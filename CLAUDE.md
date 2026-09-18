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

There are two tools for this, and they answer different questions.

**`npm run test:ui`** drives a real browser against a real instance at a desktop
and a phone viewport, and runs in CI. It exists because of a specific bug: the
file view's redundant vertical scrollbar was hidden with Mantine's
`scrollbars="x"`, which also sets `overflow-y: hidden`, so source files could not
be scrolled at all. Types passed, lint passed, 110 unit tests passed, and a
screenshot of the first forty lines looked perfect. Only moving the wheel showed
it.

```sh
go build -o quanticode ./cmd/quanticode
cd web && npm run build && npm run test:ui
```

The instance it drives serves *this repository* — no network, no clone, and a
history every checkout has. Add a case here whenever a change adds something a
reader has to be able to *do*, not merely see.

**`npm run shots`** writes desktop, phone and light-mode screenshots to
`/tmp/quanticode-shots/` and exits non-zero on a console error. It asserts
nothing about pixels on purpose — a heat map's colours depend on today's date,
so a pixel assertion would fail every morning — so it is for looking, and the
judgement stays yours.

```sh
cd web && npm run shots -- http://127.0.0.1:8099/github.com/gin-gonic/gin
```

Screenshots alone are not enough, and the scrollbar bug is the proof: the
picture was correct and the pane was frozen.

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
web/tests/          browser tests (Playwright), desktop and phone
web/scripts/        the screenshot check above
```

## Conventions

**Go tests build real git repositories** (`internal/testrepo`) with pinned commit
times and assert against actual blame output. Blame's line attribution is what
the whole app rests on; mocking it would test nothing. Keep it that way.

**Pure logic lives in `web/src/lib/` and is tested there** with Vitest. If a
piece of a component is worth asserting on, move it into `lib/` first — that is
how `heat`, `tree`, `stats`, `timeline` and `source` ended up there.

**What a component *does* is tested in `web/tests/`** with a browser. The split
is between a value and a behaviour: whether a half-life is calibrated correctly
is a unit test, whether the pane it colours can be scrolled is not.

Two things keep that suite honest, both learned by getting them wrong:

- **It owns port 8123 and never reuses a running server.** 8099 is where you run
  an instance while working; borrowing it means the suite silently tests
  whatever happens to be listening, and an instance serving no local repository
  shows the landing page instead.
- **It opens a file by name, not by rank.** The Files list is ordered by heat, so
  "the first row" is a different file tomorrow.

**Check exit codes, not output.** `npm test | grep …` reports grep's status, not
the command's — which is how a broken `npm test` reached CI green-looking from
here. Run the step, then look at `$?`.

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
