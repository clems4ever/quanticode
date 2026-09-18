// Package server exposes the analysis over HTTP and hosts the built frontend.
package server

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/clems4ever/quanticode/internal/heat"
	"github.com/clems4ever/quanticode/internal/index"
	"github.com/clems4ever/quanticode/internal/source"
)

// Repo names one repository the server should analyse and serve.
type Repo struct {
	Name string
	Dir  string
}

// Server serves analysed repositories and the SPA that reads them.
//
// Two sources, either or both: repositories named on the command line, which
// are local clones addressed by slug, and — when an index is attached —
// anything a visitor names in the URL, cloned on demand.
type Server struct {
	repos   map[string]*heat.Analyzer
	order   []string
	webDir  string
	primary string
	index   *index.Index
}

// New prepares a server over local clones only. The returned error names the
// first repository that is not usable, so a typo in a path fails at startup
// rather than on the first request.
func New(repos []Repo, webDir string) (*Server, error) {
	return NewIndexed(repos, webDir, nil)
}

// NewIndexed prepares a server that can also clone and analyse public
// repositories on demand. With an index attached, no local repository is
// required: the instance may start empty and fill up as people ask for things.
func NewIndexed(repos []Repo, webDir string, ix *index.Index) (*Server, error) {
	if len(repos) == 0 && ix == nil {
		return nil, ErrNoRepos
	}
	s := &Server{repos: map[string]*heat.Analyzer{}, webDir: webDir, index: ix}
	for _, r := range repos {
		abs, err := filepath.Abs(r.Dir)
		if err != nil {
			return nil, err
		}
		if _, err := os.Stat(filepath.Join(abs, ".git")); err != nil {
			return nil, &NotARepoError{Dir: abs}
		}
		name := r.Name
		if name == "" {
			name = filepath.Base(strings.TrimSuffix(abs, string(filepath.Separator)))
		}
		slug := Slugify(name)
		if slug == "" {
			return nil, &BadNameError{Name: name}
		}
		if _, dup := s.repos[slug]; dup {
			return nil, &DuplicateRepoError{Slug: slug}
		}
		s.repos[slug] = &heat.Analyzer{Slug: slug, Name: name, Dir: abs}
		s.order = append(s.order, slug)
	}
	if len(s.order) > 0 {
		s.primary = s.order[0]
	}
	return s, nil
}

// Slugs lists the configured repositories in declaration order.
func (s *Server) Slugs() []string { return append([]string(nil), s.order...) }

// Warm analyses every repository up front, so the first visitor does not wait
// on a full blame sweep.
func (s *Server) Warm() {
	for _, slug := range s.order {
		if _, err := s.repos[slug].Payload(); err != nil {
			log.Printf("[%s] warmup failed: %v", slug, err)
		}
	}
}

// Handler returns the fully wired HTTP handler, compression and logging included.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/instance", s.handleInstance)
	mux.HandleFunc("/api/repos", s.handleRepos)
	mux.HandleFunc("/api/repo", s.handleRepo)
	mux.HandleFunc("/api/file", s.handleFile)
	mux.HandleFunc("/api/status", s.handleStatus)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/", s.handleStatic)
	return WithGzip(logRequests(mux))
}

// Slugify reduces a repository name to a URL-safe identifier.
func Slugify(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '-', r == '_', r == '.', r == '/', r == ' ':
			b.WriteRune('-')
		}
	}
	return strings.Trim(b.String(), "-")
}

// resolution is the outcome of working out which repository a request is about.
// Exactly one of analyzer, status or err is meaningful, in that order.
type resolution struct {
	analyzer *heat.Analyzer
	// payload is the already-computed analysis for an indexed repository. A
	// local clone leaves it nil and is analysed on read, because it can move
	// under us at any moment.
	payload *heat.RepoPayload
	status  *index.Status // indexing in progress; nothing to serve yet
	err     error         // the request named something unusable
	code    int
}

// analysis returns the payload to serve, computing it only for local clones.
func (r resolution) analysis() (*heat.RepoPayload, error) {
	if r.payload != nil {
		return r.payload, nil
	}
	return r.analyzer.Payload()
}

// resolve works out which repository a request is about.
//
// ?src=github.com/owner/repo is the on-demand path and is what the URL shape
// quanticode.dev/github.com/owner/repo turns into. ?repo=slug is a local clone
// named on the command line. With neither, the primary local repository is used
// so a single-repo instance needs no query string at all.
func (s *Server) resolve(r *http.Request) resolution {
	if raw := r.URL.Query().Get("src"); raw != "" {
		if s.index == nil {
			return resolution{err: errors.New("this instance does not index remote repositories"), code: http.StatusNotFound}
		}
		src, err := source.Parse(raw)
		if err != nil {
			return resolution{err: err, code: http.StatusBadRequest}
		}
		repo, st := s.index.Get(src)
		if repo == nil {
			return resolution{status: &st}
		}
		return resolution{analyzer: repo.Analyzer, payload: repo.Payload}
	}
	if a, ok := s.repos[r.URL.Query().Get("repo")]; ok {
		return resolution{analyzer: a}
	}
	if s.primary == "" {
		return resolution{err: errors.New("no repository given: try /github.com/owner/repo"), code: http.StatusNotFound}
	}
	return resolution{analyzer: s.repos[s.primary]}
}

type repoEntry struct {
	Slug    string `json:"slug"`
	Name    string `json:"name"`
	Primary bool   `json:"primary"`
}

func (s *Server) handleRepos(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.repoEntries(), 60)
}

func (s *Server) repoEntries() []repoEntry {
	out := make([]repoEntry, 0, len(s.order))
	for _, slug := range s.order {
		out = append(out, repoEntry{slug, s.repos[slug].Name, slug == s.primary})
	}
	return out
}

func (s *Server) handleRepo(w http.ResponseWriter, r *http.Request) {
	res := s.resolve(r)
	switch {
	case res.err != nil:
		http.Error(w, res.err.Error(), res.code)
		return
	case res.status != nil:
		// 202: the request was accepted and the work has started. The browser
		// shows progress and polls /api/status.
		writeStatus(w, *res.status, http.StatusAccepted)
		return
	}
	p, err := res.analysis()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	// An indexed repository is only re-analysed on the refresh cycle, but a
	// local clone can move under us at any moment, so this stays short.
	writeJSON(w, p, 30)
}

// handleStatus reports indexing progress without starting any work, so polling
// it is free.
func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	if s.index == nil {
		http.Error(w, "this instance does not index remote repositories", http.StatusNotFound)
		return
	}
	src, err := source.Parse(r.URL.Query().Get("src"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeStatus(w, s.index.Status(src), http.StatusOK)
}

type instanceInfo struct {
	Indexing bool          `json:"indexing"`
	Hosts    []string      `json:"hosts,omitempty"`
	Limits   *index.Limits `json:"limits,omitempty"`
	Repos    []repoEntry   `json:"repos"`
}

// handleInstance tells the frontend what this deployment can do: whether it
// will index arbitrary repositories, and which local ones it already has.
func (s *Server) handleInstance(w http.ResponseWriter, r *http.Request) {
	info := instanceInfo{Indexing: s.index != nil, Repos: s.repoEntries()}
	if s.index != nil {
		info.Hosts = source.Hosts()
		lim := s.index.Limits()
		info.Limits = &lim
	}
	writeJSON(w, info, 60)
}

func (s *Server) handleFile(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	if p == "" {
		http.Error(w, "path is required", http.StatusBadRequest)
		return
	}
	if !SafeRepoPath(p) {
		http.Error(w, "invalid path", http.StatusBadRequest)
		return
	}
	res := s.resolve(r)
	switch {
	case res.err != nil:
		http.Error(w, res.err.Error(), res.code)
		return
	case res.status != nil:
		writeStatus(w, *res.status, http.StatusAccepted)
		return
	}
	fp, err := res.analyzer.File(p)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	writeJSON(w, fp, 300)
}

// SafeRepoPath rejects anything that could address a file outside the
// repository: absolute paths, parent traversal, and NUL bytes.
func SafeRepoPath(p string) bool {
	if p == "" || strings.HasPrefix(p, "/") || strings.ContainsRune(p, 0) {
		return false
	}
	if strings.HasPrefix(p, "../") || strings.Contains(p, "/../") || strings.HasSuffix(p, "/..") || p == ".." {
		return false
	}
	// Windows-style absolute paths and drive letters.
	if strings.Contains(p, "\\") || (len(p) > 1 && p[1] == ':') {
		return false
	}
	return true
}

// handleStatic serves the built SPA, falling back to index.html for client routes.
func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	clean := filepath.Clean("/" + strings.TrimPrefix(r.URL.Path, "/"))
	target := filepath.Join(s.webDir, clean)
	rel, err := filepath.Rel(s.webDir, target)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		http.NotFound(w, r)
		return
	}
	if info, statErr := os.Stat(target); statErr == nil && !info.IsDir() {
		if strings.HasPrefix(clean, "/assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}
		http.ServeFile(w, r, target)
		return
	}
	index := filepath.Join(s.webDir, "index.html")
	if _, statErr := os.Stat(index); statErr != nil {
		http.Error(w, "frontend not built: run npm run build in web/", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeFile(w, r, index)
}

// writeStatus reports indexing progress. It is never cached: the whole point of
// the response is that it changes.
func writeStatus(w http.ResponseWriter, st index.Status, code int) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if st.State == index.StateFailed {
		// Not 200: a caller asking for the analysis must be able to tell a
		// finished payload from a status document without inspecting its shape.
		code = http.StatusUnprocessableEntity
	}
	w.WriteHeader(code)
	if err := json.NewEncoder(w).Encode(st); err != nil {
		log.Printf("encode: %v", err)
	}
}

func writeJSON(w http.ResponseWriter, v any, maxAge int) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if maxAge > 0 {
		w.Header().Set("Cache-Control", "public, max-age="+strconv.Itoa(maxAge))
	}
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("encode: %v", err)
	}
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		if strings.HasPrefix(r.URL.Path, "/api/") {
			suffix := ""
			if r.URL.RawQuery != "" {
				suffix = "?" + r.URL.RawQuery
			}
			log.Printf("%s %s%s %s", r.Method, r.URL.Path, suffix, time.Since(start).Round(time.Millisecond))
		}
	})
}
