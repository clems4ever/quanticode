// Package server exposes the analysis over HTTP and hosts the built frontend.
package server

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/clems4ever/quanticode/internal/heat"
)

// Repo names one repository the server should analyse and serve.
type Repo struct {
	Name string
	Dir  string
}

// Server serves one or more analysed repositories and the SPA that reads them.
type Server struct {
	repos   map[string]*heat.Analyzer
	order   []string
	webDir  string
	primary string
}

// New validates every repository and prepares the server. The returned error
// names the first repository that is not usable, so a typo in a path fails at
// startup rather than on the first request.
func New(repos []Repo, webDir string) (*Server, error) {
	if len(repos) == 0 {
		return nil, ErrNoRepos
	}
	s := &Server{repos: map[string]*heat.Analyzer{}, webDir: webDir}
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
	s.primary = s.order[0]
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
	mux.HandleFunc("/api/repos", s.handleRepos)
	mux.HandleFunc("/api/repo", s.handleRepo)
	mux.HandleFunc("/api/file", s.handleFile)
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

// analyzer resolves the ?repo= parameter, falling back to the primary
// repository so a missing or unknown slug still renders something.
func (s *Server) analyzer(r *http.Request) *heat.Analyzer {
	if a, ok := s.repos[r.URL.Query().Get("repo")]; ok {
		return a
	}
	return s.repos[s.primary]
}

type repoEntry struct {
	Slug    string `json:"slug"`
	Name    string `json:"name"`
	Primary bool   `json:"primary"`
}

func (s *Server) handleRepos(w http.ResponseWriter, r *http.Request) {
	out := make([]repoEntry, 0, len(s.order))
	for _, slug := range s.order {
		out = append(out, repoEntry{slug, s.repos[slug].Name, slug == s.primary})
	}
	writeJSON(w, out, 60)
}

func (s *Server) handleRepo(w http.ResponseWriter, r *http.Request) {
	p, err := s.analyzer(r).Payload()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, p, 30)
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
	fp, err := s.analyzer(r).File(p)
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
