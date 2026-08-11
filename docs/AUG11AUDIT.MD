# Sokomind Consolidated Project Audit — August 11, 2026

**Status:** Authoritative open-issue audit  
**Repository snapshot:** `main` at `2a8d819`  
**Audit date:** 2026-08-11  
**Scope:** Application architecture, game core, catalog, persistence, editor,
solver and proof systems, workers, PWA behavior, accessibility, tests, CI,
documentation, security, and dependency health.

This document replaces the repository's older audit reports and issue trackers.
It intentionally contains only findings that are open on the audited snapshot,
plus the evidence and acceptance criteria needed to close them. Resolved or
obsolete findings have not been carried forward as active work.

Future-facing product and engineering opportunities live in
[`AUG11IMPROVEMENTS.MD`](AUG11IMPROVEMENTS.MD). Solver specifications, sprint
history, benchmarks, and project memory remain separate durable references.

## Executive verdict

Sokomind has a strong overall architecture: immutable game rules, bounded and
validated catalog loading, worker-isolated search, independent replay checking,
a robust static/PWA deployment model, and an unusually broad automated test
suite. No backend, account system, analytics, or external telemetry is present.
The dependency audit found no known vulnerabilities.

The current release must not advertise every IDA* result as proven
move-optimal. A reproducible transposition-table error allows Classic IDA* and
the IDA* proof path selected by Sokomind to return a legal but suboptimal route
with a false `lowerBound === upperBound` certificate. Independent replay proves
route legality, but it cannot prove minimum cost, so the existing outer worker
validation does not catch this defect.

There are also high-priority checkpoint, proof-protocol, resource-accounting,
daily-challenge, and editor-draft problems. These should be addressed before
new solver optimizations or large product features.

## Priority definitions

| Priority | Meaning |
|---|---|
| **P0** | Release-blocking correctness or integrity failure. |
| **P1** | High-impact correctness, data-loss, or resource-contract failure. |
| **P2** | Material reliability, recovery, accessibility, or UX defect. |
| **P3** | Maintainability, test-gate, documentation, or lower-impact defect. |

## Current project map

```text
index.html
  -> src/main.tsx
     -> catalog shard URL configuration
     -> cross-tab reset coordination
     -> service-worker registration and updates
     -> ErrorBoundary -> ExperienceProvider -> App
        -> RouterProvider -> AppShell
           -> Home / Selector / Play / Editor / Stats

Home + Selector
  -> compact generated metadata only

Play
  -> one validated 50-board shard
  -> immutable GameSession and canonical U/D/L/R action log
  -> autosave, progress, sharing, solver playback

Persistence
  -> localStorage for preferences, progress, favorites, ratings, and drafts
  -> generation-fenced IndexedDB mirrors for sessions and optimal records

Solver UI
  -> SolverWorkerClient
  -> outer solver.worker.ts / SolverWorkerHost / SolverRegistry
  -> Classic DFS, Greedy, exact A*, exact IDA*
  -> Sokomind adapter
       -> nested engine workers
       -> sequential or partitioned proof workers
  -> result validation
  -> independent replay through the core game engine
```

## Current inventory

| Area | Current state |
|---|---|
| Runtime | React 19.2, TypeScript 5.9, Vite 8.1, static GitHub Pages PWA |
| Source | 190 TypeScript/TSX files |
| Solver | 81 files, approximately 35,700 lines including generated engine code |
| Feature/UI | 75 files, approximately 11,100 lines |
| Catalog | 2,095 puzzles in 42 lazy board shards |
| Difficulty distribution | 10 tutorial, 451 beginner, 434 intermediate, 400 advanced, 400 expert, 400 master |
| Content origin | 37 originals and 2,058 generated puzzles |
| Typed-box coverage | 2,078 puzzles contain at least one labeled box |
| Runtime services | No backend, telemetry, advertising, or third-party analytics |

## Open issue index

| ID | Priority | Area | Finding |
|---|---|---|---|
| AUD-001 | P0 | Solver | IDA* can certify a suboptimal route as move-optimal |
| AUD-002 | P1 | Solver/checkpoints | Checkpoint compatibility ignores the actual start state |
| AUD-003 | P1 | Solver/resources | Proof phases reset run-wide budgets and under-report work |
| AUD-004 | P1 | Solver/protocol | Nested proof validation accepts unsafe bounds and solutions |
| AUD-005 | P1 | Progress | Daily completion and streaks ignore the completion date |
| AUD-006 | P1 | Editor | Shared editor links overwrite the sole saved draft |
| AUD-007 | P2 | Solver/workers | Concurrent proof lacks a deadline and complete cleanup |
| AUD-008 | P2 | Solver/browser | Browser checkpoint code depends on `node:crypto` |
| AUD-009 | P2 | Persistence | IndexedDB-only sessions cannot be discovered from Home |
| AUD-010 | P2 | Persistence | Favorites, ratings, and drafts silently ignore write failure |
| AUD-011 | P2 | Achievements | Unlock notifications compare the same stale progress state |
| AUD-012 | P2 | Editor/accessibility | Global undo and redo override native text editing |
| AUD-013 | P2 | Import/export | Stats import is unbounded and misreports merged records |
| AUD-014 | P2 | Editor/recovery | Draft deserialization is too shallow to be safe |
| AUD-015 | P3 | Solver/errors | Monotonicity errors reverse error code and message |
| AUD-016 | P3 | Tests | High coverage percentages do not protect page behavior |
| AUD-017 | P3 | Architecture | Boundary enforcement is narrower than documented layering |
| AUD-018 | P3 | Architecture | Solver UI hooks retain avoidable type-only cycles |
| AUD-019 | P3 | Documentation | Documentation validation misses links and architectural drift |

## Detailed findings and fixes

### AUD-001 — P0 — IDA* can certify a suboptimal route as move-optimal

**Evidence**

The following board was checked with the exact test oracle, exact move A*, and
IDA* with both contour-scoped and persistent transposition modes:

```text
OOOOOO
O    O
O   XO
O X  O
O RSSO
OOOOOO
```

| Search | Moves | Pushes | Replay | Reported proof |
|---|---:|---:|---|---|
| Exact oracle | 11 | 4 | N/A | Exact optimum |
| Exact move A* | 11 | 4 | Valid | `LB=UB=11`, proven |
| IDA*, contour-scoped TT | 13 | 6 | Valid | `LB=UB=13`, proven |
| IDA*, persistent TT | 13 | 6 | Valid | Proven |

The failure is in `src/solver/search/ida-star.ts`. Around line 1013, an exact
state hit reuses an absolute root-relative backed `f` value. The same state can
be reached with a different path cost `g`, making that stored value unsafe for
the new path. Lines around 1421 back the value into the table, and lines around
1440 use the resulting threshold jump to declare the incumbent optimal.
Clearing the table between contours does not prevent unsafe reuse within a
single contour.

This affects the public Classic IDA* adapter and the automatic Sokomind proof
selection used for low-memory and larger-board runs. A false proven result can
also be written to the persistent optimal cache.

**Required fix**

1. Immediately disable backed-`f` transposition pruning in proof-producing
   IDA*, or temporarily mark IDA* output as bounded/unproven.
2. Replace it with collision-checked exact-state best-`g` dominance: prune only
   when the same exact state was previously reached at a cost less than or equal
   to the current `g`.
3. Do not introduce relative backed bounds without a separate soundness proof;
   path exclusions can still make them unsafe.
4. Bump or invalidate the persisted optimal-cache schema after the fix.

**Acceptance criteria**

- The board above returns 11 moves and 4 pushes under A* and every IDA* mode.
- A deterministic generated tiny-board sweep matches an independent exact
  oracle for solution cost and unsolvability.
- Every result marked `optimality: "proven"` has a finite proof with
  `lowerBound === upperBound === solution.moves`.
- Old optimal-cache records cannot survive the corrected proof generation.

### AUD-002 — P1 — Checkpoint compatibility ignores the actual start state

`createBoardContentKey()` in `src/solver/search/ida-star-checkpoint.ts` hashes
dimensions, walls, goals, and floor topology but omits the request snapshot's
robot and label-aware box positions. Different states on the same geometry can
therefore share a checkpoint identity.

A direct reproduction loaded a one-move checkpoint from one state into a
different two-move state with identical geometry. Compatibility returned true,
and IDA* returned the checkpoint route as a one-move proven solution even
though replay on the requested state ended unsolved. The Node CLI accepts this
checkpoint path.

**Fix:** version the checkpoint schema; fingerprint the exact request snapshot,
including robot and label-aware boxes; replay and validate every restored
incumbent; require `incumbent.cost === solution.moves`; reject incompatible or
malformed records before they affect thresholds.

**Acceptance:** same-geometry/different-state checkpoints are rejected, altered
incumbents are rejected, and valid same-state resume remains deterministic.

### AUD-003 — P1 — Proof phases reset budgets and under-report work

The Sokomind discovery phase derives remaining limits, but optimal proof is
invoked with the original request. Sequential proof can receive the full time
limit again, while expanded/generated/memory allowances are not reduced.
Concurrent partitions each receive full request limits, multiplying the
effective allowance by worker count. Successful results then replace or omit
discovery/proof telemetry rather than reporting the entire run.

Relevant code is in `src/solver/implementations/sokomind-solver.ts` around line
1958 and `src/solver/implementations/sokomind-proof.ts` around lines 50, 291,
320, and 109.

**Fix:** use one coordinator-owned `BudgetTracker`; pass a remaining-budget view
to every phase; partition state and memory allowances across concurrent
workers; enforce one wall-clock deadline; merge discovery and proof counters,
current memory, peak memory, and elapsed time.

**Acceptance:** end-to-end tests must consume most of each limit during
discovery, enter proof, and show that total work never exceeds the original
contract except for a documented bounded polling interval.

### AUD-004 — P1 — Nested proof validation accepts unsafe messages

`isProofResult()` in
`src/solver/implementations/sokomind-proof-protocol.ts` checks bounds with
`typeof value === "number"`. That accepts `Infinity`, `NaN`, and negative
values. The coordinator treats `lowerBound >= bestCost` as proof completion, so
`Infinity` can create a false finite optimal certificate. A `proof/solution`
payload is also accepted as a shallow record and later cast to
`SolverSolution` without full structural or replay validation.

The older bounded-versus-exhausted protocol bug has dedicated regression tests,
but the boundary remains too permissive for malformed, stale, or mismatched
worker messages.

**Fix:** require finite non-negative safe costs; fully validate solution and
metric structures; verify candidate replay before adoption; require
`totalCost === solution.moves`; bind every message to the worker's currently
assigned partition and execution identity; reject duplicate or stale terminal
messages.

**Acceptance:** non-finite, negative, shallow, stale, wrong-partition, and
cost-mismatched messages terminate that partition as failed and can never
produce an optimal public result.

### AUD-005 — P1 — Daily streaks ignore completion dates

`computeDailyStreak()` in `src/features/progress/compute-stats.ts` checks only
whether the puzzle assigned to a date has ever been completed. Home similarly
marks today's challenge cleared if that puzzle was completed on another date.
The progress schema stores a single best completion per puzzle, so it cannot
represent repeated daily participation.

A reproduction assigned the latest three daily puzzle IDs records with
`completedAt` in the year 2000; the current streak was still reported as three.

**Fix:** add a versioned date-indexed daily participation record keyed by local
calendar date and the assigned puzzle ID. Record participation only when that
day's route is solved on that day. Define timezone rollover and clock-change
semantics explicitly.

**Acceptance:** historical solves do not clear today's challenge; repeated
assignment can be completed on multiple dates; timezone-boundary tests cover
forward and backward local-date transitions.

### AUD-006 — P1 — Shared editor links overwrite the saved draft

The editor first loads `sokomind.editor-draft.v1`. A valid custom-share route
then dispatches the shared puzzle into the same state. The generic one-second
autosave in `src/features/editor/use-editor-state.ts` writes that imported
puzzle over the sole local draft. The shared load path in
`src/features/editor-page/EditorPage.tsx` does not mark the document dirty, so
leaving produces no warning.

**Fix:** treat a shared puzzle as a read-only preview until the user explicitly
chooses **Import into editor**; preserve the prior draft in a separate slot or
version history; display the target draft name before replacement.

**Acceptance:** opening and closing a shared URL leaves the saved draft byte-for-
byte unchanged, and explicit import is covered by browser tests for replace,
cancel, and recovery behavior.

### AUD-007 — P2 — Concurrent proof lacks a deadline and complete cleanup

The coordinator promise in `sokomind-proof.ts` has no remaining-time timer or
silence watchdog. Invalid messages are ignored while their partition remains
pending. `messageerror` is represented by the worker abstraction but not
registered in the coordinator. Workers are constructed before lifecycle
cleanup ownership is established, so a later factory failure can leak an
already-created worker.

A mock worker that emitted one malformed message remained pending past a
one-millisecond elapsed limit until externally aborted.

**Fix:** establish lifecycle ownership with `try/finally`; register `error` and
`messageerror`; convert malformed messages to partition failures; apply one
remaining deadline plus a bounded silence watchdog; remove all listeners,
timers, and abort handlers on every exit.

### AUD-008 — P2 — Browser checkpoint code imports `node:crypto`

`src/solver/search/ida-star-checkpoint.ts` imports `createHash` from
`node:crypto`. Vite externalizes that module in the browser worker bundle. The
default UI does not currently supply checkpoint callbacks, so the failure is
dormant, but enabling that supported path would call a missing browser shim.

**Fix:** use a browser-neutral deterministic digest implementation, or split
Node checkpoint serialization from the browser search graph. Add a static
bundle test that rejects Node built-ins in every browser worker dependency
closure.

### AUD-009 — P2 — IndexedDB-only sessions are not discoverable

`saveSession()` can successfully mirror a session to IndexedDB when
localStorage fails. Home's Continue action reads only the localStorage puzzle
pointer. IndexedDB hydration begins only after Play has already selected a
puzzle and its resolver accepts only that puzzle, so a valid IDB-only session
for another puzzle is unreachable through normal navigation.

**Fix:** maintain a generation-fenced IndexedDB resume index or perform a
bounded startup lookup before resolving Continue. Reconcile localStorage and
IndexedDB by generation, timestamp, schema, and puzzle availability.

### AUD-010 — P2 — Some persistence failures are silently accepted

The shared storage adapter returns success/failure, but favorites and ratings
ignore it. Editor draft autosave bypasses the adapter and swallows exceptions.
The UI still updates optimistically, while the global persistence warning only
observes failures explicitly reported to it.

**Fix:** route every owned key through one reporting adapter; retain optimistic
UI only with a visible unsaved state and retry; expose scoped recovery actions;
update the persistence inventory and tests for every owned key.

### AUD-011 — P2 — Achievement unlock notifications use stale progress

The solve callback in `src/features/play/use-play-controller.ts` computes
pre-solve statistics, schedules `recordSolvedSession()`, then computes
post-solve statistics from the same closed-over `progress` object. The two
achievement sets are identical during the callback, so the triggering toast is
empty even though the achievement appears later on Stats.

**Fix:** make the progress update return the new immutable snapshot or compute
it before scheduling state; derive the achievement delta from explicit old and
new values; deduplicate toasts by achievement ID.

### AUD-012 — P2 — Editor undo and redo override native text editing

The window-level Cmd/Ctrl+Z/Y handler in
`src/features/editor-page/EditorPage.tsx` always prevents the browser default,
including inside title, hint, and import textareas. The game keyboard handler
already demonstrates the correct editable-target exclusion.

**Fix:** ignore shortcuts from inputs, textareas, selects, and contenteditable
targets unless a dedicated editor command mode owns focus. Add browser tests
for text undo, grid undo, focus changes, and macOS/Windows modifier variants.

### AUD-013 — P2 — Stats import is unbounded and misreports changes

Stats reads and parses an arbitrary-size selected file, while the existing
Progress dialog enforces a one-megabyte limit. Its merge summary counts every
known record that was not new as “updated” whenever any record changes,
including unchanged or worse imported records.

**Fix:** share one bounded import parser; validate MIME/extension only as hints,
enforce byte and record limits, parse before committing, and have the merge
operation return explicit `added`, `improved`, `unchanged`, `rejected`, and
`invalid` counts.

### AUD-014 — P2 — Editor draft deserialization is shallow

Draft loading accepts unchecked dimensions and difficulty values and casts
nested cells without validating their shape or symbols. A malformed value such
as `cells: ["x"]` can reach rendering code that assumes `row.map`, causing the
global error boundary to offer a full application-data reset.

**Fix:** reuse the editor share/schema validator for stored drafts; validate
integer dimensions, row count and width, symbols, metadata, and maximum size;
quarantine only the invalid draft; provide a download/delete recovery choice
without clearing unrelated progress.

### AUD-015 — P3 — Monotonicity errors reverse code and message

`SolverWorkerRuntimeError` takes `(code, message)`, but the three monotonicity
checks in `src/solver/worker-host.ts` pass the prose message first and
`ERR_SOLVER_MONOTONICITY` second. Remote clients receive a sentence as the code
and the symbolic code as the displayed message.

**Fix:** correct argument order and add assertions for the serialized remote
error code and user-facing message.

### AUD-016 — P3 — Coverage gates do not protect page behavior

The all-files c8 gate permits 58% line/statement coverage. The 92% focused Node
gate reports only imported files, so unimported TSX pages and hooks do not lower
its percentage. Browser tests are extensive but do not contribute line
coverage. The daily, achievement, editor, and Stats defects align with these
untested route-level paths.

**Fix:** define route/feature coverage floors, import every critical page into a
component-test harness, and track browser coverage or explicit behavior
matrices. Add regression tests for every P1/P2 UI finding before closure.

### AUD-017 — P3 — Boundary enforcement is narrower than the architecture

The documented layering is mostly respected in the current tree, but
`tests/unit/module-boundaries.test.ts` checks only three solver/search rules and
recognizes primarily `from "..."` imports. Side-effect and dynamic imports can
evade it. Core, catalog, router, feature, and general solver boundaries are not
encoded as enforceable policy.

The `SolverAdapter` comment also says adapters must not use worker globals,
while the production Sokomind adapter intentionally constructs nested workers.

**Fix:** use an AST-aware dependency rule; encode allowed layer edges; cover
static, dynamic, and side-effect imports; either formalize worker creation as an
adapter capability or narrow the contract to algorithm kernels.

### AUD-018 — P3 — Solver UI hooks retain type-only cycles

`useSolverController` imports worker, progress, and log hooks, while those hooks
import `SolverLogEntry`, `SolverUiPhase`, or `SolverRunFingerprint` back from
the controller. Type erasure prevents a runtime cycle today, but the extraction
remains coupled to its orchestrator.

**Fix:** move shared solver UI types to a neutral `solver-ui-types.ts` module and
add a dependency-cycle check for feature modules.

### AUD-019 — P3 — Documentation validation misses real drift

The current docs checker scans a narrow class of backticked paths in direct
children of `docs/`. It does not validate normal Markdown links, the root
README, nested docs, headings/anchors, or uppercase `.MD` files. It previously
passed despite broken audit links, an incorrect puzzle count, nonexistent
routes, and obsolete component names.

`docs/architecture.md`, `docs/persistence-and-sharing.md`, and portions of the
solver documentation still need reconciliation with the current router,
provider ownership, persistence keys, nested-worker design, and proof risks.

**Fix:** make documentation validation recursive and case-insensitive; parse
Markdown links and anchors; include root Markdown files; generate catalog facts
where practical; add a small source-backed architecture invariant table.

## Validation evidence

The following checks were run against the audited snapshot:

| Check | Result |
|---|---|
| Dependency install/audit | 192 packages installed; 193 audited; 0 vulnerabilities |
| TypeScript | Passed |
| ESLint | Passed |
| Generated solver freshness | Passed |
| Generated catalog freshness | Passed |
| Unit tests | 1,324 passed |
| Static production-build tests | 9 passed |
| All-source typed coverage | 64.17% lines/statements, 84.48% branches, 87.41% functions |
| Focused typed coverage rerun | 93.02% lines, 87.39% branches, 93.84% functions |
| Solver multi-fixture performance | Passed all four fixtures |
| Huge solver performance | Passed base, mirrored, rotated, and rewrite cases in about 47.3 seconds total |
| Chromium desktop | 52 browser tests passed |
| WebKit/mobile Safari | 51 passed, 5 expected skips |
| Mobile Chrome/service worker | 9 passed |

One initial focused-coverage wrapper run suffered a transient Windows native
process exit `0xC0000005` in the Node-runner timeout test. That test passed in
isolation and the full focused suite passed immediately on rerun. Firefox could
not launch in the audit environment because its software compositor failed
before page execution; no application assertion ran, so this is an environment
limitation rather than a recorded product failure.

## Security, privacy, PWA, and accessibility assessment

No critical security or privacy defect was found. Positive controls include:

- no runtime backend, analytics, advertising, or third-party telemetry;
- a production CSP restricted to same-origin application resources with
  objects disabled;
- production source maps disabled;
- bounded and deeply validated custom-share payloads;
- revisioned service-worker manifests with SHA-256 shell validation;
- scope-safe cache cleanup and preservation of the last good shell;
- SHA-pinned GitHub Actions with narrow permissions;
- route focus management, live announcements, skip navigation, reduced-motion
  support, native dialog primitives, and representative axe coverage.

The editor shortcut problem in AUD-012 is the principal accessibility defect
found during this pass.

## Remediation order

### Release gate

1. Fix AUD-001 and invalidate all old optimal-cache entries.
2. Fix AUD-002 and version checkpoint compatibility.
3. Fix AUD-003 and AUD-004 so proof has one trusted budget and protocol.
4. Add oracle, malformed-message, checkpoint, and end-to-end budget tests.

### Data and product correctness

5. Fix AUD-005 and migrate daily participation data.
6. Fix AUD-006 before promoting editor share links.
7. Fix AUD-009, AUD-010, and AUD-014 as one persistence/recovery program.

### Reliability and UX

8. Add proof-worker deadlines and cleanup for AUD-007.
9. Resolve AUD-008 and the smaller UX defects AUD-011 through AUD-013.
10. Correct AUD-015.

### Engineering controls

11. Expand coverage and boundary enforcement for AUD-016 through AUD-018.
12. Repair documentation and its validator under AUD-019.

## Outdated findings deliberately retired

The consolidation removed closed or obsolete claims rather than preserving
them as confusing “open” history. In particular:

- the old catalog difficulty skew is gone; the current tiers are broadly
  balanced;
- the old 10x10/four-box Boxoban dominance is gone; current generated content
  spans many sizes and box counts;
- the old lack of labeled-box content is reversed; 2,078 puzzles now exercise
  typed boxes;
- the event-loop scheduling dependency cycle was removed by the neutral
  `search/scheduling.ts` module;
- asynchronous PDB and deadlock-table builders and their direct cancellation
  tests now exist;
- GitHub Actions are pinned, dependency audit is enforced, generated artifacts
  have freshness checks, and Huge performance is a blocking gate;
- resolved Solver V2 spec scaffolding, naming, metrics, oracle, and benchmark
  items remain documented in the spec/progress history rather than as open
  defects;
- the prior assertion that contour-scoped IDA* transposition alone made proof
  safe is superseded by AUD-001's within-contour counterexample.

## Consolidation record

This file replaces and removes the following superseded documents:

- REMAINING-AUDIT-ITEMS.md
- docs/COMPLETE-PROJECT-ANALYSIS.md
- docs/SokomindSolver_Audit_Issues.md
- docs/sokomind-follow-up-audit.md
- docs/solver-v2-audit-report.md

The following remain intentionally separate because they are specifications,
implementation history, benchmarks, operational guidance, or durable project
context rather than active audit trackers:

- `docs/solver-v2-spec.md`
- `docs/solver-v2-progress.md`
- `docs/solver-v2-benchmarks.md`
- `docs/solver-integration.md`
- `docs/sokomind-project-memory.md`
- the focused architecture, testing, deployment, persistence, experience, and
  puzzle-format guides.
