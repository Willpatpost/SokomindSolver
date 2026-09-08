# Fast strategic analyzer implementation plan

This plan supersedes the sequencing and priorities in
[the earlier solver roadmap](solver-quality-roadmap.md).

The corrected [strategic architecture roadmap](SOKOMIND_SOLVER_STRATEGIC_ROADMAP.md)
now governs architecture and implementation sequencing. This document retains the
product timing contract and implementation history; where sequencing differs,
follow the strategic roadmap.

## Governing priority — September 7, 2026

Follow the evidence-driven stages in the strategic roadmap. Route-gap diagnosis
and decision experiments have now justified long-range rescheduling, which is
integrated into the quality pipeline with shared budgets and replay checks.
Next comes applying that costed model to analyzer-generated partial schedules. Sprints 2–3 are
implemented experiments that failed quality acceptance;
keep them for controlled comparisons. Architectural sections below are candidate
capabilities, not an automatic implementation queue.

Prioritize verified route improvement with generous, explicitly bounded analysis.
Record timing and memory throughout, but defer the three-second search acceptance
gate until quality and generalization are established. No reference-derived route
or puzzle-specific strategy may enter runtime planning.

## Implementation status — September 7, 2026

**September 8 update:** The new `solution-box-reschedule` engine command repairs
production's 789-move Grand Hall route to **647 moves / 242 pushes** without using
the human reference. An independent small-board oracle and Chromium/WebKit worker
tests pass. [Measured results](benchmarks/grand-hall-rescheduling.md) explain the
method and limits. This is a post-solution repair, not yet pre-search planning;
the public quality/optimal adapter now invokes it automatically with unused shared
budgets. Board-only adapter tests reach 647 moves on all three Grand Hall
orientations; public Chromium/WebKit worker tests reproduce 647/242. A smaller
50,000-state quality budget reaches 709 moves. Seven other catalog puzzles pass
integration replay checks. The next work is adapting its long-horizon cost model
to partial analyzer schedules, while keeping the proven complete-route repair as
a quality baseline. Fast mode and the pre-search analyzer remain unchanged.

The earlier evidence-driven Stage 0 diagnosis is available in
[Grand Hall diagnosis](benchmarks/grand-hall-diagnosis.md), with replayable traces
and eight same-state H decision trials. No trial proves a quality gain. The next
work at that checkpoint was continuation-evaluator calibration, then
full staging/transit episode comparisons. This superseded the suggestion to
implement another planning mechanism immediately. The diagnostic replay yielded
a 624-move version of the human witness without changing its pushes; runtime
planning does not consume that route and optimality remains unproven.

The first executable path is implemented behind the opt-in
`strategicAnalysisMs` request option: task generation, costed full-board
simulation, obstruction-directed group expansion, diverse candidate prefixes,
canonical serialization, and replay-checked consumption by structural search.
Bounded per-request distance caching, state-budget accounting, and a separate
kernel search deadline are included. The default remains off because benchmark
results are mixed.

The original prefix planner now also emits a typed V2 advisory task package.
Experimental persistent execution is available separately through
`strategicPlanExecution: true` (default false), including board-derived progress,
witnessed staging, temporal resource advice, and replay-verified continuation.
The quality gate has not passed: Grand Hall regresses when execution is enabled.
See [sprint measurements](solver-benchmarks.md#persistent-strategic-execution-sprint-1).
This is not yet the full strategic architecture below. Proven clearance and
space-reservation feasibility, incremental schedule repair, broader goal assignment
alternatives, and deadline-aware global rewriting remain work.
Initial rewritten Grand Hall quality improved from 789 to 780 moves in Node
experiments, but the search-time target was not reached. Reproducible commands
and limitations are recorded in [solver benchmarks](solver-benchmarks.md#executable-strategic-planning-experiments).

## 1. Product objective

Build an analyzer that quickly develops a coherent strategy, checks the
interactions that could invalidate it, and hands search a small set of useful
plans. Search should execute verified work and resolve remaining choices rather
than rediscover the strategy from individual pushes.

The Grand Hall target is a replay-valid solution of at most 650 moves within
3 seconds of SEARCH, after analysis. Analysis must also be fast, but has a
separate measured budget. The 626-move human solution is a verified upper bound,
not an optimality proof or a runtime route source.

The reviewed discovery result is 893 moves / 278 pushes; the reviewed rewrite
result is 789 moves / 270 pushes. Reconfirm these against the current build and
capture fresh browser timings. Earlier Node timings and the user's browser
measurement are not interchangeable baselines.

Success requires improved solution quality and reduced downstream search work
across multiple puzzles. More analysis output, a lower heuristic score, or a
better result obtained only by increasing total search effort is insufficient.

## 2. Timing and acceptance contract

Measure these intervals separately:

1. Startup and board transfer.
2. Static analysis and strategic planning, including their local searches.
3. Plan serialization, transfer, and hydration.
4. Downstream search, including repair and search-based rewriting.
5. Final verification and presentation.
6. Total elapsed time from the solve request.

The three-second search clock starts at downstream search execution. It is
elapsed wall time across all search workers, not the sum of worker CPU time.
Any strategic repair performed after this handoff is charged to that same
clock. Reentering analysis cannot reset it. Report a solution constructed
entirely during analysis with its actual analysis cost.

For later latency acceptance, compare analysis budgets of 100, 250, 500, and 1,000 ms. Use 250 ms
as an experimental starting configuration, not a promised final default. If
static preparation alone exceeds a budget, report the overrun rather than
silently excluding it. Longer diagnostic runs may identify missing capability,
but do not establish that the analyzer is fast enough for production.

Record the best verified result at 0.5, 1, 2, and 3 seconds of search. Compare
plans under identical downstream expansion limits as well as equal time to
separate better guidance from faster implementation. Final browser evidence
must include at least ten repetitions per tested cold/warm configuration,
failures, distributions, environment identity, and analysis cost.

## 3. Architecture: propose, simulate, repair

The analyzer follows a bounded loop:

1. Read the board and compile reusable geometry.
2. Derive tasks, prerequisites, and contested spaces.
3. Propose a small, diverse set of partial schedules.
4. Simulate the next consequential tasks in each schedule.
5. Locate the earliest important conflict or expensive decision.
6. Repair that decision and affected successors.
7. Hand off the best available plan set when the budget expires or useful
   progress stops.

Keep an initial usable plan available early. A partial plan with a verified
prefix and explicit unresolved work is preferable to a supposedly complete
schedule whose transitions have not been checked. Preserve the ordinary solver
as a fallback while the analyzer is being developed.

### A. Compiled board model

Reuse existing topology, dense board data, goal domains, room flow, and transit
prerequisites. Compile route and support relationships once per board:

- Rooms, doorways, corridors, push support squares, and keeper access regions.
- Compatible goal domains and relaxed transport costs.
- Cells needed for transit versus cells suitable for temporary occupation.
- Potential interactions: shared routes, blocked support, contested staging,
  and final placement that closes another box's route.

Do not use a graph of box paths alone: keeper support and connectivity can make
an apparently open route unusable. Keep relaxed reachability distinct from
verified accessibility in the current full state.

### B. Dynamic task and dependency model

Represent export, import, clearance, escape, staging, delivery, and final
placement as tasks. Each task specifies:

- Stable box identities and compatible destinations.
- Preconditions on boxes, keeper access, and available space.
- Desired effects and the state predicate that establishes completion.
- Required transit/support space while it is executed.
- Space occupied afterward, and the condition that releases that occupation.
- Estimated costs and references to any verified implementations.

Separate necessary conditions, relaxed deductions, and scheduling preferences.
A dependency such as G leaving a region is not equivalent to G reaching its
goal. Occupying a goal temporarily is not equivalent to permanently locking it.

Use partial orders where tasks are independent. Cyclic dependencies trigger a
search for staging or clearance alternatives; they are not automatically
deadlocks. Update only affected predicates after each simulated transition.

### C. Candidate schedule construction

Build schedules around transport batches, access preservation, and keeper
travel. Evaluate the cost of transitions between tasks as well as tasks in
isolation. Compare alternatives for:

- Which interacting task or export batch goes first.
- Where a box waits, and how it will subsequently leave.
- When a goal can be finalized without obstructing remaining work.
- Which compatible assignment avoids unnecessary transport.
- Whether nearby work can be grouped without closing essential access.

Start with a small schedule beam, experimentally 8–16 candidates. Reserve
diversity by task order, staging choice, and resulting access rather than
retaining only minor variations of one strategy. These limits are tuning
starting points, not architectural constants.

Rank by actual moves in verified prefixes plus separately identified estimates
of remaining work. Track pushes and walking individually. Add penalties for
unresolved conflicts only as guidance; do not mistake a guessed penalty for an
exact move cost or an admissible proof bound. Avoid counting the same remaining
transport in both task estimates and a global assignment estimate.

### D. Targeted interaction simulation

Spend deeper computation where a schedule has a concrete uncertainty. Begin
with the boxes on a dependency edge, usually a pair. Simulate actual pushes and
keeper walking with all other boxes present as fixed obstacles.

If a third box prevents the desired transition, identify that obstruction and
expand the group. Permit further bounded expansion when evidence requires it;
do not enumerate all triples or quadruples across the board. A useful room
interface may be a better subproblem than a larger arbitrary box group.

Return several alternatives when they preserve different keeper arrivals,
access routes, or future staging options. Include temporary displacement and
non-monotonic progress. The human reference demonstrates why reducing relaxed
goal distance at every step is too restrictive.

Each emitted sequence must replay against the complete input state. A sequence
found in a relaxation is a proposal until verified. Failure with other boxes
fixed establishes only that this restricted attempt failed; it is not a global
deadlock certificate.

### E. Incremental repair and effort allocation

Classify simulation outcomes: verified transition, conflicting occupation,
missing keeper access, insufficient staging, unreachable target under current
assumptions, or budget exhaustion. Keep evidence about the affected boxes and
cells so repair targets the actual cause.

Try the cheapest relevant repair first: change an approach, exchange nearby
tasks, select another parking cell, defer final placement, or enlarge the
interaction group. Reuse unaffected prefixes and invalidate dependent suffixes.
Do not restart the complete analysis after every failed task.

Allocate effort using observable signals: repeated schedule conflicts,
disagreement between candidate plans, large predicted keeper travel, or a
blocking interaction that prevents an otherwise promising prefix. Track actual
improvements per planning effort. Stop after a bounded period without useful
progress, retaining the best plan; any predicted value of further computation
is itself heuristic and must be evaluated empirically.

## 4. Analyzer-to-search contract

Introduce a versioned, serializable plan package. Its logical contents are:

| Field | Purpose |
|---|---|
| Board and snapshot identity | Reject stale plans |
| Analysis configuration and timing | Make results reproducible |
| Task graph | State-dependent prerequisites and effects |
| Candidate schedules | Alternative strategies and unresolved branches |
| Verified segments | Paths, full input/output states, moves, and pushes |
| Conditional proposals | Explicit assumptions requiring later validation |
| Estimated remaining cost | Separate exact and relaxed components |
| Completion status | Partial, fully simulated, or solved and verified |
| Resource statistics | Expansions, cache bytes, overruns, and useful repairs |

Search reuses verified segments when their preconditions match. Initially use
exact full-state matching; broaden reuse only with tested equivalence rules.
A matching room layout alone is insufficient. Keeper position matters for move
cost, and stable box identity matters for indexed task references.

When a plan branch fails, try an alternative or bounded local repair. Reserve
some search capacity for the ordinary planner so an incorrect strategic
preference does not eliminate every solution. All post-handoff work shares the
search deadline. Never convert advisory dependencies into exact hard pruning.

Return a verified complete route found by analysis directly; do not manufacture
extra search to make the architecture appear necessary.

## 5. Performance engineering rules

- Reuse typed arrays and compiled distance/access tables where profiling shows
  benefit. Avoid allocating complete paths and board copies for every tentative
  planning branch; materialize retained segments as needed.
- Bound cache bytes as well as entries. Include obstacle layout, keeper state,
  relevant labels, and task assumptions in cache validity. Verify cached paths
  before use when full preconditions are not encoded.
- Separate static board caches from snapshot-dependent planning caches. Editing
  a board, moving a box, or changing goal labels invalidates the appropriate data.
- Bound planning expansions, candidate schedules, group size, and elapsed time.
  Check cancellation inside expensive primitives, not just between phases.
- Run analysis away from the UI thread. Account for serialization and duplicate
  worker memory before introducing parallel analysis. Begin with one strategic
  planner and a controlled search configuration for reproducible experiments.
- Add pair-pattern tables only after measuring a repeated interaction-cost
  bottleneck. Reuse them where compatible, charge construction to analysis,
  and avoid invalid additive proof estimates.
- Do not add persistent learning, additional reverse workers, or a broad tuning
  system before testing the integrated analyzer. Those remain separate options
  if measurements identify a specific need.

## 6. Implementation sequence and deliverables

This sequence mirrors the governing strategic roadmap and supersedes the earlier
mechanism-first milestones.

1. **Diagnose:** replay and trace production discovery, production rewrite, and
   the 626-move witness. Reconcile pushes and walking; annotate repeated crossings,
   temporary placements, and goal undoing without double-counting suspected waste.
2. **Test decisions:** compare legal choices from identical board/keeper states
   using independent continuations, matched downstream limits, and generous
   diagnostic budgets. Report eventual moves and inconclusive failures.
3. **Implement from evidence:** choose the capability that fixes a demonstrated
   costly decision. Connect it to execution and establish an attributable verified
   gain against production and prior experiments.
4. **Establish quality:** repeat with declared generous analysis bounds and track
   progress toward 650 moves. More effort or lower heuristic scores alone do not
   demonstrate better planning. Timing is measured but not yet an acceptance gate.
5. **Generalize:** evaluate held-out puzzles, orientations, and roles; report
   per-puzzle regressions and solved rates before promotion.
6. **Optimize and promote:** profile the successful approach, preserve quality,
   and then validate the three-second search target and acceptable analysis cost
   in cold/warm browser runs.

Each quality milestone requires independently generated, replay-verified route
improvement. Tests and mechanism completion establish correctness, not quality.
The next integrated deliverable is the actual diagnosis and decision experiments,
not merely instrumentation or another proposed architecture.



## 7. Tests and experimental design

Use the existing production discovery/quality corpus, a focused structural
iteration subset, and a held-out subset. Retain the human reference strictly
for replay validation and diagnostic comparison. Include Grand Hall base,
mirror, and rotation without assuming that identical wall time is achievable.

Required targeted cases:

- Escape required before final placement, but not before temporary occupation.
- A compatible alternative goal that removes an apparent dependency.
- Individually valid tasks whose composition blocks keeper access.
- Staging that is reachable but prevents the box from leaving later.
- A dependency cycle resolved through temporary displacement.
- A third box that must be included in a failed pair subproblem.
- Different keeper arrivals with different continuation costs.
- Duplicate-label boxes and changing compatible assignments.
- Stale plans/caches after a board or snapshot change.
- Planning timeout, cancellation, partial results, and normal-search fallback.
- Full-board replay of every retained simulated segment and accepted solution.

Use exact small-board oracles when modifying dominance, equivalence, or pruning.
Keep proof-engine guarantees separate from heuristic planning preferences.

Compare these configurations at matched search budgets:

1. Existing analyzer and existing search.
2. New task metadata with plan execution disabled.
3. Full prepared-plan execution with a fixed narrow search.
4. Full prepared-plan execution with the normal stronger search.
5. Ablations removing interaction simulation, schedule diversity, or repair.

The metadata-only control tests whether plans matter. The narrow-search control
tests whether analysis reduces the need for downstream exploration. Normal
search remains important: the product should benefit from both strong planning
and strong search.

Before promotion, run full units, lint/type checks, generated-artifact checks,
build/static checks, Grand Hall/multi-puzzle regressions, and browser worker,
cancellation, and timeout checks. Make engine changes in source modules and
regenerate the assembled engine. Use the repository browser-test wrapper so the
preview server is started correctly. Preserve historical benchmark artifacts.

## 8. Repository integration map

- `src/solver/implementations/sokomind-engine/source/analysis.js`: analysis
  orchestration and existing transport/transit information. Extract substantial
  task, schedule, and simulation code into dedicated source modules rather than
  adding the complete planner to this file.
- `src/solver/implementations/sokomind-engine/source/topology.js` and
  `board.js` in the same directory: reusable geometry, compiled tables, and
  prepared-board compatibility.
- `src/solver/implementations/sokomind-engine/source/push-generation.js`:
  full-state push simulation and materialized macro paths.
- `src/solver/implementations/sokomind-engine/source/solver-search.js`:
  prepared-plan execution, alternative retention, and budgeted repair.
- `src/solver/implementations/sokomind-solver.ts` and
  `sokomind-plans.ts` in the same directory: phase timing, worker handoff,
  cancellation, and fallback scheduling.
- `scripts/prepare-sokomind-engine.mjs`: register any added engine modules in
  a valid dependency order; regenerate instead of editing generated output.
- Existing benchmark scripts and `tests/unit/`, `tests/performance/`, and browser
  tests: extend current infrastructure instead of creating a separate benchmark
  whose timing omits production overhead.

## 9. Final report

### Sprint 3 experiment: concrete approach repair (2026-09-07)

The analyzer can now retry a failed goal task with bounded matching-supported
owner/final-push alternatives. Simulation checks the actual final-push transition;
a keeper merely reaching the predecessor afterward is insufficient. Failed
constrained choices do not create shared clearance obligations. Remaining beam
slots can retain distinct continuations with the same first task.

This implements local choice repair, **not yet a consistent whole-plan hypothesis
solver**. Choices are realized in replayable prefixes; unresolved owner/approach
choices are not persisted across the whole schedule. The latter remains open.

Internal `scheduleChoices` defaults to zero and is bounded at eight. Reproduce:

```sh
node --experimental-strip-types scripts/benchmark-strategic-analyzer.mjs --ids=expert-maze,huge --budgets=250 --runs=1 --search-ms=0 --schedule-choices=2
```

Raw evidence: `docs/benchmarks/strategic-choice-repair-sprint3.json`. Maze remains
127 moves / 28 pushes. Grand Hall exhausts the search frontier without a solution.
Its analyzer attempts 61 concrete choices, with 60 failures and one successful
endpoint, within 4,000 expansions. These are bounded simulation failures, not
proofs of infeasibility. Eager choice enumeration was also unsuccessful; the
implemented version repairs on demand. Do not enable this configuration in the
public adapter. Production and Sprint 2 defaults retain their existing behavior.

A possible future capability is connecting unresolved obligations across a schedule
and scoping blocker evidence to that hypothesis. Diagnosis must establish its need. Retrying local approach alternatives
alone does not remove the need for that work. Compare against the archived
production and Sprint 1 controls before any promotion.

### Sprint 2 checkpoint (2026-09-07): quality first

Prioritize verified solution quality. Record analysis and search time, but defer
the three-second gate below until planning reliably improves routes. The human
626-move reference remains a witness, not an optimality proof.

Connected inference now reuses perfect-matching support for compatible box
owners, enumerates alternative final-push supports, and derives acyclic goal-order
advice. Failed simulations introduce temporary clearance tasks that expire with
their consumer. Release and staging objectives drive search macros. Joint closure
of all approaches adds an advisory cost; ordinary search remains available.

This is an experimental mechanism checkpoint, **not quality acceptance**. The
public adapter enables connected inference only with `strategicPlanExecution`.
The existing seed-only option and default production solving retain their prior
behavior. Larger internal work limits support investigation without raising the
public analysis budget or selecting a new production profile.

Replay-verified isolated Node results are stored in
`docs/benchmarks/strategic-inference-sprint2.json`:

| Puzzle | Connected seeds only | Connected execution | Production regression |
| --- | ---: | ---: | ---: |
| Expert maze | 231 moves / 26 pushes | 127 / 28 | 155 / 26 |
| Grand Hall | 1102 / 332 | 952 / 322 | 893 / 278 |

Sprint 1 execution produced 107 moves on the maze, so this also regresses that
experimental result. Do not promote this configuration. These kernel runs are
not browser acceptance measurements.

Deferred candidate capability: retain competing approach and owner choices within schedule hypotheses,
score obligations across tasks, and repair the implicated choice after failure.
A chosen approach needs a realizable keeper route and a clearance lifetime.
A union of possible approaches is not a concrete plan. Compare against both
production and Sprint 1; more analysis expansions alone do not establish quality.

Report verified moves and pushes, analysis duration, search-time-to-target,
total latency, failures, and memory observations. Include cold and warm browser
results and the selected analysis budget. Show which expensive decisions were
removed from the route and which features caused the gain.

For final product promotion, the target is met only when solutions at or below 650 moves arrive within
three seconds of search across the declared reference-run acceptance set.
Report the full success fraction; a best run or median alone is insufficient.
Separately judge whether the selected analysis latency is suitable for the
product. Neither unlimited preparation nor an analyzer that returns immediately
but leaves the difficult strategy to search fulfills the intended design.
