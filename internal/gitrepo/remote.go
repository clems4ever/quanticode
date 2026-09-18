package gitrepo

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// ErrTooBig reports a remote whose objects exceeded the byte budget. The clone
// is killed as soon as the budget is passed rather than after it completes, so
// a repository nobody wants to index cannot fill the disk on the way to being
// rejected.
type ErrTooBig struct {
	Bytes  int64
	Budget int64
}

func (e *ErrTooBig) Error() string {
	return fmt.Sprintf("repository is larger than the %d MB budget (reached %d MB)",
		e.Budget>>20, e.Bytes>>20)
}

// remoteEnv is the environment every network git command runs under.
//
// Two things are deliberate here.
//
// Git must never wait on a human: an unauthenticated clone of something private
// would otherwise sit at a username prompt until the context expires, turning a
// clean "not found" into a timeout.
//
// And the ambient git configuration is ignored entirely. This process clones
// public repositories anonymously on behalf of whoever typed a URL, so it must
// not pick up the operator's credential helper, personal access token or
// url.insteadOf rewrites — those would either leak the operator's identity into
// a stranger's request or silently redirect it somewhere else. A proxy is still
// honoured, because git reads http_proxy from the environment rather than from
// a config file.
func remoteEnv() []string {
	return append(os.Environ(),
		"GIT_TERMINAL_PROMPT=0",
		"GIT_ASKPASS=",
		"GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_CONFIG_SYSTEM=/dev/null",
		"GIT_CONFIG_NOSYSTEM=1",
		"GCM_INTERACTIVE=never",
		"GIT_LFS_SKIP_SMUDGE=1",
		"LC_ALL=C",
	)
}

// Clone makes a bare mirror-ish clone of url at dir.
//
// Bare, because nothing here reads a working tree — blame, ls-tree and log all
// work against the object database — and a checkout would roughly double the
// disk for no gain.
//
// The clone is killed if it passes budget bytes, and abandoned if it passes the
// context deadline. A partial clone is removed by the caller.
func Clone(ctx context.Context, url, dir string, budget int64) error {
	if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, "git", "clone", "--bare", "--quiet", "--no-tags", url, dir)
	cmd.Env = remoteEnv()
	cmd.WaitDelay = 5 * time.Second
	var errb bytes.Buffer
	cmd.Stderr = &errb

	if err := cmd.Start(); err != nil {
		return err
	}

	// Watch the clone grow. git reports no usable progress for this, so the
	// budget is enforced on what has actually landed on disk.
	stop := make(chan struct{})
	over := make(chan int64, 1)
	go func() {
		t := time.NewTicker(time.Second)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				if budget <= 0 {
					continue
				}
				if n, _ := DirSize(dir); n > budget {
					select {
					case over <- n:
					default:
					}
					_ = cmd.Process.Kill()
					return
				}
			}
		}
	}()

	err := cmd.Wait()
	close(stop)

	select {
	case n := <-over:
		return &ErrTooBig{Bytes: n, Budget: budget}
	default:
	}
	if err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("clone timed out: %w", ctx.Err())
		}
		return fmt.Errorf("clone failed: %s", firstLine(errb.String()))
	}
	return nil
}

// Fetch updates an existing bare clone in place.
//
// `git clone --bare` deliberately leaves remote.origin.fetch unset, so a plain
// `git fetch origin` would move nothing at all. The refspec is therefore given
// explicitly, and --prune drops branches deleted upstream.
func Fetch(ctx context.Context, dir string) error {
	cmd := exec.CommandContext(ctx, "git", "fetch", "--quiet", "--prune", "--no-tags",
		"origin", "+refs/heads/*:refs/heads/*")
	cmd.Dir = dir
	cmd.Env = remoteEnv()
	cmd.WaitDelay = 5 * time.Second
	var errb bytes.Buffer
	cmd.Stderr = &errb
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("fetch timed out: %w", ctx.Err())
		}
		return fmt.Errorf("fetch failed: %s", firstLine(errb.String()))
	}
	// HEAD is a symref to the default branch. If that branch was renamed
	// upstream, --prune has just deleted what HEAD points at, and every later
	// command would fail on a repository that is actually fine.
	if _, err := Line(dir, "rev-parse", "--verify", "HEAD"); err != nil {
		return repointHEAD(dir)
	}
	return nil
}

// repointHEAD picks a surviving branch for a HEAD left dangling by a rename
// upstream, preferring the names a default branch usually has.
func repointHEAD(dir string) error {
	out, err := Run(dir, "for-each-ref", "--format=%(refname)", "refs/heads/")
	if err != nil {
		return err
	}
	refs := strings.Fields(string(out))
	if len(refs) == 0 {
		return errors.New("remote has no branches")
	}
	pick := refs[0]
	for _, preferred := range []string{"refs/heads/main", "refs/heads/master", "refs/heads/trunk"} {
		for _, r := range refs {
			if r == preferred {
				pick = r
			}
		}
	}
	_, err = Run(dir, "symbolic-ref", "HEAD", pick)
	return err
}

// DirSize totals the bytes of every regular file under dir. A missing directory
// is zero rather than an error: it is the normal state before a clone starts.
func DirSize(dir string) (int64, error) {
	var total int64
	err := filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		if d.IsDir() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil // vanished mid-walk, e.g. a pack being replaced
			}
			return err
		}
		total += info.Size()
		return nil
	})
	if errors.Is(err, fs.ErrNotExist) {
		return 0, nil
	}
	return total, err
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if s == "" {
		return "no output from git"
	}
	return s
}
