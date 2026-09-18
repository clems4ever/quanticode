// Package gitrepo wraps the git commands quanticode needs: listing tracked files,
// blaming them line by line, and classifying what is not hand-written source.
package gitrepo

import (
	"bufio"
	"bytes"
	"fmt"
	"os/exec"
	"path"
	"strconv"
	"strings"
)

// Commit is a single commit's identity, shared by every line it authored.
type Commit struct {
	SHA     string `json:"sha"`
	Short   string `json:"short"`
	Author  string `json:"author"`
	Email   string `json:"email"`
	Time    int64  `json:"time"`
	Summary string `json:"summary"`
}

// Run executes a git command inside repo and returns stdout.
func Run(repo string, args ...string) ([]byte, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = repo
	cmd.Env = append(cmd.Environ(), "GIT_OPTIONAL_LOCKS=0", "LC_ALL=C")
	var out, errb bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errb
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(errb.String()))
	}
	return out.Bytes(), nil
}

// Line runs a git command and returns its output with surrounding space trimmed.
func Line(repo string, args ...string) (string, error) {
	out, err := Run(repo, args...)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// ListFiles returns every tracked path at HEAD. It reads the commit rather than
// the index, so it works the same in a bare clone, which has no index at all.
func ListFiles(repo string) ([]string, error) {
	out, err := Run(repo, "ls-tree", "-r", "--name-only", "-z", "HEAD")
	if err != nil {
		return nil, err
	}
	raw := bytes.Split(out, []byte{0})
	files := make([]string, 0, len(raw))
	for _, b := range raw {
		if len(b) > 0 {
			files = append(files, string(b))
		}
	}
	return files, nil
}

// Blame runs a porcelain blame and returns one commit SHA per line, plus
// every commit it referenced. Line text is only collected when withText is set,
// so the repo-wide sweep does not hold the whole tree in memory.
func Blame(repo, file string, withText bool) (shas []string, text []string, commits map[string]Commit, err error) {
	cmd := exec.Command("git", "blame", "--line-porcelain", "--root", "-M", "-w", "HEAD", "--", file)
	cmd.Dir = repo
	cmd.Env = append(cmd.Environ(), "GIT_OPTIONAL_LOCKS=0", "LC_ALL=C")
	var errb bytes.Buffer
	cmd.Stderr = &errb
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, nil, nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, nil, nil, err
	}

	commits = map[string]Commit{}
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 0, 256*1024), 8*1024*1024)

	var cur string
	pending := Commit{}
	for sc.Scan() {
		line := sc.Text()
		switch {
		case strings.HasPrefix(line, "\t"):
			// Content line: closes the current blame entry.
			if cur != "" {
				if _, ok := commits[cur]; !ok {
					pending.SHA = cur
					pending.Short = cur[:min(8, len(cur))]
					commits[cur] = pending
				}
				shas = append(shas, cur)
				if withText {
					text = append(text, line[1:])
				}
			}
			pending = Commit{}
		case len(line) >= 40 && isHex(line[:40]) && (len(line) == 40 || line[40] == ' '):
			cur = line[:40]
		case strings.HasPrefix(line, "author "):
			pending.Author = strings.TrimPrefix(line, "author ")
		case strings.HasPrefix(line, "author-mail "):
			pending.Email = strings.Trim(strings.TrimPrefix(line, "author-mail "), "<>")
		case strings.HasPrefix(line, "author-time "):
			pending.Time, _ = strconv.ParseInt(strings.TrimPrefix(line, "author-time "), 10, 64)
		case strings.HasPrefix(line, "summary "):
			pending.Summary = strings.TrimPrefix(line, "summary ")
		}
	}
	if err := sc.Err(); err != nil {
		cmd.Wait()
		return nil, nil, nil, err
	}
	if err := cmd.Wait(); err != nil {
		return nil, nil, nil, fmt.Errorf("blame %s: %w: %s", file, err, strings.TrimSpace(errb.String()))
	}
	return shas, text, commits, nil
}

func isHex(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// TextFiles returns every tracked path git considers textual, in one command.
//
// The per-file alternative is `git show HEAD:<path>` for each of them, which
// reads the whole blob to look at its first eight kilobytes. That is a process
// and a full read per file where this is a process and a scan for the entire
// repository — 0.14s against 7.5s across 3,359 files.
//
// An empty file matches nothing and so is absent here. That costs nothing: a
// blame of it yields no lines and it is dropped either way.
func TextFiles(repo string) (map[string]bool, error) {
	// -I is "ignore binary", and an empty pattern matches every line, so this
	// names precisely the files git would blame.
	out, err := Run(repo, "grep", "-I", "--name-only", "-z", "-e", "", "HEAD")
	if err != nil {
		// git grep exits 1 when nothing matched, which for a repository of only
		// binaries is a true answer rather than a failure.
		return map[string]bool{}, nil
	}
	files := map[string]bool{}
	for _, b := range bytes.Split(out, []byte{0}) {
		if len(b) == 0 {
			continue
		}
		// Entries are "HEAD:path" because the search names a revision.
		if i := bytes.IndexByte(b, ':'); i >= 0 {
			b = b[i+1:]
		}
		if len(b) > 0 {
			files[string(b)] = true
		}
	}
	return files, nil
}

// IsBinary reports whether git considers the blob untextual, using the same
// NUL-byte heuristic git itself applies.
func IsBinary(repo, file string) bool {
	out, err := Run(repo, "show", "HEAD:"+file)
	if err != nil {
		return false
	}
	head := out
	if len(head) > 8000 {
		head = head[:8000]
	}
	return bytes.IndexByte(head, 0) >= 0
}

// Directory names that never contain hand-written source.
var generatedSegments = map[string]bool{
	"vendor": true, "node_modules": true, "third_party": true, "dist": true,
	"build": true, "__pycache__": true, "gen": true, "genv1": true, "generated": true,
}

var generatedNames = []string{
	"go.sum", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "poetry.lock",
}

// Extensions that hold data rather than code. Small ones are usually
// hand-maintained config; past the threshold they are machine output.
var dataExts = map[string]bool{
	"json": true, "yaml": true, "yml": true, "csv": true, "tsv": true,
	"ndjson": true, "svg": true, "txt": true, "lock": true, "sum": true,
}

const bulkDataLines = 2000

// IsGenerated flags machine-written files so they can be dimmed or filtered.
// They distort both size and heat: a 230k-line tool cache swamps a treemap that
// is trying to show where people are working, and it is nobody's code.
func IsGenerated(p string, lines int) bool {
	lower := strings.ToLower(p)
	segments := strings.Split(lower, "/")

	for i, seg := range segments[:len(segments)-1] {
		if generatedSegments[seg] {
			return true
		}
		// Output directories of a code generator: "k8s-charts-gen/", "proto_gen/".
		if strings.HasSuffix(seg, "-gen") || strings.HasSuffix(seg, "_gen") {
			return true
		}
		// Top-level dot-directories are tool state, not source. .github is the
		// exception: CI config is written and reviewed like any other file.
		if i == 0 && strings.HasPrefix(seg, ".") && seg != ".github" {
			return true
		}
	}

	base := path.Base(lower)
	for _, n := range generatedNames {
		if base == strings.ToLower(n) {
			return true
		}
	}

	if dataExts[Ext(lower)] && lines >= bulkDataLines {
		return true
	}

	return strings.HasSuffix(lower, ".gen.go") ||
		strings.HasSuffix(lower, ".pb.go") ||
		strings.HasSuffix(lower, "_generated.go") ||
		strings.Contains(base, ".gen.") ||
		strings.Contains(base, "_pb.") ||
		strings.HasSuffix(lower, ".min.js") ||
		strings.HasSuffix(lower, ".min.css")
}

func Ext(p string) string {
	e := strings.TrimPrefix(path.Ext(p), ".")
	if e == "" {
		return path.Base(p)
	}
	return strings.ToLower(e)
}
