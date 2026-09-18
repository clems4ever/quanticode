package source_test

import (
	"testing"

	"github.com/clems4ever/quanticode/internal/source"
)

func TestParseAcceptsWhatPeoplePaste(t *testing.T) {
	want := source.Source{Host: "github.com", Owner: "torvalds", Name: "linux"}
	for _, in := range []string{
		"github.com/torvalds/linux",
		"/github.com/torvalds/linux",
		"/github.com/torvalds/linux/",
		"github.com/torvalds/linux.git",
		"https://github.com/torvalds/linux",
		"http://github.com/torvalds/linux",
		"  github.com/torvalds/linux  ",
		"GitHub.com/torvalds/linux",
		// The extra segments GitHub puts on a branch or file URL: the
		// repository is still what is being named.
		"github.com/torvalds/linux/tree/master",
		"github.com/torvalds/linux/blob/master/Makefile",
	} {
		got, err := source.Parse(in)
		if err != nil {
			t.Errorf("Parse(%q): unexpected error %v", in, err)
			continue
		}
		if got != want {
			t.Errorf("Parse(%q) = %+v, want %+v", in, got, want)
		}
	}
}

func TestParseRejects(t *testing.T) {
	for _, in := range []string{
		"",
		"/",
		"github.com",
		"github.com/torvalds",
		"gitlab.com/gitlab-org/gitlab", // host not enabled
		"evil.example/a/b",
		"github.com/../etc/passwd",
		"github.com/owner/../../etc",
		"github.com/owner/..",
		"github.com/-flag/repo",    // git would read a leading dash as an option
		"github.com/owner/-flag",   // ditto
		"github.com/ow ner/repo",   // space
		"github.com/owner/re;po",   // shell metacharacter
		"github.com/owner/re\x00o", // NUL
	} {
		if got, err := source.Parse(in); err == nil {
			t.Errorf("Parse(%q) = %+v, want an error", in, got)
		}
	}
}

func TestParseTraversalCannotEscapeTheCacheDir(t *testing.T) {
	// Every accepted source becomes a directory name, so this is the property
	// that matters most: no accepted input may contain a path separator or a
	// parent reference in any single segment.
	for _, in := range []string{
		"github.com/owner/repo",
		"github.com/owner.name/repo.name",
		"github.com/o_w-n/r_e-p.o",
	} {
		s, err := source.Parse(in)
		if err != nil {
			t.Fatalf("Parse(%q): %v", in, err)
		}
		for _, seg := range []string{s.Owner, s.Name} {
			if seg == "." || seg == ".." {
				t.Errorf("Parse(%q) produced a traversal segment %q", in, seg)
			}
			for _, r := range seg {
				if r == '/' || r == '\\' || r == 0 {
					t.Errorf("Parse(%q) produced a separator in %q", in, seg)
				}
			}
		}
	}
}

func TestURLs(t *testing.T) {
	s, err := source.Parse("github.com/clems4ever/quanticode")
	if err != nil {
		t.Fatal(err)
	}
	if got, want := s.String(), "github.com/clems4ever/quanticode"; got != want {
		t.Errorf("String() = %q, want %q", got, want)
	}
	if got, want := s.Label(), "clems4ever/quanticode"; got != want {
		t.Errorf("Label() = %q, want %q", got, want)
	}
	if got, want := s.CloneURL(), "https://github.com/clems4ever/quanticode.git"; got != want {
		t.Errorf("CloneURL() = %q, want %q", got, want)
	}
	if got, want := s.WebURL(), "https://github.com/clems4ever/quanticode"; got != want {
		t.Errorf("WebURL() = %q, want %q", got, want)
	}
	if got, want := s.Dir(), "github.com/clems4ever/quanticode.git"; got != want {
		t.Errorf("Dir() = %q, want %q", got, want)
	}
}
