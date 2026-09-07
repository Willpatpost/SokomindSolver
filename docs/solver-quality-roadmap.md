# Sokomind solver quality implementation roadmap

The newer [fast strategic analyzer plan](fast-strategic-analyzer-plan.md)
supersedes this document's sequencing and priorities. It focuses on fast
propose/simulate/repair analysis and a separate three-second search budget.

## Outcome and scope

Primary target: produce a replay-valid Grand Hall solution of at most 650 moves
within 3 seconds of search in the browser on the reference machine, AFTER the
analyzer has prepared a substantial strategic plan. Analysis has its own budget;
it is not constrained to fit inside the three-second search window. The user
explicitly prioritizes the analyzer doing the heavy lifting.

Report analysis, worker startup, search, postprocessing/verification, and total
latency separately. Any plan repair or optimization search performed after the
analysis handoff counts toward search time; restarting analysis cannot reset
the search clock. Report any solution already constructed during analysis as
such, together with its full analysis cost.
The user-supplied 626-move solution is a verified upper bound, not an optimality
proof. It is a diagnostic fixture and must never become a runtime route lookup.

Current reviewed results are 893 moves / 278 pushes for discovery and 789 moves
/ 270 pushes after rewriting. The user's 4.3-second browser measurement and
our Node measurements are different environments; establish a fresh controlled
browser baseline before claiming a speed gain.

Secondary goals: improve the quality-versus-time curve on the broader corpus,
preserve replay validity and exact-proof guarantees, and avoid regressions in
solved count, responsiveness, or retained memory. A faster poor route and a
shorter route found after the search deadline do not meet the primary target.
No maximum analysis duration has been specified. Keep it configurable,
cancellable, and visible; measure quality across analysis budgets rather than
assuming either a millisecond allowance or unlimited preparation.

This is one integrated implementation effort. Internal stages provide review
and rollback boundaries, not requests for another chat or approval. An isolated
analysis field, feature flag, or unsuccessful parameter sweep is not a delivered
quality upgrade.

## 1. Establish the measurement contract and diagnose route cost

- Extend the existing benchmark harness to record the best verified incumbent
  at 0.5, 1, 2, 3, 5, and 10 seconds AFTER analysis. Report time to first solution
  separately from time to the requested quality threshold. Independently sweep
  analysis budgets (initial experimental points: 1, 5, 15, and 30 seconds) to
  measure whether deeper preparation improves the downstream result. These are
  experiment settings, not a user-approved default or maximum.
- Record moves, pushes, walking, expanded/generated states, macro construction
  work, analysis time, rewrite gains, worker overhead, and peak retained memory
  where measurable. Do not present estimated memory as measured process memory.
- Capture production-browser baseline runs, separating cold and warm workers,
  with browser version, hardware, worker count, and build identity. Use isolated
  sequential timing runs and at least ten repetitions for final target checks.
  Report success rate and timing distribution, not only the best run or median.
- Use the existing 43-fixture corpus for production discovery/quality checks,
  a smaller structural subset during iteration, and Grand Hall transformations.
  Keep tuning fixtures separate from a held-out evaluation subset.
- Produce push-episode traces: which box moved, keeper approach cost, resulting
  layout, temporary parking, repeated transport, and dependency transitions.
  Compare the solver and human routes without treating different push orders
  as inherently wrong. Account for the excess moves in observable episodes.
- Fix the tuning metric that assigns both current and target routes zero
  quality credit. Preserve solved count first, then evaluate verified moves
  under a fixed search deadline; report analysis effort and memory explicitly.
- Correct the misleading costWeight description: in the guided beam it
  multiplies push cost. Document its distinction from accumulated move weight.

Exit: reproducible before/after artifacts and concrete expensive decisions to
target. This instrumentation work leads directly into implementation below.

## 2. Make the analyzer a strategic planner

The analyzer owns board interpretation, task decomposition, interaction planning,
and comparison of complete candidate schedules. Its output is a small set of
costed, executable or explicitly conditional plans, not just feature scores.
Local search and simulation inside the analyzer are legitimate planning tools;
their work must be reported as analysis effort rather than hidden.

- Represent export, import, clearance, release, parking, and final-placement
  tasks with stable box identities and compatible goal domains.
- Separate prerequisites supported by a relaxation from advisory preferences.
  Preserve the distinction between temporary goal occupation and final locking.
- Express dependencies as state predicates: a box enters a release region, a
  doorway becomes usable, or exports finish. Avoid encoding every dependency
  as one box finishing before another.
- Detect dependency cycles and propose clearance/staging tasks. A cycle is not
  automatically a deadlock; temporary displacement can resolve it.
- Share compiled geometry and route tables across analysis and search. Update
  affected task status after a macro instead of rerunning complete analysis at
  every node. Cache identity must preserve any box-index-dependent semantics.
- Keep initial plans revisable. Search may expose an interaction the relaxed
  analysis did not model; failure must produce an alternative or fallback.
- For each candidate schedule, predict intermediate box layouts and keeper
  access, reserve transport lanes and staging capacity, and model when each
  reservation is released. Account for keeper travel between tasks, not only
  the cost of performing tasks independently.
- Compare alternative export batches, parking choices, assignments, and goal
  completion orders BEFORE the search handoff. Identify the next unresolved
  conflict and spend further analysis effort on that conflict.
- Compile a plan package containing task dependencies, predicted states,
  verified macro segments with preconditions, alternative branches, move-cost
  estimates, and explicit unresolved assumptions. Distinguish exact simulated
  costs from relaxed estimates. Every retained plan must respect the current
  board identity and initial snapshot.
- Validate plans by replaying constructed segments and checking connectivity
  at task boundaries. Validate macro composition, not just each task in
  isolation. Keep fallback branches where complete validation is unavailable.

Exit: analysis hands search a tested strategy with concrete sequences and
localized unresolved choices. Evaluate plan quality by resulting move count and
search effort, not the quantity of metadata or a self-reported confidence score.

## 3. Build a bounded planner for interacting boxes

This runs primarily INSIDE THE ANALYZER. Replace a single guessed parking target
with several concrete, costed ways of clearing an interaction, and use them to
build and simulate the candidate schedules before search starts.

- Select small groups from actual dependency edges, shared doorways, or blocked
  push support. Start with pairs; allow a third box when it is the obstruction
  preventing a useful pair plan. Do not enumerate all triples globally.
- Search using actual keeper reachability and push-plus-walk costs. Keep other
  boxes fixed as obstacles. If a projected relaxation is used for ranking,
  validate every emitted sequence against the complete current board.
- Produce alternatives for release, clearing a lane, temporary staging, and
  completing transport. A macro contains its path, resulting layout and keeper
  position, costs, satisfied predicates, and required preconditions.
- Preserve alternatives with useful differences in moves, pushes, keeper
  arrival, and resulting access. Do not collapse everything to the cheapest
  endpoint under one weighted score.
- Bound elapsed time, expansions, alternatives, and cache bytes. A timeout or
  failure is inconclusive and falls back to ordinary macros, not a deadlock.
- Cache only where obstacle layout and keeper connectivity are compatible.
  Local failure may guide scheduling but cannot justify global hard pruning.

Exit: replay-valid interaction macros composed into the analyzer's candidate
plans and consumed by search. If pairs fail to capture the important conflict,
adaptively enlarge the interacting group or room interface while bounding
resources. Judge additional analysis by downstream quality and search reduction.

## 4. Make search execute and repair the prepared plans

The main search follows prepared tasks and verified macro segments, branching
primarily at the unresolved choices exposed by analysis. It should not have to
rediscover room order, basic clearance requirements, or every parking decision.
Reuse verified prefixes directly when their exact preconditions match.

- Compare task macros using actual incurred moves plus estimated remaining
  transport and access work. Do not substitute keeper approach distance alone
  for the full cost of choosing a task.
- Reserve beam capacity for different task orders, release choices, and keeper
  arrivals. A premature task preference should not eliminate every alternative.
- Review push-first dominance rules for move-oriented discovery. Retain a
  bounded nondominated set where fewer pushes and fewer moves disagree, with
  state identity precise enough to preserve keeper-position cost differences.
- Permit preparatory detours and temporary goal displacement. Only proven
  commitments may restrict exact search; planning preferences remain soft.
- Keep the ordinary planner available within the same search deadline. Allocate
  effort based on useful progress rather than granting each new strategy a
  separate full budget.
- Add small pair-pattern tables only if profiles show that missing interaction
  estimates remain a bottleneck. Construct reusable tables during analysis;
  count construction, lookup, and retained memory costs separately. Do not sum
  overlapping estimates into a proof lower bound without a
  valid cost-partitioning argument; discovery experiments remain separate from
  proof-engine guarantees.

Exit: improved verified moves at equal search budget on the structural corpus,
with analysis cost reported. Ablate the prepared plan at a fixed narrow search
width to demonstrate that the analyzer, rather than stronger downstream brute
force alone, is responsible for the improvement.

## 5. Enable larger incumbent restructuring

- Extend rewriting to select expensive episodes around task boundaries and
  room interfaces, rather than relying only on chronological fixed windows.
- Try relocating an independent episode, exchanging transport order, delaying
  final placement, and combining repeated visits to the same area.
- Reuse the interaction planner to repair affected sections. Match complete
  splice states, or explicitly search a reconnecting bridge; matching box
  counts or room membership alone is insufficient.
- Use release/interface milestones as optional reconnecting states so that
  alternatives can change intermediate layouts and task order.
- Prioritize regions by measured avoidable walking and repeated transport;
  stop spending effort on repeated misses. Replay-verify every accepted route.
- Apply schedule restructuring during analysis when complete simulated plans
  are available. After handoff, preserve the best incumbent and share the
  three-second search deadline with discovery and search-based rewriting.
  Never replace a valid route with an unverified candidate.

Exit: demonstrate a route change that improves task ordering beyond the reach
of existing local rewrites, with its gain and elapsed cost measured separately.

## 6. Tune the integrated pipeline and promote only demonstrated wins

- Run feature ablations for the task model, interaction macros, move-aware
  dominance, strategic diversity, and larger rewriting. Keep useful combinations;
  delete superseded experiments and redundant knobs.
- Tune a small justified parameter set after the architecture can produce better
  alternatives. Validate on held-out fixtures to limit Grand Hall overfitting.
- Profile remaining allocation, reachability, heuristic, and macro-expansion
  costs. Optimize measured hot paths while preserving intended behavior.
- Enforce separate analysis and search budgets, with cancellation checks
  throughout. Use measured discovery, repair, and rewrite costs to allocate the
  three-second search window. Retain visible analysis progress and report total
  waiting time even though it is outside the primary search target.
- Add persistent resume support only after the short-budget path is evaluated:
  versioned, bounded checkpoints/incumbents keyed by board and solver identity,
  with validation on load. It addresses long-running puzzles separately from
  the first-attempt Grand Hall target.
- Expand reverse lanes only if benchmark evidence identifies reverse coverage
  as limiting. First implement correct meeting-map ownership, shard routing,
  budget allocation, and cancellation. Raising the lane cap alone is not a fix.

Exit: promote the smallest effective production configuration. Update reviewed
deterministic guardrails only after explaining and verifying changed results.
Preserve historical baselines instead of overwriting them.

## Validation and completion

For each algorithmic change, test reachable-path reconstruction, typed/generic
goal compatibility, temporary goal displacement, dependency cycles, stale cache
preconditions, local-planner cutoff fallback, and full-board macro replay as
applicable. Include symmetry and exact small-board oracle comparisons where
completeness or pruning semantics are touched.

Before promotion, run the full unit suite, generated-artifact checks, lint,
typecheck, production build/static checks, Grand Hall and multi-puzzle gates,
and production-browser worker/timeout/cancellation checks. Browser timing is
measured independently from correctness tests; unrelated proof-heavy benchmarks
need not be rerun for each scoring experiment.

Final evidence must report:

1. Grand Hall moves and search-time-to-650 for every reference-browser repetition,
   separately for cold and warm workers and each analysis budget, with failures
   included. Also report complete elapsed time from the user's solve request.
2. Held-out solved count and quality/time changes, including regressions.
3. Analysis/planning/search/rewrite cost breakdown and memory observations.
4. Which features were retained, rejected, or remain experimental.

The primary target is achieved only when replay-valid solutions at or below
650 moves arrive within 3 seconds of search after analysis across the reference-run acceptance
set. A median alone cannot establish that. If it remains unmet, deliver the
validated Pareto improvements and identify the measured bottleneck without
calling an analysis-only change a completed quality upgrade.

During implementation, continue through dependent stages without requiring a
new prompt for each internal milestone. Report meaningful benchmark changes,
failures that change the approach, and the final integrated result. Ask only
when an external constraint or genuinely consequential product choice cannot
be resolved from the existing request.
