# Sokomind Project Reference

This is the living entry point for the current project. It records stable
contracts, ownership, and the important symbols an engineer needs to orient
themselves. Source remains authoritative for implementation details; the
source-derived section below is checked in CI so versions, counts, keys, and
budgets cannot silently drift.

Do not try to duplicate every local variable or helper here. A universal file
that restates all implementation details becomes stale faster than the code.
Use this document to find the owner and contract, then read the linked source.

## Authority order

When two documents disagree, use this order:

1. Executable contracts, validators, and tests.
2. Current source modules named in this reference.
3. This source-checked project reference.
4. Feature guides under `docs/`.
5. Historical audits, benchmark captures, and the original Solver V2 proposal.

`docs/AUG11AUDIT.MD` is a dated resolution ledger, not a statement that no new
defects can exist. `docs/solver-v2-spec.md` is design history. Current solver
behavior belongs in `docs/solver-v2-progress.md` and
`docs/solver-v2-benchmarks.md`.

## Runtime ownership

| Concern | Authoritative owner | Important entry points |
|---|---|---|
| App composition | `src/main.tsx`, `src/App.tsx`, `src/AppShell.tsx` | provider order, global recovery, lazy routes |
| Hash routing | `src/router/` | `parseHash`, `navigate`, `Link`, canonical hash builders |
| Puzzle rules | `src/core/` | `parsePuzzleRows`, `createSession`, `stepSnapshot`, `move`, `undo`, `reset`, `replayActionLog` |
| Catalog | `src/catalog/` | `PUZZLE_METADATA`, `loadPuzzle`, catalog validators and shards |
| Progress, routes, and sessions | `src/shared/progress-sync.ts`, `src/shared/personal-best-routes.ts`, `src/shared/session-persistence.ts` | synchronous summaries, replay-verified route history, fenced recovery |
| Storage boundary | `src/shared/storage.ts`, `src/shared/idb-storage.ts` | owned keys, classified failures, reset generations |
| Solver contract | `src/solver/contracts.ts`, `src/solver/validation.ts` | requests, progress, results, proof and limit invariants |
| Solver trust boundary | `src/solver/verification.ts` | canonical replay before display or persistence |
| Exact search | `src/solver/search/exact-move-astar.ts`, `src/solver/search/ida-star.ts` | move-optimal proof kernels |
| Solver portfolio | `src/solver/implementations/sokomind-solver.ts` | discovery, rewrite, proof coordination and run ledger |
| Generated engine | `src/solver/implementations/sokomind-engine/source/` | edit source, then regenerate `engine.generated.js` |
| Play UI | `src/features/play/`, `src/features/game/` | controller composition, input, timer, board, dialogs |
| Replay study UI | `src/features/replay/`, `src/features/stats/PersonalBestReplayShelf.tsx` | canonical display frames, route comparison, read-only ghost, completion and statistics entry points |
| Guided journey | `src/features/journey/`, `src/features/journey/GuidedJourneyCard.tsx` | advisory concept chapters, deterministic next-room explanation, pause/resume preference |
| Daily challenge | `src/features/progress/daily-challenge.ts`, `src/features/home/DailyChallengeCard.tsx` | local-date assignment framing, seven-day participation history, recovery states |
| Editor | `src/features/editor/` | reducer/history, draft persistence, validation, sharing |
| Experience | `src/features/experience/` | theme, motion, sound, music and Web Audio lifecycle |
| PWA | `public/sw.js`, `src/shared/sw-update-store.ts` | manifest-bound caches, update activation and offline shell |

## Important data shapes

| Type | Meaning | Invariant owner |
|---|---|---|
| `PuzzleDefinition` / `ParsedBoard` | authored input and validated immutable geometry | `src/core/model.ts`, `src/core/puzzle.ts` |
| `GameSnapshot` / `GameSession` | dynamic keeper/box state and persistent undo history | `src/core/model.ts`, `src/core/game-session.ts` |
| `ProgressData` | best records, daily participation, and bounded completion activity | `src/shared/progress.ts`, `src/shared/progress-sync.ts` |
| `PersonalBestRouteRepository` | bounded, fingerprinted, replay-verified personal-best action logs | `src/shared/personal-best-routes.ts` |
| `ReplayTrace` / `ReplayComparison` | canonical display frames plus textual and marked route divergences | `src/features/replay/replay-comparison.ts` |
| `SavedSession` | puzzle ID plus replayable action log; never trusted coordinates | `src/shared/session-persistence.ts` |
| `EditorDraftStore` | bounded named documents with one active draft and migration from the legacy payload | `src/features/editor/editor-draft.ts` |
| `SolverRequest` / `SolverResult` | validated worker-neutral request, terminal result, metrics, and proof | `src/solver/contracts.ts`, `src/solver/validation.ts` |
| `SolverProof` | bounded, optimal, or unsolvable certificate metadata | `src/solver/contracts.ts`, `src/solver/proof.ts` |
| `ExactSearchFeatures` | internal per-mechanism A/B controls; not an end-user preference | `src/solver/search/exact-search-features.ts` |

## Important functions and their contracts

| Symbol | Contract |
|---|---|
| `validatePuzzleRows` / `parsePuzzleRows` | return structured validation or a frozen parsed board; parsing throws on invalid input |
| `createSession` / `stepSnapshot` / `move` / `undo` / `reset` | own all legal game transitions without mutating earlier state |
| `replayActionLog` | replays canonical actions and identifies malformed or blocked input at the exact index |
| `parseHash` and hash builders | parse and produce the canonical application route vocabulary |
| `loadPuzzleById` | loads one validated catalog shard and may be retried after an offline or transport failure |
| `persistProgressUpdate` / `persistProgressImport` / `resetStoredProgress` | merge or reset progress under cross-tab/reset fencing and return the durable outcome |
| `verifyPersonalBestRoute` / `promoteVerifiedPersonalBestRoute` | replay a candidate from the canonical puzzle, verify exact counters, then atomically retain bounded best-route history |
| `buildReplayTrace` / `compareReplayTraces` | rebuild read-only frames through canonical moves and describe route differences without relying on color |
| `getJourneyChapterProgress` / `getJourneyRecommendation` | project solved puzzle IDs onto curated chapters and return the first explainable unsolved room without locking later content |
| `buildDailyChallengeView` | derive today's assignment, streak framing, and bounded history from the canonical daily ledger |
| `saveSession` / `hydrateSessionFromIDB` | mirror replayable sessions and reconcile the newest valid storage tier |
| `parseEditorDraftStore` / `serializeEditorDraftStore` | deeply validate, migrate, and serialize the named-draft document store |
| `assertValidSolverRequest` / `assertValidSolverResult` | reject malformed, non-finite, inconsistent, or out-of-contract protocol values |
| `verifySolverSolution` / `collectProofIssues` | independently replay a route and verify that proof metadata is compatible with it |
| `runExactMoveAStar` / `runIdaStarSearch` | return move-optimal proofs only while the open-subtree lower-bound invariant holds |
| `createSokomindSolverAdapter` / `createNodeSolverAdapter` | run the production discovery, rewrite, and proof portfolio in browser or Node isolation |
| `allocateParallelRewriteBudgets` / `remainingProofLimits` | derive disjoint integer phase/lane shares from one run-wide resource ledger |
| `resolveExactSearchFeatures` | construct frozen default or A/B exact-search feature vectors |

The tables name public or cross-boundary concepts, not every implementation
helper. Local variables should be explained next to the code when their
meaning is not obvious; duplicating them here would create a second, stale
implementation.

## Non-negotiable contracts

- The core is immutable and browser-independent. UI and solvers consume it;
  neither may maintain alternate puzzle rules.
- Total moves are the exact objective. Exact-state identity therefore includes
  the keeper cell, not only the reachable region.
- Every displayed or persisted solver route must pass canonical replay and
  counter validation.
- A proof may be called optimal only when every live/open subtree has a lower
  bound at least as large as the replay-valid incumbent.
- Elapsed, expanded, generated, and memory limits cover the complete run,
  including preprocessing, discovery, rewriting, proof, and worker overhead.
- Storage failures are user-visible outcomes. No dialog may claim a mutation
  was saved when its durable write failed.
- “Reset progress” and “reset all app data” are separate operations with
  different ownership and confirmation text.
- Exact-search optimization claims require an enabled/disabled control,
  independent optimum agreement, replay, exercised counters, deterministic
  work comparison, median timing, and memory review.
- Feature modules may depend on lower layers; core, shared, router, catalog,
  and solver boundaries are enforced by AST tests.

## Key change workflows

### Change game rules

Update the core transition/validation code first, add pure unit coverage, then
update UI feedback and solver verification consumers. Never patch equivalent
logic separately in a component or worker.

### Change exact search

Keep the feature independently disableable. Add tiny-board oracle differential
coverage, the smallest named regression fixture, replay/proof assertions, and
cutoff tests. Run both A* and IDA* where the mechanism is shared.

### Change the generated Sokomind engine

Edit `src/solver/implementations/sokomind-engine/source/`, run
`npm run prepare:sokomind-solver`, and review the generated diff. Direct edits
to `engine.generated.js` are invalid.

### Change persistence

Declare ownership in `src/shared/storage.ts`, preserve reset fencing and
cross-tab behavior, classify write failures, and test localStorage,
sessionStorage, and IndexedDB independently.

### Change routes or critical behavior

Update canonical builders/parsing, browser behavior tests, and
`tests/critical-route-behaviors.json`. The matrix accepts only executable test
declarations, not skipped/todo placeholders.

### Change documented constants

Run `npm run prepare:project-reference`. CI runs the corresponding check and
fails when the generated facts below differ from source.

## Validation ladder

1. `npm run typecheck`
2. `npm run lint`
3. `npm run lint:docs`
4. `npm run test:unit`
5. `npm run test:coverage`
6. `npm run build`
7. `npm run test:static`
8. Targeted and full browser matrices
9. `npm run test:solver:proof-regressions`
10. Solver multi-puzzle, Huge, extended optimum, and benchmark gates as
    appropriate for the changed surface

## Source-derived current facts

<!-- SOURCE_FACTS:START -->

> Generated from source by `scripts/generate-project-reference.mjs`. Do not edit this block manually.

### Runtime and catalog

- Package version: `0.1.0`
- License: `MIT`
- Supported Node.js: `^22.13.0 || >=24.0.0`
- Catalog schema: `1`
- Puzzles: **79** across **2** collections and **2** shards
- Difficulty counts: `tutorial` 21, `beginner` 14, `intermediate` 7, `advanced` 18, `expert` 12, `master` 7

### Routes

| Surface | Canonical hash |
|---|---|
| Home | `#/` |
| Difficulties | `#/puzzles` |
| Difficulty | `#/puzzles/:difficulty?page=N` |
| Collection | `#/puzzles/:difficulty/:collection?page=N` |
| Play | `#/play/:puzzleId?play=UDLR...` |
| Editor | `#/editor?custom=...` |
| Stats | `#/stats` |

### Persistent identifiers

| Owner | Key |
|---|---|
| progress | `sokomind.progress.v1` |
| experience | `sokomind.experience.v2` |
| session | `sokomind.session.v1` |
| optimal | `sokomind.optimal.v4` |
| personalBestRoutes | `sokomind.personal-best-routes.v1` |
| reset | `sokomind.reset.v1` |
| ratings | `sokomind.ratings.v1` |
| favorites | `sokomind.favorites.v1` |
| guidedJourney | `sokomind.guided-journey.v1` |
| cosmetics | `sokomind.cosmetics.v1` |
| editorDraft | `sokomind.editor-draft.v1` |
| editorDraftRecovery | `sokomind.editor-draft-recovery.v1` |
| session-only | `sokomind:timer` |
| session-only prefix | `sokomind:timer:*` |
| progress payload schema | `2` |
| saved-session payload schema | `1` |
| editor-draft payload schema | `2` |
| optimal-record payload schema | `5` |

### Bounded local data

- Saved action-log limit: **100,000** actions
- Progress import limit: **1,000,000 bytes** and **10,000 records**
- Completion activity retention: **366 days** and **10,000 entries**
- Named editor draft limit: **25 drafts**

### User-facing defaults

- Audio master: **on**
- Music: **on**
- Effects volume: **50%**
- Music volume: **50%**
- Theme: `undefined`; motion: `system`; preference schema: `2`

### Solver identities

| Solver ID | Version | Contract |
|---|---:|---|
| `classic-dfs` | `1.0.0` | first-found |
| `classic-greedy` | `1.0.0` | first-found |
| `classic-astar` | `2.1.0` | move-optimal proof |
| `classic-ida-star` | `2.1.0` | move-optimal proof |
| `sokomind-solver` | `1.1.0` | bounded discovery/rewrite/proof portfolio |

### Solver protocol and default portfolio

- Outer worker protocol: `1`
- IDA* checkpoint schema: `2`
- Sokomind mode: `fast`
- Proof algorithm: `auto`; proof parallelism: **1**
- Maximum harvested incumbents: **4**; harvest window: **5,000 ms**
- IDA* reachability snapshots: `periodic` every **4** levels

### Exact-search controls

- `incrementalAssignment`: enabled by default
- `linearConflict`: enabled by default
- `interactionBoost`: enabled by default
- `patternDatabase`: enabled by default
- `forcedPushMacros`: enabled by default
- `piCorralPruning`: enabled by default
- `patternDeadlockPruning`: enabled by default
- `deadlockTablePruning`: enabled by default
- `goalCommitmentPruning`: enabled by default
- `tunnelMacros`: enabled by default
- Maximum PDB table: **268,435,456 entries** (**512 MiB**)

### Frozen solver evidence

- Immutable benchmark fixtures: **43**
- Classic-eligible fixtures: **37**
- Frozen exact optima: **33**
- Grand Hall discovery (base, mirrored, rotated): **893 moves / 278 pushes**, **1,329 visited / 8,425 generated**
- Grand Hall quality rewrite: **789 moves / 270 pushes**, **29,000 visited**
- Current performance artifact schema: **3**; schema-2 `baseline-v0.json` is historical only.

### Delivery ceilings

- All scripts and styles: **410,000 gzip bytes**
- Largest asset: **80,000 gzip bytes**
- Solver worker: **60,000 gzip bytes**
- Nested engine worker: **65,000 gzip bytes**

<!-- SOURCE_FACTS:END -->

## Historical evidence

Benchmark JSON and dated audits explain what was measured or fixed at a point
in time. They must never override current contracts. Preserve immutable
baselines, record the commit and dirty state, and create a new artifact for a
new implementation or machine profile.
