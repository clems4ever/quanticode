// Package index indexes public repositories on demand.
//
// Nothing is cloned until somebody asks for it: the first request for
// github.com/owner/repo queues a clone and an analysis, and later requests are
// served from the result. A clone older than the refresh window is re-fetched
// in the background while the stale answer is still served, so a visitor never
// waits on a refresh — only on a repository nobody has asked for before.
//
// Because the service is open to any URL a stranger types, every job is bounded:
// a byte budget per repository, a file-count ceiling, a clone timeout, a fixed
// number of workers, and a disk budget that evicts whatever was least recently
// looked at.
package index

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/clems4ever/quanticode/internal/forge"
	"github.com/clems4ever/quanticode/internal/gitrepo"
	"github.com/clems4ever/quanticode/internal/heat"
	"github.com/clems4ever/quanticode/internal/source"
)

// State is where a repository has got to.
type State string

const (
	StateQueued    State = "queued"
	StateCloning   State = "cloning"
	StateFetching  State = "fetching"
	StateAnalysing State = "analysing"
	StateReady     State = "ready"
	StateFailed    State = "failed"
)

// Options bounds what an open index is allowed to spend.
type Options struct {
	Dir          string        // cache root for clones
	TTL          time.Duration // re-index a repository older than this
	FailTTL      time.Duration // remember a failure this long before retrying
	Workers      int           // concurrent clone+analyse jobs
	QueueSize    int           // requests waiting for a worker
	CloneTimeout time.Duration // per clone or fetch
	RepoBudget   int64         // bytes, one repository
	DiskBudget   int64         // bytes, every clone together
	MaxFiles     int           // tracked files in one repository

	// CloneURL overrides where a source is cloned from. Left nil it is the
	// forge's own URL; tests set it to a local path so the suite never needs
	// the network.
	CloneURL func(source.Source) string

	// Probe asks the forge how big a repository is before it is cloned, so an
	// oversized one is refused in a second rather than after minutes of
	// transfer. Left nil, a default client is used; set it to a no-op to turn
	// the pre-flight off.
	Probe func(context.Context, source.Source) (*forge.Info, error)
}

// Defaults fills anything left at zero with a value suitable for a small public
// instance.
func (o Options) Defaults() Options {
	if o.TTL == 0 {
		o.TTL = 24 * time.Hour
	}
	if o.FailTTL == 0 {
		o.FailTTL = 10 * time.Minute
	}
	if o.Workers == 0 {
		o.Workers = 2
	}
	if o.QueueSize == 0 {
		o.QueueSize = 64
	}
	if o.CloneTimeout == 0 {
		o.CloneTimeout = 10 * time.Minute
	}
	if o.RepoBudget == 0 {
		o.RepoBudget = 512 << 20
	}
	if o.DiskBudget == 0 {
		o.DiskBudget = 20 << 30
	}
	if o.MaxFiles == 0 {
		o.MaxFiles = 25000
	}
	if o.CloneURL == nil {
		o.CloneURL = func(s source.Source) string { return s.CloneURL() }
	}
	if o.Probe == nil {
		c := &forge.Client{Token: os.Getenv("QUANTICODE_FORGE_TOKEN")}
		o.Probe = c.Probe
	}
	return o
}

// Repo is a ready repository: the analysis to render, and the analyzer to pull
// individual files from.
//
// Payload is held here rather than re-derived from the analyzer on each request
// because a refresh replaces the analysis in place. A reader that called
// Analyzer.Payload() mid-refresh would block behind the re-analysis, which is
// exactly what serving the stale answer is supposed to avoid.
type Repo struct {
	Analyzer *heat.Analyzer
	Payload  *heat.RepoPayload
}

// Status is one repository's standing, as reported to the browser.
type Status struct {
	Source     string `json:"source"`
	Label      string `json:"label"`
	State      State  `json:"state"`
	Error      string `json:"error,omitempty"`
	Position   int    `json:"position,omitempty"` // place in the queue, 1-based
	Files      int    `json:"files,omitempty"`    // known once the tree is listed
	Blamed     int    `json:"blamed,omitempty"`   // files swept so far, during analysis
	Stage      string `json:"stage,omitempty"`    // sub-stage of the analysis
	Since      int64  `json:"since,omitempty"`    // unix seconds the current state began
	IndexedAt  int64  `json:"indexedAt,omitempty"`
	Refreshing bool   `json:"refreshing,omitempty"` // serving a cached answer while re-indexing
}

type entry struct {
	src source.Source

	mu         sync.Mutex
	state      State
	err        string
	analyzer   *heat.Analyzer
	payload    *heat.RepoPayload // last good analysis, served while re-indexing
	files      int
	blamed     int
	stage      string
	since      time.Time
	indexedAt  time.Time
	failedAt   time.Time
	lastAccess time.Time
	bytes      int64
	inFlight   bool // queued or being worked on
}

// Index is the set of repositories this process knows about.
type Index struct {
	opts Options

	mu      sync.Mutex
	entries map[string]*entry
	pending []*entry // queue order, for reporting position

	queue  chan *entry
	stop   chan struct{}
	closed sync.Once
	wg     sync.WaitGroup
}

// ErrBusy is returned when the queue is full. It is a "come back in a moment",
// not a failure of the repository.
var ErrBusy = errors.New("the index queue is full, try again in a moment")

// New starts the workers. Close stops them.
func New(opts Options) (*Index, error) {
	opts = opts.Defaults()
	if err := os.MkdirAll(opts.Dir, 0o755); err != nil {
		return nil, err
	}
	ix := &Index{
		opts:    opts,
		entries: map[string]*entry{},
		queue:   make(chan *entry, opts.QueueSize),
		stop:    make(chan struct{}),
	}
	for i := 0; i < opts.Workers; i++ {
		ix.wg.Add(1)
		go ix.worker()
	}
	return ix, nil
}

// Limits are the bounds this index enforces, for the UI to state up front. A
// limit a visitor only discovers by hitting it is a bug in the page, not in the
// limit.
type Limits struct {
	MaxRepoMB int64 `json:"maxRepoMB"`
	MaxFiles  int   `json:"maxFiles"`
	RefreshH  int   `json:"refreshHours"`
}

// Limits reports what this index will and will not take on.
func (ix *Index) Limits() Limits {
	return Limits{
		MaxRepoMB: ix.opts.RepoBudget >> 20,
		MaxFiles:  ix.opts.MaxFiles,
		RefreshH:  int(ix.opts.TTL / time.Hour),
	}
}

// Close stops the workers and waits for the job in flight.
func (ix *Index) Close() {
	ix.closed.Do(func() { close(ix.stop) })
	ix.wg.Wait()
}

// Get returns the repository when one is ready, and the status either way. A nil
// Repo means the caller should show progress and poll.
//
// This is the only entry point: it is what makes the index lazy. Asking for a
// repository is what causes it to be indexed.
func (ix *Index) Get(src source.Source) (*Repo, Status) {
	e := ix.entryFor(src)

	e.mu.Lock()
	e.lastAccess = time.Now()

	switch {
	case e.state == StateReady:
		stale := time.Since(e.indexedAt) > ix.opts.TTL
		if stale && !e.inFlight {
			e.inFlight = true
			e.mu.Unlock()
			if err := ix.enqueue(e); err != nil {
				// Refreshing is best-effort: the cached answer is still good.
				e.mu.Lock()
				e.inFlight = false
				e.mu.Unlock()
			}
			e.mu.Lock()
		}
		repo := &Repo{Analyzer: e.analyzer, Payload: e.payload}
		st := ix.statusLocked(e)
		e.mu.Unlock()
		return repo, st

	case e.inFlight:
		st := ix.statusLocked(e)
		e.mu.Unlock()
		return nil, st

	case e.state == StateFailed && time.Since(e.failedAt) < ix.opts.FailTTL:
		// Don't re-clone something that just failed on every reload; a typo'd
		// repository name would otherwise be a free way to keep the workers busy.
		st := ix.statusLocked(e)
		e.mu.Unlock()
		return nil, st
	}

	e.inFlight = true
	e.state = StateQueued
	e.err = ""
	e.since = time.Now()
	e.mu.Unlock()

	if err := ix.enqueue(e); err != nil {
		e.mu.Lock()
		e.inFlight, e.state, e.err, e.failedAt = false, StateFailed, err.Error(), time.Time{}
		st := ix.statusLocked(e)
		e.mu.Unlock()
		return nil, st
	}

	e.mu.Lock()
	st := ix.statusLocked(e)
	e.mu.Unlock()
	return nil, st
}

// Status reports without causing any work, for polling.
func (ix *Index) Status(src source.Source) Status {
	e := ix.entryFor(src)
	e.mu.Lock()
	defer e.mu.Unlock()
	return ix.statusLocked(e)
}

func (ix *Index) entryFor(src source.Source) *entry {
	key := src.String()
	ix.mu.Lock()
	defer ix.mu.Unlock()
	if e, ok := ix.entries[key]; ok {
		return e
	}
	e := &entry{src: src, state: ""}
	e.analyzer = ix.newAnalyzer(e, key, src.Label(),
		filepath.Join(ix.opts.Dir, filepath.FromSlash(src.Dir())))
	ix.entries[key] = e
	return e
}

// newAnalyzer builds an analyzer wired to report its sweep progress back into
// the entry, so /api/status can answer "how far in is it" rather than only
// "still going".
func (ix *Index) newAnalyzer(e *entry, slug, name, dir string) *heat.Analyzer {
	return &heat.Analyzer{
		Slug: slug,
		Name: name,
		Dir:  dir,
		OnProgress: func(stage string, done, total int) {
			e.mu.Lock()
			e.stage = stage
			e.blamed = done
			e.files = total
			e.mu.Unlock()
		},
	}
}

// statusLocked builds the wire status. e.mu must be held.
func (ix *Index) statusLocked(e *entry) Status {
	st := Status{
		Source: e.src.String(),
		Label:  e.src.Label(),
		State:  e.state,
		Error:  e.err,
		Files:  e.files,
		Blamed: e.blamed,
		Stage:  e.stage,
	}
	if st.State == "" {
		st.State = StateQueued
	}
	if !e.since.IsZero() {
		st.Since = e.since.Unix()
	}
	if !e.indexedAt.IsZero() {
		st.IndexedAt = e.indexedAt.Unix()
	}
	if e.state == StateQueued && e.inFlight {
		st.Position = ix.queuePosition(e)
	}
	// Ready and still in flight means a refresh is running behind the answer
	// being served.
	st.Refreshing = e.inFlight && e.state == StateReady
	return st
}

// queuePosition is this entry's 1-based place in the pending list, or 0 if it
// is not waiting. It reads only ix.pending, never another entry's fields, so it
// needs no lock but ix.mu.
func (ix *Index) queuePosition(e *entry) int {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	for i, p := range ix.pending {
		if p == e {
			return i + 1
		}
	}
	return 0
}

func (ix *Index) enqueue(e *entry) error {
	ix.mu.Lock()
	ix.pending = append(ix.pending, e)
	ix.mu.Unlock()

	select {
	case ix.queue <- e:
		return nil
	default:
		ix.unpend(e)
		return ErrBusy
	}
}

// unpend removes an entry from the pending list once a worker has taken it.
func (ix *Index) unpend(e *entry) {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	for i, p := range ix.pending {
		if p == e {
			ix.pending = append(ix.pending[:i], ix.pending[i+1:]...)
			return
		}
	}
}

func (ix *Index) worker() {
	defer ix.wg.Done()
	for {
		select {
		case <-ix.stop:
			return
		case e := <-ix.queue:
			ix.unpend(e)
			ix.run(e)
		}
	}
}

// run does the work for one entry: clone or fetch, then analyse.
func (ix *Index) run(e *entry) {
	start := time.Now()
	dir := e.analyzer.Dir
	_, statErr := os.Stat(filepath.Join(dir, "HEAD"))
	haveClone := statErr == nil

	ctx, cancel := context.WithTimeout(context.Background(), ix.opts.CloneTimeout)
	defer cancel()

	if !haveClone {
		// Ask before downloading. The byte budget below still guards the clone,
		// but finding out that way costs minutes and a loaded machine, and the
		// visitor waits through all of it to be told no.
		if msg, refuse := ix.preflight(ctx, e.src); refuse {
			e.fail(msg)
			log.Printf("[%s] refused before cloning: %s", e.src, msg)
			return
		}
	}

	if haveClone {
		e.setState(StateFetching)
	} else {
		e.setState(StateCloning)
	}

	var err error
	if haveClone {
		if err = gitrepo.Fetch(ctx, dir); err != nil {
			// A clone that cannot be updated may simply be corrupt. Throw it
			// away and start again, once.
			log.Printf("[%s] fetch failed (%v), re-cloning", e.src, err)
			_ = os.RemoveAll(dir)
			e.setState(StateCloning)
			err = gitrepo.Clone(ctx, ix.opts.CloneURL(e.src), dir, ix.opts.RepoBudget)
		}
	} else {
		err = gitrepo.Clone(ctx, ix.opts.CloneURL(e.src), dir, ix.opts.RepoBudget)
	}
	if err != nil {
		_ = os.RemoveAll(dir)
		e.fail(err.Error())
		log.Printf("[%s] %v", e.src, err)
		return
	}

	// The file count is the real cost of the analysis — one blame per file —
	// so it is checked before the sweep rather than discovered during it.
	files, err := gitrepo.ListFiles(dir)
	if err != nil {
		_ = os.RemoveAll(dir)
		e.fail("repository has no readable HEAD: " + err.Error())
		return
	}
	if len(files) > ix.opts.MaxFiles {
		_ = os.RemoveAll(dir)
		e.fail(tooManyFiles(len(files), ix.opts.MaxFiles))
		return
	}

	e.mu.Lock()
	e.files = len(files)
	e.blamed = 0
	e.stage = heat.StageBlaming
	e.mu.Unlock()
	e.setState(StateAnalysing)

	payload, err := e.analyzer.Payload()
	if err != nil {
		e.fail(err.Error())
		log.Printf("[%s] analysis failed: %v", e.src, err)
		return
	}

	size, _ := gitrepo.DirSize(dir)

	e.mu.Lock()
	e.state = StateReady
	e.err = ""
	e.blamed = 0
	e.stage = ""
	e.payload = payload
	e.indexedAt = time.Now()
	e.since = e.indexedAt
	e.bytes = size
	e.inFlight = false
	e.mu.Unlock()

	log.Printf("[%s] indexed %d files, %d MB on disk, in %s",
		e.src, len(files), size>>20, time.Since(start).Round(time.Millisecond))

	ix.evict(e)
}

// preflight returns a refusal message and true when the forge already tells us
// the repository cannot be indexed here. Anything it cannot determine is not a
// refusal: the clone goes ahead and the byte budget is the backstop.
func (ix *Index) preflight(ctx context.Context, src source.Source) (string, bool) {
	info, err := ix.opts.Probe(ctx, src)
	if errors.Is(err, forge.ErrNotFound) {
		return "no such public repository (it may be private, renamed or deleted)", true
	}
	if info == nil || info.SizeBytes <= 0 {
		return "", false
	}
	if info.SizeBytes > ix.opts.RepoBudget {
		return fmt.Sprintf("repository is %d MB, larger than the %d MB this instance indexes",
			info.SizeBytes>>20, ix.opts.RepoBudget>>20), true
	}
	return "", false
}

func tooManyFiles(got, max int) string {
	return "repository has " + itoa(got) + " tracked files, more than this instance indexes (" + itoa(max) + ")"
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

func (e *entry) setState(s State) {
	e.mu.Lock()
	e.state = s
	e.since = time.Now()
	e.mu.Unlock()
}

func (e *entry) fail(msg string) {
	e.mu.Lock()
	e.state = StateFailed
	e.err = msg
	e.failedAt = time.Now()
	e.since = e.failedAt
	e.inFlight = false
	e.bytes = 0
	e.mu.Unlock()
}

// evict drops the least recently looked-at clones until the cache is inside its
// disk budget. keep is never evicted: it is the one just indexed, and somebody
// is waiting for it.
func (ix *Index) evict(keep *entry) {
	total, err := gitrepo.DirSize(ix.opts.Dir)
	if err != nil || total <= ix.opts.DiskBudget {
		return
	}

	// Snapshot under ix.mu, then inspect with ix.mu released: the lock order
	// everywhere else is e.mu -> ix.mu, and nesting it the other way here would
	// deadlock against a status read.
	ix.mu.Lock()
	all := make([]*entry, 0, len(ix.entries))
	for _, e := range ix.entries {
		if e != keep {
			all = append(all, e)
		}
	}
	ix.mu.Unlock()

	candidates := make([]*entry, 0, len(all))
	for _, e := range all {
		e.mu.Lock()
		eligible := e.state == StateReady && !e.inFlight
		e.mu.Unlock()
		if eligible {
			candidates = append(candidates, e)
		}
	}

	sort.Slice(candidates, func(i, j int) bool {
		candidates[i].mu.Lock()
		a := candidates[i].lastAccess
		candidates[i].mu.Unlock()
		candidates[j].mu.Lock()
		b := candidates[j].lastAccess
		candidates[j].mu.Unlock()
		return a.Before(b)
	})

	for _, e := range candidates {
		if total <= ix.opts.DiskBudget {
			return
		}
		e.mu.Lock()
		if e.state != StateReady || e.inFlight {
			e.mu.Unlock()
			continue
		}
		dir, freed := e.analyzer.Dir, e.bytes
		// Forget the analysis too: its cached payload refers to objects that
		// are about to stop existing.
		e.state = ""
		e.indexedAt = time.Time{}
		e.bytes = 0
		e.payload = nil
		e.analyzer = ix.newAnalyzer(e, e.analyzer.Slug, e.analyzer.Name, dir)
		e.mu.Unlock()

		if err := os.RemoveAll(dir); err != nil {
			log.Printf("evict %s: %v", e.src, err)
			continue
		}
		total -= freed
		log.Printf("evicted %s (%d MB), cache now %d MB of %d MB budget",
			e.src, freed>>20, total>>20, ix.opts.DiskBudget>>20)
	}
}
