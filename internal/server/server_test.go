package server_test

import (
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/clems4ever/quanticode/internal/server"
	"github.com/clems4ever/quanticode/internal/testrepo"
)

var day1 = time.Date(2024, 1, 10, 12, 0, 0, 0, time.UTC)

// newServer builds a server over two repositories and a fake web/dist.
func newServer(t *testing.T) (*server.Server, string) {
	t.Helper()

	r1 := testrepo.New(t)
	r1.WriteLines("main.go", "package main", "func main() {}")
	r1.Commit("init", "Ada", "ada@example.com", day1)

	r2 := testrepo.New(t)
	r2.WriteLines("lib.ts", "export const x = 1")
	r2.Commit("init", "Grace", "grace@example.com", day1)

	web := t.TempDir()
	mustWrite(t, filepath.Join(web, "index.html"), "<!doctype html><title>quanticode</title>")
	mustWrite(t, filepath.Join(web, "assets", "app.js"), "console.log(1)")

	s, err := server.New([]server.Repo{
		{Name: "alpha", Dir: r1.Dir},
		{Name: "beta", Dir: r2.Dir},
	}, web)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return s, web
}

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func get(t *testing.T, h http.Handler, target string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, target, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestNewRejectsBadConfiguration(t *testing.T) {
	if _, err := server.New(nil, "web"); err == nil {
		t.Error("no repositories should be rejected")
	}

	notARepo := t.TempDir()
	if _, err := server.New([]server.Repo{{Name: "x", Dir: notARepo}}, "web"); err == nil {
		t.Error("a directory without .git should be rejected")
	}

	r := testrepo.New(t)
	r.WriteLines("a.go", "package a")
	r.Commit("init", "Ada", "ada@example.com", day1)
	// "my repo" and "my-repo" both slugify to "my-repo", which would make one
	// of them unreachable.
	if _, err := server.New([]server.Repo{
		{Name: "my repo", Dir: r.Dir},
		{Name: "my-repo", Dir: r.Dir},
	}, "web"); err == nil {
		t.Error("colliding slugs should be rejected")
	}

	if _, err := server.New([]server.Repo{{Name: "!!!", Dir: r.Dir}}, "web"); err == nil {
		t.Error("a name with no usable characters should be rejected")
	}
}

func TestHandleRepos(t *testing.T) {
	s, _ := newServer(t)
	rec := get(t, s.Handler(), "/api/repos")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var got []struct {
		Slug    string `json:"slug"`
		Name    string `json:"name"`
		Primary bool   `json:"primary"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d repos, want 2", len(got))
	}
	if got[0].Slug != "alpha" || !got[0].Primary {
		t.Errorf("first repo = %+v, want alpha as primary", got[0])
	}
	if got[1].Primary {
		t.Error("only the first repo should be primary")
	}
}

func TestHandleRepoSelectsBySlug(t *testing.T) {
	s, _ := newServer(t)
	h := s.Handler()

	for _, tc := range []struct{ query, wantName string }{
		{"", "alpha"},               // no slug falls back to primary
		{"?repo=beta", "beta"},      // explicit slug
		{"?repo=nonesuch", "alpha"}, // unknown slug falls back rather than 404s
	} {
		rec := get(t, h, "/api/repo"+tc.query)
		if rec.Code != http.StatusOK {
			t.Fatalf("%q: status = %d", tc.query, rec.Code)
		}
		var p struct {
			Meta struct {
				Name string `json:"name"`
			} `json:"meta"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
			t.Fatalf("%q: decode: %v", tc.query, err)
		}
		if p.Meta.Name != tc.wantName {
			t.Errorf("%q: served %q, want %q", tc.query, p.Meta.Name, tc.wantName)
		}
	}
}

func TestHandleFile(t *testing.T) {
	s, _ := newServer(t)
	rec := get(t, s.Handler(), "/api/file?path=main.go")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body)
	}
	var fp struct {
		Path  string `json:"path"`
		Lines []struct {
			Text string `json:"t"`
			SHA  string `json:"c"`
		} `json:"lines"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &fp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if fp.Path != "main.go" || len(fp.Lines) != 2 {
		t.Fatalf("got %+v", fp)
	}
	if fp.Lines[0].Text != "package main" {
		t.Errorf("first line = %q", fp.Lines[0].Text)
	}
}

func TestHandleFileRequiresPath(t *testing.T) {
	s, _ := newServer(t)
	if rec := get(t, s.Handler(), "/api/file"); rec.Code != http.StatusBadRequest {
		t.Errorf("missing path: status = %d, want 400", rec.Code)
	}
	if rec := get(t, s.Handler(), "/api/file?path=missing.go"); rec.Code != http.StatusNotFound {
		t.Errorf("unknown file: status = %d, want 404", rec.Code)
	}
}

// The path parameter is fed to git, so it must never be able to address
// anything outside the repository.
func TestHandleFileRejectsTraversal(t *testing.T) {
	s, _ := newServer(t)
	h := s.Handler()
	for _, bad := range []string{
		"../etc/passwd",
		"a/../../etc/passwd",
		"/etc/passwd",
		"nested/..",
		"..",
		"..%2Fetc%2Fpasswd",
		`..\windows\system32`,
		"C:/windows",
	} {
		rec := get(t, h, "/api/file?path="+url(bad))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("path %q: status = %d, want 400", bad, rec.Code)
		}
	}
}

func url(s string) string {
	r := strings.NewReplacer("/", "%2F", "\\", "%5C", " ", "%20", ":", "%3A")
	return r.Replace(s)
}

func TestSafeRepoPath(t *testing.T) {
	ok := []string{"a.go", "a/b/c.go", "dir/.hidden", "a..b/c.go", "..a/b"}
	bad := []string{"", "/abs", "../up", "a/../../up", "a/..", "..", "a\x00b", `a\b`, "C:/x"}
	for _, p := range ok {
		if !server.SafeRepoPath(p) {
			t.Errorf("SafeRepoPath(%q) = false, want true", p)
		}
	}
	for _, p := range bad {
		if server.SafeRepoPath(p) {
			t.Errorf("SafeRepoPath(%q) = true, want false", p)
		}
	}
}

func TestStaticServesAssetsAndFallsBackToIndex(t *testing.T) {
	s, _ := newServer(t)
	h := s.Handler()

	rec := get(t, h, "/assets/app.js")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "console.log") {
		t.Errorf("asset: status = %d body = %q", rec.Code, rec.Body)
	}
	if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "immutable") {
		t.Errorf("asset Cache-Control = %q, want immutable", cc)
	}

	// An unknown path is a client route, so it must render the SPA shell.
	rec = get(t, h, "/some/client/route")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "quanticode") {
		t.Errorf("fallback: status = %d body = %q", rec.Code, rec.Body)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-cache" {
		t.Errorf("index Cache-Control = %q, want no-cache", cc)
	}
}

func TestStaticDoesNotEscapeWebDir(t *testing.T) {
	s, web := newServer(t)
	secret := filepath.Join(filepath.Dir(web), "secret.txt")
	mustWrite(t, secret, "do not serve me")

	rec := get(t, s.Handler(), "/../secret.txt")
	if strings.Contains(rec.Body.String(), "do not serve me") {
		t.Fatal("served a file from outside the web directory")
	}
}

func TestHealthz(t *testing.T) {
	s, _ := newServer(t)
	rec := get(t, s.Handler(), "/healthz")
	if rec.Code != http.StatusOK || rec.Body.String() != "ok" {
		t.Errorf("healthz: status = %d body = %q", rec.Code, rec.Body)
	}
}

func TestGzip(t *testing.T) {
	s, _ := newServer(t)
	h := s.Handler()

	req := httptest.NewRequest(http.MethodGet, "/api/repo", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if enc := rec.Header().Get("Content-Encoding"); enc != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", enc)
	}
	if v := rec.Header().Get("Vary"); !strings.Contains(v, "Accept-Encoding") {
		t.Errorf("Vary = %q, want Accept-Encoding", v)
	}
	zr, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatalf("gzip reader: %v", err)
	}
	body, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("gunzip: %v", err)
	}
	var p map[string]any
	if err := json.Unmarshal(body, &p); err != nil {
		t.Fatalf("decoded body is not JSON: %v", err)
	}
	if _, ok := p["meta"]; !ok {
		t.Error("decompressed payload has no meta")
	}
}

func TestGzipSkippedWithoutAcceptEncoding(t *testing.T) {
	s, _ := newServer(t)
	rec := get(t, s.Handler(), "/api/repo")
	if enc := rec.Header().Get("Content-Encoding"); enc != "" {
		t.Errorf("Content-Encoding = %q, want none", enc)
	}
	var p map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
		t.Fatalf("plain body is not JSON: %v", err)
	}
}

func TestSlugify(t *testing.T) {
	cases := map[string]string{
		"runyard":               "runyard",
		"Runyard AI":            "runyard-ai",
		"productize-cloud/spec": "productize-cloud-spec",
		"My_Repo.v2":            "my-repo-v2",
		"--edges--":             "edges",
		"!!!":                   "",
	}
	for in, want := range cases {
		if got := server.Slugify(in); got != want {
			t.Errorf("Slugify(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSlugs(t *testing.T) {
	s, _ := newServer(t)
	got := s.Slugs()
	if len(got) != 2 || got[0] != "alpha" || got[1] != "beta" {
		t.Errorf("Slugs() = %v, want [alpha beta]", got)
	}
	// The returned slice must be a copy; mutating it must not affect the server.
	got[0] = "mutated"
	if s.Slugs()[0] != "alpha" {
		t.Error("Slugs() exposed internal state")
	}
}
