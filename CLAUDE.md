# Working on quanticode

Standing context for anyone — human or agent — changing this repository. The
README says what quanticode *is*; this says what to keep true while changing it.

## What this is for

quanticode gives a human measurable perspectives on a codebase, so that code
nobody hand-wrote can still be trusted. One lens so far: **heat**, a map of a git
repository coloured by how recently each line last changed.

That purpose decides arguments. A change that makes the map prettier but makes a
number less honest is the wrong change.

## Every UI change must work on desktop *and* mobile

This is the rule that gets broken most easily, because a type check and a unit
test both pass on a layout nobody can use on a phone.

**Hover does not exist on a touch screen.** Anything reachable only by hovering
does not exist on half the devices this is read on. When a hover reveals
something, there must be a second route to the same information — the treemap
hover card has its commit repeated on every row of the rankings for exactly this
reason.

Before pushing a UI change, look at it on both:

```sh
make build
./quanticode -addr :8099 -web web/dist -cache /tmp/qc-cache &
cd web && npm run shots -- http://127.0.0.1:8099/github.com/gin-gonic/gin
```

That writes desktop, phone and light-mode screenshots to
`/tmp/quanticode-shots/` and exits non-zero on any console error. Look at the
images. The script asserts nothing about pixels on purpose — a heat map's
colours depend on today's date, so a pixel assertion would fail every morning —
so the judgement is still yours.

## The invariants worth protecting

**Heat is the encoding.** Colour on a tile, a row or a gutter means recency and
nothing else. Anything else that wants colour — syntax highlighting, chart
series, badges — must stay quieter than it. The file view's syntax theme is
deliberately restrained for this reason.

**Colour is never the only channel.** The rankings repeat heat as bar length;
the timeline repeats it as bar height. A reader who cannot distinguish the ramp
still gets the ordering.

**The colour ramp is gated by a test, not by taste.** `npm test` checks
lightness monotonicity, hot-end contrast and lightness span in both schemes. If
a ramp change fails it, the ramp is wrong, not the test.

**Numbers in the README are measured.** There are performance and calibration
tables in there with real figures. If a change moves them, re-measure and edit
them; do not leave a claim standing because it used to be true.

## Choices that were measured, not guessed

Three defaults in here look arbitrary and are not. Each was chosen against real
repository data, and the reasoning is in the code comment next to it. If you
change one, measure it the same way rather than substituting a different guess.

- **Half-life calibration** (`web/src/lib/stats.ts`) — the most spread among the
  half-lives that do not wash the map to the hot end. Maximising spread alone
  picks a year on authelia/authelia, which is the rendering it exists to fix.
- **Activity window** (`web/src/lib/timeline.ts`) — the shortest window with at
  least a dozen active days. A fixed 30 days draws gin-gonic/gin, a healthy
  project, as abandoned.
- **Index limits** (`internal/index/index.go`) — a byte budget, a file ceiling
  and a disk budget, because any stranger can name any repository.

## Layout

```
cmd/quanticode/     flag parsing and process wiring, nothing else
internal/gitrepo/   git commands: clone, list, blame, text/binary detection
internal/source/    the URL shape: host/owner/repo, parsed and validated
internal/forge/     asks a host about a repository before it is cloned
internal/index/     lazy on-demand cloning, refresh, limits and eviction
internal/heat/      the blame sweep and the per-file aggregates (the heat lens)
internal/server/    HTTP API, gzip, static hosting of the SPA
internal/testrepo/  builds throwaway git repos for the tests
web/                React + TypeScript + Mantine, Vite, Vitest
web/scripts/        the screenshot check above
```

## Conventions

**Go tests build real git repositories** (`internal/testrepo`) with pinned commit
times and assert against actual blame output. Blame's line attribution is what
the whole app rests on; mocking it would test nothing. Keep it that way.

**Pure logic lives in `web/src/lib/` and is tested there.** Components are
verified by looking at them. If a piece of a component is worth asserting on,
move it into `lib/` first — that is how `heat`, `tree`, `stats`, `timeline` and
`source` ended up there.

**Payload keys are short** (`p`, `l`, `k`, `le`, `lc`) because one ships per file
and a large repository has thousands. Comment the meaning in the Go struct and
in `web/src/lib/api.ts`; do not lengthen them.

**Keep the entry bundle small.** Anything heavy loads on demand — syntax
highlighting pulls its core, its regex engine and each grammar as separate
chunks on first file open, so a visit that never opens a file pays nothing. A
static import of something large is easy to add by accident; check
`npm run build` output when adding a dependency.

**Nothing may be fetched from a CDN at runtime.** An instance is often a
container with a repository mounted into it and no route to the internet.
Everything ships from the instance's own `/assets`.

## Releasing

Actions → **Release** → choose patch, minor or major. The version is derived from
the highest existing `v*` tag. See the README for what the workflow does.
