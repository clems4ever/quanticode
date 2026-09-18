package index_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/clems4ever/quanticode/internal/forge"
	"github.com/clems4ever/quanticode/internal/index"
	"github.com/clems4ever/quanticode/internal/source"
	"github.com/clems4ever/quanticode/internal/testrepo"
)

// newIndex builds an index that clones from a local path instead of a forge, so
// the suite exercises the real clone, fetch and analyse path without a network.
func newIndex(t *testing.T, from string, opts index.Options) *index.Index {
	t.Helper()
	opts.Dir = t.TempDir()
	opts.CloneURL = func(source.Source) string { return from }
	if opts.Probe == nil {
		// No pre-flight by default: these sources are not on a real forge, and
		// the suite must not touch the network.
		opts.Probe = func(context.Context, source.Source) (*forge.Info, error) { return nil, nil }
	}
	ix, err := index.New(opts)
	if err != nil {
		t.Fatalf("index.New: %v", err)
	}
	t.Cleanup(ix.Close)
	return ix
}

func mustSource(t *testing.T, s string) source.Source {
	t.Helper()
	src, err := source.Parse(s)
	if err != nil {
		t.Fatalf("Parse(%q): %v", s, err)
	}
	return src
}

// await polls until nothing is in flight, like the browser does. Ready and
// refreshing at once is a real state — the stale answer is being served while a
// new one is built — so settling means ready and *not* refreshing.
func await(t *testing.T, ix *index.Index, src source.Source) index.Status {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		st := ix.Status(src)
		if (st.State == index.StateReady && !st.Refreshing) || st.State == index.StateFailed {
			return st
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s, last state %q", src, ix.Status(src).State)
	return index.Status{}
}

func TestIndexIsLazyThenServes(t *testing.T) {
	r := testrepo.New(t)
	r.WriteLines("main.go", "package main", "func main() {}")
	r.WriteLines("README.md", "# hello")
	r.Commit("first", "Ada", "ada@example.com", time.Now().Add(-48*time.Hour))

	ix := newIndex(t, r.Dir, index.Options{})
	src := mustSource(t, "github.com/example/repo")

	// Nothing has been asked for, so nothing has been done.
	if st := ix.Status(src); st.State == index.StateReady {
		t.Fatal("index did work before anything was requested")
	}

	// The first request starts the work and returns no payload.
	repo, st := ix.Get(src)
	if repo != nil {
		t.Fatalf("first Get returned a repository immediately, state %q", st.State)
	}

	if st := await(t, ix, src); st.State != index.StateReady {
		t.Fatalf("state = %q, error %q", st.State, st.Error)
	}

	repo, st = ix.Get(src)
	if repo == nil {
		t.Fatalf("Get after ready returned nothing, state %q error %q", st.State, st.Error)
	}
	p := repo.Payload
	if p.Meta.TotalFiles != 2 {
		t.Errorf("TotalFiles = %d, want 2", p.Meta.TotalFiles)
	}
	if p.Meta.TotalLines != 3 {
		t.Errorf("TotalLines = %d, want 3", p.Meta.TotalLines)
	}
	if len(p.Authors) != 1 || p.Authors[0].Name != "Ada" {
		t.Errorf("Authors = %+v, want one entry for Ada", p.Authors)
	}
}

func TestRefreshPicksUpNewCommits(t *testing.T) {
	r := testrepo.New(t)
	r.WriteLines("a.go", "package a")
	r.Commit("first", "Ada", "ada@example.com", time.Now().Add(-72*time.Hour))

	// A TTL of zero makes every read stale, which is how the refresh path is
	// reached without waiting a day.
	ix := newIndex(t, r.Dir, index.Options{TTL: time.Nanosecond})
	src := mustSource(t, "github.com/example/repo")

	ix.Get(src)
	if st := await(t, ix, src); st.State != index.StateReady {
		t.Fatalf("first index failed: %q %q", st.State, st.Error)
	}

	r.WriteLines("b.go", "package b", "// second file")
	r.Commit("second", "Grace", "grace@example.com", time.Now())

	// The stale read still serves the old answer rather than blocking...
	repo, st := ix.Get(src)
	if repo == nil {
		t.Fatal("a stale entry should still serve its cached analysis")
	}
	if repo.Payload == nil {
		t.Fatal("a stale entry should carry the previous payload")
	}
	if !st.Refreshing {
		t.Error("a stale entry should report that it is refreshing")
	}
	if got := repo.Payload.Meta.TotalFiles; got != 1 {
		t.Errorf("stale read served %d files, want the previous answer of 1", got)
	}

	// ...and the refresh lands.
	if st := await(t, ix, src); st.State != index.StateReady {
		t.Fatalf("refresh failed: %q %q", st.State, st.Error)
	}
	repo, _ = ix.Get(src)
	p := repo.Payload
	if p.Meta.TotalFiles != 2 {
		t.Errorf("TotalFiles after refresh = %d, want 2", p.Meta.TotalFiles)
	}
	var sawGrace bool
	for _, a := range p.Authors {
		if a.Name == "Grace" {
			sawGrace = true
		}
	}
	if !sawGrace {
		t.Errorf("refresh did not pick up the new author: %+v", p.Authors)
	}
}

func TestTooManyFilesIsRefused(t *testing.T) {
	r := testrepo.New(t)
	r.WriteLines("a.go", "package a")
	r.WriteLines("b.go", "package b")
	r.WriteLines("c.go", "package c")
	r.Commit("first", "Ada", "ada@example.com", time.Now())

	ix := newIndex(t, r.Dir, index.Options{MaxFiles: 2})
	src := mustSource(t, "github.com/example/repo")

	ix.Get(src)
	st := await(t, ix, src)
	if st.State != index.StateFailed {
		t.Fatalf("state = %q, want failed", st.State)
	}
	if st.Error == "" {
		t.Error("a failure should say why")
	}
}

func TestFailureIsRememberedRatherThanRetriedOnEveryRequest(t *testing.T) {
	// Nothing to clone from: every attempt fails.
	ix := newIndex(t, "/nonexistent/path/to/nothing.git", index.Options{
		FailTTL:      time.Hour,
		CloneTimeout: 10 * time.Second,
	})
	src := mustSource(t, "github.com/example/gone")

	ix.Get(src)
	if st := await(t, ix, src); st.State != index.StateFailed {
		t.Fatalf("state = %q, want failed", st.State)
	}

	// A second request inside the failure window reports the same failure
	// without queueing more work.
	repo, st := ix.Get(src)
	if repo != nil {
		t.Fatal("a failed entry should not return a repository")
	}
	if st.State != index.StateFailed {
		t.Errorf("state = %q, want the remembered failure", st.State)
	}
}

func TestConcurrentGetsDoNotDuplicateWork(t *testing.T) {
	r := testrepo.New(t)
	r.WriteLines("a.go", "package a")
	r.Commit("first", "Ada", "ada@example.com", time.Now())

	ix := newIndex(t, r.Dir, index.Options{})
	src := mustSource(t, "github.com/example/repo")

	// Hammer the same source from several goroutines: with -race this is what
	// catches the locking going wrong.
	done := make(chan struct{})
	for i := 0; i < 8; i++ {
		go func() {
			defer func() { done <- struct{}{} }()
			for j := 0; j < 20; j++ {
				ix.Get(src)
				ix.Status(src)
			}
		}()
	}
	for i := 0; i < 8; i++ {
		<-done
	}

	if st := await(t, ix, src); st.State != index.StateReady {
		t.Fatalf("state = %q, error %q", st.State, st.Error)
	}
}

func TestPreflightRefusesBeforeCloning(t *testing.T) {
	r := testrepo.New(t)
	r.WriteLines("a.go", "package a")
	r.Commit("first", "Ada", "ada@example.com", time.Now())

	var probed int
	ix := newIndex(t, r.Dir, index.Options{
		RepoBudget: 100 << 20,
		Probe: func(context.Context, source.Source) (*forge.Info, error) {
			probed++
			return &forge.Info{SizeBytes: 6 << 30}, nil // a Linux-sized repository
		},
	})
	src := mustSource(t, "github.com/example/huge")

	ix.Get(src)
	st := await(t, ix, src)
	if st.State != index.StateFailed {
		t.Fatalf("state = %q, want failed", st.State)
	}
	if probed == 0 {
		t.Error("the forge was never asked")
	}
	// The point of the pre-flight is the message: it must name the real size
	// rather than whatever the clone happened to reach before being killed.
	if !strings.Contains(st.Error, "6144 MB") || !strings.Contains(st.Error, "100 MB") {
		t.Errorf("error = %q, want it to name both the size and the limit", st.Error)
	}
}

func TestPreflightNotFoundIsRefusedImmediately(t *testing.T) {
	ix := newIndex(t, "/nonexistent", index.Options{
		Probe: func(context.Context, source.Source) (*forge.Info, error) {
			return nil, forge.ErrNotFound
		},
	})
	src := mustSource(t, "github.com/example/gone")

	ix.Get(src)
	st := await(t, ix, src)
	if st.State != index.StateFailed {
		t.Fatalf("state = %q, want failed", st.State)
	}
	if !strings.Contains(st.Error, "no such public repository") {
		t.Errorf("error = %q, want the not-found message", st.Error)
	}
}

func TestPreflightFailureFallsThroughToTheClone(t *testing.T) {
	r := testrepo.New(t)
	r.WriteLines("a.go", "package a")
	r.Commit("first", "Ada", "ada@example.com", time.Now())

	// A forge that says nothing useful — rate limited, unreachable — must not
	// stop a repository being indexed.
	ix := newIndex(t, r.Dir, index.Options{
		Probe: func(context.Context, source.Source) (*forge.Info, error) { return nil, nil },
	})
	src := mustSource(t, "github.com/example/repo")

	ix.Get(src)
	if st := await(t, ix, src); st.State != index.StateReady {
		t.Fatalf("state = %q, error %q", st.State, st.Error)
	}
}
