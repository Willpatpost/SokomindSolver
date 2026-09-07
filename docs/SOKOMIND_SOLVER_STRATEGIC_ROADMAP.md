# Sokomind Solver: Strategic Intelligence Audit and Implementation Roadmap

> **2026-09-07 implementation checkpoint:** Sprint 2 connected matching,
> alternative goal supports, temporary clearance, and task macros are implemented
> experimentally. Quality acceptance remains open: Grand Hall is 952 moves versus
> the production 893. Keep execution opt-in. Prioritize route quality before the
> timing target; see the Sprint 2 checkpoint in `docs/fast-strategic-analyzer-plan.md`
> and raw `docs/benchmarks/strategic-inference-sprint2.json` for evidence and the
> next approach/owner hypothesis work.

**Repository:** `Willpatpost/SokomindSolver`  
**Audit target:** current `main` branch as reviewed on 2026-09-07  
**Scope:** flagship **Sokomind Solver** only; commit history intentionally excluded  
**Purpose:** turn the current sophisticated Sokoban search portfolio into a solver that **studies a puzzle, derives what must and must not happen, forms a causal plan, and then searches to execute and repair that plan**.

---

**Architecture revision — 2026-09-07:** Corrected dependency strength, temporal
resource semantics, predicate validation, scoped provenance, matching reuse,
move-aware scoring, and delivery order. Part VII governs implementation order;
earlier priority groupings describe topics, not prerequisites. These are planned
changes, not claims that the architecture is already implemented.

## 1. Executive summary

The current Sokomind Solver is already much closer to a “thinking” solver than a conventional brute-force or heuristic Sokoban engine. It has strong ingredients:

- typed-box-aware geometry and goal feasibility;
- articulation points, rooms, tunnels, doorway lanes, and room interfaces;
- reverse push information and box-to-goal domains;
- goal-access analysis;
- doorway import/export obligations;
- transport planning and relaxed transit prerequisites;
- bounded local strategic simulation;
- a strategic plan object with candidate schedules;
- a dedicated `plan-macro-beam` structural lane;
- checkpoint continuations, bidirectional search, diversified discovery, rewrite/improvement, and proof lanes;
- independent replay verification at the solver boundary.

The latest strategic-planning work is a real improvement. The issue is not that Sokomind lacks analysis. The issue is that **the strongest analysis is not yet the authoritative control model for the complete solve**.

Today, the strategic planner is best described as a **bounded plan simulator and seed generator**:

1. analyze the board;
2. construct tasks such as `release`, `export`, and `deliver`;
3. simulate some task sequences;
4. keep several candidate move paths;
5. pass those paths into `plan-macro-beam` as prepared strategic seeds;
6. let the broader portfolio continue largely through ordinary search with coarse recommendations.

That is useful, but it is still different from the desired architecture:

> Analyze the puzzle → infer constraints until stable → build a causal partial-order plan → search only among currently sensible plan actions → mark phases complete → re-analyze when the strategic situation changes → repair the remaining plan → verify the end-to-end solution.

The most important recommendation in this document is therefore:

> **Promote the strategic plan from a candidate-path hint into a typed, persistent, explainable plan DAG whose tasks, dependencies, invariants, resources, alternatives, and completion state govern the entire flagship solver.**

Everything else in this roadmap supports that change.

---

## 2. The north-star behavior

A strong human Sokoban solver does not normally begin by enumerating pushes. The human first tries to answer questions such as:

- Which goals are deep or dangerous?
- Which boxes can even reach those goals?
- Which box-goal assignments are forced?
- Which boxes are interchangeable and which are not?
- Which corridors are one-way or effectively one-way?
- Which rooms must be emptied before they can be filled?
- Which doorway must remain open?
- Which keeper support square will be needed later?
- Which goal must not be occupied yet?
- Where can a box be staged without consuming a future route?
- Does one box have to move merely to let another box pass?
- Can a local room be solved independently?
- Which orderings are proven, and which are only guesses?
- If there are two plausible plans, which one should be tested first?

Only after that mental model exists does the human search detailed moves.

The target Sokomind architecture should mirror that process.

```text
                           PUZZLE
                              |
                              v
                  +-----------------------+
                  | Strategic Analyzer    |
                  |-----------------------|
                  | static topology       |
                  | reverse feasibility   |
                  | assignment domains    |
                  | keeper support        |
                  | doorway resources     |
                  | room/corral structure |
                  | staging safety        |
                  | ordering constraints  |
                  +-----------+-----------+
                              |
                              v
                    constraint fixed point
                              |
                              v
                  +-----------------------+
                  | Strategic Plan DAG    |
                  |-----------------------|
                  | tasks                 |
                  | prerequisites         |
                  | completion predicates |
                  | preserve invariants   |
                  | resource locks        |
                  | alternatives          |
                  | proof provenance      |
                  +-----------+-----------+
                              |
                              v
                       enabled tasks
                              |
                              v
                  +-----------------------+
                  | Hierarchical Search   |
                  |-----------------------|
                  | room macros           |
                  | transport macros      |
                  | staging macros        |
                  | goal-commit macros    |
                  | exact push execution  |
                  +-----------+-----------+
                              |
                   strategic event occurs?
                       /              \
                     yes              no
                      |                |
                      v                v
                incremental          continue
                 re-analysis          search
                      |
                      v
                   plan repair
                      |
                      +------------------+
                                         |
                                         v
                                     SOLUTION
                                         |
                                         v
                                independent replay
                                   verification
```

Search remains essential. Sokoban is too combinatorial to replace search with rules. The goal is not to eliminate search; it is to make search **execute a model of the puzzle rather than discover that model accidentally through state expansion**.

---

## 3. Current implementation: what is already strong

### 3.1 Root puzzle analysis is meaningful

`src/solver/implementations/sokomind-engine/source/analysis.js` already computes or exposes several strategically valuable concepts.

Important current functions include:

- `analyzeGoalTransitPrerequisites(...)`
- `analyzeTransportPlan(...)`
- `analyzePuzzleForSearch(...)`
- doorway assignment and box domains from the topology/assignment layer;
- goal access analysis;
- room summaries and room interfaces;
- initial legal pushes and heuristic pressure;
- reverse-start portfolio information;
- prepared-board caches.

The current transit analysis is particularly valuable because it recognizes a subtle Sokoban concept: **final occupation of a goal can destroy a route required by another box**. It models prerequisite boxes that must first reach release regions before a particular final occupation becomes strategically safe.

That is exactly the type of reasoning the final solver needs more of.

### 3.2 The latest strategic planner is not superficial

`src/solver/implementations/sokomind-engine/source/strategic-planning.js` introduces a bounded full-board simulation layer.

Current task kinds are principally:

- `release`
- `export`
- `deliver`

`strategicTasks(...)` derives those tasks from the current state, doorway obligations, transit prerequisites, and an assignment detail.

`simulateStrategicTask(...)` then attempts to realize a task while keeping non-participating boxes as real obstacles. It can widen the participant set when another box repeatedly obstructs progress. That is significantly better than planning in a completely relaxed board.

`buildStrategicPlan(...)` searches several layers of task schedules and returns candidate paths, task IDs, endpoints, estimated remaining pushes, and statistics.

The planner also canonicalizes board orientation, which is a good way to keep strategic behavior symmetry-aware.

### 3.3 The structural lane actually receives the plan

`src/solver/implementations/sokomind-plans.ts` passes `analysisPlan.strategicPlan` into the engine payload for `algorithm: "plan-macro-beam"`.

That is the correct architectural direction.

### 3.4 The broader portfolio uses analysis recommendations

The discovery planner also consumes analysis-derived recommendations such as:

- beam width;
- beam visited budget;
- checkpoint limit;
- reverse worker limit;
- side visited limit;
- sequence macro use;
- whether a milestone-oriented beam profile should be used.

This lets analysis influence later search, but only at a coarse configuration level.

### 3.5 The solver has a strong correctness boundary

The existing independent solution verification/replay layer should be preserved. A smarter planner will create more aggressive pruning and more complicated search control. That makes independent final verification even more important.

The future strategic planner should follow the same philosophy:

> **Reason aggressively, but distinguish proven constraints from guidance, and never trust a candidate route until the core model replays it successfully.**

---

## 4. The central gap: a strategic seed is not yet a persistent plan

The current `strategicPlan` is effectively a set of candidate execution traces.

At a high level, the implementation behaves like this:

```text
root analysis
    |
    v
strategic tasks
    |
    v
bounded task simulation
    |
    v
candidate move paths + task IDs
    |
    v
preparedStrategicSeeds(...)
    |
    v
plan-macro-beam starts from useful endpoints
    |
    v
broader search portfolio
```

`preparedStrategicSeeds(...)` replays the candidate paths and converts them into search seeds. This is useful, but the **causal meaning of the plan mostly disappears into the seed**.

The later solver does not universally carry an object equivalent to:

```text
completed tasks
active tasks
unlocked tasks
still-required resources
forbidden commitments
current plan hypothesis
assumptions that remain valid
```

That distinction matters enormously.

A seed says:

> “Here is a promising place to start searching.”

A real plan says:

> “These things must happen; these things must remain possible; these tasks are currently enabled; this move would violate a future requirement; this phase is complete; this assumption has failed; therefore repair this portion of the plan.”

The remainder of this roadmap is about building the second system incrementally on top of the first.

---

# Part I — P0 changes: build the planning backbone

## 5. P0-1: create an authoritative typed Strategic Plan contract

### 5.1 Where the weakness is now

At the TypeScript boundary in `src/solver/implementations/sokomind-legacy.ts`, the strategic plan is currently exposed as:

```ts
readonly strategicPlan?: Readonly<Record<string, unknown>>;
```

This is striking because the strategic plan is supposed to become the highest-level reasoning product of the flagship solver, yet it has a weaker contract than many ordinary solver settings.

`analysisPlanFromAnalysis(...)` only checks that the object has `schemaVersion === 1` and then shallowly freezes it.

That is acceptable for an experiment. It should not remain the final architecture.

### 5.2 What to introduce

Create a JSON-safe wire-level contract for the strategic plan.

A practical first version could look like this:

```ts
export type StrategicFactStrength =
  | "proven"
  | "derived-safe"
  | "heuristic";

export type StrategicTaskKind =
  | "release"
  | "export"
  | "import"
  | "transport"
  | "stage"
  | "clear-doorway"
  | "preserve-support"
  | "commit-goal"
  | "solve-room"
  | "solve-corral";

export type StrategicFactScope =
  | { readonly kind: "static"; readonly boardKey: string }
  | { readonly kind: "snapshot"; readonly snapshotKey: string }
  | { readonly kind: "hypothesis"; readonly snapshotKey: string;
      readonly hypothesisId: string; readonly assumptionIds: readonly string[] };

export interface StrategicEvidence {
  readonly id: string;
  readonly strength: StrategicFactStrength;
  readonly scope: StrategicFactScope;
  readonly rule: string;
  readonly sourceIds: readonly string[];
  readonly reason: string;
}

/** Initial variants; add each new kind with its validator and evaluator. */
export type StrategicPredicate = StrategicEvidence & (
  | { readonly kind: "box-in-region"; readonly boxCandidates: readonly number[];
      readonly regionId: string }
  | { readonly kind: "goal-unoccupied"; readonly goalId: string }
  | { readonly kind: "keeper-can-reach"; readonly cell: string }
  | { readonly kind: "doorway-open"; readonly doorwayId: string }
  | { readonly kind: "task-complete"; readonly taskId: string }
);

export interface StrategicTask {
  readonly id: string;
  readonly kind: StrategicTaskKind;

  /** Set-valued whenever interchangeable boxes are still possible. */
  readonly boxCandidates: readonly number[];

  /** Set-valued until a target is actually forced or a hypothesis selects one. */
  readonly goalCandidates: readonly string[];

  /** Facts that must hold before this task is enabled. */
  readonly requires: readonly StrategicPredicate[];

  /** Facts used to recognize completion from a board state. */
  readonly completesWhen: readonly StrategicPredicate[];

  /** Invariants enforced only during their declared resource-use intervals. */
  readonly preserve: readonly StrategicPredicate[];

  /** Explicit partial-order edges. */
  readonly dependsOn: readonly string[];

  /** Resources consumed, reserved, or released. */
  readonly resources: readonly StrategicResourceUse[];

  /** Whether failure can invalidate the task or only the current realization. */
  readonly strength: StrategicFactStrength;

  readonly explanation: string;
}

export interface StrategicPlanHypothesis {
  readonly id: string;
  readonly taskIds: readonly string[];
  readonly assumptions: readonly StrategicPredicate[];
  readonly estimatedCost: number;
  readonly uncertainty: number;
}

export interface StrategicPlan {
  readonly schemaVersion: 2;
  readonly snapshotKey: string;
  readonly tasks: readonly StrategicTask[];
  readonly resources: readonly StrategicResource[];
  readonly facts: readonly StrategicPredicate[];
  readonly hypotheses: readonly StrategicPlanHypothesis[];
  readonly recommendedHypothesisId?: string;
  readonly analysis: StrategicAnalysisSummary;
}
```

Every predicate kind needs exhaustive runtime evaluation and bounded validation of its payload, references, and scope. Unknown kinds or invalid packages reject the plan and resume ordinary search; they must never become pruning evidence. The union above is an initial subset, not permission to accept arbitrary string/payload predicates.

The exact names can change. The important architectural shift is that the plan stops being “some object from the engine” and becomes a **versioned solver contract**.

### 5.3 Why the plan needs predicates

Hardcoding every possible planning relation as a separate field will become unmanageable.

Predicates let the planner express things like:

```text
box-in-region(B, R)
goal-unoccupied(G)
doorway-open(D)
keeper-can-reach(S)
box-domain(B) intersects {G1,G2}
room-export-balance(R) = 0
all-dependent-tasks-complete(T)
support-square-unoccupied(S)
```

This makes task completion and plan repair much easier because the solver can **re-evaluate predicates against a new board state**.

### 5.4 Do not confuse search phases with strategic tasks

The current analysis exposes phases such as:

- `evacuation`
- `room-packing`
- `tunnel-macros`
- `feature-space`
- `milestone-reverse`
- `landmark-bridges`
- `exact-proof`

These are useful, but they are primarily **search-stage recommendations**.

They are not equivalent to puzzle-specific strategic tasks such as:

```text
export box from room 2
keep doorway 1 open
stage one blue box outside room 3
solve deep goal g7 before g4
clear support square s18
```

Rename or type these concepts separately:

```ts
type SearchStageId = ...;
type StrategicTaskId = string;
```

This will prevent the architecture from blurring “which algorithm should run?” with “what must happen in this puzzle?”

### 5.5 Add validation immediately

Create something like:

a proposed `sokomind-strategic-contract.ts` module under `src/solver/implementations`

with:

- `isStrategicPlan(value)`
- `assertStrategicPlan(value)`
- `strategicPlanFromAnalysis(value)`

Validate:

- schema version;
- unique task IDs;
- all dependency IDs exist;
- no malformed resource IDs;
- box candidate indices are in range;
- goal cells exist;
- proof-strength enums are valid;
- plan hypotheses only reference declared tasks;
- dependency cycles are either rejected or explicitly represented as a special “joint group” rather than silently accepted.

### 5.6 Preserve same-label box symmetry

This is subtle and important.

The existing legacy layer explicitly notes that same-label boxes may be interchangeable in canonical identities, even though snapshot order is preserved for order-sensitive caches.

The strategic planner currently uses `boxIndex` heavily.

That is safe for executing a particular candidate path, but it can be dangerous if a future hard planner interprets an arbitrary box index as a permanent semantic identity.

Example:

```text
Two identical blue boxes A and B can both reach goals G1 and G2.
The plan says “box index 0 must go to G1.”
Later search swaps their effective roles.
The board is still strategically correct, but the plan thinks it failed.
```

Therefore:

- use **set-valued box candidates** until a physical box role is actually forced;
- use label + region + current candidate set as the semantic role where possible;
- only lock a concrete box identity when an inference proves that identity matters;
- allow plan repair to rebind an interchangeable task to another equivalent box.

This prevents the planner from destroying useful symmetry reduction.

### 5.7 Acceptance criteria for P0-1

Do not change search behavior yet. First make this a contract-only refactor.

Success means:

- every strategic plan crossing the JS/TS boundary is strongly validated;
- current candidate-path behavior is preserved;
- current tests still pass;
- the strategic plan can be logged/debugged without inspecting arbitrary records;
- future fields can be introduced through a schema version bump.

---

## 6. P0-2: make plan progress govern the entire Sokomind solve

### 6.1 Current behavior to change

`structuralPlan(...)` passes the full `strategicPlan` to `plan-macro-beam`.

By contrast, `discoveryPlans(...)` mainly consumes coarse recommendations such as beam width, visited limits, checkpoint count, reverse-lane settings, and beam profile.

The practical consequence is:

> the plan is strongest in one lane, while the overall flagship solver is still a portfolio whose later lanes can lose most of the plan semantics.

### 6.2 Target behavior

Every flagship forward-search lane should understand the current strategic context.

Conceptually, a search node needs:

```text
board state
keeper reachability identity
plan hypothesis
completed task mask
active resource locks
```

Do **not** literally attach large JS objects to every node. Use compact encodings.

For example:

```ts
interface PlanExecutionState {
  readonly hypothesisIndex: number;
  readonly completedMask: bigint;
  readonly releasedResourceMask: bigint;
}
```

For more than 64 tasks, use a compact typed-array bitset or interned immutable bitset.

### 6.3 Derive progress from board state whenever possible

Avoid unnecessary state-space multiplication.

If task completion is purely derivable from the current board:

```text
box is outside room
box is on allowed goal
support square is clear
```

then recompute it rather than storing history.

Only store history when the strategy genuinely depends on an irreversible historical choice that is not visible in the board configuration.

This distinction is important for transposition tables:

- If two identical board states have identical future possibilities, they should normally merge.
- Do not prevent merging merely because the solver reached them through different narrative task sequences.

A useful rule:

> **Plan execution metadata belongs in the transposition identity only if it changes the legal/strategically admissible future from the same physical board state.**

### 6.4 Add a plan evaluator to successor generation

Create a central function conceptually like:

```ts
interface PlanTransitionAssessment {
  readonly admissible: boolean;
  readonly hardViolation?: string;
  readonly tasksCompleted: readonly string[];
  readonly tasksEnabled: readonly string[];
  readonly strategicProgress: number;
  readonly resourceRisk: number;
  readonly hypothesisCompatibility: number;
}

function assessPlanTransition(
  before: State,
  after: State,
  plan: StrategicPlan,
  execution: PlanExecutionState,
): PlanTransitionAssessment;
```

Use the result in all Sokomind-specific forward lanes.

### 6.5 Use three levels of control

Do not immediately turn every strategic preference into a prune.

Use:

#### Level A — hard admissibility

Only for sound constraints:

- static dead squares;
- proven box-goal infeasibility;
- proven resource destruction;
- proven impossible room balance;
- exact local macro preconditions;
- formally validated ordering constraints.

If violated, prune.

#### Level B — plan-first ordering

For strong but not fully proven strategy:

- moves that advance an enabled task;
- moves that clear a known blocker;
- moves that improve a staging requirement;
- moves that preserve scarce future access.

Generate or rank these first.

#### Level C — escape/recovery search

If plan-guided search stalls, allow broader legal search.

This should be explicit and measurable:

```text
plan lane exhausted
    -> recovery lane
    -> if recovery discovers a strategic event
    -> repair/rebuild plan
```

Do not silently let the generic lane become the main solver without knowing it happened.

### 6.6 Make task enablement explicit

For every node or checkpoint:

```text
completed = tasks whose completion predicates hold
blocked   = tasks whose prerequisites do not hold
enabled   = incomplete tasks whose prerequisites hold
```

Then macro generation can prefer:

```text
enabled task macros
required blocker-clearing macros
safe staging macros
only then unrelated pushes
```

This is the difference between “search with a heuristic” and “search inside a plan.”

### 6.7 Propagate the plan through checkpoints

`checkpointContinuationPlans(...)` currently resumes from structural checkpoints and launches ordinary discovery with analysis recommendations.

Change checkpoints to optionally carry strategic context:

```ts
interface StrategicCheckpoint extends LegacySearchCheckpoint {
  readonly planSnapshot?: {
    readonly hypothesisId: string;
    readonly completedTaskIds: readonly string[];
    readonly activeResourceIds: readonly string[];
    readonly unresolvedAssumptionIds: readonly string[];
  };
}
```

Validate this context by recomputing it from the replayed checkpoint state. Never trust serialized progress blindly.

### 6.8 Keep exact proof independent

The optimal proof lane must not inherit heuristic restrictions.

Safe proven constraints may be shared, but if a constraint is merely “the planner thinks left room first is best,” exact A*/IDA* must remain free to disprove it.

### 6.9 Acceptance criteria for P0-2

A successful version should show:

- plan task completion in telemetry;
- plan-aware successor ranking in every flagship forward lane;
- zero solution-loss on small exhaustive regression boards;
- fewer expanded states on puzzles with meaningful structure;
- explicit counts for recovery/fallback expansions;
- checkpoint continuations retaining strategic intent.

---

## 7. P0-3: add a fixed-point strategic inference engine

### 7.1 Why this is the biggest reasoning upgrade

The analyzer already derives many useful facts, but the next level is to make facts **change one another repeatedly**.

Example:

```text
Initial domains:
A -> {G1, G2}
B -> {G2, G3}
C -> {G3}
```

Because `C -> G3` is forced:

```text
B -> G2
```

and then:

```text
A -> G1
```

Now suppose the final push to G1 consumes doorway D, while B must cross D to reach G2.

Then:

```text
cross(B, D) BEFORE commit(A, G1)
```

This requires proof that committing A closes the required crossing route. It does not require B to finish on G2 first; that stronger edge needs separate evidence.

That new ordering may invalidate a staging square for A, which may create a new transport obligation, which may reveal another forced assignment.

This is how human deductions compound.

### 7.2 Introduce a fact store

Create an internal representation such as:

```ts
interface StrategicFact {
  readonly id: string;
  readonly kind: StrategicFactKind;
  readonly strength: StrategicFactStrength;
  readonly payload: JsonValue;
  readonly derivedFrom: readonly string[];
  readonly scope: StrategicFactScope;
  readonly rule: string;
}
```

Maintain indexes by:

- box;
- goal;
- room;
- doorway;
- support cell;
- resource;
- task.

### 7.3 Suggested inference passes

Run cheap rules first and expensive rules only when their inputs change.

#### Pass A — box-goal feasibility

Use current reverse push / compiled goal push information to build domains:

```text
D(box) = reachable compatible goals
```

Remove impossible edges.

#### Pass B — matching consistency

Run bipartite matching over each label class.

Use matching support to detect:

- edges that participate in no perfect matching;
- forced edges;
- forced subsets;
- Hall-style bottlenecks.

Reuse the existing `perfectMatchingDomains` implementation in
`src/solver/implementations/sokomind-engine/source/heuristic.js`. It already
computes allowed perfect-matching edges through alternating-cycle reachability.
The forced-assignment example above is already covered by this capability.

The upgrade is feedback from sound support, transit, and resource deductions
into matching domains. Recompute matching and supported edges when the domain
signature changes; do not reuse support computed for an older graph. Reserve
per-edge matching checks for a test oracle or a demonstrated gap in the existing
method, rather than adding redundant production work.

Deductions are monotone only within a fixed snapshot and assumption context.
A heuristic assumption may narrow its own hypothesis, never global domains.
On state or assumption changes, invalidate dependent facts and rebuild affected
domains before continuing propagation.

#### Pass C — final-push support requirements

For each still-possible goal commitment, record:

- final box predecessor cell;
- keeper support cell(s);
- doorway/corridor resources needed to reach those supports;
- goals whose occupation would block those supports.

#### Pass D — transport prerequisites

Feed `analyzeGoalTransitPrerequisites(...)` results into the fact store.

The current implementation intentionally treats these as advisory rather than hard pruning. Keep that conservatism until each inference rule has been separately validated for soundness.

#### Pass E — room flow constraints

From doorway assignments and room interfaces, derive:

```text
minimum exports
minimum imports
exports before imports
room sealing conditions
required doorway crossings
```

#### Pass F — staging viability

For a staging candidate, test whether placing a box there preserves:

- all remaining goal domains;
- keeper access to required support cells;
- required doorway crossings;
- room balance;
- escape options for the staged box.

Classify staging squares:

```text
safe
conditionally-safe-until(task X)
risky
proven-invalid
```

#### Pass G — ordering edges

Construct explicit causal relations:

```text
T1 -> T2
```

when completing T2 first would violate a proven requirement of T1.

#### Pass H — contradiction detection

Examples:

```text
box domain becomes empty
label matching becomes impossible
resource required by two incompatible permanent commitments
room requires more imports than available candidates
cyclic hard ordering with no staging escape
```

A contradiction should invalidate a **plan hypothesis** before it invalidates the puzzle unless the facts are all globally proven.

### 7.4 Iterate until stable

Pseudo-code:

```text
facts = initial_static_analysis()
agenda = all_initial_fact_ids

while agenda not empty and budget remains:
    changedInputs = pop_batch(agenda)

    for rule affected by changedInputs:
        newFacts, removals = rule.apply(facts)

        if contradiction:
            record contradiction/provenance

        for each actual change:
            update indexes
            agenda.add(change.id)

return fixed_point_or_partial_result
```

Do not rerun every expensive analysis every round. Use dependency indexes.

### 7.5 Budget by work as well as time

The current strategic analysis is wall-clock bounded, and deterministic mode rejects timed strategic analysis.

Introduce deterministic work budgets:

```ts
interface StrategicBudget {
  readonly maxRuleFirings?: number;
  readonly maxMatchingChecks?: number;
  readonly maxLocalSearchExpanded?: number;
  readonly maxGenerated?: number;
  readonly maxElapsedMs?: number;
}
```

Then deterministic mode can run:

```text
exactly N rule firings / matching checks / expansions
```

instead of disabling strategic reasoning simply because elapsed-time cutoffs are nondeterministic.

### 7.6 Measure information gain

Add metrics such as:

```text
initialGoalDomainEdges
finalGoalDomainEdges
forcedAssignments
removedAssignmentEdges
hardOrderingEdges
derivedOrderingEdges
safeStagingCells
rejectedStagingCells
resourceDependencies
factsDerived
ruleFirings
fixedPointReached
```

Then stop deep analysis when marginal information gain is low.

### 7.7 Acceptance criteria for P0-3

- On curated puzzles, analysis should derive more constraints before search.
- Every hard inference rule must have a soundness test.
- The same deterministic work budget must produce the same fact set.
- Search should expand fewer states when new facts are enabled.
- Disabling a heuristic fact must never change solvability; it should only change search effort.

---

# Part II — P1 changes: reason about time, resources, and subproblems

## 8. P1-1: model doorways, support squares, corridors, and staging areas as temporal resources

### 8.1 Why this is Sokoban-specific and high value

A goal is not merely a destination. Finishing a box changes the topology of every future keeper path and push.

The solver must reason about **resources that can be consumed by box placement**.

Examples:

- doorway D must remain traversable until two exports finish;
- support square S is needed for a later final push;
- corridor C must remain empty until box B crosses;
- staging square P can be occupied temporarily but must be vacated before task T;
- room gate G may be sealed only after the room's import/export balance is complete.

### 8.2 Introduce a resource vocabulary

For example:

```ts
export type StrategicResourceKind =
  | "doorway"
  | "keeper-support"
  | "corridor"
  | "staging-cell"
  | "room-interface"
  | "keeper-region";

export interface StrategicResource {
  readonly id: string;
  readonly kind: StrategicResourceKind;
  readonly cells: readonly string[];
  readonly explanation: string;
}

export interface StrategicResourceUse {
  readonly resourceId: string;
  readonly mode: "requires" | "preserves" | "consumes" | "releases";
  readonly strength: StrategicFactStrength;
  readonly activeFromTaskId: string;
  readonly activeUntilTaskId: string;
  readonly releaseObligationTaskId?: string;
}
```

Resource intervals are explicit task events, not "all time while a task is pending".
Temporary occupation may create a clearance obligation before a consumer becomes
enabled. An unverified clearance route is uncertainty within a hypothesis;
only a sound impossibility result justifies rejecting the board state.

### 8.3 Resource example

```text
Resource: doorway:R2
Required by:
  export:B4
  export:B7
Consumed by:
  commit:G9

Therefore:
  export:B4 -> commit:G9
  export:B7 -> commit:G9
```

Another:

```text
Resource: keeper-support:8,12
Required by:
  commit:G6
Threatened by:
  stage:B3@8,12

Therefore:
  clear B3 from 8,12 before commit:G6 needs its support
  temporary staging is allowed if its clearance remains feasible
  reject it as impossible only with sound evidence that clearance cannot occur
```

### 8.4 Turn current obstruction observations into causal evidence

`simulateStrategicTask(...)` already counts blockers encountered when trying to move toward a task destination. If the task fails and an obstruction dominates, the current code widens the participant group.

Preserve that behavior, but also emit structured evidence:

```text
Task T repeatedly requires cell C
Box B blocks C in 17 attempted realizations
```

That can create a new candidate dependency:

```text
clear-or-stage(B) BEFORE T
```

Repeated failed realizations are heuristic evidence, not proof that every realization needs this dependency. Keep the dependency hypothesis-scoped until independently justified.

This is more useful than merely making B part of the same local search.

### 8.5 Generalize participant widening

The current strategic simulation intentionally remains bounded and only widens small participant groups. That is good for runtime, but complex puzzles may need rearrangements involving more than three boxes.

Do not simply raise the participant cap aggressively; that turns strategic analysis into expensive full search.

Instead:

```text
small obstruction set -> local multi-box simulation
large/recurring obstruction set -> generate higher-level blocker-clearing task or room macro
```

This keeps the hierarchy intact.

### 8.6 Define a “future-plan deadlock”

Classic deadlock:

```text
box can never reach a goal
```

Strategic deadlock:

```text
current state may still be globally solvable,
but it violates every remaining plan hypothesis because a required future resource was consumed
```

If the resource loss is **proven globally**, prune.

If it only invalidates the current plan hypothesis, abandon/repair that hypothesis rather than declaring the board unsolvable.

This distinction is critical.

---

## 9. P1-2: perform incremental re-analysis and plan repair

### 9.1 Why root-only planning is insufficient

Humans repeatedly update their mental model:

> “Now that this box has moved, the doorway is clear.”  
> “Now that the room is solved, I can seal it.”  
> “That target assignment no longer makes sense; the other identical box should take it.”

A planner that only analyzes the root eventually works with stale strategic assumptions.

### 9.2 Do not re-analyze every search node

That would be far too expensive.

Use strategic event triggers.

Recommended triggers:

- a task completes;
- a room import/export balance changes;
- a goal becomes permanently occupied;
- a doorway transitions from reusable to effectively sealed;
- a box enters/leaves a critical room;
- a box becomes forced to one goal;
- a previously forced assignment becomes invalid;
- a plan-guided lane has no admissible advancing macro;
- a phase reaches a search plateau;
- a recovery lane discovers a materially different configuration;
- a local exact subproblem completes.

### 9.3 Plan repair, not full restart

Suppose:

```text
P1 -> P2 -> P3 -> P4 -> P5
```

P1 and P2 are complete. An assumption used by P3 fails.

Do this:

```text
preserve facts whose scope and evidence remain valid
re-evaluate P1/P2 completion against the current board
reopen any reversible task whose completion predicate no longer holds
invalidate affected downstream tasks
recompute affected domains/resources
rebuild only the invalid suffix
```

Not this:

```text
discard all analysis and begin from zero
```

### 9.4 Track provenance to make repair cheap

Every fact should record what produced it:

```text
fact F7
rule: goal-support-dependency
inputs: F1, F3, resource D2
```

If D2 changes, invalidate facts transitively derived from D2.

This is the same idea as incremental build systems and truth-maintenance systems.

### 9.5 Suggested API

```ts
interface StrategicRepairRequest {
  readonly previousPlan: StrategicPlan;
  readonly previousStateKey: string;
  readonly currentState: LegacyState;
  readonly strategicEvents: readonly StrategicEvent[];
  readonly budget: StrategicBudget;
}

interface StrategicRepairResult {
  readonly plan: StrategicPlan;
  readonly preservedTaskIds: readonly string[];
  readonly invalidatedTaskIds: readonly string[];
  readonly newTaskIds: readonly string[];
  readonly changedFactIds: readonly string[];
  readonly reason: string;
}
```

### 9.6 Cache static and dynamic analysis separately

Do not recompute static geometry:

**Static/cacheable:**

- floor graph;
- articulation points;
- tunnels;
- static reverse push tables;
- goal final-push geometries;
- room decomposition;
- dense board indices.

**Dynamic:**

- current goal domains;
- keeper reachability;
- current doorway occupancy;
- staging safety;
- resource availability;
- room balance;
- enabled tasks.

The current prepared-board system is already a good foundation for this split.

### 9.7 Acceptance criteria

- replanning occurs only at strategic events;
- completed sound tasks survive repair;
- stale assumptions are invalidated;
- static-board computation is reused;
- replan time is much smaller than root analysis on average;
- replanning reduces fallback-search expansions on puzzles with multiple phases.

---

## 10. P1-3: convert local exact room/corral reasoning into contract macros

### 10.1 Why macros should carry guarantees

If a small room can be solved exactly, the global solver should not rediscover every push arrangement every time it enters that room.

Represent a solved local transformation as a contract.

```ts
interface StrategicMacro {
  readonly id: string;
  readonly kind: "room" | "corral" | "transport" | "goal-sequence";
  readonly preconditions: readonly StrategicPredicate[];
  readonly effects: readonly StrategicPredicate[];
  readonly preserves: readonly StrategicPredicate[];
  readonly path?: readonly string[];
  readonly pushes: number;
  readonly moves: number;
  readonly proof: "exact-local" | "verified-realization" | "heuristic";
}
```

Example:

```text
Macro: SolveRoom3

Requires:
  doorway D open
  boxes {B2,B5} in room
  keeper can enter from west

Guarantees:
  two matching goals filled
  no remaining export obligation
  keeper exits to region R4

Preserves:
  central corridor C

Cost:
  9 pushes
  14 moves
```

### 10.2 Hierarchical search target

```text
Strategic search:
    choose room/transport/commit tasks

Macro search:
    find a verified realization of the chosen task

Push search:
    execute exact pushes

Keeper pathfinding:
    connect pushes with shortest/appropriate walks
```

This is a much more scalable hierarchy than putting every concern into one score function.

### 10.3 Cache macros by local interface signature

A room macro can be reused when the relevant local state matches:

```text
room topology ID
box multiset/labels inside
entry keeper position (or separately priced entry connector)
entry keeper region
boundary occupancy
required external resources
```

Include every external connectivity assumption used by the local proof. Keeper region alone cannot identify walking cost: different entry positions can require different walks. Replay cached realizations against the full board, recompute connector cost, and verify their contracts. A valid macro does not prove that alternative local paths can be pruned; that requires a separate completeness or dominance argument.

Do not key only by full-board state.

### 10.4 Corrals

Corrals are especially suitable because keeper exclusion creates a natural subproblem boundary.

If a corral is independent enough to solve exactly:

- solve it locally;
- export its verified result as a macro;
- mark which global resources the macro consumes;
- use the macro as one high-level transition.

---

# Part III — P2 changes: uncertainty, alternatives, and default intelligence

## 11. P2-1: branch on plan hypotheses, not immediately on pushes

### 11.1 Current strategic diversity is still path-oriented

`buildStrategicPlan(...)` keeps candidate schedules and deliberately preserves diversity among first tasks/task kinds.

That is a good start, but the solver should eventually represent **different theories of the solution**, not just different first paths.

Example:

```text
Hypothesis A:
  export left room
  solve central deep goal
  then pack right room

Hypothesis B:
  stage central box
  export right room first
  reopen center
  then solve left room
```

### 11.2 A hypothesis should contain assumptions

```ts
interface StrategicPlanHypothesis {
  id: string;
  assumptions: StrategicPredicate[];
  tasks: string[];
  lowerBound: number;
  uncertainty: number;
  scarceResourcesRequired: string[];
  estimatedSearchWidth: number;
}
```

Then allocate bounded search to the best 2–4 hypotheses.

### 11.3 Avoid premature target assignment

The current strategic task builder uses a concrete `assignedTarget` when creating `deliver` tasks.

That is efficient when the assignment is genuinely forced. It is risky when multiple same-label assignments remain feasible.

Future behavior should be:

```text
if target is proven forced:
    create commit/deliver task to that target

else if a small number of assignments remain:
    branch plan hypotheses

else:
    keep set-valued goal domain and delay commitment
```

This is one of the most important safeguards against making a “smart” solver brittle.

### 11.4 Hypothesis portfolio is better diversity than parameter-only portfolio

Sokomind already runs diversified search configurations.

Keep that, but add semantic diversity:

```text
worker 1: plan hypothesis A, balanced execution
worker 2: plan hypothesis B, balanced execution
worker 3: recovery/search-diverse lane
```

Now parallelism tests different **solution theories**, not merely different numerical weights.

---

## 12. P2-2: make strategic analysis normal, not an experimental opt-in

### 12.1 Current configuration issue

`src/solver/implementations/sokomind-options.ts` currently defines:

```ts
strategicAnalysisMs: 0
```

and describes it as experimental strategic preparation.

In addition, the top-level solver currently runs the preparation phase only when the puzzle passes the structural-size gate. The current constants are:

```text
STRUCTURAL_BOX_THRESHOLD  = 10
STRUCTURAL_FLOOR_THRESHOLD = 100
```

That means many difficult 4–9 box puzzles can skip the strategic preparation entirely even though those puzzles may depend heavily on goal order and access.

This does not match the long-term identity of the flagship solver.

### 12.2 Replace one analysis switch with tiers

Recommended model:

```text
Tier 0: mandatory cheap analysis
  - static dead cells
  - reverse domains
  - basic goal matching
  - obvious room/doorway facts
  - obvious goal support conflicts

Tier 1: structural inference
  - matching propagation
  - doorway resources
  - room flow
  - staging analysis
  - ordering inference

Tier 2: bounded strategic simulation
  - current release/export/deliver simulation
  - obstruction discovery
  - plan hypotheses

Tier 3: selective local exact analysis
  - small rooms
  - corrals
  - ambiguous critical subproblems
```

Every puzzle gets Tier 0.

Use **reasoning pressure**, not just board size, to decide whether to run deeper tiers.

### 12.3 Better trigger metrics than box/floor count

Compute metrics like:

```text
goal-domain entropy
number of ambiguous matching edges
number of articulation-controlled goals
number of rooms with mixed import/export
number of scarce keeper-support cells
dependency density
staging scarcity
keeper-access pressure
number of competing plan hypotheses
```

A small puzzle with high uncertainty may deserve deep analysis; a large open puzzle may not.

### 12.4 Deterministic mode

The current options reject timed strategic analysis when deterministic mode is enabled.

Once work-unit budgets exist, deterministic mode can use:

```text
strategicAnalysisWork = 5000
```

rather than `strategicAnalysisMs`.

Long-term, prefer an options model such as:

```ts
strategicAnalysis: {
  level: "auto" | "cheap" | "deep" | "off";
  maxWork?: number;
  maxElapsedMs?: number;
}
```

Stable iteration order, deterministic tie-breaking, and work accounting are required for reproducibility. An emergency wall-clock cutoff must be reported as partial and cannot promise identical output across machines.

Promote cheap analysis and eventually `auto` only after corpus and browser measurements establish acceptable overhead and quality. Keep deeper analysis opt-in until its acceptance gates pass.

---

## 13. P0 foundation: separate proof, safe derivation, and heuristic advice

### 13.1 Why this becomes mandatory

The stronger the planner becomes, the more dangerous an incorrect assumption becomes.

If the solver merely ranks a move badly, the search can recover.

If the solver declares that move illegal, an unsound inference can make a solvable puzzle appear unsolvable.

### 13.2 Three reasoning classes

Use these everywhere:

#### `proven`

A fact follows from a sound complete check or a formally safe relaxation.

Allowed use:

- hard prune;
- hard dependency;
- exact proof support.

#### `derived-safe`

A fact follows from a sound inference rule whose inputs hold in the same declared scope. Tests support the soundness argument; passing tests alone does not establish it. This class distinguishes derivation method from direct proof, not weaker permission to prune.

Allowed use:

- hard prune only with a soundness argument, validated input scope, and differential coverage;
- hard task dependency.

#### `heuristic`

A fact is a prediction or strategic preference.

Allowed use:

- ranking;
- hypothesis selection;
- beam prioritization;
- budget allocation.

Never use alone for completeness-destroying pruning.

A contradiction under hypothesis assumptions invalidates that hypothesis, not the puzzle. Snapshot facts must be revalidated after affected state changes. Exact proof lanes must independently validate any evidence they consume.

### 13.3 Every fact needs provenance

Example:

```json
{
  "id": "order:exportB4-before-goalG9",
  "kind": "ordering",
  "strength": "derived-safe",
  "rule": "doorway-resource-consumption",
  "derivedFrom": [
    "requires:exportB4:doorD",
    "consumes:goalG9:doorD"
  ]
}
```

This makes debugging dramatically easier.

When the solver makes a strange decision, you can answer:

> “Why did Sokomind refuse to fill this goal?”

with an actual causal explanation.

---

# Part IV — improve the current strategic planner itself

## 14. Expand the task ontology beyond `release`, `export`, and `deliver`

The latest planner’s task set is deliberately small. That is a good experimental foundation but too narrow for the final vision.

Recommended task kinds and semantics:

### `release`

Current behavior. Move a prerequisite box into a release region so another goal commitment remains possible.

Keep it.

### `export`

Current behavior. Move a box out of a room through its gate.

Keep it.

### `import`

Explicitly represent mandatory or planned imports. This matters for rooms whose packing cannot begin until required boxes arrive.

### `stage`

Move a box to a temporary safe region/cell while preserving future tasks.

The task should include an expiry condition:

```text
stage B in region R until task T completes
```

### `clear-doorway`

Make doorway/resource D traversable without necessarily deciding the blocker’s final destination.

This is more flexible than automatically turning the blocker into a participant of another task.

### `preserve-support`

Usually represented as an invariant rather than an executable action, but it can generate clearing tasks when the support cell is occupied.

### `transport`

Move a box from one strategic region to another without committing it to a final goal.

This is important because humans often reason:

> “Get this box through the corridor first; decide the exact goal later.”

### `commit-goal`

Separate “move toward this goal” from **final irreversible occupation**.

This distinction is crucial for access ordering.

### `solve-room`

Execute an exact/verified room macro when available.

### `solve-corral`

Execute an exact/verified corral macro when available.

---

## 15. Separate planning from candidate realization

Currently `buildStrategicPlan(...)` intertwines two jobs:

1. deciding which strategic tasks are worth doing;
2. simulating concrete move paths that realize those tasks.

Split these conceptually:

```text
Strategic inference
      |
      v
Declarative plan graph
      |
      v
Task realization search
      |
      v
Verified candidate macro/path
```

This gives several advantages:

- the plan survives when one realization path fails;
- alternate realizations can be tried without rebuilding the entire plan;
- failed realization produces information about blockers/resources;
- task dependencies can remain stable while detailed paths change;
- re-planning can operate on tasks rather than raw move traces.

A failed path should normally mean:

> “this realization failed”

not:

> “this strategic task was wrong.”

The current source comment already recognizes this principle: a failed bounded strategic task is inconclusive. Preserve that philosophy in the architecture.

---

## 16. Improve strategic scoring: feasibility first, cost second

Current strategic candidate scoring combines roughly:

```text
path length
+ estimated remaining pushes
+ weighted doorway schedule penalty
+ weighted goal access penalty
```

This is useful guidance, but fixed linear weights can blur fundamentally different concerns.

First reject only independently sound board-level impossibilities. A violated
hypothesis triggers repair or another hypothesis; uncertain resource risk is
advice, not a hard feasibility class.

Among admissible candidates, prioritize actual moves plus estimated remaining
moves, including keeper travel. Use resource risk and task progress as bounded
heuristic preferences, with diversity slots for competing strategies. Do not
rank raw task counts or push lower bounds lexicographically ahead of move cost:
task counts depend on decomposition, and fewer pushes can require more walking.
Any combined score must be labelled heuristic unless its bounds are justified.

Because the user-visible solver objective is moves, also keep units clear:

- push lower bounds;
- keeper-walk lower bounds;
- actual moves;

should not be mixed as though they were all the same quantity unless the score is explicitly heuristic.

---

## 17. Preserve and exploit canonical symmetry carefully

`buildStrategicPlan(...)` canonicalizes board orientation. Keep this; it is valuable.

Extend symmetry testing to strategic output:

```text
analyze puzzle P
analyze mirrored P'
transform plan(P') back
compare strategic facts modulo symmetry
```

Expected invariants:

- same number of proven assignment edges;
- corresponding ordering relations;
- corresponding room/resource facts;
- equivalent plan hypothesis quality;
- no orientation-specific arbitrary decisions unless intentionally tie-broken.

This is a powerful way to catch hidden directional biases.

---

## 18. Short-circuit a fully solved strategic candidate

If bounded strategic analysis already produces a candidate marked solved, consider immediately converting/replaying that candidate through the core verifier before launching a structural search lane.

Current architecture can effectively rediscover/consume it through strategic seeds, so this is not a correctness bug. It is simply unnecessary indirection when the analyzer already found a complete route.

Flow:

```text
strategicPlan.status === solved
    |
    v
select solved candidate(s)
    |
    v
convert legacy directions
    |
    v
core replay verification
    |
    +-- valid --> incumbent/return/improve
    |
    +-- invalid --> reject + diagnostic
```

This also creates a useful telemetry category:

```text
solutionSource = "strategic-analysis"
```

---

# Part V — testing and measurement

## 19. Measure intelligence, not only runtime

If the goal is a smarter solver, elapsed time alone is not enough.

A solver can become faster because a beam width changed without becoming better at reasoning.

Add strategic telemetry.

### 19.1 Analysis telemetry

```text
analysisTier
analysisElapsedMs
analysisWorkUnits
fixedPointReached
factsDerived
provenFacts
derivedSafeFacts
heuristicFacts

initialAssignmentEdges
finalAssignmentEdges
forcedAssignments
forcedGoalSets
matchingChecks

orderingEdges
resourceDependencies
stagingCandidates
safeStagingCandidates
rejectedStagingCandidates

roomsAnalyzed
corralsAnalyzed
localExactSubproblems
localMacrosProduced

planHypotheses
planTasks
planDAGEdges
```

### 19.2 Search telemetry

```text
planAdvancingExpansions
planNeutralExpansions
planRecoveryExpansions
hardPlanPrunes
resourceViolationPrunes
hypothesesAbandoned
replans
planRepairs
strategicEvents

strategicSeedsGenerated
strategicSeedsAccepted
strategicSeedSolutionHits

phaseExpandedStates[task/phase]
phaseGeneratedStates[task/phase]
```

### 19.3 Analysis ROI

For benchmark runs compare:

```text
strategic reasoning OFF
strategic reasoning ON
```

Measure:

```text
analysis cost
search states saved
wall time saved/lost
memory impact
solution quality
fallback expansions
```

A useful derived metric:

```text
search_expansions_saved / analysis_work_unit
```

Not because it is a perfect objective, but because it exposes analysis that is expensive and unproductive.

---

## 20. Build a mechanism-focused strategic benchmark corpus

Do not evaluate only on aggregate puzzle difficulty.

Create fixture groups where each group isolates a reasoning mechanism.

Recommended categories:

1. **forced box-goal assignment**
2. **ambiguous same-label assignment**
3. **deep goal before shallow goal**
4. **goal temporarily must remain empty**
5. **doorway export before room packing**
6. **mixed export/import room**
7. **temporary staging required**
8. **staging square that looks safe but kills keeper support**
9. **box must move away from all goals to unblock another**
10. **corridor must remain open**
11. **corral solvable as local subproblem**
12. **room exact macro**
13. **plan hypothesis A succeeds / B fails**
14. **same-label box role swap**
15. **replan after a strategic phase**
16. **cyclic-looking dependency resolved by staging**
17. **false heuristic ordering that must not become a hard prune**
18. **symmetry/mirror equivalent puzzle**
19. **small board with high strategic complexity**
20. **large board with low strategic complexity**

The last two specifically test whether analysis depth is based on reasoning pressure rather than size alone.

---

## 21. Hard-pruning soundness tests

Any new hard strategic rule should pass differential tests against exact search on small puzzles.

Test pattern:

```text
for many small solvable and unsolvable states:
    result A = exhaustive/exact solver with strategic hard prune disabled
    result B = same exact solver with strategic hard prune enabled

require:
    solvability(A) == solvability(B)
```

For a rule that rejects a state, keep a test corpus of rejected states and confirm no solution exists from them with an independent exact solver within the fully enumerable small-board domain.

This is one of the best ways to confidently turn strategic ideas into hard pruning.

---

## 22. Metamorphic tests

Strategic reasoning should obey transformations that preserve the puzzle.

Test:

- horizontal mirror;
- vertical mirror;
- rotation;
- equivalent same-label box permutation;
- equivalent goal ordering in source representation.

Compare facts and plans after mapping coordinates back.

This will catch accidental dependence on:

- iteration order;
- box array order;
- map insertion order;
- direction enumeration;
- arbitrary matching selection.

---

## 23. Plan-repair tests

Create direct unit scenarios:

```text
root plan has tasks T1,T2,T3
state after T1 is supplied
repair must preserve T1 and not recompute unrelated facts
```

And:

```text
hypothesis H1 assumption fails
repair abandons H1
H2 remains viable
```

And:

```text
same-label box roles swap
logical task remains valid by rebinding box candidates
```

---

# Part VI — concrete module-level implementation plan

## 24. Recommended file/module changes

This does **not** require a large rewrite of the existing solver engine.

### 24.1 TypeScript boundary

Add:

```text
src/solver/implementations/
  sokomind-strategic-contract.ts
  sokomind-strategic-validation.ts   (optional separate file)
```

Responsibilities:

- wire types;
- schema validation;
- conversion from engine analysis;
- compact plan execution types;
- telemetry types.

Update:

```text
sokomind-legacy.ts
```

Replace opaque strategic record typing with the validated plan contract.

### 24.2 Engine analysis layer

Current:

```text
sokomind-engine/source/analysis.js
sokomind-engine/source/strategic-planning.js
sokomind-engine/source/topology.js
```

Suggested gradual split:

```text
strategic-facts.js
strategic-inference.js
strategic-resources.js
strategic-planning.js
strategic-realization.js
strategic-repair.js        # later
```

Do not split everything on day one. A good first extraction is:

```text
strategic-inference.js
```

for the fixed-point fact engine while leaving bounded task realization in `strategic-planning.js`.

Because the legacy engine build concatenates modules in dependency order, any new bare-global JS source file must also be inserted into the source list in:

```text
scripts/prepare-sokomind-engine.mjs
```

and the generated-engine freshness check must continue to pass.

### 24.3 Search integration

Update:

```text
sokomind-engine/source/solver-search.js
```

Add centralized plan transition assessment rather than scattering task-weight logic throughout push generation.

Long-term target functions:

```text
planExecutionState(...)
enabledStrategicTasks(...)
assessStrategicTransition(...)
strategicMacroCandidates(...)
strategicEventAfterTransition(...)
```

### 24.4 Orchestration

Update:

```text
src/solver/implementations/sokomind-plans.ts
src/solver/implementations/sokomind-solver.ts
src/solver/implementations/sokomind-options.ts
```

Goals:

- always run cheap analysis;
- deep analysis selected by reasoning pressure;
- propagate full plan/hypothesis context into flagship forward lanes;
- add repair phases at strategic checkpoints;
- expose telemetry;
- keep proof lanes independent.

---

# Part VII — staged roadmap with acceptance criteria

## 25. Stage 0 — establish a baseline before changing behavior

### Implement

Add strategic counters for the current planner:

- tasks attempted;
- candidates produced;
- candidate task lengths;
- seeds accepted;
- solved strategic candidates;
- analysis elapsed/expanded/generated;
- plan-macro-beam expansions;
- ordinary discovery expansions after the structural lane.

### Why

Without a baseline, later gains will be hard to attribute.

### Acceptance

Benchmark reports can answer:

> How often does the current strategic plan help, and how much search still occurs after it?

---

## 26. Stage 1 — integrated persistent-plan execution

**Sprint implementation status — 2026-09-07:** A V2 advisory task contract now
reaches structural search and replay-verified checkpoint continuation. It includes
bounded validation, hypothesis-scoped evidence, reversible board-derived progress,
witnessed staging tasks, consumer-scoped resource intervals, bounded ordering
preferences, recovery candidates, and telemetry. The adapter uses a generated
lightweight validator; checkpoint replay and rebinding run inside the worker.

This is an experimental integration, not acceptance of the quality gate. Enable
`strategicAnalysisMs` and `strategicPlanExecution: true` to exercise it. Execution
defaults to false because matched experiments improve the maze fixture but regress
Grand Hall. The initial predicate subset is box-at-cells/cells-clear, and one
root assignment hypothesis is represented. Cross-domain fixed-point inference,
proved clearance feasibility, role-domain alternatives, task-directed macros,
and incremental causal repair remain subsequent work. The current scoring
retains calibrated structural guidance with bounded task/walking adjustments;
it is not the final remaining-move estimator described in section 16.

See [sprint measurements](solver-benchmarks.md#persistent-strategic-execution-sprint-1)
for results and reproduction commands.


Implement the typed contract, exhaustive predicates, scoped provenance, minimal
hypothesis representation, and temporal resource semantics together. Convert
current tasks and retain replay-verified realizations. Recompute completion from
the board; reversible accomplishments must not remain permanently complete.

Connect enabled tasks and move-aware ordering to structural search and checkpoint
continuation, preserving independent recovery. Schema-only conversion is an
internal milestone, not the delivery boundary.

Acceptance: exercise doorway release → temporary staging → goal commitment end
to end, verify worker serialization and replay, and benchmark behavior against a
fresh baseline. Plan-progress counters explain behavior but do not prove quality.

---

## 27. Stage 2 — connected inference and temporal staging

Add bounded agenda-based propagation between existing matching support, final-push
access, doorway crossings, room flow, and staging clearance obligations. Reuse
matching support rather than rebuilding it. Keep conditional conclusions scoped
to their hypothesis and invalidate affected facts when their inputs change.

Acceptance: mechanism fixtures cover crossing-before-commit without unnecessary
finish-before-commit edges, reusable support squares, and reversible task progress.
Measure analysis cost, total moves, walking, and downstream search effort. Do not
introduce new hard pruning in this stage.

---

## 28. Stage 3 — competing strategies and incremental repair

Maintain a bounded set of hypotheses with explicit assumptions; detect strategic
events, invalidate dependent evidence, rebind interchangeable roles, and repair
only affected tasks. Extend plan-aware execution through applicable forward lanes
while keeping an independent recovery lane and independent exact proof lanes.

Acceptance: a bad strategy can be abandoned without declaring the puzzle
unsolvable; equivalent states do not gain unnecessary narrative search identity.
Repair work shares a bounded budget and is included in reported timing.

---

## 29. Stage 4 — reusable local execution contracts

Add room/corral contracts with explicit boundary assumptions and verified paths.
Cache by the complete relevant interface, including keeper entry position or an
explicitly priced connector. Keep macro validity separate from claims of local
optimality or completeness.

Acceptance: cached and uncached execution replay identically; alternate entry
positions and external connectivity changes cannot reuse invalid costs or proofs.
Demonstrate reduced work without sacrificing solution quality.

---

## 30. Stage 5 — justified hard strategic constraints

Only after inference, resource semantics, and repair are validated, consider new
hard pruning. Each rule needs a soundness argument, explicit assumption scope,
small-board exhaustive differential checks, and metamorphic coverage. A failed
macro precondition rejects that macro, not all successors. A hypothesis conflict
rejects that hypothesis, not the board.

Acceptance: no solvability loss in exhaustive fixtures; every promoted rule has
an independent rationale. Test coverage alone is not a proof of soundness.

---

## 31. Stage 6 — measured default promotion

Promote the cheap pass across puzzle sizes only after overhead and quality gates
pass. Use deterministic work budgets and reasoning pressure to select deeper
analysis; preserve explicit off/experimental controls during rollout.

Acceptance: browser and mechanism-corpus measurements show acceptable analysis
latency, no material quality regressions, and reproducible work-budget behavior.

## 32. Delivery and performance gates

Every stage includes runtime integration, regression coverage, and comparative
benchmarks. Target a replay-valid Grand Hall solution of at most 650 moves within
three seconds of search after analysis. Report analysis, search, refinement, and
total elapsed time separately; any refinement needed to meet 650 counts within
the search allowance. The 626-move reference is an upper bound, not a runtime
route or a proof of optimality. Browser timings establish the product target;
Node measurements support iteration but cannot substitute for them.

## 33. Cross-stage telemetry

Track moves, pushes, walking, solved rate, analysis/repair work, downstream search
work, and latency distributions. Domain reductions and task progress explain
results; they are not standalone acceptance criteria.

## 34. Cross-stage mechanism corpus

Cover temporary occupation, delayed commitment, alternative crossings, role
symmetry, reversible progress, hypothesis failure, and cache-boundary changes.
Run replay and transformed-board checks alongside the established puzzle corpus.

## 35. Review boundaries

Keep internal patches reviewable while delivering integrated stages. Do not stop
a quality upgrade at types, advisory JSON, or counters that search does not use.

---

# Part VIII — design details that will prevent future problems

## 36. Do not make every plan fact part of the search identity

This can cause state explosion.

Use physical board state as the fundamental identity and add strategic execution state only when it changes future admissibility.

Prefer:

```text
recompute completed tasks from board
```

instead of:

```text
store narrative history in every state
```

---

## 37. Do not overcommit same-label boxes

A planned role should often be:

```text
one blue box from candidate set {0,3}
```

not:

```text
box index 0
```

until topology or matching proves the identity.

---

## 38. Do not overcommit goals either

If a box can still validly serve multiple same-label goals, maintain the domain.

Commit only when:

- forced by matching;
- forced by geometry/resources;
- deliberately selected inside one explicit hypothesis.

---

## 39. Do not simply increase strategic-analysis milliseconds

More wall-clock time alone will eventually turn the analyzer into another search engine.

The goal is better deduction per unit work, not merely more preprocessing.

Use:

- fixed-point rules;
- selective exact local analysis;
- information-gain stopping;
- reasoning-pressure triggers.

---

## 40. Do not replan every node

Replan on strategic events and plateaus.

Search should remain fast in the inner loop.

---

## 41. Do not let heuristic plans contaminate exact proof

The exact proof lane must be able to find a solution that contradicts a heuristic plan.

Only sound proven constraints may be shared as hard restrictions.

---

## 42. Do not throw away the existing search portfolio

The current portfolio, structural search, bidirectional lanes, rewrite lane, and proof machinery are valuable.

The target architecture is:

```text
better brain above the search engines
+ better plan state inside the flagship lanes
```

not:

```text
replace everything with a new planner
```

---

## 43. Do not adopt machine learning yet

There is substantial untapped value in symbolic Sokoban reasoning already available from the board.

ML could eventually help with:

- hypothesis ordering;
- beam ranking;
- analysis-budget allocation;
- macro selection.

But it should come **after** the solver has a clean representation of facts, tasks, resources, and plan outcomes. Otherwise a learned model will be compensating for missing architecture and will be harder to debug.

---

# Part IX — suggested pseudocode for the target solver

## 44. Root solve orchestration

```text
function solve(request):
    board = prepareBoard(request)

    # Always-on deterministic reasoning.
    facts = cheapStrategicAnalysis(board, request.snapshot)

    pressure = reasoningPressure(facts, board)

    if pressure warrants deeper analysis:
        facts = fixedPointInference(facts, configuredBudget)

    if critical local subproblems exist:
        macros = exactLocalAnalysis(facts)
        facts += macroFacts(macros)

    hypotheses = buildPlanHypotheses(facts)

    for hypothesis in prioritized(hypotheses):
        plan = buildPlanDAG(facts, hypothesis)
        launch plan-guided lane

    keep one bounded recovery/diversity lane when useful

    while workers active:
        receive candidates/checkpoints/events

        verify any complete solution independently

        if strategic event at a high-value checkpoint:
            repairedPlan = repairPlan(...)
            optionally launch continuation under repaired plan

    if incumbent exists:
        improve/rewrite as current architecture does
        optionally prove optimality as current architecture does

    else:
        exact/compatibility fallback under remaining global limits
```

---

## 45. Plan-guided successor generation

```text
function strategicSuccessors(state, plan):
    execution = evaluatePlanState(state, plan)
    enabled = execution.enabledTasks

    candidates = []

    for task in enabled:
        candidates += macrosThatAdvance(task, state)

    candidates += blockerClearingMacrosFor(enabled)
    candidates += safeStagingMacrosFor(enabled)

    for candidate in candidates:
        assessment = assessPlanTransition(state, candidate.state, plan)

        if assessment.soundBoardImpossibility:
            prune
        else:
            candidate.score = moveAwareHeuristic(
                candidate.movesSoFar + candidate.remainingMoveEstimate,
                boundedPreference(assessment.resourceRisk, assessment.taskProgress),
            )
            retainDiverseHypothesesAndRecovery(candidate)

    # Independent recovery retains budget even when task candidates exist.
    scheduleIndependentRecovery(state)
    if candidates empty or plateau exceeded:
        return boundedRecoverySuccessors(state, plan)

    return candidates
```

---

## 46. Strategic event detection

```text
function detectStrategicEvents(before, after, plan):
    events = []

    if task completion changed:
        events += TASK_COMPLETED

    if goal domain changed materially:
        events += DOMAIN_CHANGED

    if doorway/resource availability changed:
        events += RESOURCE_CHANGED

    if room balance changed:
        events += ROOM_INTERFACE_CHANGED

    if a plan assumption became false:
        events += ASSUMPTION_INVALIDATED

    if no enabled task has a realization:
        events += PLAN_STALLED

    return events
```

---

## 47. Plan repair

```text
function repairPlan(previousPlan, currentState, events):
    preserve facts whose dependencies are unchanged
    preserve tasks already completed and still valid

    invalidate facts downstream of changed resources/assumptions
    rerun affected inference rules to fixed point

    if current hypothesis contradicted:
        try next existing hypothesis

    if no existing hypothesis remains:
        construct new hypotheses from current facts

    rebuild only affected plan DAG region

    return repaired plan
```

---

# Part X — a concrete example of the desired reasoning

## 48. Example

Imagine a puzzle with:

- boxes `A`, `B`, `C` of the same compatible class;
- goals `G1`, `G2`, `G3`;
- a narrow doorway `D`;
- deep goal `G1` whose final support is inside the doorway region;
- box `B` currently blocks a staging area.

### Raw reverse analysis

```text
A -> {G1, G2}
B -> {G2, G3}
C -> {G3}
```

### Matching propagation

```text
C -> G3 forced
B -> G2 forced
A -> G1 forced
```

### Support analysis

```text
Final push A->G1 requires support S.
Keeper reaches S only while doorway D remains open.
Committing A to G1 closes D, and B has no alternate crossing route.
```

### Transport analysis

```text
B must cross D to reach G2.
```

### Ordering inference

```text
cross(B, D) before commit(A, G1)
```

### Obstruction analysis

```text
B cannot cross D because C temporarily occupies corridor C1.
C is already assigned G3, but sending C directly to G3 would block keeper route K.
```

### Staging inference

```text
C may stage at P2 safely until B crosses D.
P1 needs a clearance obligation before G1 uses its support.
Reject P1 only if clearance is proven impossible; otherwise compare its move cost.
```

### Plan DAG

```text
T1: stage C at P2
T2: transport B through D        depends on T1
T3: commit B to G2               depends on T2
T4: commit C to G3               depends on T2
T5: commit A to G1               depends on T2

Invariant:
D must remain open until T2 completes.
S must be keeper-accessible when T5 uses it; temporary occupation needs clearance.
T3/T4 need not precede T5 without additional access evidence.
```

### Search behavior

Instead of considering every legal push at the root:

```text
search task T1 realizations
```

After T1:

```text
re-evaluate plan
T2 becomes enabled
```

After T2:

```text
doorway resource no longer reserved for B
T3/T4/T5 considered enabled if their own support predicates hold
```

This is the style of reasoning that would make Sokomind feel qualitatively different from ordinary search.

---

# Part XI — priority ranking

## 49. Recommended priority table

| Priority | Change | Why it matters | Expected impact |
|---|---|---|---|
| **P0** | Typed plan, executable predicates, scoped provenance | Makes inference and repair auditable from the first integration | Foundation |
| **P0** | Structural execution and checkpoints, then applicable forward lanes | Retains task meaning with independent recovery | Runtime benefit |
| **P0** | Temporal resources and connected inference | Models crossing, clearance, and commitment precisely | Strategic quality |
| **P0** | Minimal hypotheses, telemetry, and mechanism corpus | Separates assumptions from facts and measures outcomes | Correctness and feedback |
| **P1** | Competing strategies and incremental repair | Recovers from bad assumptions cheaply | Robustness |
| **P1** | Verified room/corral contracts | Reuses bounded local execution | Structured-puzzle efficiency |
| **P2** | New hard pruning after soundness validation | Removes only justified impossibilities | Branch reduction |
| **P2** | Measured cheap/auto default promotion | Expands coverage after overhead and quality gates pass | Product rollout |

---

# Part XII — immediate next implementation slice

## 50. What I would implement first

The first delivery is Stage 1 end to end. The following steps are internal review milestones, not separate chat-sized endpoints. Include scoped provenance, minimal hypotheses, temporal resource intervals, and an independent recovery path from the start.

### Step 1 — create `StrategicPlanV2` types and validator

No search behavior change.

### Step 2 — translate current strategic output

Map current planner concepts into:

- facts;
- tasks;
- candidate realizations;
- plan statistics.

Keep existing candidate paths unchanged.

### Step 3 — add plan completion evaluation

Implement:

```text
evaluateStrategicTaskCompletion(state, task)
```

for the existing task kinds:

- release;
- export;
- deliver/commit.

### Step 4 — instrument structural search

At every retained checkpoint/candidate, report:

```text
completedTaskCount
enabledTaskCount
planAdvancingPushes
planNeutralPushes
```

Still do not hard-prune.

### Step 5 — execute the plan with move-aware ordering

Connect doorway release, temporary staging, and goal commitment to successor generation and checkpoint continuation. Estimate total moves including keeper travel; task progress and uncertain resource risks guide bounded preferences and diversity, not hard exclusion.

Keep fallback successors and an independent recovery lane. Re-evaluate reversible completion against the current board.

### Step 6 — benchmark

Compare current `main` behavior to the plan-aware ordering version.

Measure analysis separately, and compare verified moves, walking, solved rate, and search time across the mechanism corpus and browser Grand Hall runs. Proceed to connected inference only after reporting the integrated result; more completed tasks alone is not a performance win.

This approach yields useful feedback early without requiring the entire final architecture at once.

---

# Part XIII — current-code observations that should guide the work

## 51. Strategic analysis currently does not run universally

The top-level solver only runs `preparationPlan(...)` inside the `structural` branch.

The current size gates are 10 boxes or 100 floor cells.

Therefore “analyze first” is not yet literally true for every Sokomind solve.

Long-term fix: cheap analysis for all puzzles; expensive analysis selected by reasoning pressure.

---

## 52. Strategic analysis is currently disabled by default

`DEFAULT_SOKOMIND_REQUEST_OPTIONS` currently uses:

```text
strategicAnalysisMs = 0
```

This is appropriate while the feature is experimental, but inconsistent with the final flagship identity.

Long-term fix: `auto` analysis level with deterministic cheap reasoning always enabled.

---

## 53. Current strategic tasks are concrete-index-oriented

`strategicTasks(...)` uses `boxIndex` and a concrete assigned target for `deliver` tasks.

This is fine for bounded path simulation, but a hard long-lived planner must handle same-label interchangeability and assignment uncertainty more carefully.

Long-term fix: set-valued box/goal roles + explicit hypothesis commitments.

---

## 54. Current task failure contains useful information that is mostly discarded

`simulateStrategicTask(...)` records obstructions and may widen the participant set.

Long-term fix: convert recurring blockers into explicit causal facts and blocker-clearing/staging tasks.

---

## 55. Current candidate diversity is based strongly on early task identity

`buildStrategicPlan(...)` retains diversity among first tasks/task kinds.

Long-term fix: preserve diversity among full strategic hypotheses and causal schedules, not only path starts.

---

## 56. Current scoring is advisory and weight-based

Candidate score combines path cost, estimated remaining pushes, doorway schedule penalty, and goal-access penalty.

Long-term fix: reject sound board-level impossibilities, repair hypothesis conflicts, and rank admissible candidates by move-aware estimates with bounded strategic preferences and diversity. Uncertain resource risk must not dominate move cost lexicographically.

---

## 57. The analyzer already exposes the right raw facts for the next step

The major opportunity is not “add dozens more heuristics.”

It is to connect existing facts through:

- typed semantics;
- propagation;
- temporal resources;
- task dependencies;
- plan execution state;
- repair.

This is encouraging because it means the project does **not** need a conceptual restart.

---

# Part XIV — audit anchors

## 58. Files reviewed most directly for this roadmap

The roadmap is grounded primarily in the following current source modules:

```text
src/solver/implementations/sokomind-solver.ts
src/solver/implementations/sokomind-options.ts
src/solver/implementations/sokomind-plans.ts
src/solver/implementations/sokomind-legacy.ts

src/solver/implementations/sokomind-engine/source/analysis.js
src/solver/implementations/sokomind-engine/source/strategic-planning.js
src/solver/implementations/sokomind-engine/source/topology.js
src/solver/implementations/sokomind-engine/source/solver-search.js
src/solver/implementations/sokomind-engine/source/push-generation.js
src/solver/implementations/sokomind-engine/source/heuristic.js
src/solver/implementations/sokomind-engine/source/deadlock.js

scripts/prepare-sokomind-engine.mjs
```

At the time of this audit, notable current blob SHAs included:

```text
sokomind-solver.ts       c06af9225e86a2fade232e37b664d5fe9afe57d6
sokomind-options.ts      2e7f09b575ab1d03bf6332ab551e4ec937af618a
sokomind-legacy.ts       8b0d4c42e5f4d2695fb394fa477d747654b85014
analysis.js              24e3e4220499318bfd30b047e4e6b6cb049d64d4
strategic-planning.js    f738192edeed7422ffe4f5e74e01fc3fb6ca0c7e
solver-search.js         d41bb4b3ad1771a728138fb0af8844a2248c1338
```

These hashes are included only to make clear which code snapshot informed the recommendations. Commit history itself was not analyzed.

---

# 59. Final recommendation

The flagship solver is already sophisticated enough that the next major improvement should **not** be another isolated heuristic or another search lane.

The next leap is architectural:

> Turn all of the solver's existing structural knowledge into a persistent causal model of the puzzle.

The best sequence is:

```text
1. Strong typed strategic-plan contract
2. Persistent plan progress in every flagship forward lane
3. Fixed-point constraint propagation
4. Temporal doorway/support/staging resources
5. Incremental plan repair
6. Exact local room/corral macros
7. Explicit competing plan hypotheses
8. Always-on tiered strategic analysis
9. Strategic telemetry and soundness corpus
```

If those pieces are implemented carefully, Sokomind will stop being best described as:

> a sophisticated Sokoban search portfolio with strategic preprocessing

and start being accurately described as:

> **a hierarchical Sokoban reasoning system that analyzes the puzzle, derives constraints, forms and tests a plan, repairs that plan as the state changes, and uses search as the executor of strategic intent.**

That is the architecture closest to the human process described at the beginning: **look first, understand what has to happen, then search inside that understanding.**
