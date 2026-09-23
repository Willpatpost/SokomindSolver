# Solver status and proof safeguards

This guide records current solver guarantees and the few implementation choices
that maintainers must preserve. For module boundaries and worker protocols, see
[Solver integration](solver-integration.md). For measurements and experiment
history, see [Solver benchmarks](solver-benchmarks.md).

## Production paths

The shipped solver has three layers:

1. Classic exact A* and IDA* kernels for move-optimal proofs.
2. Sokomind discovery for fast incumbents, with harvesting and bounded rewrite
   available to quality mode.
3. Sokomind optimal mode, which gives replay-valid incumbents to the exact proof
   kernels under one run-wide resource budget.

All worker results pass structural validation and core replay before return.
Discovery quality never substitutes for proof. Proven results require an optimal
proof envelope; bounded proofs require unknown optimality, including at the worker
client boundary. Classic DFS/Greedy reuse a keeper region only when the newly
occupied cell was outside the parent region; otherwise they recompute full BFS.
Sokomind reports `exhausted` only when a complete search finishes without a
route. If the budget runs out before its complete fallback search can start,
the result is `limit-reached`.

Browser Sokomind controls offer Auto or a manual worker ceiling up to twelve.
Hardware and memory can reduce that ceiling. Discovery reserves 256 MiB per
lane; browser Quality/Optimal proof reserves 512 MiB per lane plus 128 MiB for
the coordinator. Available partitions can further reduce occupied workers.
Non-browser proof parallelism defaults to one; deterministic adapter runs are
serial. Cancelling Optimal proof returns cancelled with one proof lane or many,
never the discovery incumbent. The [performance roadmap](SOLVER-PERFORMANCE-ROADMAP-2026-09-16.md)
tracks qualification and the remaining scheduler work.

Parallel proof uses a shared pending first-push queue with one active task per
lane. Automatic algorithm selection uses the lane's divided memory. Active or
failed task grants stay reserved until safe completion; remaining elapsed time
is recomputed at dispatch. Late candidates and certificates exceeding their
work grants cannot establish proof. Aggregate progress publishes
active/pending worker counts and only bounds a lane failure cannot withdraw:
completed partitions' bounds and the prefix bound of each open partition. A
running lane's own bound appears in the progress detail as provisional until
its partition completes, so the worker host's monotonic-bound check never
rejects the run. Failed partitions retain only their independently
known prefix bound; they block an optimal certificate unless that prefix bound
alone reaches the incumbent cost, whatever order lane events arrive in.
Deadline cutoff remains bounded. Deeper partition splitting and immutable preprocessing reuse remain open.

Exact PDB preprocessing checks estimated memory before table/queue allocation,
releases consumed packed queue chunks, and propagates cancellation. Optional
PDB-cache growth is included in both kernels' live estimates and cannot consume
unavailable residual memory. The corrected move-cost PDB remains disabled
pending broader performance qualification. Quality strategic defaults preserve
explicit zero-analysis and false-plan-execution controls.

Persisted optimality records use schema 7, proof revision
`exact-moves-pattern-key-v1`, and storage key `sokomind.optimal.v7`.
Earlier revisions are rejected in both storage tiers, including schema-7 records
that can predate the A* frontier correction, the tunnel-macro soundness fix or
the pattern-deadlock key fix.
The separate storage key prevents older tabs from overwriting current
certificates; progress and personal-best routes are preserved. Bump the proof
revision and storage key after any proof-safety correction.

A* 2.2.1 and Sokomind 1.2.1 correct forced-successor scheduling: forced children
use the global priority queue before their bounds or goals can establish proof.
The previous shortcut could certify a nine-move solution while a seven-move
route remained in the frontier. Independent oracle tests cover the board,
mirror, rotation, incumbents and resource cutoffs. Earlier A* certificates must
not be treated as proof evidence. This A*-specific correction does not change
the independently searched IDA* contours or checkpoint schema.

A* 2.2.2, IDA* 2.2.1 and Sokomind 1.3.0 correct tunnel-macro pruning. The
former macro dropped the single push into a tunnel whenever the next cell was
on the same tunnel axis, keeping only its stops (matching goals, the exit and
the blocked end). Routes that park a box part-way into a tunnel were lost, so
both exact kernels could certify non-optimal move counts and prove solvable
boards unsolvable. IDA* also keyed macro children by the box's origin cell
instead of the post-macro robot cell. Macro stops are now extra successors
beside the single push, and tunnel macros default off.

The same releases correct the pattern-deadlock cache key. The local search
reads the floor just outside its 9x9 window (push supports and escapes), but
the canonical key encoded only the window's floor, goals and boxes. A window
whose exits were walled could prove a deadlock, and that verdict was then
reused for a translated or rotated copy of the window whose exits were open,
pruning live states with default features. The oracle-backed
`pattern-deadlock-soundness` fixtures, one board proven at 73 instead of 63
moves and one proven unsolvable instead of solvable in 63, run through both
exact kernels. Proof revision `exact-moves-pattern-key-v1` rejects earlier
optimal records, and IDA* checkpoint schema 4 rejects earlier checkpoints.
Earlier certificates and unsolvability proofs must not be treated as proof
evidence. The bundled engine's local pattern memo carried the same key defect;
its results are replayed and labelled unknown optimality, so there it cost
solution quality rather than proof soundness.

Sokomind 1.3.0 also versions the earlier Quality changes: Quality no longer
dispatches proof and always reports unknown optimality, `SolverRequest` accepts
a replay-validated `initialSolution` seed, and Quality repair runs on a
parallel task-slot coordinator. Quality artifacts labelled 1.2.1 may predate
these changes.

Quality and optimal modes can refine a complete incumbent with whole-box
rescheduling. Every physical box is eligible, including repeated-label boxes;
route-length and remaining-budget checks still govern execution. Each repair
frees one box while preserving the other boxes' push order and identity. This
restricted optimization is not a global optimality proof. See the
[Grand Hall evidence](benchmarks/grand-hall-rescheduling.md) for isolated repair
and public-adapter results with their separate inputs and limits.

Quality-mode whole-box repair uses its allocated state budget for work and the
existing live estimated-memory checks for memory. It no longer inherits the
extra 20k/35k memory-class state caps. Local-window and optimal-mode allocations
are unchanged; shared limits, cutoff publications, and replay checks still apply.
See [resource-policy measurements](benchmarks/quality-memory-policy.md). The
historical lower-memory Grand Hall proof claims were invalid: the former PI-corral
implementation incorrectly rejected its solvable root because it only checked
keeper-reachable boundary pushes and applied deadlock tests against all board
boxes. That implementation has been replaced with a sound I-corral detector that
checks all potential boundary pushes (support cell outside the corral component)
and restricts freeze/2x2 deadlock tests to corral-internal boxes only. The
corrected detector does not false-positive on Grand Hall. PI-corral pruning
PI-corral pruning now defaults on after benchmark validation showed consistent
state-count improvements; the prior hard override that silently forced it off has
been removed. Updated runs retain unknown optimality and bounded proof metadata. Sokomind 1.2.0 / exact A* and IDA* 2.2.0 supersede the
affected versions; IDA* schema 3 rejects older checkpoints, including direct API
resume. Previously emitted claims must not be treated as current proof evidence.

Rescheduling publishes complete improvements during repair. The coordinator
independently replays these, retains only the best published route, and
continues bounded repair. If a later work/time cutoff or worker failure prevents
the terminal message, the already verified improvement survives. A route that
arrives in the same message that reaches a work, time or memory limit is also
replayed and kept, in discovery as in repair: engines stop at their grants, so
the limit stops new work, not work already done. Cancellation still returns
cancelled, and a route whose reported expanded or generated work passes the
request limit is not accepted. This preserves useful work without extending the
shared limits or changing proof semantics.

The adapter is split by responsibility: `sokomind-legacy.ts` converts legacy
data and validates replay, `sokomind-plans.ts` builds worker payloads and divides
rewrite budgets, and `sokomind-solver.ts` coordinates execution.

## Tuning-controlled search experiments

Three tuning parameters control experimental search behavior. All are soft
ordering or candidate-generation changes; none affect legality, deadlock
rejection, replay verification, or resource limits.

- `firstPushWalkWeight` (default 0, disabled): adds exact keeper walk-to-support
  distance as a penalty term in the structural planner's first-push ranking.
  Active in the `planMacroBeamSearch` recovery score. Set to 0.05 to enable.

- `moveAwareDiscovery` (default 0, disabled): when >= 0.5, discovery beam
  search uses `BoundedKeeperArrivalMap` for transpositions instead of
  depth-only dedup, retaining states with distinct keeper approach directions.
  Quality-mode discovery plans set `planMoveAwareTranspositions: true` when
  enabled.

- `macroIntermediateQuota` (default 0, disabled): retains up to this many
  non-endpoint intermediate states in both untargeted and targeted macro
  expansion, selected by shortest path and side diversity. Targeted macros
  report separate counters (`macroTargetedIntermediatesGenerated`,
  `macroTargetedIntermediatesRetained`). Intermediate provenance
  (`intermediateOf`) is written but not yet consumed by beam selection.
  A configured quota alone is not evidence it ran.

Quality-mode rescheduling is gated by `predictRescheduleValue()` in
`sokomind-reschedule-predictor.ts`. Puzzles with low walk-push ratio and few
boxes skip whole-box repair. Optimal mode always reschedules when eligible.

Supply validated tuning to the adapter through its `tuning` option. The Node
benchmark commands also accept `SOKOMIND_TUNING_JSON`, e.g.
`SOKOMIND_TUNING_JSON='{"moveAwareDiscovery":1}'`. The SLURM benchmark script
`scripts/slurm-p1-benchmark.sh` runs controlled A/B pairs for each parameter.
Explicit strategic options are preserved in every mode: zero analysis time and
disabled execution remain off in Quality. Enabling a strategy is separate from
selecting Quality and still requires the documented promotion evidence.

## Exact-search safeguards

- A* and IDA* minimize moves and independently replay accepted routes.
- IDA* keeps collision-checked best-`g` dominance only inside the current
  contour. Path-dependent backed `f` values are not persistent transposition
  bounds. Computed `h` values are cached across contours because `h` is
  state-determined (depends only on box positions and robot cell, not path).
- The unproved goal-depth macro prune is disconnected from both exact kernels.
- A numeric upper bound is an exclusive pruning ceiling. Only a complete,
  replay-valid incumbent can become a public solution.
- A* resource exits retain the active minimum-`f` node's bound rather than
  deriving proof progress from the remaining heap alone.
- Forced successors obey the same frontier ordering and projected-memory
  checks as other successors, including the initial node arena allocation.
- Pattern-database, deadlock-table, and related preprocessing share the run's
  cancellation, elapsed-time, state, and estimated-memory budgets.
- Parallel rewrite lanes receive deterministic, disjoint integer shares of the
  remaining expanded, generated, and elapsed budgets.
- Bidirectional discovery lanes receive disjoint generated-state shares and
  enforce them before generating successors; coordinator checks remain a backstop.
- Worker registration and coordinator resource changes invalidate cached totals
  before subsequent startup or limit checks, including silent workers.
- Persisted proof records are versioned and fingerprinted; stale solver or
  feature identities cannot establish current optimality.
- Macro successors are additive. Tunnel macros never remove the single-push
  child, and every macro child's state key uses its exact post-macro robot cell.
- Pattern-deadlock memo keys encode every cell the local search reads,
  including the floor just outside the window, and a memo only serves the
  board it was built on.

`inter-rooms` is the regression for the former unsound goal prune. It must solve
in 28 moves with a replay-valid seven-push route and equal 28-move lower and
upper bounds under both exact engines.

The `es01`, `es01a`, `es01c`, `es01d`, `fz-unsolvable` and `fz-corridor` boards
in `tests/fixtures/solver-v2/tunnel-soundness.ts` are the regressions for the
former tunnel single-push replacement. Both exact engines must prove the oracle
optimum (9, 16, 19, 22, 15 and 10 moves) with default features, with
`tunnelMacros` enabled and with `forcedPushMacros` disabled, and `es01d` and
`fz-unsolvable` must never be reported unsolvable.

`pd-false-optimum` and `pd-false-unsolvable` in
`tests/fixtures/solver-v2/pattern-deadlock-soundness.ts` are the regressions
for the former pattern-deadlock key. Both exact engines must prove the 63-move
oracle optimum with default features and with `tunnelMacros` enabled while
pattern-deadlock pruning is active.

## Exact feature controls

The features in `src/solver/search/exact-search-features.ts` can be disabled
internally for controlled comparisons. All default on except where noted:

- incremental assignment repair;
- linear conflict;
- interaction boost;
- pattern database;
- forced-push macros;
- PI-corral pruning;
- corral ordering;
- pattern-deadlock pruning;
- deadlock-table pruning;
- goal-commitment pruning;
- tunnel macros (default off);
- goal-cut heuristic; and
- backward perimeter (default off).

Telemetry reports the feature vector and mechanism-specific construction,
evaluation, application, or prune counters. A feature is beneficial only when
both variants prove and replay the expected result, the control proves the
feature ran, deterministic work or measured memory improves, and isolated-run
timing shows no material regression.

Tunnel macros add look-ahead successors when a push moves a box into a
same-axis tunnel cell: one child per stopping point (a matching goal, the
tunnel exit, or the last free cell before a wall or box), costed as the keeper
walk plus one move per push. They never replace the single push. Every stop is
2 to 64 pushes away: a one-push stop would repeat the single push, and the A*
node arena records at most 64 pushes per step. A stop beyond that is offered
once single pushes bring the box close enough. The former rule dropped the
single-push child whenever the destination's far neighbor was also a tunnel
cell; that pruned move-optimal plans that stop a box part-way into a tunnel and
produced false proven optima and false `unsolvable` proofs on solvable boards.
IDA* keys each macro child by its post-macro robot cell, as A* already did.
Once sound, the macro adds no pruning and measured slower, so `tunnelMacros`
defaults off; re-enable it only after the tunnel regressions pass with it on
and a benchmark shows a gain.

Goal-commitment pruning skips successor generation for boxes proven to be on
their final goals. Static commitments detect boxes on matching goals in corner
or dead-end cells (both axes wall-blocked). Dynamic freeze commitments extend
this: when a group of boxes is mutually frozen (each axis blocked by walls or
other frozen boxes) and every box in the group is on its matching goal, the
entire group is committed. The residual assignment check ensures the remaining
boxes can still reach the remaining goals.

Corral ordering reuses the PI-corral flood to identify boundary pushes into
unreachable regions containing off-goal boxes and reorders IDA* child generation
to try those pushes first. It never prunes branches, so proof correctness is
unaffected. PI-corral pruning uses a sound I-corral detector that checks all
potential boundary pushes and restricts deadlock tests to corral-internal boxes.

Pattern-database partitions contribute to the heuristic via per-label surplus:
for each label, any excess of the PDB value over the assignment cost is added to
the heuristic as `h = assignment + max(LC, boost, pdb_surplus, goal_cut) + walk`.
This is admissible because each label's boxes and goals are disjoint.

Goal-cut detects bottleneck conflicts when multiple boxes' shortest push-paths
share articulation points or tunnel cells. For each bottleneck with demand N > 1,
the surplus is (N-1)*2 additional pushes; the heuristic takes the maximum across
all bottlenecks. This is admissible: N boxes sharing a single-capacity bottleneck
require at least N-1 yield manoeuvres of 2 pushes each.

Mixed-label deadlock tables enumerate the complete label assignment product
within the existing construction budget. Deeper PI-corral boundary-table checks
and relaxed pattern-window eligibility remain rejected because each produced a
false positive under its abstraction.

Backward perimeter builds a bounded reverse push-only BFS from the solved box
layout during preprocessing. The BFS uses relaxed un-push transitions (no
keeper reachability, no deadlock pruning) so its distances are admissible lower
bounds on remaining pushes. For repeated-label puzzles, matching-component
analysis (alternating-cycle detection on the box–goal bipartite reachability
graph, ported from `perfectMatchingDomains`) splits interchangeable same-label
boxes into independent groups, giving the reverse BFS a unique seed and
finer-grained colored state identity. Colored BFS states are projected back to
uncolored box-only keys; the minimum distance across all colorings is stored.
Forward A*/IDA* combine the perimeter as
`h = max(normalPushBound, perimeterPushDist) + walkBound`. Perimeter values
are lower bounds only — never upper bounds and never incumbents. The feature
defaults off pending benchmark validation.

## Correctness and performance gates

Known optima and oracle cases live in `tests/fixtures/solver-v2/`; the source and
tests own their current counts. New optima require an independent exact result,
replay validation, and review before entering the frozen map. Only entries with
`oracleStates` have step-oracle provenance; the others are frozen exact-solver
outputs. The known-optimum gate replays every entry through exact A* and the
small oracle-backed entries, solved and unsolvable, through exact IDA* too.

```text
npm.cmd run test:solver:oracle
npm.cmd run test:solver:optimal
npm.cmd run test:solver:proof-regressions
npm.cmd run test:solver:known
npm.cmd run test:solver:known:extended
npm.cmd run test:solver:parallel
npm.cmd run test:solver:multi
npm.cmd run test:solver:huge
npm.cmd run benchmark:solver:v2 -- --fixture=ultra-tiny --profile=sokomind-fast --runs=1 --warmup=0
```

Correctness changes may expose performance costs. The open measurement work is
to recover the slow `expert-tetris` proof without restoring unsafe pruning,
capture full controlled feature A/B samples where exercise counters are
nonzero, and keep Grand Hall base/mirror/rotation results replay-stable.
