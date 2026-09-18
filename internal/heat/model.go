// Package analysis turns a git repository into the per-file heat aggregates the
// dashboard is drawn from.
package heat

import (
	"strconv"

	"github.com/clems4ever/quanticode/internal/gitrepo"
)

// Commit is re-exported so API consumers need only this package.
type Commit = gitrepo.Commit

// Bucket groups the lines of one file that share a last-edit timestamp.
// Encoded as a 2-tuple to keep the repo payload small.
type Bucket struct {
	Time  int64
	Lines int
}

// FileHeat is the per-file aggregate the treemap is drawn from. Field names are
// short because this struct ships once per file in the repo payload.
type FileHeat struct {
	Path      string   `json:"p"`
	Lines     int      `json:"l"`
	Bytes     int64    `json:"b"`
	Ext       string   `json:"x"`
	Buckets   []Bucket `json:"k"`
	LastEdit  int64    `json:"le"`
	FirstEdit int64    `json:"fe"`
	Commits   int      `json:"nc"`
	TopAuthor string   `json:"ta"`
	Authors   int      `json:"na"`
	Generated bool     `json:"g,omitempty"`
	Binary    bool     `json:"bin,omitempty"`
}

// AuthorStat is one contributor's standing in the current working tree.
type AuthorStat struct {
	Name     string `json:"name"`
	Email    string `json:"email"`
	Lines    int    `json:"lines"`
	Commits  int    `json:"commits"`
	LastEdit int64  `json:"lastEdit"`
}

// DayStat is one day of commit activity, for the timeline.
type DayStat struct {
	Date    string `json:"d"`
	Commits int    `json:"c"`
	Added   int    `json:"a"`
	Removed int    `json:"r"`
}

// RepoMeta describes the analysed repository and the run that produced it.
type RepoMeta struct {
	Name        string `json:"name"`
	Slug        string `json:"slug"`
	Remote      string `json:"remote"`
	Branch      string `json:"branch"`
	Head        string `json:"head"`
	HeadShort   string `json:"headShort"`
	CommitCount int    `json:"commitCount"`
	FirstCommit int64  `json:"firstCommit"`
	LastCommit  int64  `json:"lastCommit"`
	TotalFiles  int    `json:"totalFiles"`
	TotalLines  int    `json:"totalLines"`
	GeneratedAt int64  `json:"generatedAt"`
	AnalysisMs  int64  `json:"analysisMs"`
}

// RepoPayload is the single response that powers the whole dashboard.
type RepoPayload struct {
	Meta     RepoMeta          `json:"meta"`
	Files    []FileHeat        `json:"files"`
	Authors  []AuthorStat      `json:"authors"`
	Timeline []DayStat         `json:"timeline"`
	Commits  map[string]Commit `json:"commits"`
}

// FileLine is one line of source with a pointer into the commit dictionary.
type FileLine struct {
	Text string `json:"t"`
	SHA  string `json:"c"`
}

// FilePayload is the per-line blame view of a single file.
type FilePayload struct {
	Path    string            `json:"path"`
	Lines   []FileLine        `json:"lines"`
	Commits map[string]Commit `json:"commits"`
	Ext     string            `json:"ext"`
}

// MarshalJSON encodes a Bucket as a [time, lines] tuple. There is one bucket per
// distinct edit time per file, so the object form roughly triples the payload.
func (b Bucket) MarshalJSON() ([]byte, error) {
	out := make([]byte, 0, 24)
	out = append(out, '[')
	out = strconv.AppendInt(out, b.Time, 10)
	out = append(out, ',')
	out = strconv.AppendInt(out, int64(b.Lines), 10)
	return append(out, ']'), nil
}
