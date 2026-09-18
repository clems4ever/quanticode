package heat

import (
	"log"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/clems4ever/quanticode/internal/gitrepo"
)

// Analyzer owns one repository and caches its analysis, keyed by HEAD, so a
// reload is free until the repo actually moves.
type Analyzer struct {
	Slug string
	Name string
	Dir  string

	// OnProgress, when set, is called as the analysis advances. A large
	// repository is minutes of blame, and a stage name with no number behind it
	// is indistinguishable from a hang — which is exactly how it was reported.
	//
	// The stage matters as much as the count. Rolling up authors and walking the
	// history for the timeline happens after the last file is blamed, and on a
	// repository with ten thousand commits that is another fifteen seconds; a
	// bar sitting at 100% for that long reads as stuck all over again.
	OnProgress func(stage string, done, total int)

	mu     sync.Mutex
	cached *RepoPayload
	head   string
}

// Payload returns the repo analysis, recomputing only when HEAD has changed.
func (a *Analyzer) Payload() (*RepoPayload, error) {
	head, err := gitrepo.Line(a.Dir, "rev-parse", "HEAD")
	if err != nil {
		return nil, err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.cached != nil && a.head == head {
		return a.cached, nil
	}
	p, err := a.analyze(head)
	if err != nil {
		return nil, err
	}
	a.cached, a.head = p, head
	return p, nil
}

// Stages reported through OnProgress.
const (
	StageBlaming     = "blaming"
	StageSummarising = "summarising"
)

type blameResult struct {
	file    FileHeat
	commits map[string]Commit
	authors map[string]int // "name\x00email" -> lines
}

func (a *Analyzer) analyze(head string) (*RepoPayload, error) {
	start := time.Now()

	files, err := gitrepo.ListFiles(a.Dir)
	if err != nil {
		return nil, err
	}

	// Resolved once for the repository rather than per file.
	text, err := gitrepo.TextFiles(a.Dir)
	if err != nil {
		return nil, err
	}

	jobs := make(chan string)
	results := make(chan blameResult)
	done := make(chan struct{}, len(files))
	workers := runtime.NumCPU()
	if workers > 12 {
		workers = 12
	}
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for f := range jobs {
				if r, ok := a.blameOne(f, text); ok {
					results <- r
				}
				done <- struct{}{}
			}
		}()
	}
	go func() {
		for _, f := range files {
			jobs <- f
		}
		close(jobs)
		wg.Wait()
		close(results)
		close(done)
	}()

	// Counted in its own goroutine so a slow progress callback cannot stall the
	// workers. Reported at most every 1% or 25 files, whichever is coarser: the
	// browser polls every 1.5s and does not need more.
	go func() {
		step := len(files) / 100
		if step < 25 {
			step = 25
		}
		n := 0
		for range done {
			n++
			if a.OnProgress != nil && (n%step == 0 || n == len(files)) {
				a.OnProgress(StageBlaming, n, len(files))
			}
		}
	}()

	payload := &RepoPayload{
		Files:   make([]FileHeat, 0, len(files)),
		Commits: map[string]Commit{},
	}
	authorLines := map[string]int{}
	for r := range results {
		payload.Files = append(payload.Files, r.file)
		for sha, c := range r.commits {
			if _, ok := payload.Commits[sha]; !ok {
				payload.Commits[sha] = c
			}
		}
		for k, n := range r.authors {
			authorLines[k] += n
		}
	}
	sort.Slice(payload.Files, func(i, j int) bool { return payload.Files[i].Path < payload.Files[j].Path })

	// Every file is blamed by here; what remains is the roll-up and a full walk
	// of the history for the timeline, which is not instant on a big repository.
	if a.OnProgress != nil {
		a.OnProgress(StageSummarising, len(files), len(files))
	}

	payload.Authors = a.buildAuthors(authorLines, payload.Commits)
	payload.Timeline = a.buildTimeline()
	payload.Meta = a.buildMeta(head, payload, start)

	log.Printf("[%s] analysed %d files / %d lines / %d commits in %s",
		a.Slug, payload.Meta.TotalFiles, payload.Meta.TotalLines, len(payload.Commits), time.Since(start).Round(time.Millisecond))
	return payload, nil
}

// blameOne turns a single file into its heat aggregate. text is the set of
// paths git considers textual, resolved once for the whole repository.
func (a *Analyzer) blameOne(f string, text map[string]bool) (blameResult, bool) {
	if !text[f] {
		return blameResult{}, false
	}
	shas, _, commits, err := gitrepo.Blame(a.Dir, f, false)
	if err != nil || len(shas) == 0 {
		return blameResult{}, false
	}

	byTime := map[int64]int{}
	authors := map[string]int{}
	authorCount := map[string]int{}
	seenCommits := map[string]bool{}
	var last, first int64
	first = 1<<63 - 1
	lastSHA := ""

	for _, sha := range shas {
		c := commits[sha]
		byTime[c.Time]++
		key := c.Author + "\x00" + c.Email
		authors[key]++
		authorCount[c.Author]++
		seenCommits[sha] = true
		if c.Time > last {
			last, lastSHA = c.Time, c.Short
		}
		if c.Time < first {
			first = c.Time
		}
	}

	buckets := make([]Bucket, 0, len(byTime))
	for t, n := range byTime {
		buckets = append(buckets, Bucket{Time: t, Lines: n})
	}
	sort.Slice(buckets, func(i, j int) bool { return buckets[i].Time > buckets[j].Time })

	top, topN := "", 0
	for name, n := range authorCount {
		if n > topN || (n == topN && name < top) {
			top, topN = name, n
		}
	}

	return blameResult{
		file: FileHeat{
			Path:       f,
			Lines:      len(shas),
			Ext:        gitrepo.Ext(f),
			Buckets:    buckets,
			LastEdit:   last,
			LastCommit: lastSHA,
			FirstEdit:  first,
			Commits:    len(seenCommits),
			TopAuthor:  top,
			Authors:    len(authorCount),
			Generated:  gitrepo.IsGenerated(f, len(shas)),
		},
		commits: commits,
		authors: authors,
	}, true
}

func (a *Analyzer) buildAuthors(lines map[string]int, commits map[string]Commit) []AuthorStat {
	type agg struct {
		AuthorStat
		commits map[string]bool
	}
	byName := map[string]*agg{}
	for key, n := range lines {
		parts := strings.SplitN(key, "\x00", 2)
		name := parts[0]
		e := ""
		if len(parts) > 1 {
			e = parts[1]
		}
		if byName[name] == nil {
			byName[name] = &agg{AuthorStat: AuthorStat{Name: name, Email: e}, commits: map[string]bool{}}
		}
		byName[name].Lines += n
	}
	for _, c := range commits {
		if g := byName[c.Author]; g != nil {
			g.commits[c.SHA] = true
			if c.Time > g.LastEdit {
				g.LastEdit = c.Time
			}
		}
	}
	out := make([]AuthorStat, 0, len(byName))
	for _, g := range byName {
		g.Commits = len(g.commits)
		out = append(out, g.AuthorStat)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Lines > out[j].Lines })
	return out
}

// buildTimeline walks the full history once for per-day commit and churn counts.
func (a *Analyzer) buildTimeline() []DayStat {
	out, err := gitrepo.Run(a.Dir, "log", "--no-merges", "--date=short", "--pretty=format:C%ad", "--numstat")
	if err != nil {
		return nil
	}
	byDay := map[string]*DayStat{}
	cur := ""
	for _, line := range strings.Split(string(out), "\n") {
		if strings.HasPrefix(line, "C") {
			cur = strings.TrimPrefix(line, "C")
			if byDay[cur] == nil {
				byDay[cur] = &DayStat{Date: cur}
			}
			byDay[cur].Commits++
			continue
		}
		if line == "" || cur == "" {
			continue
		}
		cols := strings.Split(line, "\t")
		if len(cols) < 3 {
			continue
		}
		add, err1 := strconv.Atoi(cols[0])
		del, err2 := strconv.Atoi(cols[1])
		if err1 != nil || err2 != nil {
			continue // binary file, shown as "-"
		}
		byDay[cur].Added += add
		byDay[cur].Removed += del
	}
	days := make([]DayStat, 0, len(byDay))
	for _, d := range byDay {
		days = append(days, *d)
	}
	sort.Slice(days, func(i, j int) bool { return days[i].Date < days[j].Date })
	return days
}

func (a *Analyzer) buildMeta(head string, p *RepoPayload, start time.Time) RepoMeta {
	m := RepoMeta{
		Name:        a.Name,
		Slug:        a.Slug,
		Head:        head,
		HeadShort:   head[:min(8, len(head))],
		GeneratedAt: time.Now().Unix(),
	}
	m.Branch, _ = gitrepo.Line(a.Dir, "rev-parse", "--abbrev-ref", "HEAD")
	m.Remote, _ = gitrepo.Line(a.Dir, "config", "--get", "remote.origin.url")
	if s, err := gitrepo.Line(a.Dir, "rev-list", "--count", "HEAD"); err == nil {
		m.CommitCount, _ = strconv.Atoi(s)
	}
	if s, err := gitrepo.Line(a.Dir, "log", "-1", "--format=%at"); err == nil {
		m.LastCommit, _ = strconv.ParseInt(s, 10, 64)
	}
	if s, err := gitrepo.Line(a.Dir, "log", "--reverse", "--format=%at"); err == nil {
		if i := strings.IndexByte(s, '\n'); i > 0 {
			s = s[:i]
		}
		m.FirstCommit, _ = strconv.ParseInt(s, 10, 64)
	}
	m.TotalFiles = len(p.Files)
	for _, f := range p.Files {
		m.TotalLines += f.Lines
	}
	m.AnalysisMs = time.Since(start).Milliseconds()
	return m
}

// File returns the per-line blame view of one path.
func (a *Analyzer) File(p string) (*FilePayload, error) {
	shas, text, commits, err := gitrepo.Blame(a.Dir, p, true)
	if err != nil {
		return nil, err
	}
	lines := make([]FileLine, len(shas))
	for i, sha := range shas {
		t := ""
		if i < len(text) {
			t = text[i]
		}
		lines[i] = FileLine{Text: t, SHA: sha}
	}
	return &FilePayload{Path: p, Lines: lines, Commits: commits, Ext: gitrepo.Ext(p)}, nil
}
