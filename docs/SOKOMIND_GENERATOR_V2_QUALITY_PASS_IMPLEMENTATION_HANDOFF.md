# Sokomind Generator V2.1 / V2.2 Quality Pass — Detailed Implementation Handoff

> **Repository:** `Willpatpost/SokomindSolver`  
> **Primary target:** Generator V2 and the official generated puzzle catalog  
> **Recommended naming:** **Generator V2.1 — Quality & Correctness**, followed by **Generator V2.2 — Curation & Validation**  
> **Do not call this Generator V3.** The intent is to make the existing V2 architecture correctly fulfill its own design goals, not replace it.
>
> This document is intended as an implementation handoff. Treat it as a technical plan, not a request to blindly apply every proposed API name verbatim. Inspect the current source before editing, preserve existing architectural boundaries, and adapt names where the repository already has a clearer convention.

---

# 0. Executive Summary

Generator V2 has the right high-level architecture:

```text
structural topology
    ↓
functional room roles
    ↓
goal placement / motifs / composition
    ↓
reverse beam search
    ↓
candidate puzzle
    ↓
geometry tightening
    ↓
solver-backed evaluation
    ↓
acceptance gates
    ↓
diversity selection
    ↓
official catalog
```

The core generator should **not** be rewritten.

The current weaknesses are concentrated in the back half of the pipeline:

1. generated puzzle IDs are ordinal and can silently refer to a different board after regeneration;
2. forge parameter sampling does not explore the intended Cartesian product;
3. exact duplicate boards can survive diversity selection;
4. some evaluator metrics do not measure what their names imply;
5. strategic branching is undercounted because only immediately adjacent pushes are considered;
6. `boxIndependenceRatio` is a push-switch proxy rather than causal box interaction;
7. geometry tightening protects solvability but not the intended motif/topology/mechanism;
8. dependency realization is semantically weaker than the dependency labels imply;
9. dependency realization is computed before tightening and can become stale afterward;
10. difficulty mismatches are informational only;
11. catalog generation can silently produce fewer puzzles than requested;
12. catalog conversion discards valuable provenance;
13. the “V1 vs V2” baseline is not stable across repeated regeneration;
14. final curation uses a single weighted scalar and one main solver, creating selection pressure toward one morphology and one solver’s biases;
15. existing diversity tests are too weak to catch the duplicates that are actually present in the official catalog.

The priority is therefore:

> **Make identity, measurement, sampling, preservation, and curation trustworthy before adding more topology families or motif types.**

A good implementation sequence is:

```text
V2.1 correctness foundation
    1. stable puzzle identity + provenance
    2. canonical board normalization + dedupe
    3. stratified/cartesian forge sampling
    4. evaluator correctness
    5. semantic dependency verification
    6. mechanism-preserving tightening
    7. atomic quota-enforced catalog production
    8. difficulty policy

V2.2 quality/curation
    9. stable benchmark baselines
   10. multi-solver finalist grading
   11. Pareto + novelty selection
   12. catalog audit/reporting + large-run validation
```

Do not regenerate and publish the official catalog until the V2.1 blockers are complete.

---

# 1. Current Repository Areas Relevant to This Work

The implementation should begin by inspecting these existing files and preserving their responsibilities where possible.

## Core V2 pipeline

```text
src/features/generator/v2/
├── blueprint-graph.ts
├── blueprint-types.ts
├── room-roles.ts
├── goal-placement.ts
├── reverse-beam-search.ts
├── reverse-scoring.ts
├── motifs.ts
├── dependency-graph.ts
├── structural-metrics.ts
├── puzzle-evaluator.ts
├── geometry-tightening.ts
├── puzzle-forge.ts
└── index.ts
```

## Catalog generation

```text
scripts/generate-v2-catalog.ts
src/catalog/generated-puzzles.json
```

## Existing non-V2 generator code still reused by V2

```text
src/features/generator/
├── generate-puzzle.ts
├── difficulty-classifier.ts
├── reverse-play.ts
├── board-template.ts
├── generator-types.ts
└── ...
```

## Progress/persistence surface affected by puzzle identity

```text
src/shared/progress.ts
```

## Important test files

```text
tests/unit/puzzle-forge.test.ts
tests/unit/puzzle-evaluator.test.ts
tests/unit/geometry-tightening.test.ts
tests/unit/dependency-graph.test.ts
```

There are additional V2 tests for blueprint generation, roles, motifs, reverse search, etc. Preserve them and add focused tests rather than replacing broad coverage.

---

# 2. Existing V2 Design Intent That Must Be Preserved

The design documents explicitly aim for generated puzzles that feel **authored**, not merely solvable.

The existing V2 roadmap already calls for:

- rooms;
- corridors;
- narrow doorways;
- bottlenecks;
- packing order;
- staging;
- box dependencies;
- support-square conflicts;
- temporary displacement;
- room traffic;
- crossing paths;
- misleading but plausible moves;
- strategic choices;
- explicit tedium penalties;
- richer difficulty signals;
- solver effort;
- multiple solvers;
- novelty;
- a curated offline forge.

Do not simplify the generator back into “random geometry + solvability.”

The V2 architecture is the asset we want to protect.

---

# 3. Versioning Recommendation

Use the following conceptual split.

## Generator V2.0

Already implemented:

- structural blueprints;
- functional room roles;
- topology families;
- goal-placement styles;
- reverse beam search;
- motifs;
- dependency DAG composition;
- geometry tightening;
- evaluator;
- forge;
- first V2 official generated catalog.

## Generator V2.1 — Quality & Correctness

Implement in this effort:

- immutable puzzle identity;
- provenance manifest;
- canonical board normalization;
- exact duplicate detection;
- optionally symmetry-equivalent duplicate detection;
- correct parameter sampling;
- evaluator semantic fixes;
- proper reachable-push branching;
- clearer interaction metrics;
- stronger dependency verification;
- post-tightening dependency revalidation;
- mechanism-preserving tightening;
- difficulty mismatch policy;
- quota enforcement;
- atomic generation;
- stable comparison baseline;
- much stronger tests.

## Generator V2.2 — Curation & Validation

Implement after V2.1 is green:

- independent solver evidence on finalists;
- Pareto/non-dominated selection;
- novelty/diversity selection based on board structure and behavior;
- cross-tier calibration;
- catalog audit artifact;
- large deterministic candidate runs;
- human blind-play sampling workflow.

## Generator V3

Reserve for a future conceptual jump, such as:

- first-class typed-box procedural design;
- explicit causal plan synthesis;
- evolutionary mutation loops;
- MAP-Elites / quality-diversity generation;
- learned human difficulty or quality model;
- automatic motif discovery;
- generation conditioned on named puzzle styles.

---

# 4. Release-Blocking Problem 1 — Generated Puzzle Identity Is Not Stable

## Current behavior

The official catalog conversion assigns IDs by tier and ordinal position:

```text
gen-tutorial-001
gen-beginner-001
gen-intermediate-001
...
```

This means puzzle identity is tied to **selection order**, not board identity.

If a later generator run produces a different first tutorial puzzle, the same ID can point to a different board.

This has already happened across generator generations. V1 and V2 have reused ordinal IDs for different boards.

Progress is keyed by puzzle ID in `src/shared/progress.ts`, so this can make an old completion record appear to belong to a new puzzle.

That is unacceptable for a persistent game catalog.

## Required behavior

A published puzzle ID must be **immutable**.

Once an ID has referred to one board, it must never refer to a different board.

Selection order should be presentation metadata only.

## Recommended design

Create a dedicated V2 identity utility, for example:

```text
src/features/generator/v2/puzzle-identity.ts
```

Suggested responsibilities:

```ts
export interface CanonicalPuzzleIdentity {
  canonicalRows: readonly string[];
  boardHash: string;
}

export function canonicalizePuzzleRows(
  rows: readonly string[],
  options?: CanonicalizationOptions,
): readonly string[];

export function computePuzzleBoardHash(
  rows: readonly string[],
): string;

export function createGeneratedPuzzleId(
  provenance: Pick<ForgeProvenance, "seed">,
  boardHash: string,
): string;
```

A reasonable ID shape:

```text
gen-v2-150083-a7c31e42
```

or:

```text
gen-v2-a7c31e42
```

The important requirement is not the exact syntax. The important requirements are:

1. V2 must use a namespace distinct from V1;
2. the ID must be stable for the board;
3. it should not depend on ordinal catalog position;
4. collisions must be detected;
5. an ID must never be reassigned to different canonical rows.

### Recommendation

Use:

```text
gen-v2-<seed>-<shortHash>
```

where `shortHash` is derived from canonical board content.

Keep the full hash in the provenance manifest.

---

# 5. Canonical Board Normalization

This is needed for both identity and duplicate detection.

## Minimum normalization

Implement a canonical board representation that:

1. validates all rows have consistent width;
2. treats `O` as wall;
3. removes all-wall rows from the top and bottom;
4. removes all-wall columns from the left and right;
5. preserves the exact relative placement of walls, floor, robot, boxes, goals, and typed boxes/goals if present;
6. returns deterministic rows.

A puzzle shifted within wall-only padding should normalize to the same board.

## Optional symmetry normalization

For stronger duplicate rejection, also compute transformed forms:

- identity;
- horizontal reflection;
- vertical reflection;
- 180° rotation;
- optionally 90°/270° rotation if rectangular dimension swapping is acceptable for your definition of equivalence.

For each transformation:

1. trim all-wall padding;
2. serialize rows;
3. choose the lexicographically smallest serialization.

Expose two hashes:

```ts
exactCanonicalHash
symmetryCanonicalHash
```

Use **exact canonical hash** for immutable puzzle identity unless you explicitly want mirrored boards to share identity.

Use **symmetry canonical hash** for stronger diversity/deduplication warnings.

This lets you distinguish “same puzzle content” from “same puzzle up to rotation/reflection.”

---

# 6. Provenance Manifest

The forge already tracks useful provenance, but official catalog conversion discards most of it.

Create a committed or generated sidecar artifact, for example:

```text
src/catalog/generated-puzzles.manifest.json
```

Suggested structure:

```ts
interface GeneratedPuzzleManifest {
  schemaVersion: 1;
  generatorVersion: "2.1.0";
  catalogHash: string;
  puzzles: GeneratedPuzzleManifestEntry[];
}

interface GeneratedPuzzleManifestEntry {
  id: string;
  title: string;
  difficulty: Difficulty;

  seed: number;
  family: TopologyFamily;
  boxCount: number;
  mode: ForgeGenerationMode;

  motifType?: MotifType;
  compositionType?: string;

  boardHash: string;
  symmetryHash: string;

  tightened: boolean;
  cellsRemoved: number;

  dependencyEdges?: number;
  dependencyRealized?: number;
  dependencyRealizationRate?: number;

  intendedDifficulty: Difficulty;
  classifiedDifficulty: Difficulty;
  difficultyGap: number;

  evaluation: PuzzleEvaluationVector;
  finalistEvaluation?: FinalistEvaluation;
}
```

Do not necessarily expose this entire object to the browser bundle if that would inflate runtime assets.

The purpose is reproducibility and generator analysis.

---

# 7. Migration Rule for Existing Progress

Do **not** try to pretend old ordinal V1/V2 generated IDs are the same puzzle.

Recommended policy:

- new V2.1 catalog IDs use `gen-v2-*`;
- old generated IDs become stale IDs during normalization;
- existing `normalizeProgress()` behavior can ignore unknown puzzle IDs and report them;
- do not migrate old completion records unless a board-content mapping proves that the old and new puzzles are exactly the same canonical board.

If you want to preserve records for unchanged puzzles:

1. create a one-time explicit old-ID → new-ID mapping;
2. only map when canonical rows match exactly;
3. add tests proving each migrated pair is identical.

Never migrate based only on title, tier, ordinal, seed guess, or similarity.

---

# 8. Release-Blocking Problem 2 — Forge Sampling Is Correlated

## Current pattern

`runForge()` currently chooses configuration dimensions from the same loop index:

```ts
family = families[i % familyCount];
boxCount = boxCounts[i % boxCountCount];
mode = modes[i % modeCount];
difficulty = difficulties[i % diffCount];
```

This does **not** sample the Cartesian product.

It creates deterministic coupling.

For the current Master tier:

```text
families:  loop, branch, nested
boxes:     5, 6, 7
modes:     plain, motif, composed
```

the forge repeatedly samples only:

```text
loop   + 5 + plain
branch + 6 + motif
nested + 7 + composed
```

instead of all 27 possible combinations.

---

# 9. Required Sampling Redesign

Introduce an explicit parameter-combination representation.

```ts
export interface ForgeParameterCombination {
  family: TopologyFamily;
  boxCount: number;
  mode: ForgeGenerationMode;
  difficulty: Difficulty;
}
```

Create:

```ts
export function enumerateForgeCombinations(
  config: ForgeConfig,
): ForgeParameterCombination[];
```

This should create the Cartesian product of:

```text
families × boxCounts × modes × difficulties
```

Then create deterministic sampling across that combination list.

## Recommended deterministic schedule

For each candidate index:

```ts
const combo = combinations[i % combinations.length];
const cycle = Math.floor(i / combinations.length);
const seed = deriveSeed(config.baseSeed, comboIndex, cycle);
```

A simpler implementation is also acceptable:

```ts
const combo = combinations[i % combinations.length];
const seed = config.baseSeed + i;
```

as long as:

- all combinations are visited before repeats;
- the mapping is deterministic;
- the same config and base seed reproduce the same candidates.

## Better stratified schedule

To reduce position bias:

1. build Cartesian combinations;
2. deterministically shuffle the combination array with a seeded RNG derived from `baseSeed`;
3. cycle through that shuffled list;
4. use a different deterministic seed per attempt.

---

# 10. Sampling Tests

Add tests such as:

```ts
test("forge parameter scheduler covers full Cartesian product")
```

For a 3 × 3 × 3 × 1 configuration and `batchSize >= 27`, assert all 27 combinations were attempted.

Add a diagnostic to `ForgeRunResult` or expose the schedule in a testable helper.

Also assert:

- deterministic schedule for same config/baseSeed;
- different base seed does not alter combination coverage;
- each combination gets attempt counts differing by at most one when batch size is not divisible by combination count.

---

# 11. Release-Blocking Problem 3 — Diversity Selection Allows Exact Duplicate Boards

The current forge diversity logic uses provenance + coarse metric buckets.

It does not enforce unique canonical geometry.

Exact duplicate boards have survived into the current official generated catalog, including duplicate pairs inside Intermediate and Master and translation-equivalent boards across tiers.

Do not rely on provenance or solver metrics to infer board uniqueness.

---

# 12. Required Deduplication Pipeline

Deduplicate at multiple stages.

## Stage A — before expensive finalist ranking

After a candidate has been tightened and evaluated:

```ts
candidate.identity = buildCanonicalPuzzleIdentity(candidate.puzzle);
```

Maintain a map:

```ts
Map<boardHash, ForgeCandidate>
```

If a new candidate has the same canonical exact hash:

- keep only the better candidate;
- record the rejected candidate as `duplicate-exact`;
- preserve provenance of duplicate seeds in diagnostics if useful.

The “better” candidate can be chosen by deterministic quality comparison.

## Stage B — symmetry-equivalent duplicate filtering

Optionally maintain:

```ts
Map<symmetryHash, ForgeCandidate>
```

Policy recommendation:

- exact duplicate: hard reject;
- symmetry-equivalent duplicate: hard reject for official catalog unless there is a strong reason to retain mirrored variants.

## Stage C — global cross-tier dedupe

The final catalog must be deduplicated across all tiers, not merely within a tier.

After all tier candidate pools exist:

1. compute canonical hashes globally;
2. resolve collisions;
3. either keep the version whose classified difficulty best matches its intended tier, or choose the best candidate and assign one calibrated difficulty.

This should happen **before** catalog conversion and final quota filling.

---

# 13. Add Explicit Rejection Reasons

Extend `ForgeRejectionReason` with relevant values such as:

```ts
| "duplicate-exact"
| "duplicate-symmetry"
| "difficulty-mismatch"
| "post-tightening-dependency-regression"
| "post-tightening-topology-regression"
```

If global final curation happens outside `runForge()`, create a separate `CatalogRejectionReason` rather than overloading forge-level reasons.

---

# 14. Replace the Existing Diversity Test

The current diversity test is too weak.

Add exact semantic tests.

### Exact duplicate

```ts
const a = puzzle([...]);
const b = puzzle([...same rows...]);
assert.equal(exactHash(a), exactHash(b));
```

### Padding translation duplicate

```ts
const a = compactPuzzle;
const b = same puzzle shifted inside wall-only padding;
assert.equal(exactCanonicalHash(a), exactCanonicalHash(b));
```

### Mirrored duplicate

```ts
assert.notEqual(exactHash(a), exactHash(mirror(a)));
assert.equal(symmetryHash(a), symmetryHash(mirror(a)));
```

### Final selection

Feed exact duplicates with different provenance into the selector and assert only one survives.

### Catalog-level

Load the generated catalog and assert:

```text
no duplicate exact canonical hashes
no duplicate IDs
no ID maps to conflicting rows
```

If symmetry dedupe is policy, assert that too.

---

# 15. Release-Blocking Problem 4 — `unusedFloorRatio` Does Not Measure Floor Usage

## Current behavior

The evaluator currently counts entity cells in the initial board as “used” and effectively treats blank floor as “unused.”

This is closer to:

```text
empty floor ratio
```

than:

```text
unused by the solution
```

Because this metric is used in acceptance/ranking/tightening, it creates pressure to remove open maneuvering space even when the space is strategically meaningful.

---

# 16. Define the Correct Metric

Introduce a clear distinction between:

```ts
initialEmptyFloorRatio
solutionUnusedFloorRatio
solutionFloorCoverage
```

### `initialEmptyFloorRatio`

If retained:

```text
blank walkable cells / total walkable cells
```

This is a morphology metric, not a tedium metric.

### `solutionFloorCoverage`

Replay a valid solution and track all relevant cells used by:

- keeper positions;
- keeper movement;
- box positions;
- box destinations;
- keeper support squares before pushes.

Then:

```text
usedSolutionCells / totalFloor
```

### `solutionUnusedFloorRatio`

```text
1 - solutionFloorCoverage
```

This is the metric that should replace the current misleading `unusedFloorRatio` in tedium analysis.

---

# 17. Multiple-Solution Caveat

A single solver solution does not prove a floor cell is globally unnecessary.

Therefore use the metric carefully.

For candidate scoring:

- acceptable to use one reference solution as a heuristic.

For geometry deletion:

- do not conclude “unused in one solution = safe to wall”;
- mutation still needs semantic structure checks and re-solving;
- ideally preserve reachable-area capacity around designed rooms.

If preserving the existing field name, document that it is reference-solution-based. A precise name such as `referenceSolutionUnusedFloorRatio` is preferable internally.

---

# 18. Release-Blocking Problem 5 — Strategic Push Branching Is Undercounted

## Current behavior

The branching evaluator counts only boxes immediately adjacent to the current keeper position.

That misses the actual strategic choice set available to a player after walking around the current reachable region.

In Sokoban, a move state often consists of:

```text
keeper can freely walk in region R
→ from region R, multiple box pushes are available
```

The strategic branch count is the set of reachable pushes, not adjacent pushes from the keeper's exact current square.

---

# 19. Implement Reachable Push Enumeration

Create a helper in an appropriate low-level location.

Possible API:

```ts
interface ReachablePush {
  boxIndex: number;
  direction: Direction;
  support: GridPosition;
  destination: GridPosition;
}

function enumerateReachablePushes(
  grid: readonly (readonly string[])[],
  robot: GridPosition,
  boxes: readonly GridPosition[],
): ReachablePush[];
```

Algorithm:

1. build occupied box set;
2. flood-fill keeper-reachable floor without moving boxes;
3. for every box and each direction:
   - destination must be floor and unoccupied;
   - support square opposite destination must be floor and unoccupied;
   - support square must be keeper-reachable;
4. each such box/direction pair is one legal push action.

Do not count duplicate actions.

---

# 20. Update Branching Metrics

At each **push decision state** in the reference solution:

1. reconstruct current board state;
2. enumerate all reachable push actions;
3. record count.

Then derive:

```ts
avgReachablePushChoices
maxReachablePushChoices
singleChoiceRatio
forcedPushRatio
highBranchCount
```

Consider renaming `avgLegalPushes` to `avgReachablePushes` if compatibility allows.

---

# 21. Better Decision-Quality Metrics

The roadmap wants meaningful choices, not merely legal actions.

V2.1 can stop after correct reachable-push enumeration.

V2.2 should add richer signals:

```ts
productiveAlternativeCount
immediateDeadlockAlternativeCount
reversibleAlternativeCount
longTermBadAlternativeCount
```

A practical staged approximation for finalists:

1. enumerate reachable pushes;
2. apply each alternative push;
3. perform cheap deadlock validation;
4. optionally run a short bounded solver;
5. classify alternatives.

A useful human-difficulty signal is:

```text
several legal/plausible pushes
but only one or two retain a good continuation
```

---

# 22. Release-Blocking Problem 6 — `boxIndependenceRatio` Is Misnamed

## Current behavior

The evaluator observes which box is pushed in each push step.

It treats switching from one box to another as evidence of interaction.

That is not causal box interaction.

It is a useful behavior feature, but it should be named accurately.

---

# 23. Rename the Existing Metric

Recommended names:

```ts
boxPushSwitchRate
boxPushRunConcentration
```

For example:

```text
switchRate = transitions / (pushes - 1)
```

Keep this as a tedium/solution-style signal.

Do not use it as the primary causal interaction score.

---

# 24. Implement Better Interaction Metrics

Add progressively stronger signals.

## 24.1 Shared traffic

For each box route in the reference solution, track:

- cells occupied;
- doorway/chokepoint crossings;
- keeper support squares.

Measure overlap between box routes.

Possible fields:

```ts
sharedBoxRouteCells
sharedSupportCells
sharedChokepointUses
```

## 24.2 Reachability influence

Sample key solution states.

For each box move:

1. enumerate reachable pushes before;
2. apply the actual move;
3. enumerate reachable pushes after;
4. detect whether moving box A enables/disables a push of B, changes keeper access to B, or changes accessible regions.

Count these as causal interaction events.

## 24.3 Ordering sensitivity

For a candidate dependency or motif:

- test whether prematurely completing/positioning one relevant box makes another target inaccessible or much harder;
- use bounded solving rather than full proof when necessary.

---

# 25. Change Forge Scoring So One Weak Proxy Does Not Dominate

The current quality score places a large weight on the inverse “box independence” proxy.

After renaming it to push-switch behavior:

- greatly reduce its weight;
- add actual interaction signals;
- avoid allowing one metric to dominate the entire population.

For V2.1, a simple transition is acceptable:

```text
old interaction proxy weight: high
new push-switch weight: low
actual interaction metrics: moderate/high
```

Do not tune final weights before the metrics themselves are correct.

---

# 26. Release-Blocking Problem 7 — Dependency Realization Is Too Weak

The dependency DAG concept is valuable and should be preserved.

However, labels such as:

```text
must-stage
blocks-access
shares-passage
must-precede
```

should not be considered verified based only on loose completion order.

The generated graph is currently closer to:

```text
intended semantic dependency
```

than:

```text
proven causal dependency
```

We need to close that gap.

---

# 27. Introduce Stable Semantic Goal Identity

Do not rely on array index matching across independently reconstructed representations.

Create explicit goal identity.

For example:

```ts
export interface GoalCell {
  readonly goalId: string;
  readonly row: number;
  readonly column: number;
  readonly roomId: number;
  ...
}
```

or use a numeric stable ID generated at goal placement time.

DAG nodes should reference:

```ts
goalId
```

not a positional `goalIndex` whose meaning can change after array reordering.

If changing `GoalCell` broadly is too invasive, create a V2-only semantic wrapper:

```ts
interface SemanticGoal {
  id: string;
  cell: GoalCell;
}
```

---

# 28. Preserve Goal Identity Through Rendering and Replay

When a puzzle is rendered to generic `S` cells, identity is not encoded in the board.

Therefore dependency verification should receive the original semantic goal mapping directly:

```ts
verifyDependencies(
  dag,
  puzzle,
  solutionSteps,
  semanticGoals,
)
```

Do not reconstruct semantic goal identity by scanning board rows and assuming the order matches generation order.

---

# 29. Stronger Semantics by Dependency Type

## `must-precede`

Minimum acceptable verification:

- target A becomes permanently completed before target B;
- or the planned semantic event A occurs before B.

Stronger verification:

- test B-first counterfactual with bounded search;
- if B-first causes failure or major cost increase, confidence is stronger.

## `blocks-access`

Do not equate it with completion order.

Verify that moving/completing the `from` box changes access relevant to the `to` task.

Possible evidence:

```text
before event:
    required support region / target region unavailable

after event:
    required support region / target region becomes reachable
```

Track keeper reachability and/or reachable pushes.

## `must-stage`

Verify an actual temporary displacement.

A staging event should look like:

1. a box moves away from its final target/goal path;
2. it occupies a temporary location;
3. another dependency task occurs while it is staged;
4. the staged box later moves again toward final completion.

At minimum, detect that the involved box is moved, remains displaced across another relevant box action, and is later revisited.

## `shares-passage`

Do not treat “goals finish at different moves” as passage interaction.

Use known passage cells from the blueprint.

Verify that at least two relevant boxes traverse the same passage/chokepoint set, or their routes compete for the same passage support/occupancy cells.

---

# 30. Add Verification Confidence

Dependency realization does not have to be a binary oracle.

A useful structure:

```ts
interface DependencyEdgeVerification {
  edge: DependencyEdge;
  realized: boolean;
  confidence: "structural" | "observed" | "counterfactual";
  evidence: readonly DependencyEvidence[];
  reason: string;
}
```

This makes it possible to distinguish “observed ordering” from “supported by counterfactual bounded search” without pretending both are equally strong.

---

# 31. Reverify Dependencies After Tightening

This is mandatory.

Change the effective pipeline from:

```text
compose
→ verify dependency
→ tighten geometry
→ evaluate tightened puzzle
→ keep old dependency score
```

to:

```text
compose
→ initial dependency verification
→ tighten geometry
→ solve tightened puzzle
→ verify dependencies again on tightened puzzle
→ apply final dependency gate using post-tightening result
```

The final candidate provenance must store the **post-tightening** realization.

If tightening destroys the intended mechanism, reject or revert the damaging mutations.

---

# 32. Release-Blocking Problem 8 — Geometry Tightening Is Solvability-Preserving, Not Mechanism-Preserving

The tightening pass is useful and should remain.

The problem is the acceptance contract.

Current logic strongly protects validation, connectivity, solvability, and a handful of solver metrics.

It does not sufficiently protect intended topology, room identity, staging capacity, loops, passage structure, motif realization, dependency realization, or meaningful alternate keeper paths.

---

# 33. Introduce a Tightening Preservation Contract

Create something like:

```ts
export interface TighteningPreservationContext {
  blueprint?: FunctionalBlueprint;
  motif?: MotifType;
  dependencyDag?: DependencyDAG;
  semanticGoals?: readonly SemanticGoal[];
  baselineStructuralMetrics: StructuralMetrics;
  baselineBlueprintFidelity?: BlueprintFidelity;
  baselineDependencyVerification?: DependencyVerificationResult;
}
```

Then allow:

```ts
tightenPuzzle(
  puzzle,
  params,
  preservationContext,
)
```

For plain puzzles without semantic metadata, use the existing solver/structural safeguards.

For motif/composed puzzles, apply stronger preservation.

---

# 34. Protect Critical Geometry

Before ranking removal candidates, mark cells that should not be mutated casually.

Potential critical cells:

- passage cells from the blueprint;
- doorways;
- articulation points;
- intended staging cells;
- goal-approach cells;
- motif-specific support cells;
- cells used as dependency evidence;
- cells that preserve a loop/alternate path;
- a minimum maneuvering halo around rooms/goals.

Represent as:

```ts
Set<string> protectedCells
```

Skip these in the first tightening pass.

A future advanced tightening pass could mutate them under stronger proof, but V2.1 should be conservative.

---

# 35. Preserve Blueprint Fidelity

You already have structural metrics and blueprint-fidelity analysis.

Use them.

Before tightening:

```ts
baseline = analyzeBlueprintFidelity(blueprint, analyzeGrid(grid))
```

After every accepted candidate mutation or at least after batches:

```ts
after = analyzeBlueprintFidelity(...)
```

Reject changes that exceed configured regressions.

Possible invariants:

```text
connected components must stay 1
unintended shortcuts must not increase
merged rooms must not materially increase
intended room count fidelity must not collapse
required topology cycle must remain if the family expects one
required passages/chokepoints must remain functionally represented
```

Do not use one universal threshold blindly. Add family/role-aware checks.

---

# 36. Preserve Room Capacity

The visual skeletonization problem can arise even when graph connectivity remains intact.

Add room-capacity guards.

For each functional room, compute remaining floor area after mutation.

Require:

```text
remainingRoomFloor >= max(
    minimum absolute floor,
    configured fraction of original room floor
)
```

Use stricter preservation for:

```text
staging
exchange
goal-room
shared-work areas
```

than for pure transit corridors.

Reasonable starting experiments might preserve ~65–75% for strategically important rooms and ~50–60% for general rooms, but these are tuning suggestions, not required constants.

The point is to prevent a room from being shaved into a graph edge simply because one Greedy solution did not use every cell.

---

# 37. Re-evaluate Quality After Tightening

The current tightening regression checks can remain as cheap filters.

For semantic candidates, add periodic or final full evaluation.

Possible pattern:

```text
for each candidate wall mutation:
    connectivity
    validate
    solve
    cheap regression checks

every N accepted mutations OR before finalizing:
    full puzzle evaluator
    structural fidelity
    dependency verification
    motif verification
```

If final semantic checks fail, either roll back to the last known-good checkpoint or rerun tightening with stricter protected cells.

A checkpoint-based implementation is safer than trying to reverse arbitrary mutations after the fact.

---

# 38. Release-Blocking Problem 9 — Official Catalog Generation Is Not Atomic

The catalog generator currently logs some errors and can continue.

For official generation, that is too permissive.

A committed catalog should be all-or-nothing.

---

# 39. Define Final Catalog Invariants

Before writing `generated-puzzles.json`, assert all of the following:

```text
1. every puzzle validates;
2. every puzzle solves under the required verification solver;
3. every ID is unique;
4. every exact canonical board hash is unique;
5. every symmetry hash is unique if that policy is enabled;
6. no puzzle reuses an existing immutable ID for different content;
7. each difficulty tier meets its required quota;
8. every puzzle satisfies final difficulty policy;
9. every motif/composed puzzle satisfies post-tightening semantic verification;
10. provenance exists for every generated puzzle;
11. manifest entry count equals catalog entry count;
12. catalog total equals expected total;
13. deterministic ordering is used;
14. the entire candidate set passes before either output file is written.
```

If any invariant fails:

```text
exit non-zero
write nothing
```

Use temp files then rename after success if useful.

---

# 40. Quota Enforcement

The current Master configuration requests 20 puzzles while the current catalog contains only 18 Master entries.

Do not accept this silently.

## Recommended: deterministic seed-window continuation

For each tier:

```text
target = retainTarget
seedWindow = baseSeed

while retainedUniqueValid < target:
    run another deterministic batch using next seed window
    merge candidates
    dedupe
    curate
    advance seedWindow

    if max windows exceeded:
        fail generation
```

Add a hard maximum to prevent accidental infinite generation.

Example:

```ts
maxBatchWindows: 10
```

If target is still not reached, fail clearly:

```text
ERROR: master requested 20 but only 18 qualifying unique candidates were found.
```

---

# 41. Difficulty Calibration Policy

The current legacy classifier uses moves, pushes, and box count.

It is useful as one feature but not sufficient as a V2 difficulty definition.

The official generation currently logs mismatches but keeps everything.

Change that.

---

# 42. V2.1 Difficulty Policy

Do not attempt a learned difficulty model yet.

Implement an explicit conservative policy.

Let:

```text
intendedTier = forge configuration tier
legacyClassifiedTier = classifyFromMetrics(...)
gap = rank(intended) - rank(classified)
```

Recommended rules:

```text
gap = 0:
    accept

candidate classifies one tier easier:
    accept only if V2 structural difficulty metrics support intended tier,
    otherwise reclassify

candidate classifies one tier harder:
    generally accept/reclassify upward if quota policy allows

absolute gap >= 2:
    reject or reclassify; do not silently keep
```

Code this as an explicit function:

```ts
decideDifficulty(
  intended,
  legacyClassified,
  evaluation,
  semanticMetrics,
): DifficultyDecision
```

with a result such as:

```ts
type DifficultyDecision =
  | { action: "accept"; difficulty: Difficulty; reason: string }
  | { action: "reclassify"; difficulty: Difficulty; reason: string }
  | { action: "reject"; reason: string };
```

---

# 43. V2.2 Difficulty Vector

Once evaluator metrics are reliable, create a richer difficulty vector.

Candidate dimensions:

```ts
interface DifficultyVector {
  moves: number;
  pushes: number;
  boxCount: number;

  reachablePushBranching: number;
  forcedPushRatio: number;
  deceptiveChoiceRate?: number;

  causalInteractionEvents: number;
  dependencyDepth: number;
  realizedDependencyCount: number;

  roomTrafficComplexity: number;
  packingComplexity: number;

  deadlockPressure: number;

  solverEffortGreedy: number;
  solverEffortAStar?: number;
  solverEffortSokomind?: number;

  tedium: number;
}
```

Do not immediately compress this into one scalar until distributions are examined.

---

# 44. Stable Benchmark Baseline

The catalog generation script currently reads the same generated catalog file that it later overwrites and uses it as the “V1” comparison baseline.

That only represents V1 on the first transition.

On later runs it becomes “previous generated catalog vs candidate generated catalog.”

Fix this.

---

# 45. Create Frozen Benchmark Fixtures

Create stable fixtures, for example:

```text
tests/fixtures/generator/v1-generated-benchmark.json
tests/fixtures/generator/handcrafted-benchmark.json
```

The V1 fixture should contain a representative frozen sample of old V1 generated puzzles.

The handcrafted fixture should contain a curated sample across known mechanisms/difficulties.

Reports can then clearly distinguish:

```text
Frozen V1 benchmark vs V2.1 candidate
Handcrafted benchmark vs V2.1 candidate
Previous official generated catalog vs candidate
```

These are different comparisons and should not be conflated.

---

# 46. Do Not Benchmark Only Averages

Report:

- count;
- solved count;
- mean;
- median;
- p10;
- p25;
- p75;
- p90;
- min/max;
- per-tier distribution.

Also report:

```text
exact duplicate count
symmetry duplicate count
difficulty mismatch count
mode distribution
family distribution
family×mode distribution
box-count distribution
```

---

# 47. V2.2 — Multi-Solver Finalist Evaluation

Do not run every expensive solver on every raw candidate.

Use a funnel.

## Stage 1 — cheap generation filters

Per raw candidate:

- blueprint/goal/motif validity;
- reverse construction success;
- puzzle validation;
- cheap solver solvability;
- basic tedium;
- basic structural checks.

## Stage 2 — forge candidate

For candidates that pass cheap gates:

- geometry tightening;
- post-tightening validation;
- corrected evaluator;
- canonical dedupe;
- semantic verification.

## Stage 3 — finalists only

For perhaps top 5–20%:

- Greedy;
- A* or exact solver where tractable;
- Sokomind solver;
- optional IDA* / other independent strategy;
- bounded alternative-push analysis.

Store results in:

```ts
interface SolverEvidence {
  solverId: string;
  status: string;
  moves?: number;
  pushes?: number;
  expandedStates?: number;
  generatedStates?: number;
  elapsedMs?: number;
  optimalityProven?: boolean;
}
```

---

# 48. Avoid Comparing Raw Solver Times Naively

Elapsed time is noisy.

Prefer deterministic counters:

- expanded states;
- generated states;
- deadlock prunes;
- frontier size;
- proof status;
- solution length.

Timing can remain diagnostic but should not dominate difficulty or quality ranking.

---

# 49. Solver Disagreement Can Be Useful

Interesting patterns:

```text
Greedy easy, all others easy
    likely straightforward

Greedy struggles, structural solver easy
    possible heuristic mismatch or structural mechanism

several independent solvers struggle
    stronger evidence of combinatorial difficulty

solver solution lengths disagree substantially
    potential optimization/deception signal
```

Do not equate “one solver is slow” with “human puzzle is hard.”

---

# 50. V2.2 — Replace Scalar-Only Final Curation

The current `paretoScore()` is a weighted scalar despite the “Pareto-like” description.

For final curation, implement actual multi-objective selection or at least non-dominated sorting.

---

# 51. Recommended Objective Groups

Do not use every raw metric independently. Group correlated metrics.

Example:

```ts
interface CurationObjectives {
  interaction: number;        // maximize
  dependency: number;         // maximize
  decisionQuality: number;    // maximize
  structuralRichness: number; // maximize
  solverChallenge: number;    // maximize within tier
  novelty: number;            // maximize
  tedium: number;             // minimize
}
```

Normalize objective values per tier.

---

# 52. Pareto Selection

Candidate A dominates B if A is no worse on all objectives and strictly better on at least one.

Compute Pareto fronts:

```text
front 0 = non-dominated
front 1 = dominated only by front 0
...
```

Fill catalog quota by front order.

Within a front, select for novelty/diversity.

This avoids one fixed weighted score deciding what “good Sokoban” means.

---

# 53. Novelty / Diversity Should Include Geometry

A better candidate distance should combine:

## Geometry

- canonical wall/floor structure;
- region graph shape;
- room count;
- chokepoint count;
- tunnel count;
- open area ratio;
- topology family.

## Mechanics

- mode;
- motif/composition;
- dependency pattern;
- box count;
- goal distribution.

## Behavior

- push count;
- reachable branching;
- interaction;
- traffic;
- tedium.

A simple first novelty score can be average distance to k nearest already-selected candidates.

Do not gate geometry comparison behind matching provenance fingerprints.

---

# 54. Preserve Archetype Coverage

Consider curation quotas or soft targets for:

```text
plain
motif
composed

packing-order
doorway-traffic
staging-dep
gatekeeper

linear
hub
loop
branch
nested
```

Do not force equal representation if some combinations are poor.

But report the distribution and prevent the final catalog from collapsing into one winning type.

---

# 55. Reverse Beam Search — Keep It

The current reverse beam search is a strong foundation.

It already:

- starts from solved state;
- enumerates legal reverse pulls;
- maintains a beam;
- scores candidates;
- tracks pull history;
- does within-beam diversity.

Do not replace it during V2.1.

---

# 56. Add Semantic Event Tracking to Reverse Search Later

For future quality scoring, augment `PullRecord` or beam metadata with events such as:

```ts
interface PullRecord {
  ...
  fromRoomId?: number;
  toRoomId?: number;
  crossedPassageId?: string;
  enteredChokepoint?: boolean;
  exitedGoalRoom?: boolean;
}
```

This can support room crossing counts, passage use, staging hypotheses, and route diversity.

If invasive, defer to V2.2.

---

# 57. Review Reverse Scoring Assumptions, But Do Not Over-Tune Yet

Current reverse scoring rewards:

- boxes off goals;
- room crossings;
- dispersion;
- chokepoint interaction;
- tunnel occupancy;
- distance from solved;
- support constraints.

This is directionally useful, but several metrics are positional proxies.

Do not spend V2.1 retuning these weights before downstream evaluation and curation are fixed.

After V2.1, run ablations such as:

```text
default scoring
minus room-crossing reward
minus dispersion reward
minus chokepoint reward
...
```

Compare resulting finalist populations.

---

# 58. Catalog Conversion Must Not Destroy Provenance

Change `forgeCandidateToCatalogEntry()` so ID generation uses stable identity.

Do not use `index + 1` for identity.

The title can remain ordinal for presentation:

```text
Tutorial 1
Tutorial 2
...
```

but title and ID must be independent.

Example:

```ts
return {
  id: createGeneratedPuzzleId(candidate.provenance, identity.boardHash),
  title: `${TITLE_LABELS[difficulty]} ${index + 1}`,
  difficulty,
  boxes: candidate.puzzle.boxes,
  collection: "Sokomind Generated",
  rows: [...candidate.puzzle.rows],
};
```

---

# 59. Deterministic Ordering

After curation, sort candidates deterministically before assigning display titles.

Recommended tier-local ordering:

1. calibrated difficulty sub-score ascending;
2. box count;
3. objective score or puzzle complexity;
4. stable ID as tie-breaker.

This makes `Beginner 1 → Beginner 15` feel roughly progressive.

Do not sort by incidental run order.

---

# 60. Catalog Audit Artifact

Add a generator audit command.

Potential script:

```text
scripts/audit-generated-catalog.ts
```

It should load the official generated catalog and optional manifest and report:

```text
catalog entries
tier counts
ID uniqueness
exact hash uniqueness
symmetry hash uniqueness
validation pass count
solvability pass count
difficulty distribution
difficulty mismatches
box-count distribution
mode distribution
family distribution
motif distribution
duplicate pairs if any
metric percentiles
outlier puzzles
```

Exit non-zero on hard invariants.

---

# 61. Suggested NPM Scripts

Add scripts consistent with existing naming conventions, for example:

```json
{
  "scripts": {
    "generate:catalog:v2": "...",
    "generate:catalog:v2:dry": "... --dry-run",
    "audit:catalog:generated": "...",
    "test:generator:v2": "..."
  }
}
```

Do not rename existing scripts unnecessarily if comparable scripts already exist.

---

# 62. Test Strategy — Required New Tests

This work should come with a much stronger test suite.

## 62.1 Puzzle identity tests

- same rows → same exact hash;
- wall-only padding difference → same canonical hash;
- one wall change → different hash;
- one box position change → different hash;
- one goal change → different hash;
- same hash → same generated ID;
- different board → different generated ID;
- V2 ID namespace never emits legacy ordinal ID.

## 62.2 Symmetry tests

If implemented:

- mirror → same symmetry hash;
- 180° rotation → same symmetry hash;
- unrelated board → different symmetry hash.

## 62.3 Sampling tests

- full Cartesian coverage;
- even distribution;
- deterministic schedule;
- Master-like 3×3×3 config covers 27 combinations.

## 62.4 Deduplication tests

- exact duplicates rejected;
- padded translations rejected;
- cross-tier duplicates resolved;
- provenance difference does not allow duplicate board;
- final retained set contains unique exact hashes.

## 62.5 Evaluator floor-use tests

Construct a puzzle where solution visits most of a large room.

Assert `solutionUnusedFloorRatio` reflects actual visited/box/support cells rather than initial entity count.

Construct another puzzle with a genuinely unused alcove and assert unused ratio is higher.

## 62.6 Reachable-push branching tests

Create a state where the keeper is adjacent to only one box but can walk to support positions for several others.

Assert reachable-push count includes all legal actions.

## 62.7 Push-switch metric tests

Verify existing box-switch behavior under its new name.

Do not label it causal interaction.

## 62.8 Causal interaction tests

Create small handcrafted fixtures:

- box A must move to enable B;
- two truly independent boxes;
- shared chokepoint;
- staging case.

Assert interaction metrics distinguish them.

## 62.9 Dependency verification tests

For each edge type:

- positive fixture;
- negative fixture;
- false-order fixture that previously would have passed;
- semantic goal order shuffled to prove identity mapping is stable.

## 62.10 Post-tightening tests

Generate/combine motif candidate.

Assert dependency realization after tightening is recomputed.

Create a mock mutation that preserves solvability but destroys mechanism and assert it is rejected.

## 62.11 Catalog atomicity tests

Simulate:

- duplicate ID;
- duplicate board;
- target shortfall;
- invalid entry;
- difficulty hard mismatch.

Assert generator fails before writing outputs.

## 62.12 Official catalog invariant test

Load committed `generated-puzzles.json` and manifest.

Assert all hard invariants.

This test should be fast enough for normal CI if possible.

---

# 63. Existing Tests That Should Be Strengthened

## `puzzle-forge.test.ts`

The current diversity test should be replaced/expanded.

Do not accept `families.size >= 1` or `modes.size >= 1` as evidence of diversity.

Add:

- exact canonical uniqueness;
- Cartesian attempt coverage;
- meaningful distribution checks;
- duplicate rejection.

The existing “different base seed produces different IDs” test is weak because seed-derived IDs can differ even when boards are equivalent.

Compare canonical board hashes instead.

## `puzzle-evaluator.test.ts`

Add fixtures that validate semantics, not merely bounds.

Tests such as “ratio is between 0 and 1” are useful sanity checks but cannot catch a metric that measures the wrong concept.

For every important metric, include at least one test where the expected qualitative ordering is known.

## `dependency-graph.test.ts`

Current tests establish graph structure and existence of realization data.

Add tests for causal semantics.

A verifier should fail when completion order happens to match but the claimed mechanism did not occur.

## `geometry-tightening.test.ts`

Existing tests correctly verify solvability and entity preservation.

Add semantic preservation fixtures:

- loop remains loop when required;
- staging room retains minimum capacity;
- critical passage survives;
- dependency realization does not regress;
- a solvability-preserving but mechanism-destroying wall mutation is rejected.

---

# 64. Performance Requirements

This is an offline forge, so correctness and curation quality are more important than browser latency.

However, avoid accidental algorithmic blowups.

Track:

```text
ms per raw candidate
ms per valid candidate
ms per tightened candidate
ms per finalist
```

Use a tiered evaluation funnel.

Do not run exact optimal proof for every raw candidate.

---

# 65. Determinism Requirements

Official catalog generation should be reproducible.

Given:

- source commit;
- generator version;
- config;
- base seeds;

the generated candidate pool and final selected catalog should be deterministic except for explicitly documented non-deterministic timing fields.

Avoid `Date.now()` and `Math.random()` in official forge identity or selection.

The generic browser generator may remain random where appropriate.

---

# 66. Separate Browser Generator From Official Forge

Do not accidentally force the browser generator to adopt expensive offline V2.2 evaluation.

Keep two profiles:

```text
interactive browser generator
    fast
    responsive
    best-effort

official catalog forge
    deterministic
    expensive
    highly selective
    reproducible
```

Share low-level components where useful, but do not constrain offline quality by browser latency.

---

# 67. Suggested Data Types

These names are illustrative.

```ts
export interface PuzzleCanonicalIdentity {
  exactHash: string;
  symmetryHash: string;
  canonicalRows: readonly string[];
}

export interface DifficultyDecision {
  action: "accept" | "reclassify" | "reject";
  difficulty?: Difficulty;
  reason: string;
  intended: Difficulty;
  legacyClassified: Difficulty;
}

export interface DependencyVerificationResult {
  totalEdges: number;
  realizedEdges: number;
  realizationRate: number;
  edgeDetails: readonly DependencyEdgeVerification[];
}

export interface DependencyEdgeVerification {
  edgeId: string;
  edgeType: DependencyEdge["type"];
  realized: boolean;
  confidence: "structural" | "observed" | "counterfactual";
  reason: string;
  evidence: readonly DependencyEvidence[];
}

export interface FinalistEvaluation {
  evaluatorVersion: number;
  objectives: CurationObjectives;
  solverEvidence: readonly SolverEvidence[];
}

export interface CatalogCandidate {
  puzzle: PuzzleDefinition;
  provenance: ForgeProvenance;
  identity: PuzzleCanonicalIdentity;
  evaluation: PuzzleEvaluationVector;
  difficultyDecision: DifficultyDecision;
  dependencyVerification?: DependencyVerificationResult;
  finalistEvaluation?: FinalistEvaluation;
}
```

---

# 68. Do Not Put Everything Into `puzzle-forge.ts`

`puzzle-forge.ts` already owns substantial behavior.

Do not grow it into a monolith.

Recommended new modules:

```text
src/features/generator/v2/
├── puzzle-identity.ts
├── forge-sampling.ts
├── puzzle-usage.ts
├── reachable-pushes.ts
├── interaction-analysis.ts
├── dependency-verification.ts
├── curation.ts
└── ...
```

Keep `puzzle-forge.ts` as orchestration.

---

# 69. Recommended Implementation Phases / Commits

Implement in small behaviorally coherent commits.

## Phase 1 — Identity foundation

Files likely touched:

```text
src/features/generator/v2/puzzle-identity.ts       NEW
src/features/generator/v2/index.ts
scripts/generate-v2-catalog.ts
tests/unit/puzzle-identity.test.ts                 NEW
```

Implement:

- canonical row trimming;
- hashes;
- V2 IDs;
- tests.

Do not regenerate catalog yet.

## Phase 2 — Forge sampling fix

Files:

```text
src/features/generator/v2/forge-sampling.ts        NEW
src/features/generator/v2/puzzle-forge.ts
tests/unit/puzzle-forge.test.ts
```

Implement:

- Cartesian combinations;
- deterministic scheduler;
- coverage diagnostics/tests.

## Phase 3 — Exact dedupe

Files:

```text
src/features/generator/v2/puzzle-identity.ts
src/features/generator/v2/puzzle-forge.ts
src/features/generator/v2/curation.ts              NEW or later
tests/unit/puzzle-forge.test.ts
```

Implement:

- canonical hash on candidate;
- exact duplicate rejection;
- symmetry duplicate policy if desired.

## Phase 4 — Correct evaluator semantics

Files:

```text
src/features/generator/v2/puzzle-usage.ts          NEW
src/features/generator/v2/reachable-pushes.ts      NEW
src/features/generator/v2/puzzle-evaluator.ts
tests/unit/puzzle-evaluator.test.ts
```

Implement:

- actual reference-solution floor usage;
- reachable push enumeration;
- renamed push-switch metric;
- update downstream references.

Do not tune weights yet.

## Phase 5 — Interaction analysis

Files:

```text
src/features/generator/v2/interaction-analysis.ts  NEW
src/features/generator/v2/puzzle-evaluator.ts
tests/unit/puzzle-evaluator.test.ts
```

Implement at least:

- shared route cells;
- shared support cells;
- chokepoint sharing;
- causal enable/disable counts if tractable.

Then revise forge quality terms.

## Phase 6 — Dependency identity + verification

Files:

```text
src/features/generator/v2/blueprint-types.ts
src/features/generator/v2/goal-placement.ts
src/features/generator/v2/motifs.ts
src/features/generator/v2/dependency-graph.ts
src/features/generator/v2/dependency-verification.ts  NEW
tests/unit/dependency-graph.test.ts
```

Implement:

- stable semantic goal IDs;
- evidence-based edge verification;
- stronger tests.

## Phase 7 — Mechanism-preserving tightening

Files:

```text
src/features/generator/v2/geometry-tightening.ts
src/features/generator/v2/structural-metrics.ts
src/features/generator/v2/puzzle-forge.ts
tests/unit/geometry-tightening.test.ts
```

Implement:

- preservation context;
- protected critical cells;
- room-capacity checks;
- fidelity checks;
- post-tightening semantic verification.

## Phase 8 — Atomic catalog generation

Files:

```text
scripts/generate-v2-catalog.ts
src/catalog/generated-puzzles.manifest.json       generated
tests/... catalog invariant tests
```

Implement:

- global cross-tier dedupe;
- difficulty decisions;
- quotas;
- retry seed windows;
- all-or-nothing writes;
- manifest.

Still do not publish catalog until dry-run report looks sane.

## Phase 9 — Stable benchmark fixtures

Files:

```text
tests/fixtures/generator/v1-generated-benchmark.json
tests/fixtures/generator/handcrafted-benchmark.json
scripts/generate-v2-catalog.ts or benchmark script
```

Remove misleading “V1 vs V2” behavior based on the mutable output file.

## Phase 10 — V2.2 finalist grading

Likely files:

```text
src/features/generator/v2/finalist-evaluator.ts    NEW
src/features/generator/v2/curation.ts
```

Implement multi-solver evidence behind an offline-only path.

## Phase 11 — Pareto + novelty selection

Replace final weighted ranking with:

```text
objective normalization
→ non-dominated fronts
→ novelty/diversity fill
```

Keep existing scalar score only as a debugging signal, possible tie-breaker, or backwards comparison.

## Phase 12 — Regenerate official catalog

Only now generate the new catalog.

New IDs must use `gen-v2-*`.

Run complete CI afterward.

---

# 70. Suggested Catalog Generation Flow After Refactor

The desired final flow is:

```text
for each difficulty tier
    ↓
construct Cartesian forge configuration schedule
    ↓
generate deterministic seed windows
    ↓
raw candidate
    ↓
validate
    ↓
initial semantic checks
    ↓
tighten with preservation context
    ↓
re-solve
    ↓
recompute evaluator
    ↓
reverify motifs/dependencies
    ↓
canonical identity
    ↓
exact/symmetry dedupe
    ↓
difficulty decision
    ↓
tier candidate pool

all tiers
    ↓
global cross-tier dedupe
    ↓
quota reconciliation
    ↓
finalist multi-solver evaluation
    ↓
Pareto fronts
    ↓
novelty/diversity selection
    ↓
deterministic ordering
    ↓
stable IDs + titles
    ↓
catalog audit
    ↓
atomic write:
    generated-puzzles.json
    generated-puzzles.manifest.json
```

---

# 71. Catalog Quota Reconciliation

Cross-tier dedupe and reclassification can create shortfalls.

Handle them intentionally.

Pseudo-process:

```ts
for each tier:
  while finalUniqueCount[tier] < target[tier]:
    request next deterministic seed window for tier
    generate/evaluate new candidates
    merge
    run global dedupe
    run difficulty decisions
```

If a candidate reclassifies to another tier, it may fill a vacancy there.

Avoid exceeding a tier quota until all tiers are reconciled.

Keep the process deterministic.

---

# 72. Difficulty Progression Within a Tier

After final candidates are selected, order them using a calibrated within-tier difficulty score.

Possible ingredients:

- pushes;
- solver effort percentile;
- decision branching;
- dependency depth;
- deadlock pressure;
- box count;
- tedium penalty.

This controls display order only.

It does not determine immutable identity.

---

# 73. Human Review Workflow

Automated metrics are not enough to prove “fun.”

After V2.2 can generate a clean catalog:

1. select a blinded sample of perhaps 5 puzzles per tier;
2. hide provenance/mode/seed;
3. play them manually;
4. score:
   - clarity;
   - strategic interest;
   - surprise;
   - meaningful choices;
   - tedium;
   - perceived difficulty;
   - visual intentionality;
   - willingness to keep in official catalog;
5. compare human scores with automated metrics.

Use this to tune the evaluator.

---

# 74. Quality Metrics Worth Logging

Per puzzle:

```text
solution moves
solution pushes
walk ratio
longest walk streak

reachable push choices:
    avg
    max
    forced ratio
    high-branch states

push-switch rate

causal interaction events
shared route cells
shared support cells
shared chokepoints

room crossings
articulation points
regions
tunnels
chokepoints
open area
floor utilization

reference-solution floor coverage
reference-solution unused floor

deadlock density

dependency:
    total
    realized
    depth
    confidence distribution

blueprint fidelity
room area preservation

solver evidence
```

Per population, report median and percentile bands, not only averages.

---

# 75. Metrics That Should Be Treated Carefully

Do not overinterpret:

## Solver elapsed time

Environment-sensitive.

## Raw solution length

Can measure distance/tedium rather than difficulty.

## Push-switch rate

Solution style, not causal dependency.

## Deadlock density

Solver-dependent and may reward pathological geometry if overweighted.

## Room count

More rooms does not automatically mean better puzzle.

## Reverse pull depth

Distance from solved state is not equivalent to strategic depth.

---

# 76. Acceptance Gates Should Be Tier-Aware but Not Tier-Defining

The forge gates should remove pathological candidates.

They should not be the entire definition of difficulty.

Good gates:

```text
minimum pushes
maximum tedium
maximum unused geometry
minimum solver effort floor
minimum interaction
minimum semantic realization for composed puzzles
```

Difficulty classification should happen separately after the puzzle has passed quality gates.

This keeps **quality** distinct from **difficulty**.

---

# 77. Add Configuration Schema Versioning

Because V2.1 changes selection semantics, capture configuration version.

Example:

```ts
interface ForgeConfig {
  schemaVersion: 2;
  ...
}
```

Manifest should record:

```text
forgeConfigSchemaVersion
evaluatorVersion
generatorVersion
curationVersion
```

This makes future catalog changes explainable.

---

# 78. Add Reproducibility Diagnostics

For every retained puzzle, be able to print:

```text
ID
seed
generator version
tier config
family
mode
box count
motif/composition
canonical hash
tightening mutations
evaluation summary
dependency summary
difficulty decision
```

A developer should be able to take one manifest entry and reproduce the candidate.

If exact one-seed reproduction is not possible because selection depends on a broader batch, document the distinction between **candidate reproduction** and **catalog-position reproduction**.

---

# 79. Avoid Throwing Away Failed Candidate Information

For large forge runs, rejection statistics are valuable.

Track counts by:

```text
reason
tier
family
mode
box count
```

This can reveal generator blind spots.

Example:

```text
nested + 7 + composed
    90% composition failure

loop + 5 + plain
    high duplicate rate
```

---

# 80. Add Combination-Level Reporting

The corrected sampler makes this especially useful.

Report:

```text
combination
attempted
raw-valid
tightened-valid
semantic-valid
retained
```

Then we can see whether certain topology/mode combinations are productive or systematically weak.

---

# 81. Geometry Diversity Metric

Add a board-structure fingerprint independent of provenance.

Possible features:

```text
trimmed width
trimmed height
floor count
wall/floor bitmap hash
region graph degree sequence
articulation count
tunnel count
room-size histogram
goal-room distribution
```

Use exact hash for hard dedupe.

Use structural feature distance for near-duplicate detection.

---

# 82. Near-Duplicate Detection

Exact dedupe is mandatory.

Near-duplicate detection can initially be diagnostic.

Possible signals:

```text
same trimmed wall layout but different robot
same wall + goal layout but different initial boxes
same region graph and >90% cell overlap
same board under small translation and one-cell mutation
```

Report these pairs.

Do not necessarily hard-reject all near duplicates until inspected.

---

# 83. Typed Boxes — Explicit Non-Goal for V2.1

The current official V2 catalog uses generic `X` and `S`.

Do not add first-class typed-box generation during this hardening pass.

That is a good future V3 feature because it introduces a genuinely new assignment/matching design dimension.

The identity and canonicalization utilities should nevertheless preserve typed symbols if present.

---

# 84. Documentation Updates

After implementation, update:

```text
docs/Sokomind_Puzzle_Generation_V2_Roadmap.md
docs/PUZZLE_GENERATOR_V2_IMPLEMENTATION_PLAN.md
docs/PROJECT-REFERENCE.md
README.md
```

Recommended status language:

```text
Generator V2.1:
quality/correctness hardening complete

Generator V2.2:
curation/validation complete
```

Also update any stale catalog count.

Avoid embedding a catalog number in prose without a source-checked mechanism if it will drift again.

---

# 85. README Count Drift

Add a check or generated documentation mechanism so catalog counts do not drift.

Options:

1. source-check README number in CI;
2. generate a short catalog stats block;
3. avoid exact count in README and point to live catalog stats.

Preferred: source-check or generate.

---

# 86. CI Integration

At minimum, normal PR CI should run:

```text
identity tests
sampling tests
evaluator semantic tests
dependency tests
tightening tests
catalog invariant test
```

Do not regenerate thousands of puzzles during every PR unless runtime is acceptable.

Use frozen deterministic fixtures in CI.

Run full offline forge generation in a manual, nightly, or release workflow if desired.

---

# 87. Optional Dedicated Generator Workflow

Potential workflow:

```text
.github/workflows/generator-validation.yml
```

Could run:

```text
unit tests
small deterministic forge matrix
catalog audit
benchmark fixtures
```

A manual dispatch could run a larger candidate batch and upload reports as artifacts.

Do not automatically commit generated catalog changes from CI.

---

# 88. Static Output Determinism

Avoid storing non-deterministic timestamps in committed manifest content unless needed.

If `generatedAt` causes noisy diffs, omit it from committed JSON and print timestamp only in console reports.

Stable generated artifacts are easier to review.

---

# 89. Error Handling Principles

Official forge should fail loudly when assumptions break.

Use clear messages.

Examples:

```text
CATALOG INVARIANT FAILED
tier=master
expected=20
actual=18
reason=insufficient qualifying unique candidates
```

```text
DUPLICATE CANONICAL BOARD
gen-v2-... and gen-v2-...
hash=...
```

```text
IMMUTABLE ID CONFLICT
id=gen-v2-...
existingHash=...
candidateHash=...
```

Avoid continuing after hard invariant failures.

---

# 90. Logging Levels

Consider structured categories:

```text
[forge]
[identity]
[dedupe]
[difficulty]
[dependency]
[tightening]
[curation]
[audit]
```

Keep verbose per-candidate logs behind a flag.

Default official run should summarize.

---

# 91. Dry Run Semantics

`--dry-run` should run the **entire pipeline**, including:

- quotas;
- dedupe;
- difficulty decisions;
- manifest construction;
- audits;

but should write nothing.

It should return non-zero if the candidate catalog would fail release invariants.

This makes it a meaningful preflight.

---

# 92. Suggested CLI Flags

Optional but useful:

```text
--dry-run
--report <path>
--tier master
--base-seed <n>
--batch-multiplier <n>
--max-seed-windows <n>
--no-symmetry-dedupe
--verbose
```

Do not overbuild CLI complexity unless useful.

---

# 93. Statistical Report for Each Generation

At end of a successful dry run, print:

```text
Generator version
Evaluator version
Candidate attempts
Valid after generation
Valid after tightening
Unique exact boards
Unique symmetry boards
Difficulty accepted/reclassified/rejected
Final retained
Tier quotas

Per tier:
    attempts
    unique finalists
    mode distribution
    family distribution
    box count
    median moves/pushes
    median branching
    median interaction
    median tedium
    median solver effort
```

Optionally write a machine-readable JSON report.

---

# 94. Comparison Against the Current 118-Puzzle Catalog

Before replacing it, audit the current catalog with the new tools.

Produce:

```text
exact duplicate pairs
symmetry duplicate pairs
cross-tier duplicates
difficulty reclassification distribution
true floor-use metrics
correct reachable-branching metrics
interaction metrics
```

This creates a useful before/after baseline.

Do not rely only on the existing V1/V2 comparison report.

---

# 95. Recommended Catalog Replacement Policy

Once V2.2 is ready:

- generate a completely new official generated set;
- use new immutable V2 IDs;
- do not attempt to preserve ordinal V2 IDs;
- retain old records only for boards proven identical;
- publish the new manifest;
- update README/project reference counts;
- run full browser/accessibility/solver CI.

The exact catalog total is less important than enforcing whatever target the configuration declares.

---

# 96. Do Not Optimize for “More Puzzles” Yet

A smaller set of clearly good generated puzzles is better than thousands of mediocre ones.

The V2 roadmap explicitly embraces aggressive rejection.

Keep that philosophy.

After quality is trustworthy, scale candidate generation, not acceptance rate.

---

# 97. Suggested Initial Candidate Scale After V2.2

Reasonable large-run starting ranges:

```text
tutorial:      2,000–5,000 attempts
beginner:      5,000–10,000
intermediate: 10,000+
advanced:     10,000+
expert:       10,000+
master:       10,000+
```

These are not strict requirements.

Use empirical retention/performance numbers to choose final scales.

The key principle is:

```text
generate many
retain very few
```

---

# 98. Quality Ablation Experiments

Once metrics are fixed, run controlled generation experiments.

Example variants:

```text
A: default V2.1
B: no geometry tightening
C: conservative tightening
D: no dependency reward
E: no interaction reward
F: no novelty selection
```

Compare population metrics and blinded human samples.

This tells us which pipeline stages genuinely contribute quality.

---

# 99. Architecture Boundary Requirements

Respect existing module-layer rules.

Generator V2 is under `features/generator`.

Avoid making low-level core puzzle rules depend on generator code.

Reuse canonical core game rules rather than implementing alternate movement logic.

Where possible, use existing canonical board/session helpers to replay moves.

If a new reusable push-enumeration helper belongs in core rather than generator, only move it there if it genuinely represents generic Sokoban rules and does not introduce a generator dependency.

---

# 100. Solver Trust Boundary

Any solution used for:

- catalog publication;
- metric generation;
- dependency verification;
- tightening acceptance;

must be replay-valid according to the repository's canonical verification expectations.

Do not treat solver-returned counters as sufficient proof that the route is valid.

If the solver infrastructure already has a canonical replay/verification utility, use it instead of duplicating route checking.

---

# 101. Avoid New Circular Dependencies

The repository has explicit AST-based module boundary and cycle tests.

Keep new modules directional.

Suggested dependency direction:

```text
identity
usage/reachable-push analysis
interaction analysis
dependency verification
        ↓
puzzle evaluator
        ↓
tightening / forge
        ↓
catalog script
```

Do not make low-level analysis import `puzzle-forge.ts`.

---

# 102. Backwards Compatibility

Do not change core puzzle format, solver contracts, or browser play mechanics unless a change is required for semantic goal identity.

Prefer V2-specific metadata outside `PuzzleDefinition`.

The runtime catalog should remain a normal array of `PuzzleDefinition`.

Provenance belongs in a sidecar.

---

# 103. What “Done” Means for V2.1

V2.1 is complete only when all of these are true:

- [ ] official generated puzzle IDs are immutable and V2-namespaced;
- [ ] canonical exact board normalization exists;
- [ ] global exact duplicate detection exists;
- [ ] forge samples the intended Cartesian parameter space;
- [ ] `unusedFloorRatio` semantics are corrected or renamed;
- [ ] reachable push branching is correctly measured;
- [ ] push-switch behavior is no longer called causal independence;
- [ ] at least one stronger box-interaction metric exists;
- [ ] dependency verification uses stable semantic goal identity;
- [ ] dependency semantics are stronger than completion-order coincidence;
- [ ] dependencies are reverified after tightening;
- [ ] tightening preserves semantic/structural context, not only solvability;
- [ ] final catalog generation enforces quotas;
- [ ] catalog generation fails atomically;
- [ ] provenance manifest is produced;
- [ ] difficulty mismatches have an enforceable policy;
- [ ] benchmark baseline no longer aliases the mutable output catalog;
- [ ] official catalog invariant tests catch exact duplicates;
- [ ] unit tests prove metric semantics, not only valid ranges.

---

# 104. What “Done” Means for V2.2

V2.2 is complete when:

- [ ] finalists receive independent multi-solver evidence;
- [ ] final selection is based on true multi-objective/Pareto logic;
- [ ] novelty selection includes geometry/mechanics/behavior;
- [ ] cross-tier calibration is stable;
- [ ] a catalog audit report is generated;
- [ ] large deterministic forge runs succeed;
- [ ] generated catalog has zero exact duplicates;
- [ ] configured tier quotas are exact;
- [ ] human blinded sample is materially better than the current V2.0 catalog;
- [ ] README/project-reference counts are correct;
- [ ] complete CI is green on the regenerated catalog.

---

# 105. Non-Goals

Do **not** include these in V2.1 unless absolutely necessary:

- typed-box procedural synthesis;
- full learned difficulty model;
- neural puzzle scoring;
- evolutionary mutation engine;
- MCTS generator rewrite;
- automatic motif discovery;
- replacing reverse beam search;
- rewriting core Sokoban rules;
- replacing the existing solver portfolio;
- huge UI work;
- adding dozens of new motifs before evaluation is trustworthy.

These are future opportunities.

---

# 106. Recommended First PR

## “Generator V2.1 foundation: stable identity, exact dedupe, and forge sampling”

Scope:

1. `puzzle-identity.ts`;
2. canonical trim/hash;
3. V2 immutable ID function;
4. `forge-sampling.ts`;
5. Cartesian schedule;
6. exact duplicate rejection;
7. focused tests;
8. no catalog regeneration.

This PR should be small enough to review confidently.

---

# 107. Recommended Second PR

## “Generator V2.1 evaluator correctness”

Scope:

1. reference-solution floor usage;
2. reachable push enumeration;
3. push-switch metric rename;
4. initial actual interaction metrics;
5. test fixtures with known semantics;
6. update forge gates/ranking only after metrics are stable.

---

# 108. Recommended Third PR

## “Generator V2.1 semantic preservation”

Scope:

1. goal identities;
2. dependency verifier;
3. post-tightening verification;
4. protected tightening cells;
5. blueprint-fidelity preservation;
6. semantic tightening tests.

---

# 109. Recommended Fourth PR

## “Generator V2.1 official catalog pipeline”

Scope:

1. difficulty policy;
2. global cross-tier dedupe;
3. quota continuation;
4. manifest;
5. atomic output;
6. frozen V1/handcrafted benchmark fixtures;
7. audit script;
8. catalog invariant tests.

After this PR, run a dry generation but still inspect results before committing a new official catalog.

---

# 110. Recommended Fifth PR

## “Generator V2.2 finalist curation”

Scope:

1. multi-solver finalist evaluator;
2. objective vector;
3. non-dominated sorting;
4. novelty selection;
5. population diagnostics.

---

# 111. Final Regeneration PR

The final regeneration PR should contain primarily generated/catalog artifacts and documentation updates.

Reviewers should be able to inspect:

```text
old vs new catalog counts
dedupe count
difficulty distribution
topology/mode distribution
quality metric distributions
representative puzzles
audit PASS
```

Avoid mixing major new generator code into the same PR as the new official catalog.

---

# 112. Commands / Validation Checklist

Adapt to current `package.json`, but at minimum run the existing validation ladder relevant to this repository.

Expected categories include:

```bash
npm ci
npm run typecheck
npm run lint
npm run lint:docs
npm run test:unit
npm run test:coverage
npm run build
npm run test:static
npm run test:browser
npm run test:solver:multi
npm run test:solver:proof-regressions
```

Also run any specific generator audit/generation scripts added by this work.

Do not claim success until the repository's full current CI-relevant suite is green.

---

# 113. Implementation Notes for Claude

When implementing this plan:

1. **Inspect current code before modifying it.** The repository is actively changing.
2. **Do not assume this handoff's proposed names are already present.**
3. **Preserve existing tests and architecture rules.**
4. **Add tests before or alongside behavior changes.**
5. **Do not regenerate the official catalog during early foundational PRs.**
6. **Do not reuse old generated IDs for new boards.**
7. **Do not loosen solver validation to make generation pass.**
8. **Do not reduce the V2 design into simpler random generation.**
9. **Do not add metrics unless their semantics are demonstrably testable.**
10. **Prefer interpretable metrics over opaque composite scores.**
11. **Keep official generation deterministic.**
12. **Use existing canonical puzzle/game rules when replaying states.**
13. **Record why candidates are rejected.**
14. **Treat post-tightening puzzle state as authoritative for final evaluation.**
15. **If an intended mechanism cannot be verified, do not claim it is realized.**

---

# 114. Core Principle to Keep in Mind

The main failure mode of procedural puzzle generation is not:

> “The generator cannot produce solvable puzzles.”

Sokomind already does that.

The main failure mode is:

> “The generator produces thousands of valid puzzles but cannot reliably distinguish authored-feeling strategic puzzles from structurally shallow ones.”

Generator V2 already has the right front-half architecture for solving that problem.

The work in V2.1 and V2.2 should therefore focus on making the back half of the system trustworthy:

```text
measure correctly
preserve intended mechanisms
sample the real design space
deduplicate by actual board identity
calibrate difficulty
select diverse quality
publish atomically
```

Once those are in place, we can finally judge the true quality ceiling of Generator V2.

Only after that should the project decide what conceptual leap deserves the name **Generator V3**.

---

# 115. Final Priority Order

If time or scope must be reduced, implement in this exact order.

## P0 — correctness / safety

1. immutable V2 puzzle IDs;
2. canonical exact-board hashing;
3. exact duplicate rejection;
4. Cartesian/stratified forge sampling;
5. atomic catalog generation;
6. exact tier quota enforcement.

## P1 — evaluator correctness

7. real solution floor usage;
8. reachable-push branching;
9. rename push-switch proxy;
10. stronger interaction metrics.

## P1 — semantic preservation

11. stable semantic goal identity;
12. stronger dependency verification;
13. reverify after tightening;
14. mechanism-preserving tightening.

## P2 — calibration

15. enforce difficulty mismatch policy;
16. frozen benchmark fixtures;
17. catalog audit report.

## P2 — advanced curation

18. multi-solver finalist grading;
19. Pareto/non-dominated selection;
20. novelty/structural diversity selection.

## P3 — future work

21. typed-box generator;
22. evolutionary generation;
23. learned human-quality model;
24. Generator V3.

---

# 116. Desired End State

A successful V2.2 catalog build should be able to make the following claims truthfully:

> Every published generated puzzle has an immutable content identity.

> No two published generated puzzles are exact canonical duplicates.

> The forge actually explored the declared topology × box-count × generation-mode space.

> Difficulty labels passed an explicit calibration policy.

> Branching metrics describe pushes reachable by the keeper, not only immediately adjacent pushes.

> “Unused floor” describes solution usage rather than blank initial cells.

> Box interaction metrics include causal/shared-resource evidence rather than merely solver push alternation.

> Composed puzzle dependency claims are checked against the final post-tightening puzzle.

> Tightening cannot silently destroy the mechanism that caused a puzzle to be selected.

> The configured catalog quotas are met exactly or generation fails.

> The catalog and its provenance manifest are produced atomically.

> Final selection rewards multiple forms of puzzle quality rather than one weighted morphology.

> The official catalog can be reproduced and audited.

That is the standard Generator V2 should meet before moving on to Generator V3.
