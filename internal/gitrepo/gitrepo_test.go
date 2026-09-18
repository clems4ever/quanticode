package gitrepo_test

import (
	"testing"
	"time"

	"github.com/clems4ever/quanticode/internal/gitrepo"
	"github.com/clems4ever/quanticode/internal/testrepo"
)

var (
	t1 = time.Date(2024, 1, 10, 12, 0, 0, 0, time.UTC)
	t2 = time.Date(2024, 3, 20, 9, 30, 0, 0, time.UTC)
)

func TestListFiles(t *testing.T) {
	r := testrepo.New(t)
	r.WriteLines("a.go", "package a")
	r.WriteLines("nested/dir/b.go", "package b")
	r.Write("untracked.txt", "not committed")
	r.Commit("first", "Ada", "ada@example.com", t1)

	files, err := gitrepo.ListFiles(r.Dir)
	if err != nil {
		t.Fatalf("ListFiles: %v", err)
	}
	want := map[string]bool{"a.go": true, "nested/dir/b.go": true, "untracked.txt": true}
	if len(files) != len(want) {
		t.Fatalf("got %d files %v, want %d", len(files), files, len(want))
	}
	for _, f := range files {
		if !want[f] {
			t.Errorf("unexpected file %q", f)
		}
	}
}

// Blame must attribute each line to the commit that last changed *that line*,
// not to the file's most recent commit.
func TestBlameAttributesLinesToTheirOwnCommit(t *testing.T) {
	r := testrepo.New(t)
	r.WriteLines("f.go", "one", "two", "three")
	first := r.Commit("first", "Ada", "ada@example.com", t1)

	r.WriteLines("f.go", "one", "TWO CHANGED", "three")
	second := r.Commit("second", "Grace", "grace@example.com", t2)

	shas, text, commits, err := gitrepo.Blame(r.Dir, "f.go", true)
	if err != nil {
		t.Fatalf("Blame: %v", err)
	}
	if len(shas) != 3 {
		t.Fatalf("got %d lines, want 3", len(shas))
	}
	want := []string{first, second, first}
	for i, w := range want {
		if shas[i] != w {
			t.Errorf("line %d: got sha %s, want %s", i+1, shas[i][:7], w[:7])
		}
	}
	if got := []string{"one", "TWO CHANGED", "three"}; text[0] != got[0] || text[1] != got[1] || text[2] != got[2] {
		t.Errorf("text = %q, want %q", text, got)
	}

	c := commits[second]
	if c.Author != "Grace" {
		t.Errorf("author = %q, want Grace", c.Author)
	}
	if c.Email != "grace@example.com" {
		t.Errorf("email = %q, want grace@example.com", c.Email)
	}
	if c.Time != t2.Unix() {
		t.Errorf("time = %d, want %d", c.Time, t2.Unix())
	}
	if c.Summary != "second" {
		t.Errorf("summary = %q, want %q", c.Summary, "second")
	}
	if len(c.Short) != 8 || c.Short != second[:8] {
		t.Errorf("short = %q, want %q", c.Short, second[:8])
	}
}

// withText=false is the repo-wide sweep's mode: it must still return every
// line's sha without accumulating the file's contents.
func TestBlameWithoutTextSkipsContent(t *testing.T) {
	r := testrepo.New(t)
	r.WriteLines("f.go", "a", "b", "c", "d")
	r.Commit("only", "Ada", "ada@example.com", t1)

	shas, text, _, err := gitrepo.Blame(r.Dir, "f.go", false)
	if err != nil {
		t.Fatalf("Blame: %v", err)
	}
	if len(shas) != 4 {
		t.Errorf("got %d shas, want 4", len(shas))
	}
	if len(text) != 0 {
		t.Errorf("got %d text lines, want none", len(text))
	}
}

func TestBlameEmptyAndMissingFiles(t *testing.T) {
	r := testrepo.New(t)
	r.Write("empty.txt", "")
	r.WriteLines("real.txt", "x")
	r.Commit("init", "Ada", "ada@example.com", t1)

	shas, _, _, err := gitrepo.Blame(r.Dir, "empty.txt", false)
	if err != nil {
		t.Fatalf("Blame on empty file: %v", err)
	}
	if len(shas) != 0 {
		t.Errorf("empty file produced %d lines, want 0", len(shas))
	}

	if _, _, _, err := gitrepo.Blame(r.Dir, "does-not-exist.txt", false); err == nil {
		t.Error("blaming a missing file should fail")
	}
}

func TestIsBinary(t *testing.T) {
	r := testrepo.New(t)
	r.Write("text.txt", "plain text\nsecond line\n")
	r.Write("binary.bin", "head\x00\x01\x02tail")
	r.Commit("init", "Ada", "ada@example.com", t1)

	if gitrepo.IsBinary(r.Dir, "text.txt") {
		t.Error("text.txt classified as binary")
	}
	if !gitrepo.IsBinary(r.Dir, "binary.bin") {
		t.Error("binary.bin not classified as binary")
	}
}

func TestIsGenerated(t *testing.T) {
	cases := []struct {
		path  string
		lines int
		want  bool
		why   string
	}{
		{"internal/server/api.go", 400, false, "ordinary source"},
		{"README.md", 200, false, "ordinary docs"},
		{"ui/src/App.tsx", 300, false, "ordinary frontend source"},

		{"vendor/github.com/x/y.go", 100, true, "vendored"},
		{"ui/node_modules/left-pad/index.js", 10, true, "node_modules"},
		{"go.sum", 50, true, "lock file"},
		{"ui/package-lock.json", 100, true, "lock file"},
		{"api/guest/genv1/guest.gen.go", 7000, true, "generated suffix"},
		{"internal/gen/specdrive/v1/document.pb.go", 8000, true, "protobuf output"},
		{"internal/gen/v1/doc.connect.go", 100, true, "under a gen/ directory"},
		{"ui/main/src/gen/v1/document_pb.d.ts", 4000, true, "under a gen/ directory"},
		{"cmd/k8s-charts-gen/imports/k8s/k8s.go", 45000, true, "output of a *-gen tool"},
		{"assets/app.min.js", 5, true, "minified"},

		// Tool caches live in top-level dot directories; .github is real config.
		{".gograph/graph.json", 230000, true, "tool cache"},
		{".claude/plugins/thing.md", 50, true, "tool state"},
		{".github/workflows/ci.yml", 300, false, ".github is reviewed like source"},

		// Data files are judged by size: small ones are hand-maintained config.
		{"config/settings.json", 40, false, "small config"},
		{"openapi/guest.yaml", 1668, false, "under the bulk threshold"},
		{"data/dump.json", 2000, true, "at the bulk threshold"},
		{"data/dump.json", 1999, false, "just under the bulk threshold"},
		{"docs/notes.md", 5000, false, "markdown is never bulk data"},
	}
	for _, c := range cases {
		if got := gitrepo.IsGenerated(c.path, c.lines); got != c.want {
			t.Errorf("IsGenerated(%q, %d) = %v, want %v (%s)", c.path, c.lines, got, c.want, c.why)
		}
	}
}

func TestExt(t *testing.T) {
	cases := map[string]string{
		"a/b/c.go":     "go",
		"a/b/c.TSX":    "tsx",
		"Makefile":     "Makefile",
		"a/Dockerfile": "Dockerfile",
		".gitignore":   "gitignore",
	}
	for in, want := range cases {
		if got := gitrepo.Ext(in); got != want {
			t.Errorf("Ext(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestRunReportsGitFailure(t *testing.T) {
	r := testrepo.New(t)
	if _, err := gitrepo.Run(r.Dir, "rev-parse", "HEAD"); err == nil {
		t.Error("rev-parse on a repo with no commits should fail")
	}
}
