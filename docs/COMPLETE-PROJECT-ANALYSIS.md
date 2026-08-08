# Sokomind3 — Complete Project Analysis

*Generated 2026-08-04. This document is a comprehensive technical map of every
subsystem, file, type, algorithm, and architectural decision in the Sokomind3
codebase.*

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Build System & Configuration](#2-build-system--configuration)
3. [Core Engine (`src/core/`)](#3-core-engine-srccore)
4. [Solver Subsystem (`src/solver/`)](#4-solver-subsystem-srcsolver)
5. [Sokomind Engine (`src/solver/implementations/sokomind-engine/`)](#5-sokomind-engine)
6. [Catalog & Puzzle Data (`src/catalog/`)](#6-catalog--puzzle-data-srccatalog)
7. [UI Features (`src/features/`)](#7-ui-features-srcfeatures)
8. [Shared Infrastructure (`src/shared/`)](#8-shared-infrastructure-srcshared)
9. [Router (`src/router/`)](#9-router-srcrouter)
10. [Application Shell](#10-application-shell)
11. [Testing Infrastructure](#11-testing-infrastructure)
12. [Scripts & Tooling](#12-scripts--tooling)
13. [Deployment & CI/CD](#13-deployment--cicd)
14. [Remaining Work Items](#14-remaining-work-items)
15. [File Index](#15-file-index)

---

## 1. Project Overview

**Sokomind** is a fully static, offline-capable Sokoban puzzle application built
with React 19, TypeScript, and Vite 8. It deploys to GitHub Pages with no
server, database, or account system.

### Key Statistics
- **2,194 validated puzzles** across 6 difficulty tiers (tutorial → master)
- **42 puzzle shard files** (50 puzzles each) for on-demand loading
- **15 typed-box (labeled) puzzles** — a Sokomind-specific extension where
  boxes A-Z must reach matching goals a-z
- **4 solver algorithms**: DFS, Greedy, A*, IDA* (classic family) + the
  production Sokomind Solver (structural macros + bidirectional + rewrite)
- **21 tunable search parameters** exposed for AlphaEvolve optimization
- Pure immutable game rules with no React or browser dependencies in `src/core/`

### High-Level Architecture

```
catalog ----\
             +--> game UI --> App
core -------/

core <------ solver contracts
experience --> game UI and App
```

**Dependency rule**: `src/core` never imports React, storage, animation, audio,
or solver code. Solvers consume the same serializable geometry and snapshot types
as the game.

### Technology Stack
| Layer | Technology | Version |
|-------|-----------|---------|
| Runtime | React + ReactDOM | 19.2.6 |
| Build | Vite | 8.1.5 |
| Language | TypeScript (strict) | 5.9.3+ |
| Testing | Node test runner + c8 | Node 22.13+ |
| E2E | Playwright + axe-core | 1.62+ |
| Linting | ESLint + typescript-eslint | 10.8.0 |

---

## 2. Build System & Configuration

### `package.json` — Key Scripts

| Script | Purpose |
|--------|---------|
| `dev` | Start Vite dev server (runs `predev` first: solver + catalog prep) |
| `build` | TypeScript check + Vite production build |
| `test` | Unit tests + build + static asset validation |
| `test:unit` | Node `--experimental-strip-types --test tests/unit/*.test.ts` |
| `test:browser` | Playwright E2E tests + axe accessibility |
| `test:solver:huge` | Grand Hall guardrail (3 orientations) |
| `test:solver:multi` | Multi-puzzle performance suite |
| `benchmark:solver` | JSON Lines benchmark for hard/master corpus |
| `benchmark:solver:v2` | V2 benchmark with child-process isolation |
| `test:coverage` | Three-tier coverage (c8 + native + engine) |
| `typecheck` | `tsc --noEmit` |
| `lint` | ESLint |

### `tsconfig.json`
- Target: ES2022
- Module: ESNext with Bundler resolution
- Strict mode enabled
- `@/*` path alias maps to project root
- Includes: `src`, `tests`, `vite.config.ts`

### `vite.config.ts` — Three Custom Plugins

1. **`sokomind-public-metadata`**: Replaces `__PUBLIC_SITE_URL__` in HTML;
   injects CSP meta tag with SHA-256 hashes for inline scripts in production.
   CSP directives: `default-src 'self'`, `script-src` with hash whitelist,
   `style-src-attr 'unsafe-inline'` (for React dynamic styles), no `eval`.

2. **`react()`**: Standard Vite React plugin.

3. **`sokomind-asset-manifest`**: Post-build plugin that:
   - Classifies built assets into **precache** (core app) vs **runtime**
     (solver workers, puzzle shards, progress/solver dialogs)
   - Computes SHA-256 hashes for shell resources
   - Generates `dist/asset-manifest.json` with version 2 schema
   - Stamps a build revision hash into the service worker

Manual chunks split React vendor and puzzle catalog into separate bundles.

### `playwright.config.ts`
- Serves `dist/` directory for E2E tests
- Configurable base path via `SOKOMIND_PREVIEW_BASE_PATH` env var
- Default base: `/Sokomind/`

---

## 3. Core Engine (`src/core/`)

The core is the **immutable, framework-independent game engine**. Every type is
JSON-safe. All returned values are frozen with `Object.freeze()`.

### `model.ts` — Domain Types (170 lines)

**Constants & Enums:**
- `DIFFICULTIES`: `["tutorial", "beginner", "intermediate", "advanced", "expert", "master"]`
- `DIRECTIONS`: `["up", "down", "left", "right"]`

**Primary Types:**
| Type | Purpose | Key Fields |
|------|---------|------------|
| `PuzzleDefinition` | Static puzzle metadata | `id`, `title`, `difficulty`, `boxes`, `hint?`, `collection?`, `rows`, `complexity?` |
| `Position` | `{row, column}` coordinate | Immutable, row-major |
| `Box` | Dynamic box state | `id` (stable, e.g. `"X:0"`), `label` (`"X"` or `"A"`-`"Z"`), `position` |
| `Goal` | Static goal position | `label`, `position` |
| `ParsedBoard` | Immutable static geometry | `width`, `height`, `rows`, `walls`, `floor`, `goals`, `initialRobot`, `initialBoxes` |
| `GameSnapshot` | Dynamic state | `puzzleId`, `robot`, `boxes`, `moves`, `pushes`, `solved` |
| `GameHistoryEntry` | Linked-list undo node | `snapshot`, `previous` |
| `GameHistory` | Undo stack with head pointer | `head`, `length` |
| `SnapshotTransition` | Result of one step | `snapshot`, `moved`, `pushed`, `pushedBoxId?`, `deadlocked?` |
| `GameSession` | Complete session state | `puzzle`, `board`, `snapshot`, `history`, `actionLog`, `moves`, `pushes`, `solved` |
| `GameAction` | Discriminated union | `{type:"move", direction}` / `{type:"undo"}` / `{type:"reset"}` |
| `DeadlockDetector` | Optional callback `(board, snapshot) => boolean` | Injected by UI, never imported by core |

**Validation Types:**
- `PuzzleValidationCode`: 8 error codes (`invalid-puzzle`, `empty-board`, `robot-count`, `box-goal-mismatch`, etc.)
- `PuzzleValidationResult`: `{valid, errors[]}`

### `position.ts` — Coordinate Utilities (49 lines)

| Function | Signature | Purpose |
|----------|-----------|---------|
| `positionKey` | `Position → string` | `"row,column"` (deprecated) |
| `numericPositionKey` | `(row, col, width) → number` | Dense `row*width+col` |
| `samePosition` | `(a, b) → boolean` | Equality check |
| `directionDelta` | `Direction → Position` | `up→{-1,0}`, `down→{1,0}`, etc. |
| `translate` | `(pos, delta) → Position` | Vector addition |
| `freezePosition` | `Position → Position` | Deep freeze |
| `freezeBox` | `Box → Box` | Deep freeze with position |

### `puzzle.ts` — Parsing & Validation (327 lines)

**Constants:**
- `WALL = "O"`, `ROBOT = "R"`, `GENERIC_BOX = "X"`, `GENERIC_GOAL = "S"`
- `SUPPORTED_SYMBOL = /^[A-Za-z ORSX]$/` (note: lowercase `x` rejected)

**Dedicated boxes**: Any single uppercase A-Z letter that is NOT O, R, S, or X.
**Goal labels**: `S` → label `X` (generic); `a`-`z` → label `A`-`Z` (typed).

**Key Functions:**
| Function | Purpose |
|----------|---------|
| `analyzeRows(rows)` | Counts robots, boxes by label, goals by label, validates symbols |
| `validatePuzzleRows(rows)` | Row-only validation |
| `validatePuzzle(puzzle)` | Full validation including metadata (id, title, difficulty, boxes count) |
| `parsePuzzleRows(rows)` | Parse to `ParsedBoard` (throws on invalid) |
| `parsePuzzle(puzzle)` | Parse `PuzzleDefinition` to `ParsedBoard` |

**Behavior:**
- Ragged rows padded with walls (`WALL`), not floor
- Box IDs generated as `"LABEL:INDEX"` in source-row order (e.g., `"X:0"`, `"A:1"`)
- `PuzzleValidationError` extends `Error` with `.issues` array

### `game-session.ts` — Immutable State Machine (333 lines)

**Caching:**
- `goalMapCache: WeakMap<ParsedBoard, Map<numericKey, label>>` — avoids
  recomputing goal positions
- `boxIndexCache: WeakMap<GameSnapshot, Map<numericKey, boxIndex>>` — avoids
  rebuilding box lookup per step

**Key Functions:**
| Function | Signature | Behavior |
|----------|-----------|----------|
| `createSession(puzzle)` | `PuzzleDefinition → GameSession` | Initial state |
| `stepSnapshot(board, snapshot, direction, detector?)` | `→ SnapshotTransition` | Core transition: move robot, push box if present, check solved, optionally check deadlock |
| `move(session, direction)` | `→ GameSession` | Step + push to history + append action log |
| `undo(session)` | `→ GameSession` | Pop history, trim action log by 1 char |
| `reset(session)` | `→ GameSession` | Return to initial state, clear history+log |
| `isSolved(snapshot)` | `→ boolean` | Selector |
| `sessionReducer(session, action)` | `→ GameSession` | Dispatch move/undo/reset |

**`stepSnapshot` algorithm:**
1. Compute destination = robot + delta
2. If destination is wall → blocked (return same snapshot)
3. If destination has a box:
   - Compute box destination = destination + delta
   - If box destination is wall or occupied → blocked
   - Move box, increment pushes
4. Increment moves, check solved (all boxes on matching goals)
5. If pushed and deadlock detector provided → invoke detector

**Solved check**: `boxesAreSolved()` uses `goalMapFor()` cache — every box's
cell must have a goal with matching label.

**Undo**: Persistent linked list. `pushHistory` creates one new node;
`popHistory` follows the `previous` pointer. No array copying.

### `action-log.ts` — Compact Move Encoding (111 lines)

- Codes: `U`, `D`, `L`, `R` (single characters, verified at module load)
- `MAX_SHARED_ACTIONS = 2_000` — limit for shareable URLs
- `encodeDirection` / `decodeActionCode`: bidirectional mapping
- `isActionLog(value)`: validates `^[UDLR]*$`
- `decodeActionLog(value)`: strict parser, rejects whitespace/lowercase
- `ActionLogError`: typed error with `code`, `index`, `action` fields

### `replay.ts` — Action Log Replay (78 lines)

- `replayActionLog(puzzle, log, options?)`: Rebuild session from scratch
- Strict mode (default): throws on any blocked action
- Non-strict mode: skips blocked actions, returns `{session, applied, skipped}`
- Used by: session recovery, solver verification, sharing

### `index.ts` — Public Barrel Export

Exports everything from model, position, puzzle, game-session, action-log, and
replay. This is the API boundary for consumers.

---

## 4. Solver Subsystem (`src/solver/`)

### Architecture Overview

```
contracts.ts          ← Pure types (SolverAdapter, SolverRequest, SolverResult, etc.)
protocol.ts           ← Worker message types
validation.ts         ← Solver objective scoring
verification.ts       ← Independent solution replay verification
cancellation.ts       ← AbortSignal → SolverCancellation error
compatibility.ts      ← Adapter compat checks
deadlock-bridge.ts    ← Bridge from game layer to solver deadlock checks
registry.ts           ← SolverRegistry: named adapter lookup
default-registry.ts   ← Default registry with all 4 solver families
worker-host.ts        ← Worker-side job execution
worker-client.ts      ← Main-thread worker management
solver.worker.ts      ← Worker entry point
index.ts              ← Barrel export

search/               ← Classic solver primitives
  model.ts            ← DenseBox, ZobristTable, canonicalBoxSignature
  compiled-board.ts   ← CompiledSearchBoard (dense geometry for search)
  reachability.ts     ← KeeperReachability (BFS flood fill)
  deadlocks.ts        ← Static dead cell, 2x2 deadlock, freeze deadlock
  heuristic.ts        ← AssignmentHeuristic (Hungarian lower bound + walk augmentation)
  assignment.ts       ← Hungarian algorithm (O(n²×m))
  priority-queue.ts   ← StablePriorityQueue (deterministic binary min-heap)
  engine.ts           ← Classic DFS/Greedy/A* search (push-macro edges)
  ida-star.ts         ← IDA* search (iterative deepening A*)

implementations/      ← Solver adapter implementations
  classic-solvers.ts  ← DFS, Greedy, A*, IDA* adapters
  sokomind-solver.ts  ← Production Sokomind Solver adapter (2400 lines)
  sokomind-tuning.ts  ← 21 tunable parameters with validation
  sokomind-engine/    ← Ported legacy engine (nested worker)
  index.ts            ← Barrel
```

### `contracts.ts` — Solver Interface Types (170 lines)

**Core Interface: `SolverAdapter`**
```typescript
interface SolverAdapter {
  readonly metadata: SolverMetadata;
  solve(request: SolverRequest, context: SolverExecutionContext): Promise<SolverResult>;
}
```

**`SolverRequest`**: `{board, snapshot, objective, limits?, options?}`
- `objective`: Currently only `{kind: "moves"}` — minimizes total movement
- `limits`: `{maxElapsedMs?, maxExpandedStates?, maxGeneratedStates?, maxMemoryBytes?}`

**`SolverResult`**: Discriminated union:
- `{status: "solved", solution, metrics}`
- `{status: "unsolved", reason: "exhausted"|"limit-reached"|"unsupported", metrics, detail?}`
- `{status: "cancelled", metrics}`

**`SolverSolution`**: `{steps[], moves, pushes, objective, objectiveScore, optimality: "unknown"|"proven"}`
- `optimality: "proven"` only set by A*/IDA* after exhaustive exact search

**`SolverMetadata`**: `{id, displayName, description, version, capabilities}`
- Capabilities: executionTargets, runtime, objectives, quality, labeledBoxes,
  genericBoxes, partialState, reportsProgress, cooperativeCancellation, deterministic

**`SolverProgress`**: `{phase, elapsedMs, expandedStates?, generatedStates?,
frontierSize?, counters?, fraction?, incumbent?, detail?}`

### `search/compiled-board.ts` — Dense Board Geometry (259 lines)

`CompiledSearchBoard` pre-computes:
- Floor cells sorted row-major → dense cell IDs (0..N-1)
- `cellByOffset`: rectangular row-major offset → dense cell ID (-1 = wall)
- `neighbors[]`: for each cell, `Int32Array[4]` of adjacent cells (up/down/left/right, -1 = wall)
- `goalCellsByLabel`: `Map<label, cellIds[]>`
- `goalLabelByCell`: `(string|null)[]`
- `reversePushDistancesByGoal`: `Map<goalCell, Int32Array>` — BFS distances for
  admissible heuristic

**`SEARCH_DIRECTIONS`**: Fixed order `[up, down, left, right]` with opposite
indices. This order is part of the contract — changing it changes search
determinism.

**`buildReversePushDistances`**: BFS from each goal cell, computing how many
pushes to reach any floor cell when all other boxes are removed. This is
admissible because removing obstacles can only decrease cost.

### `search/reachability.ts` — Keeper BFS (176 lines)

`KeeperReachability` is a reusable BFS workspace:
- Epoch-based visited tracking (no per-call allocation)
- `flood(start, occupied)` → `KeeperReachabilityResult`:
  - `isReachable(cell)`, `distanceTo(cell)`, `pathTo(cell)` (shortest walk)
  - `canonicalCell`: smallest reachable cell ID (for non-optimal state identity)
- `saveState()` / `restoreState()`: snapshot 4 typed arrays (used by IDA* to
  avoid re-flooding when backtracking)

### `search/deadlocks.ts` — Deadlock Detection (183 lines)

Three independent detectors:

1. **Static dead cell** (`isStaticDeadCell`): A cell is dead for label L if no
   goal with label L is reachable via reverse-push BFS. Pre-computed per board.

2. **2×2 deadlock** (`createsFullyBlockedTwoByTwoDeadlock`): Any 2×2 square
   entirely filled with walls/boxes where at least one box is not on its goal.
   When `movedCell` is provided, only checks the 4 overlapping squares.

3. **Freeze deadlock** (`hasFreezeDeadlock`): Fixpoint analysis — a box is
   "frozen" when both axes (horizontal + vertical) are blocked by walls or
   other frozen boxes. If any frozen box is not on its matching goal → deadlock.
   Uses a worklist queue for efficient propagation.

### `search/heuristic.ts` — Admissible Lower Bound (201 lines)

**`assignmentLowerBound(board, boxes)`**: For each label group, builds a cost
matrix (box → goal distances from reverse-push tables), then solves minimum
assignment via Hungarian algorithm. Sum of all label groups = admissible lower
bound on remaining pushes.

**`minimumWalkToFirstPush(board, playerCell, boxes)`**: Manhattan distance from
player to the nearest support cell of any unsolved box. Admissible because
Manhattan ≤ BFS distance. Added to push lower bound without double-counting
(walk moves and push moves are disjoint).

**`AssignmentHeuristic`**: LRU-cached wrapper (default 50K entries). Cache key =
`canonicalBoxSignature` (ignores box IDs, only labels + cells).

### `search/assignment.ts` — Hungarian Algorithm (145 lines)

`minimumAssignment(costs[][])`: O(rows² × columns) implementation.
- Supports rectangular matrices (rows ≤ columns)
- Deterministic tie-breaking (first equal reduced cost wins)
- Returns `{cost, columns[]}` where `columns[row]` = assigned column
- Handles `Infinity` costs (infeasible assignments)

### `search/priority-queue.ts` — Deterministic Min-Heap (125 lines)

`StablePriorityQueue<T>`: Binary min-heap with insertion-order tie-breaking.
Parallel arrays for values and sequence numbers (no per-entry object allocation).

### `search/engine.ts` — Classic Search Engine (945 lines)

`runClassicSearch(request, context, config)`: Shared implementation for DFS,
Greedy, and A*.

**Search node**: `{robot, boxes, key, parentIndex, push?, moves, pushes, depth, p0, p1, p2, estimatedBytes}`

**Priority computation** (`nodePriority`):
- A*: `[moves + pushLowerBound, pushLowerBound, moves]`
- Greedy: `[pushLowerBound, moves, 0]`
- DFS: `[0, 0, 0]` (LIFO via stack)

**Frontier implementations**:
- `QueueFrontier`: Segmented queue (4096-entry segments) for BFS-like expansion
- `StackFrontier`: Simple array stack for DFS
- `StablePriorityQueue`: For Greedy/A*

**State identity**:
- A*: Zobrist hash of exact robot cell + sorted boxes (exact position matters
  for move-optimal proof)
- DFS/Greedy: Zobrist hash of canonical (smallest reachable) robot cell + sorted boxes

**Duplicate handling**:
- A*: `bestNodeByKey` map tracks best g-cost per state; reopens allowed
- DFS/Greedy: `discovered` set; first visit wins

**Hot loop** (per expanded node):
1. Flood keeper reachability
2. For each box × direction:
   a. Check destination is floor and not occupied
   b. Check support cell is reachable
   c. Check static dead cell
   d. Move box, check 2×2 deadlock
   e. Check freeze deadlock
   f. Compute walk distance (support → robot walk)
   g. Compute heuristic
   h. Check memory limit
   i. Create child node, push to frontier

**Cooperative scheduling**: Yields to event loop every 10ms or 256 work units.
Progress reports every 100ms.

**Solution reconstruction**: Walk parent chain, then for each push edge,
re-flood reachability from parent state to find the exact keeper walk.

### `search/ida-star.ts` — IDA* Search (1034 lines)

`runIdaStarSearch(request, context)`: Iterative-deepening A* with:

**Stack frames** (not nodes): Each frame has `{robot, boxes, boxSignature, moves,
pushes, g, push?, frozenBoxes, childCursor, expanded, reachabilitySnapshot,
cachedReachable, estimatedStackBytes, estimatedReachabilityBytes}`.

**Key differences from classic A*:**
- DFS stack instead of priority queue → O(depth) memory
- F-limit threshold increases each iteration
- Transposition table cleared each iteration (states explored at old f-limit
  need re-exploration with new limit)
- Reachability snapshots saved/restored to avoid re-flooding on backtrack
- Frozen box optimization: boxes on goals locked by walls/frozen neighbors are
  skipped during successor generation
- Walk augmentation: `h = hPush + hWalk` where hWalk = minimum Manhattan
  distance to nearest support cell

**Memory tracking**: Five categories independently estimated:
1. Static (board geometry + reusable buffers)
2. Transposition table entries
3. Heuristic cache entries
4. DFS stack frames
5. Reachability snapshots

### `search/model.ts` — Search Data Types (161 lines)

**`DenseBox`**: `{id, label, cell}` — box in dense coordinate system.

**`canonicalBoxSignature(boxes)`**: Length-delimited string of sorted
`label:cell` pairs. Assumes pre-sorted input. Used as cache key and
transposition identity.

**`ZobristTable`**: Deterministic hash table for state identity.
- `mulberry32` PRNG seeded with `0xdeadbeef`
- Dual 32-bit hash (`h1:h2`) for collision resistance
- Per-cell, per-label random values for box positions
- Separate table for robot position
- `stateKey(robotCell, boxes)` → `"h1:h2"` string

### `implementations/classic-solvers.ts`

Four adapter wrappers around `runClassicSearch` and `runIdaStarSearch`:
- `classic-dfs` (quality: first-found, deterministic)
- `classic-greedy` (quality: first-found, deterministic)
- `classic-astar` (quality: optimal, deterministic, optimality: proven)
- `classic-ida-star` (quality: optimal, deterministic, optimality: proven)

### `implementations/sokomind-solver.ts` — Production Solver (2400 lines)

The default solver. Non-deterministic (parallel first-solution race).

**Solve phases:**
1. **Preparation** (structural puzzles only): Analyze board topology in a
   worker, produce reusable prepared-board seed
2. **Structural plan search**: Macro-beam search with time-limited head start
3. **Discovery portfolio**: Up to 3 concurrent workers:
   - Guided direct search (`algorithm: "ultimate"`)
   - Forward bidirectional search
   - Reverse bidirectional search
4. **Bidirectional fallback** (2-worker config only)
5. **Classic greedy fallback** (if all workers fail/exhaust)
6. **Solution improvement**: Bounded move-count rewrite passes

**Key algorithms/features:**
- `toLegacyState()`: Converts SolverRequest to the legacy engine's state format
- `solutionFromLegacyPath()`: Replays legacy direction path through core engine
- `reconstructBidirectionalPath()`: Joins forward/reverse meeting at a common
  state, BFS-walks the keeper between meeting positions
- `boxesFromMeetKey()`: Decodes compact base-36 push keys for bidirectional
  meeting box positions
- `walkBetween()`: BFS walk between two positions around box obstacles

**Telemetry**: Per-worker tracking of visited, generated, frontier, retained,
memory breakdown (8 categories), Chromium process memory samples.

**Resource management**:
- Worker concurrency: min(hardwareConcurrency-1, memoryBound, 3)
- Memory estimation: deterministic per-state estimates when Chromium reports
  process-wide heap
- Watchdog timer: 120s silence timeout per worker
- Phase deadlines from global elapsed limit

### `implementations/sokomind-tuning.ts` — Tunable Parameters (228 lines)

21 parameters in `SokomindTuningProfile`:

| Parameter | Default | Range | Description |
|-----------|---------|-------|-------------|
| planMoveWeight | 0.005 | 0–0.1 | Plan-move ordering bias |
| heuristicWeight | 3 | 0–20 | Heuristic multiplier in beam scoring |
| costWeight | 0 | 0–10 | Move-cost weight in beam scoring |
| goalPackingWeight | 0.8 | 0–5 | Goal-packing density bonus |
| mobilityWeight | 0.03 | 0–1 | Box mobility bonus |
| topologyWeight | 0.7 | 0–5 | Topological-distance bonus |
| evacuationWeight | 0 | 0–5 | Evacuation-path weight |
| supportDependencyWeight | 0.8 | 0–5 | Support-dependency chain weight |
| localRoomWeight | 0.6 | 0–5 | Local room connectivity weight |
| doorwayFlowWeight | 0.35 | 0–5 | Doorway flow-through weight |
| relevanceWeight | 0.6 | 0–5 | Goal-relevance ordering weight |
| planBeamWidth | 32 | 4–128 | Structural plan beam width |
| planBoxBranches | 6 | 2–16 | Box candidates per plan step |
| maxPlanSegments | 160 | 20–500 | Maximum plan length in segments |
| planSlack | 240 | 50–800 | Plan cost slack allowance |
| sequenceMacroLimit | 24 | 4–64 | Macro discovery budget per sequence |
| structuralHeadStartMs | 25000 | 5000–60000 | Structural lane head start |
| structuralTimeShare | 0.7 | 0.2–0.9 | Fraction of time for structural |
| structuralStateShare | 0.6 | 0.2–0.9 | Fraction of states for structural |
| rewriteWindowVisited | 12000 | 2000–50000 | Rewrite per-window budget |
| rewriteMoveWindowScale | 1.0 | 0.5–4.0 | Move-window size multiplier |

`resolveSokomindTuning(overrides)`: Validates and merges overrides with defaults.
`sokomindTuningPayload(profile)`: Translates to legacy engine vocabulary.
`sokomindTuningFingerprint(profile)`: Stable identity string for benchmarks.

### Worker Communication

**`protocol.ts`**: Defines `SolverWorkerRequest` and `SolverWorkerResponse`
messages between main thread and solver worker.

**`worker-host.ts`**: Worker-side job manager — receives requests, instantiates
adapters, manages cancellation, sends progress/results.

**`worker-client.ts`**: Main-thread client — creates workers, sends requests,
handles responses, suppresses stale jobs.

**`solver.worker.ts`**: Worker entry point — imports host, registers adapters.

**`deadlock-bridge.ts`**: Bridges game UI to solver deadlock checks via
`WeakMap<ParsedBoard, CompiledSearchBoard>` cache. Exposes a `DeadlockDetector`
function the game layer injects into `stepSnapshot()`.

### `cancellation.ts`
- `SolverCancellation` error class
- `throwIfSolverCancelled(signal)`: throws if AbortSignal is aborted
- `isSolverCancellation(error)`: type guard

### `verification.ts`
Independent replay verification: takes a `SolverRequest` + `SolverSolution`,
replays every step through the core engine, verifies moves/pushes/solved match.

### `validation.ts`
`scoreSolverObjective(objective, moves)`: Currently just returns `moves` for
the `"moves"` objective.

---

## 5. Sokomind Engine

`src/solver/implementations/sokomind-engine/` contains the ported legacy Sokoban
solver engine, executed in an isolated nested module worker.

### Source Modules (`source/`)

| File | Purpose |
|------|---------|
| `board.js` | Board parsing, floor/wall maps, neighbor computation |
| `state.js` | State representation, canonical forms |
| `topology.js` | Room/tunnel/doorway detection, connectivity graph |
| `deadlock.js` | Engine-specific deadlock detection (static, pattern, corral) |
| `heuristic.js` | Push-distance heuristics, goal packing, mobility scoring |
| `memo.js` | Transposition tables, state caching |
| `metrics.js` | Memory tracking, performance counters |
| `push-generation.js` | Legal push enumeration, sequence/targeted macros |
| `solver-search.js` | Main search algorithms (ultimate, plan-macro-beam, bidirectional, rewrite) |
| `analysis.js` | Board analysis, prepared-board seed generation |

### `engine.generated.js` / `engine.generated.d.ts`
Concatenated bundle of source modules in dependency order. **Do not edit
directly** — regenerate from `source/` files.

### `engine-protocol.ts`
Defines `EngineCommand` and `EngineResult` message types for the nested worker.
Commands include: `{mode: "search"|"bidir-forward"|"bidir-reverse", payload}`.
Results include: progress records, solution paths, analysis seeds, telemetry.

### `sokomind-engine.worker.ts`
Nested worker entry point. Imports `engine.generated.js`, receives commands,
dispatches to solver functions, posts results.

---

## 6. Catalog & Puzzle Data (`src/catalog/`)

### Structure

- **`generated-puzzles.json`**: Full catalog of 2,194 puzzles with metadata
- **`puzzle-metadata.json`**: Compact metadata index (id, title, difficulty,
  boxes, collection, hint, complexity) without board rows
- **`puzzle-shards/puzzle-shard-XXX.json`**: 42 files, each containing up to 50
  puzzles with full board rows
- **`puzzles.ts`**: Static puzzle definitions (32 canonical + imports)
- **`catalog-types.ts`**: Type definitions for catalog entries
- **`catalog-validation.ts`**: Validates catalog integrity
- **`puzzle-loader.ts`**: Async shard loader (loads only the shard containing
  the requested puzzle)
- **`puzzle-metadata.ts`**: Metadata index accessor
- **`configure-vite-puzzle-loader.ts`**: Vite plugin configuration for shard
  splitting

### Puzzle Distribution

| Difficulty | Count | Share |
|------------|-------|-------|
| Tutorial | 5 | 0.2% |
| Beginner | 46 | 2.1% |
| Intermediate | 1,090 | 49.7% |
| Advanced | 1,035 | 47.2% |
| Expert | 13 | 0.6% |
| Master | 5 | 0.2% |

97% intermediate/advanced (Boxoban dominance: 2,000 puzzles at 10×10, 4 boxes).

### Collections

| Collection | Count |
|------------|-------|
| Boxoban Medium | 1,000 |
| Boxoban Hard | 1,000 |
| Microban | 124 |
| Caleb | 22 |
| Extremely Easy | 10 |
| Seemingly Hard | 5 |
| Illustrative Levels | 1 |
| Canonical (hand-designed) | 32 |

### Board Format

```
O = Wall
R = Robot (keeper)
X = Generic box (matches S goal)
S = Generic goal
A-Z = Typed box (matches lowercase a-z goal)
a-z = Typed goal
  (space) = Floor
```

---

## 7. UI Features (`src/features/`)

### `features/game/` — Game Board & Controls

| File | Purpose |
|------|---------|
| `Board.tsx` | Grid rendering with CSS Grid, stable box IDs for FLIP animation |
| `Board.module.css` | Cell styling, piece animations, deadlock highlights |
| `GameControls.tsx` | Undo, hint, restart, solver buttons |
| `GameSidebar.tsx` | Move/push counters, timer, difficulty badge |
| `CompletionDialog.tsx` | Win dialog with stats, replay, next puzzle |
| `MoveNotation.tsx` | Arrow-glyph strip showing last 24 moves |
| `move-notation-format.ts` | Direction → arrow glyph mapping |
| `game-feedback.ts` | Classifies session transition as step/push/goal/blocked/solve |
| `hint-messages.ts` | Hint request/response message types |
| `hint-worker-runtime.ts` | Hint worker management |
| `swipe-direction.ts` | Touch → direction mapping |
| `timer-math.ts` | M:SS / H:MM:SS formatting |
| `trail-positions.ts` | Last 6 robot positions from undo chain |
| `use-game-keyboard.ts` | Arrow key + WASD + H (hint) + Z (undo) bindings |
| `use-hint-controller.ts` | Hint solver lifecycle (A* with 5s/128MB limits) |
| `use-swipe-controls.ts` | Touch swipe gesture detection |
| `use-timer.ts` | RAF-based timer with auto-pause |

### `features/play/` — Play Page

| File | Purpose |
|------|---------|
| `PlayPage.tsx` | Main play view: board + controls + dialogs |
| `use-play-controller.ts` | Session management, move dispatch |
| `use-persisted-play.ts` | Session autosave/recovery |
| `use-puzzle-navigation.ts` | Next/previous puzzle, catalog navigation |
| `use-sharing.ts` | URL sharing with action log encoding |
| `use-solver-playback.ts` | Animated solution playback |

### `features/editor/` — Puzzle Editor

| File | Purpose |
|------|---------|
| `editor-model.ts` | Editor state: grid, active tool, dimensions |
| `editor-serialization.ts` | Grid ↔ puzzle rows conversion |
| `EditorGrid.tsx` | Editable board grid with tool painting |
| `EditorToolbar.tsx` | Tool palette (wall, floor, box, goal, robot) |
| `EditorPlaytest.tsx` | In-editor puzzle playtesting |
| `use-editor-state.ts` | Editor state management hook |

### `features/editor-page/` — Editor Page
- `EditorPage.tsx`: Full-page editor layout

### `features/experience/` — Audio, Motion, Themes

| File | Purpose |
|------|---------|
| `experience-context.ts` | React context for experience preferences |
| `experience-preferences.ts` | Persistent sound/motion/theme settings |
| `ExperienceProvider.tsx` | Context provider with localStorage sync |
| `ExperienceControls.tsx` | Settings panel (sound, motion, theme toggles) |
| `AmbientBackdrop.tsx` | Animated background with floating shapes |
| `CelebrationOverlay.tsx` | One-shot confetti/particles on puzzle solve |
| `procedural-audio.ts` | Web Audio API synthesis (no downloaded audio) |
| `use-experience.ts` | Consumer hook for experience context |
| `use-resolved-motion.ts` | Respects `prefers-reduced-motion` |
| `use-resolved-theme.ts` | Resolves system vs explicit theme |

### `features/home/` — Home Page
- `HomePage.tsx`: Landing page with difficulty grid and catalog navigation

### `features/help/` — How To Play
- `HowToPlay.tsx`: Rules, controls, keyboard shortcuts guide

### `features/selector/` — Puzzle Browser

| File | Purpose |
|------|---------|
| `PuzzleSelectorPage.tsx` | Full puzzle catalog browser |
| `CollectionGrid.tsx` | Collection-based puzzle grid |
| `DifficultyGrid.tsx` | Difficulty-based puzzle grid |
| `Pagination.tsx` | 50-per-page pagination |
| `PuzzleFilters.tsx` | Filter by difficulty, collection, solved status |
| `PuzzleListView.tsx` | List view of puzzles |
| `selector-constants.ts` | Page size (50), filter options |
| `use-puzzle-list-state.ts` | Filter/sort/paginate state management |

### `features/solver/` — Solver UI

| File | Purpose |
|------|---------|
| `SolverDialog.tsx` | Full solver dialog with algorithm selection |
| `solver-format.ts` | Formats solver metrics for display |
| `solver-internals.ts` | Internal solver state types |
| `useSolverController.ts` | Solver lifecycle management |
| `use-solver-log.ts` | Bounded solver log history |
| `use-solver-progress.ts` | Live progress display |
| `use-solver-worker.ts` | Worker connection management |

### `features/progress/` — Progress Tracking

| File | Purpose |
|------|---------|
| `compute-stats.ts` | Aggregate completion stats by difficulty |
| `ProgressDialog.tsx` | Progress overview, export/import/reset |

### `features/generator/` — Puzzle Generator

| File | Purpose |
|------|---------|
| `generate-puzzle.ts` | Reverse-play puzzle generation |
| `board-template.ts` | Random board template creation |
| `difficulty-classifier.ts` | `estimatePuzzleComplexity()` heuristic |
| `GeneratorDialog.tsx` | Generator UI with size/difficulty controls |
| `generator-types.ts` | Generator configuration types |
| `label-assignment.ts` | Box → goal label assignment |
| `reverse-play.ts` | Reverse push/walk simulation |

---

## 8. Shared Infrastructure (`src/shared/`)

### Storage & Persistence

| File | Purpose |
|------|---------|
| `storage.ts` | Namespaced, versioned, exception-safe localStorage wrapper |
| `progress.ts` | Progress records (best moves/pushes per puzzle) |
| `progress-sync.ts` | Cross-tab progress synchronization |
| `use-stored-progress.ts` | React hook for progress state |
| `session-persistence.ts` | Exact session autosave/recovery via action log replay |
| `idb-storage.ts` | IndexedDB adapter for larger data |
| `optimal-cache.ts` | Optimal solution caching |
| `persistence-health.ts` | Storage health checks |
| `app-data-reset.ts` | Full data reset with confirmation |
| `sw-update-store.ts` | Service worker update state |

**Storage keys:**
- `sokomind.progress.v1` — per-puzzle completion records
- `sokomind.experience.v1` — sound/motion/theme preferences
- `sokomind.session.v1` — active session autosave

### UI Components

| File | Purpose |
|------|---------|
| `Modal.tsx` | Reusable modal dialog with backdrop |
| `ConfirmDialog.tsx` | Confirmation dialog with cancel/confirm |
| `ErrorBoundary.tsx` | React error boundary with fallback |
| `PersistenceWarning.tsx` | Warning when storage is unavailable |
| `UpdateNotification.tsx` | Service worker update prompt |

---

## 9. Router (`src/router/`)

Custom hash-based router (no external dependency).

| File | Purpose |
|------|---------|
| `routes.ts` | Route definitions (home, play, editor, help, selector) |
| `router-context.ts` | React context for router state |
| `RouterProvider.tsx` | Listens to `hashchange`, provides route context |
| `parse-hash.ts` | Hash URL → route params parser |
| `navigation.ts` | Programmatic navigation helpers |
| `Link.tsx` | `<Link>` component for hash navigation |
| `use-router.ts` | Consumer hook |

**Routes:**
- `#/` — Home
- `#/play/:puzzleId` — Play puzzle (with optional `?actions=` query)
- `#/editor` — Puzzle editor
- `#/help` — How to play
- `#/puzzles` — Puzzle selector/browser

---

## 10. Application Shell

### `src/main.tsx`
Composition root: `ExperienceProvider` → `App`.

### `src/App.tsx`
Route-based page rendering with lazy imports for Play, Editor, etc.

### `src/AppShell.tsx`
Layout shell: navigation header, ambient backdrop, main content area,
celebration overlay.

### `src/styles/globals.css`
CSS custom properties for theming, responsive breakpoints, animation
definitions.

### `index.html`
Static metadata mount point with `__PUBLIC_SITE_URL__` placeholders for
OpenGraph/Twitter tags, canonical URL, and PWA manifest.

### `public/sw.js`
Service worker template with `__SOKOMIND_BUILD_REVISION__` token. Handles
precaching, runtime caching of shards/workers, cache pruning on activation.

---

## 11. Testing Infrastructure

### Unit Tests (`tests/unit/` — 47 test files)

| Category | Files | What They Test |
|----------|-------|----------------|
| Core engine | `game-engine.test.ts`, `action-log.test.ts`, `position.test.ts` | All transition rules, undo, reset, label matching |
| Solver search | `deadlock-detection.test.ts`, `search-heuristic.test.ts`, `ida-star.test.ts`, `search-strategies.test.ts`, `search-limits.test.ts`, `reachability.test.ts` | All deadlock types, heuristic admissibility, search correctness |
| Solver integration | `solver-format.test.ts`, `solver-registry.test.ts`, `solver-validation.test.ts`, `solver-verification.test.ts`, `solver-worker-runtime.test.ts` | Registry, verification, worker protocol |
| Sokomind engine | `sokomind-engine.test.ts`, `sokomind-engine-integration.test.ts`, `sokomind-engine-protocol.test.ts`, `sokomind-solver.test.ts`, `sokomind-tuning.test.ts` | Engine protocol, tuning validation |
| Catalog | `catalog.test.ts`, `catalog-boundaries.test.ts` | Puzzle validation, metadata consistency |
| UI logic | `editor-model.test.ts`, `editor-serialization.test.ts`, `experience-preferences.test.ts`, `game-feedback.test.ts`, `hint-*`, `move-notation.test.ts`, `swipe-direction.test.ts`, `timer-*.test.ts`, `trail-positions.test.ts` | Pure UI logic |
| Persistence | `storage.test.ts`, `idb-storage.test.ts`, `session-persistence.test.ts`, `progress.test.ts`, `progress-sync.test.ts`, `optimal-cache.test.ts`, `persistence-health.test.ts`, `app-data-reset.test.ts` | All storage layers |
| Puzzle | `puzzle-generator.test.ts`, `puzzle-route.test.ts` | Generator, URL parsing |

### Performance Tests (`tests/performance/`)
- `sokomind-solver-huge.test.ts`: Grand Hall in 3 orientations (base, mirrored,
  rotated). Checks deterministic 1,010 moves / 316 pushes + rewrite phase.
- `sokomind-solver-multi.test.ts`: Multi-puzzle performance suite.

### E2E Tests (`tests/e2e/` — 13 spec files)
Playwright tests covering: app loading, editor, mobile, navigation,
persistence, progress, solver, visual layout, service worker, accessibility
(axe), error recovery.

### Test Support
- `tests/support/child-process-gate.ts`: Isolation helper for benchmark tests
- `tests/support/memory-indexeddb.ts`: In-memory IndexedDB mock

### Coverage Thresholds
| Tier | Lines | Statements | Functions | Branches |
|------|-------|------------|-----------|----------|
| c8 broad | 58% | 58% | 80% | 78% |
| Native focused | 92% | — | 93% | 84% |
| Engine | 41% | — | 56% | 63% |

---

## 12. Scripts & Tooling

| Script | Purpose |
|--------|---------|
| `benchmark-sokomind-solver.ts` | JSON Lines benchmark for hard/master corpus |
| `benchmark-solver-v2.ts` | V2 benchmark with child-process isolation, schema v2 |
| `fill-advanced.ts` | Fill advanced difficulty tier with puzzles |
| `fix-generated-ids.ts` | Fix puzzle ID formatting |
| `generate-catalog-puzzles.ts` | Generate catalog from puzzle sources |
| `generate-hard-puzzles.ts` | Generate hard difficulty puzzles |
| `generate-tier.ts` | Generate puzzles for a specific tier |
| `merge-tiers.ts` | Merge tier-specific catalogs |
| `prepare-imported-puzzles.ts` | Process imported puzzle collections |
| `slurm-solver-v2-tests.sh` | SLURM job script for V2 tests on Waterfield |
| `validate-catalog.ts` | Validate catalog integrity |

---

## 13. Deployment & CI/CD

### GitHub Actions (`.github/workflows/deploy-pages.yml`)
- Triggers on push to `main`
- Steps: checkout → Node setup → install → typecheck → lint → test → build →
  deploy to GitHub Pages
- Uses `actions/deploy-pages` with `dist/` artifact
- Accepts `PUBLIC_SITE_URL` repository variable

### Dependabot (`.github/dependabot.yml`)
Automated dependency updates for npm packages.

### Service Worker
- Precaches shell resources (index.html, icons, manifest)
- Runtime-caches solver workers, puzzle shards, dialogs
- Revision-stamped for cache invalidation
- Registration failure is non-blocking (PWA is enhancement)

---

## 14. Remaining Work Items

Four deferred items from the 55-item audit:

### Q8: Tunnel Macros, Goal Macros, and Corral Detection
- **What**: Add tunnel macros (skip corridor intermediates), goal room macros
  (force entry ordering), and corral pruning to classic A*/IDA*
- **Impact**: 30-60% node reduction on corridor puzzles; the Sokomind engine
  already has these but classic solvers do not
- **Estimated**: 700-950 lines across 5 files

### P1: Extreme Difficulty Skew
- **What**: 97% of puzzles are intermediate/advanced (Boxoban). Tails have
  almost nothing.
- **Fix**: Import Sasquatch, du Peloux, XSokoban, etc. (500-700 puzzles)

### P2: Boxoban Homogeneity
- **What**: 93% of puzzles are exactly 10×10 with 4 boxes
- **Fix**: Same imports as P1 + subsample Boxoban

### P6: No Labeled-Box Imported Puzzles
- **What**: Only 15 canonical puzzles use typed boxes (0.7% of catalog)
- **Fix**: Label-injection post-processor on generic puzzles

---

## 15. File Index

### Source Files (by directory)

```
src/
├── main.tsx                          # Composition root
├── App.tsx                           # Route-based page rendering
├── AppShell.tsx                      # Layout shell
├── styles/globals.css                # Global CSS + theme variables
├── core/
│   ├── index.ts                      # Barrel export
│   ├── model.ts                      # All domain types (170 lines)
│   ├── position.ts                   # Coordinate utilities (49 lines)
│   ├── puzzle.ts                     # Parsing + validation (327 lines)
│   ├── game-session.ts               # Immutable state machine (333 lines)
│   ├── action-log.ts                 # U/D/L/R encoding (111 lines)
│   └── replay.ts                     # Action log replay (78 lines)
├── catalog/
│   ├── catalog-types.ts              # Catalog entry types
│   ├── catalog-validation.ts         # Integrity validation
│   ├── configure-vite-puzzle-loader.ts
│   ├── generated-puzzles.json        # Full catalog (2,194 puzzles)
│   ├── puzzle-loader.ts              # Async shard loader
│   ├── puzzle-metadata.json          # Compact metadata index
│   ├── puzzle-metadata.ts            # Metadata accessor
│   ├── puzzle-shards/                # 42 shard files (50 puzzles each)
│   └── puzzles.ts                    # Static definitions
├── solver/
│   ├── index.ts                      # Barrel export
│   ├── contracts.ts                  # SolverAdapter interface (170 lines)
│   ├── protocol.ts                   # Worker message types
│   ├── cancellation.ts               # AbortSignal handling
│   ├── compatibility.ts              # Adapter compat checks
│   ├── deadlock-bridge.ts            # Game → solver bridge
│   ├── default-registry.ts           # Default solver registry
│   ├── registry.ts                   # SolverRegistry class
│   ├── solver.worker.ts              # Worker entry point
│   ├── validation.ts                 # Objective scoring
│   ├── verification.ts               # Independent solution verification
│   ├── worker-client.ts              # Main-thread worker client
│   ├── worker-host.ts                # Worker-side host
│   ├── search/
│   │   ├── assignment.ts             # Hungarian algorithm (145 lines)
│   │   ├── compiled-board.ts         # Dense board geometry (259 lines)
│   │   ├── deadlocks.ts              # 3 deadlock detectors (183 lines)
│   │   ├── engine.ts                 # Classic DFS/Greedy/A* (945 lines)
│   │   ├── heuristic.ts              # Assignment heuristic (201 lines)
│   │   ├── ida-star.ts               # IDA* search (1034 lines)
│   │   ├── model.ts                  # DenseBox, Zobrist (161 lines)
│   │   ├── priority-queue.ts         # Stable min-heap (125 lines)
│   │   └── reachability.ts           # Keeper BFS (176 lines)
│   └── implementations/
│       ├── index.ts                  # Barrel
│       ├── classic-solvers.ts        # 4 classic adapters
│       ├── sokomind-solver.ts        # Production solver (2400 lines)
│       ├── sokomind-tuning.ts        # 21 tunable parameters (228 lines)
│       └── sokomind-engine/
│           ├── README.md
│           ├── engine-protocol.ts    # Nested worker protocol
│           ├── engine.generated.d.ts # Generated type declarations
│           ├── engine.generated.js   # Generated engine bundle
│           ├── sokomind-engine.worker.ts  # Nested worker entry
│           └── source/              # Original engine modules
│               ├── analysis.js
│               ├── board.js
│               ├── deadlock.js
│               ├── heuristic.js
│               ├── memo.js
│               ├── metrics.js
│               ├── push-generation.js
│               ├── solver-search.js
│               ├── state.js
│               └── topology.js
├── features/
│   ├── editor/                       # 7 files
│   ├── editor-page/                  # 2 files
│   ├── experience/                   # 14 files
│   ├── game/                         # 21 files
│   ├── generator/                    # 8 files
│   ├── help/                         # 2 files
│   ├── home/                         # 2 files
│   ├── play/                         # 6 files
│   ├── progress/                     # 3 files
│   ├── selector/                     # 8 files
│   └── solver/                       # 8 files
├── shared/
│   ├── app-data-reset.ts
│   ├── idb-storage.ts
│   ├── optimal-cache.ts
│   ├── persistence-health.ts
│   ├── progress-sync.ts
│   ├── progress.ts
│   ├── session-persistence.ts
│   ├── storage.ts
│   ├── sw-update-store.ts
│   ├── use-stored-progress.ts
│   └── ui/                           # 10 files (5 TSX + 5 CSS)
└── router/                           # 8 files
```

### Test Files (53 total)
- `tests/unit/` — 47 test files
- `tests/e2e/` — 13 spec files
- `tests/performance/` — 2 test files
- `tests/support/` — 2 support files
- `tests/fixtures/solver-v2/` — 2 fixture files

### Documentation (12 files in `docs/`)
- architecture.md, deployment.md, experience.md, persistence-and-sharing.md,
  puzzle-format.md, sokomind-follow-up-audit.md, sokomind-project-memory.md,
  solver-integration.md, solver-v2-benchmarks.md, solver-v2-progress.md,
  solver-v2-spec.md, testing.md

---

*End of complete project analysis.*
