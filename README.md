# quanticode

Measurable perspectives on a codebase, so that code nobody hand-wrote can still
be trusted. One perspective so far — **heat**.

**Heat** is a map of a git repository where every file and every line is
coloured by how recently it last changed: recent code glows, untouched code goes
cold. It answers "what is actually moving, and what has been still for years"
before a single file is opened.

![the map](docs/desktop-dark.png)

## What it shows

**The map** is a squarified treemap of the repository. Area is line count,
colour is heat, and directories keep their children adjacent and carry their own
aggregate heat in the frame and label — so an entire area of the codebase reads
hot or cold before any individual file is examined. Click a folder label to zoom
in; click a file to open it.

**The ranking** puts the same children of the folder in view in a strict
hottest-to-coldest order, so the question can also be answered by reading top to
bottom rather than by hunting for colour. Folders rank ahead of loose files.

**The file view** shows one file line by line, each row carrying the heat of the
commit that last touched it, with a whole-file minimap and the commit behind the
line under the cursor.

**The timeline** is commit activity over the repository's life, with each bar at
its own position on the same heat scale.

## The heat model

A line's heat is an exponential decay of its age:

```
heat = 0.5 ^ (age / half-life)
```

A line edited right now is `1.0`; one edited a half-life ago is `0.5`; two
half-lives ago `0.25`. The **half-life** is the one knob the reader turns — it
sets what "recent" is being measured against. A week answers "what is this
sprint touching"; a quarter answers "which parts of the architecture are still
moving". It defaults to roughly a sixth of the repository's own history, so the
colour scale is spent on the range that repo actually spans.

A file's heat is the line-weighted mean of its lines' heat (**Every line**), so
a 500-line file where one line changed yesterday is correctly cold. Switch to
**Last touch** to colour by the single most recent edit instead.

A directory's heat is recomputed from the merged lines of everything beneath it,
not averaged from its children's heat — so one huge cold file and one tiny hot
one land where the line counts say they should.

### The colour scale

One sequential ramp, because heat is one magnitude. It runs cold slate → violet
→ ember → amber, strictly monotonic in lightness, with its own steps per mode:
on dark the hot end is the bright one, on light the hot end is the dark one, so
"hot" is always the salient end against the surface it is drawn on.

That gate is a test, not a script somebody has to remember to run: `npm test`
checks lightness monotonicity, hot-end contrast and lightness span for both
ramps, so a colour change that breaks the encoding fails CI.

Heat is also encoded by bar length in the rankings, so the ordering survives
without colour.

## Generated and data files

Lock files, vendored and generated code, tool caches and bulk data are hidden by
default: they distort both size and heat without reflecting anyone's work. One
230k-line tool cache was swamping a map trying to show where people work. The
toggle brings them back. Detection covers `vendor/`, `node_modules/`, `gen/`,
`*-gen/` output directories, top-level dot-directories other than `.github`,
`*.gen.go` / `*.pb.go`, lock files, and data-extension files past 2000 lines.

## Running it

### With Docker

```sh
docker run --rm -p 8090:8090 \
  -v /path/to/a/git/clone:/repo:ro \
  ghcr.io/clems4ever/quanticode:latest \
  -repo myrepo=/repo
```

Then open <http://localhost:8090>. Images are published for `linux/amd64` and
`linux/arm64` on every release, tagged `latest`, `X.Y.Z`, `X.Y` and `X`.

Mount the repository read-only — quanticode only ever reads. It runs as a non-root
user and reads a clone owned by whatever uid the host uses, which git would
normally refuse as "dubious ownership"; the image sets `safe.directory` through
the environment so it works under any `--user` and without a writable HOME.

Serve several repositories by repeating the flag and the mount:

```sh
docker run --rm -p 8090:8090 \
  -v ~/code/api:/repos/api:ro -v ~/code/web:/repos/web:ro \
  ghcr.io/clems4ever/quanticode:latest \
  -repo api=/repos/api -repo web=/repos/web
```

The repository is then chosen with `?repo=<slug>`. To give each one its own
address instead, run one container per repository on its own port.

### From source

Needs Go 1.22+ and Node 20+, and a local clone of whatever you want to look at.
The Go side has no dependencies outside the standard library.

```sh
make install                          # frontend dependencies
make run REPO=/path/to/a/git/clone    # build both, then serve on :8090
```

Or by hand:

```sh
cd web && npm install && npm run build && cd ..
go build -o quanticode ./cmd/quanticode
./quanticode -addr :8090 -repo myrepo=/path/to/clone -web web/dist
```

`-repo` is repeatable (`name=/path`, or just `/path`), and the repository is
chosen with `?repo=<slug>`. To give each repository its own address, run one
instance per repo on its own port — that is what `./run.sh` does.

For frontend work, `npm run dev` in `web/` proxies `/api` to `127.0.0.1:8099`.

## Development

```sh
make test     # Go tests with -race, plus the frontend suite
make lint     # gofmt, go vet, oxlint, tsc
make help     # everything else
```

Both run in CI on every push and pull request, along with a job that builds the
Docker image and smoke-tests it by serving the checkout through it — so a
release is never the first time anyone finds out the image is broken.

The Go tests build real throwaway git repositories with pinned commit times
(`internal/testrepo`) and assert against actual blame output, rather than
mocking git — blame's line attribution is the one thing the whole app rests on,
so it is worth testing for real. The frontend tests cover the heat model, the
tree aggregation, the summary statistics and the colour ramps.

## How it works

The backend shells out to `git blame --line-porcelain -M -w` once per tracked
file across a worker pool — the whole of a 600-file repository in a couple of
seconds — and reduces each file to the line counts grouped by last-edit
timestamp. That aggregate is a few hundred numbers per file, so the entire
repository ships as one ~35 KB gzipped payload and every control (half-life,
metric, filter, zoom) is recomputed in the browser with no round trip. Per-line
blame is fetched on demand when a file is opened. Results are cached per HEAD,
so a reload is free until the repository actually moves.

```
cmd/quanticode/     flag parsing and process wiring, nothing else
internal/gitrepo/   git commands: list, blame, binary and generated detection
internal/heat/      the blame sweep and the per-file aggregates (the heat lens)
internal/server/    HTTP API, gzip, static hosting of the SPA
internal/testrepo/  builds throwaway git repos for the tests
web/                React + TypeScript + Mantine
```

## Releasing

Every release is a tag, and the tag is what publishes.

Actions → **Release** → *Run workflow*, then choose **patch**, **minor** or
**major**. The next version is derived from the highest existing `v*` tag —
`v0.4.2` plus *minor* is `v0.5.0`, and a repository with no tags yet starts from
`v0.0.0`, so the first *minor* release is `v0.1.0`. Pre-release tags are skipped
when working out where you are, so an `-rc` never becomes the base for a bump.

From there the workflow runs the whole CI suite against the commit being
released, creates and pushes the tag, builds the multi-arch image, pushes it to
GHCR, pulls it back and checks it actually serves a repository, then cuts the
GitHub release with generated notes and the `Dockerfile` that built the image
attached as an asset.

Pushing a `v*` tag by hand does the same thing, minus the tag creation — use
that when you want to name the version exactly rather than bump it.

A version containing a hyphen (`v0.3.0-rc.1`) is treated as a pre-release, as is
anything released with the pre-release box ticked: it publishes under its exact
version only, and does not move `latest`, `X.Y` or `X`.

## Licence

[Apache 2.0](LICENSE).
