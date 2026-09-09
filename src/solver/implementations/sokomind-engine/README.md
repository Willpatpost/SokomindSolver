# Sokomind engine provenance

This directory contains the search kernel used by the **Sokomind Solver**
adapter.

The baseline modules were ported from `Sokomind/src`. `heuristic.js` comes
from the newer `Sokomind/src` implementation because it reuses the existing
Hungarian assignment when calculating linear conflicts instead of solving the
same assignment twice.

The following newer changes are intentionally excluded:

- the PI-corral sealed-state prune, because it inferred the keeper region from
  an arbitrary adjacent cell rather than the exact post-push keeper position;
- same-box tunnel collapsing, because it can skip a required stop or an
  interleaving push by another box;
- default congestion scoring, because it changed Grand Hall's deterministic
  route and expanded-state count without a correctness or performance win;
- enlarged per-worker caches and worker caps, because the website enforces one
  aggregate browser memory budget.

The older PI-corral helper is also disabled as a hard prune. The engine retains
the separate sealed-corral check that receives the exact reachable keeper
region.

The vendored `solver-search.js` includes integration telemetry and bounded
structural-search improvements. Bidirectional record batches include visited,
generated, frontier, retained, and peak-frontier counters. The structural plan
lane accepts a generated-state cap so the adapter can reserve a run-wide budget
for discovery. On crowded room boards it also spends one existing first-push
slot on an additional distinct box agenda before alternate directions; the
total first-push cap is unchanged.

`planEgressGuard` continues to control the certified packing-order and
box-continuation guards. The local `strandedExports` estimate is intentionally
only a soft score by default: a legal enabling import can temporarily increase
that one-push estimate. `planStrandedExportGuard: true` restores the legacy hard
rejection for diagnostic comparison only. `planDiagnostics: true` emits a
bounded per-layer generation/selection/pruning trace; normal runs omit it and
do not allocate trace records.

The source files use the legacy classic-script layout: declarations span files
and must share one lexical scope. `scripts/prepare-sokomind-engine.mjs`
concatenates the required live modules into `engine.generated.js`, which Vite
then packages as a same-origin module worker. The generated file is checked in
so type checking and editor navigation do not depend on a sibling repository.
Large-board analysis also produces the legacy prepared-board seed, which is
structured-cloned to search workers and rehydrated with worker-local mutable
caches.

Strategic preparation emits a validated V2 advisory contract. Its predicates and
resource intervals are evaluated from each board state; completion is reversible
and cannot authorize new hard pruning. The preparation script also generates
`strategic-validation.generated.js` from the same validator source, so the typed
adapter does not import the search engine into the UI bundle. Checkpoint lineage
replay, canonical coordinate mapping, and box-role rebinding occur in the worker.

Persistent execution requires the experimental request option
`strategicPlanExecution: true` alongside strategic preparation. It defaults off
because current quality results are mixed. Kernel experiments can disable it with
`planStrategicExecution: false` while retaining prepared seeds. Diagnostics report
`strategicExecution` evaluation, enabled/completed, advancement, and recovery counts.

The `solution-box-reschedule` search command accepts `state` and a
replay-valid `solutionPath`. It frees one physical box's entire schedule,
including boxes in repeated-label groups, while retaining every other box's
push order and identity. It uses exact keeper travel and
bounded A*, verifies each accepted candidate and the unchanged push sequence,
and retains the incumbent when interrupted by its work/time budgets. It is a
post-solution repair command, not pre-search analysis or a global optimality proof.
Each accepted improvement is also published as a complete `path` on a progress
message. The adapter independently replays and retains the best publication
before checking later work, so a subsequent shared-budget cutoff cannot discard
an already verified improvement. Publication does not end the repair phase.

`maxVisited` (default 300,000), `maxGenerated` (2,000,000), and
`rescheduleMaxMs` (10,000) are shared across all repairs. `rescheduleRounds`
defaults to two; zero disables repair. Optional `rescheduleBoxIndices` restricts
the eligible physical box indices. Otherwise the largest observed push detour is
tried first, followed by alphabetical sweeps. Temporary occupancy tables are
capped at four million cells. `boxRescheduling` reports per-attempt counters and
budget exhaustion. A supplied `maxMemoryBytes` also bounds estimated table and
node memory; progress reports expose work and retained-state accounting.
The public quality/optimal pipeline automatically selects this command for its
final refinement when at least one box, a sufficiently long verified incumbent,
and unused quality budgets are available.
Eligible first local passes are capped at 50,000 states and three quarters of the
quality time envelope, reserving time for rescheduling. Fast mode is unchanged.
See [integration evidence](../../../../docs/benchmarks/grand-hall-rescheduling.md).

The internal structural planner accepts an optional read-only observer used by
the offline Node VM route diagnostic. It is not exported and cannot be configured
through worker payloads. Normal solving leaves it null and allocates no events.
See [recoverability methodology](../../../../docs/benchmarks/planner-route-recoverability.md)
for matched-state semantics, bounds, and known visibility limits.
