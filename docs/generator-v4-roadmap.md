# Sokomind Generator V4 Roadmap

**Project:** SokomindSolver  
**Repository:** `Willpatpost/SokomindSolver`  
**Primary area:** procedural puzzle generation / catalog generation  
**Status:** implementation roadmap  
**Target version:** Generator V4

---

## 1. Purpose

Generator V4 should turn the current procedural generator from a fast catalog-filling system into a quality-first Sokoban puzzle generator capable of producing a large, varied library of genuinely enjoyable puzzles across all difficulty levels.

The current generator is technically sophisticated in several areas, but its incentives and pipeline structure are misaligned with the desired product. It is currently optimized to:

- generate many small solvable boards quickly;
- fit candidates into fixed tier quotas;
- reduce unused floor aggressively;
- prefer relatively compact solutions;
- assign dedicated box labels to nearly every generated puzzle;
- retain candidates early before expensive evaluation;
- use a reverse-search heuristic that favors visually/structurally interesting scramble states but does not directly optimize final human puzzle quality.

The desired V4 generator should instead optimize for:

- **fun, deliberate Sokoban design**;
- **larger and more meaningful playing areas** on harder tiers;
- **more boxes and deeper box interactions**;
- **generic, typed, and hybrid box/goal puzzles**;
- **complete outer wall framing**;
- **genuinely difficult solutions**, especially at Expert and Master;
- **multiple interacting mechanisms in one puzzle**;
- **quality-first offline search**, even when producing one excellent puzzle requires significant computation;
- **trustworthy post-transformation metrics**, so every score describes the exact puzzle that ships;
- **strong deterministic provenance, verification, invariants, and regression tests**.

The generator may take a long time to create difficult puzzles. That is acceptable. Runtime during offline catalog generation is secondary to puzzle quality.

---

# 2. High-level diagnosis

The current output quality problem is not caused by one small parameter. Several systems reinforce each other in the wrong direction.

The most important problems are:

1. all generated puzzles are effectively converted to dedicated typed boxes/goals;
2. final catalog canonicalization strips the protective outer wall frame;
3. harder tiers increase nominal canvas size without increasing actual architectural scale;
4. geometry tightening removes too much playable space;
5. the scoring system rewards compactness and saturates too early on boxes/pushes;
6. Master is explicitly limited to only 6–8 boxes;
7. tier-specific reverse-search depth is ignored by motif/composed generation paths;
8. the reverse beam search is too narrow and too weakly related to final puzzle difficulty;
9. topology generation is mostly random room placement joined by simple passages;
10. motif selection and composition are too repetitive;
11. dependency verification happens before later geometry mutation and can become stale;
12. puzzle metrics are computed before box labeling and therefore may not describe the final puzzle;
13. the candidate pool is reduced too early, leaving little or nothing for expensive final curation to select;
14. the difficulty policy permits obviously under-tiered puzzles to ship as Master;
15. current difficulty classification is dominated by move/push/box thresholds rather than human reasoning complexity;
16. novelty distance is not normalized and can be distorted by incompatible metric scales.

V4 should address all of these as one coherent pipeline redesign.

---

# 3. Relevant current files

The following files are central to V4 and should be reviewed before implementation begins.

## Generator orchestration

- `scripts/generate-v2-catalog.ts`
- `src/features/generator/v2/puzzle-forge.ts`
- `src/features/generator/v2/forge-sampling.ts`

## Geometry and topology

- `src/features/generator/v2/blueprint-types.ts`
- `src/features/generator/v2/blueprint-graph.ts`
- `src/features/generator/v2/room-roles.ts`
- `src/features/generator/v2/goal-placement.ts`
- `src/features/generator/v2/geometry-tightening.ts`
- `src/features/generator/v2/structural-metrics.ts`

## Reverse generation

- `src/features/generator/reverse-play.ts`
- `src/features/generator/v2/reverse-beam-search.ts`
- `src/features/generator/v2/reverse-scoring.ts`

## Motifs / dependencies

- `src/features/generator/v2/motifs.ts`
- `src/features/generator/v2/dependency-graph.ts`
- `src/features/generator/v2/dependency-verification.ts`

## Evaluation and curation

- `src/features/generator/v2/puzzle-evaluator.ts`
- `src/features/generator/v2/finalist-evaluator.ts`
- `src/features/generator/v2/curation.ts`
- `src/features/generator/difficulty-classifier.ts`

## Identity / output

- `src/features/generator/v2/puzzle-identity.ts`
- `src/features/generator/label-assignment.ts`
- `src/catalog/generated-puzzles.json`
- `src/catalog/generated-puzzles.manifest.json`

## Tests

- `tests/unit/catalog-generation.test.ts`
- other generator unit/performance tests under `tests/`

Do not assume every V4 implementation must remain in a `v2` directory. Renaming can happen late in the roadmap after behavior is stable.

---

# 4. Current defects in detail

## 4.1 No real generic-box generation

### Current behavior

`ForgeConfig` contains:

```ts
readonly useLabels: boolean;
```

`DEFAULT_FORGE_CONFIG` sets:

```ts
useLabels: true
```

Every tier inherits this unless explicitly overridden. Once a generic puzzle is solved, `assignLabels()` attempts to replace every `X`/`S` pair with a dedicated uppercase/lowercase label pair.

As a result, generated catalog puzzles are overwhelmingly or entirely typed.

### Why this is wrong

Sokomind supports three useful puzzle styles:

1. **generic** — all boxes are `X`, all goals are `S`;
2. **typed** — all boxes/goals use dedicated pairs (`A/a`, `B/b`, etc.);
3. **hybrid** — some boxes are generic and some are typed.

Grand Hall demonstrates that hybrid puzzles can be especially interesting.

The generator should deliberately produce all three styles.

### Required fix

Replace `useLabels: boolean` with an explicit box-typing policy.

Suggested type:

```ts
export type BoxTypingMode = "generic" | "typed" | "hybrid";

export interface BoxTypingPolicy {
  readonly modes: readonly BoxTypingMode[];
  readonly hybridTypedFractionMin: number;
  readonly hybridTypedFractionMax: number;
}
```

Each generated candidate should deterministically select a mode from its tier policy and seed.

For `hybrid`:

- derive full box-to-goal pairing from a known valid solution;
- choose a deterministic subset of box/goal pairs to type;
- leave all other pairs generic `X/S`;
- preserve at least one generic pair and one typed pair;
- validate after transformation;
- replay a known solution after transformation;
- re-evaluate the transformed puzzle.

### Acceptance criteria

- catalog includes generic, typed, and hybrid puzzles;
- distribution is configurable per tier;
- manifest records `typingMode` and typed/generic pair counts;
- generated hybrid puzzles pass canonical replay validation;
- tests prove all three modes can be produced deterministically.

---

# 4.2 Outer wall frame is removed from final catalog puzzles

### Current behavior

Blueprint generation correctly keeps floor away from the true board edge, and geometry tightening refuses to remove outermost cells.

However, `canonicalizeRows()` removes all-wall padding rows and columns. The catalog conversion currently calls `canonicalizeRows()` on the actual puzzle rows before writing them.

This means the canonicalization helper that was intended for identity/deduplication becomes a destructive serialization step.

The result is generated puzzles where:

- the player can touch the puzzle boundary;
- goals or boxes can touch the boundary;
- some rows begin/end on open floor instead of walls.

### Required fix

Separate **identity canonicalization** from **catalog rendering**.

Keep `canonicalizeRows()` for hashing and symmetry comparison only.

Add a new helper, for example:

```ts
export function framePuzzleRows(rows: readonly string[]): readonly string[]
```

Desired behavior:

1. normalize ragged rows with walls;
2. optionally trim redundant wall-only padding outside the actual board;
3. calculate the bounding box of all non-wall cells;
4. expand that box by exactly one cell on each side;
5. emit a rectangular board where every perimeter cell is `O`.

If expansion reaches outside the source array, synthesize `O` cells.

Do **not** modify playable interior geometry.

### New invariant

Every generated catalog puzzle must satisfy:

- first row all `O`;
- last row all `O`;
- first character of every row is `O`;
- last character of every row is `O`.

Add this to catalog invariant checks and unit tests.

### Acceptance criteria

No generated puzzle can ship without a complete wall barrier around the perimeter.

---

# 4.3 Hard-tier canvas size does not translate into actual board size

### Current behavior

Master currently requests a board around 18×18, but the blueprint defaults still use approximately:

- 2–5 rooms;
- 3–5 cells width/height per room;
- passage width 1.

This creates a larger empty canvas containing nearly the same amount of actual architecture as lower tiers.

### Required fix

Introduce explicit per-tier **geometry profiles** rather than changing only `boardWidth` and `boardHeight`.

Suggested structure:

```ts
export interface GeometryProfile {
  readonly boardWidthRange: readonly [number, number];
  readonly boardHeightRange: readonly [number, number];
  readonly minRooms: number;
  readonly maxRooms: number;
  readonly minRoomSize: number;
  readonly maxRoomSize: number;
  readonly passageWidths: readonly (1 | 2)[];
  readonly minPlayableFloor: number;
  readonly maxPlayableFloor?: number;
  readonly minFloorCoverage: number;
  readonly minRegions: number;
  readonly minChokepoints: number;
}
```

Initial targets should be tuned empirically, but a reasonable starting direction is:

| Tier | Boxes | Playable floor | Rooms | Board scale |
|---|---:|---:|---:|---|
| Tutorial | 1–3 | 10–30 | 1–3 | small |
| Beginner | 2–5 | 20–45 | 2–4 | small-medium |
| Intermediate | 3–7 | 35–70 | 3–6 | medium |
| Advanced | 5–10 | 50–95 | 4–8 | medium-large |
| Expert | 7–15 | 70–130 | 5–10 | large |
| Master | 10–20 | 95–180+ | 6–12 | large / very large |

These are not permanent balancing values. They are initial engineering targets to prevent tiny hard-tier boards.

### Acceptance criteria

- hard-tier puzzles cannot pass with tiny playable areas;
- Master should be capable of boards in the same broad scale class as Grand Hall;
- tier config controls actual architecture, not only outer canvas dimensions;
- manifest records final board dimensions, playable floor count, and floor coverage.

---

# 4.4 Geometry tightening removes too much useful space

### Current behavior

`tightenPuzzle()` can accept a large number of floor-to-wall mutations. The default maximum accepted count is high relative to the generated boards.

The current call site does not supply the preservation context supported by the tightening module.

There is no hard-tier minimum playable area guard.

### Why this hurts puzzle quality

Unused floor is not automatically bad.

Good Sokoban puzzles need:

- staging squares;
- temporary parking;
- maneuvering lanes;
- alternative routes;
- support squares behind boxes;
- room for box interactions to unfold.

Aggressively deleting floor because one current Greedy solution does not use it can simplify the puzzle or destroy potential strategic depth.

### Required fix

V4 should change tightening from **aggressive compression** to **structure-aware refinement**.

For Expert/Master, start conservatively:

- much lower `maxAccepted`;
- no removal from protected rooms/passages;
- preserve all cells used by verified dependencies;
- preserve staging zones;
- preserve alternate robot access lanes where possible;
- enforce `minPlayableFloor` and `minFloorCoverage` after each mutation;
- reject any mutation that materially reduces structural complexity.

Use `buildPreservationContext()` or expand it.

Recommended new protected categories:

- perimeter wall frame;
- entity cells;
- solution path cells;
- passage cells;
- chokepoint neighborhoods;
- dependency evidence cells;
- motif-defined staging cells;
- cells important to multiple reachable box-support configurations.

Consider disabling tightening entirely for Master during early V4 development until quality metrics are trustworthy.

### Acceptance criteria

- tightening cannot reduce a puzzle below tier geometry floors;
- composed/motif dependencies are re-verified afterward;
- structural richness cannot regress beyond explicit limits;
- before/after metrics are retained in provenance.

---

# 4.5 Current scoring rewards compactness more than deep difficulty

### Current behavior

Early `paretoScore()` rewards:

- low box independence;
- low unused floor;
- low empty walking;
- some box interaction;
- pushes, but only up to a relatively small cap.

Final curation similarly saturates structural box-count reward around a small number of boxes and push challenge around relatively modest push counts.

### Problem

The scoring function does not meaningfully distinguish:

- a 6-box puzzle from a 17-box puzzle;
- a 30-push solution from a 90-push solution;
- shallow sequencing from multi-stage dependencies;
- monotonic solving from temporary displacement and restoration;
- a single motif from several interacting mechanisms.

### Required fix

Do not attempt to solve V4 by simply increasing caps.

Redesign candidate quality into separate dimensions and avoid collapsing them too early.

Recommended dimensions:

### Structural scale

- box count;
- playable floor count;
- board footprint;
- regions;
- articulation points;
- chokepoints;
- tunnels;
- room size diversity;
- passage diversity;
- open-area versus constrained-area balance.

### Solution depth

- solution moves;
- solution pushes;
- pushes per box;
- number of distinct boxes moved;
- number of boxes moved multiple separated times;
- number of non-monotonic box episodes;
- number of staging operations;
- number of box switches;
- path reuse.

### Human reasoning complexity

- reachable legal push count at decision points;
- number of plausible but losing branches;
- deadlock pressure;
- dependency-chain length;
- number of interacting dependency chains;
- temporary displacement requirement;
- gate reopening requirement;
- packing-order constraints;
- shared passage contention;
- support-square contention;
- box-order ambiguity;
- goal-assignment ambiguity for generic boxes;
- route crossings;
- multi-room transport.

### Tedium

Keep explicit penalties for:

- huge empty walking stretches;
- repetitive straight pushes without decisions;
- large unused decorative areas;
- trivially independent boxes;
- artificial solver difficulty that adds no interesting decisions.

### Acceptance criteria

Final selection should be multi-objective. A puzzle should not become “Master” solely because one solver expanded many states.

---

# 4.6 Master box count is artificially capped at 6–8

### Current behavior

The current Master tier uses box counts `[6, 7, 8]`.

### Required fix

Raise box capacity by tier.

Suggested initial V4 ranges:

```text
Tutorial:     1–3
Beginner:     2–5
Intermediate: 3–7
Advanced:     5–10
Expert:       7–15
Master:      10–20
```

These ranges should overlap. Difficulty must not be determined by box count alone.

Ensure `VALID_LABELS` capacity is considered for fully typed puzzles. For puzzles above the available dedicated-label count, either:

- force generic/hybrid mode;
- or extend label support only if the entire core/UI format supports it safely.

Do not increase symbol semantics casually.

### Acceptance criteria

The generator must be able to create Grand-Hall-scale box counts without special-case code.

---

# 4.7 Tier beam parameters are ignored for motif/composed generation

### Current behavior

Plain generation receives the tier's `beamParams`.

Motif and composed generation call helpers without passing those tier-specific settings, causing them to use much shallower internal defaults.

This means a Master tier that claims `maxDepth: 80` can still create motif puzzles with a depth around 25 and composed puzzles around 30.

### Required fix

Pass the complete beam/search policy into **all** generation modes.

Example:

```ts
generateVerifiedMotifPuzzle(fb, {
  seed,
  boxCount,
  motif: motifChoice,
  beamParams: {
    ...DEFAULT_BEAM_PARAMS,
    ...config.beamParams,
    seed,
  },
});
```

Do the equivalent for composed generation.

Add a regression test that uses a distinctive configured beam depth and confirms all modes receive it.

### Acceptance criteria

No generation mode may silently replace tier search settings with shallower defaults.

---

# 4.8 Reverse beam search is not strong enough for quality-first hard generation

### Current behavior

The reverse search uses a small beam and scores states using static features such as:

- boxes off goals;
- room crossings;
- dispersion;
- chokepoint occupancy;
- tunnel occupancy;
- distance from solved;
- box adjacency/support constraints.

It does not directly evaluate the resulting forward puzzle while searching.

### Specific weaknesses

#### Beam width too small

A beam width around single digits is appropriate for quick generation, not for searching rare high-quality Master puzzles.

#### State identity ignores keeper region

`stateFingerprint()` uses only box positions.

Two states with identical box positions but different reachable robot regions can have different legal reverse continuations. They should not automatically collapse to one state.

#### No robust global transposition structure

Search can revisit equivalent arrangements at different depths.

#### Seed does little inside beam search

The search itself is mostly deterministic once a solved board is fixed. This limits diversification across restarts.

#### Static scoring is only indirectly related to difficulty

A box near a chokepoint may look promising without creating a meaningful forward dependency.

### Required V4 reverse-search redesign

Introduce a new search state identity:

```ts
interface ReverseStateKey {
  boxPositionsCanonical: string;
  keeperRegionCanonical: string;
  typingRelevantAssignment?: string;
}
```

Keeper position itself may be overly specific; canonical reachable keeper region is usually more meaningful.

Add:

- global transposition table;
- best-known score/depth per state;
- immediate inverse/undo suppression where safe;
- history-aware scoring;
- stochastic tie breaking driven by seed;
- random/restart search modes;
- much wider configurable beams;
- adaptive beam width;
- per-tier search time/state budgets;
- optional Monte Carlo / best-first continuation from promising states;
- ability to retain many candidate scramble states from one solved template.

Recommended Master search strategy:

1. create a promising solved architecture;
2. run many reverse-search restarts;
3. retain a large archive of diverse scramble states;
4. cheaply pre-screen them;
5. forward-evaluate only the strongest subset;
6. continue search around promising families if desired.

### Important principle

Generation should be allowed to spend substantial computation on one board.

A command such as:

```bash
npm run generate:v4 -- --tier master --quality high --target 1
```

may legitimately run a long search if that produces a much better puzzle.

---

# 4.9 Topology generation is too weakly tied to intended mechanics

### Current behavior

The blueprint layer selects graph families such as linear/hub/loop/branch/nested, places rooms relatively independently, then joins room centers with Manhattan passages.

This generates variation but does not deliberately construct difficult Sokoban geometry.

### Required fix

Create a distinction between:

1. **graph topology**;
2. **spatial layout**;
3. **mechanical topology**.

Mechanical topology should describe intended interactions before geometry is finalized.

Examples:

- a gate corridor that must remain open until another box passes;
- two rooms sharing a scarce transit lane;
- a packing room requiring back-to-front fill;
- an exchange chamber requiring boxes to swap sides;
- a temporary parking bay required before final placement;
- a one-way-feeling staging sequence;
- multiple feeder rooms into one constrained destination;
- a central hub whose access changes as boxes are solved;
- a deep goal chain with supporting squares that overlap.

Then geometry should be synthesized to satisfy those mechanics.

### Add new topology/mechanism families

Potential additions:

- `warehouse-grid`
- `crossroads`
- `multi-wing`
- `concentric`
- `interlocking-loops`
- `packing-hall`
- `gate-network`
- `exchange-network`
- `multi-stage-transport`

These names are only examples. Prefer a small number of meaningful, tested families over many shallow names.

### Acceptance criteria

Hard-tier geometry should visibly contain multiple purposeful rooms, lanes, bottlenecks, and staging spaces rather than mostly tiny disconnected shapes connected by basic corridors.

---

# 4.10 Motifs and compositions are too repetitive

### Current behavior

Available motifs include roughly:

- packing order;
- doorway traffic;
- staging dependency;
- gatekeeper.

Compositions combine a small number of these patterns.

Automatic motif selection can repeatedly favor doorway traffic.

### Required fix

V4 should support **mechanism portfolios** rather than one motif label per puzzle.

A hard puzzle should be able to require several of:

- packing order;
- temporary staging;
- cross-room transport;
- gate opening/closing;
- gate reopening;
- shared corridor scheduling;
- box-order inversion;
- parking displacement;
- forced unsolving/re-solving of a goal;
- exchange room;
- multiple dependencies on one box;
- dependency chain of length 3+;
- two independent chains that later interact;
- generic-box assignment ambiguity;
- typed-box route crossing;
- competing support squares.

Represent this explicitly.

Suggested types:

```ts
interface MechanismPlan {
  readonly mechanisms: readonly MechanismSpec[];
  readonly intendedDependencies: readonly DependencyEdge[];
  readonly requiredEvidence: readonly MechanismEvidenceRequirement[];
}
```

Do not award quality points merely because a motif was requested. Award them only after the final puzzle solution provides evidence that the mechanism actually exists.

---

# 4.11 Dependency verification becomes stale after tightening

### Current behavior

Composed puzzles verify dependencies before returning from their generation helper.

`runForge()` then tightens the puzzle.

The old dependency realization score remains attached to the candidate.

### Required fix

Any transformation that changes board semantics or geometry must invalidate downstream analysis.

Required stage order:

```text
raw architecture
→ goals / mechanism plan
→ reverse generation
→ build generic puzzle
→ optional geometry refinement
→ box typing transformation
→ FINAL validation
→ FINAL solver/replay evaluation
→ FINAL dependency/mechanism verification
→ difficulty classification
→ curation
→ catalog serialization
```

No dependency metric calculated before geometry/typing mutation may be used for final selection.

### Acceptance criteria

All manifest dependency metrics describe the exact rows written to `generated-puzzles.json`.

---

# 4.12 Metrics describe the generic pre-label puzzle, not the final typed puzzle

### Current behavior

The pipeline currently:

1. evaluates generic puzzle;
2. applies gates;
3. assigns labels;
4. stores original evaluation vector alongside the labeled puzzle.

### Why this matters

Typing changes the puzzle semantics.

In a generic puzzle, boxes can be assigned to any generic goal. In a typed puzzle, each dedicated box has a specific destination.

This can change:

- optimal solution;
- Greedy solution;
- assignment ambiguity;
- search state count;
- reachable decisions;
- route crossings;
- box interaction;
- difficulty classification.

### Required fix

After all typing operations:

- validate final puzzle;
- replay the known solution if it should remain valid;
- solve/evaluate final puzzle;
- apply quality gates using final metrics;
- classify difficulty using final metrics;
- use final metrics in manifest and curation.

If generic evaluation is useful for constructing the pairing, store it as `preTypingEvaluation` for diagnostics only.

### Acceptance criteria

No final score or difficulty label may rely on stale pre-typing metrics.

---

# 4.13 Candidate retention happens too early

### Current behavior

Each tier may attempt hundreds of raw candidates, but `runForge()` immediately selects only approximately `retainTarget` candidates, often 20.

The later expensive finalist/Pareto stage then sees around 20 candidates for a quota of 20 and therefore has little or nothing to cull.

### Required fix

Separate these concepts:

- `rawAttemptBudget`
- `preScreenRetain`
- `finalistRetain`
- `catalogQuota`

Example Master pipeline:

```text
20,000 raw attempts
→ 2,000 valid structural candidates
→ 500 cheap-quality survivors
→ 100 forward-evaluated finalists
→ 40 deep-evaluated finalists
→ 20 catalog winners
```

The exact counts should be configurable and may be much smaller during CI/testing.

### Add generation quality presets

Suggested CLI presets:

```text
--quality smoke
--quality standard
--quality high
--quality exhaustive
```

Example meanings:

- `smoke`: deterministic tiny budgets for tests;
- `standard`: normal developer generation;
- `high`: long catalog-quality generation;
- `exhaustive`: intentionally expensive search for exceptional puzzles.

### Acceptance criteria

The final expensive quality stage must choose among materially more candidates than the final quota.

---

# 4.14 Difficulty policy allows obviously under-tiered Master puzzles

### Current behavior

The code permits a very large mismatch between intended and classified difficulty before rejecting a candidate.

The existing test text states a stricter policy than the real implementation.

Current Master examples are frequently classified as Advanced or Expert yet still shipped as Master.

### Required fix

Remove quota-driven lying about difficulty.

A puzzle's displayed difficulty should be based primarily on its final measured difficulty, not the tier generation request.

Recommended policy:

1. generation tier is a **search target**, not a guaranteed label;
2. after final evaluation, classify the actual candidate;
3. accept into a tier only if classification is inside the allowed tolerance;
4. if a candidate misses the tier, either reclassify it or reject it;
5. never keep a badly mismatched candidate merely to fill quota;
6. generate more candidates instead.

At minimum, reconcile the existing contradiction and make the policy test call the actual implementation.

### Acceptance criteria

A Master catalog slot should never be filled by an obviously Advanced puzzle because a quota was short.

---

# 4.15 Difficulty classification is too simple

### Current behavior

Classification is mainly based on thresholds for:

- solution moves;
- solution pushes;
- box count.

### Required fix

Create V4 difficulty scoring based on a richer feature vector.

Do not necessarily replace the existing classifier immediately. Build a new classifier alongside it and compare results against handcrafted puzzles.

Candidate feature set:

```text
box count
playable floor
solution moves
solution pushes
pushes per box
solver effort
reachable push branching
forced-push ratio
box switch rate
causal enable/disable count
shared route cells
shared support cells
shared chokepoint uses
room crossings
region count
chokepoints
deadlock pressure
packing dependencies
verified dependency chain depth
non-monotonic box moves
temporary goal vacating
staging operations
assignment ambiguity
goal-order constraints
```

### Calibration strategy

Use handcrafted puzzles as anchors.

Do not assume their existing difficulty labels are perfect, but use them as a useful reference set.

Add a benchmark report showing where generated puzzles fall relative to known handcrafted examples such as:

- simple tutorials;
- established intermediate puzzles;
- Expert Tetris;
- Grand Hall.

### Acceptance criteria

Difficulty should correspond more closely to perceived reasoning challenge, not just length.

---

# 4.16 Novelty scoring uses incompatible raw scales

### Current behavior

Curation computes Euclidean distance over raw objective dimensions that have different numerical scales.

### Required fix

Normalize dimensions over the candidate population before novelty distance.

Preferred methods:

- robust rank normalization;
- percentile normalization;
- min-max with clipping;
- robust z-score.

Rank/percentile normalization is attractive because generator metric distributions can be highly skewed.

Then compute k-nearest-neighbor novelty.

### Also fix

`CurationObjectives.novelty` is currently effectively separate from the actual `noveltyScore` field. Simplify this model so there is one clear source of novelty truth.

---

# 5. Target V4 pipeline

The completed V4 pipeline should look approximately like this.

```text
1. Select tier + generation quality profile
2. Sample geometry/mechanism plan
3. Build structural blueprint at tier-appropriate scale
4. Assign room roles / mechanism constraints
5. Place goals in a solved architecture
6. Run deep reverse-generation search
7. Archive many diverse reverse states
8. Build generic candidate puzzles
9. Cheap structural validation / pre-screen
10. Structure-aware geometry refinement (optional)
11. Apply generic / typed / hybrid box policy
12. Validate exact final rows
13. Replay known witness solution where applicable
14. Final forward solver evaluation
15. Final mechanism/dependency verification
16. Final difficulty classification
17. Hard quality gates
18. Cross-tier / exact / symmetry dedup
19. Deep finalist evaluation
20. Normalized multi-objective Pareto + novelty curation
21. Select final quota
22. Frame board with complete wall perimeter
23. Revalidate serialized rows
24. Write catalog + detailed manifest
25. Run generated-catalog invariant suite
```

A key V4 principle is:

> **Every analysis used to decide whether a puzzle ships must describe the exact final puzzle that ships.**

---

# 6. Recommended implementation phases

## Phase 0 — Protect the existing system

Before major changes:

- preserve the current generated catalog as a fixture or tag if not already preserved;
- ensure the project has a clean passing baseline;
- create a Generator V4 branch if desired;
- add deterministic smoke-generation fixtures to make iteration fast.

Do not regenerate the production catalog after every intermediate phase.

---

## Phase 1 — Correctness and serialization fixes

### Goals

Fix defects that make the current catalog semantically or visually wrong.

### Tasks

1. split identity canonicalization from final row serialization;
2. add complete perimeter frame helper;
3. add frame invariant tests;
4. replace `useLabels` with typing policy;
5. support generic, typed, hybrid generation;
6. pass tier beam parameters into plain/motif/composed paths;
7. move final evaluation after all transformations;
8. re-run dependency verification after tightening/typing;
9. reconcile difficulty mismatch policy and its tests.

### Required tests

- `framePuzzleRows()` always creates all-wall perimeter;
- framing does not alter internal playable geometry;
- `boardHash()` remains padding-invariant;
- generic mode emits `X/S` and no dedicated labels;
- typed mode emits dedicated pairs;
- hybrid mode emits at least one generic and one typed pair;
- known solution remains replay-valid after typing;
- post-typing evaluation is used in candidate output;
- motif/composed paths inherit configured beam depth;
- dependency score is recalculated after mutation;
- difficulty policy integration test calls actual policy code.

### Phase 1 completion definition

The pipeline is trustworthy even if puzzle quality is not yet dramatically improved.

---

## Phase 2 — Tier geometry and scale redesign

### Goals

Make harder tiers genuinely larger and more spatially rich.

### Tasks

1. add `GeometryProfile` to tier configuration;
2. allow tier-specific room count ranges;
3. allow tier-specific room-size ranges;
4. allow mixed passage widths;
5. add minimum playable-floor gates;
6. add minimum board coverage gates;
7. add structural minimums for high tiers;
8. make large board architecture more likely, not merely possible;
9. increase upper-tier box-count ranges.

### New structural gates

Potential fields:

```ts
minPlayableFloor
minFloorCoverage
minRegionCount
minChokepoints
minArticulationPoints
minRoomCount
minLargeRoomCount
minBoxDensity
maxBoxDensity
```

Use them carefully. Hard gates should prevent clearly bad boards, not overfit every puzzle to one shape.

### Phase 2 completion definition

Master candidate boards routinely contain large playable areas and enough boxes/regions for complex interaction before reverse search even starts.

---

## Phase 3 — Structure-aware refinement instead of aggressive tightening

### Goals

Stop destroying useful hard-puzzle geometry.

### Tasks

1. lower or disable tightening for hard tiers initially;
2. wire preservation context into `runForge()`;
3. protect mechanism-critical cells;
4. add floor/region/chokepoint preservation constraints;
5. recompute all final metrics after refinement;
6. re-verify mechanisms afterward;
7. log why each accepted mutation was safe.

### Optional later improvement

Replace subtractive tightening with **local geometry mutation search** that can both add and remove walls while preserving solvability and increasing quality.

For example:

- add an alcove;
- narrow a passage;
- widen a staging room;
- create/remove one alternate route;
- shift a wall to create a support-square constraint.

This would be more powerful than pure deletion.

---

## Phase 4 — Reverse-generation search V4

### Goals

Make reverse generation capable of spending real computation to find deep, interesting states.

### Tasks

1. implement keeper-region-aware state keys;
2. implement global transposition table;
3. add configurable beam width per tier/quality mode;
4. add configurable max expanded states / elapsed time;
5. add deterministic stochastic tie-breaking;
6. add multi-restart search;
7. retain an archive of diverse candidate states, not only one `bestEver`;
8. add anti-cycle/anti-immediate-undo handling;
9. record pull histories efficiently;
10. compute cheap history-based complexity signals during reverse search;
11. optionally run periodic forward estimates on elite states;
12. support “search long for one puzzle” workflows.

### Candidate reverse-history metrics

Track cheaply while reverse searching:

- distinct boxes pulled;
- pull switches between boxes;
- repeated returns to the same box;
- room transitions per box;
- chokepoint crossings;
- tunnel transitions;
- number of boxes displaced from final region;
- dependency-like blocking events;
- number of times robot reachability region changes materially.

These do not prove final difficulty, but they are better search guidance than distance alone.

### Search presets

Example:

```ts
interface ReverseSearchProfile {
  beamWidth: number;
  maxDepth: number;
  maxExpandedStates: number;
  restartCount: number;
  archiveSize: number;
  eliteForwardProbeCount: number;
}
```

Use small profiles in CI and large profiles for catalog generation.

### Phase 4 completion definition

For the same solved architecture, V4 should produce a broad set of substantially deeper and more varied scramble states than V3.

---

## Phase 5 — Mechanism-driven generation

### Goals

Move from “random geometry plus motifs” toward deliberate Sokoban design.

### Tasks

1. replace single-motif thinking with `MechanismPlan`;
2. define evidence requirements for each mechanism;
3. expand motif/mechanism library;
4. allow 2–5 mechanisms in Expert/Master candidates;
5. create geometry templates/helpers that intentionally support those mechanisms;
6. represent intended dependency graphs before reverse search;
7. verify actual dependency realization only on final puzzle solutions.

### Required new mechanisms to consider

At minimum, explore implementations for:

- packing chain;
- gatekeeper;
- gate reopening;
- staging dependency;
- temporary parking;
- shared corridor traffic;
- support-square contention;
- cross-room exchange;
- dependency chain;
- multi-chain merge;
- required temporary goal vacancy;
- generic-assignment ambiguity.

### Phase 5 completion definition

Master candidates should regularly demonstrate multiple verified mechanisms rather than one shallow motif.

---

## Phase 6 — Human-quality evaluator and V4 difficulty model

### Goals

Make quality selection correlate with fun and reasoning challenge.

### Tasks

1. expand solution analysis metrics;
2. detect non-monotonic box movement;
3. detect staging operations;
4. detect temporary goal vacancy;
5. estimate dependency chain depth;
6. estimate meaningful decision branching;
7. quantify deadlock pressure without rewarding pure solver pathology;
8. distinguish solver challenge from human challenge;
9. create V4 difficulty classifier;
10. benchmark against handcrafted puzzle corpus.

### Important distinction

Track at least three separate concepts:

```text
solution length
solver computational difficulty
human reasoning difficulty
```

Do not collapse them into one number too early.

### Phase 6 completion definition

The generator can explain *why* a Master candidate is considered hard in terms of measurable puzzle mechanics, not merely because it has many moves or many A* expansions.

---

## Phase 7 — Quality-first candidate funnel

### Goals

Stop throwing away candidates before expensive evaluation can compare them.

### Tasks

Refactor `runForge()` / catalog generation into multiple explicit stages.

Suggested candidate funnel:

### Stage A — raw generation

Very cheap checks only:

- valid blueprint;
- valid goal placement;
- reverse depth > 0;
- final solvability witness exists;
- board scale minimums.

### Stage B — cheap structural scoring

Compute:

- floor;
- regions;
- chokepoints;
- box count;
- reverse-history metrics;
- basic diversity fingerprint.

Retain a large pool.

### Stage C — first forward evaluation

Use Greedy/Sokomind with moderate limits.

Reject:

- trivially easy puzzles;
- tedious puzzles;
- unexpectedly tiny solutions;
- mechanically empty puzzles.

### Stage D — deep finalist evaluation

Run multiple solvers and richer analysis only on a smaller pool.

### Stage E — final curation

Use normalized Pareto + novelty + hard tier constraints.

### Phase 7 completion definition

The final 20 Master puzzles are chosen from a genuinely competitive pool, not simply the first 20 that survive cheap gates.

---

## Phase 8 — Curation and novelty cleanup

### Goals

Make final selection diverse without letting metric scale distort novelty.

### Tasks

1. normalize curation objectives;
2. remove ambiguous duplicate novelty fields;
3. consider structural fingerprint novelty in addition to metric novelty;
4. ensure final set spans different geometry families, typing modes, and mechanisms;
5. prevent one dominant motif from filling a tier;
6. optionally enforce soft diversity quotas.

### Possible diversity dimensions

- topology family;
- mechanism portfolio;
- box typing mode;
- box-count band;
- board-scale band;
- goal-distribution style;
- solution-length band;
- dependency-chain profile.

Do not make diversity quotas so rigid that low-quality candidates are forced into the catalog.

---

## Phase 9 — Solver integration and bottleneck review

### Goal

Determine whether the forward solver now limits generator quality.

Do this **after** generator improvements expose the real bottlenecks.

### Questions to measure

- How many promising Expert/Master candidates have a known witness solution but time out under the evaluator?
- Can Sokomind find solutions where Classic Greedy/A* cannot?
- Are candidates being rejected because optimal proof is expensive even though they are valid and interesting?
- Which solver metrics correlate with human difficulty?

### Likely V4 evaluator policy

Use multiple solver roles:

- **witness validation:** canonical replay, always required;
- **fast quality probe:** Greedy or Sokomind bounded run;
- **exact difficulty evidence:** A*/IDA* only when feasible;
- **proof:** optional for catalog acceptance unless a feature explicitly promises optimality.

Do not require every large Master puzzle to be optimally solved during generation if a valid replay witness exists and the product does not claim the displayed route is optimal.

### Only improve the solver if measurements justify it

Possible later solver work:

- better large-box assignment heuristics;
- stronger deadlock tables;
- macro reasoning for packing rooms;
- corridor/gate macros;
- more memory-efficient bounded solving;
- generator-specific evaluation mode.

---

## Phase 10 — Catalog regeneration and acceptance review

Do not overwrite the main generated catalog until V4 passes objective and subjective gates.

### Generate a review catalog first

For each tier, output candidate packs with:

- ASCII board;
- box typing mode;
- box count;
- board dimensions;
- playable floor;
- moves/pushes;
- solver evidence;
- mechanism evidence;
- difficulty score/classification;
- structural metrics;
- provenance seed.

A human should play a representative sample.

### Required qualitative question

For Expert/Master especially:

> “Would I voluntarily choose to play another generated puzzle from this tier?”

If the answer is no, do not declare V4 complete just because metrics improved.

---

# 7. Proposed V4 tier philosophy

These are product goals, not hard-coded permanent thresholds.

## Tutorial

Should teach one mechanic at a time.

- small boards;
- 1–3 boxes;
- generic boxes common;
- simple typed examples occasionally;
- minimal deadlock traps;
- short solutions;
- obvious framing and readable geometry.

## Beginner

Should require basic planning.

- 2–5 boxes;
- modest rooms/corridors;
- some generic assignment choice;
- simple typed/hybrid puzzles;
- one meaningful ordering decision.

## Intermediate

Should introduce sustained Sokoban reasoning.

- 3–7 boxes;
- multiple rooms;
- meaningful staging;
- moderate dependencies;
- more route planning;
- several plausible choices.

## Advanced

Should punish careless pushing.

- 5–10 boxes;
- multi-room interaction;
- constrained passages;
- temporary parking;
- packing/ordering;
- nontrivial deadlock risks;
- multiple decision stages.

## Expert

Should feel like a substantial puzzle.

- roughly 7–15 boxes;
- large meaningful playable area;
- multiple interacting mechanisms;
- dependency chains;
- significant staging;
- solver challenge;
- solution should not be obvious from local moves alone.

## Master

Should be the generator's showcase tier.

- roughly 10–20 boxes;
- Grand-Hall-scale boards should be normal, not exceptional;
- high playable floor count;
- several interacting regions;
- multiple mechanism types;
- long-range planning;
- temporary displacement;
- traffic scheduling;
- assignment/route interactions;
- strong deadlock pressure;
- a long, purposeful solution;
- no tiny “Master” puzzles allowed merely because a classifier or quota says so.

---

# 8. Manifest V4 requirements

Expand generated manifest provenance so generator behavior can be audited.

Suggested fields per puzzle:

```ts
{
  id,
  title,
  difficulty,
  generationTier,
  classifiedDifficulty,
  difficultyScore,

  seed,
  generatorVersion,
  qualityProfile,

  topologyFamily,
  mechanismIds,
  typingMode,
  genericBoxCount,
  typedBoxCount,

  boxCount,
  boardWidth,
  boardHeight,
  playableFloor,
  floorCoverage,
  roomCount,
  regionCount,
  chokepoints,
  articulationPoints,

  reverseDepth,
  reverseExpandedStates,
  reverseRestartIndex,
  reverseArchiveRank,

  solutionMoves,
  solutionPushes,
  pushesPerBox,
  solverEvidence,

  dependencyEdges,
  dependencyRealized,
  dependencyRealizationRate,
  dependencyChainDepth,

  tighteningApplied,
  tighteningCellsRemoved,

  boardHash,
  symmetryHash
}
```

Not every field must be mandatory immediately, but V4 should move in this direction.

---

# 9. Required V4 invariants

Generator output should fail hard if any of these are violated.

## Board invariants

- exactly one robot;
- declared box count equals actual box count;
- box/goal label counts match;
- all rows normalize safely;
- complete perimeter wall frame;
- puzzle validates under canonical parser;
- all floor/entity cells are within wall frame;
- no duplicate generated IDs;
- no duplicate canonical boards;
- no symmetry duplicate boards unless intentionally allowed.

## Solution invariants

- every catalog puzzle has at least one canonical replay-valid solution witness;
- displayed/stored solution counters must match replay if stored;
- final evaluation is run on the final serialized puzzle semantics;
- typed/hybrid transformation cannot invalidate the witness route.

## Difficulty invariants

- final assigned difficulty must be compatible with final classification;
- a large mismatch must reject or reclassify, never silently remain;
- quota shortfalls are warnings/errors, not justification to mislabel puzzles.

## Quality invariants for hard tiers

Examples:

- minimum box count;
- minimum playable floor;
- minimum mechanism evidence;
- minimum solution depth;
- minimum interaction/dependency score;
- maximum tedium score.

Tune these empirically and keep them centralized in tier policy.

---

# 10. Testing strategy

V4 needs stronger tests than “the generator produced 20 valid boards.”

## Unit tests

Add tests for:

- framing;
- typing modes;
- keeper-region state identity;
- reverse transposition behavior;
- beam setting propagation;
- difficulty policy;
- normalized novelty;
- geometry profile sampling;
- mechanism evidence calculations;
- final-evaluation ordering.

## Deterministic smoke generation

Create tiny budget V4 fixture tests that run quickly in CI.

Example:

```bash
npm run generate:v4 -- --quality smoke --tier tutorial --dry-run
npm run generate:v4 -- --quality smoke --tier master --dry-run
```

They should verify pipeline correctness, not final quality.

## Generator regression fixtures

Freeze several seeds / mechanism plans and assert:

- expected framing;
- minimum floor;
- expected typing mode;
- reverse depth propagation;
- witness replay;
- no stale pre-transformation evaluation.

## Catalog-level tests

Read `generated-puzzles.json` and assert:

- perimeter walls;
- distribution of generic/typed/hybrid puzzles;
- hard-tier box/floor minimums;
- difficulty compatibility;
- unique IDs/hashes;
- manifest consistency.

## Quality regression tests

Maintain a small frozen benchmark of known generated puzzles whose metrics should not regress badly.

Avoid overfitting exact solver elapsed time.

Prefer deterministic structural/state counters where possible.

---

# 11. CLI / developer workflow

V4 should be pleasant to iterate on.

Suggested commands:

```bash
# Tiny deterministic CI/dev check
npm run generate:v4 -- --quality smoke --dry-run

# One tier, moderate search
npm run generate:v4 -- --tier master --quality standard --dry-run

# Search aggressively for one or a few exceptional Master puzzles
npm run generate:v4 -- --tier master --quality exhaustive --target 1 --verbose

# Full production catalog generation
npm run generate:v4 -- --quality high
```

Useful optional flags:

```text
--tier
--target
--quality
--base-seed
--max-runtime
--max-attempts
--typing-mode
--topology
--mechanism
--no-tighten
--output-dir
--verbose
--dry-run
```

Do not require every flag in the first implementation. Establish a clean configuration model first.

---

# 12. Performance philosophy

V4 should explicitly separate **CI performance** from **catalog generation performance**.

The production generator is offline. It is allowed to be expensive.

### CI goals

- deterministic;
- small seeds/budgets;
- fast correctness checks;
- no requirement to produce exceptional Master puzzles.

### Production-generation goals

- quality first;
- high search budgets allowed;
- multiple restarts allowed;
- deep evaluation allowed;
- can spend a long time on rare candidates.

Do not cripple production puzzle quality merely to keep full catalog regeneration inside ordinary CI runtime.

---

# 13. What not to do

Avoid these shortcuts.

## Do not only increase board dimensions

An 18×18 canvas with four tiny rooms is still a tiny puzzle.

## Do not only increase box count

More independent boxes can create tedium rather than difficulty.

## Do not define difficulty only by solution length

A 200-move puzzle can still be straightforward.

## Do not define difficulty only by A* expansions

Solver pathology is not necessarily human puzzle quality.

## Do not solve the problem by deleting less floor alone

The architecture itself must improve.

## Do not keep pre-typing or pre-tightening metrics

Final selection must describe final puzzle rows.

## Do not fill quotas with poor candidates

It is better for generation to search longer or report a quota shortfall than to label an Advanced-quality puzzle as Master.

## Do not rewrite the existing solver without evidence

Improve generator architecture first. Revisit solver bottlenecks after V4 produces larger, more difficult candidates.

---

# 14. Definition of Generator V4 complete

Generator V4 should not be considered complete until all of the following are true.

## Correctness

- all generated boards have a complete wall perimeter;
- generic, typed, and hybrid puzzles are intentionally supported;
- all stored metrics describe the final puzzle;
- final dependency/mechanism scores are recomputed after all mutations;
- every generated puzzle validates;
- every generated puzzle has a replay-valid witness solution;
- difficulty labels cannot materially contradict the measured classification.

## Scale

- Expert/Master produce genuinely large playable boards;
- Master supports approximately 10–20 boxes;
- Grand-Hall-scale puzzles are within normal generator capability;
- large canvas dimensions correspond to large playable geometry.

## Quality

- Master puzzles contain multiple meaningful interacting mechanisms;
- upper-tier solutions require long-range planning and staging;
- puzzles are not mostly collections of independent boxes;
- difficult boards retain useful maneuvering area;
- final selection comes from a large candidate pool;
- curation meaningfully chooses winners rather than rubber-stamping the only survivors.

## Diversity

The catalog includes a meaningful mix of:

- generic puzzles;
- typed puzzles;
- hybrid puzzles;
- topology families;
- mechanism portfolios;
- box-count bands;
- board scales;
- solution styles.

## Engineering quality

- deterministic seeds/provenance;
- smoke mode for CI;
- high/exhaustive quality modes for offline generation;
- strong invariants;
- regression tests;
- detailed manifest;
- no silent fallback to weaker search settings.

## Human acceptance

A representative human playtest of generated Expert/Master puzzles should conclude that the puzzles are:

- fun;
- varied;
- readable;
- meaningfully difficult;
- worth playing in quantity.

This human criterion is important. Procedural-quality metrics exist to help produce good puzzles, not to replace judgment about whether the puzzles are actually enjoyable.

---

# 15. Recommended immediate implementation order

If executing this roadmap sequentially, start here:

1. **Fix final wall framing.**
2. **Replace `useLabels` with generic/typed/hybrid typing policy.**
3. **Move authoritative evaluation to after all transformations.**
4. **Reverify dependencies after tightening/typing.**
5. **Propagate tier reverse-search config into motif and composed modes.**
6. **Fix real difficulty mismatch policy and tests.**
7. **Add tier geometry profiles and hard minimum playable-floor rules.**
8. **Increase Expert/Master box ranges.**
9. **Disable or heavily constrain Master tightening until preservation is trustworthy.**
10. **Refactor early retention so a large candidate pool reaches finalist evaluation.**
11. **Upgrade reverse state identity and transposition handling.**
12. **Increase reverse-search budgets and add multi-restart/archive behavior.**
13. **Implement mechanism portfolios and richer hard-puzzle geometry.**
14. **Build V4 difficulty/human-quality metrics.**
15. **Normalize novelty and finalize Pareto curation.**
16. **Measure whether forward solver limitations remain.**
17. **Regenerate a review catalog.**
18. **Playtest Expert/Master samples.**
19. **Tune thresholds/search budgets based on evidence.**
20. **Regenerate the production catalog only after V4 quality is convincing.**

---

# 16. Final product vision

The finished Generator V4 should be capable of being asked for something like:

> Generate twenty Master Sokomind puzzles. Search as long as necessary within the configured offline budget. Favor large boards with 10–20 boxes, several interacting rooms, multiple verified Sokoban mechanisms, strong staging and ordering requirements, and low tedium. Produce a diverse mixture of generic, typed, and hybrid puzzles. Reject weak candidates rather than filling quota with mislabeled puzzles.

And the generator should actually behave that way.

A generated Master puzzle should no longer look like a small Advanced puzzle that happened to survive a quota pipeline. It should look and play like a puzzle deliberately designed to occupy an experienced Sokoban player for a meaningful amount of time.

Grand Hall is a useful scale reference, but V4 should not merely imitate Grand Hall. The goal is a **plethora of distinct, high-quality puzzles** with different mechanisms, layouts, box semantics, and solving experiences.

Quality is the primary objective. Generation speed is secondary.
