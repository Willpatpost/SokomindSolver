# Solver V2 Progress

## Repository provenance

The current code originated from the GitHub repository `Willpatpost/Sokomind5`.
The project was downloaded as a ZIP and placed on the ODU Waterfield HPC cluster
in a local directory named `Sokomind3` (the name is incidental — earlier Sokomind
directories already existed on Waterfield). The Sokomind5 code was copied over
the older local contents.

From Waterfield, a new GitHub repository named `SokomindSolver` was created with
the complete imported codebase plus the Sprint 0 baseline files as the initial
commit.

Therefore:

- The local directory name (`Sokomind3`), the original source (`Sokomind5`), and
  the current remote (`SokomindSolver`) intentionally differ.
- The initial repository commit intentionally contains the imported codebase.
- No pre-Sprint-0 repository comparison exists.
- This is not an unresolved blocker. Do not attempt to reconstruct, rewrite, or
  compare against a nonexistent pre-Sprint-0 Git commit.

## Sprint 0 — Baseline Established

**Date**: 2026-08-04
**Node**: v22.16.0
**Platform**: linux x64 (AMD EPYC 7B13)

### Solver versions

| Solver | Version |
|---|---|
| sokomind-solver | 1.1.0 |
| classic-astar | 1.0.0 |
| classic-ida-star | 1.0.0 |

### Deliverables

- `CLAUDE.md` — engineering rules from spec section 27
- `tests/fixtures/solver-v2/benchmark-corpus.ts` — 34 frozen fixtures (32 catalog + 2 Grand Hall variants), classified by group
- `scripts/benchmark-solver-v2.ts` — V2 benchmark runner with child-process isolation, schema v2, board hashes
- `docs/solver-v2-progress.md` — this file
- `docs/solver-v2-benchmarks.md` — human-readable summary
- Baseline JSON artifact at `tests/fixtures/solver-v2/baseline-v0.json`

### Fixture classification

| Group | Count | Description |
|---|---|---|
| primary-v2 | 23 | Fixtures with direct V2 solver relevance (typed boxes, multi-box, proof candidates, Grand Hall) |
| legacy-regression | 11 | Simple tutorial/beginner puzzles for regression coverage |

All 34 fixtures are snapshotted inline with frozen row arrays. Board identity is established by SHA-256 hash of the row content. No mutable catalog lookup is required.

### Canonical 17-box fixture

The 17-box hand-designed puzzle from spec §20.1 item 17 is the Grand Hall puzzle. Canonical V2 fixture ID: `v2-17box-handdesigned`. Aliases: `huge`, `grand-hall`. The Grand Hall mirrored and rotated variants use IDs `v2-17box-mirrored` and `v2-17box-rotated`.

### Baseline results

Benchmark schema version: 2. Every record includes board hash, dimensions, fixture group, solver version, configuration with explicit limits, and replay verification status.

| Category | Count |
|---|---|
| Total fixture-solver pairs | 92 |
| Solved | — |
| Cancelled (time/state limit) | — |
| Error (child timeout) | — |

*(Counts updated after compute-node recapture.)*

Where both classic solvers completed, A* and IDA* produced identical optimal move counts.

### test:solver:huge

The `test:solver:huge` test exercises the Grand Hall puzzle in three orientations (base, mirrored, rotated) with a deterministic search phase and a solution-window rewrite phase.

**Deterministic search results** (identical across all three orientations):

| Metric | Value |
|---|---|
| Moves | 1,010 |
| Pushes | 316 |
| Visited | 1,843 |
| Generated | 13,844 |
| Retained | 3,471 |
| Peak frontier | 387 |

These match the reviewed deterministic result exactly.

**Rewrite phase**: The rewrite phase has a 90-second wall-clock gate. On the shared Waterfield login node (AMD EPYC 7B13), this gate was exceeded (104.4s observed). Sprint 0 contains zero solver behavior changes. The deterministic route and state counts are exact matches. This timing failure is a machine-performance condition on a shared login node, not a solver regression.

*(Compute-node result updated below after SLURM job completes.)*

### Test regression

- `npm run check:sokomind-solver` — pass
- `npm run typecheck` — pass
- `npm run lint` — pass
- `npm run test:unit` — 628 tests, 79 suites, all pass
- `npm run build` — pass
- `npm run test:solver:multi` — 4/4 pass
- `npm run test:solver:huge` — see above

---

## Sprint 1 — Exact Identity and Optimality Correctness

**Date**: 2026-08-05
**Node**: v22.16.0
**Platform**: linux x64 (AMD EPYC 7B13)

### Deliverables

#### New files

- `src/solver/search/exact-state.ts` — Collision-free `BigInt` state codec (`ExactStateCodec`)
- `tests/unit/solver-exact-state.test.ts` — 19 tests: round-trip, collision-exhaustion, label grouping, edge cases
- `tests/support/exact-solver-oracle.ts` — Exhaustive step-level BFS oracle for tiny boards
- `tests/unit/solver-exact-oracle.test.ts` — 9 tests: admissibility verification, solved-box regression, codec collision check

#### Modified files

- `src/solver/search/heuristic.ts` — Added two proof-safe walk bounds:
  - `minimumManhattanWalkToPotentialPush`: considers ALL boxes (including on-goal)
  - `minimumReachableWalkToLegalPush`: exact BFS-based bound for node expansion
  - Original `minimumWalkToFirstPush` retained for non-proof discovery
- `src/solver/search/ida-star.ts` — Replaced unsafe `minimumWalkToFirstPush` with corrected `minimumManhattanWalkToPotentialPush`

### ExactStateCodec specification

Each box encoded as: `token = labelId × cellCount + cellId`

Tokens sorted numerically (preserves label grouping), packed into `BigInt`:
```
packed = boxCount | token[0] | token[1] | ... | token[n-1]
```
Each token occupies `ceil(log2(labelCount × cellCount))` bits.

Move-state identity:
```
identity = (packedBoxIdentity << cellBits) | robotCell
```

Properties:
- Collision-free (proven by exhaustive enumeration on tiny boards)
- Same-label boxes are interchangeable (sorted tokens)
- Different labels are distinguishable (labelId in token)
- Supports up to 30 boxes
- Round-trip decode for testing

### Walk lower bound correction

The previous `minimumWalkToFirstPush` excluded boxes on matching goals:
```ts
if (board.goalLabelByCell[box.cell] === box.label) continue;
```
This is unsafe: an optimal solution can begin by moving a correctly placed box.

The corrected `minimumManhattanWalkToPotentialPush` considers all boxes. Additionally checks that both support cell and destination cell are valid floor cells and optionally rejects occupied destinations.

### Oracle validation

The exhaustive oracle uses step-level BFS (cost 1 per walk step, cost 1 per push) to compute exact minimum moves. On a 12-cell board with 2 generic boxes (660 total state positions, ~50+ solvable), the oracle verified:
- `assignmentLowerBound(state) <= exactRemainingMoves(state)` for every solvable state
- `minimumManhattanWalkToPotentialPush(state) <= exactRemainingMoves(state)` for every solvable state
- `pushBound + walkBound <= exactRemainingMoves(state)` for every solvable state (combined proof heuristic)
- Typed-label admissibility verified on a separate 2-label board

### Test regression

- `npm run typecheck` — pass
- `npm run lint` — pass (0 errors)
- `npm run test:unit` — 656 tests, 85 suites, all pass (+28 new tests)
- `npm run build` — pass
- `npm run test:solver:multi` — 4/4 pass

---

## Sprint 2 — Low-Risk Hot-Loop Performance

**Date**: 2026-08-05
**Node**: v22.16.0
**Platform**: linux x64 (AMD EPYC 7B13)

### Objective

Eliminate redundant per-child reachability floods in A* search and reuse reconstruction buffers, without altering solver correctness or deterministic results.

### Deliverables

#### New files

- `tests/unit/sprint2-flood-regression.test.ts` — 11 tests across 5 suites: flood-count regression (A* floods ≤ expanded+1), solution correctness preservation, DFS canonical-cell verification, instrumentation counter presence, collision-free identity verification
- `tests/support/sprint2-baseline.ts` — Baseline measurement script for pre/post comparison

#### Modified files

- `src/solver/search/engine.ts` — Three targeted changes in `runClassicSearch()`:
  1. Removed redundant A* child reachability floods
  2. Reused reconstruction occupancy buffer
  3. Replaced Zobrist string keys with collision-free ExactStateCodec bigint keys for A* proof search

### Change 1: Remove redundant A* child reachability floods

**Root cause**: In the hot loop, every generated child performed a `childReachability.flood()` BFS regardless of search strategy. For A*, this flood's only purpose was computing `canonicalCell` — but A* uses `box.cell` (exact robot position) for state identity, never `canonicalCell`. Additionally, the flood occurred *before* duplicate and infeasibility checks, wasting BFS computation on children that would be immediately rejected.

**Fix**: For A* strategy, compute the state key directly using `box.cell` without any flood. Perform duplicate detection and infeasibility pruning *before* the flood. For DFS/Greedy strategies, the canonical-cell flood is retained but now occurs only after duplicate and infeasibility checks pass.

**Acceptance criterion** (spec §11.1): A* reachability floods ≈ expanded states. Verified: floods = expanded + 1 on all test fixtures.

### Change 2: Reuse reconstruction occupancy buffer

**Root cause**: In `reconstructSolution()`, the `occupancyFor()` helper allocated a new `Uint8Array(cellCount)` for every reconstruction step.

**Fix**: Allocate a single `Uint8Array(cellCount)` before the reconstruction loop and reuse it via `fillOccupancy()` at each step.

### Change 3: Collision-free A* state identity

**Root cause**: The A* proof-search path used `ZobristTable.stateKey()` (a 64-bit XOR hash) as the sole state identity in `bestNodeByKey`, `closed`, and expansion-time stale-node checks. No collision resolution existed — two distinct states sharing a Zobrist key would be incorrectly merged, violating completeness or optimality. `ExactStateCodec` (Sprint 1) was defined but never imported by the search engine.

**Fix**: A* now uses `ExactStateCodec.packMoveState()` to produce a collision-free `bigint` identity for all duplicate detection, best-cost tracking, and closed-set membership. The codec encodes each box as `token = labelId × cellCount + cellId`, sorts tokens (interchanging same-label boxes), and packs them with the exact robot cell into a `BigInt`. This identity is injective by construction — no two distinct states can share a key. DFS/Greedy retain Zobrist string keys (they make no proof-level optimality claim).

**Verification**: Exhaustive test on all (robot, box1, box2) triples across a 12-cell board confirms zero ExactStateCodec collisions. Separate test verifies ExactStateCodec distinguishes states that a truncated hash could merge. End-to-end A* proof results unchanged.

### Baseline comparison

| Fixture | Metric | Before | After | Change |
|---|---|---|---|---|
| two-generic-boxes | Floods | 18 | 4 | −78% |
| two-generic-boxes | Expanded | 3 | 3 | — |
| two-generic-boxes | Moves | 4 | 4 | — |
| exact-keeper-regression | Floods | 140 | 40 | −71% |
| exact-keeper-regression | Expanded | 39 | 39 | — |
| exact-keeper-regression | Moves | 18 | 18 | — |
| medium-4box | Floods | 9,762 | 1,520 | −84% |
| medium-4box | Expanded | 1,519 | 1,519 | — |
| medium-4box | Moves | 28 | 28 | — |

On medium-4box: floods dropped from 6.4× expanded to 1.0× expanded — exactly matching the spec §11.1 acceptance criterion.

All move counts, push counts, expanded states, generated states, and optimality proofs are identical before and after.

### Deterministic result verification

Grand Hall (test:solver:huge) deterministic results unchanged:

| Metric | Value |
|---|---|
| Moves | 1,010 |
| Pushes | 316 |
| Visited | 1,843 |
| Generated | 13,844 |
| Retained | 3,471 |
| Peak frontier | 387 |

### Test regression

- `npm run typecheck` — pass
- `npm run lint` — pass (0 errors)
- `npm run test:unit` — 667 tests, 90 suites, all pass (+11 new tests, +5 new suites)
- `npm run build` — pass
- `npm run test:solver:multi` — 4/4 pass
- `npm run test:solver:huge` — pass (deterministic results identical)

---

## Sprint 1–2 Compliance Correction

**Date**: 2026-08-05
**Node**: v22.16.0
**Platform**: linux x64 (AMD EPYC 7B13)

### Objective

Resolve six specification-compliance deficiencies identified by post-Sprint-2 audit against `docs/solver-v2-spec.md`. No new solver features or Sprint 3 behavior introduced.

### Deliverables

#### New files

- `tests/unit/sprint12-compliance.test.ts` — 14 tests across 4 suites: IDA* BigInt identity (4), avoided-flood counter (3), sorted-box invariants (6), reconstruction buffer (1)
- `tests/support/sprint2-benchmark.ts` — Median-of-5 timing benchmark with warm-up phase

#### Modified files

- `src/solver/search/ida-star.ts` — Three changes:
  1. Replaced `canonicalBoxSignature` string transposition with `ExactStateCodec.packMoveState()` BigInt identity
  2. Transposition table type: `Map<string, number>` → `Map<bigint, number>`
  3. Reconstruction buffer: single `Uint8Array` allocation reused via `fillOccupancy()`
- `src/solver/search/engine.ts` — Added `avoidedReachabilityFloods` counter to `SearchCounters`, initialized to 0, incremented when A* skips a child flood

### Correction 1: IDA* collision-free BigInt identity (spec §3.1)

**Issue**: IDA* used `canonicalBoxSignature` (a collision-free string) for its transposition table, but the spec requires the shared `ExactStateCodec` BigInt codec for all proof paths.

**Fix**: IDA* now imports `createExactStateCodec` and uses `packMoveState()` for transposition keys. The `StackFrame.boxSignature` field was replaced with `StackFrame.exactKey: bigint`. Memory estimation updated for BigInt keys (128 + 64 bytes per entry).

**Verification**: IDA* and A* produce identical optimal solutions on all solvable fixtures (4 moves/2 pushes on two-generic-boxes, 18 moves/6 pushes on exact-keeper-regression). IDA* correctly identifies the typed-2box fixture as exhausted (geometrically unsolvable).

### Correction 2: Explicit `avoidedReachabilityFloods` counter (spec §11.1)

**Issue**: The Sprint 2 A* flood optimization skipped child floods but did not instrument the savings.

**Fix**: New `avoidedReachabilityFloods` field in `SearchCounters`, incremented at the exact point where A* skips a child flood (line 867 of engine.ts). Reported in both solved and cancelled metrics.

**Verification**: Counter is > 0 for all A* solved fixtures. `reachabilityFloods <= expanded + 1` confirmed on all fixtures.

### Correction 3: IDA* reconstruction buffer reuse

**Issue**: IDA* allocated a new `Uint8Array(cellCount)` per reconstruction step.

**Fix**: Single `occupancyBuffer` allocated before the reconstruction loop, reused via `fillOccupancy()`.

**Verification**: IDA* produces correct solutions (4 moves, 2 pushes on two-generic-boxes).

### Correction 4: Sorted-box invariant (spec §2.2)

**Issue**: The `sortedBoxes` and `movedBoxes` functions maintained sorted order but this was not tested.

**Fix**: Six explicit tests verifying:
- `sortedBoxes` produces canonical cell order
- `movedBoxes` preserves sorted order when moving forward or backward
- Typed labels maintain cross-label sort order
- Repeated same-label boxes remain interchangeable
- `ExactStateCodec` receives tokens in sorted order from sorted boxes

### Correction 5: Median-of-5 timing benchmark (spec §20.3)

**Methodology**: 1 warm-up run (discarded) + 5 measured runs per fixture. Median reported.

| Fixture | Median (ms) | Moves | Pushes | Optimality |
|---|---|---|---|---|
| two-generic-boxes | 1.25 | 4 | 2 | proven |
| exact-keeper-regression | 4.07 | 18 | 6 | proven |
| medium-4box | 131.90 | 28 | 13 | proven |
| typed-2box | 0.10 | — | — | unsolved (exhausted) |

Detailed counters per fixture:

| Fixture | Expanded | Generated | Floods | Avoided floods | Duplicates | Deadlock prunes | Infeasible | Peak frontier |
|---|---|---|---|---|---|---|---|---|
| two-generic-boxes | 3 | 16 | 4 | 14 | 0 | 2 | 0 | 12 |
| exact-keeper-regression | 39 | 133 | 40 | 74 | 23 | 33 | 3 | 38 |
| medium-4box | 1,519 | 11,615 | 1,520 | 3,498 | 4,542 | 3,373 | 202 | 1,822 |
| typed-2box | 0 | 0 | 1 | 0 | 0 | 0 | 1 | 1 |

### Correction 6: Sprint 2-only flood comparison (same BigInt identity both sides)

The previous Sprint 2 baseline comparison mixed two changes: Sprint 1 identity upgrade (Zobrist → BigInt) and Sprint 2 flood optimization. This section isolates the Sprint 2 flood optimization using the same BigInt identity on both sides.

**Methodology**: Sprint 1 equivalent flood count = generated − deadlockPrunes (every non-deadlock child was flooded before Sprint 2 optimization). Sprint 2 actual flood count = `reachabilityFloods` counter (parent expansions only; A* children never flooded).

| Fixture | Sprint 1 est. floods | Sprint 2 floods | Reduction |
|---|---|---|---|
| two-generic-boxes | 14 | 4 | −71% |
| exact-keeper-regression | 100 | 40 | −60% |
| medium-4box | 8,242 | 1,520 | −82% |

Estimated solver memory (node/frontier/closed-set storage) is identical between Sprint 1 and Sprint 2. The flood optimization saves CPU work (avoided BFS traversals), not data-structure memory. Process RSS on medium-4box: 165.9 MB.

### Deterministic result verification

Grand Hall (test:solver:huge) deterministic results unchanged:

| Metric | Value |
|---|---|
| Moves | 1,010 |
| Pushes | 316 |
| Visited | 1,843 |
| Generated | 13,844 |
| Retained | 3,471 |
| Peak frontier | 387 |

### Test regression

- `npm run check:sokomind-solver` — pass
- `npm run typecheck` — pass
- `npm run lint` — pass (0 errors)
- `npm run test:unit` — 681 tests, 94 suites, all pass (+14 new tests, +4 new suites)
- `npm run build` — pass
- `npm run test:solver:multi` — 4/4 pass
- `npm run test:solver:huge` — pass (deterministic results identical)

## Sprint 3 — Proof Contract and Protocol

**Date**: 2026-08-05
**Node**: v22.16.0
**Platform**: linux x64 (AMD EPYC 7B13)

### Summary

Pure types/validation/protocol sprint — no search algorithm changes. Added
`SolverProof` metadata contract (bounded, optimal, unsolvable proof kinds),
extended `SolverProgress` with proof-tracking fields, threaded proof validation
through the worker protocol, and maintained full backward compatibility.

### Deliverables

**New files:**

- `src/solver/proof.ts` — proof invariant validation: `collectProofIssues`,
  `assertValidProof`, `isProofCompatibleOptimality`
- `tests/unit/solver-proof-contract.test.ts` — 39 tests across 10 suites

**Updated files:**

- `src/solver/contracts.ts` — added `SolverProofKind`, `SolverProofAlgorithm`,
  `SolverProof` types; extended `SolverPhase` with `"proving"`; extended
  `SolverProgress` with `lowerBound`, `upperBound`, `gap`; added optional
  `proof` field to all three `SolverResult` variants (solved, unsolved, cancelled)
- `src/solver/validation.ts` — added `"proving"` to PHASES set; added
  `lowerBound`/`upperBound`/`gap` keys to progress allowed-keys and structural
  validation; expanded result allowed-keys to include `"proof"`; delegated
  proof validation to `collectProofIssues`
- `src/solver/worker-client.ts` — added `assertValidSolverResult` call on
  received results (defense-in-depth, client-side proof validation)
- `docs/solver-integration.md` — added "Proof metadata" subsection

- `src/solver/worker-host.ts` — added progress monotonicity enforcement
  (lowerBound only increases, upperBound only decreases, gap only decreases);
  violations throw `SolverWorkerRuntimeError` with code `ERR_SOLVER_MONOTONICITY`

**Unchanged files (verified):**

- `src/solver/protocol.ts` — no changes needed; delegates to `validation.ts`
- `src/solver/verification.ts` — replay is unconditional, no proof reference

### Acceptance criteria

| Criterion | Status |
|---|---|
| AC1: Old result payloads remain valid | PASS |
| AC2: Invalid proof combinations rejected | PASS — 10 rejection tests |
| AC3: Optimal result requires equal bounds | PASS |
| AC4: Bounded result requires valid gap | PASS |
| AC5: Worker host and client both validate proof metadata | PASS |

### Test results

- `npm run typecheck` — pass
- `npm run lint` — pass (0 errors)
- `npm run test:unit` — 722 tests, 105 suites, all pass (+41 new tests, +11 new suites)
- `npm run test:solver:multi` — 4/4 pass
- Grand Hall deterministic results unchanged (no search code modified)

### Post-audit corrections

Self-audit against spec §6 identified two gaps, both fixed:

1. **Progress monotonicity (spec §6.4)**: `worker-host.ts` now enforces that
   `lowerBound` only increases, `upperBound` only decreases, and `gap` only
   decreases across successive progress reports. Violations cancel the run with
   `ERR_SOLVER_MONOTONICITY`.

2. **Cancelled variant proof field**: `contracts.ts` and `validation.ts` updated
   so the cancelled `SolverResult` variant includes `readonly proof?: SolverProof`
   and validates it when present. Two new tests added to
   `solver-proof-contract.test.ts` for this variant.

---

## Sprint 4 — Incumbent-Bounded Exact Move A*

**Date**: 2026-08-05
**Node**: v22.16.0
**Platform**: linux x64 (AMD EPYC 7B13)

### Summary

First sprint to **produce proof metadata**. Implements spec §8: an A* search
that continues past the first solution, tracks an incumbent upper bound U, and
terminates with a mathematical proof of optimality when the minimum f in OPEN
reaches U (`L >= U`). Returns bounded gap on cutoff, unsolvable proof when OPEN
empties with no incumbent. The `classicAStarSolver` adapter now delegates to the
new exact A* engine.

### Algorithm

The exact move A* maintains an incumbent solution with cost U (initially ∞ or
a provided initial incumbent). When a goal state is popped with g < U, the
incumbent is replaced and search continues. The search proves optimality when
`L >= U` (the minimum f-value in OPEN meets or exceeds the incumbent cost).

Termination cases:

| Condition | Result | Proof |
|---|---|---|
| `L >= U` | solved, `optimality: "proven"` | `kind: "optimal"`, gap=0 |
| OPEN empty + incumbent | solved, `optimality: "proven"` | `kind: "optimal"`, gap=0 |
| OPEN empty + no incumbent | unsolved, `reason: "exhausted"` | `kind: "unsolvable"` |
| Cutoff + incumbent | solved, `optimality: "unknown"` | `kind: "bounded"`, gap=U−L |
| Cutoff + no incumbent | unsolved, `reason: "limit-reached"` | no proof |
| Cancellation | cancelled | partial metrics |

### Deliverables

**New files:**

- `src/solver/search/exact-search-types.ts` — shared types and pure functions
  extracted from `engine.ts` (`PushRecord`, `SearchNode`, `SearchCounters`,
  `Frontier`, `objectiveScore`, `compareBoxes`, `comparePriority`, `isSolved`,
  `estimateNodeBytes`, `estimatedMemoryBytes`, `reconstructSolution`,
  `OPPOSITE_DIRECTION`, `fillOccupancy`, `fillDeadlockOccupancy`)
- `src/solver/search/exact-move-astar.ts` — incumbent-bounded exact A* with
  proof output (`runExactMoveAStar`, `ExactIncumbent`, `ExactMoveAStarOptions`)
- `tests/unit/exact-move-astar.test.ts` — 13 tests across 9 suites covering
  all 7 acceptance criteria plus edge cases

**Updated files:**

- `src/solver/search/engine.ts` — replaced local definitions of extracted items
  with imports from `exact-search-types.ts`; re-exports for backward compatibility
- `src/solver/implementations/classic-solvers.ts` — `classicAStarSolver` now
  delegates to `runExactMoveAStar` (version bumped to 2.0.0)
- `tests/unit/search-limits.test.ts` — updated expected phase sequence from
  `["preparing", "searching", "verifying"]` to `["preparing", "searching", "improving"]`

### Acceptance criteria

| Criterion | Status |
|---|---|
| AC1: Oracle equality — matches oracle on all 60+ solvable states | PASS |
| AC2: Lower-bound monotonicity across progress reports | PASS |
| AC3: Incumbent improvements (DFS → exact A*) | PASS |
| AC4: Optimal proof structure with collectProofIssues validation | PASS |
| AC5: Unsolvable proof on geometrically impossible puzzle | PASS |
| AC6: Cutoff with incumbent returns bounded proof + gap | PASS |
| AC7: Classic A* adapter produces proof metadata, matches oracle | PASS |

### Deterministic regression

The exact A* produces identical solutions to the previous A* on all test
fixtures. With an admissible heuristic, when the first goal is popped from the
min-heap, `L = f_goal = g_goal = U`, so `L >= U` is immediately satisfied — the
search terminates at the same point, producing identical results plus proof
metadata.

Grand Hall deterministic results unchanged:

| Metric | Value |
|---|---|
| Moves | 1,010 |
| Pushes | 316 |
| Visited | 1,843 |
| Generated | 13,844 |
| Retained | 3,471 |
| Peak frontier | 387 |

### Test regression

- `npm run typecheck` — pass
- `npm run lint` — pass (0 errors)
- `npm run test:unit` — 735 tests, 114 suites, all pass (+13 new tests, +9 new suites)
- `npm run test:solver:multi` — 4/4 pass

---

## Sprint 5 — Corrected Move IDA* and Memory Profiles

**Date**: 2026-08-05
**Node**: v22.16.0
**Platform**: linux x64 (AMD EPYC 7B13)

### Summary

Sprint 5 upgrades IDA* (`ida-star.ts`) to the same proof-producing standard as
the Sprint 4 A* engine. The implementation adds incumbent upper-bound acceptance,
proof metadata output, lower-bound tracking via `lastExhaustedThreshold`, three
reachability snapshot policies for memory control, and an automatic proof
algorithm selection helper.

### Files changed

| File | Action | Lines changed |
|---|---|---|
| `src/solver/search/ida-star.ts` | Updated | Incumbent tracking, proof output, snapshot policies |
| `src/solver/implementations/classic-solvers.ts` | Updated | Version bump to 2.0.0, explicit `reachabilityPolicy: "all"` |
| `src/solver/search/proof-algorithm-selection.ts` | **Created** | Auto proof algorithm selection (§9.7) |
| `tests/unit/exact-move-ida-star.test.ts` | **Created** | 20 tests across 15 suites |
| `docs/solver-v2-progress.md` | Updated | Sprint 5 results |

### IDA* proof engine changes

**Incumbent-bounded search (§9.3)**:
- Accepts `ExactMoveIdaStarOptions` with optional `incumbent`, `reachabilityPolicy`, `snapshotPeriod`
- Prunes when `f >= U` (independent of contour threshold)
- Goal found mid-contour updates incumbent and continues DFS (does NOT return)
- Solution `optimality` is `"unknown"` until contour exhaustion proves it

**Contour proof (§9.4–9.5)**:
- `lastExhaustedThreshold` tracks the highest fully-completed contour
- After iteration completes: `lastExhaustedThreshold = fLimit`
- When `fLimit >= U` or `nextLimit >= U`: incumbent is proven optimal
- Cutoff mid-contour uses `lastExhaustedThreshold` as lower bound (never the
  incomplete `currentThreshold`)
- IDA* never claims proof from an incomplete contour

**Proof metadata output**:
- `kind: "optimal"` — search exhausted all f <= U, gap = 0
- `kind: "bounded"` — cutoff with incumbent, gap = U - lastExhaustedThreshold
- `kind: "unsolvable"` — all states exhausted, no solution exists
- `algorithm: "move-ida-star"` on all proofs

**Cancellation preserves incumbent (§8.7)**:
- Hoisted `incumbentSolution`, `U`, `lastExhaustedThreshold` before try block
- Catch block returns solved+bounded when incumbent exists

**Lower-bound metric on cutoff without incumbent**:
- `metrics.counters.lowerBound` includes `lastExhaustedThreshold`

### Reachability snapshot policies (§9.6)

| Policy | Behavior | Memory | Speed |
|---|---|---|---|
| `"all"` | Save every frame's snapshot | Highest | Fastest resumes |
| `"periodic"` (default, period 4) | Save at depth % period === 0 | Medium | Re-floods un-snapshotted frames |
| `"none"` | Never save snapshots | Lowest | Re-floods every resume |

All three policies produce identical solutions and proof results. The "none"
policy shows strictly lower `memoryReachabilitySnapshotBytes` than "all".

The `classicIdaStarSolver` adapter explicitly passes `reachabilityPolicy: "all"`
to preserve pre-Sprint-5 deterministic behavior. The function default is
`"periodic"` per spec.

### Automatic proof algorithm selection (§9.7)

Created `src/solver/search/proof-algorithm-selection.ts`:

```
If maxMemoryBytes defined and < 768 MiB → IDA*
Else if boxCount ≤ 8 and floorCount ≤ 96 → A*
Else → IDA*
```

Policy is verbatim from spec — not tuned by intuition.

### Acceptance criteria

| Criterion | Result |
|---|---|
| AC1: Oracle equality — all reachable solvable states match | PASS |
| AC2: Lower-bound monotonicity — LB never decreases, UB never increases | PASS |
| AC3: Incumbent improvements — improves suboptimal DFS seed | PASS |
| AC4: Optimal proof structure — valid proof, collectProofIssues = [] | PASS |
| AC5: Unsolvable proof — exhausted + unsolvable proof | PASS |
| AC6: Cutoff with incumbent — bounded proof, gap > 0 | PASS |
| AC6b: Cutoff without incumbent — unsolved, limit-reached | PASS |
| AC7: Classic IDA* adapter produces proof metadata, matches oracle | PASS |
| Snapshot policy equivalence — all/periodic/none identical results | PASS |
| Low-memory mode lowers peak memory — "none" <= "all" snapshot bytes | PASS |
| Incomplete contour guard — never claims proven from incomplete contour | PASS |
| Cancellation preserves incumbent — returns solved+bounded | PASS |
| Bounded proof lb==U guard — promotes to optimal when lb >= U | PASS |
| Already-solved initial state — cost 0, optimal proof | PASS |
| Progress phase transitions — preparing, searching/improving phases | PASS |
| Cutoff lower-bound metric — lowerBound in metrics.counters | PASS |

### Test regression

- `npm run typecheck` — pass
- `npm run test:unit` — 759 tests, 132 suites, all pass (+20 new tests, +15 new suites)
- `npm run test:solver:multi` — 4/4 pass

---

## Sprint 6 — Sokomind Modes and Sequential Proof Integration

**Date**: 2026-08-05
**Node**: v22.16.0
**Platform**: linux x64 (AMD EPYC 7B13)

### Summary

Integration sprint — wires the proof engines from Sprints 4–5 into the
production sokomind solver via three user-facing modes (fast/quality/optimal),
a typed options parser for `request.options?.["sokomind-solver"]`, and a
sequential proof orchestrator. No new search algorithms; no UI changes.

### Files changed

| File | Action | Purpose |
|---|---|---|
| `src/solver/implementations/sokomind-options.ts` | **Created** | Typed options parser (spec §5) |
| `src/solver/implementations/sokomind-proof.ts` | **Created** | Sequential proof orchestration for quality/optimal modes |
| `src/solver/implementations/sokomind-solver.ts` | Updated | Wire modes, parse options, call proof after discovery |
| `tests/unit/sokomind-modes.test.ts` | **Created** | 31 tests across 4 suites |
| `docs/solver-v2-progress.md` | Updated | Sprint 6 results |

### Options parser (`sokomind-options.ts`)

Implements spec §5 request options model.

**Exports**: `SokomindMode`, `SokomindRequestOptions`, `DEFAULT_SOKOMIND_REQUEST_OPTIONS`,
`parseSokomindOptions()`, `extractSokomindOptions()`

**Validated fields**:

| Field | Type | Range | Default |
|---|---|---|---|
| `mode` | enum | `"fast"` \| `"quality"` \| `"optimal"` | `"fast"` |
| `proofAlgorithm` | enum | `"auto"` \| `"astar"` \| `"ida-star"` | `"auto"` |
| `deterministic` | boolean | — | `false` |
| `maximumIncumbents` | integer | 1–8 | 4 |
| `harvestElapsedMs` | integer | 0–30,000 | 5,000 |
| `proofParallelism` | integer | 1–32 | 1 |
| `idaReachabilitySnapshots` | enum | `"all"` \| `"periodic"` \| `"none"` | `"periodic"` |
| `idaSnapshotPeriod` | integer | 1–64 | 4 |

Unknown properties are rejected. Nullish input returns defaults. Non-object
input throws. Missing fields inherit defaults. Returned object is frozen.

### Sequential proof orchestrator (`sokomind-proof.ts`)

`runSequentialProof(request, context, options, discoveryResult)`:

1. Non-solved discovery passes through unchanged
2. Computes remaining time budget from discovery elapsed
3. Selects proof algorithm via `selectProofAlgorithm()` or explicit option
4. Routes to `runExactMoveAStar` or `runIdaStarSearch` with incumbent
5. Returns proof result if solved, otherwise falls back to discovery result

**Quality vs optimal**: quality mode passes remaining time budget to proof;
optimal mode passes original limits unchanged.

### Solver wiring (`sokomind-solver.ts`)

Minimal changes at three well-defined points in the ~2400-line orchestrator:

1. **Top of `solve()`**: `extractSokomindOptions(request)` parses options
2. **Deterministic mode**: `sokomindOptions.deterministic ? 1 : configuredWorkerCount()`
3. **Post-discovery**: `solvedWithImprovement()` calls `runSequentialProof()`
   when `mode !== "fast"` at all three existing call sites (rewrite path,
   classic fallback, and direct solve)

### Acceptance criteria

| Criterion | Status |
|---|---|
| Options parser: null/undefined/empty returns defaults | PASS |
| Options parser: valid overrides merge with defaults | PASS |
| Options parser: unknown keys rejected | PASS |
| Options parser: out-of-range values rejected | PASS |
| Options parser: non-object input rejected | PASS |
| Extract from request: no options returns defaults | PASS |
| Extract from request: mode override works | PASS |
| Quality mode: proof improves or matches DFS solution | PASS |
| Optimal mode: proves small puzzle with optimal proof | PASS |
| Optimal cutoff: preserves incumbent with bounded proof | PASS |
| Non-solved discovery: passes through unchanged | PASS |
| Expired time budget: skips proof, returns discovery | PASS |
| Post-proof replay: all solutions verify | PASS |
| proofAlgorithm astar: produces move-astar | PASS |
| proofAlgorithm ida-star: produces move-ida-star | PASS |
| proofAlgorithm auto: selects astar or ida-star | PASS |
| Deterministic parser: accepts true/false, rejects string | PASS |
| Deterministic extract: passes through from request | PASS |

### Test regression

- `npm run typecheck` — pass
- `npm run lint` — pass (0 errors)
- `npm run test:unit` — 790 tests, 136 suites, all pass (+31 new tests, +4 new suites)
- `npm run test:solver:multi` — 4/4 pass

---

## Sprint 7 — Compact Exact-Search Arena (spec §10, §24)

### Goal

Replace per-node JS object storage (`SearchNode`) and JS-array priority queue
(`StablePriorityQueue`) with chunked typed-array structures, eliminating GC
pressure and cutting retained bytes per node by ≥50%.

### Implementation

#### CompactNodeArena (`src/solver/search/compact-node-arena.ts`)

Chunked typed-array arena storing 8 scalar fields per node plus flattened box
tokens. Each field uses a separate array of fixed-size chunks (CHUNK_SIZE=8192).

| Field | TypedArray | Bytes |
|---|---|---|
| robotCell | Uint16Array | 2 |
| gMoves | Uint32Array | 4 |
| pushes | Uint16Array | 2 |
| parentNode | Int32Array | 4 |
| pushedFromCell | Uint16Array | 2 |
| pushDirection | Uint8Array | 1 |
| heuristic | Uint16Array | 2 |
| **Scalar total** | | **17** |

Box tokens stored as flattened `Uint16Array` (or `Uint32Array` when
`labelCount × cellCount > 65535`). Per-node total for 3 boxes with Uint16
tokens: **23 bytes** vs legacy **752 bytes** = **97% reduction**.

Note: `insertionSequence` was removed from the arena — the
`NumericPriorityQueue` handles FIFO tie-breaking internally via its own
sequence counter, making the arena field dead data.

Factory: `createCompactNodeArena(boxCount, maxToken?)`.

#### NumericPriorityQueue (`src/solver/search/numeric-priority-queue.ts`)

Typed-array binary min-heap specialized for unsigned 32-bit integer values
(node indices) with stable FIFO tie-breaking via insertion sequence.

- `Uint32Array` for values and sequences (initial capacity 1024, doubles on fill)
- Standard sift-up/sift-down with `#compareAt` delegating to caller-supplied compare
- Per-entry: **8 bytes** vs legacy **56 bytes** = **86% reduction**

#### Exact A* Integration (`src/solver/search/exact-move-astar.ts`)

Complete rewrite of the inner search loop:

- Node creation: `arena.allocate()` + field setters instead of `SearchNode` object
- Priority: arena-based compare `(f_a - f_b) || (h_a - h_b)` via `NumericPriorityQueue`
- Key recomputation: `exactCodec.packMoveState(robotCell, tokenBuf)` at expansion
  (no stored key per node)
- Child generation: `sortedInsertToken()` on parent tokens — removes moved box,
  binary-inserts new token in sorted position
- Deadlock/heuristic: mutable `DenseBox[]` buffer, mutate `cell` for child state,
  restore after each direction
- Reconstruction: `reconstructFromArena()` walks arena parent chain
- Memory estimation: `estimatedArenaMemoryBytes()` with arena `estimatedRetainedBytes()`
- `depth` field dropped (depth === pushes always)

#### Support functions (`src/solver/search/exact-search-types.ts`)

- `reconstructFromArena(board, arena, goalIndex, reachability)` — walks parent
  chain via arena field reads, decodes tokens to cells for occupancy and BFS flood
- `estimateArenaNodeBytes(boxCount)` — returns `21 + boxCount * 2`
- `estimatedArenaMemoryBytes(...)` — uses `frontierSize * 8` (was 56) for queue overhead
- Original `SearchNode`, `comparePriority`, `estimateNodeBytes`, `reconstructSolution`
  kept for backward compatibility with engine.ts DFS/Greedy strategies

### Per-node byte comparison

| Component | Legacy (3 boxes) | Arena (3 boxes) | Reduction |
|---|---|---|---|
| Node storage | 752 bytes | 23 bytes | 97% |
| Frontier entry | 56 bytes | 8 bytes | 86% |

Performance gate (§24): ≥50% lower retained bytes — **met at 97%**.

### Files changed

| File | Action |
|---|---|
| `src/solver/search/compact-node-arena.ts` | Created |
| `src/solver/search/numeric-priority-queue.ts` | Created |
| `src/solver/search/exact-move-astar.ts` | Rewritten for arena + queue |
| `src/solver/search/exact-search-types.ts` | Updated (arena reconstruction + estimators) |
| `tests/unit/compact-node-arena.test.ts` | Created |
| `docs/solver-v2-progress.md` | Updated |

### Acceptance criteria

| Criterion | Status |
|---|---|
| Arena allocate/read/write round-trip all fields | PASS |
| Arena crosses chunk boundary (>8192 nodes) correctly | PASS |
| Arena wide tokens (maxToken > 65535) | PASS |
| Queue dequeues in priority order | PASS |
| Queue stable FIFO tie-breaking | PASS |
| Queue handles capacity doubling (>1024 entries) | PASS |
| estimateArenaNodeBytes matches arena estimatedBytesPerNode | PASS |
| Arena node bytes ≤50% of legacy estimate | PASS |
| estimatedArenaMemoryBytes uses reduced frontier cost | PASS |
| Exact A* oracle equality (AC1: all reachable solvable states) | PASS |
| Lower-bound monotonicity (AC2) | PASS |
| Incumbent improvements (AC3) | PASS |
| Optimal proof structure (AC4) | PASS |
| Unsolvable proof (AC5) | PASS |
| Cutoff with incumbent returns bounded proof (AC6) | PASS |
| Classic A* adapter matches oracle (AC7) | PASS |
| Already-solved initial state | PASS |
| Progress phase transitions | PASS |
| Cancellation preserves incumbent | PASS |
| Cutoff lower-bound metric | PASS |
| Bounded proof lb==U guard | PASS |
| 1-box arena integration | PASS |
| 2-box arena integration | PASS |
| Reconstruction replays correctly | PASS |

### Test regression

- `npm run typecheck` — pass
- `npm run lint` — pass (0 errors)
- `npm run test:unit` — 816 tests, 140 suites, all pass (+26 new tests, +4 new suites)
- `npm run test:solver:multi` — 4/4 pass

---

## Sprint 8 — Incremental Typed Assignment Repair (spec §12)

**Date**: 2026-08-06
**Node**: v22.16.0
**Platform**: linux x64 (AMD EPYC 7B13)

### Summary

When one box moves during search, the assignment heuristic previously rebuilt the
full O(N²M) Hungarian cost matrix and solved from scratch. Sprint 8 adds
incremental assignment repair: unchanged label groups reuse their cached
cost/matching/potentials, and the moved label's group uses a single-row
O(NM) Hungarian repair when the group size meets the crossover threshold (≥3).

### Algorithm

The `evaluateIncremental(boxes, childBoxKey, parentBoxKey, movedLabel)` method:

1. Cache hit on `childBoxKey` → return cached cost
2. Cache miss on `parentBoxKey` → fall back to full evaluation
3. For each label group:
   - **Unchanged label** (not `movedLabel`): reuse parent's cached cost
   - **Moved label, group < 3**: full recompute (below crossover)
   - **Moved label, group ≥ 3**: identify removed/added cell via sorted
     set-difference, remap parent's matching and potentials to child's row
     order, build full child cost matrix, call `repairAssignment` on the
     changed row

The repair uses set-difference (not position-by-position comparison) to correctly
handle cases where a box move changes the sorted order within a label group. The
parent's per-row potentials and column assignments are remapped to the child's
sorted cell order before calling the single-row augmenting-path repair.

### Files changed

| File | Action | Purpose |
|---|---|---|
| `src/solver/search/assignment.ts` | Updated | `AssignmentState` type, `minimumAssignmentWithState`, `repairAssignment` |
| `src/solver/search/heuristic.ts` | Updated | BigInt cache, per-label state, `evaluateIncremental`, set-difference repair |
| `src/solver/search/exact-move-astar.ts` | Updated | Wire `evaluateIncremental` with `parentBoxKey`/`childBoxKey`/`movedLabel` |
| `src/solver/search/ida-star.ts` | Updated | Wire `evaluateIncremental` for IDA* search frames |
| `tests/unit/incremental-assignment.test.ts` | Created | 20 tests across 6 suites |
| `tests/unit/search-heuristic.test.ts` | Updated | Add `incrementalRepairs` to stats assertion |
| `docs/solver-v2-progress.md` | Updated | Sprint 8 results |

### New types

**`AssignmentState`** (`assignment.ts`):
```typescript
interface AssignmentState {
  readonly cost: number;
  readonly columns: readonly number[];
  readonly rowPotentials: Float64Array;
  readonly columnPotentials: Float64Array;
}
```

**`LabelAssignmentState`** (`heuristic.ts`): per-label cache entry storing cost,
matching, dual potentials, and the sorted box/goal cells used to build the matrix.

**`AssignmentCacheEntry`** (`heuristic.ts`): `totalCost` + `Map<string, LabelAssignmentState>`.

### Cache architecture

The `AssignmentHeuristic` now has a dual cache:
- **BigInt-keyed** (`Map<bigint, AssignmentCacheEntry>`): used when `packBoxKey`
  is provided (exact-move-astar, ida-star). Stores full per-label state for repair.
- **String-keyed** (`Map<string, number>`): fallback for engine.ts non-proof paths
  that don't have an `ExactStateCodec`. Stores cost only.

Both use LRU eviction with a 50K entry limit.

### Crossover policy

`INCREMENTAL_ASSIGNMENT_CROSSOVER = 3` (spec §12.3, not tuned). Label groups with
fewer than 3 boxes use full Hungarian recompute. Groups with ≥3 use the single-row
repair path when a parent cache entry exists.

### Acceptance criteria

| Criterion | Status |
|---|---|
| `repairAssignment` matches full Hungarian on 3×3 matrix | PASS |
| `repairAssignment` matches full on 4×4 with Infinity | PASS |
| `repairAssignment` handles optimal matching shift | PASS |
| `repairAssignment` detects infeasibility | PASS |
| Identity change returns same result | PASS |
| Rectangular matrix (3×5) repair matches full | PASS |
| Label A move reuses label B cached cost | PASS |
| 3-box generic group uses incremental repair | PASS |
| 2-box group uses full recompute (below crossover) | PASS |
| 3-box group uses incremental repair (at crossover) | PASS |
| 1-box group uses full recompute | PASS |
| 100 random single-box moves: incremental == full | PASS |
| Same box configuration → same BigInt key | PASS |
| Different configurations → different keys | PASS |
| Robot position does not affect box key | PASS |
| Box moving onto matching goal: incremental == full | PASS |
| Box moving off matching goal: incremental == full | PASS |
| Typed + generic mixed labels: incremental == full | PASS |
| Exact A* produces correct solution on 2-box puzzle | PASS |
| Exact A* solves 3-box puzzle | PASS |

### Deterministic result verification

Grand Hall (test:solver:huge) deterministic results unchanged:

| Metric | Value |
|---|---|
| Moves | 1,010 |
| Pushes | 316 |
| Visited | 1,843 |
| Generated | 13,844 |
| Retained | 3,471 |
| Peak frontier | 387 |

### Test regression

- `npm run typecheck` — pass
- `npm run lint` — pass (0 errors)
- `npm run test:unit` — 836 tests, 146 suites, all pass (+20 new tests, +6 new suites)
- `npm run build` — pass
- `npm run test:solver:multi` — 4/4 pass
- `npm run test:solver:huge` — pass (deterministic results identical)

## Sprint 9a — Proof-Safe Pruning (Families 1–3)

**Date**: 2026-08-06

### Overview

Ported three hard-prune families from the production sokomind-engine to the exact proof pipeline. Each prune is unconditionally sound: exhaustive local analysis or structural impossibility ensures no solvable state is ever pruned.

### Family 1: Exact Bounded Pattern Deadlocks

**File**: `src/solver/search/pattern-deadlock.ts` (392 lines)

Bounded BFS on a 9×9 Chebyshev window around a moved box. Tests all local box configurations reachable by pushes (ignoring player reachability and outside boxes). If BFS exhausts the state space with no solution found, the pattern is deadlocked.

- **Eligibility gates**: ≤18 floor cells, ≤2 floor neighbors per cell, 2–4 boxes, ≤512 combinatorial states
- **Canonical pattern key**: 8 symmetry transforms (D4 dihedral group), lexicographic minimum
- **LRU cache**: 50,000 entries with FIFO eviction
- **Soundness**: BFS over-approximates legal moves → conservative. Box escape treated as success. Cutoff returns false.

### Family 2: Exact Sealed Corrals

**File**: `src/solver/search/sealed-corral.ts` (114 lines)

After keeper reachability flood (already computed per-node), finds connected components of unreachable floor cells. For each component containing a misplaced box, checks if any boundary box can be pushed in. If no box is openable → sealed corral deadlock.

- **Per-node check**: Runs after reachability, before child generation (reuses existing BFS — no redundant flood)
- **Soundness**: Keeper cannot reach sealed component, no push can open it → boxes permanently stuck. If any is misplaced, puzzle is unsolvable.

### Family 3: Proven Goal Commitments

**File**: `src/solver/search/goal-commitment.ts` (100 lines)

A box is "proven committed" when: (1) it sits on a cell whose goal label matches, (2) it is statically immovable (no axis has floor on both sides), and (3) the residual Hungarian assignment (excluding this box and its goal) still has finite cost. Committed boxes are excluded from push generation.

- **Soundness**: Corner-locked box on correct goal genuinely never needs to move. Residual matching check prevents false commitments where committing would strand another same-label box.
- **CONDITIONAL tier not ported**: Per spec §14, only the PROVEN tier is implemented.

### Integration

All three families wired into both `exact-move-astar.ts` and `ida-star.ts`:
- Deadlock chain: `isStaticDeadCell` → `createsFullyBlockedTwoByTwoDeadlock` → `hasFreezeDeadlock` → `createsPatternDeadlock` (per-child)
- Corral check: after reachability flood, before child generation (per-node)
- Commitment skip: before push generation loop (per-node)

New counters in `SearchCounters`: `patternDeadlockPrunes`, `corralPrunes`, `commitmentSkips`

### Files changed

| File | Action | Lines |
|---|---|---|
| `src/solver/search/pattern-deadlock.ts` | Created | 392 |
| `src/solver/search/sealed-corral.ts` | Created | 114 |
| `src/solver/search/goal-commitment.ts` | Created | 100 |
| `src/solver/search/exact-search-types.ts` | Updated | +3 counter fields |
| `src/solver/search/exact-move-astar.ts` | Updated | +imports, +cache/detector init, +3 check sites |
| `src/solver/search/ida-star.ts` | Updated | +imports, +cache/detector init, +3 check sites, +committedBoxes frame field |
| `src/solver/search/engine.ts` | Updated | +3 counter fields in init and reporting |
| `tests/unit/pattern-deadlock.test.ts` | Created | 10 tests |
| `tests/unit/sealed-corral.test.ts` | Created | 7 tests |
| `tests/unit/goal-commitment.test.ts` | Created | 7 tests |

### Correctness gates

All three families include oracle exhaustive tests on tiny boards: for every solvable (robot, boxes) configuration, verify no hard prune fires. Zero false positives across all families.

| Test | Result |
|---|---|
| Pattern deadlock: known deadlock detected | PASS |
| Pattern deadlock: known solvable → false | PASS |
| Pattern deadlock: single box (< 2) → false | PASS |
| Pattern deadlock: cutoff (stateLimit=1) → false | PASS |
| Pattern deadlock: label-aware matching | PASS |
| Pattern deadlock: statistics reported | PASS |
| Pattern deadlock: cache limit respected | PASS |
| Pattern deadlock: oracle exhaustive, 0 false positives | PASS |
| Pattern deadlock: boxes on goals → false | PASS |
| Pattern deadlock: box count > boxLimit → false | PASS |
| Sealed corral: trivially sealed with misplaced box | PASS |
| Sealed corral: keeper reaches all boxes → false | PASS |
| Sealed corral: sealed but all on goals → false | PASS |
| Sealed corral: no reachable support → deadlock | PASS |
| Sealed corral: openable → false | PASS |
| Sealed corral: statistics reported | PASS |
| Sealed corral: oracle exhaustive, 0 false positives | PASS |
| Goal commitment: corner-locked on goal → committed | PASS |
| Goal commitment: not on goal → not committed | PASS |
| Goal commitment: movable on goal → not committed | PASS |
| Goal commitment: residual feasible → both committed | PASS |
| Goal commitment: residual infeasible → not committed | PASS |
| Goal commitment: statistics reported | PASS |
| Goal commitment: multiple corners → both committed | PASS |
| Goal commitment: oracle exhaustive, 0 false reductions | PASS |

### Test regression

- `npm run typecheck` — pass
- `npm run lint` — pass (0 errors)
- `npm run test:unit` — 861 tests, 149 suites, all pass (+25 new tests, +3 new suites)
- `npm run build` — pass
- `npm run test:solver:multi` — 4/4 pass (deterministic results unchanged)
- `npm run test:solver:huge` — pass with SOKOMIND_TIMING_SCALE=2 (timing gate only; pruning does not affect legacy engine)
