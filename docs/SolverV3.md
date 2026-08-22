# Solver V3 -- Legacy Engine Discovery Pipeline

Last updated: August 22, 2026

This document maps the discovery pipeline that produces first-found solutions,
analyzes why Grand Hall formerly yielded 1,066 moves, records the current
893-move first-found route, and proposes concrete
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

**Algorithm:** `planMacroBeamSearch` in `solver-search.js:1445`

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
| Macro explored | 48 general / 64 targeted states | adapter payload |
| Time budget | 25s head start | `tuning.structuralHeadStartMs` |
| State share | 60% of total | `tuning.structuralStateShare` |

Scoring formula (`scoreCandidate`, line 1598):
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

**Algorithm:** `searchCore` → `ultimate` portfolio in `solver-search.js:4352`

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

**Algorithm:** `beamSearch` in `solver-search.js:2055`

Layered beam search over push states. Each layer:
1. Expand all beam nodes: generate push neighbors with sequence macros
2. Score each candidate
3. Select top-W by feature-space diversity + banded quality selection
4. Compact transpositions, advance to next layer

**Scoring formula** (base score at line 2324, mobility adjustment at line 2485):
```
score = costWeight * pushCost           [default: 0 — PUSH COST IS IGNORED]
      + 0.002 * accumulated moves       [small move/walk-distance signal]
      + 3.0 * heuristic                 [assignment lower bound]
      + 0.7 * topologyPenalty            [room flow, gate blocking]
      + 0   * evacuation                [disabled by default]
      - 0.8 * goalPackingBonus           [reward solved goals]
      + 0.8 * supportDependencyDelta     [penalty for blocking dependencies]
      + 0.6 * localRoomDelta             [local room ordering signal]
      + 0.35 * (0.2*doorwayPenalty + doorwayDelta)
      + 0.6 * relevanceScore            [goal relevance of this push]
      + 1.5 * signatureNoise            [Zobrist-based diversity jitter]
      - 0.03 * reachable cells          [keeper-mobility reward]
```

**Beam selection** (`selectBeamLayer`, line 570):
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
- Finding solutions quickly (the current first path uses 322 pushes)
- Feature-space diversity prevents premature convergence
- Doorway/dependency/room ordering guide box sequencing well

**What beam search IS NOT good at:**
- Push-count quality — **costWeight is 0**, so accumulated push cost does not
  affect the base score
- Move-count quality — accumulated moves have only a 0.002 weight, too weak to
  repair a globally poor push agenda
- The relevanceWeight (0.6) includes proximity but it's weak relative to
  the heuristic weight (3.0)

### 2.4 FESS (Feature-Space Search)

**Algorithm:** `fessSearch` in `solver-search.js:1118`

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

## 3. Why Grand Hall Produced 1,066 Moves

Grand Hall is a 15×15 grid with six typed boxes (A/B/C/D/G/H), eleven
generic boxes (X), 127 floor cells, and a robot that starts at center-bottom.
The certified doorway analysis focuses on the gated lower room.

### 3.1 Root Cause Analysis

The reviewed 628-move route has 244 pushes and 384 keeper walks. The former
1,066-move solution had 322 pushes and 744 keeper walks; the current 893-move
solution has 278 pushes and 615 keeper walks. Replay analysis found no repeated
exact states in the former route, and every walk between consecutive pushes was
already shortest for its chosen push sequence. The quality gap is therefore
primarily the push agenda, not local pathfinding.

The lower room has six mandatory exports and four mandatory imports. Its
two-sided barrier requires four exports before the first import; after those
four exports, exactly two imports are safe. The earlier schedule admitted only
one, and its distance term continued to prioritize every pending export. The
current schedule uses the capacity formula and measures the nearest imports
that are actually unlocked.

The former first solution exported all six lower boxes before importing. Two
independent defects hid the better schedule:

1. Root branching spent two of eight fixed slots on alternate directions for
   already represented boxes, so the seventh distinct box agenda was not
   retained even though the teacher route selected it.
2. `strandedExports` was a local, one-push reachability estimate but was used as
   a hard import rejection. A legal import can temporarily make another export
   non-immediate while creating the support access needed to continue it.

The retained fixed-work branch policy and softening of that unproven prune now
produce the structurally correct four-export, two-import, two-export,
two-import cadence. The first-found route is 893 moves / 278 pushes. The
remaining gap is mostly later agenda sequencing in the upper room: 92 pushes
and 256 moves occur after the final lower-room crossing. The route also places
H on its goal, later reopens it, and manipulates that box in four episodes.
Global temporary-goal penalties did not fix this coherently.

### 3.2 What a 700-Move Solution Looks Like

A human solving Grand Hall in < 700 moves typically:

1. Clears staging areas systematically (export surplus boxes first)
2. Moves boxes in batch along corridors to minimize keeper backtracking
3. Packs goal rooms in dependency order (deepest goals first)
4. Minimizes keeper walks by choosing pushes near the current position

The solver performs valid local routing, but its longer-lived staging and goal
commitments make the keeper traverse the board far more often.

---

## 4. Implemented and Rejected Changes

Implemented:

1. Fast mode returns the first replay-verified solution immediately. It does
   not harvest, compare another final layer, or start a rewrite worker.
2. Perfect-matching domains certify mandatory room crossings without treating
   ambiguous generic assignments as facts.
3. The doorway-capacity rule admits the number of imports made safe by completed
   exports. The distance term alternates naturally between unlocked imports and
   the exports needed to unlock the next slot.
4. Structural goal-access evaluation uses a compact, plan-local summary instead
   of retaining full goal-access object graphs in the global signature memo.
   Equivalence tests lock the penalty and blocked-goal outputs used by scoring.
5. Dense occupancy and non-allocating hot paths remove repeated box scans and
   temporary arrays while preserving the selected route.
6. Plan-local doorway and analysis caches are bounded and included in live
   memory telemetry. Reusing a prepared board under a smaller ceiling replaces
   oversized derived caches instead of reporting a limit they do not honor.
7. On room-bearing boards with more movable boxes than the ordinary distinct
   box quota can represent, one of the existing eight first-push slots is
   reserved for one additional distinct box before alternate directions. The
   total branching budget is unchanged.
8. The local `strandedExports` signal remains in search scoring, but its hard
   rejection is now diagnostic opt-in (`planStrandedExportGuard: true`). The
   independently certified packing-order, goal-access, deadlock, and box-
   continuation guards remain enabled.
9. `planDiagnostics: true` returns a bounded, structured trace with one record
   per macro layer: generated and selected first pushes, distinct boxes,
   macro successors, candidate/milestone/eligible/retained counts, and explicit
   prune totals. The field is absent in normal runs and does not allocate layer
   records unless requested.

### 4.1 Current deterministic results

| Case | Moves | Pushes | Visited | Generated | Retained | Peak frontier |
|---|---:|---:|---:|---:|---:|---:|
| Grand Hall, former fast baseline | 1,066 | 322 | 1,616 | 9,329 | 3,077 | 330 |
| Grand Hall, current first found | **893** | **278** | **1,329** | **8,425** | **2,538** | **291** |
| Current route after quality rewrite | 789 | 270 | 29,000 | 108,722 | 29,000 | 1 |

Base, mirror, and 180-degree rotation produce exactly the same 893 / 278
result and counters. All routes above replay successfully. The direct Node
engine takes about 5.3--7.2 seconds by orientation on the development machine;
the rewrite is intentionally not part of fast mode.

### 4.2 Controlled experiments

| Experiment | Result | Decision |
|---|---|---|
| Original branch policy + stranded hard guard | 1,066 / 322 | Baseline |
| Distinct-box reserve only | 1,020 / 288, more generated work | Incomplete alone |
| Guard relaxation only | Cutoff, 5,043 visited / 30,659 generated | Reject alone |
| Reserve + guard relaxation | **893 / 278**, less search than baseline | Retain as one coherent change |
| One enabling handoff per box | Cutoff, 54,942 generated | Revert |
| Persistent agenda-resumption slot | 1,121 / 322 | Revert |
| Macro alternate-approach reserve | Cutoff, 27.5 s | Revert |
| Move-aware macro arrival diversity | Cutoff, 20.6 s | Revert |
| Temporary-goal penalty | 918 / 278, more search | Revert |
| Remove temporary goals from milestone identity | Cutoff, 5,025 visited / 39,580 generated | Revert |

The failed diversity trials preserved local keeper-arrival geometry, not a
coherent multi-macro agenda. They displaced useful endpoints repeatedly and
are not suitable for fast mode.

### 4.3 Generalization evidence

The default reserve predicate is based only on topology and branch pressure:
the board has at least one detected room and more than `planBoxBranches + 2`
boxes. It activates on 23 of 2,095 catalog puzzles, not on an ID, dimensions,
labels, or fixed doorway counts. Representative non-Grand-Hall improvements
include:

| Puzzle | Before | After |
|---|---:|---:|
| `gen-expert-057` | 109 / 24 | 87 / 24 |
| `gen-master-090` | 90 / 28 | 86 / 28 |
| `gen-expert-335` | 341 / 95 | 195 / 43 |

Across the reviewed 15-puzzle room-bearing structural corpus, the combined
default produced four wins, eight ties, and three losses while reducing total
moves, pushes, and generated states. Large room/packing boards remain the most
important regression class because the seventh box can replace a useful second
direction.

Rejected after deterministic Grand Hall trials:

- larger global move weights;
- move-aware transposition and macro Pareto variants;
- hard doorway branch quotas;
- global crossing-progress rewards or reduced evacuation-completion bonuses;
- keeper-distance weighting at the first-push rank;
- goal-transit penalties for premature H placement;
- import-to-goal continuation or reserved import branch slots;
- one-push handoff macros and persistent agenda-resumption slots; and
- local keeper-approach diversity at macro endpoints.

Those variants either exhausted the bounded frontier or returned a slower,
longer first solution. Future work should add phase-aware macro diversity only
with fixed branch/beam budgets and a corpus gate; the all-export fallback must
remain represented.

---

## 5. Current Engine Parameters

### 5.1 Tunable Weights (21 parameters in `sokomind-tuning.ts`)

| Parameter | Default | Effect on Discovery |
|---|---|---|
| `planMoveWeight` | 0.005 | Plan scoring: move count influence (near zero) |
| `heuristicWeight` | 3.0 | Beam scoring: remaining-push estimate |
| `costWeight` | 0.0 | Beam scoring: accumulated push cost (**zero!**) |
| `goalPackingWeight` | 0.8 | Beam scoring: reward for solved goals |
| `mobilityWeight` | 0.03 | Beam score: keeper-reachability reward |
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
| Plan solution comparison | fast: 0; quality/optimal: 96 states | Fast returns the first plan solution; other modes compare a bounded final layer |
| Fallback-beam solution comparison | fast: 0; quality/optimal: 64 candidates | Fast also returns the first fallback-beam solution without a hidden comparison tail |

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

1. What compact representation can preserve an interrupted strategic agenda
   without forcing its immediate resumption or multiplying macro endpoints?

2. Can provisional goal occupancy be incorporated as one component of a
   state-specific traffic/dependency feature instead of a global penalty?

3. Does seeding from plan checkpoints help or hurt? The plan's best
   checkpoint might be in a local optimum that biases the beam.

4. Would several fixed-work, deterministic strategic restarts beat a single
   homogeneous search, provided each lane encodes a genuinely different
   room/packing agenda rather than arbitrary score noise?

5. What beam width saturates the quality improvement? Is 512 better than
   256, or does it plateau?
