// Package source turns the path half of a quanticode URL into the repository it
// names, so that prepending the service to a forge URL is all a visitor has to
// do:
//
//	https://quanticode.dev/github.com/torvalds/linux
//
// Nothing here touches the network. Parsing is deliberately strict — every
// accepted value becomes a directory name and a git remote, so anything odd is
// rejected here rather than defended against in three later places.
package source

import (
	"errors"
	"fmt"
	"strings"
)

// Hosts that may be indexed, mapped to the scheme their clone URLs use. A forge
// is added here rather than anywhere else.
var hosts = map[string]string{
	"github.com": "https",
}

// ErrNoSource means the path named no repository at all — the landing page.
var ErrNoSource = errors.New("no repository in path")

// UnsupportedHostError reports a forge quanticode will not clone from.
type UnsupportedHostError struct{ Host string }

func (e *UnsupportedHostError) Error() string {
	return fmt.Sprintf("%q is not a supported host (try github.com/owner/repo)", e.Host)
}

// Source is one indexable repository.
type Source struct {
	Host  string `json:"host"`
	Owner string `json:"owner"`
	Name  string `json:"name"`
}

// Hosts lists the forges that may be indexed.
func Hosts() []string {
	out := make([]string, 0, len(hosts))
	for h := range hosts {
		out = append(out, h)
	}
	return out
}

// String is the canonical "github.com/owner/repo" form, which is also the URL
// path and the key everything else is stored under.
func (s Source) String() string { return s.Host + "/" + s.Owner + "/" + s.Name }

// Label is the short "owner/repo" shown in the UI.
func (s Source) Label() string { return s.Owner + "/" + s.Name }

// CloneURL is the remote git is pointed at.
func (s Source) CloneURL() string { return hosts[s.Host] + "://" + s.String() + ".git" }

// WebURL is the repository's page on its forge.
func (s Source) WebURL() string { return hosts[s.Host] + "://" + s.String() }

// Dir is the on-disk location of the clone, relative to the cache root. The
// three segments are already validated, so this cannot escape the root.
func (s Source) Dir() string { return s.Host + "/" + s.Owner + "/" + s.Name + ".git" }

// Parse reads a source from a URL path or a bare "host/owner/repo" string.
//
// It accepts what a person would actually paste: a leading slash, a trailing
// slash, a ".git" suffix, a "https://" prefix, and the extra path segments
// GitHub puts on a branch or file URL ("/tree/main", "/blob/main/x.go") — those
// are dropped, because the repository is what is being named.
func Parse(p string) (Source, error) {
	p = strings.TrimSpace(p)
	p = strings.TrimPrefix(p, "/")
	// A whole URL pasted in after the service name.
	for _, scheme := range []string{"https://", "http://"} {
		p = strings.TrimPrefix(p, scheme)
	}
	p = strings.TrimSuffix(p, "/")
	if p == "" {
		return Source{}, ErrNoSource
	}

	parts := strings.Split(p, "/")
	if len(parts) < 3 {
		return Source{}, fmt.Errorf("%q is not a repository: expected host/owner/name", p)
	}

	host := strings.ToLower(parts[0])
	if _, ok := hosts[host]; !ok {
		return Source{}, &UnsupportedHostError{Host: host}
	}

	owner, name := parts[1], strings.TrimSuffix(parts[2], ".git")
	if err := validSegment(owner, "owner"); err != nil {
		return Source{}, err
	}
	if err := validSegment(name, "repository"); err != nil {
		return Source{}, err
	}
	return Source{Host: host, Owner: owner, Name: name}, nil
}

// validSegment allows what the supported forges allow in a name, and nothing
// else. In particular it rejects anything that would climb out of the cache
// directory, and any leading dash, which git would read as an option.
func validSegment(s, what string) error {
	if s == "" {
		return fmt.Errorf("empty %s", what)
	}
	if len(s) > 100 {
		return fmt.Errorf("%s is too long", what)
	}
	if s == "." || s == ".." || strings.HasPrefix(s, "-") {
		return fmt.Errorf("%q is not a valid %s", s, what)
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '-', r == '_', r == '.':
		default:
			return fmt.Errorf("%q is not a valid %s", s, what)
		}
	}
	return nil
}
