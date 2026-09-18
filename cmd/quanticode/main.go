// Command quanticode serves a heatmap of one or more git repositories: every file
// and every line coloured by how recently it last changed.
package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"runtime/debug"
	"strings"
	"time"

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
	flag.Var(&repos, "repo", "repository to analyse, as name=/path or /path (repeatable)")
	flag.Parse()

	if *showVersion {
		fmt.Println(Version())
		return
	}

	srv, err := server.New(repos, *webDir)
	if err != nil {
		log.Fatal(err)
	}

	// Analyse up front so the first visitor gets a warm cache.
	go srv.Warm()

	log.Printf("quanticode %s listening on %s, serving %v from %s", Version(), *addr, srv.Slugs(), *webDir)
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
