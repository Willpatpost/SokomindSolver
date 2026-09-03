# Solver V2 — Current Implementation Status

Last reconciled: August 23, 2026

Offline generator follow-up (September 3, 2026): candidate evidence and search
budgets are documented in [All-tier generator progress](generator-all-tier-progress.md).
No exact solver or optimality rules are changed by that work.

This document describes the code that exists now. It replaces the former
sprint-by-sprint diary, which mixed historical intentions, intermediate test
counts, and claims that were no longer true. The original design goals remain
in `docs/solver-v2-spec.md`; benchmark methodology lives in
`docs/solver-v2-benchmarks.md`.

## Verdict

Solver V2 is usable, replay-gated, and proof-capable, but not every proposed
optimization has demonstrated a benefit. Correctness takes precedence over
search speed:

- Exact A* and IDA* minimize moves and independently replay every accepted
  route.
- IDA* uses contour-local, collision-checked best-`g` dominance. It does not
  reuse path-dependent backed `f` values as transposition bounds.
- The unsafe goal-depth macro prune is disabled in both exact kernels.
- Optimal-cache schema 5 invalidates proof records produced by any earlier
  schema, including records affected by that prune.
- Every optional exact-search optimization now has an internal feature toggle
  and an exercise counter. Efficiency claims require controlled on/off data.
- Five disconnected proof scaffolds were removed rather than presented as
  implemented proof improvements.

## Production solver paths

The shipped solver surface has three layers:

1. Classic exact A* and IDA* kernels for move-optimal proofs.
2. Sokomind discovery for immediate fast-mode incumbents, with harvesting and
   bounded rewrite reserved for quality-mode incumbents.
3. Sokomind optimal mode, which hands verified incumbents to the exact proof
   kernels under one run-wide resource budget.

All worker results cross structural validation and core replay before they can
be returned. Discovery quality never substitutes for proof.

## Correctness corrections in the August 11 review

### IDA* transposition safety

The earlier implementation could attach an absolute backed `f` value to a
state reached through one path and reuse it after reaching the same state with
a different `g`. That could produce a false optimality certificate.

The current table stores only the exact state identity and the lowest `g` seen
inside the current contour. It is cleared between contours. The original
two-box counterexample now returns the exact 11-move / 4-push optimum in A* and
IDA*, and the generated tiny-board differential suite checks both engines
against an independent step-level oracle.

### Goal-depth macro pruning

The proposed prune treated certain goal placements as irreversible without a
complete proof. `inter-rooms` exposed the problem: the prune could remove the
optimal route. Both exact kernels now use ordinary safe successor generation;
the old goal-macro analysis remains unreferenced so it cannot influence proof.

The frozen `inter-rooms` regression asserts:

- 28 optimal moves
- 7 pushes on the selected optimal route
- replay validity
- `lowerBound === upperBound === 28`
- proven optimality under both exact engines

### Proof cache invalidation

Classic exact solver versions are 2.1.0 and the persisted optimal-record schema
is 5. Schemas 1 through 4 are rejected. Explicit user audio or gameplay
preferences are unrelated and are not migrated by this change.

## Frozen optimum gate

The corpus contains 43 immutable fixtures, of which 37 meet the classic
eligibility threshold. Twenty-five currently have frozen exact move optima in
`tests/fixtures/solver-v2/known-optima.ts`.

All 25 known records were checked against production exact A* after disabling
goal-macro pruning. Twenty-four completed under the ordinary 60-second gate.
`expert-tetris` required an extended diagnostic run and completed at 38 moves /
19 pushes after roughly 150 seconds. This is a correctness pass and a
performance warning, not an efficiency success.

The manifest is executable rather than documentary:

- `npm run test:solver:known` runs the 24 ordinary fixtures;
- `npm run test:solver:known:extended` runs `expert-tetris`; and
- `npm run test:solver:parallel` proves inter-rooms through the production
  two-worker Node adapter.

Standard and parallel gates run in pull-request/default-branch CI. The extended
fixture runs in a scheduled/manual workflow because its single proof currently
takes about 2.5 minutes on the audit workstation.

No unknown optimum is invented from an old performance artifact. A newly
proved, replay-valid result can be captured, reviewed, and then added to the
frozen correctness map separately.

## Parallel incumbent rewrite

Quality and optimal modes may rewrite up to three diverse incumbents in
parallel. Before workers start, the coordinator now takes one remaining-budget
snapshot and reserves disjoint integer shares for each lane:

- expanded states
- generated states
- elapsed rewrite time

Remainders are assigned deterministically. A total budget smaller than the
lane count produces zero-budget lanes rather than manufacturing one state per
lane. The rewrite engine enforces and reports generated states across
permutation, push-window, and move-window searches. Summed reservations cannot
exceed the run-wide remainder.

## August 14 proof-safety follow-up

### Active A* cutoffs

A* dequeues the minimum-`f` node before expanding it. Resource termination
during that expansion now retains the active node's bound; the remaining heap
alone cannot overstate proof progress. A cutoff returns a bounded incumbent
unless every unresolved subtree is already at or above its cost.

### Numeric caps are not incumbents

`ExactIncumbent` carries a complete replay-validated route and its cost.
`upperBound` is an exclusive numeric ceiling only. Parallel workers use the
latter until they construct a real route, so a shared bound can prune or prove
partition exhaustion but can never manufacture a public solution.

### Integer and deadline-safe phase handoff

Discovery metrics may contain fractional milliseconds, while solver protocol
limits require positive safe integers. Sequential proof floors and clamps every
derived elapsed/state remainder, returns immediately for a zero share, and
subtracts proof-planning time again before launch.

### Budgeted preprocessing

Pattern-database, deadlock-table, and related exact preprocessing now share the
run's cancellation, elapsed, and estimated-memory budget. Limit exits include
retained preprocessing bytes and feature counters instead of appearing as
zero-cost failures before search.

### Parallel metric semantics

Expanded/generated work and event counters are additive. A retained structure
or peak takes the maximum across sequential partitions on the same worker and
then conservatively sums worker maxima across possible concurrency. Coordinator
elapsed time remains wall time. This avoids summing sequential peaks while
remaining an upper bound rather than claiming timeline-sampled process RSS.

## Removed proof scaffolds

The following prototypes were disconnected from exact search and did not meet
the proof-and-benefit bar, so their source, registry, and shallow tests were
removed:

- local-room lower bound
- local-room deadlock detector
- local-corral lower bound
- local-corral deadlock detector
- doorway-crossing lower bound

The local-room and local-corral bounds lacked a complete proof for global box
exchange. The local-corral deadlock test was dominated by active PI-corral
pruning. The doorway bound was admissible but dominated by typed assignment and
could not raise the combined lower bound. Active assignment, room-pattern,
pair-conflict, interaction, PI-corral, pattern-deadlock, deadlock-table,
commitment, PDB, and forced-push mechanisms remain.

Future component heuristics must demonstrate both oracle safety and unique
utility. Non-negativity alone is not an admissibility test.

## Exact-search feature controls

`src/solver/search/exact-search-features.ts` resolves a frozen default vector:

| Feature | Default | Disabled behavior |
|---|---:|---|
| Incremental assignment repair | On | Full typed assignment evaluation |
| Linear conflict | On | Zero conflict addition |
| Interaction boost | On | No evaluator construction or evaluation |
| Pattern database | On | No PDB construction or lookup |
| Forced-push macros | On | Ordinary successor generation |
| PI-corral pruning | On | No detector construction or checks |
| Pattern-deadlock pruning | On | No cache construction or checks |
| Deadlock-table pruning | On | No table build or checks |
| Goal-commitment pruning | On | No commitment detector or skipped pushes |

The vector is internal to exact-kernel options. It is not a puzzle URL or
end-user setting. Non-default IDA* vectors cannot be combined with checkpoints,
because a saved exhausted contour is meaningful only under the feature vector
that produced it.

Telemetry reports one enabled-feature bitmask plus feature-specific
construction, evaluation, application, and prune counters. The `inter-rooms`
regression runs both exact engines with all features off and with each feature
individually off; every variant still proves 28 moves.

## What is and is not an improvement

An optimization is accepted as correct when on and off variants both replay
and prove the expected optimum. It is accepted as beneficial only when:

1. its control-side counter proves the feature executed;
2. the disabled side reports zero for that mechanism;
3. deterministic expanded/generated states or measured memory improve; and
4. median timing across isolated runs does not reveal a material regression.

The first live controlled smoke comparison, PDB on versus off for
`inter-rooms`, produced identical work on both sides: A* expanded 312 and
generated 1,433 states, while IDA* expanded 2,705 and generated 12,640. Both
are therefore no-effect results for that fixture, not evidence of a speedup.
One-run elapsed differences are recorded but are not a cross-machine gate.

## Benchmark implementation

The schema-3 V2 harness now:

- invokes `createNodeSolverAdapter()` for Sokomind production profiles;
- passes exactly the limits it records on each request;
- offers explicit fast, quality, optimal-A*, optimal-IDA*, classic-A*, and
  classic-IDA* profiles;
- uses isolated child processes for cold samples;
- treats `--warmup` as an untimed cold preflight, not as JIT warming;
- stores every raw sample plus min/median/max/MAD summaries;
- rejects child exit failures, malformed JSON, and identity mismatches;
- records before/after RSS and operating-system peak RSS;
- records commit, dirty state, corpus and tuning fingerprints;
- rejects deterministic status, proof, optimum, or state-count drift;
- distinguishes partial captures from promotable full baselines; and
- refuses to overwrite an artifact unless `--force` is explicit.

`tests/fixtures/solver-v2/baseline-v0.json` is retained as historical schema-2
evidence. It is incomplete for the current 43-fixture corpus and must not be
used as the current performance truth.

A schema-3 capture is promotable only when it covers every eligible pair,
every deterministic group is accepted, it has at least five timed samples, the
Git commit is a known full hash, and the worktree is clean. A/B classifications
also qualify median elapsed time and peak RSS; a reviewed regression in either
resource vetoes an apparent node-count win or makes conflicting evidence mixed.

## Sprint 3: Mixed-label deadlock tables (August 23, 2026)

### Mixed-label deadlock tables

The deadlock-table build phase previously tested only uniform-label box
configurations (e.g. [A,A], [B,B]) when enumerating region patterns. The lookup
side already handled mixed labels correctly. The build now enumerates the full
Cartesian product of labels (e.g. [A,B], [B,A]) via `forEachLabelAssignment`,
bounded by the existing 2-second time budget. Both sync and async builders were
updated. An exhaustive false-positive oracle test on a typed board confirms
soundness.

### Attempted and reverted

**Deeper pi-corral boundary analysis** — consulting deadlock tables after
simulating a boundary push produced a false positive on the "tiny" typed puzzle.
Root cause: pi-corral evaluates each corral independently. When post-push
deadlock patterns involve boxes in *other* single-cell corrals (which can be
moved first), the "all pushes deadlocked" conclusion is unsound.

**Pattern-deadlock eligibility relaxation** — removing the >2-floor-neighbor
gate caused the windowed BFS (which strips the robot and drops boxes leaving
the window) to produce false positives on wider geometries. The no-robot
abstraction is only sound in corridors where the robot position is uniquely
determined by box positions.

## Remaining performance work

Correctness changes can expose performance costs. Current priorities are:

- recover `expert-tetris` proof time without reinstating unsafe pruning;
- run median-of-five A/B captures for every feature on fixtures where its
  exercise counter is nonzero;
- identify PDB and deadlock-table fixture classes where preprocessing pays for
  itself;
- capture a new immutable full schema-3 baseline on controlled hardware;
- keep Grand Hall base, mirrored, and rotated solution counters replay-stable;
  and
- treat mixed or no-effect A/B outcomes as evidence, not as successes.

## Sprint 4 — Tunnel macros (August 2026)

**Goal.** When a box is pushed into a tunnel cell (exactly 2 collinear floor
neighbors), generate additional successors at "interesting" stopping points:
matching goal cells, the tunnel exit (first non-tunnel cell), or where another
box blocks further progress. The macro produces look-ahead successors alongside
the normal single-push successor; it does not replace it.

**Implementation.**

| File | Change |
|---|---|
| `src/solver/search/tunnel-macros.ts` | New: `TunnelMacroDetector`, `encodeTunnelPushDirection`, `decodeTunnelPushDirection` |
| `src/solver/search/exact-move-astar.ts` | Tunnel macro successor generation after static dead cell check |
| `src/solver/search/ida-star.ts` | Tunnel macro child generation with frame-persisted stop state |
| `src/solver/search/exact-search-features.ts` | `tunnelMacros` feature flag (default: enabled) |
| `src/solver/search/exact-search-types.ts` | `pushCount` on `PushRecord`; multi-push `reconstructFromArena` |
| `scripts/solver-v2-benchmark-lib.ts` | `tunnelMacros` → `tunnelMacroApplications` counter mapping |
| `tests/unit/tunnel-macros.test.ts` | 17 tests: detector unit tests, encode/decode, A*/IDA* integration, oracle comparison |

**Design decision.** Tunnel macros are additive, not replacing. The normal
single-push successor is always generated alongside macro stops. Early prototype
used replacement (`continue` after macro block), which caused the "2-box
T-junction" puzzle to become unsolvable — the robot can navigate around short
tunnels to reach the opposite side, making intermediate stops load-bearing.

**Benchmark (deterministic, Waterfield).**

| Fixture | Visited (before) | Visited (after) | Generated (before) | Generated (after) |
|---|---|---|---|---|
| beginner-three | 13 | 13 | 30 | 30 |
| classic-1 | 46 | 46 | 177 | 177 |
| box-7x7 | 44 | 44 | 437 | 437 |
| expert-maze | 381 | 381 | 1715 | 1715 |

No measurable state-count change on benchmark corpus. The macro primarily
benefits corridor-heavy puzzles not represented in the current fixture set.

**Items deferred.**
- #7 Persistent IDA* TT — unsafe; backed f-values are path-dependent.
- #8 Greedy fallback >20 labels — negligible impact; typical puzzles have 1–3 labels.

## Validation commands

```text
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run test:unit
npm.cmd run test:solver:oracle
npm.cmd run test:solver:optimal
npm.cmd run test:solver:proof-regressions
npm.cmd run test:solver:known:extended
npm.cmd run test:solver:multi
npm.cmd run test:solver:huge
npm.cmd run build
```

Focused benchmark examples are documented in `docs/solver-v2-benchmarks.md`.
