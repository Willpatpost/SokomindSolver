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
