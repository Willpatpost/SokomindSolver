# Solver V3 -- Legacy Engine Discovery Pipeline

Last updated: August 14, 2026

This document maps the discovery pipeline that produces first-found solutions,
analyzes why Grand Hall currently yields ~1,010 moves, and proposes concrete
improvements targeting **< 700 moves in < 10 seconds**. Proof kernels (A\*,
IDA\*) and rewrite passes are out of scope.

---

## 1. Mode Behavior (Implemented)

| Mode | Behavior |
|---|---|
| `fast` (default) | Return first discovered solution immediately. No rewrite, no harvest. |
| `quality` | Harvest diverse incumbents, rewrite each, return best. |
| `optimal` | Quality + exact proof to certify move-optimality. |

Fast mode was changed to skip `improveIncumbent()` entirely, returning the
raw discovery solution in `solvedWithImprovement()` at `sokomind-solver.ts`.

---

## 2. Discovery Pipeline (Current Flow)

For a structural puzzle like Grand Hall (17 boxes, 127 floor cells):

```
Request
  │
  ▼
[Preparation]  compile board, dense cell index, topology, push distances
  │
  ▼
[Structural Plan]  plan-macro-beam search (1 worker, capped head start)
  │  → if solution found: return immediately (fast mode)
  │  → otherwise: best checkpoint stored but NOT seeded into discovery
  │
  ▼
[Discovery]  up to 3 parallel workers:
  │  Worker 1: "ultimate" portfolio (beam → greedy → weighted A* → pure A*)
  │  Worker 2: bidirectional forward BFS
  │  Worker 3: bidirectional reverse BFS
  │  → first verified solution wins; other workers terminated
  │
  ▼
[Mode Gate]
  fast → return solution as-is
  quality/optimal → harvest + rewrite + optional proof
```

### 2.1 Structural Plan

**Algorithm:** `planMacroBeamSearch` in `solver-search.js:1178`

Macro-level beam search where each transition is a multi-push sequence
moving one box. Uses doorway scheduling (export/import/packing order),
goal-access analysis, and evacuation planning to guide box ordering.

| Parameter | Default | Source |
|---|---|---|
| Beam width | 32 | `tuning.planBeamWidth` |
| Max segments | 160 | `tuning.maxPlanSegments` |
| Plan slack | 240 pushes | `tuning.planSlack` |
| Box branches/step | 6 | `tuning.planBoxBranches` |
| Macro limit | 24 pushes | `tuning.sequenceMacroLimit` |
| Macro explored | 64-96 states | adaptive |
| Time budget | 25s head start | `tuning.structuralHeadStartMs` |
| State share | 60% of total | `tuning.structuralStateShare` |

Scoring formula (`scoreCandidate`, line 1300):
```
score = pushCost + 0.005 * moves
      + (evacActive ? 0.25 : 1.15) * heuristic
      + 4 * goalAccessPenalty + 0.08 * evacuation
      + (evacActive ? 4 : 3) * doorwayPenalty
      - (evacComplete ? 250 : 0)
```

Board transformations (8 orientations) are tried to find the canonical
orientation that places the robot deepest, diversifying the search
space.

### 2.2 Guided Push Portfolio ("ultimate")

**Algorithm:** `searchCore` → `ultimate` portfolio in `solver-search.js:3752`

Sequential cascade of four algorithms, each consuming a fraction of the
remaining budget:

| Lane | Algorithm | Budget Reserve | Realistic for Grand Hall? |
|---|---|---|---|
| 1 | `push-beam` (beam search) | 40% reserved for later | **Yes** — primary solver |
| 2 | `push-greedy` | 20% reserved | No — greedy can't handle 17 boxes |
| 3 | `weighted-push-astar` (w=1.6) | 10% reserved | No — state space too large |
| 4 | `push-astar` (exact) | 0% reserved | No — not even close |

For Grand Hall, only the beam search lane matters. Lanes 2-4 waste ~30%
of the state budget.

### 2.3 Beam Search (The Actual Solver)

**Algorithm:** `beamSearch` in `solver-search.js:1651`

Layered beam search over push states. Each layer:
1. Expand all beam nodes: generate push neighbors with sequence macros
2. Score each candidate
3. Select top-W by feature-space diversity + banded quality selection
4. Compact transpositions, advance to next layer

**Scoring formula** (line 1858):
```
score = costWeight * pushCost           [default: 0 — PUSH COST IS IGNORED]
      + 3.0 * heuristic                 [assignment lower bound]
      + 0.7 * topologyPenalty            [room flow, gate blocking]
      + 0   * evacuation                [disabled by default]
      - 0.8 * goalPackingBonus           [reward solved goals]
      + 0.8 * supportDependencyDelta     [penalty for blocking dependencies]
      + 0.6 * localRoomDelta             [local room ordering signal]
      + 0.35 * (0.2*doorwayPenalty + doorwayDelta)
      + 0.6 * relevanceScore            [goal relevance of this push]
      + 1.5 * signatureNoise            [Zobrist-based diversity jitter]
```

**Beam selection** (`selectBeamLayer`, line 311):
- Feature-space diversity: 35% of beam from unique feature cells
  (heuristic slack × topology × evacuation × packing × doorway × dependency × mobility)
- Banded selection: remaining 65% from four quality bands
  (slack ≤2: 50%, ≤5: 25%, ≤9: 15%, 10+: 10%)
- `takeDiverse()` ensures no two selections from the same push class
  within a band

**Budget for Grand Hall** (approximate, memory ≥ 1.5GB):
- Beam width: 256 (`sokomindDiscoveryBeamWidth` for ≥8 boxes)
- Visited: ~60,000 (divided among 3 workers, this worker gets 1/3)
- After 40% portfolio reserve: ~36,000 visited for beam
- Layers: 36,000 / 256 ≈ 140 beam layers
- Push depth: with macros averaging ~2 pushes, reaches ~280 pushes → enough

**What beam search IS good at:**
- Finding solutions quickly (the push-count path is decent: 316 pushes)
- Feature-space diversity prevents premature convergence
- Doorway/dependency/room ordering guide box sequencing well

**What beam search IS NOT good at:**
- Move-count quality — **costWeight is 0**, so push cost doesn't factor
  into scoring at all
- Keeper walk distance — a push reachable from across the board scores
  the same as one next to the keeper
- The relevanceWeight (0.6) includes proximity but it's weak relative to
  the heuristic weight (3.0)

### 2.4 FESS (Feature-Space Search)

**Algorithm:** `fessSearch` in `solver-search.js:856`

Best-first search using a typed-array arena for memory efficiency. States
are ranked by `weight * 1e9 + moves * 1000 + order`, where weight
accumulates advisory penalties.

Unique features:
- **Arena-based storage**: `createFessStateArena` stores states in typed
  arrays (Uint32Array/Float64Array), not JS objects. Paths are 2-bit
  packed (4 moves per byte).
- **Feature cells**: states grouped by (packing, connectivity,
  roomConnectivity, outOfPlan). The round-robin `nextAction()` visits
  cells cyclically to ensure diversity.
- **Advisor system**: `fessAdvisor` scores pushes by whether they make
  structural progress (packing, connectivity, blocking-box, assignment,
  access). Recommended pushes get weight=0; others get weight=1, which
  delays them by 1e9 in the priority queue.

FESS is **not used in the discovery portfolio**. It's available as
`algorithm: "fess"` but the "ultimate" portfolio doesn't include it.

### 2.5 Bidirectional Search

Workers 2 and 3 run BFS from start and from goal states, publishing
partial-path records. The coordinator checks for meetings. Useful for
small-to-medium puzzles but rarely produces solutions for 17-box puzzles
within the budget.

---

## 3. Why Grand Hall Produces ~1,010 Moves

Grand Hall: 15×15 grid, 17 typed boxes (a,b,c,d,g,h,A,B,C,D,G,H + X),
127 floor cells, 4 rooms connected through narrow gates, robot starts at
center-bottom.

### 3.1 Root Cause Analysis

**1. Push cost has zero weight in beam scoring** (`costWeight: 0`)

The beam search optimizes for reducing the heuristic estimate (remaining
pushes to goal), not for finding short paths. A sequence that adds 50
moves to reduce the heuristic by 5 scores the same as one that adds 10
moves to reduce it by 3. Result: 316 pushes is decent, but the 1,010
moves include excessive keeper walking.

**2. Move count has negligible weight** (`planMoveWeight: 0.005`)

The plan-macro-beam scoring uses `0.005 * moves`, which for a 1,000-move
solution adds only 5.0 to the score — negligible compared to heuristic
and topology contributions (typically 50-150).

**3. No keeper-proximity bias in push ordering**

The beam search treats all pushable boxes equally regardless of how far
the keeper has to walk. The `relevanceWeight: 0.6` includes some
proximity signal but it's dominated by the `heuristicWeight: 3.0`.

**4. Structural plan checkpoints are discarded**

The structural plan runs for 25s and produces good intermediate
checkpoints, but if it doesn't find a complete solution, those
checkpoints are thrown away. The discovery phase starts over from the
initial state instead of seeding from the plan's best checkpoint.

**5. 30% of portfolio budget wasted on infeasible lanes**

The "ultimate" portfolio reserves 30% for greedy/weighted-A\*/A\* that
cannot possibly solve a 17-box puzzle. These states do nothing.

**6. No continuation/endgame probes**

The beam search supports `continuationVisited` and `endgameVisited`
parameters that launch DFS/beam probes from near-solution checkpoints,
but the discovery payload doesn't set these. The beam search may get
close to a solution (heuristic ≤ 20) but lack the depth budget to
finish.

**7. Beam width may be too narrow**

256 for Grand Hall gives ~140 layers after portfolio reservation.
Each layer explores at most 256 candidates. For a puzzle with complex
room interactions, more beam width means more diverse strategies
survive to the endgame.

### 3.2 What a 700-Move Solution Looks Like

A human solving Grand Hall in < 700 moves typically:
1. Clears staging areas systematically (export surplus boxes first)
2. Moves boxes in batch along corridors to minimize keeper backtracking
3. Packs goal rooms in dependency order (deepest goals first)
4. Minimizes keeper walks by choosing pushes near the current position

The solver's 1,010-move solution does steps 1 and 3 well (thanks to
doorway scheduling and packing order), but steps 2 and 4 poorly
because the scoring function doesn't penalize long keeper walks.

---

## 4. Improvement Proposals

### Sprint 1: Scoring Rebalance (Expected: −200 to −300 moves)

**Rationale:** The single highest-impact change. The beam search finds
good push sequences but terrible move sequences because moves don't
factor into scoring.

**Changes:**
1. Increase `costWeight` from 0 to **0.3** — factor push cost into
   beam scoring to prefer shorter push paths
2. Increase `planMoveWeight` from 0.005 to **0.03** — give move count
   meaningful influence in plan scoring
3. Increase `relevanceWeight` from 0.6 to **1.0** — stronger keeper
   proximity bias to prefer pushes near the keeper
4. Add a `moveWeight` term to beam scoring: `moveWeight * moveCount`
   with a small coefficient (0.01-0.03) to penalize long keeper walks

**Risk:** Higher cost/move weights could cause the beam to converge
prematurely on greedy-looking but ultimately suboptimal paths. Needs
A/B evaluation on the full benchmark corpus.

**Validation:** Run Grand Hall with old and new weights, compare move
count and solve time. Verify no regression on the 43-fixture matrix.

### Sprint 2: Eliminate Portfolio Waste (Expected: −50 to −100 moves)

**Rationale:** For 17-box puzzles, giving 100% of the state budget to
beam search instead of wasting 30% on impossible lanes gives the beam
36,000 → 52,000 visited states (+44%).

**Changes:**
1. In the "ultimate" portfolio, skip greedy/A\* lanes when box count ≥ 8
2. Or: route 100% of budget to push-beam for structural puzzles
3. Consider using `beamRestartSearch` (3 restarts with different seeds)
   instead of the portfolio cascade for large puzzles

**Risk:** Low. The skipped lanes never produce solutions for large
puzzles anyway.

### Sprint 3: Enable Continuation Probes (Expected: −50 to −150 moves)

**Rationale:** The beam search collects near-solution checkpoints
(heuristic ≤ threshold) but never launches finishers from them. Adding
continuation/endgame probes lets the beam "finish off" promising
positions.

**Changes:**
1. Add `endgameVisited` and `continuationVisited` parameters to the
   discovery payload in `discoveryPlans()`
2. Set `endgameThreshold: 40` (launch probes when heuristic drops below
   40 pushes remaining)
3. Budget: allocate 20% of visited budget to endgame probes

Beam search already has the infrastructure for this (lines 2027-2125):
`beamRestartSearch` launches continuation beam searches and
`boundedPushDepthFirstSearch` endgame DFS probes from the best
checkpoints.

### Sprint 4: Seed Discovery from Plan Checkpoints (Expected: −100 moves)

**Rationale:** The structural plan runs for up to 25s and produces good
intermediate checkpoints. Currently these are discarded when the plan
doesn't find a complete solution. Seeding the beam search from these
checkpoints would give it a 100-200 push head start.

**Changes:**
1. When structural plan returns without a solution, extract its best
   checkpoint(s) from the result
2. Pass checkpoint states to the discovery phase as initial beam members
3. The beam search would start with both the original initial state AND
   the plan checkpoints in its beam

**Complexity:** Medium. Requires modifying `discoveryPlans()` to accept
checkpoint seeds and `beamSearch()` to accept an initial beam.

### Sprint 5: FESS as Discovery Lane (Expected: exploration)

**Rationale:** FESS uses a completely different search strategy (best-first
with feature-cell diversity) and might find solutions the beam search
misses. It's already implemented but not included in the discovery
portfolio.

**Changes:**
1. Add FESS as a fourth discovery lane (or replace bidirectional reverse)
2. Configure with modest budget (20,000 visited states)
3. FESS arena is memory-efficient (typed arrays), so memory impact is low

**Risk:** FESS might not find solutions for 17-box puzzles within the
budget. Its advisor system needs tuning for large puzzles. Worth
experimenting.

### Sprint 6: Wider Beam for Complex Topologies (Expected: −50 moves)

**Rationale:** Grand Hall has 4 distinct rooms with narrow gates. More
beam width preserves more diverse room-packing strategies through the
search.

**Changes:**
1. Increase beam width for structural puzzles from 256 to 512
2. Or: scale beam width by room count * gate connectivity
3. Compensate by reducing visited budget proportionally to maintain
   solve time

**Trade-off:** Wider beam = fewer layers but more diversity per layer.
For complex room puzzles, diversity is more valuable than depth.

---

## 5. Current Engine Parameters

### 5.1 Tunable Weights (21 parameters in `sokomind-tuning.ts`)

| Parameter | Default | Effect on Discovery |
|---|---|---|
| `planMoveWeight` | 0.005 | Plan scoring: move count influence (near zero) |
| `heuristicWeight` | 3.0 | Beam scoring: remaining-push estimate |
| `costWeight` | 0.0 | Beam scoring: accumulated push cost (**zero!**) |
| `goalPackingWeight` | 0.8 | Beam scoring: reward for solved goals |
| `mobilityWeight` | 0.03 | Beam selection: keeper mobility |
| `topologyWeight` | 0.7 | Beam scoring: room flow balance |
| `evacuationWeight` | 0.0 | Beam scoring: evacuation penalty (**disabled**) |
| `supportDependencyWeight` | 0.8 | Beam scoring: blocking dependency |
| `localRoomWeight` | 0.6 | Beam scoring: local room ordering |
| `doorwayFlowWeight` | 0.35 | Beam scoring: doorway traffic |
| `relevanceWeight` | 0.6 | Beam scoring: push relevance/proximity |
| `planBeamWidth` | 32 | Plan: beam width |
| `planBoxBranches` | 6 | Plan: box candidates per step |
| `maxPlanSegments` | 160 | Plan: max depth |
| `planSlack` | 240 | Plan: cost slack bound |
| `sequenceMacroLimit` | 24 | Max pushes in a macro sequence |
| `structuralHeadStartMs` | 25,000 | Plan: time budget |
| `structuralTimeShare` | 0.7 | Plan: fraction of total time |
| `structuralStateShare` | 0.6 | Plan: fraction of state budget |
| `rewriteWindowVisited` | 12,000 | Rewrite: per-window budget |
| `rewriteMoveWindowScale` | 1.0 | Rewrite: move-window multiplier |

### 5.2 Discovery Budget Allocation (Structural Puzzle, Memory ≥ 1.5GB)

| Resource | Direct Portfolio | Bidirectional (each) |
|---|---|---|
| Visited states | 180,000 / 3 = 60,000 | 100,000 / 3 = 33,333 |
| Generated states | 1,200,000 / 3 = 400,000 | — |
| Beam width | 256 | — |
| Transposition limit | 60,000 | 40,000 frontier |
| Max push depth | 360 | — |

### 5.3 Key Thresholds

| Threshold | Value | Purpose |
|---|---|---|
| Structural trigger | ≥ 10 boxes OR ≥ 100 floor | Enable plan phase |
| "Moderate" puzzle | ≥ 5 boxes OR ≥ 45 floor | Adjust budgets |
| Box complexity | ≥ 8 boxes | Narrow beam width |
| Endgame threshold | not configured | Would enable probes |
| Solution comparison | 96 states | Plan: how long to keep searching after first solution found |

---

## 6. Search Algorithm Inventory

| Algorithm | Function | Used By | Move-Optimal? |
|---|---|---|---|
| Plan Macro Beam | `planMacroBeamSearch` | Structural plan | No |
| Push Beam | `beamSearch` | Discovery "ultimate" | No |
| Beam Restarts | `beamRestartSearch` | Not used in default flow | No |
| FESS | `fessSearch` | Not used in default flow | No |
| Bounded Push DFS | `boundedPushDepthFirstSearch` | Endgame probes (if enabled) | No |
| Push Greedy | `searchCore` (greedy) | Discovery "ultimate" | No |
| Weighted Push A\* | `searchCore` (w=1.6) | Discovery "ultimate" | No |
| Push A\* | `searchCore` (exact) | Discovery "ultimate" | Push-optimal |

---

## 7. Measurement Plan

1. Run `npm run benchmark:solver:v2` before and after each sprint
2. Grand Hall specifically: `npm run test:solver:huge`
3. Track: move count, push count, solve time, peak memory
4. Compare full 43-fixture matrix for regressions
5. Use `SOKOMIND_TIMING_SCALE=2` on Waterfield login node

---

## 8. Open Questions

1. What is the optimal `costWeight` for move-count quality without
   sacrificing push-count quality? Need A/B experiments.

2. Should `evacuationWeight` be nonzero for Grand Hall? The puzzle has
   boxes that must leave rooms before others can enter.

3. Does seeding from plan checkpoints help or hurt? The plan's best
   checkpoint might be in a local optimum that biases the beam.

4. Would `beamRestartSearch` with 3 restarts beat the single-shot beam?
   Different seeds explore different parts of the search space.

5. What beam width saturates the quality improvement? Is 512 better than
   256, or does it plateau?
