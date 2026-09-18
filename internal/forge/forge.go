// Package forge asks a hosting provider about a repository before anything is
// cloned.
//
// This exists because of how badly the alternative behaves. Enforcing a size
// budget by watching a clone grow does work — the clone is killed the moment it
// passes — but finding out that way costs minutes of transfer and a loaded
// machine, and the visitor stares at a progress screen the whole time only to be
// told no. torvalds/linux is 6.2 GB; one HTTP request says so in well under a
// second.
//
// The probe is advisory. Any failure — rate limit, network, an unexpected body —
// returns no information rather than an error the caller must handle, and the
// clone proceeds with the byte budget as the backstop. A forge being unreachable
// must not take the service down with it.
package forge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/clems4ever/quanticode/internal/source"
)

// Info is what a forge will tell us about a repository without cloning it.
type Info struct {
	SizeBytes     int64
	DefaultBranch string
	Archived      bool
	Fork          bool
}

// ErrNotFound means the forge is sure there is no such public repository —
// either it does not exist, or it is private. The two are deliberately
// indistinguishable from the outside, and saying so is more honest than
// guessing.
var ErrNotFound = errors.New("no such public repository")

// APIBase maps a host to its REST base. A host absent from here simply is not
// probed.
var APIBase = map[string]string{
	"github.com": "https://api.github.com",
}

// Client probes a forge. The zero value is usable.
type Client struct {
	HTTP    *http.Client
	BaseFor func(host string) string // overridden in tests
	// Token, when set, is sent as a bearer token. Unauthenticated GitHub allows
	// 60 requests an hour per address, which is thin for a busy public instance;
	// a token raises it to 5000. Only ever used for the probe, never for cloning.
	Token string
}

func (c *Client) httpClient() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{Timeout: 10 * time.Second}
}

func (c *Client) base(host string) string {
	if c.BaseFor != nil {
		return c.BaseFor(host)
	}
	return APIBase[host]
}

// Probe asks about one repository.
//
// It returns (nil, nil) when nothing could be learned — an unsupported host, a
// rate limit, a network failure. Only ErrNotFound is a verdict.
func (c *Client) Probe(ctx context.Context, src source.Source) (*Info, error) {
	base := c.base(src.Host)
	if base == "" {
		return nil, nil
	}
	url := fmt.Sprintf("%s/repos/%s/%s", strings.TrimSuffix(base, "/"), src.Owner, src.Name)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, nil
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "quanticode")
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}

	resp, err := c.httpClient().Do(req)
	if err != nil {
		return nil, nil
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusNotFound:
		return nil, ErrNotFound
	default:
		// 403 and 429 are the rate limit; 5xx is the forge having a bad day.
		// Neither says anything about the repository, so say nothing.
		return nil, nil
	}

	// Cap the read: this is a response from a third party.
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, nil
	}
	var raw struct {
		Size          int64  `json:"size"` // kibibytes, as GitHub measures it
		DefaultBranch string `json:"default_branch"`
		Archived      bool   `json:"archived"`
		Fork          bool   `json:"fork"`
		Private       bool   `json:"private"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, nil
	}
	if raw.Private {
		return nil, ErrNotFound
	}
	// A zero size is what GitHub reports for a repository it has not finished
	// measuring, and for an empty one. Treating it as "unknown" keeps the clone
	// from being waved through on a number that means nothing.
	if raw.Size <= 0 {
		return &Info{DefaultBranch: raw.DefaultBranch, Archived: raw.Archived, Fork: raw.Fork}, nil
	}
	return &Info{
		SizeBytes:     raw.Size * 1024,
		DefaultBranch: raw.DefaultBranch,
		Archived:      raw.Archived,
		Fork:          raw.Fork,
	}, nil
}
