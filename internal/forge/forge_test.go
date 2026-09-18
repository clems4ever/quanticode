package forge_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/clems4ever/quanticode/internal/forge"
	"github.com/clems4ever/quanticode/internal/source"
)

func clientFor(t *testing.T, handler http.HandlerFunc) *forge.Client {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return &forge.Client{BaseFor: func(string) string { return srv.URL }}
}

func src(t *testing.T) source.Source {
	t.Helper()
	s, err := source.Parse("github.com/torvalds/linux")
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestProbeReadsTheSize(t *testing.T) {
	c := clientFor(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/torvalds/linux" {
			t.Errorf("path = %q", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"size": 6361962, "default_branch": "master", "archived": false}`))
	})

	info, err := c.Probe(context.Background(), src(t))
	if err != nil {
		t.Fatalf("Probe: %v", err)
	}
	if info == nil {
		t.Fatal("no info")
	}
	// GitHub reports kibibytes.
	if want := int64(6361962) * 1024; info.SizeBytes != want {
		t.Errorf("SizeBytes = %d, want %d", info.SizeBytes, want)
	}
	if info.DefaultBranch != "master" {
		t.Errorf("DefaultBranch = %q", info.DefaultBranch)
	}
}

func TestProbeNotFound(t *testing.T) {
	c := clientFor(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	if _, err := c.Probe(context.Background(), src(t)); !errors.Is(err, forge.ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound", err)
	}
}

func TestProbeTreatsPrivateAsNotFound(t *testing.T) {
	c := clientFor(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"size": 12, "private": true}`))
	})
	if _, err := c.Probe(context.Background(), src(t)); !errors.Is(err, forge.ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound", err)
	}
}

// Everything below must be advisory: a forge that cannot answer may not stop a
// repository being indexed, because the byte budget is still there to catch it.
func TestProbeIsAdvisoryOnFailure(t *testing.T) {
	cases := map[string]http.HandlerFunc{
		"rate limited": func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusForbidden)
		},
		"too many requests": func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusTooManyRequests)
		},
		"server error": func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		},
		"nonsense body": func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`not json at all`))
		},
	}
	for name, handler := range cases {
		t.Run(name, func(t *testing.T) {
			c := clientFor(t, handler)
			info, err := c.Probe(context.Background(), src(t))
			if err != nil {
				t.Errorf("err = %v, want nil so the clone goes ahead", err)
			}
			if info != nil {
				t.Errorf("info = %+v, want nil", info)
			}
		})
	}
}

func TestProbeUnknownHostIsNotProbed(t *testing.T) {
	c := &forge.Client{BaseFor: func(string) string { return "" }}
	info, err := c.Probe(context.Background(), src(t))
	if info != nil || err != nil {
		t.Errorf("Probe = (%+v, %v), want (nil, nil)", info, err)
	}
}

func TestProbeZeroSizeIsUnknownRatherThanEmpty(t *testing.T) {
	// GitHub reports 0 for a repository it has not measured yet. Reporting that
	// as a real size would wave anything through the budget check.
	c := clientFor(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"size": 0, "default_branch": "main"}`))
	})
	info, err := c.Probe(context.Background(), src(t))
	if err != nil {
		t.Fatal(err)
	}
	if info == nil {
		t.Fatal("no info")
	}
	if info.SizeBytes != 0 {
		t.Errorf("SizeBytes = %d, want 0 meaning unknown", info.SizeBytes)
	}
}
