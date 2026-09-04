# Sokomind Solver V2

> Historical reference. For current behavior, start with the [project reference](../PROJECT-REFERENCE.md).

> Implementation note (August 11, 2026): this is the original design
> specification, not a completion report. Current behavior and audited
> deviations are recorded in `docs/solver-v2-progress.md`. In particular,
> goal-depth macro pruning is disabled, and the proposed local-room,
> local-corral, doorway-crossing, and generic registry scaffolds were removed
> after they failed the proof-and-unique-benefit acceptance bar.

## Anytime Optimality, Search Quality, Memory Efficiency, and Performance Plan

## 1. Mission

Refine the existing Sokomind Solver into a three-mode solver system that can:

1. Continue returning strong solutions quickly in interactive play.
2. Improve solution quality beyond the first discovered route.
3. Prove move optimality whenever exact search completes.
4. Report an honest lower bound and optimality gap when proof does not complete.
5. Use memory substantially more efficiently.
6. Reduce repeated computation in search hot loops.
7. Scale from compact puzzles through 17–30-box puzzles.
8. Run deterministically when requested.
9. Preserve all existing typed-box and generic-box rules.
10. Preserve replay verification as the final authority.
11. Preserve the current production solver’s conservative hard-pruning discipline.
12. Support browser execution and a later Node/HPC proof runner.

This project is a solver refinement. It must not modify the puzzle generator or regenerate the puzzle catalog.

---

# 2. Authoritative Architectural Decisions

The following decisions are final and must not be redesigned during implementation.

## 2.1 Preserve the current Sokomind discovery portfolio

The existing production portfolio remains the basis of fast first-solution discovery.

It continues to use:

* Structural analysis
* Prepared-board reuse
* Structural plan-macro beam search
* Guided direct search
* Bidirectional search
* Typed assignment
* Rooms, tunnels, and doorway reasoning
* Support dependencies
* Goal commitments
* Local room and corral analysis
* Conservative deadlock pruning
* Bounded solution-window rewriting
* Classic Greedy compatibility fallback
* Independent replay verification

Do not replace this portfolio with one monolithic A* search.

## 2.2 Add an exact proof layer

Optimality proof must be handled by a separate exact move-cost search layer.

The exact layer must:

* Minimize total moves, not pushes.
* Use exact robot position in state identity.
* Use a collision-free state identity.
* Use only admissible heuristics in `f = g + h`.
* Permit state reopening.
* Use an existing verified solution as an upper bound.
* Continue until the lower bound reaches the incumbent cost.
* Report `optimality: "proven"` only after complete proof.
* Return the best known solution with a gap when interrupted.

## 2.3 Separate proof heuristics from ordering heuristics

Every heuristic or structural signal must belong to exactly one category.

### Proof heuristic

A proof heuristic:

* Is mathematically admissible for total move cost.
* May participate in `f = g + h`.
* Must have exhaustive small-state tests.
* Must never exceed the exact remaining move cost.

### Ordering heuristic

An ordering heuristic:

* May be aggressive.
* May use topology, congestion, relevance, evacuation, dependencies, or learned weights.
* May break ties or order successors.
* May not increase the proof `f` value.
* May not justify pruning in exact mode.

No heuristic may silently migrate from ordering to proof use.

## 2.4 Preserve hard-pruning discipline

A new hard prune may be introduced only when:

1. It has a written soundness argument.
2. It has an independent oracle test family.
3. It passes exhaustive differential tests on small states.
4. It is registered by name.
5. Failure of the local analysis is treated as “unknown,” not as a deadlock.

## 2.5 Preserve generated-engine source discipline

Never edit:

```text
src/solver/implementations/sokomind-engine/engine.generated.js
```

directly.

Edit files under:

```text
src/solver/implementations/sokomind-engine/source/
```

and regenerate with:

```text
npm run prepare:sokomind-solver
```

Then validate with:

```text
npm run check:sokomind-solver
```

---

# 3. Correctness Problems to Resolve Before New Optimality Claims

## 3.1 Replace hash-only classic state identity

The classic search currently uses a two-part deterministic Zobrist fingerprint as its complete duplicate key.

That is practically collision-resistant but not collision-free.

A solver cannot claim a mathematical optimality guarantee when a hash collision could merge two different states.

### Required replacement

Create a collision-free packed identity using:

* Dense floor cell IDs
* Stable label IDs
* Sorted typed box tokens
* Exact robot cell

Each box token is:

```text
token = labelId × cellCount + cellId
```

Let:

```text
tokenBits = ceil(log2(labelCount × cellCount))
cellBits = ceil(log2(cellCount))
```

Pack the sorted tokens into a `BigInt`.

The final exact move-state identity is:

```text
exactStateIdentity =
    (packedBoxIdentity << cellBits)
    | robotCell
```

Prepend the box count to the packed box identity even though box count is fixed within one puzzle. This makes the encoding independently unambiguous.

### Rules

* Exact A* and exact IDA* must use this `BigInt` identity.
* Hashes may remain as optional lookup accelerators.
* Hash equality must never substitute for exact equality.
* Same-label boxes remain interchangeable because typed tokens are sorted.
* Different labels remain distinguishable because the label ID is part of the token.
* The robot’s exact cell is included for total-move optimality.

## 3.2 Correct the first-push walk lower bound

The current classic IDA* walk lower bound excludes boxes already on matching goals.

That is not generally safe. A valid optimal solution can require moving a correctly placed box first.

### Required safe bound

Replace the current function with two explicitly named bounds.

#### Cheap insertion bound

```ts
minimumManhattanWalkToPotentialPush(...)
```

It must:

* Consider every box, including boxes on matching goals.
* Consider each direction for which the support and destination are floor cells.
* Preferably reject a destination currently occupied by another box.
* Ignore walls along the robot path and therefore remain a lower bound.
* Return the minimum Manhattan distance from the robot to any candidate support cell.
* Return zero for a solved state.
* Return zero rather than an unsafe positive value when uncertain.

#### Exact expansion bound

```ts
minimumReachableWalkToLegalPush(...)
```

It must:

* Reuse the exact keeper BFS calculated for node expansion.
* Consider every legal push.
* Include boxes currently on matching goals.
* Return the minimum exact keeper distance to a legal push support cell.
* Return positive infinity when the state is unsolved and has no legal push.
* Never perform a second keeper flood for the same node.

### Proof heuristic

The initial move lower bound is:

```text
h = typedAssignmentPushLowerBound
  + minimumManhattanWalkToPotentialPush
```

At node expansion, the stronger bound may be used:

```text
hExpanded = typedAssignmentPushLowerBound
          + minimumReachableWalkToLegalPush
```

The expanded bound may prune the node against the incumbent.

It must not cause a second BFS.

---

# 4. Target Solver Modes

The production adapter must support three modes.

```ts
type SokomindMode = "fast" | "quality" | "optimal";
```

The mode must be selected through the existing JSON-safe request options.

Use this exact namespace:

```ts
request.options?.["sokomind-solver"]
```

Create a typed parser in:

```text
src/solver/implementations/sokomind-options.ts
```

Unknown properties must be rejected.

## 4.1 Fast mode

Fast mode preserves current interactive behavior.

It must:

* Use the existing first-solution portfolio.
* Return the first replay-verified strong solution.
* Optionally run the current bounded rewrite.
* Make no optimality guarantee.
* Preserve current browser-oriented latency.
* Remain the default mode unless the UI explicitly chooses another.

## 4.2 Quality mode

Quality mode seeks a better route without requiring complete proof.

It must:

1. Run the discovery portfolio.
2. Retain up to four diverse verified incumbents.
3. Permit a short solution-harvest grace period after the first solution.
4. Rewrite the best three distinct incumbents.
5. Run an incumbent-bounded global move search.
6. Return the shortest replay-verified route.
7. Report a lower bound when the bounded exact search produced one.
8. Never claim optimality unless proof accidentally completes.

## 4.3 Optimal mode

Optimal mode must:

1. Find a verified incumbent through the fast or quality pipeline.
2. Start exact move proof using that incumbent as an upper bound.
3. Improve the incumbent whenever an exact search finds a shorter route.
4. Continue until:

   * The lower bound reaches the upper bound, or
   * A resource limit is reached.
5. Report:

   * The best route
   * Lower bound
   * Upper bound
   * Gap
   * Proof algorithm
   * Whether the result is proven optimal

On a cutoff with a valid incumbent, return `status: "solved"` with bounded proof metadata. Do not discard the incumbent and return `unsolved`.

---

# 5. Request Options

Create this exact request-options model:

```ts
export interface SokomindRequestOptions {
  readonly mode: "fast" | "quality" | "optimal";
  readonly proofAlgorithm: "auto" | "astar" | "ida-star";
  readonly deterministic: boolean;
  readonly maximumIncumbents: number;
  readonly harvestElapsedMs: number;
  readonly proofParallelism: number;
  readonly idaReachabilitySnapshots: "all" | "periodic" | "none";
  readonly idaSnapshotPeriod: number;
}
```

Defaults:

```ts
const DEFAULT_SOKOMIND_REQUEST_OPTIONS = {
  mode: "fast",
  proofAlgorithm: "auto",
  deterministic: false,
  maximumIncumbents: 4,
  harvestElapsedMs: 5_000,
  proofParallelism: 1,
  idaReachabilitySnapshots: "periodic",
  idaSnapshotPeriod: 4,
};
```

Validation ranges:

* `maximumIncumbents`: integer, 1–8
* `harvestElapsedMs`: integer, 0–30,000
* `proofParallelism`: integer, 1–32
* `idaSnapshotPeriod`: integer, 1–64

Deterministic mode must:

* Use one discovery worker unless the lanes are executed in a fixed non-racing schedule.
* Use deterministic tie-breaking.
* Disable timing-based winner selection.
* Use fixed algorithm order.
* Produce the same solution and core search counters under identical inputs and limits.

---

# 6. Public Proof Contract

Extend `src/solver/contracts.ts`.

## 6.1 Proof types

Add:

```ts
export type SolverProofKind =
  | "bounded"
  | "optimal"
  | "unsolvable";

export type SolverProofAlgorithm =
  | "move-astar"
  | "move-ida-star"
  | "parallel-move-astar"
  | "parallel-move-ida-star";

export interface SolverProof {
  readonly objective: SolverObjective;
  readonly kind: SolverProofKind;
  readonly lowerBound?: number;
  readonly upperBound?: number;
  readonly gap?: number;
  readonly algorithm: SolverProofAlgorithm;
}
```

## 6.2 Proof invariants

### Bounded solved result

Must satisfy:

```text
0 ≤ lowerBound ≤ upperBound
upperBound = solution.moves
gap = upperBound − lowerBound
```

### Optimal solved result

Must satisfy:

```text
lowerBound = upperBound = solution.moves
gap = 0
solution.optimality = "proven"
```

### Proven unsolvable result

Must satisfy:

* `kind = "unsolvable"`
* No upper bound
* No solution
* Exact search frontier or contour space was completely exhausted
* No bounded or heuristic-only search may produce this result

## 6.3 Result shape

Add optional `proof` to every `SolverResult` variant.

For solved results:

```ts
{
  status: "solved";
  solution: SolverSolution;
  metrics: SolverRunMetrics;
  proof?: SolverProof;
}
```

For exact exhausted unsolvable results:

```ts
{
  status: "unsolved";
  reason: "exhausted";
  metrics: SolverRunMetrics;
  proof: {
    objective: { kind: "moves" };
    kind: "unsolvable";
    algorithm: ...;
  };
}
```

## 6.4 Progress

Add:

```ts
"proving"
```

to `SolverPhase`.

Extend progress with:

```ts
readonly lowerBound?: number;
readonly upperBound?: number;
readonly gap?: number;
```

Progress invariants must be validated.

* Lower bound may only stay the same or increase within one exact run.
* Upper bound may only stay the same or decrease.
* Gap may only stay the same or decrease.
* `fraction` must not be invented unless a meaningful finite calculation exists.

## 6.5 Compatibility

Retain:

```ts
optimality: "unknown" | "proven"
```

for existing callers.

Derive it from proof state:

* `proof.kind === "optimal"` → `"proven"`
* Otherwise → `"unknown"`

---

# 7. Exact State Codec

Create:

```text
src/solver/search/exact-state.ts
```

## 7.1 Required interface

```ts
export interface ExactStateCodec {
  readonly cellBits: number;
  readonly tokenBits: number;
  readonly labelCount: number;   // distinct label types (for token encoding)
  readonly cellCount: number;    // total board cells (for cell-index sizing)

  tokensFromBoxes(
    boxes: readonly DenseBox[],
  ): Uint32Array;

  packBoxTokens(
    sortedTokens: ArrayLike<number>,
  ): bigint;

  packMoveState(
    robotCell: number,
    sortedTokens: ArrayLike<number>,
  ): bigint;

  decodeTokensForTest(
    identity: bigint,
  ): readonly number[];
}
```

> **Rationale:** The codec needs `labelCount` (number of distinct label types) to
> determine the token vocabulary size for encoding, and `cellCount` to size
> cell-index fields. The raw box count is derivable and not directly consumed by
> the codec interface.

## 7.2 Encoding requirements

* Tokens must be sorted numerically.
* Numeric token sorting must preserve typed-label grouping.
* No floating-point bitwise operation may truncate token values.
* Validate that token values fit within `tokenBits`.
* Validate that robot cell fits within `cellBits`.
* Handle one-cell boards.
* Handle up to 30 boxes.
* Handle every supported typed label.
* Support repeated labels.
* Provide round-trip tests.
* Provide collision-exhaustion tests over all states in tiny fixtures.

## 7.3 Zobrist usage

The existing Zobrist implementation may remain for:

* Non-proof search
* Diagnostic hashing
* Fast transposition bucket selection

It must not be used as the sole equality key in an optimal solver.

---

# 8. Exact Move A* Specification

Create:

```text
src/solver/search/exact-move-astar.ts
```

Classic A* must be refactored to call this implementation.

## 8.1 Search cost

Each macro edge consists of:

```text
exact shortest keeper walk to support
+ one push
```

The edge cost is:

```text
walk length + 1
```

The accumulated `g` is total moves.

Push count is retained only as a route statistic and optional tie-breaker.

## 8.2 State identity

Use:

```text
exact robot cell + collision-free typed box identity
```

Do not canonicalize the robot to its reachable region in move-optimal search.

## 8.3 Heuristic

Initial implementation:

```text
h = typed assignment push lower bound
  + safe first-push walk lower bound
```

No production topology weight may be included in `h`.

Ordering-only tie-breaks may include:

1. Lower assignment cost
2. Greater number of correctly placed boxes
3. Lower topology penalty
4. Lower push count
5. Stable insertion sequence

These tie-breaks must not affect `f`.

## 8.4 Open and best-cost handling

Use:

* A stable minimum heap
* `Map<bigint, number>` for best known `g`
* No permanent closed-set rule that prevents reopening
* Stale-node skipping on pop

A popped node is stale when:

```text
node.g !== bestG.get(node.identity)
```

A child is retained only when:

```text
child.g < previousBestG
```

This supports inconsistent but admissible heuristics safely.

## 8.5 Incumbent handling

The exact search accepts an optional verified incumbent.

```ts
interface ExactIncumbent {
  readonly solution: SolverSolution;
  readonly cost: number;
}
```

Set:

```text
U = incumbent.moves
```

If no incumbent exists:

```text
U = Infinity
```

Prune any node or child satisfying:

```text
g + h >= U
```

because the exact phase seeks only a route strictly shorter than the current incumbent.

When a goal with `g < U` is found:

1. Reconstruct the route.
2. Replay-verify it.
3. Replace the incumbent.
4. Set `U = g`.
5. Continue search.

## 8.6 Proof condition

Let:

```text
L = minimum f value in OPEN
```

The incumbent is proven optimal when:

```text
L >= U
```

If OPEN becomes empty:

* With an incumbent: the incumbent is optimal.
* Without an incumbent: the puzzle is unsolvable.

Do not terminate merely because the first goal is popped unless the same proof condition is met.

## 8.7 Cutoff result

On time, state, generated-state, memory, or cancellation cutoff:

* Preserve the incumbent.
* Compute the best valid lower bound available.
* Return bounded proof metadata when an incumbent exists.
* Return an unsolved result with a lower-bound metric when no incumbent exists.
* Never set `optimality: "proven"`.

---

# 9. Exact Move IDA* Specification

Refactor:

```text
src/solver/search/ida-star.ts
```

Do not maintain a separate contradictory proof model.

## 9.1 Identity

Use the same collision-free exact state codec as A*.

## 9.2 Heuristic

Use the corrected safe move lower bound.

Do not exclude boxes merely because they are on matching goals.

## 9.3 Upper bound

Accept an incumbent `U`.

Prune when:

```text
g + h >= U
```

If a shorter goal is found:

* Reconstruct
* Verify
* Lower `U`
* Continue proof as required

## 9.4 Contour proof

For a contour threshold `T`:

* Exhaustively search every exact state with `f <= T`.
* Record the minimum exceeded `f` as the next threshold.
* Do not carry unsafe dominance conclusions across incomplete contours.

The current implementation clears the transposition table each iteration. Preserve that behavior unless a formally correct contour-aware persistent scheme is separately proven.

## 9.5 Lower bound

Maintain:

```text
lastExhaustedThreshold
currentThreshold
```

While searching an incomplete contour, the valid lower bound is the current threshold only when all lower thresholds have been exhausted.

On cutoff, report the strongest completed lower bound.

## 9.6 Reachability snapshot policies

Implement:

### All

Save every frame’s reachability snapshot.

* Fastest resumes
* Highest memory

### Periodic

Save snapshots only when:

```text
depth % snapshotPeriod === 0
```

Recompute reachability when resuming unsnapshotted frames.

### None

Save no reachability snapshots.

Recompute on every resumed frame.

Default:

```text
periodic, period 4
```

All three modes must return identical optimal solutions and proof results.

## 9.7 Automatic proof algorithm selection

When `proofAlgorithm === "auto"`, use this exact initial policy:

```text
If maxMemoryBytes is defined and < 768 MiB:
    use IDA*

Else if boxCount <= 8 and floorCount <= 96:
    use A*

Else:
    use IDA*
```

Do not alter this policy during implementation based on intuition. Future benchmark data may change it in a separate reviewed commit.

---

# 10. Compact Exact-Search Arena

Create:

```text
src/solver/search/compact-node-arena.ts
```

Do not initially rewrite the production engine’s state arena. First use the new arena for exact A*.

## 10.1 Storage

Use chunked typed arrays.

Required fields:

```text
robotCell
gMoves
pushes
parentNode
pushedFromCell
pushDirection
boxTokenOffset
heuristic
```

FIFO tie-breaking (insertion sequence) is required but is managed internally by
`NumericPriorityQueue` via its `#sequences` array, not stored in the arena.
This avoids wasting arena memory on a value only the priority queue consumes.

Use:

* `Uint16Array` where the proven maximum permits it
* Otherwise `Uint32Array`
* `Int32Array` for parent indices
* `Uint8Array` for directions
* `Float64Array` only when integer storage is insufficient

Box tokens must be stored in flattened chunked `Uint32Array` storage.

## 10.2 No per-node object graph

The exact A* hot path must not allocate:

* A `SearchNode` object per retained node
* A `DenseBox` object per box per node
* A string key per state
* A push descriptor object per child

Temporary expansion objects may be used only outside measured hot loops.

## 10.3 Reconstruction

Reconstruct by following:

```text
parentNode
pushedFromCell
pushDirection
```

For each macro:

1. Materialize the parent box layout.
2. Run keeper BFS.
3. Recover a deterministic shortest walk to the support cell.
4. Append the push.
5. Verify final route.

## 10.4 Superseded nodes

Superseded arena nodes may remain allocated in the initial compact implementation.

Do not add complex reclamation until benchmarks show it is necessary.

A later optional compaction pass may retain only:

* Current best node per identity
* Ancestors of current best nodes
* Incumbent route ancestors
* OPEN nodes

That compaction is not part of the first arena sprint.

---

# 11. Immediate Search-Hot-Loop Optimizations

These changes must occur before large architectural optimization.

## 11.1 Remove unnecessary A* child floods

Current classic search calculates child keeper reachability even though A* identity uses the exact post-push robot cell.

For A*:

* Do not flood the child when generating it.
* Set child robot cell to the source cell vacated by the pushed box.
* Flood only when the child is actually expanded.

For DFS and Greedy:

* Continue to calculate the child reachable-region canonical cell when needed.

Acceptance metric:

```text
classic A* reachabilityFloods
approximately equals expandedStates
rather than generated accepted children
```

## 11.2 Perform assignment infeasibility before nonessential child flood

For first-found searches:

1. Apply static deadlock checks.
2. Apply dynamic deadlock checks.
3. Evaluate typed assignment.
4. Reject infinite assignment.
5. Only then calculate child reachable-region identity.

## 11.3 Reuse reconstruction buffers

During route reconstruction:

* Reuse occupancy arrays.
* Reuse keeper BFS workspaces.
* Do not allocate a new occupancy array for every push.

## 11.4 Avoid unnecessary sorted copies

Where box arrays are already sorted:

* Do not call a general sort.
* Update the moved box by ordered removal/reinsertion.
* Assert sortedness in development and tests.

---

# 12. Incremental Typed Assignment

Port the reviewed incremental assignment approach from the production engine into typed exact search.

Create or extend:

```text
src/solver/search/assignment.ts
src/solver/search/heuristic.ts
```

## 12.1 Required behavior

When one box moves:

* Reuse all unchanged label groups.
* Reuse unchanged cost rows.
* Recompute only the moved box’s cost row.
* Repair the previous Hungarian assignment when safe.
* Fall back to complete Hungarian calculation when repair is not appropriate.
* Return exactly the same assignment cost as full recomputation.

## 12.2 Caching

Cache by collision-free box identity.

Cache entries may contain:

* Total assignment cost
* Matching columns by label
* Optional Hungarian potentials
* Per-label cost structure

Use a bounded cache.

Eviction may cause recomputation but must not affect correctness.

## 12.3 Crossover

Use the production engine’s current crossover policy as the initial value:

```text
INCREMENTAL_ASSIGNMENT_CROSSOVER = 3
```

Do not tune it during the implementation sprint.

## 12.4 Verification

For randomized box moves:

```text
incrementalCost === fullHungarianCost
```

must hold exactly.

Test:

* Unique labels
* Repeated labels
* Generic boxes
* Mixed labels
* Impossible assignments
* Boxes moving onto and off matching goals

---

# 13. Stronger Admissible Heuristics

Create:

```text
src/solver/search/proof-heuristics.ts
```

Do not port every production heuristic at once.

## 13.1 Initial proof heuristic set

Phase one:

* Typed assignment push lower bound
* Corrected first-push walk lower bound

Phase two candidates, only after oracle and unique-benefit tests:

* Exact disjoint room-pattern lower bounds
* Exact pair-conflict lower bounds

The local-room, local-corral, and doorway-crossing prototypes were later
rejected and removed. Room/corral variants lacked a complete global
box-exchange proof, while the doorway bound was dominated by typed assignment.

## 13.2 Combination rules

The default safe combination is:

```text
max(componentLowerBounds)
```

Use addition only when:

* Domains are disjoint, or
* Costs have an explicit cost partition, or
* A written proof establishes no double counting.

## 13.3 Registry

Every proof heuristic must register:

```ts
interface ProofHeuristicRegistration {
  readonly id: string;
  readonly objective: "moves";
  readonly proofFamily: string;
  readonly evaluate: ...;
}
```

The registry must distinguish it from ordering-only heuristics.

## 13.4 Exhaustive oracle

For each tiny reachable state:

```text
heuristic(state) <= exactRemainingMoves(state)
```

must hold.

Any failing heuristic is disabled from proof mode immediately.

---

# 14. Porting Exact Production Pruning

The classic exact search currently uses fewer hard proofs than the production engine.

Port only proof-safe mechanisms.

Initial candidates:

1. Exact sealed-corral deadlocks
2. Exact closed local-room deadlocks
3. Exact closed local-corral deadlocks
4. Exact bounded pattern deadlocks
5. Proven goal commitments
6. Forced global-push macros

Do not port as hard prunes:

* Topology scores
* Evacuation penalties
* Relevance
* Doorway preferences
* Congestion
* Guessed PI corrals
* Incomplete local analyses
* Conditional goal commitments
* Weighted heuristic recommendations

Each port must be one focused commit with its own oracle family.

---

# 15. Production Engine State Efficiency

After the exact layer is stable, optimize the production engine’s state path.

Modify:

```text
src/solver/implementations/sokomind-engine/source/state.js
```

## 15.1 Incremental Zobrist update

When one box moves:

```text
childHash =
  parentHash
  XOR hash(oldToken)
  XOR hash(newToken)
```

Do not recalculate the Zobrist fingerprint across every box.

## 15.2 Ordered token update

Maintain sorted canonical tokens by:

1. Removing the old token.
2. Finding the insertion position for the new token.
3. Inserting it.

Do not sort a fresh token array on every child.

## 15.3 Separate retained identity from expansion workspace

A retained state should not always own:

* Full `indexByCell`
* Full occupancy bitset
* Full derived layout arrays

Where safe:

* Store canonical tokens with the state.
* Materialize occupancy in reusable expansion workspaces.
* Retain full layout only for active beam layers or cache hits that justify it.

Do not perform this refactor in the same sprint as exact A* correctness work.

## 15.4 Cache policy

Replace delete-and-reinsert `Map` LRU behavior in the hottest caches with a fixed-capacity policy.

Initial replacement:

* Clock replacement or generational replacement
* Numeric or `BigInt` keys where possible
* Fixed maximum entries
* No iterator allocation on every eviction
* Search-depth-preferred replacement for transposition data

Eviction may only reduce performance, never change pruning correctness.

---

# 16. Solution Quality Improvements

## 16.1 Incumbent collection

During Quality and Optimal modes, do not terminate every discovery lane immediately after the first accepted route.

After the first solution:

```text
harvest duration =
  min(configured harvestElapsedMs,
      10% of original finite request time)
```

Minimum finite harvest:

```text
500 ms
```

Maximum default harvest:

```text
5,000 ms
```

Retain at most:

```text
maximumIncumbents
```

verified routes.

## 16.2 Diversity signature

Deduplicate incumbents using:

* Move count
* Push count
* Ordered push-chain signature
* Room-transition sequence (deferred — the engine tracks `strategicHistory` internally but does not propagate it through the solution contract)
* Box-goal assignment signature

Prefer structurally different routes over nearly identical routes.

## 16.3 Rewrite policy

Rewrite no more than the best three diverse incumbents.

Use the same total rewrite budget currently available. Divide it rather than multiplying it without limit.

Select the final rewritten incumbent by:

1. Lowest moves
2. Lowest pushes
3. Stable discovery order

## 16.4 Global bounded re-search

After local rewriting, run exact move A* or IDA* with the incumbent upper bound.

Bounded re-search and optimality proof share the same `runProof()` /
`runSequentialProof()` / `runConcurrentProof()` infrastructure, differentiated
by mode-specific budget limits rather than being separate mechanisms.

In Quality mode:

* Use only the allocated remaining quality budget.
* Return when the budget ends.
* Keep any improved exact route.
* Report a bound if available.
* Do not require proof.

In Optimal mode:

* Continue until proof or global resource cutoff.

---

# 17. Dynamic Upper-Bound Updates

The first implementation may run discovery and proof sequentially.

After that implementation is correct, add concurrent proof.

## 17.1 Protocol extension

Extend the nested engine or exact-worker protocol with:

```ts
{
  type: "solver/update-upper-bound";
  moves: number;
}
```

The proof worker must:

* Validate the bound.
* Accept only a strictly smaller bound.
* Update `U`.
* Apply the new bound on the next node or contour check.
* Never drop a better verified incumbent.

## 17.2 Concurrent optimal mode

After shared board preparation:

* Start discovery.
* Start exact proof.
* Discovery sends verified incumbent improvements to proof.
* Proof sends shorter exact solutions to the coordinator.
* Coordinator replay-verifies all routes.
* Proof ends only on completion or resource cutoff.

This concurrency is a later sprint. Sequential correctness must exist first.

---

# 18. Parallel Exact Proof

Parallel proof is not ordinary first-solution racing.

## 18.1 Partitioning

Partition by canonical first push.

For every legal first push:

* Calculate its exact shortest support walk.
* Create the resulting state.
* Assign the branch to exactly one proof worker.

A zero-push solved root is handled before partitioning.

## 18.2 Worker responsibility

Each worker proves:

```text
No solution in this partition has cost < U
```

or returns a shorter verified route.

## 18.3 Global proof

Let each worker report lower bound `L_i`.

The global lower bound is:

```text
L = min(L_i)
```

The incumbent is proven optimal when every partition is complete or:

```text
min(L_i) >= U
```

## 18.4 No overlapping partitions

Partition identity must be based on exact first-push state, not only box choice.

Two workers must never claim the same exact prefix partition.

## 18.5 Browser policy

Do not enable parallel exact proof by default in the browser.

Default:

```text
proofParallelism = 1
```

Permit higher values only through explicit options and resource checks.

---

# 19. Node/HPC Runner

After browser integration is stable, create a Node runner.

Suggested files:

```text
scripts/solve-sokomind.ts
scripts/benchmark-sokomind-optimal.ts
scripts/solver-hpc/worker.ts
scripts/solver-hpc/run-array-task.ts
scripts/solver-hpc/aggregate-results.ts
scripts/solver-hpc/slurm/
```

## 19.1 Runtime

Use:

* Node `worker_threads`, or
* Isolated child processes when memory measurement requires process separation

Do not emulate browser workers unnecessarily.

## 19.2 Input

Each job must specify:

* Puzzle ID or puzzle rows
* Solver mode
* Proof algorithm
* Limits
* Parallelism
* Deterministic flag
* Solver version
* Git commit
* Tuning fingerprint

## 19.3 Output

Write immutable JSON Lines records containing:

* Puzzle identity
* Solution
* Verification result
* Lower bound
* Upper bound
* Gap
* Proof status
* Expanded/generated states
* Peak frontier
* Memory
* Per-lane counters
* Runtime
* Configuration
* Commit SHA

## 19.4 Checkpointing

Exact IDA* may support contour checkpoints.

A checkpoint must include:

* Board-content key
* Solver version
* Objective
* Exact-state codec version
* Current threshold
* Last exhausted threshold
* Incumbent
* Partition identity
* Required transposition metadata

Reject incompatible checkpoints.

---

# 20. Benchmark Corpus

Create a permanent solver corpus.

## 20.1 Required fixtures

Include:

1. Every current canonical puzzle
2. Grand Hall
3. Grand Hall mirrored
4. Grand Hall rotated
5. Existing typed master puzzles
6. Microban 145
7. Microban 146
8. Caleb 022
9. Repeated-label puzzles
10. Mixed `X/S` and typed puzzles
11. A solved-box-must-move-first regression
12. An assignment-infeasible state
13. A sealed-corral proof fixture
14. A wide multi-entry-room fixture
15. A loop-heavy fixture
16. A 25–30-box memory fixture
17. The following 17-box hand-designed puzzle:

```ts
[
  "OOOOOOOOOOOOOOO",
  "OaSS   S   SSbO",
  "OSCS  OOO  SDSO",
  "OX X  OOO  X XO",
  "O     OOO     O",
  "OOOO   X   OOOO",
  "O      O      O",
  "O G hOOOOOH g O",
  "O      O      O",
  "OOO         OOO",
  "OOO   X X   OOO",
  "OOOOOOOROOOOOOO",
  "O B X X X X A O",
  "O Sc       dS O",
  "OOOOOOOOOOOOOOO"
]
```

Store benchmark fixtures separately from the shipped catalog when appropriate.

## 20.2 Baseline metrics

Record:

* Status
* Moves
* Pushes
* Optimality
* Lower bound
* Gap
* Elapsed time
* Expanded states
* Generated states
* Reachability floods
* Assignment calls
* Assignment cache hits
* Deadlock prunes
* Infeasible prunes
* Reopens
* Peak frontier
* Peak estimated memory
* Process RSS in Node benchmarks
* Per-lane metrics

## 20.3 Benchmark methodology

* Use isolated processes for memory measurements.
* Perform warm-up runs separately.
* Report median of at least five timed runs for small and medium fixtures.
* Use one isolated run for very large fixtures when necessary.
* Compare identical solver modes and limits.
* Do not use one machine’s milliseconds as a formal correctness gate.
* Use state counts and memory counts as primary stable performance gates.
* Preserve raw JSON benchmark artifacts.

---

# 21. Exhaustive Small-State Oracle

Create:

```text
tests/support/exact-solver-oracle.ts
tests/unit/solver-exact-oracle.test.ts
```

## 21.1 Ground truth

For tiny boards:

* Enumerate full legal game states.
* Search individual robot moves with ordinary BFS.
* Treat every walk and push as cost one.
* Use the real `stepSnapshot()` transition.
* Determine exact remaining move cost.
* Determine unsolvability.

## 21.2 Scope

Use boards small enough for exhaustive enumeration, including:

* Up to approximately 12–16 floor cells
* One or two boxes
* Typed and generic cases
* Boxes on goals
* Repeated labels where practical
* Partial states

## 21.3 Assertions

For every reachable state:

```text
assignmentLowerBound <= exactRemainingMoves
safeWalkLowerBound <= exactRemainingMoves
combinedProofHeuristic <= exactRemainingMoves
exactAStarResult = oracleResult
exactIdaStarResult = oracleResult
```

For unsolvable states:

```text
exact search exhausts
and reports unsolvable
```

## 21.4 Generated regression fixture

Use the oracle to locate and commit at least one minimal state where:

* A box begins on its matching goal.
* Every optimal route begins by moving a box that is currently on a matching goal.

This fixture protects the corrected first-walk bound.

---

# 22. Sprint Plan

Implement only one sprint at a time.

Every sprint ends with:

* Tests
* Benchmark comparison
* Documentation update
* Review subagent report
* One focused commit
* No automatic transition to the next sprint

## Sprint 0 — Baseline and safety documentation

### Files

Create:

```text
docs/archive/solver-v2-spec.md
docs/solver-v2-progress.md
docs/solver-v2-benchmarks.md
scripts/benchmark-solver-v2.ts
tests/fixtures/solver-v2/
```

Update:

```text
docs/solver-integration.md
```

### Work

* Copy this specification into `docs/archive/solver-v2-spec.md`.
* Record current commit and solver versions.
* Add the benchmark corpus.
* Add the 17-box fixture.
* Capture Fast, classic A*, and classic IDA* baselines.
* Record current Grand Hall guardrails.
* Add no intentional search behavior changes.

### Acceptance

* Existing tests pass.
* Baseline artifacts are reproducible.
* No solver result changes.
* No generated catalog changes.

### Commit

```text
docs(solver): establish solver v2 baseline and benchmark corpus
```

## Sprint 1 — Exact identity and optimality correctness

### Files

Create:

```text
src/solver/search/exact-state.ts
tests/unit/solver-exact-state.test.ts
tests/support/exact-solver-oracle.ts
tests/unit/solver-exact-oracle.test.ts
```

Update:

```text
src/solver/search/model.ts
src/solver/search/engine.ts
src/solver/search/ida-star.ts
src/solver/search/heuristic.ts
```

### Work

* Implement collision-free `BigInt` identity.
* Replace classic A* and IDA* hash-only identity.
* Retain Zobrist only for non-proof acceleration.
* Replace the unsafe walk lower bound.
* Add solved-box-first regression.
* Add exhaustive oracle comparisons.
* Do not yet change the production Sokomind adapter.

### Acceptance

* No collision in exhaustive tiny-state identity tests.
* Exact A* matches oracle.
* Exact IDA* matches oracle.
* Every proof heuristic is admissible on oracle states.
* All previous classic-optimal fixtures still pass.

### Commit

```text
fix(solver): harden exact move-search optimality guarantees
```

## Sprint 2 — Low-risk hot-loop performance

### Files

Update:

```text
src/solver/search/engine.ts
src/solver/search/ida-star.ts
src/solver/search/reachability.ts
src/solver/search/heuristic.ts
```

### Work

* Remove child flood from A* generation.
* Evaluate assignment infeasibility before nonessential child flood.
* Reuse reconstruction buffers.
* Remove redundant box sorting.
* Add exact counters for avoided floods.

### Acceptance

* Exact solutions unchanged.
* Oracle results unchanged.
* A* reachability floods fall to approximately one per expanded node.
* Generated/expanded state counts do not increase materially.
* Median exact-search runtime improves on the small/medium corpus.
* No memory regression.

### Commit

```text
perf(solver): remove redundant exact-search reachability work
```

## Sprint 3 — Proof contract and protocol

### Files

Update:

```text
src/solver/contracts.ts
src/solver/validation.ts
src/solver/protocol.ts
src/solver/worker-host.ts
src/solver/worker-client.ts
src/solver/verification.ts
docs/solver-integration.md
```

Create:

```text
src/solver/proof.ts
tests/unit/solver-proof-contract.test.ts
```

### Work

* Add proof structures.
* Add `proving` progress phase.
* Add lower/upper/gap progress.
* Validate proof invariants.
* Preserve backwards-compatible `optimality`.
* Reject malformed worker proof data.
* Ensure replay verification remains mandatory.

### Acceptance

* Old result payloads remain valid.
* Invalid proof combinations are rejected.
* Optimal result requires equal bounds.
* Bounded result requires valid gap.
* Worker host and client both validate proof metadata.

### Commit

```text
feat(solver): add bounded and optimal proof metadata
```

## Sprint 4 — Incumbent-bounded exact move A*

### Files

Create:

```text
src/solver/search/exact-move-astar.ts
src/solver/search/exact-search-types.ts
tests/unit/exact-move-astar.test.ts
```

Update:

```text
src/solver/search/engine.ts
src/solver/implementations/classic-solvers.ts
```

### Work

* Implement exact A* as specified.
* Use incumbent upper bounds.
* Continue after finding a goal.
* Prove when OPEN lower bound reaches incumbent.
* Return bounded result on cutoff.
* Refactor `classic-astar` to use the same engine.

### Acceptance

* Oracle equality.
* Correct lower-bound monotonicity.
* Correct incumbent improvements.
* Correct optimal proof.
* Correct unsolvable proof.
* Cutoff returns incumbent plus gap.
* Classic A* remains move-optimal.

### Commit

```text
feat(solver): add incumbent-bounded exact move A-star proof
```

## Sprint 5 — Corrected move IDA* and memory profiles

### Files

Update:

```text
src/solver/search/ida-star.ts
src/solver/implementations/classic-solvers.ts
```

Create:

```text
tests/unit/exact-move-ida-star.test.ts
```

### Work

* Integrate exact identity.
* Integrate safe heuristic.
* Add incumbent bound.
* Add lower-bound progress.
* Add all/periodic/none reachability snapshot policies.
* Add automatic proof algorithm selection helper.

### Acceptance

* All snapshot policies produce identical proof results.
* Low-memory mode materially lowers estimated peak memory.
* Oracle equality.
* Bound remains valid on interruption.
* IDA* never claims proof from an incomplete contour.

### Commit

```text
feat(solver): add bounded exact move IDA-star proof modes
```

## Sprint 6 — Sokomind modes and sequential proof integration

### Files

Create:

```text
src/solver/implementations/sokomind-options.ts
src/solver/implementations/sokomind-proof.ts
tests/unit/sokomind-modes.test.ts
```

Update:

```text
src/solver/implementations/sokomind-solver.ts
src/solver/implementations/sokomind-tuning.ts
```

### Work

* Add Fast, Quality, and Optimal modes.
* Parse namespaced options.
* Keep Fast default.
* Run discovery first.
* Pass incumbent to exact proof.
* Return bounded result on proof cutoff.
* Return proven optimal when proof completes.
* Do not change UI yet beyond compatibility.

### Acceptance

* Fast mode matches current behavior.
* Quality mode never returns a worse route than Fast under the same completed incumbent set.
* Optimal mode proves small fixtures.
* Optimal cutoff preserves incumbent.
* All returned solutions replay.
* Deterministic mode is repeatable.

### Commit

```text
feat(solver): integrate fast quality and optimal modes
```

## Sprint 7 — Compact exact-search arena

### Files

Create:

```text
src/solver/search/compact-node-arena.ts
src/solver/search/numeric-priority-queue.ts
tests/unit/compact-node-arena.test.ts
```

Update:

```text
src/solver/search/exact-move-astar.ts
```

### Work

* Replace per-node object storage.
* Replace string keys.
* Use typed-array chunks.
* Use numeric heap storage.
* Preserve exact reconstruction.
* Preserve stable tie-breaking.

### Acceptance

* Exact routes and proof results unchanged.
* Estimated retained bytes per node fall by at least 50% on fixed fixtures.
* Process RSS improves on isolated medium/large runs.
* No increase in expanded states.
* No replay regressions.

### Commit

```text
perf(solver): compact exact A-star state and frontier storage
```

## Sprint 8 — Incremental assignment

### Files

Update:

```text
src/solver/search/assignment.ts
src/solver/search/heuristic.ts
src/solver/search/exact-move-astar.ts
src/solver/search/ida-star.ts
```

Create:

```text
tests/unit/incremental-assignment.test.ts
```

### Work

* Port incremental matching.
* Cache matching records.
* Repair one moved row.
* Fall back safely.
* Preserve exact assignment values.

### Acceptance

* Incremental equals full Hungarian on randomized tests.
* Heuristic calls become cheaper on multi-box benchmarks.
* Exact search expands the same states or fewer.
* No admissibility failure.

### Commit

```text
perf(solver): add exact incremental typed assignment repair
```

## Sprint 9 — Proof-safe stronger heuristics and pruning

### Files

Create:

```text
src/solver/search/proof-heuristics.ts
```

Update as required:

```text
src/solver/search/deadlocks.ts
src/solver/search/exact-move-astar.ts
src/solver/search/ida-star.ts
```

### Work

Port one proof family at a time.

Required order:

1. Exact bounded pattern deadlocks
2. Exact sealed corrals
3. Proven goal commitments
4. Disjoint room-pattern lower bounds
5. Pair-conflict lower bounds

Each family gets a separate commit if substantial.

### Acceptance

* Oracle differential tests.
* Written soundness notes.
* No incorrect prune.
* Exact state expansions improve on relevant fixtures.
* Overhead does not regress unrelated small fixtures materially.

### Commit examples

```text
feat(solver): add proof-safe exact pattern deadlocks
feat(solver): add exact sealed-corral pruning
feat(solver): add admissible disjoint room lower bounds
```

## Sprint 10 — Quality-mode incumbent harvesting

### Files

Update:

```text
src/solver/implementations/sokomind-solver.ts
src/solver/implementations/sokomind-proof.ts
```

Create:

```text
src/solver/implementations/sokomind-incumbents.ts
tests/unit/sokomind-incumbents.test.ts
```

### Work

* Harvest up to four incumbents.
* Add diversity signatures.
* Rewrite up to three.
* Add global bounded re-search.
* Preserve total resource ceilings.

### Acceptance

* Fast mode unchanged.
* Quality mode returns equal or fewer moves on benchmark corpus.
* Resource limits remain global.
* No unverified incumbent is retained.
* Nondeterministic races cannot overwrite a shorter incumbent with a longer one.

### Commit

```text
feat(solver): harvest and globally improve diverse incumbents
```

## Sprint 11 — Production engine state efficiency

### Files

Update:

```text
src/solver/implementations/sokomind-engine/source/state.js
src/solver/implementations/sokomind-engine/source/memo.js
src/solver/implementations/sokomind-engine/source/metrics.js
```

Regenerate:

```text
src/solver/implementations/sokomind-engine/engine.generated.js
```

### Work

* Incremental Zobrist.
* Ordered token reinsertion.
* Reduce retained layout duplication.
* Replace hottest LRU mutations.
* Add counters for copies and avoided work.

### Acceptance

* Grand Hall deterministic route unchanged or improved.
* Mixed typed engine tests pass.
* Generated engine check passes.
* Peak RSS improves.
* Generated successors per second improve.
* No hard-pruning behavior changes.

### Commit

```text
perf(solver): reduce production engine state-copy overhead
```

## Sprint 12 — Concurrent and parallel proof

### Files

Create or update:

```text
src/solver/implementations/sokomind-proof-worker.ts
src/solver/implementations/sokomind-proof-protocol.ts
src/solver/implementations/sokomind-solver.ts
```

### Work

* Add dynamic upper-bound messages.
* Run discovery and proof concurrently.
* Add first-push partitioning.
* Aggregate worker lower bounds.
* Preserve exact global proof semantics.

### Acceptance

* One-worker and multi-worker proof return identical optimum.
* Partitions are disjoint and complete.
* Dynamic bound only decreases.
* Global lower bound is correct.
* Worker failure does not produce false proof.
* Cancellation terminates every proof worker.

### Commit

```text
feat(solver): add concurrent and partitioned exact proof
```

## Sprint 13 — Node and Waterfield execution

### Files

Create:

```text
scripts/solve-sokomind.ts
scripts/benchmark-sokomind-optimal.ts
scripts/solver-hpc/*
```

### Work

* Add Node worker execution.
* Add deterministic JSONL output.
* Add checkpoint/resume for IDA*.
* Add job-array-safe input partitions.
* Add aggregate reporting.
* Do not couple this work to the browser UI.

### Acceptance

* Same puzzle/configuration produces the same deterministic proof result in browser-compatible and Node execution.
* Interrupted checkpoints resume correctly.
* Incompatible checkpoints are rejected.
* Per-job output is immutable and independently verifiable.

### Commit

```text
feat(solver): add deterministic Node and HPC proof runner
```

## Sprint 14 — UI, rollout, and final verification

### Work

* Expose Fast, Quality, and Optimal modes.
* Display:

  * Best moves
  * Best pushes
  * Lower bound
  * Gap
  * Proven status
* Preserve simple defaults for ordinary users.
* Update documentation.
* Run complete regression and performance corpus.
* Review all optimality wording.

### Acceptance

* No UI says “optimal” without proof metadata.
* Fast remains default.
* Existing hint behavior is unchanged unless explicitly updated.
* Full build, tests, coverage, browser tests, performance tests, and audit pass.

### Commit

```text
feat(solver): expose solver quality and optimality modes
```

---

# 23. Required Test Commands

At appropriate sprint boundaries run:

```text
npm run check:sokomind-solver
npm run typecheck
npm run lint
npm run test:unit
npm run build
npm run test
npm run test:coverage
npm run test:solver:multi
npm run test:solver:huge
npm run benchmark:solver
```

Add new scripts for:

```text
npm run test:solver:oracle
npm run test:solver:optimal
npm run benchmark:solver:v2
npm run benchmark:solver:memory
```

Do not increase existing timeouts merely to hide a regression.

---

# 24. Performance Gates

Use baseline-relative gates.

## Correctness sprints

* Zero solution-cost regressions
* Zero proof mismatches
* Zero replay failures
* Zero heuristic admissibility violations

## Low-risk optimization sprint

* At least 30% fewer reachability floods on exact A* fixtures that previously generated many accepted children
* No increase in exact expanded states
* No peak-memory regression

## Compact arena sprint

* At least 50% lower estimated retained bytes per exact A* node
* Meaningful process-RSS reduction on isolated medium fixtures
* No route or proof change

## Incremental assignment sprint

* Exact equality with full Hungarian assignment
* Lower assignment computation time on repeated-label and 10+-box fixtures
* No increased state count caused by heuristic inconsistency

## Production state sprint

* Grand Hall result unchanged or improved
* No increase in generated states caused by altered ordering unless justified
* Lower process RSS or higher successor throughput

A performance optimization that increases complexity but produces no measurable corpus benefit should be reverted.

---

# 25. Risk Register

## Risk: False optimality

Prevention:

* Collision-free identity
* Exhaustive oracle
* Admissible heuristic registry
* Exact proof condition
* Replay verification
* No heuristic hard pruning

## Risk: Exact mode consumes browser memory

Prevention:

* IDA* automatic selection
* Snapshot policies
* Compact arena
* Explicit memory ceiling
* Bounded proof return
* Fast mode remains default

## Risk: Stronger heuristic is too expensive

Prevention:

* Per-component timing counters
* Lazy evaluation
* Use stronger heuristic only near incumbent bound
* Benchmark before enabling by default

## Risk: Parallel proof duplicates work

Prevention:

* Exact first-push partitioning
* Stable partition IDs
* Per-partition lower bounds
* No overlapping prefix assignments

## Risk: Production and classic code diverge

Prevention:

* Shared exact state codec
* Shared proof contract
* Shared assignment primitives where practical
* Avoid broad engine rewrites during proof work

## Risk: Generated engine becomes stale

Prevention:

* Never edit generated file
* Run prepare and check scripts
* Keep generated-file test gate

## Risk: Quality mode exceeds global limits

Prevention:

* One run-wide resource ledger
* Rewrite and harvest consume the same global budget
* No phase receives a fresh full budget

## Risk: Deterministic mode is only superficially deterministic

Prevention:

* Single-worker or fixed sequential schedule
* Stable ties
* No wall-clock race winner
* Fixed options fingerprint
* Repeated-result tests

---

# 26. Explicit Prohibitions

Claude must not:

* Mark the existing production Sokomind route optimal.
* Use Zobrist fingerprints as exact proof identity.
* Exclude solved boxes from a first-push lower bound.
* Use weighted A* as an optimality proof.
* Use beam search as an optimality proof.
* Treat push-optimal search as move-optimal.
* Stop exact A* at the first goal without checking the frontier lower bound.
* Use topology scores inside proof `f`.
* Convert incomplete corral analysis into a hard prune.
* Treat timeout as proof.
* Treat a bounded result as unsolvable.
* Discard a verified incumbent when proof times out.
* Edit the generated engine bundle directly.
* weaken replay verification.
* weaken tests.
* increase timeouts without a root-cause explanation.
* regenerate the puzzle catalog.
* combine solver work with generator changes.
* introduce GPU code.
* introduce WebAssembly before typed-array and algorithmic optimization is measured.
* rewrite the entire vendored engine into TypeScript as part of this project.
* implement multiple sprints in one unreviewed change.

---

# 27. Required Root CLAUDE.md Content

Create a root `CLAUDE.md` during Sprint 0 with these instructions:

```text
# Sokomind Solver Engineering Rules

## Game rules

- O is wall.
- R is robot.
- X may only occupy S.
- Only X may occupy S.
- Typed uppercase boxes may only occupy their matching lowercase goals.
- Repeated typed labels are allowed.
- The robot pushes but never pulls during forward play.

## Solver truth rules

- Sokomind fast discovery is bounded, not optimal.
- Only a completed exact move proof may set optimality to proven.
- A timeout is never proof.
- A push optimum is not a move optimum.
- Every returned solution must replay through the core game engine.
- Exact proof must use collision-free state identity.
- Exact move search includes exact robot position.
- Proof heuristics must be admissible.
- Ordering heuristics may not affect proof f-cost.
- Incomplete local analysis is not a deadlock.
- Never use a greedy or weighted result as an exact proof.

## Source rules

- Do not edit engine.generated.js directly.
- Edit sokomind-engine/source and regenerate.
- Do not change the puzzle generator or catalog during solver work.
- Main agent owns code edits.
- Subagents are read-only unless assigned isolated non-overlapping work.

## Test commands

- npm run check:sokomind-solver
- npm run typecheck
- npm run lint
- npm run test:unit
- npm run build
- npm run test
- npm run test:coverage
- npm run test:solver:multi
- npm run test:solver:huge
- npm run benchmark:solver

## Sprint rules

- Implement one approved sprint at a time.
- Add tests with implementation.
- Update docs/solver-v2-progress.md.
- Run targeted and required tests.
- Use one focused reversible commit.
- Stop after the sprint report.
```

---

# 28. Definition of Done

The Solver V2 project is complete when:

1. Fast mode preserves or improves current first-solution performance.
2. Quality mode returns solutions no worse than Fast and usually better on long fixtures.
3. Optimal mode proves all oracle fixtures.
4. Exact A* and IDA* agree with exhaustive ground truth.
5. Hash collisions cannot affect proof correctness.
6. First-push walk bounds are admissible.
7. A cutoff returns an honest lower bound and gap.
8. `optimality: "proven"` is used only after complete proof.
9. Exact A* uses compact state storage.
10. Exact IDA* supports low-memory operation.
11. Incremental assignment is exactly equivalent to full assignment.
12. Stronger proof heuristics pass exhaustive oracle tests.
13. Parallel proof partitions are disjoint and complete.
14. Every solution is replay-verified.
15. Grand Hall guardrails remain valid.
16. The 17-box fixture is permanently benchmarked.
17. Browser and Node deterministic modes agree.
18. Documentation accurately distinguishes:

    * First found
    * Improved
    * Bounded
    * Proven optimal
19. No puzzle-generator or catalog changes are included.
20. Every sprint is represented by a focused reviewed commit.
