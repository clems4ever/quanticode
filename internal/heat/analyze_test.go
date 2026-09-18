package heat_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/clems4ever/quanticode/internal/heat"
	"github.com/clems4ever/quanticode/internal/testrepo"
)

var (
	day1 = time.Date(2024, 1, 10, 12, 0, 0, 0, time.UTC)
	day2 = time.Date(2024, 2, 15, 8, 0, 0, 0, time.UTC)
	day3 = time.Date(2024, 3, 20, 16, 0, 0, 0, time.UTC)
)

// fixture builds a repository with a known, mixed history:
//
//	a.go  3 lines: 2 from day1 (Ada), 1 from day3 (Grace)
//	b.go  2 lines: both from day2 (Grace)
//	go.sum        generated, so flagged
func fixture(t *testing.T) *heat.Analyzer {
	t.Helper()
	r := testrepo.New(t)

	r.WriteLines("a.go", "alpha", "beta", "gamma")
	r.Commit("add a", "Ada", "ada@example.com", day1)

	r.WriteLines("b.go", "one", "two")
	r.WriteLines("go.sum", "example.com/m v1.0.0 h1:abc=")
	r.Commit("add b and lockfile", "Grace", "grace@example.com", day2)

	r.WriteLines("a.go", "alpha", "BETA CHANGED", "gamma")
	r.Commit("touch a", "Grace", "grace@example.com", day3)

	return &heat.Analyzer{Slug: "fix", Name: "fixture", Dir: r.Dir}
}

func fileByPath(t *testing.T, p *heat.RepoPayload, path string) heat.FileHeat {
	t.Helper()
	for _, f := range p.Files {
		if f.Path == path {
			return f
		}
	}
	t.Fatalf("file %q not in payload", path)
	return heat.FileHeat{}
}

func TestPayloadFileAggregates(t *testing.T) {
	p, err := fixture(t).Payload()
	if err != nil {
		t.Fatalf("Payload: %v", err)
	}

	a := fileByPath(t, p, "a.go")
	if a.Lines != 3 {
		t.Errorf("a.go lines = %d, want 3", a.Lines)
	}
	if a.LastEdit != day3.Unix() {
		t.Errorf("a.go lastEdit = %d, want %d", a.LastEdit, day3.Unix())
	}
	if a.FirstEdit != day1.Unix() {
		t.Errorf("a.go firstEdit = %d, want %d", a.FirstEdit, day1.Unix())
	}
	if a.Commits != 2 {
		t.Errorf("a.go commits = %d, want 2", a.Commits)
	}
	if a.Authors != 2 {
		t.Errorf("a.go authors = %d, want 2", a.Authors)
	}
	// Two of three lines are Ada's, so she is the top author.
	if a.TopAuthor != "Ada" {
		t.Errorf("a.go topAuthor = %q, want Ada", a.TopAuthor)
	}
	if a.Ext != "go" {
		t.Errorf("a.go ext = %q, want go", a.Ext)
	}

	// Buckets are the line counts per distinct edit time, newest first.
	if len(a.Buckets) != 2 {
		t.Fatalf("a.go buckets = %v, want 2", a.Buckets)
	}
	if a.Buckets[0].Time != day3.Unix() || a.Buckets[0].Lines != 1 {
		t.Errorf("a.go newest bucket = %+v, want {day3, 1}", a.Buckets[0])
	}
	if a.Buckets[1].Time != day1.Unix() || a.Buckets[1].Lines != 2 {
		t.Errorf("a.go oldest bucket = %+v, want {day1, 2}", a.Buckets[1])
	}
}

// Every file's buckets must account for exactly its line count: the frontend
// divides by that total to get a mean, so a mismatch silently skews all heat.
func TestBucketsSumToLineCount(t *testing.T) {
	p, err := fixture(t).Payload()
	if err != nil {
		t.Fatalf("Payload: %v", err)
	}
	for _, f := range p.Files {
		sum := 0
		for _, b := range f.Buckets {
			sum += b.Lines
		}
		if sum != f.Lines {
			t.Errorf("%s: buckets sum to %d, want %d", f.Path, sum, f.Lines)
		}
	}
}

func TestBucketsAreSortedNewestFirst(t *testing.T) {
	p, err := fixture(t).Payload()
	if err != nil {
		t.Fatalf("Payload: %v", err)
	}
	for _, f := range p.Files {
		for i := 1; i < len(f.Buckets); i++ {
			if f.Buckets[i-1].Time < f.Buckets[i].Time {
				t.Errorf("%s: buckets out of order at %d", f.Path, i)
			}
		}
	}
}

func TestGeneratedFilesAreFlaggedNotDropped(t *testing.T) {
	p, err := fixture(t).Payload()
	if err != nil {
		t.Fatalf("Payload: %v", err)
	}
	sum := fileByPath(t, p, "go.sum")
	if !sum.Generated {
		t.Error("go.sum should be flagged generated")
	}
	if sum.Lines == 0 {
		t.Error("go.sum should still be analysed, so the toggle can reveal it")
	}
	if a := fileByPath(t, p, "a.go"); a.Generated {
		t.Error("a.go should not be flagged generated")
	}
}

func TestAuthorsRankedBySurvivingLines(t *testing.T) {
	p, err := fixture(t).Payload()
	if err != nil {
		t.Fatalf("Payload: %v", err)
	}
	if len(p.Authors) != 2 {
		t.Fatalf("authors = %+v, want 2", p.Authors)
	}
	// Grace: 1 line of a.go + 2 of b.go + 1 of go.sum = 4. Ada: 2.
	if p.Authors[0].Name != "Grace" || p.Authors[0].Lines != 4 {
		t.Errorf("top author = %+v, want Grace with 4 lines", p.Authors[0])
	}
	if p.Authors[1].Name != "Ada" || p.Authors[1].Lines != 2 {
		t.Errorf("second author = %+v, want Ada with 2 lines", p.Authors[1])
	}
	if p.Authors[0].Commits != 2 {
		t.Errorf("Grace commits = %d, want 2", p.Authors[0].Commits)
	}
	if p.Authors[0].LastEdit != day3.Unix() {
		t.Errorf("Grace lastEdit = %d, want %d", p.Authors[0].LastEdit, day3.Unix())
	}
}

func TestMeta(t *testing.T) {
	p, err := fixture(t).Payload()
	if err != nil {
		t.Fatalf("Payload: %v", err)
	}
	m := p.Meta
	if m.Name != "fixture" || m.Slug != "fix" {
		t.Errorf("name/slug = %q/%q", m.Name, m.Slug)
	}
	if m.Branch != "main" {
		t.Errorf("branch = %q, want main", m.Branch)
	}
	if m.CommitCount != 3 {
		t.Errorf("commitCount = %d, want 3", m.CommitCount)
	}
	if m.FirstCommit != day1.Unix() {
		t.Errorf("firstCommit = %d, want %d", m.FirstCommit, day1.Unix())
	}
	if m.LastCommit != day3.Unix() {
		t.Errorf("lastCommit = %d, want %d", m.LastCommit, day3.Unix())
	}
	if m.TotalFiles != 3 {
		t.Errorf("totalFiles = %d, want 3", m.TotalFiles)
	}
	if m.TotalLines != 6 {
		t.Errorf("totalLines = %d, want 6", m.TotalLines)
	}
	if len(m.HeadShort) != 8 || m.Head[:8] != m.HeadShort {
		t.Errorf("headShort %q does not prefix head %q", m.HeadShort, m.Head)
	}
}

func TestTimeline(t *testing.T) {
	p, err := fixture(t).Payload()
	if err != nil {
		t.Fatalf("Payload: %v", err)
	}
	if len(p.Timeline) != 3 {
		t.Fatalf("timeline = %+v, want 3 days", p.Timeline)
	}
	if p.Timeline[0].Date != "2024-01-10" {
		t.Errorf("first day = %q", p.Timeline[0].Date)
	}
	if p.Timeline[2].Date != "2024-03-20" {
		t.Errorf("last day = %q", p.Timeline[2].Date)
	}
	// The third commit rewrote one line of a.go.
	if got := p.Timeline[2]; got.Commits != 1 || got.Added != 1 || got.Removed != 1 {
		t.Errorf("last day = %+v, want 1 commit +1/-1", got)
	}
}

// A second call must not re-blame the repository, and a new commit must
// invalidate the cache.
func TestPayloadCachedUntilHeadMoves(t *testing.T) {
	r := testrepo.New(t)
	r.WriteLines("a.go", "one")
	r.Commit("first", "Ada", "ada@example.com", day1)
	a := &heat.Analyzer{Slug: "c", Name: "c", Dir: r.Dir}

	first, err := a.Payload()
	if err != nil {
		t.Fatalf("Payload: %v", err)
	}
	second, err := a.Payload()
	if err != nil {
		t.Fatalf("Payload again: %v", err)
	}
	if first != second {
		t.Error("second call re-analysed an unchanged repository")
	}

	r.WriteLines("a.go", "one", "two")
	r.Commit("second", "Ada", "ada@example.com", day2)

	third, err := a.Payload()
	if err != nil {
		t.Fatalf("Payload after commit: %v", err)
	}
	if third == second {
		t.Fatal("cache was not invalidated by a new commit")
	}
	if third.Meta.TotalLines != 2 {
		t.Errorf("totalLines = %d, want 2", third.Meta.TotalLines)
	}
}

func TestFileReturnsLinesWithCommits(t *testing.T) {
	fp, err := fixture(t).File("a.go")
	if err != nil {
		t.Fatalf("File: %v", err)
	}
	if fp.Path != "a.go" || fp.Ext != "go" {
		t.Errorf("path/ext = %q/%q", fp.Path, fp.Ext)
	}
	if len(fp.Lines) != 3 {
		t.Fatalf("lines = %d, want 3", len(fp.Lines))
	}
	want := []string{"alpha", "BETA CHANGED", "gamma"}
	for i, w := range want {
		if fp.Lines[i].Text != w {
			t.Errorf("line %d = %q, want %q", i+1, fp.Lines[i].Text, w)
		}
		if _, ok := fp.Commits[fp.Lines[i].SHA]; !ok {
			t.Errorf("line %d references sha %q missing from the commit map", i+1, fp.Lines[i].SHA)
		}
	}
	if fp.Commits[fp.Lines[1].SHA].Time != day3.Unix() {
		t.Error("the changed line should carry the newest commit")
	}
}

func TestFileRejectsUnknownPath(t *testing.T) {
	if _, err := fixture(t).File("nope.go"); err == nil {
		t.Error("File on a missing path should fail")
	}
}

// Buckets ship once per distinct edit time per file; the object form would
// roughly triple the payload, so the tuple encoding is load-bearing.
func TestBucketMarshalsAsTuple(t *testing.T) {
	got, err := json.Marshal(heat.Bucket{Time: 1700000000, Lines: 42})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if string(got) != "[1700000000,42]" {
		t.Errorf("Bucket JSON = %s, want [1700000000,42]", got)
	}
}

func TestBinaryFilesAreExcluded(t *testing.T) {
	r := testrepo.New(t)
	r.WriteLines("code.go", "package main")
	r.Write("logo.bin", "PNG\x00\x01\x02binary")
	r.Commit("init", "Ada", "ada@example.com", day1)

	p, err := (&heat.Analyzer{Slug: "b", Name: "b", Dir: r.Dir}).Payload()
	if err != nil {
		t.Fatalf("Payload: %v", err)
	}
	for _, f := range p.Files {
		if f.Path == "logo.bin" {
			t.Error("binary file should not be analysed: blame of it is meaningless")
		}
	}
	if p.Meta.TotalFiles != 1 {
		t.Errorf("totalFiles = %d, want 1", p.Meta.TotalFiles)
	}
}

func TestEmptyRepositoryDoesNotPanic(t *testing.T) {
	r := testrepo.New(t)
	r.WriteLines("only.go", "package only")
	r.Commit("init", "Ada", "ada@example.com", day1)
	// Remove the only file, leaving a repo with history but no tracked content.
	r.Write("only.go", "")
	r.Commit("empty it", "Ada", "ada@example.com", day2)

	p, err := (&heat.Analyzer{Slug: "e", Name: "e", Dir: r.Dir}).Payload()
	if err != nil {
		t.Fatalf("Payload: %v", err)
	}
	if p.Meta.TotalLines != 0 {
		t.Errorf("totalLines = %d, want 0", p.Meta.TotalLines)
	}
}
