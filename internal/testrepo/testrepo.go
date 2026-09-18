// Package testrepo builds throwaway git repositories with controlled contents,
// authors and commit timestamps, so tests can assert on blame output exactly
// rather than against whatever history happens to be checked out.
package testrepo

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Repo is a temporary git repository, removed when the test ends.
type Repo struct {
	t   *testing.T
	Dir string
}

// New initialises an empty repository in the test's temp directory.
func New(t *testing.T) *Repo {
	t.Helper()
	dir := t.TempDir()
	r := &Repo{t: t, Dir: dir}
	r.git("init", "--initial-branch=main")
	r.git("config", "user.name", "Test Author")
	r.git("config", "user.email", "test@example.com")
	// Keep blame output stable regardless of the host's git config.
	r.git("config", "core.autocrlf", "false")
	r.git("config", "commit.gpgsign", "false")
	return r
}

// Write creates or replaces a file, creating parent directories as needed.
func (r *Repo) Write(path, content string) {
	r.t.Helper()
	full := filepath.Join(r.Dir, filepath.FromSlash(path))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		r.t.Fatalf("mkdir for %s: %v", path, err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		r.t.Fatalf("write %s: %v", path, err)
	}
}

// WriteLines is Write for content given a line at a time, with a trailing newline.
func (r *Repo) WriteLines(path string, lines ...string) {
	r.Write(path, strings.Join(lines, "\n")+"\n")
}

// Commit stages everything and commits it as author at the given time. Author
// and committer time are both pinned so tests do not depend on the wall clock.
func (r *Repo) Commit(message, author, email string, when time.Time) string {
	r.t.Helper()
	r.git("add", "-A")
	stamp := when.Format(time.RFC3339)
	r.gitEnv([]string{
		"GIT_AUTHOR_DATE=" + stamp,
		"GIT_COMMITTER_DATE=" + stamp,
		"GIT_AUTHOR_NAME=" + author,
		"GIT_AUTHOR_EMAIL=" + email,
		"GIT_COMMITTER_NAME=" + author,
		"GIT_COMMITTER_EMAIL=" + email,
	}, "commit", "-m", message, "--no-gpg-sign")
	return strings.TrimSpace(r.out("rev-parse", "HEAD"))
}

// Head returns the current HEAD sha.
func (r *Repo) Head() string {
	r.t.Helper()
	return strings.TrimSpace(r.out("rev-parse", "HEAD"))
}

func (r *Repo) git(args ...string) { r.t.Helper(); r.gitEnv(nil, args...) }
func (r *Repo) gitEnv(env []string, args ...string) {
	r.t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = r.Dir
	cmd.Env = append(append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null"), env...)
	if out, err := cmd.CombinedOutput(); err != nil {
		r.t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
}

func (r *Repo) out(args ...string) string {
	r.t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = r.Dir
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
	out, err := cmd.Output()
	if err != nil {
		r.t.Fatalf("git %s: %v", strings.Join(args, " "), err)
	}
	return string(out)
}
