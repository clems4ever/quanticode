// Command quanticode serves a heatmap of one or more git repositories: every file
// and every line coloured by how recently it last changed.
package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
	"time"

	"github.com/clems4ever/quanticode/internal/index"
	"github.com/clems4ever/quanticode/internal/server"
)

// version is stamped at build time with -ldflags "-X main.version=v1.2.3".
// Left unset, it falls back to whatever the go tool recorded in the binary.
var version = ""

// repoFlag collects repeated -repo values, each "name=/path" or just "/path".
type repoFlag []server.Repo

func (r *repoFlag) String() string {
	parts := make([]string, 0, len(*r))
	for _, v := range *r {
		parts = append(parts, v.Name+"="+v.Dir)
	}
	return strings.Join(parts, ",")
}

func (r *repoFlag) Set(v string) error {
	name, dir := "", v
	if i := strings.Index(v, "="); i > 0 {
		name, dir = v[:i], v[i+1:]
	}
	*r = append(*r, server.Repo{Name: name, Dir: dir})
	return nil
}

func main() {
	var repos repoFlag
	addr := flag.String("addr", ":8090", "listen address")
	webDir := flag.String("web", "web/dist", "directory of built frontend assets")
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.Var(&repos, "repo", "local repository to analyse, as name=/path or /path (repeatable)")

	// On-demand indexing. With this on, visiting /github.com/owner/repo clones
	// and analyses that repository the first time somebody asks for it.
	doIndex := flag.Bool("index", true, "clone and analyse public repositories named in the URL")
	cacheDir := flag.String("cache", defaultCacheDir(), "where on-demand clones are kept")
	refresh := flag.Duration("refresh", 24*time.Hour, "re-index a repository older than this")
	workers := flag.Int("index-workers", 2, "repositories cloned and analysed at once")
	cloneTimeout := flag.Duration("clone-timeout", 10*time.Minute, "give up on a clone or fetch after this")
	repoBudget := flag.Int64("max-repo-mb", 512, "skip a repository whose clone passes this size")
	diskBudget := flag.Int64("max-disk-mb", 20480, "total disk for clones before the least-used are evicted")
	maxFiles := flag.Int("max-files", 25000, "skip a repository with more tracked files than this")
	flag.Parse()

	if *showVersion {
		fmt.Println(Version())
		return
	}

	var ix *index.Index
	if *doIndex {
		var err error
		ix, err = index.New(index.Options{
			Dir:          *cacheDir,
			TTL:          *refresh,
			Workers:      *workers,
			CloneTimeout: *cloneTimeout,
			RepoBudget:   *repoBudget << 20,
			DiskBudget:   *diskBudget << 20,
			MaxFiles:     *maxFiles,
		})
		if err != nil {
			log.Fatalf("index: %v", err)
		}
		defer ix.Close()
	}

	srv, err := server.NewIndexed(repos, *webDir, ix)
	if err != nil {
		log.Fatal(err)
	}

	// Analyse the local repositories up front so the first visitor gets a warm
	// cache. Indexed ones are deliberately not warmed: nothing is cloned until
	// somebody asks for it.
	go srv.Warm()

	if *doIndex {
		log.Printf("quanticode %s listening on %s, serving %v from %s; indexing on demand into %s, refresh every %s",
			Version(), *addr, srv.Slugs(), *webDir, *cacheDir, *refresh)
	} else {
		log.Printf("quanticode %s listening on %s, serving %v from %s", Version(), *addr, srv.Slugs(), *webDir)
	}
	httpSrv := &http.Server{
		Addr:              *addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	if err := httpSrv.ListenAndServe(); err != nil {
		log.Println(err)
		os.Exit(1)
	}
}

// defaultCacheDir keeps clones under the user cache directory, falling back to
// a directory beside the process when there is no HOME — which is the normal
// case in a container running as a non-root user.
func defaultCacheDir() string {
	if d, err := os.UserCacheDir(); err == nil {
		return filepath.Join(d, "quanticode")
	}
	return "cache"
}

// Version reports the stamped version, falling back to the module version the
// go tool embeds (so `go install` builds are identified too).
func Version() string {
	if version != "" {
		return version
	}
	if info, ok := debug.ReadBuildInfo(); ok && info.Main.Version != "" && info.Main.Version != "(devel)" {
		return info.Main.Version
	}
	return "dev"
}
