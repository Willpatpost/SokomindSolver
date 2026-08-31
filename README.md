# Sokomind

A polished, fully static Sokoban application built for GitHub Pages. It keeps
Sokomind's clean domain and solver boundaries while replacing its server
hosting layer with a portable Vite build.

## Highlights

- A validated, source-checked puzzle catalog with typed-box rooms
- Responsive keyboard, touch, and mouse controls
- Animated crates, matching goal sockets, and a characterful keeper
- Optional procedural sound effects and ambient music with no downloaded audio
- Ambient background motion and a one-shot puzzle-completion celebration
- System-aware reduced motion plus persistent sound and motion preferences
- Exact autosave/recovery, undo, guarded restart, and personal bests
- Shareable puzzle/replay links and portable progress import/export
- URL-addressable, accessible 50-row catalog pages with on-demand board shards
- Installable offline PWA behavior with repository-subpath-safe assets
- Pure immutable game rules with no React or browser dependencies
- Default Sokomind Solver with structural macros, guided push search, compact
  bidirectional frontiers, and bounded move-count rewriting
- DFS, Greedy, A*, and IDA* alternatives behind the same typed adapter
  boundary
- Live solver telemetry, bounded status history, and verified route playback
- Automated unit, static, browser, accessibility, and Pages deployment checks

The application has no API, database, account system, or runtime server.
Progress and preferences remain in the browser's local storage.

## Local development

Requirements: Node.js 22.13 or newer.

```powershell
npm install
npm run dev
```

The production build is also an ordinary static directory:

```powershell
npm run build
npm run preview
```

## Quality checks

```powershell
npm run typecheck
npm run lint
npm test
npm run test:coverage
npm run test:browser
npm run test:solver:multi
npm run test:solver:huge
npm run benchmark:solver -- --puzzle=huge
```

`npm test` runs domain and preference tests, creates the production build, and
then verifies that every emitted script, stylesheet, and public asset is safe
to deploy beneath a GitHub project-page path. `npm run test:browser` adds
Playwright interaction tests and axe accessibility scans at `/Sokomind/` by
default. Set `SOKOMIND_PREVIEW_BASE_PATH` to verify any other project path.
The intentionally separate `test:solver:huge` guardrail replay-solves Grand
Hall in base, mirrored, and rotated orientations and checks the reviewed
move-count rewrite. `benchmark:solver` emits JSON Lines for the isolated
hard/master corpus and accepts a versioned heuristic profile through
`SOKOMIND_TUNING_JSON`.

## GitHub Pages

The workflow at `.github/workflows/deploy-pages.yml` validates and deploys
`dist/` whenever `main` is updated. In the repository's **Settings > Pages**
screen, choose **GitHub Actions** as the publishing source once. No generated
build files need to be committed.

Vite uses `base: "./"`, so the same output works at `/Sokomind/`, on a custom
domain, and through a local static server. The workflow derives temporary
Pages metadata from the repository and accepts a `PUBLIC_SITE_URL` repository
variable for the final canonical domain. See
[docs/deployment.md](docs/deployment.md) for the complete deployment contract.

## Project structure

```text
Sokomind/
|-- .github/                 Pages workflow and dependency updates
|-- public/                  PWA, metadata assets, and .nojekyll
|-- scripts/                 Cross-platform Pages preview/test helpers
|-- src/
|   |-- catalog/             Definitions, generated metadata, and board shards
|   |-- core/                Pure parsing, rules, state, and validation
|   |-- features/
|   |   |-- experience/      Audio, music, motion, ambience, celebration
|   |   |-- game/            Board, controls, and play orchestration
|   |   |-- help/            Instructions and keyboard guidance
|   |   |-- selector/        Searchable and filterable puzzle curriculum
|   |   |-- progress/        Backup, import, and reset UI
|   |   `-- solver/          Search controls, telemetry, and route playback
|   |-- shared/              Safe storage, replay persistence, dialogs, links
|   |-- solver/              Search engine, adapters, verification, worker runtime
|   |-- App.tsx              UI composition
|   `-- main.tsx             Browser composition root
|-- docs/                    Architecture and extension guides
|-- tests/
|   |-- e2e/                 Playwright and axe browser tests
|   |-- performance/         Explicit Grand Hall solver guardrail
|   |-- unit/                Deterministic domain and runtime tests
|   `-- static-build.test.mjs
|-- index.html               Static metadata and application mount point
`-- vite.config.ts           Portable static build configuration
```

The dependency direction is intentional:

```text
catalog ----\
             +--> game UI --> App
core -------/

core <------ solver contracts
experience --> game UI and App
```

`src/core` never imports React, storage, animation, audio, or solver code.
Solvers consume the same serializable geometry and snapshot types as the game
and run in a module worker without changing board rendering.

Home and the selector consume a compact generated metadata index. Play routes
load only the 50-board shard containing the requested puzzle, so the Home
dependency closure never includes the complete board corpus.

The canonical `U/D/L/R` action log is shared by autosave, exact replay,
shareable routes, and solver playback. Undo uses a persistent linked
history, so long routes do not copy every earlier snapshot per move.

## Documentation

- [Living project reference](docs/PROJECT-REFERENCE.md) — authoritative owners,
  contracts, source-derived versions, routes, storage keys, and validation
- [Architecture](docs/architecture.md)
- [Consolidated August 11 audit](docs/archive/AUG11AUDIT.MD)
- [August 11 improvements roadmap](docs/archive/AUG11IMPROVEMENTS.MD)
- [Experience, sound, and motion](docs/experience.md)
- [GitHub Pages deployment](docs/deployment.md)
- [Solver integration](docs/solver-integration.md)
- [Solver Lab guide and metric definitions](docs/solver-lab.md)
- [Puzzle format](docs/puzzle-format.md)
- [Testing strategy](docs/testing.md)
- [Persistence and sharing](docs/persistence-and-sharing.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)
- [MIT license](LICENSE)

## Puzzle data note

Puzzle rows, identifiers, titles, difficulty tiers, hints, and ordering are
preserved from Sokomind. Six legacy `boxes` metadata values disagreed with
their boards; the catalog corrects those values from the rows and locks them
with invariant tests. Grand Hall contains 17 boxes.

## Current scope

This repository is the static user application and extension architecture.
`Sokomind Solver` is the default bounded search. It ports the strongest
legacy typed-box kernel into an isolated nested worker and combines a
deterministic structural plan lane with guided and bidirectional discovery.
Every candidate is replayed through the immutable Sokomind core before the UI
can expose it. Fast mode returns Grand Hall without comparison, harvesting, or
rewriting; quality mode may improve that verified route. The reviewed counters
for both paths are generated from the executable performance guardrail into the
living project reference. Neither bounded result is a claim of optimality.

The classic family remains available for comparison and exact-search research.
Its A* and IDA* results are accepted as move-optimal proof only after exact
request/progress validation, canonical route replay, and proof-bound checks.
Current safeguards, feature controls, and performance caveats live in the
project reference and Solver V2 progress guide.
