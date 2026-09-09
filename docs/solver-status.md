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
Discovery quality never substitutes for proof.

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
historical lower-memory Grand Hall proof claims were invalid: PI-corral pruning
incorrectly rejected its solvable root. That rule is now disabled in exact search,
including explicit feature overrides. Updated runs retain unknown optimality and
bounded proof metadata. Sokomind 1.2.0 / exact A* and IDA* 2.2.0 supersede the
affected versions; IDA* schema 3 rejects older checkpoints, including direct API
resume. Previously emitted claims must not be treated as current proof evidence.

Rescheduling publishes complete improvements during repair. The coordinator
independently replays these under the same pre/post-verification budget checks,
retains only the best published route, and continues bounded repair. If a later
work/time cutoff or worker failure prevents the terminal message, the already
verified improvement survives. Cancellation still returns cancelled, and a
candidate first received at the limit is not accepted. This preserves useful
work without extending the shared limits or changing proof semantics.

The adapter is split by responsibility: `sokomind-legacy.ts` converts legacy
data and validates replay, `sokomind-plans.ts` builds worker payloads and divides
rewrite budgets, and `sokomind-solver.ts` coordinates execution.

## Exact-search safeguards

- A* and IDA* minimize moves and independently replay accepted routes.
- IDA* keeps collision-checked best-`g` dominance only inside the current
  contour. Path-dependent backed `f` values are not persistent transposition
  bounds.
- The unproved goal-depth macro prune is disconnected from both exact kernels.
- A numeric upper bound is an exclusive pruning ceiling. Only a complete,
  replay-valid incumbent can become a public solution.
- A* resource exits retain the active minimum-`f` node's bound rather than
  deriving proof progress from the remaining heap alone.
- Pattern-database, deadlock-table, and related preprocessing share the run's
  cancellation, elapsed-time, state, and estimated-memory budgets.
- Parallel rewrite lanes receive deterministic, disjoint integer shares of the
  remaining expanded, generated, and elapsed budgets.
- Persisted proof records are versioned and fingerprinted; stale solver or
  feature identities cannot establish current optimality.

`inter-rooms` is the regression for the former unsound goal prune. It must solve
in 28 moves with a replay-valid seven-push route and equal 28-move lower and
upper bounds under both exact engines.

## Exact feature controls

Every feature in `src/solver/search/exact-search-features.ts` defaults on and can
be disabled internally for controlled comparisons:

- incremental assignment repair;
- linear conflict;
- interaction boost;
- pattern database;
- forced-push macros;
- PI-corral pruning;
- pattern-deadlock pruning;
- deadlock-table pruning;
- goal-commitment pruning; and
- tunnel macros.

Telemetry reports the feature vector and mechanism-specific construction,
evaluation, application, or prune counters. A feature is beneficial only when
both variants prove and replay the expected result, the control proves the
feature ran, deterministic work or measured memory improves, and isolated-run
timing shows no material regression.

Tunnel macros add look-ahead successors at safe stopping points while retaining
the ordinary single-push successor. Replacing the single step is unsound on
short tunnels where the robot can reach the opposite side.

Mixed-label deadlock tables enumerate the complete label assignment product
within the existing construction budget. Deeper PI-corral boundary-table checks
and relaxed pattern-window eligibility remain rejected because each produced a
false positive under its abstraction.

## Correctness and performance gates

Known optima and oracle cases live in `tests/fixtures/solver-v2/`; the source and
tests own their current counts. New optima require an independent exact result,
replay validation, and review before entering the frozen map.

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
