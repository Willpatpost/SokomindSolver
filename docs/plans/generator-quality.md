# Sokomind Generator V4.1 — Trustworthy Quality Pipeline

**Status:** Implementation roadmap  
**Purpose:** Repair the current generator so that it can reliably produce high-quality Sokoban puzzles, especially at Advanced / Expert / Master tiers.  
**Primary target:** `src/features/generator/v2/` and `scripts/generate-v2-catalog.ts`  
**Important:** Do **not** regenerate or overwrite the production catalog until the release gates in the final phase pass.

---

## 1. Executive Summary

The current Sokomind generator contains many strong ideas: topology-aware blueprints, reverse construction, mechanism planning, dependency graphs, solution-depth analysis, multi-objective curation, V4 difficulty modeling, and multi-role solver evaluation.

However, several of those systems are either:

1. incorrect at the metric level,
2. disconnected from the production path,
3. weaker than their interfaces imply,
4. applied in the wrong order,
5. or allowed to pass without proving that the intended puzzle mechanism actually exists.

As a result, the generator can produce puzzles that are technically valid and solvable while still being weak, misclassified, under-mechanized, or structurally inconsistent with their requested tier.

This roadmap is intentionally ordered so that **measurement correctness comes before search tuning**.

The next milestone is not:

> “Generate 20 Master puzzles.”

The next milestone is:

> **For every generated puzzle, trust the board semantics, trust the box count, trust the structural profile, trust the mechanism claims, trust the difficulty metrics, and trust that reverse search actually explored different alternatives.**

Only after those conditions hold should search budgets, thresholds, beam widths, depth limits, or seed counts be tuned.

---

# 2. Non-Negotiable Design Principles

These principles should guide every implementation decision.

## 2.1 Correctness before scale

Do not compensate for incorrect scoring by:

- increasing seed windows,
- increasing beam width,
- increasing reverse depth,
- loosening difficulty thresholds,
- increasing solver limits,
- increasing box counts,
- or allowing lower dependency realization.

If the objective function is wrong, more search only optimizes the wrong thing more aggressively.

## 2.2 Quality and difficulty are separate concepts

A puzzle can be:

- difficult but bad,
- easy but elegant,
- complex but tedious,
- or structurally large but cognitively shallow.

The pipeline must evaluate **quality first**, then difficulty.

A candidate should not reach Master merely because it has:

- many boxes,
- many pushes,
- many solver-expanded states,
- or a large board.

## 2.3 Mechanisms must be causal, not decorative

A board is not a “gate-reopening puzzle” because:

- it visually resembles a gate,
- the solver happened to move a gate box,
- or the completion order matched the intended dependency.

A mechanism claim must mean the mechanism was **necessary or materially constraining**.

## 2.4 Inventory must never determine truth

A candidate must never be promoted or left in a harder tier because that tier is short of puzzles.

If only 7 true Master puzzles exist, the correct result is:

```text
Master: 7 / 20
```

not:

```text
Promote Expert puzzles until Master reaches 20.
```

## 2.5 Production paths must use the newest authoritative systems

A system is not “implemented” merely because:

- the module exists,
- unit tests exist,
- or it is exported.

For each subsystem, verify:

1. Implemented?
2. Tested?
3. Invoked by the production generator?
4. Used to make an acceptance decision?

All four must be true.

---

# 3. Current High-Severity Defects

This section summarizes the issues that motivate the sprint ordering.

---

## 3.1 Puzzle evaluator incorrectly recognizes uppercase tiles as boxes

Several evaluator paths use logic equivalent to:

```ts
ch === "X" || (ch >= "A" && ch <= "Z")
```

This incorrectly includes:

- `O` — wall,
- `R` — robot,
- `S` — generic goal.

At least one evaluator path also converts those recognized cells to floor in its local analysis grid.

This can corrupt:

- reachable-push counts,
- legal-push counts,
- forced-choice ratios,
- branching metrics,
- box-switch metrics,
- room-crossing metrics,
- and downstream human-reasoning scores.

Some newer modules already use the correct exclusion logic. Tile semantics must be centralized.

---

## 3.2 Reverse-search restarts share one transposition table

`reverseBeamSearchV4()` creates one transposition table outside the restart loop.

Each restart begins from the same solved state.

After restart 1 records the first-layer states, restart 2 generates those same states and the shared table rejects them.

Therefore the configured multi-restart behavior can collapse into:

```text
1 real restart + N nearly empty restarts
```

This is especially damaging for Expert / Master generation.

---

## 3.3 Mechanism generation does not honor requested box count

The requested `boxCount` is used to:

- determine feasibility,
- influence mechanism count,
- and record provenance.

But individual mechanism specs generally allocate only their catalog minimum number of goals.

The remaining requested box budget is not guaranteed to be allocated.

Consequences:

- requested box count can differ from actual box count,
- provenance can overstate complexity,
- mechanism-mode Expert / Master attempts can collapse into much smaller puzzles,
- and tier search behavior becomes misleading.

The following invariant must become mandatory:

```text
requestedBoxCount
==
actualPuzzle.boxes
==
numberOfGoals
==
genericBoxCount + typedBoxCount
```

---

## 3.4 Mechanism evidence requirements are not fully wired through generation

The mechanism catalog contains rich semantic requirements such as:

- `gate-displacement`,
- `gate-return`,
- `temporary-park`,
- `chain-ordering`,
- `cross-exchange`.

The dependency verifier also supports richer edge types such as:

- `must-reopen`,
- `must-park`,
- `chain-link`,
- `exchange-cross`.

But mechanism placement often emits weaker generic dependency edges:

- `blocks-access`,
- `must-stage`,
- `must-precede`,
- `shares-passage`.

Therefore the generator can claim a stronger mechanism than it actually verifies.

---

## 3.5 Dependency verification is too observational

Several dependencies are considered realized because one solver solution happens to satisfy a completion order.

Example:

```text
A completed before B
```

does not prove:

```text
A must be completed before B
```

The generator needs counterfactual or necessity-oriented verification for hard-tier mechanisms.

---

## 3.6 Structural geometry profile is partially descriptive rather than authoritative

`GeometryProfile` defines useful constraints including:

- board dimension ranges,
- room count,
- playable floor bounds,
- floor coverage,
- region count,
- chokepoints.

But not all of these are consistently enforced after generation.

Additionally, the `nested` family has a room-count behavior that can conflict with high-tier minimum-room requirements.

Hard tiers must not silently violate the geometry profile.

---

## 3.7 Reverse scoring optimizes structural distance more than puzzle reasoning

The reverse search currently rewards useful proxies such as:

- boxes off goals,
- dispersion,
- room crossings,
- chokepoint occupancy,
- distance from solved,
- support constraints.

However, it does not directly optimize the richer properties the evaluator later rewards:

- temporary displacement,
- staging,
- goal vacancy,
- causal enable/disable,
- dependency depth,
- mechanism evidence,
- box reuse,
- delayed consequences.

This creates a mismatch between generation objective and final quality objective.

---

## 3.8 The diverse reverse archive is underused

V4 reverse search returns an archive of candidate states.

The forge usually consumes only `best`.

That wastes potentially valuable alternative start states from an expensive geometry / mechanism blueprint.

---

## 3.9 The funnel is expensive too early

The intended funnel is:

```text
many cheap candidates
↓
structural screening
↓
cheap solve/evaluation
↓
deep evaluation
↓
curation
```

The actual Stage A currently performs substantial work before structural selection, including solver calls and tightening.

This prevents the generator from cheaply exploring a very large architectural population.

---

## 3.10 V4 production integration is incomplete

Newer V4 components exist, but older systems remain authoritative in important places.

Examples include:

- old finalist evaluation instead of the multi-role V4 evaluator,
- legacy difficulty classification instead of the V4 difficulty profile,
- simpler Pareto selection instead of full diversity-aware selection.

---

## 3.11 Low-supply tiers receive weaker curation pressure

When candidate count is at or below target, the current catalog flow can simply keep all candidates.

That is exactly backwards for Expert / Master, where candidate scarcity is greatest.

Scarcity must not weaken quality requirements.

---

## 3.12 Tests often validate plumbing, not puzzle semantics

Many tests prove things such as:

- metric is nonnegative,
- a pipeline returns a valid puzzle,
- a DAG exists,
- a count is within a broad range.

These do not prove that:

- branching values are correct,
- a gate is necessary,
- staging is required,
- a mechanism is causal,
- or a generated hard puzzle is actually hard in a human sense.

---

# 4. Sprint / Phase Overview

Recommended implementation order:

| Phase | Name | Primary Goal |
|---|---|---|
| 0 | Freeze & Diagnostics Baseline | Preserve current behavior for comparison |
| 1 | Tile Semantics & Evaluator Correctness | Make metrics trustworthy |
| 2 | Reverse Search Restart Repair | Make exploration genuinely diverse |
| 3 | Box Budget & Provenance Integrity | Make requested puzzle scale real |
| 4 | Geometry Contract Enforcement | Make tier geometry requirements authoritative |
| 5 | Mechanism Semantic Wiring | Ensure planned mechanisms map to correct dependency semantics |
| 6 | Causal / Counterfactual Verification | Prove mechanisms matter |
| 7 | Mechanism-First Geometry | Build geometry around intended reasoning |
| 8 | Reverse Objective Alignment | Search for reasoning-rich states, not just distant states |
| 9 | True Cost Funnel | Explore many ideas cheaply |
| 10 | V4 Production Integration | Make V4 systems authoritative |
| 11 | Quality Gate & Difficulty Calibration | Separate “good” from “hard” |
| 12 | Curation, Diversity, and Quota Policy | Curate without tier inflation |
| 13 | Semantic Generator Test Suite | Protect puzzle quality behavior |
| 14 | Review Catalog & Release Gate | Regenerate only after evidence supports release |

---

# 5. Phase 0 — Freeze Current Behavior and Create a Diagnostic Baseline

## Goal

Capture current generator behavior before modifying it so regressions and improvements can be measured.

## Files

Likely:

- `scripts/generate-v2-catalog.ts`
- `src/features/generator/v2/puzzle-forge.ts`
- `src/features/generator/v2/review-catalog.ts`
- `src/catalog/generated-puzzles.manifest.json`

## Tasks

### 0.1 Do not overwrite production catalog

All implementation work should use:

- `--review`,
- temporary output directories,
- or dedicated diagnostic fixtures.

### 0.2 Add a generator diagnostic report

For every run, record at least:

```ts
interface GeneratorDiagnostics {
  attempted: number;
  blueprintSucceeded: number;
  mechanismPlanSucceeded: number;
  goalPlacementSucceeded: number;
  reverseSearchSucceeded: number;
  puzzleValidationSucceeded: number;
  initialSolveSucceeded: number;
  gatePassed: number;
  finalistPassed: number;
  qualityPassed: number;
  difficultyPassed: number;
  curated: number;
}
```

Also record rejection counts by:

- tier,
- family,
- mode,
- requested box count,
- actual box count,
- mechanism type,
- reverse depth,
- reverse restart.

### 0.3 Add requested-vs-actual scale diagnostics

Before fixing anything, report:

```text
requestedBoxes
actualBoxes
goalCount
genericBoxes
typedBoxes
difference
```

### 0.4 Add reverse-restart diagnostics

For each restart record:

```text
restartIndex
expanded
maxDepth
archiveOffers
archiveAccepts
transpositionHits
firstLayerGenerated
firstLayerRejected
```

This should make the restart defect directly visible.

## Acceptance Criteria

Phase 0 is complete when:

- production catalog is untouched,
- generator diagnostic output exists,
- the current box-count mismatch is measurable,
- restart behavior is measurable,
- and the same seed/config remains reproducible.

---

# 6. Phase 1 — Centralize Tile Semantics and Repair Evaluator Correctness

## Goal

Make every generator metric operate on the same correct interpretation of Sokomind board characters.

This is the highest-priority phase.

## Recommended New Module

Create something similar to:

```text
src/features/generator/v2/tile-semantics.ts
```

or reuse an authoritative existing core helper if one already exists.

## Required API

At minimum:

```ts
export function isWallChar(ch: string): boolean;
export function isRobotChar(ch: string): boolean;
export function isGenericBoxChar(ch: string): boolean;
export function isTypedBoxChar(ch: string): boolean;
export function isBoxChar(ch: string): boolean;
export function isGenericGoalChar(ch: string): boolean;
export function isTypedGoalChar(ch: string): boolean;
export function isGoalChar(ch: string): boolean;
export function isWalkableChar(ch: string): boolean;
```

Prefer one authoritative implementation rather than repeated inline character-range tests.

## Files to Audit

At minimum:

- `puzzle-evaluator.ts`
- `interaction-analysis.ts`
- `solution-depth-analysis.ts`
- `dependency-verification.ts`
- `geometry-tightening.ts`
- `solution-usage.ts`
- `reachable-pushes.ts`
- any other generator code containing:
  - `ch >= "A"`,
  - `ch <= "Z"`,
  - `ch === "X"`,
  - `ch === "S"`,
  - or `ch !== "O"`.

## Required Fixes

### 1.1 Branching analysis

Fix initialization so:

- walls remain walls,
- goals remain floor-goal cells,
- keeper is not a box,
- typed boxes are recognized correctly.

### 1.2 Box interaction analysis

Use the shared box predicate.

### 1.3 Room traffic analysis

Use the shared box predicate.

### 1.4 Remove duplicate tile-parsing rules

Search the entire generator package for duplicate character semantics.

## Tests

Add exact semantic tests.

### Test A — Wall is never treated as a box

Construct a tiny board with many `O` cells and one box.

Assert:

```text
parsed box count == 1
```

### Test B — Robot is never treated as a box

Assert:

```text
parsed box count excludes R
```

### Test C — Generic goal is never treated as a box

Assert:

```text
S is recognized as goal but not box
```

### Test D — Exact reachable push count

Create a board where there are exactly 2 reachable pushes.

Assert:

```ts
ev.avgReachablePushes === 2
```

or inspect a state-level helper directly.

### Test E — Exact forced state

Create a state where exactly one push is possible.

Assert:

```text
reachable push count == 1
forced ratio == expected exact value
```

### Test F — Exact box-switch sequence

Provide a known replay such as:

```text
box 0
box 0
box 1
box 1
box 0
```

Assert exact transition count and switch rate.

## Acceptance Criteria

- No evaluator code uses broad uppercase checks for boxes.
- Exact oracle tests pass.
- Existing generator tests still pass.
- Handcrafted benchmark metrics are regenerated after the fix.
- Any materially changed historical metric distributions are documented rather than “corrected back” to old values.

---

# 7. Phase 2 — Repair V4 Reverse Search Restarts and Archive Correctness

## Goal

Ensure each configured restart actually explores an independent search trajectory.

## Files

- `reverse-beam-search.ts`
- `reverse-scoring.ts`
- related tests

## Required Architecture

Use:

```text
GLOBAL:
  diverse archive

PER RESTART:
  local transposition / dominance table
  local beam
  restart-specific RNG
```

Do **not** use one visited/transposition structure that blocks later restarts from revisiting the same early states.

## Tasks

### 2.1 Move transposition table inside restart scope

Preferred structure:

```ts
for (let r = 0; r < restartCount; r++) {
  const transposition = new TranspositionTable();
  ...
}
```

Keep the archive global if cross-restart diversity is desired.

### 2.2 Preserve global duplicate control separately

If needed, create a separate global archive key index.

Do not conflate:

- “this state has already been explored in this restart”
- with
- “this state has appeared somewhere before.”

### 2.3 Fix archive stale keys

If an archive entry is evicted, remove its old state key from the key set.

A safer design is to store:

```ts
interface ArchiveEntry {
  key: string;
  candidate: BeamCandidate;
}
```

so replacement can correctly update both structures.

### 2.4 Make restarts genuinely different

Current stochastic tie-breaking mostly matters only on exact or nearly exact score ties.

Add controlled restart diversity such as:

- restart-specific scoring jitter,
- weight perturbation within safe bounds,
- restart-specific beam diversity radius,
- archive novelty bonus,
- top-k weighted selection rather than deterministic top-1 ordering.

All randomness must remain seed-reproducible.

### 2.5 Record per-restart diversity

Measure:

- unique states,
- unique fingerprints,
- unique terminal archive states,
- overlap between restarts.

## Tests

### Test A

`restartCount = 3` must result in meaningful expansion in all three restarts on a nontrivial board.

### Test B

Restart 2 must not terminate at depth 0 merely because restart 1 saw the same first layer.

### Test C

Same seed/config must produce identical final results.

### Test D

Different restart indices should produce at least some non-identical search ordering or archive contributions.

### Test E

Evicted archive keys must be reusable if the same state later qualifies again.

## Acceptance Criteria

- Each configured restart expands states unless naturally exhausted by the puzzle.
- Restart diagnostics show meaningful independent exploration.
- Archive key bookkeeping is correct.
- Determinism remains intact.

---

# 8. Phase 3 — Enforce Box Budget, Goal Budget, and Provenance Integrity

## Goal

The requested puzzle scale must match the resulting puzzle.

## Files

- `mechanism-plan.ts`
- `blueprint-types.ts`
- `puzzle-forge.ts`
- `catalog-manifest-types.ts`
- `review-catalog.ts`
- catalog generation script

## Recommended Type Changes

Instead of:

```ts
interface MechanismSpec {
  minGoals: number;
}
```

use something closer to:

```ts
interface MechanismSpec {
  minGoals: number;
  allocatedGoals: number;
}
```

or rename cleanly:

```ts
goalCount: number;
```

Keep minimum requirements separately.

## Tasks

### 3.1 Allocate the entire box budget

Given:

```text
requested boxCount = N
selected mechanisms = M
```

allocate exactly `N` goals across mechanisms.

Algorithm:

1. assign each mechanism its minimum,
2. compute remaining budget,
3. distribute remaining goals according to:
   - mechanism scalability,
   - room capacity,
   - tier preferences,
   - compatibility,
4. reject the plan if exact allocation is impossible.

### 3.2 Define mechanism scalability

Some mechanisms scale naturally.

Examples:

- packing chain: 2..N,
- dependency chain: 3..N,
- corridor traffic: 2..N,
- temporary parking: 2..N.

Others may have a tighter useful range.

Represent this explicitly in the mechanism catalog:

```ts
minBoxes
maxUsefulBoxes?
scalable: boolean
```

### 3.3 Guarantee goal count

After `placeGoalsFromPlan()`:

```ts
assert(solved.goals.length === requestedBoxCount)
```

If not, generation fails.

### 3.4 Guarantee puzzle box count

After reverse construction:

```ts
assert(puzzle.boxes === requestedBoxCount)
```

### 3.5 Guarantee post-typing count

Typing may change labels, never count.

Assert:

```text
genericBoxCount + typedBoxCount == puzzle.boxes
```

### 3.6 Separate requested and actual provenance

If retaining both is useful:

```ts
requestedBoxCount
actualBoxCount
```

But after this phase they should always match for accepted production candidates.

## Required Hard Invariant

```text
requestedBoxCount
==
solved.goals.length
==
puzzle.boxes
==
genericBoxCount + typedBoxCount
```

Any mismatch is a fatal candidate rejection.

## Tests

- mechanism plan with 13 boxes yields exactly 13 allocated goals,
- Master plan with 20 boxes either produces exactly 20 goals or returns null,
- typing cannot alter count,
- manifest records actual and requested values consistently,
- synthetic impossible allocation fails explicitly.

## Acceptance Criteria

No accepted candidate can have a provenance box count different from its board.

---

# 9. Phase 4 — Make GeometryProfile an Enforced Contract

## Goal

A tier's geometry profile must describe actual accepted geometry, not merely generation preferences.

## Files

- `blueprint-types.ts`
- `blueprint-graph.ts`
- `structural-metrics.ts`
- `puzzle-forge.ts`
- tier configs in catalog script
- geometry tests

## Tasks

### 4.1 Fix `nested` room-count behavior

Current nested handling can conflict with high tier minimum rooms.

Redesign family semantics.

Options:

### Option A — Nested supports arbitrary room count

Recommended if nested is intended for hard tiers.

### Option B — Nested has a true hard maximum

Then it must not be scheduled for tiers whose `minRooms` exceeds that maximum.

Do not generate an inverted random range.

### 4.2 Validate blueprint against profile immediately

After blueprint creation, compute structural diagnostics and enforce:

```text
board dimensions in range
room count in range
playable floor >= min
playable floor <= max if defined
floor coverage >= min
region count >= min
chokepoint count >= min
```

### 4.3 Revalidate after tightening

Geometry mutation can violate structural constraints.

Final puzzle geometry must still satisfy tier requirements.

### 4.4 Make profile rejection reason specific

Instead of one generic `gate-geometry`, use diagnostic subreasons if useful:

```text
geometry-room-count
geometry-floor-min
geometry-floor-max
geometry-coverage
geometry-regions
geometry-chokepoints
```

This will make bottleneck analysis much easier.

### 4.5 Do not let family semantics silently override profile semantics

Profile requirements win.

## Tests

- Master nested configuration never yields fewer than Master minimum rooms,
- max playable floor is enforced,
- region minimum is enforced,
- chokepoint minimum is enforced,
- post-tightening puzzle still satisfies profile.

## Acceptance Criteria

Every retained candidate satisfies the complete geometry profile for its intended tier.

---

# 10. Phase 5 — Wire Mechanism Semantics End-to-End

## Goal

A mechanism's declared identity, dependency edges, evidence requirements, and verification logic must all agree.

## Files

- `mechanism-plan.ts`
- `blueprint-types.ts`
- `dependency-verification.ts`
- `puzzle-forge.ts`

## Tasks

### 5.1 Map each mechanism to its defining edge semantics

Recommended:

| Mechanism | Defining edges / evidence |
|---|---|
| packing-chain | `must-precede` / completion order |
| gatekeeper | `blocks-access` |
| gate-reopening | `must-reopen` |
| staging-dependency | `must-stage` |
| corridor-traffic | `shares-passage` |
| temporary-parking | `must-park` |
| dependency-chain | `chain-link` |
| cross-room-exchange | `exchange-cross` |

Do not reduce a stronger mechanism to a weaker generic edge unless that weaker edge is only supplemental.

### 5.2 Preserve mechanism evidence requirements

The plan already contains evidence requirements.

Carry them into:

- candidate provenance,
- review packs,
- verification.

### 5.3 Create mechanism-level verification results

Example:

```ts
interface MechanismVerificationResult {
  mechanismIndex: number;
  type: MechanismType;
  passed: boolean;
  requiredEvidence: readonly MechanismEvidenceKind[];
  observedEvidence: readonly MechanismEvidenceKind[];
  missingEvidence: readonly MechanismEvidenceKind[];
}
```

### 5.4 Separate defining evidence from supporting dependency edges

A mechanism passes only if all required defining evidence is satisfied.

Secondary DAG edges may use a realization ratio.

### 5.5 Tighten hard-tier acceptance

For mechanism mode:

```text
Tutorial / Beginner:
  may allow simple mechanisms

Intermediate:
  defining evidence required

Advanced / Expert / Master:
  all defining mechanism evidence required
```

Do not allow a “gate-reopening” candidate with no gate return.

## Tests

For every mechanism type:

- positive fixture where defining evidence occurs,
- negative fixture where layout looks similar but evidence does not occur,
- mechanism must fail the negative fixture.

## Acceptance Criteria

No candidate can claim a mechanism unless its defining evidence passes.

---

# 11. Phase 6 — Causal and Counterfactual Mechanism Verification

## Goal

Move from:

> “the solver happened to do this”

toward:

> “the puzzle required or materially enforced this.”

## Design Philosophy

Not every dependency needs a formal proof.

Use graduated confidence:

```text
observed
structural
counterfactual
proven
```

Hard tiers should require stronger confidence for defining mechanisms.

## Candidate Counterfactual Tests

### 6.1 Must-precede

Question:

```text
Can target B be completed before A?
```

Possible strategy:

- solve with a constrained objective,
- detect whether B can be placed while A remains incomplete,
- or perform bounded search for a state violating the intended order.

### 6.2 Blocks-access / gatekeeper

Question:

```text
Can the inner goal region be accessed without moving the gate box?
```

Freeze the gate box or treat it as immovable.

If the inner subproblem remains solvable, the gate is not causal.

### 6.3 Must-reopen

Require:

1. gate box leaves its gate role,
2. downstream progress occurs,
3. gate box later returns / completes.

Ideally also test that downstream progress is impossible while the gate remains fixed.

### 6.4 Must-stage

Require:

- box is displaced away from direct completion,
- another box or dependency progresses,
- staged box is later revisited.

Counterfactual:

```text
Can the puzzle solve if that box is forced to monotonically approach a goal?
```

### 6.5 Must-park

Require:

- temporary non-goal parking,
- later resumption,
- and meaningful downstream action while parked.

### 6.6 Chain-link

Test whether chain order can be violated.

For a chain:

```text
A -> B -> C
```

bounded search should attempt:

```text
B before A
C before B
```

If violations are possible, the dependency is weaker than claimed.

### 6.7 Exchange-cross

Verify both boxes truly traverse the intended shared passage and originate / terminate in opposite logical regions.

## Performance Strategy

Counterfactual verification is expensive.

Only run it after cheap filtering.

Recommended:

```text
candidate passes base quality
↓
mechanism observed evidence
↓
counterfactual verification for finalists only
```

## Acceptance Criteria

For Expert / Master mechanism puzzles:

- defining mechanism evidence is at least structural,
- at least one defining dependency should ideally reach counterfactual confidence,
- no hard-tier mechanism is accepted solely from incidental completion order.

---

# 12. Phase 7 — Mechanism-First Geometry Synthesis

## Goal

Stop asking generic random geometry to accidentally support sophisticated mechanisms.

For Advanced / Expert / Master, generate geometry from mechanism requirements.

## Proposed Architecture

Instead of:

```text
random rooms
↓
random corridors
↓
choose mechanisms that fit
```

use:

```text
choose target reasoning structure
↓
derive geometric constraints
↓
place required mechanism geometry
↓
connect / decorate supporting rooms
↓
validate structural contract
```

## New Concept: Geometry Requirements

Example:

```ts
interface MechanismGeometryRequirement {
  requiredRooms: number;
  requiredNarrowPassages: number;
  minRoomArea?: number;
  terminalRoomRequired?: boolean;
  requiredSupportCells?: readonly RelativeCellConstraint[];
  parkingPocketRequired?: boolean;
  gateMobilityPattern?: GateMobilityConstraint;
}
```

## Mechanism Examples

### Gatekeeper

Geometry should guarantee:

- a bottleneck,
- gate box affects bottleneck occupancy,
- downstream goals lie beyond the bottleneck,
- no alternate keeper route bypasses gate.

### Gate Reopening

Need enough space on both sides for:

- gate displacement,
- downstream transit,
- eventual gate restoration.

### Packing Chain

Need:

- terminal geometry,
- depth gradient,
- support squares that disappear as shallow positions fill.

### Temporary Parking

Need:

- at least one safe temporary cell,
- that cell should not simply be another equivalent goal path,
- parking should enable a distinct downstream action.

### Cross-Room Exchange

Need:

- two logical regions,
- a shared narrow transit structure,
- box goals requiring cross-region movement.

## Keep Generic Families

Topology families are still useful as macro structure.

But hard-tier mechanism geometry should constrain how those families instantiate.

## Acceptance Criteria

A hard-tier mechanism blueprint must be generated from explicit mechanism geometry requirements, not merely retrofitted afterward.

---

# 13. Phase 8 — Align Reverse Search Objective with Final Puzzle Quality

## Goal

Make reverse construction search for states likely to produce human-interesting reasoning.

## Current Problem

Static distance-like features are useful but insufficient.

## Add Reasoning-Oriented Reverse Features

Possible features:

```text
distinct boxes moved in pull history
box revisit count
room-crossing sequence
temporary goal departures in reverse history
support-square competition
chokepoint re-entry
mechanism-specific state progress
number of active dependencies
keeper-region changes caused by box pulls
```

## Candidate Score Categories

Separate the score into interpretable components:

```ts
interface ReverseObjectiveVector {
  scrambleDepth: number;
  boxDiversity: number;
  roomTraffic: number;
  supportCompetition: number;
  mechanismProgress: number;
  dependencyPotential: number;
  structuralRisk: number;
  repetitionPenalty: number;
}
```

Avoid collapsing everything too early.

## Mechanism-Aware Reverse Search

If a mechanism plan exists, give the reverse search a mechanism context.

Examples:

- gate-reopening: reward states where the gate box begins away from its final gate state and downstream boxes are beyond it,
- packing-chain: reward states whose forward solution will require ordered repacking,
- cross-room exchange: reward boxes beginning in opposite logical regions from their eventual goal regions.

## Archive Consumption

Do not use only `archive.getBest()`.

For each solved blueprint, emit several structurally distinct reverse candidates.

Recommended configurable value:

```text
reverseCandidatesPerBlueprint = 8..32
```

depending on tier and cost.

## Acceptance Criteria

- multiple reverse states per blueprint reach downstream evaluation,
- mechanism-mode reverse scoring includes mechanism-aware features,
- Expert / Master candidate diversity per blueprint increases measurably.

---

# 14. Phase 9 — Rebuild the Generator into a True Cost Funnel

## Goal

Allow the generator to explore thousands of architectural ideas cheaply before invoking expensive solvers.

## Recommended Funnel

### Stage A — Blueprint / plan generation

Cheap only.

Perform:

- topology generation,
- geometry-profile checks,
- mechanism feasibility,
- box-budget allocation.

No full solver.

Target scale:

```text
10,000+ possible raw structures
```

for offline high-quality generation.

### Stage B — Structural / mechanism pre-screen

Compute cheap static metrics:

- floor,
- room counts,
- chokepoints,
- articulation,
- corridor structure,
- mechanism geometry feasibility,
- support-square availability,
- likely dead squares.

Retain top subset with diversity.

### Stage C — Reverse generation

Run reverse search only on promising solved templates.

Produce multiple archive candidates per template.

### Stage D — Cheap witness validation

Use:

- reverse witness replay if available,
- tight greedy probe,
- cheap metric analysis.

Reject obvious failures.

### Stage E — Full candidate construction

Only now perform:

- typing,
- tightening if appropriate,
- full evaluation,
- dependency evidence.

### Stage F — V4 finalist evaluation

Use:

- witness,
- fast probe,
- exact evidence,
- optional proof where policy permits.

### Stage G — Hard quality qualification

Reject candidates below quality floors.

### Stage H — Difficulty qualification

Assign intrinsic difficulty.

### Stage I — Pareto + novelty + diversity curation

Choose among already-qualified candidates.

## Important

Do not call a stage “cheap evaluation” if it merely rescales metrics already produced by an expensive full solve.

## Acceptance Criteria

Generator diagnostics must show meaningful attrition at each stage and significantly fewer expensive solver calls than raw attempts.

---

# 15. Phase 10 — Make V4 Components Authoritative in Production

## Goal

Eliminate the split between “new V4 modules exist” and “old production logic still decides.”

## Tasks

### 10.1 Replace old finalist evaluator in production path

Use:

```ts
evaluateFinalistV4()
```

for finalists.

Use reverse witness steps when available.

### 10.2 Make proof optional, not required for all large puzzles

Respect the existing role policy concept:

- witness,
- fast probe,
- exact evidence,
- optional proof.

Do not reject valid hard puzzles merely because an expensive optimal proof times out.

### 10.3 Make V4 difficulty profile authoritative

Replace legacy:

```ts
classifyFromMetrics(moves, pushes, boxes)
```

with V4 profile classification after calibration.

### 10.4 Use full diversity quota selection

Use `selectWithDiversityQuotas()` or an improved equivalent in the actual catalog path.

### 10.5 Verify structural fingerprints are meaningful

Fingerprint should encode real diversity dimensions, for example:

```text
topology
mode
mechanism set
motif
actual box count bucket
region bucket
dependency pattern
```

Do not rely only on solution length buckets.

## Acceptance Criteria

A code audit must show:

- V4 finalist evaluator controls finalist decisions,
- V4 difficulty controls tier assignment,
- diversity quotas control final catalog curation.

---

# 16. Phase 11 — Introduce a Hard Quality Gate Before Difficulty

## Goal

Prevent technically valid but uninteresting puzzles from entering any high tier.

## New Concept

Create:

```ts
interface PuzzleQualityProfile {
  purposefulGeometry: number;
  interactionQuality: number;
  causalDepth: number;
  decisionQuality: number;
  mechanismIntegrity: number;
  elegance: number;
  tedium: number;
  passed: boolean;
  reasons: readonly string[];
}
```

## Candidate Quality Dimensions

### Positive

- shared support cells,
- causal enable/disable events,
- box reuse,
- non-monotonic movement,
- staging,
- temporary goal vacancy,
- required room traffic,
- dependency depth,
- actual mechanism evidence,
- purposeful solution floor coverage.

### Negative

- long empty walks,
- repetitive same-direction pushing,
- independent box subproblems,
- huge unused geometry,
- excessive forced sequences,
- scale without reasoning,
- accidental difficulty from solver inefficiency only.

## Tier-Independent Quality Floor

A Master puzzle that is bad should be rejected, not called Master.

Recommended order:

```text
valid
↓
solvable
↓
quality-qualified
↓
difficulty-classified
```

## Tier-Specific Quality Floors

Harder tiers may additionally require:

### Advanced

- some genuine interaction,
- low tedium,
- meaningful nontrivial decision structure.

### Expert

- multi-box causal interaction,
- dependency depth,
- staging / non-monotonic behavior or equivalent reasoning.

### Master

Require strong evidence from multiple dimensions.

Example policy concept:

```text
at least 2 strong causal mechanisms
or
one deep multi-stage mechanism + substantial interaction
```

Do not encode exact thresholds until metrics are recalibrated.

## Acceptance Criteria

Low-quality candidates cannot survive merely because the tier population is small.

---

# 17. Phase 12 — Difficulty Calibration Against Handcrafted Human-Designed Puzzles

## Goal

Calibrate V4 difficulty on real puzzle content rather than arbitrary thresholds.

## Dataset

Use the canonical handcrafted catalog as the reference set.

If tier labels are trusted, build:

```text
expected tier
vs
V4 predicted tier
```

## Required Report

For every handcrafted puzzle:

```text
id
expected tier
predicted tier
structural score
solution depth score
reasoning score
tedium
composite
```

Produce:

- confusion matrix,
- exact-match accuracy,
- within-one-tier accuracy,
- worst overclassification,
- worst underclassification.

## Threshold Tuning Rules

Do not tune to perfect exact-match accuracy.

Prioritize:

1. monotonic tier progression,
2. no obvious easy puzzle classified Master,
3. no rich Expert puzzle classified Beginner,
4. strong separation of Advanced / Expert / Master reasoning.

## Important

Do this **after** evaluator fixes.

Do not calibrate against corrupted historical evaluator numbers.

## Acceptance Criteria

V4 classification must be demonstrably correlated with handcrafted tier labels and manually inspected examples.

---

# 18. Phase 13 — Fix Curation, Diversity, and Quota Policy

## Goal

Ensure catalog selection chooses the best diverse qualified puzzles without distorting difficulty.

## Correct Order

```text
candidate generation
↓
hard quality floor
↓
intrinsic difficulty classification
↓
deduplication
↓
Pareto sorting
↓
novelty
↓
diversity quotas
↓
catalog quota
```

## Remove Quota-Driven Difficulty Logic

Delete behavior where destination tier capacity influences whether a candidate is reclassified.

Candidate classification is intrinsic.

## Quota Shortfall Behavior

If a tier is short:

1. open another seed window,
2. generate more candidates,
3. optionally widen generator search budgets,
4. report shortfall if still insufficient.

Do **not** lower quality thresholds automatically.

## Diversity Quotas

Use soft caps across:

- topology,
- generation mode,
- mechanism family,
- motif,
- typing mode if needed,
- box-count bucket.

## Quality Floor Always Applies

Even if:

```text
candidateCount <= target
```

the quality gate still applies.

Never “keep all” before quality qualification.

## Acceptance Criteria

A catalog with 2 Master candidates means:

- only 2 candidates qualified,
- not that curation failed to fill the quota.

---

# 19. Phase 14 — Build a Semantic Generator Test Suite

## Goal

Protect actual puzzle-generation meaning rather than only implementation plumbing.

## Test Categories

---

## 19.1 Tile Semantics Tests

Exact expected counts.

---

## 19.2 State Branching Oracle Tests

Tiny boards with exact expected reachable pushes.

---

## 19.3 Mechanism Positive / Negative Fixtures

For each mechanism:

```text
positive board:
  mechanism must pass

lookalike negative board:
  mechanism must fail
```

---

## 19.4 Counterfactual Tests

Examples:

```text
gatekeeper:
  freezing gate makes downstream target impossible

fake gate:
  freezing gate still allows solution
```

---

## 19.5 Box Budget Invariants

Requested count always equals actual count.

---

## 19.6 Geometry Contract Tests

Each tier profile's hard constraints are enforced.

---

## 19.7 Reverse Restart Tests

Multiple restarts perform meaningful work.

---

## 19.8 Archive Diversity Tests

Multiple distinct reverse candidates are produced.

---

## 19.9 Difficulty Benchmark Tests

Do not assert every handcrafted puzzle exact tier if that becomes brittle.

Instead enforce:

- catastrophic misclassification limits,
- ordering properties,
- representative known anchors.

Example anchors:

```text
known tutorial <= beginner
known Expert >= advanced
known Master >= expert
```

after calibration.

---

## 19.10 Quality Gate Negative Tests

Create synthetic bad puzzles:

- long corridor pushing,
- independent box rows,
- giant unused room,
- forced-only repetitive solution.

Assert they do not qualify as Expert / Master even if solution length is high.

---

# 20. Phase 15 — Review Catalog and Production Release Gate

## Goal

Only replace production content after the new generator has demonstrated quality.

## Review Workflow

Generate into:

```text
review-catalog/
```

Never overwrite production directly.

## Required Review Data Per Candidate

Include:

### Identity

- seed,
- topology,
- generation mode,
- mechanism types,
- requested box count,
- actual box count.

### Geometry

- rooms,
- floor,
- regions,
- chokepoints,
- articulation points,
- tunnels.

### Reverse search

- restart count,
- meaningful restarts,
- archive rank,
- reverse depth.

### Solution

- moves,
- pushes,
- non-monotonic moves,
- box episodes,
- staging operations,
- temporary goal vacancies,
- dependency depth.

### Mechanism

- intended mechanism,
- defining evidence,
- counterfactual status,
- realization confidence.

### Quality

- quality profile,
- rejection warnings,
- tedium.

### Difficulty

- V4 classification,
- confidence.

### Solver evidence

- witness,
- greedy probe,
- A* evidence,
- optional proof.

## Human Playtest

For Expert / Master, manually play a meaningful sample.

Ask:

> **Would I voluntarily play another puzzle from this tier?**

Also record:

```text
Was there a clear idea?
Did the puzzle require reasoning?
Did it contain delayed consequences?
Did boxes interact?
Was the difficulty mostly thinking rather than walking?
Did the solution feel inevitable in hindsight?
```

## Production Acceptance Gate

Production replacement must fail if any of these occur:

- invalid puzzle,
- duplicate board,
- symmetry duplicate,
- requested/actual box mismatch,
- mechanism claim without defining evidence,
- tier classification mismatch beyond allowed policy,
- quality failure,
- missing required review metadata,
- quota shortfall if the release contract explicitly requires full quotas.

## Important Distinction

Separate statuses:

```text
structurally valid
solver verified
quality qualified
difficulty qualified
human reviewed
release approved
```

---

# 21. Recommended New Generator Invariants

These should become explicit automated assertions.

## Invariant A — Tile semantics

No wall, keeper, or goal can be parsed as a box.

## Invariant B — Box accounting

```text
requestedBoxCount
==
actualBoxCount
==
goalCount
==
genericBoxCount + typedBoxCount
```

## Invariant C — Geometry

Accepted puzzle satisfies intended tier geometry contract.

## Invariant D — Solvability

Every accepted candidate has a valid witness or successful trusted solver result.

## Invariant E — Mechanism identity

Every claimed mechanism satisfies its defining evidence requirements.

## Invariant F — Hard-tier mechanism confidence

Expert / Master mechanism claims cannot be based only on observed completion order.

## Invariant G — Difficulty independence

Difficulty classification does not inspect tier quotas.

## Invariant H — Quality independence

Candidate quality thresholds do not become weaker because a tier is short.

## Invariant I — Restart integrity

A configured restart must use its own local transposition state.

## Invariant J — Production V4 authority

Production generation must invoke the current V4 evaluator, quality model, difficulty model, and diversity curation.

---

# 22. Recommended Rejection Taxonomy

Improve diagnostics by using specific reasons.

Example:

```ts
type ForgeRejectionReason =
  | "blueprint-failed"
  | "geometry-room-count"
  | "geometry-floor-min"
  | "geometry-floor-max"
  | "geometry-floor-coverage"
  | "geometry-regions"
  | "geometry-chokepoints"
  | "mechanism-plan-failed"
  | "mechanism-box-budget-failed"
  | "mechanism-placement-failed"
  | "reverse-search-empty"
  | "reverse-search-low-diversity"
  | "validation-failed"
  | "witness-invalid"
  | "unsolvable"
  | "typing-replay-failed"
  | "mechanism-evidence-missing"
  | "mechanism-counterfactual-failed"
  | "quality-interaction"
  | "quality-depth"
  | "quality-tedium"
  | "difficulty-mismatch"
  | "duplicate-exact"
  | "duplicate-symmetry";
```

This will make hard-tier bottlenecks measurable rather than anecdotal.

---

# 23. Recommended Implementation Order Within Claude Sessions

If this work is handed to Claude incrementally, use this order.

## Session / Sprint 1

Implement:

- Phase 0 diagnostics,
- Phase 1 tile semantics,
- exact evaluator tests.

Do not touch difficulty thresholds.

## Session / Sprint 2

Implement:

- Phase 2 reverse restart repair,
- archive fix,
- restart tests.

Do not increase search budgets yet.

## Session / Sprint 3

Implement:

- Phase 3 box budget,
- provenance invariants,
- manifest checks.

## Session / Sprint 4

Implement:

- Phase 4 geometry profile enforcement,
- nested family correction.

## Session / Sprint 5

Implement:

- Phase 5 mechanism semantic wiring,
- mechanism-level evidence results.

## Session / Sprint 6

Implement:

- Phase 6 causal / counterfactual verification for at least:
  - gatekeeper,
  - gate-reopening,
  - must-stage,
  - must-park.

Then expand to chain / exchange.

## Session / Sprint 7

Implement:

- Phase 7 mechanism-first geometry.

Start with 2–3 mechanisms before generalizing.

Recommended first targets:

1. packing-chain,
2. gatekeeper,
3. gate-reopening.

## Session / Sprint 8

Implement:

- Phase 8 reverse objective alignment,
- multiple archive candidates per blueprint.

## Session / Sprint 9

Refactor:

- Phase 9 true funnel.

Measure solver-call reduction.

## Session / Sprint 10

Integrate:

- V4 finalist evaluator,
- V4 difficulty,
- V4 curation.

## Session / Sprint 11

Implement:

- quality gate,
- handcrafted calibration.

## Session / Sprint 12

Implement:

- semantic test suite,
- final review catalog,
- release gate.

---

# 24. Anti-Patterns / What Not to Do

Until the relevant correctness phases pass, do not:

- increase Master beam width,
- increase Master max depth,
- increase restart count,
- increase solver limits,
- run huge seed windows,
- reduce dependency thresholds,
- lower V4 difficulty thresholds,
- classify by quota need,
- promote lower tiers,
- or accept more puzzles merely to fill catalog slots.

Also avoid:

## 24.1 Optimizing only solver difficulty

Solver expanded states are not a substitute for human reasoning quality.

## 24.2 Rewarding board size directly

Large boards can create walking and search noise without better puzzles.

## 24.3 Treating declared DAG edges as reality

The final solution must supply evidence.

## 24.4 Treating one observed solution as a proof of necessity

Use counterfactual checks for defining hard-tier mechanisms.

## 24.5 Keeping every candidate when supply is low

Low supply should trigger more generation, not lower selectivity.

---

# 25. Definition of “Quality Puzzle” for This Generator

The generator should optimize toward the following product definition:

> **A quality Sokomind puzzle presents a small number of consequential decisions whose implications interact over time, requires the player to understand why boxes cannot simply be solved independently, uses its geometry purposefully, contains enough plausible alternatives to require reasoning, and avoids difficulty that comes primarily from walking, repetition, board size, or brute-force search.**

Particularly valuable hard-tier properties:

- temporary displacement,
- non-monotonic progress,
- goal vacating and refilling,
- box reuse,
- staging,
- shared support squares,
- corridor contention,
- access-state changes,
- dependency chains,
- delayed consequences,
- misleading but logical alternatives,
- multi-box interactions.

---

# 26. Definition of V4.1 Complete

V4.1 should not be called complete until all of the following are true.

## Correctness

- [ ] Tile semantics are centralized.
- [ ] Exact branching oracle tests pass.
- [ ] Exact box-switch / interaction oracle tests pass.
- [ ] Requested box count always equals actual.
- [ ] Geometry profile is enforced.

## Reverse Search

- [ ] Each restart independently explores.
- [ ] Archive eviction bookkeeping is correct.
- [ ] Multiple reverse states per blueprint can reach evaluation.

## Mechanisms

- [ ] Every mechanism maps to defining semantic evidence.
- [ ] Evidence requirements are preserved.
- [ ] Expert / Master mechanisms use structural or counterfactual verification.
- [ ] Mechanism-first geometry is implemented for hard-tier mechanism mode.

## Pipeline

- [ ] Cheap stages occur before expensive solver work.
- [ ] V4 finalist evaluator is authoritative.
- [ ] Quality gate occurs before difficulty.
- [ ] V4 difficulty is authoritative.
- [ ] Final curation uses Pareto + novelty + diversity quotas.

## Catalog Policy

- [ ] Difficulty is not quota-sensitive.
- [ ] Quality is not quota-sensitive.
- [ ] Quota shortfall does not auto-promote candidates.
- [ ] Review generation cannot overwrite production accidentally.
- [ ] Production acceptance includes quality and mechanism checks.

## Validation

- [ ] Handcrafted calibration report exists.
- [ ] Expert / Master human playtest sample passes review.
- [ ] Production catalog is only regenerated after all release gates pass.

---

# 27. First Implementation Tasks

If beginning immediately, do these first:

### Task 1

Create centralized tile semantic helpers and replace every duplicated generator box/goal/wall parser.

### Task 2

Add exact oracle tests for reachable pushes, forced pushes, box switches, and typed/generic entity parsing.

### Task 3

Move reverse-search transposition state inside each restart and fix archive stale-key replacement.

### Task 4

Add restart diagnostics proving every restart expands meaningful states.

### Task 5

Change mechanism planning so the full requested box budget is allocated exactly.

### Task 6

Add fatal invariants for requested / actual / goal / typed+generic box count equality.

Only after these six tasks are complete should the next diagnostic Expert / Master generation run be trusted enough to analyze.

---

# 28. Expected Outcome

After V4.1, the generator should be able to answer the following questions reliably:

```text
Why did this candidate fail?
What mechanism was intended?
Did that mechanism actually matter?
How many boxes were actually generated?
Did geometry satisfy the tier contract?
How many genuinely different reverse states were explored?
Did the puzzle pass a quality floor?
Why was it classified as this difficulty?
Why was it selected over similar candidates?
```

That level of observability is the prerequisite for improving generation quality scientifically rather than by guesswork.

Once those foundations are in place, search-budget tuning becomes useful.

Before then, it does not.
