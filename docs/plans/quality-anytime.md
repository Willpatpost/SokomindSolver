# Quality mode: comprehensive anytime improvement implementation plan

Status: **planned; no solver implementation in this document change**.

Prepared September 19, 2026 against source revision
`c415a02ea78160f56fa5aa8420f1e812c61766e6`.

This is the implementation guide for the requested Quality-mode redesign.
It supersedes earlier plans that give Quality unused time for optimality
proving. It does not change the separate Optimal-mode proof contract.
Line numbers below are verified starting points at the revision above; they
will move during implementation. Find the named symbol before editing.

## Contents

1. [Product contract and invariants](#1-product-contract-and-invariants)
2. [Evidence and diagnosis](#2-evidence-and-diagnosis)
3. [Current source map](#3-current-source-map)
4. [Target architecture](#4-target-architecture)
5. [Work package A: remove Quality proof paths](#5-work-package-a-remove-quality-proof-paths)
6. [Work package B: publish every useful complete improvement](#6-work-package-b-publish-every-useful-complete-improvement)
7. [Work package C: task outcomes, accounting, and continuation](#7-work-package-c-task-outcomes-accounting-and-continuation)
8. [Work package D: diverse candidate archive](#8-work-package-d-diverse-candidate-archive)
9. [Work package E: adaptive scheduling and parallel repair](#9-work-package-e-adaptive-scheduling-and-parallel-repair)
10. [Work package F: continue from an existing solution](#10-work-package-f-continue-from-an-existing-solution)
11. [Work package G: broader repair neighborhoods](#11-work-package-g-broader-repair-neighborhoods)
12. [Work package H: computation and memory efficiency](#12-work-package-h-computation-and-memory-efficiency)
13. [UI, protocol, and documentation integration](#13-ui-protocol-and-documentation-integration)
14. [Testing and qualification](#14-testing-and-qualification)
15. [Delivery sequence and completion checklist](#15-delivery-sequence-and-completion-checklist)
16. [Risk register and implementation pitfalls](#16-risk-register-and-implementation-pitfalls)
17. [Audit artifacts and reproduction](#17-audit-artifacts-and-reproduction)
18. [Durable route evidence](#18-durable-route-evidence)

## 1. Product contract and invariants

### 1.1 What Quality means

Quality spends its available solving budget finding and improving legal
solutions. It does not schedule global optimality proof work. A completed
Quality run returns the shortest verified solution it has accepted, with
unknown optimality and no newly produced proof envelope.

The primary objective remains **total moves**. Fewer pushes can break an
equal-move tie, but a route with fewer pushes and more moves is not a better
returned solution. Different push counts may still make a candidate useful
for further exploration.

Optimal owns global certification. Fast owns first-solution latency. Local
A* searches inside a bounded repair operator remain permitted: their purpose
is to find a better route within a restricted neighborhood, not to prove the
whole puzzle optimal. Do not remove useful local search merely because it
uses an exact priority queue.

### 1.2 Full-budget behavior

For a finite time allowance, Quality should keep assigning useful work until
the deadline, unless cancelled or stopped by an explicit request-wide resource
limit. It should not stop improving because an arbitrary internal cumulative
expansion counter reaches a memory-tier-derived threshold.

When one task finishes, choose another task: another candidate, another box or
window, a larger bounded neighborhood, a different discovery seed, or an
eligible experimental operator. Keep an exploration allocation so promising
but initially longer candidates are not starved.

Full-budget behavior does not mean busy-waiting, knowingly repeating an
exhausted task, manufacturing work, or exceeding a deadline. If all enabled
avenues are genuinely exhausted and no new task can be generated, return the
best route with an explicit diagnostic explaining that condition. A solved
starting snapshot can return immediately. When no time limit is requested,
continue useful search until cancellation, explicit resource exhaustion, or
genuine exhaustion of configured avenues; do not silently substitute a proof
phase or an undocumented 45-second run limit.

Reserve measured headroom for verification, result assembly, messaging, and
worker cleanup. Internal task deadlines should precede the outer deadline.
Use a monotonic clock and include preparation and replay in the total budget.

### 1.3 Invariants that every implementation stage must preserve

- The best accepted move count never increases within one run.
- An archived candidate may be worse than the global best; the returned route
  may not be worse than the global best.
- An accepted initial incumbent is a floor on output quality, not a proof.
- Every published complete candidate is independently replayed by the
  coordinator before it becomes accepted, displayed as an accepted best, or
  persisted.
- A candidate received after the accepted deadline cannot improve the result.
  Preserve existing pre- and post-replay cutoff checks.
- Explicit expanded-state, generated-state, and memory limits remain binding.
- Live memory includes worker state, retained candidates, pending verification,
  checkpoints, shared/prepared geometry, and coordinator bookkeeping.
- A task cutoff is not proof that its neighborhood was exhausted.
- Restricted repair exhaustion is not proof of global optimality.
- Hashes accelerate lookup; exact content or canonical keys resolve collisions.
- Physical box identity and exact keeper position remain available where the
  algorithm requires them, including repeated-label boxes.
- Cancellation keeps its existing public result semantics unless separately
  changed. Do not silently turn `cancelled` into `solved` just because a best
  route exists. A separate stop-and-keep-best feature can be designed later.
- Do not hard-code Grand Hall, its labels, the 916-move seed, or the 476-move
  route into production search or scheduling.

## 2. Evidence and diagnosis

### 2.1 Confirmed findings

The user supplied a replay-valid Grand Hall route of **482 moves / 242 pushes**.
An offline audit found **476 moves / 238 pushes**, and reproduced the identical
route and state counters in a fresh process. Neither route is certified
optimal.

| Observation | Evidence | Implication |
|---|---|---|
| A six-second initial rewrite returned no route to the coordinator before termination | An observation-only engine copy saw valid internal improvements from 952 down to 852 moves; the ordinary worker protocol did not publish them | Publish complete intermediate rewrite paths, then retain them at the coordinator |
| The supplied 30-second run switched from improvement to proof at exactly 500,000 additional expansions | 506,249 minus 6,249 equals 500,000; local reproduction repeated 506,213 minus 6,213 | Remove the implicit run-wide improvement cap; enforce actual request limits and live memory instead |
| Identical box sweeps repeated | Two completed sweeps of the same 485-move route each expanded 54,048 and generated 55,227 states | Track exhaustion by candidate and neighborhood; do not rerun an unchanged completed task |
| Longer time limits alter early search | Harvest takes 10% of requested time; initial rewrite takes 40% of remaining time, up to six seconds | Use stable initial work and resumable extension rather than proportional front-loading |
| A shorter seed can refine to a worse result | Table below | Preserve semantic diversity, not just lowest current move count |
| Single-box repair stops improving the user's route without hitting limits | Both short and long allowances completed the same 50,037-expanded / 51,101-generated search | Further quality needs other seeds or broader neighborhoods |
| Local-window work can be expensive with no benefit | Larger isolated rewrite took about 68.7 seconds, expanded 182,839 and generated 1,311,293 states, still returning 482 | Allocate by measured value, and retain alternatives rather than simply making windows larger |

### 2.2 Seed quality is not final quality

These are isolated refinements of replay-valid intermediate routes, using the
existing box rescheduler with an eight-round ceiling and bounded resources.

| Starting moves | Final moves | Final pushes |
|---:|---:|---:|
| 952 | 485 | 240 |
| 932 | 482 | 242 |
| **916** | **476** | **238** |
| 890 | 481 | 236 |
| 852 | 509 | 236 |

The 18-seed survey consumed approximately 21.64 seconds of isolated repair
work, 7,290,059 expanded and 9,435,739 generated states, excluding discovery
and observation. The winning isolated repair used 450,945 expanded and
582,585 generated states; its fresh-process time was about 1.36 seconds.
These are not end-to-end 15-second results and are not a statistical speed
claim. The 482-move routes in this seed survey were not byte-identical to the
user's 482-move route.

### 2.3 Scheduling experiment and limitations

A Node public-adapter baseline reached 485 moves at approximately 20.97 seconds
in a 30-second run. An audit-only combined treatment skipped harvesting and
reduced local-window work to normalization, reaching the same 485 moves at
approximately 10.75 seconds. This supports testing earlier repair; it does
not justify globally disabling harvesting or rewriting. The successful 476
seed came from rewriting.

Those adapter runs used Node v24.14.0 on Windows, a 4-GiB estimated-memory
limit, supplied hardware concurrency 16, supplied device memory 16 GiB,
automatic discovery workers, and seven proof workers. The user's browser
settings were not confirmed. The observations explain mechanisms but do not
establish browser timing distributions or holdout generalization.

101 focused tests passed during the audit. They do not certify the proposed
redesign, which has not been implemented.

## 3. Current source map

All paths are repository-relative. Links open the file; the line column
identifies the current entry point. Several rows intentionally name shared
code that must retain Fast/Optimal compatibility.

### 3.1 Coordinator, budgets, and candidate handling

| File | Current lines and symbols | Required work |
|---|---|---|
| [sokomind-solver.ts](../../src/solver/implementations/sokomind-solver.ts) | 347 `createSokomindSolverAdapter`; 359 `improveByMode` (formerly `boundHarvestAndImprove`); 390 onward `solve`; 270 `runClassicFallback`; 663 fallback dispatch | Route Quality to the dedicated scheduler; handle initial incumbents; eliminate the fallback Quality-to-proof transition; preserve cumulative metrics |
| [sokomind-harvest.ts](../../src/solver/implementations/sokomind-harvest.ts) | 55 `runProof`; 297 `harvestIncumbents`; 390 `qualityAnytimeImprove`; 455 initial-wave budget; 524 best selection; 539 stall state; 575 improvement cap; 644 final proof call; 654 `optimalQuickImprove` | Extract Quality scheduling, replace fixed loop, retain Optimal behavior |
| [sokomind-improvement.ts](../../src/solver/implementations/sokomind-improvement.ts) | 32 `SokomindImprovementOptions`; 39 `ImprovedIncumbent`; 45 `improveIncumbent`; 208 `solvedWithImprovement` | Rich task outcomes, resumable repair, candidate publication; audit memory-derived visited caps and phase deadlines |
| [sokomind-plans.ts](../../src/solver/implementations/sokomind-plans.ts) | 35 `defaultImprovementMaxVisited`; 42–48 time constants; 112 `structuralPlan`; 395 `diversifiedHarvestPlans`; 447 `sokomindRewriteConcurrency`; 467 `solutionImprovementPlan`; 517 `solutionReschedulingPlan` | Separate live-memory and work policy; build task-specific bounded payloads; add operator/cursor options without changing proof heuristics |
| [sokomind-incumbents.ts](../../src/solver/implementations/sokomind-incumbents.ts) | 29 `isSolutionBetter`; 39 `computeDiversitySignature`; 96 `computeHarvestMs`; 109 `selectForRewrite`; 138 `selectBest`; 156 `IncumbentCollector`; 167 `offer` | Preserve existing comparator; evolve diversity retention and eviction; stop tying early Quality harvest to total timeout |
| [sokomind-phase-runner.ts](../../src/solver/implementations/sokomind-phase-runner.ts) | 56 `PhaseRunOptions`; 62 `PhaseOutcome`; 128 `publishedSolution`; 273 `cleanupWorker`; 289 `finish`; 337 `acceptPath`; 493 `startPlan`; 522 progress-path gate; 661 `runPhase` | Accept complete rewrite publications, retain multiple useful candidates, expose lifecycle outcomes, later support persistent worker tasks |
| [sokomind-run-state.ts](../../src/solver/implementations/sokomind-run-state.ts) | 36 `SearchRunState`; 82 `invalidateAggregate`; 86 `aggregate`; 242 `metrics`; 261 `report`; 281 `updateTelemetry`; 463 `reachedLimit`; 473 `withRemainingLimits` | Add run-owned archive/task accounting; keep cumulative counters and peaks correct across tasks and worker reuse |
| [sokomind-budget-tracker.ts](../../src/solver/implementations/sokomind-budget-tracker.ts) | 20 `BudgetTracker`; 28 `checkLimit`; 58 `retainRecord`; 72 `resetPhase` | Track persistent archive/checkpoint memory separately from disposable phase records; implement reservation accounting if parallel repair is added |
| [sokomind-worker-registry.ts](../../src/solver/implementations/sokomind-worker-registry.ts) | `WorkerExecutionRegistry`, `register`, `deactivate` | Separate physical worker lifetime from logical task telemetry when pooling; ensure aggregate invalidation |
| [sokomind-worker-limits.ts](../../src/solver/implementations/sokomind-worker-limits.ts) | 2–5 reservation constants; 16 `workerCount`; 43 `effectiveWorkerCount`; 56 `effectiveProofWorkerCount` | Preserve ceilings; eventually use task-specific grants rather than assuming all repair tasks cost the same |
| [sokomind-legacy.ts](../../src/solver/implementations/sokomind-legacy.ts) | 119 `toLegacyState`; 301 `withPreparedBoard`; 325 `solutionFromLegacyPath`; 368 `semanticDiversityTrace`; 578 `legacyPathFromSolution` | Reuse canonical replay/conversion and semantic trace; preserve prefix handling for continuation states |

### 3.2 Engine and worker boundaries

| File | Current lines and symbols | Required work |
|---|---|---|
| [solver-search.js](../../src/solver/implementations/sokomind-engine/source/solver-search.js) | 11 `prepareSearchBoard`; 3624 `moveBridgeAStarSearch`; 3718 `bridgeAStarSearch`; 4294 vicinity `pushPermutationSearch`; 4385 `solutionWindowRewriteSearch`; 4399 canonical path; 4453 permutation improvement; 4518 push-window improvement; 4607 move-window improvement | Publish complete candidates, cumulative progress, budget checks, cursor state, later larger bounded neighborhoods |
| [box-rescheduling.js](../../src/solver/implementations/sokomind-engine/source/box-rescheduling.js) | 3 `fixedOrderBoxReschedule`; 40 `walk`; 184 `boxReschedulingTrace`; 196 `solutionBoxRescheduleSearch`; 229 `attempt`; 256 rounds/sweeps | Expose per-attempt outcome/cursor, avoid duplicate sweeps, later add pair/assignment repair and reusable buffers |
| [engine-protocol.ts](../../src/solver/implementations/sokomind-engine/engine-protocol.ts) | 67 `WindowRewritePayload`; 92 `BoxReschedulePayload`; 149 `EngineResultPayload`; 256 `isEngineCommand`; 362 `isEngineResult`; 430 `dispatchEngineCommand` | Type and validate task identity, complete-candidate events, cumulative counters, outcome and continuation payloads |
| [sokomind-engine.node-worker.ts](../../src/solver/implementations/sokomind-engine.node-worker.ts) | Worker `postMessage` bridge and dispatch callback | Preserve Node parity; extend lifecycle if cooperative yield/pooling requires it |
| [sokomind-engine.worker.ts](../../src/solver/implementations/sokomind-engine/sokomind-engine.worker.ts) | Browser worker dispatch | Apply equivalent lifecycle/protocol changes; verify actual filename before editing if source organization changes |
| [node-runner.ts](../../src/solver/node-runner.ts) | 18 `wrapNodeWorker`; 64 `createNodeEngineWorker`; 84 `createNodeSolverAdapter` vicinity | Worker reuse/termination tests and Node/browser parity |
| [prepare-sokomind-engine.mjs](../../scripts/prepare-sokomind-engine.mjs) | 21 `SOURCE_FILES` | Register new engine source modules in dependency order if any are added; regenerate output |

Never edit the generated engine directly. Change source modules and run
`npm.cmd run prepare:sokomind-solver`. Do not write new production code in the
audit directory or maintain a patched copy of the generated engine.

### 3.3 Public API, UI, persistence, and benchmarking

| File | Current lines and symbols | Required work |
|---|---|---|
| [contracts.ts](../../src/solver/contracts.ts) | 48 `SolverLimits`; 59 `SolverRequest`; 105 `SolverSolution`; 130 `SolverProgress`; 156 `SolverResult` | Optional typed initial incumbent if chosen; consistent progress/result semantics; no Quality proof envelope |
| [validation.ts](../../src/solver/validation.ts) | 36 `collectRequestIssues`; 66 `collectProgressIssues`; 193 `collectResultIssues` | Request allow-list updates, structural incumbent validation, strict new-field validation |
| [verification.ts](../../src/solver/verification.ts) | `verifySolverSolution`, `assertVerifiedSolverSolution` | Reuse independent replay; keep proof and legality separate |
| [protocol.ts](../../src/solver/protocol.ts) | 15 protocol version; 104 `isSolverWorkerCommand`; 136 `isSolverWorkerEvent` | Version decisions and backward-compatible optional request fields |
| [worker-client.ts](../../src/solver/worker-client.ts) | `run`, `#handleProgress`, `#handleResult`, cancellation watchdog | Correlate jobs, retain existing terminal validation, handle any new best-route event safely |
| [sokomind-options.ts](../../src/solver/implementations/sokomind-options.ts) | 6 `SokomindRequestOptions`; 25 defaults; 91 `parseSokomindOptions` vicinity | Preserve explicit controls; document proof options as irrelevant to Quality; add only justified Quality controls |
| [use-solver-progress.ts](../../src/features/solver/use-solver-progress.ts) | 28 `useSolverProgress`; 79 start callback; 94 request construction; 99 proof options | Start/continue behavior, retain verified seed before clearing view state, Quality options and deadline behavior |
| [useSolverController.ts](../../src/features/solver/useSolverController.ts) | 40 `useSolverController`; 91 proof concurrency passed to progress hook | Mode-aware worker policy and continue-solution wiring |
| [SolverDialog.tsx](../../src/features/solver/SolverDialog.tsx) | 248 proof-worker copy; mode selector and primary actions | Describe Quality as improvement-only; show continue action and best-so-far clearly |
| [solver-format.ts](../../src/features/solver/solver-format.ts) | 53 `phaseLabel`; 93 `resultSummary` | Quality phase wording without proof promises; retain Optimal formatting |
| [SolverLabPage.tsx](../../src/features/solver-lab/SolverLabPage.tsx) | 214 recorded proof worker count; 417 proof-worker copy; 594 proof-worker display | Record no proof usage for Quality; expose candidate/operator diagnostics appropriately |
| [solver-lab-model.ts](../../src/features/solver-lab/solver-lab-model.ts) | 4 configuration; 105 `compareSolverLabRuns`; 124–125 proof comparability | Exclude unused Quality proof settings from comparison identity; include seed/configuration identity |
| [personal-best-routes.ts](../../src/shared/personal-best-routes.ts) | 321 `verifyPersonalBestRoute`; 371 `promoteVerifiedPersonalBestRoute`; 439 `loadPersonalBestRoutes` | Reuse only if persisted solver incumbents fit existing semantics; do not mark unplayed solver routes as user achievements |
| [puzzle-revision.ts](../../src/core/puzzle-revision.ts) | 18 `puzzleRevisionFingerprint` | Helpful lookup identity; still compare/replay exact board and snapshot before seed admission |
| [solver-v2-benchmark-lib.ts](../../scripts/solver-v2-benchmark-lib.ts) | 53 schema; 83 production Quality limits; 217 profile; 407 `benchmarkRequest`; `qualifySolvedBenchmark` around 622; 686 `runBenchmarkSample`; 702 incumbent history; 1082 history validation | Quality curves, operator evidence, seed provenance, qualification without requiring in-run proof |

## 4. Target architecture

### 4.1 Keep responsibilities separate

Use the adapter for mode selection and setup. A dedicated Quality coordinator
owns a run-long candidate archive, task queue, budget ledger, and verified
global best. Engine workers execute bounded tasks and publish candidates.
The coordinator alone accepts a global best and decides what runs next.

The current phase runner owns a timer that ends the entire phase and terminates
its workers. That is useful for isolated phases but not sufficient for a
dynamic queue where one task finishes and another should occupy its slot while
other tasks continue. Initially implement a serial scheduler through the
existing phase runner; add task-scoped asynchronous execution before enabling
concurrent repair. Do not build uncontrolled parallelism by calling multiple
`runPhase` instances against the same mutable run budget.

### 4.2 Proposed modules, not existing files

Under the existing solver implementation directory, consider these new files:

| Proposed filename | Responsibility |
|---|---|
| `sokomind-quality-scheduler.ts` | Work selection, fair exploration, deadlines, queue lifecycle, Quality terminal result |
| `sokomind-quality-archive.ts` | Bounded verified candidates, semantic diversity, protected global best, admission/eviction |
| `sokomind-quality-tasks.ts` | Typed tasks, outcomes, exact neighborhood identity, continuation descriptors |
| `sokomind-worker-pool.ts` | Optional later physical-worker reuse; only after task IDs and cleanup are proven |

These names are proposals. Do not create empty abstractions ahead of their
first use. Reuse existing comparator, replay, worker limits and candidate
signature helpers rather than duplicating them.

### 4.3 Suggested internal data model

The following is design pseudocode, not a schema to paste without review:

```ts
type QualityOperator =
  | "normalize" | "window" | "single-box" | "discover"
  | "two-box" | "goal-reassignment" | "perturb-and-repair";

interface CandidateRecord {
  id: string;
  requestIdentity: string;
  routeIdentity: string;
  semanticPushKey: string;
  semanticGoalKey: string;
  verifiedSolution: SolverSolution;
  parentCandidateId?: string;
  sourceTaskId: string;
  acceptedAtMs: number;
  retainedBytes: number;
}

interface QualityTask {
  id: string;
  operator: QualityOperator;
  candidateId?: string;
  neighborhoodKey: string;
  configurationIdentity: string;
  continuationId?: string;
  seed?: number;
  priority: number;
}

type TaskEndReason =
  | "exhausted" | "completed-pass" | "time-cutoff"
  | "expanded-cutoff" | "generated-cutoff" | "memory-cutoff"
  | "cancelled" | "failed";

interface QualityTaskOutcome {
  taskId: string;
  reason: TaskEndReason;
  acceptedCandidateIds: readonly string[];
  expanded: number;
  generated: number;
  elapsedMs: number;
  peakEstimatedBytes: number;
  continuationId?: string;
}
```

Improvement and completion are independent: a task can improve the incumbent
and still end by cutoff. Do not encode them as mutually exclusive statuses.
Likewise, a completed pass may have applied a bounded heuristic or beam and
must not be called exhaustive neighborhood search unless that is actually true.

### 4.4 Coordinator control flow

```text
Validate request and any supplied incumbent.
Initialize shared deadline, work ledger, archive, and task queue.
If already solved, return the legal empty route.
If no incumbent exists, run first-solution discovery within shared limits.
Offer every complete verified candidate to the archive.
Seed normalization, publishing rewrite, and box-repair tasks.

While shared limits allow useful work:
    Retire completed tasks and update outcomes/accounting.
    Accept and replay bounded candidate publications.
    Update protected global best and queue consequences of new candidates.
    Generate diverse tasks when current neighborhoods have stalled.
    Select eligible tasks fairly and reserve disjoint work/memory grants.
    Dispatch/resume tasks in available slots.
    Stop a task at its own deadline without erasing other tasks' progress.

Stop/clean up workers and return the already verified global best.
Never dispatch global proof work from this coordinator.
```

## 5. Work package A: remove Quality proof paths

### 5.1 Required edits

1. In `qualityAnytimeImprove`, replace the final `runProof` call at line 644
   with a Quality terminal result using the protected best and aggregate metrics.
   This is the first functional change, not the complete scheduler redesign.
2. In `createSokomindSolverAdapter`, inspect the fallback block around line
   663. Its condition is currently non-Fast, so Quality also calls proof after
   greedy fallback. Optimal may retain proof; Quality must route the verified
   fallback incumbent into improvement when budget remains.
3. Handle fallback accounting carefully. `runClassicFallback` returns merged
   metrics, but the run's worker ledger was not populated by that greedy search.
   If improvement continues afterward, add a dedicated completed-work baseline
   or import that work exactly once before `withRemainingLimits`. Otherwise the
   scheduler could forget fallback work or double-count the legacy portion.
4. Audit all indirect paths through `solvedWithImprovement` and
   `improveByMode`. Keep mode dispatch explicit and avoid a generic non-Fast
   branch for proof. The unreachable `harvestAndImprove` fallthrough has been
   removed; an unknown mode now throws.
5. Preserve `optimalQuickImprove`, classic A*/IDA*, certificate validation, and
   proof persistence behavior. Do not remove proof APIs just because Quality
   no longer calls them.
6. Make a Quality terminal result structurally consistent: solved route,
   `optimality: "unknown"`, no invented lower bound or proof envelope. A supplied
   route that came from Optimal can be used for quality, but Quality itself
   should not claim to have produced its certificate.
7. Update mode descriptions and tests in the same implementation change.

### 5.2 Explicit option policy

For compatibility, it is reasonable to continue parsing valid existing
`proofAlgorithm` and `proofParallelism` options while documenting that they
have no effect in Quality. The UI should stop sending/displaying them for
Quality. Do not represent disabled proof as `proofParallelism: 0` unless its
validator is deliberately redesigned: the current accepted minimum is one.
An omitted proof option is sufficient; routing determines whether proof runs.

### 5.3 Tests and acceptance

- Inject a proof-worker factory that throws if called; exercise Quality after
  ordinary discovery, structural discovery, rescheduling, and greedy fallback.
- Assert no `proving` progress, no proof result, and unknown optimality.
- Assert Optimal still invokes proof and retains known-optimum regression behavior.
- Cover already-solved snapshots, no solution found, deadline before first
  incumbent, and cancellation.
- Update `sokomind-modes.test.ts:191`: a direct proof test labeled Quality should
  become an Optimal/proof-kernel test, not be mistaken for the production
  Quality routing test.
- Review `sokomind-solver.test.ts:562–616`, where assertions/comments currently
  allow subsequent exact proof to improve the tiny repair fixture.

## 6. Work package B: publish every useful complete improvement

### 6.1 Engine publication points

In `solutionWindowRewriteSearch`, publish after a complete route has been
validated and adopted at these sites:

- Canonicalization: line 4399, only when it actually improves the route.
- Push permutation: line 4453.
- Push-window replacement: line 4518.
- Move-window replacement: line 4607.

Publish the **full solution from the request's start**, not the local bridge
segment. Every local substitution must still replay successfully and solve the
puzzle before publication. For tasks deliberately based on a continuation
state, the coordinator must prepend the verified prefix exactly as it already
does for terminal paths, then replay against the original request.

Factor an engine-side publication helper so path, cumulative work, retained
memory, task identity, and optional operator metadata follow one convention.
Avoid a helper that calls a large replay repeatedly when validated details are
already available inside the worker; the coordinator's independent replay
still remains mandatory.

### 6.2 Coordinator changes are essential

`startPlan` currently accepts `progress.path` only when the algorithm equals
`solution-box-reschedule` at line 522. Merely adding `postMessage` in the
rewrite function will therefore not fix the bug. Extend the gate to explicitly
supported full-solution publishers, or introduce a typed complete-candidate
event whose semantics are clear. Do not treat arbitrary partial discovery
paths as solutions.

Reuse `acceptPath` for pre/post replay limit checks. Initially preserve
`publishedSolution` as a protected best so a small first patch is reviewable.
Then connect accepted publications to the archive in work package D.

The terminal `finish` method already selects a better published route over a
worse terminal route. Preserve that behavior and test the orderings explicitly.
Candidate publication must not implicitly finish an ongoing repair task.

### 6.3 Throughput and memory bounds

Streaming every update can overload structured cloning, message queues, replay,
or route storage. Apply bounded buffering and publication policy:

- Always preserve the newest best candidate pending delivery.
- Allow a bounded number of semantically distinct intermediate candidates;
  do not coalesce every publication to only the shortest route.
- Deduplicate exact route identities before replay when safe, without trusting
  an unverified sender's quality claim.
- Bound queued route bytes and number of unverified candidates.
- Flush useful pending candidates before a cooperative yield or terminal result.
- Record candidates dropped/coalesced by reason so diversity loss is visible.
- Keep worker and coordinator verification time inside shared time accounting.

Initial serial implementation can use a small bounded publication queue. Add
acknowledgements/backpressure before a multi-worker portfolio can flood it.

### 6.4 Required regressions

Use a small synthetic board for stable unit tests, plus the real Grand Hall
trace as an integration fixture:

1. Worker publishes a valid improvement, then never sends a terminal result:
   phase timeout retains the improvement.
2. Worker publishes multiple improvements and returns a worse terminal route:
   best accepted route survives.
3. Invalid, partial, wrong-prefix, and late paths are rejected.
4. A candidate received before the deadline but finishing replay after it is
   rejected under the existing conservative deadline contract.
5. Repeated identical publications do not grow retained memory indefinitely.
6. Cancellation still returns the appropriate cancellation status.
7. Grand Hall instrumented trace can be replayed as events without timing-based
   assertions that the 916 seed must appear at exactly 450 ms.

## 7. Work package C: task outcomes, accounting, and continuation

### 7.1 Distinguish progress from task completion

Extend `ImprovedIncumbent` and `PhaseOutcome` with enough information to tell
whether the underlying neighborhood finished. The current improved/cancelled
booleans lose this information. A phase timeout, worker silence, exhausted
frontier, completed bounded pass, and explicit shared-limit cutoff are not
interchangeable.

For box repair, report which physical box was attempted, its target assignment,
whether the search completed, and the next unvisited box/round. The current
`budgetExhausted` flag is useful but is not a sufficient continuation schema.
For windows, report stage, window size, start/end position or exact boundary
identities, configuration, and whether an interrupted inner search remains.

### 7.2 Stable identity for completed work

A task's cache key should include:

- Exact request/board/snapshot identity and engine/checkpoint revision.
- Candidate route identity or a proven equivalent neighborhood identity.
- Operator and every setting that affects available transitions or pruning.
- Selected physical boxes, goal assignment, fixed-event constraints, or window
  boundary identities as applicable.
- Seed when it changes the explored search order/neighborhood.

A task ID or `candidateIndex` by itself is not a new neighborhood. Do not mark
a timed-out task exhausted. If a task uses beam/frontier truncation, distinguish
completed configured search from exhaustive search over the unrestricted
neighborhood.

### 7.3 Resume in two increments

**Cursor continuation first:** save the next untouched box/window and enough
configuration to avoid repeating completed tasks. If interrupted halfway
through an inner search, mark it incomplete and schedule it with a larger
grant or keep it eligible. A cursor alone does not resume its frontier.

**Frontier continuation second:** retain heap, dominance table, parent arena,
scratch ownership and exact bounds for expensive interrupted searches. Prefer
keeping these in the same worker while it is paused. Serialization should be
bounded, validated and revisioned if moving work between workers is justified.

For a changed candidate, discard stale checkpoints unless equivalence has been
explicitly established. Never reuse a dominance table across a changed fixed
push chain or changed target assignment.

### 7.4 Correct cumulative telemetry

Nested bridge searches publish local `visited` values. `updateTelemetry` takes
the maximum, which cannot reconstruct the sum across multiple windows. Build
an outer cumulative counter that includes completed subsearch work plus current
subsearch work. Include generated states, not only expanded states.

Give each physical worker a logical task ID and sequence number so reused
worker counters can reset per task without making run totals decrease or
double-count. Ignore stale messages after task completion. Explicitly report
current retained memory dropping when a frontier is released.

Coordinator progress should report the global best rather than temporarily
showing the longer candidate an individual worker happens to be exploring.
Separate task-local quality from accepted-best quality in diagnostics.

### 7.5 Work and memory grants

Keep three independent concepts:

| Concept | Meaning | Release policy |
|---|---|---|
| Request work allowance | Maximum total expanded/generated work explicitly requested | Consumed work never becomes available again |
| Task work grant | A reserved share of remaining request work | Return confirmed unused work when safe |
| Live memory reservation | Space for active task state and retained run data | Release only after the state is actually released or conservatively accounted for |

For parallel tasks, outstanding grants plus consumed work must not exceed the
request allowance. On a hard-killed worker with incomplete counters, do not
assume unreported work was unused; conservatively charge its grant or use a
validated shared accounting mechanism. Improve cooperative completion so this
conservative rule does not waste most of the budget.

`BudgetTracker.resetPhase` currently clears coordinator memory. Archive and
checkpoint allocations must live outside that phase-reset bucket, or be
re-added with an explicit invariant. Invalidate aggregate caches on every
archive admission/eviction, reservation change, task start/finish, and geometry
ownership change.

### 7.6 Tests

- Two unchanged completed box sweeps are recognized as the same work.
- Time cutoff remains resumable; exhausted work remains skipped.
- A new candidate creates the appropriate newly eligible tasks.
- Work counters remain monotonic across three nested windows and worker reuse.
- Two concurrent tasks cannot both receive the full remaining state allowance.
- Killed, failed and late-reporting tasks cannot restore already consumed work.
- Archive/checkpoint memory survives phase resets and is released on disposal.
- Unlimited-time requests still respect explicit state and memory limits.

## 8. Work package D: diverse candidate archive

### 8.1 Reuse and extend existing semantics

Reuse `isSolutionBetter`, `semanticDiversityTrace` and collision-resolved
signature keys. The existing `IncumbentCollector.offer` replaces same-semantic
routes when they improve, which is valuable. Its full-archive eviction policy
primarily compares move count, however; a new archive needs to protect useful
novelty instead of discarding every longer route.

Start with a deterministic admission policy. A candidate is eligible if it is
verified and either improves the global best, improves the representation of
an existing semantic plan, introduces a distinct goal assignment, or introduces
a sufficiently different push order under available capacity.

Use a declared candidate-count ceiling and a retained-byte ceiling. The
existing maximum-incumbents option may be reused if its meaning is explicitly
expanded; do not silently turn a discovery-only setting into a large unbounded
run-long store. Initial candidate counts are tuning parameters to measure,
not promises that every machine should retain eight large route histories.

### 8.2 Separate global best from archive eviction

The global best must remain retained even if archive policy would otherwise
evict its record. Active tasks pin the candidate data/checkpoints they require.
Count pinned data in the archive memory budget. On memory pressure, evict
inactive redundant candidates and resumable caches before risking the only
verified best route.

Keep quality comparison deterministic: moves, then pushes, then a stable tie
break. Archive novelty may have a separate score. Do not overload the public
solution comparator with novelty or speculative repair potential.

### 8.3 Parentage and neighborhood history

Every accepted candidate records its source operator, parent route, task ID,
configuration and acceptance time. Associate completed task records with exact
candidate identities. A window improvement may make box repair productive
again; invalidate/rebuild the relevant candidate-specific schedule rather than
leaving a global `stalls.box` count at its previous value.

Store routes compactly as canonical direction sequences where practical;
materialize full `SolutionStep` arrays only when required by an API. Account
for both representations while they coexist. Do not introduce compressed
identity shortcuts that can confuse physical box traces.

### 8.4 Selection and eviction policy to implement first

1. Protect the global best and active task inputs.
2. Prefer a shorter route within the same exact semantic plan.
3. Retain representative goal assignments before filling all slots with one
   assignment's slightly different walk realizations.
4. Within an assignment, prefer genuinely different push chains.
5. Evict inactive redundant representatives using deterministic tie breaks.
6. Admit longer novel candidates within measured bounds rather than relying on
   a hard unqualified move-ratio threshold that could discard the winning seed.
7. Expose admission, duplicate, novelty and memory-pressure rejection counts.

### 8.5 Tests

- In an event sequence containing the observed 952/932/916/890/852 candidates,
  the archive keeps more than just the shortest candidate under a declared
  capacity. Use verified semantic traces, not move counts alone.
- A synthetic longer-seed/better-descendant case drives scheduler coverage.
- A full archive can accept a useful longer but novel route.
- Same-semantic shorter routes replace weaker representatives.
- Hash collisions cannot merge distinct canonical plans.
- Eviction cannot worsen the protected global best or break an active task.
- Archive byte limits include pinned inputs and queued candidate publications.

Do not write a production rule to always preserve the 916 seed. The real
fixture is evidence for diversity, not an algorithm identifier.

## 9. Work package E: adaptive scheduling and parallel repair

### 9.1 Initial serial policy

Implement a transparent serial scheduler before a learned or complicated
priority formula. Suggested sequence after first incumbent:

1. Cheap loop removal/walk normalization.
2. Short local-window task that publishes complete improvements.
3. Single-box repair of the protected best and a bounded selection of diverse
   intermediate candidates.
4. Continue productive tasks and explore untried archive candidates.
5. Interleave new discovery/perturbation when candidates converge.
6. Increase neighborhood complexity only under remaining resource grants.

The initial policy should be based on stable work chunks and measured minimum
useful durations, not simply percentages of the requested total time. Choose
initial constants from baseline measurements and record them in benchmark
configuration fingerprints. Do not promote the audit's normalization-only
rewrite treatment as a universal default.

### 9.2 Fair exploration with bounded overhead

Track for each operator/candidate class: time, expansions, generated states,
memory peak, completed neighborhoods, cutoffs, novel verified descendants and
best-route improvements. Initially use a deterministic weighted round-robin
or priority queue with explicit exploration reservations and ageing.

Measured moves saved per millisecond can guide exploitation, but cannot be the
only score: it penalizes tasks that unlock a good descendant later. Credit
useful descendants to their ancestry in diagnostics, and keep untried novel
candidates eligible even when they have zero immediate reward.

Do not promise to exhaust every avenue in a finite budget. The requirement is
fair opportunity and visible reasons for skipped/deferred work, with explicit
user-disabled operators remaining disabled.

### 9.3 Prevent repeated and starved work

- Never dispatch the same exhausted neighborhood on the same candidate and
  configuration merely to reach a stall count.
- Do not restart a timed-out early window three times with identical limits.
- Age waiting candidates so a single productive family cannot monopolize all
  lanes indefinitely.
- When new routes arrive, leave active tasks on their own valid input unless
  their remaining value is clearly lower than alternatives. Restarting every
  task on every new global best causes thrashing.
- If an unchanged task keeps hitting memory, reduce its scope or select another
  avenue; a longer wall-clock grant alone will not help.

### 9.4 Parallel portfolio

Run independent full-route repairs on different candidates or selected
neighborhoods. Each task returns a complete replayable candidate. Never splice
two independently improved paths together without rebuilding and replaying
the resulting route.

Allocate disjoint work and memory grants before dispatch. Worker limits are
ceilings, not a requirement to occupy all CPUs. Use a ready queue so completing
one task releases its slot without waiting for a whole `Promise.all` wave.
Reserve coordinator headroom and prevent archive verification from being
starved by too many worker messages.

Keep deterministic mode serial initially, with deterministic task ordering and
seed derivation. Nondeterministic parallel runs need repeat distributions, not
assertions of byte-identical routes.

### 9.5 Deadline and extension semantics

Distinguish three guarantees:

| Scenario | Required guarantee |
|---|---|
| One running search | Accepted best never worsens |
| Continue a completed search with its validated route/archive | Previously best route is retained and usable work continues |
| Two independent fresh runs with different deadlines | Stable early policy and statistical improvement targets; no unconditional identical-prefix guarantee under wall-clock races |

An eventual extend-running-budget operation would need a separately specified
deadline-update protocol. Initial scope is a new Quality request supplied with
a verified incumbent, optionally plus an in-memory validated continuation.

## 10. Work package F: continue from an existing solution

### 10.1 API design decision

Prefer a typed optional initial-incumbent input over burying an arbitrary
route inside untyped tuning JSON. One reasonable design is an optional
`initialSolution` on `SolverRequest`; another is an explicitly typed
Sokomind-specific request extension. Choose one and update every validator.
The present request validator uses an exact key allow-list at line 40, so
adding a field only to the TypeScript interface will fail at runtime.

Validate structure first, then replay against the exact requested board and
snapshot. Recompute counts and step kinds. Ignore claimed optimality and do
not trust only a puzzle ID, a hash, or saved move count.

Initially reject an invalid explicitly supplied incumbent with a clear error;
do not silently present it as accepted. A missing automatically loaded saved
route can simply fall back to normal discovery after reporting a diagnostic.

### 10.2 Snapshot compatibility

A route from the initial puzzle position is not generally a solution from the
current partially played board. A suffix is reusable only after replaying the
prefix to confirm it matches the exact current state; a coincidental action
count or puzzle ID is insufficient. Otherwise ignore it for seeding that
snapshot or offer to solve from the initial board through an existing explicit
UI action.

Request identity should include canonical board content and relevant snapshot
state. Puzzle revision fingerprints are a lookup aid, not a replacement for
replay. Keep counters and objective semantics aligned with the current
snapshot: solution moves are additional moves from that snapshot.

### 10.3 UI and persistence boundaries

Retain the previous verified route before `resetRunState` clears result
presentation. Add a clearly labeled continue/improve action, and display the
starting incumbent so users know the next run is preserving it.

Start with an in-memory per-request seed cache. Persistent route/archive
storage is a later step if needed. Existing personal-best storage represents
user progress: do not save an automatically discovered solver route as a played
completion or award an achievement. If its repository cannot represent solver
incumbents without changing those semantics, use a separate bounded solver
incumbent repository with the same reset-generation fencing principles.

Check protocol versioning for cross-version worker/service-worker assets if a
public field or event becomes incompatible. Optional data additions still need
explicit validator support and compatibility tests.

### 10.4 Tests

- Valid 482-move seed survives an otherwise unproductive request.
- A shorter verified descendant replaces it; a longer one may enter the
  archive but cannot become the result.
- Wrong board, changed puzzle revision, wrong snapshot, illegal move, wrong
  counters, excessive route length and malformed steps are rejected.
- Reopening a puzzle or resetting progress cannot resurrect an incompatible
  seed. No optimality certificate is inferred from a saved route.
- Verification itself obeys time/input-size bounds and cancellation policy.

## 11. Work package G: broader repair neighborhoods

These operators are subsequent experiments, disabled by default until
qualification. The initial scheduler must already support operator registration,
grants, complete candidate replay, provenance and explicit cutoff outcomes.

### 11.1 Joint two-box repair

Generalize the restricted fixed-order repair concept: free two selected
physical boxes while preserving the other boxes' ordered push events. State
must include fixed-event phase, both selected positions, exact robot position,
cost, and reconstruction data. Prevent collisions between selected boxes and
fixed occupancy. Preserve typed goal legality and repeated-label identities.

Start with fixed final targets. Add goal reassignment separately. Rank pairs
using observed interference, intersecting transport paths, repeated temporary
displacements, shared bottlenecks and keeper travel. Do not blindly enumerate
every pair with the full budget.

Use admissible bounds only when making exhaustive restricted-optimum claims.
For Quality-only heuristic/beam variants, label the outcome as completed
bounded search, preserve every legal incumbent, and never export it as a
global certificate. Tiny independent primitive-move oracles should check the
restricted constraints and completeness of any exact variant.

### 11.2 Same-label goal reassignment

Repeated X boxes can finish on interchangeable S goals, but changing one box's
target in isolation may conflict with the box already assigned there. Represent
the assignment change jointly and ensure goals remain one-to-one. Preserve
all typed-label restrictions.

Begin with bounded pairwise swaps or a small selected same-label group.
Explicitly include assignment identity in task/checkpoint keys. Validate final
solutions through the canonical core, not just through assignment feasibility.

### 11.3 Dependency-based windows

Use push-event traces to choose a segment containing an interaction, including
necessary support and clearance events. Existing fixed sizes and endpoint
constraints may omit the move needed to escape a local minimum.

Vary selected segment, allowed boxes, push slack and endpoint flexibility as
separate experiments. Keep prefix and suffix compatibility exact. If endpoint
flexibility changes the suffix state, replan/verify the affected suffix instead
of appending the old suffix blindly.

### 11.4 Perturb and repair

Permit a bounded, verified working candidate that is temporarily longer than
the global best. Follow it with repair and retain useful descendants. Cap
perturbation depth, archive occupancy and work share; avoid random wandering
that crowds out productive tasks.

Derive reproducible seeds and record them. A stochastic task must be
reproducible from request, configuration and seed for diagnosis, even when its
wall-clock cutoff is not deterministic.

### 11.5 Alternative discovery and existing tuning

Existing controls such as `moveAwareDiscovery`, `firstPushWalkWeight`, and
`macroIntermediateQuota` should become explicit, measured discovery avenues
only when enabled. Preserve explicit zero/false strategic controls. Confirm
effective settings and exercise counters before attributing a gain to them.

Do not reactivate previously rejected broad beam widening or aggressive
strategic execution without a new controlled experiment and holdout evidence.

## 12. Work package H: computation and memory efficiency

### 12.1 Measure the right quantities first

Separate worker startup, module load, preparation, route replay, serialization,
queue wait, search CPU/wall time and cleanup. Record candidate verification
backlog and bytes, not only worker heap estimates. Record process/browser
memory independently from internal estimates and explain their different scope.

Source review shows opportunities; it does not establish their exact speedup.
Keep an unmodified control and run one optimization at a time.

### 12.2 Reusable workers

The current `startPlan` creates a worker and `cleanupWorker` terminates it for
each plan. Introduce pooling after task IDs and task-scoped lifecycle exist.
Reset mutable frontier, dominance, random seed, budget, progress offsets,
listeners and cancellation state between tasks. Cache only correctly keyed
immutable geometry or deliberately bounded reusable tables.

Ignore late events from previous task IDs. A failed worker is retired, not
returned to the pool. A timeout of a synchronous non-yielding search requires
termination unless the engine gains cooperative interruption. Merely keeping
the Worker object alive cannot make a synchronous search process queued cancel
messages. Account for workers being terminated until their release is known
or covered by a conservative overlap reserve.

Pool tests must cover failed startup, message errors, stale completion,
cancel-and-reuse, partial preparation, and reset/dispose. Include Node shutdown
stress tests separately from performance timings.

### 12.3 Geometry and cache reuse

`solutionWindowRewriteSearch` calls `prepareSearchBoard(payload, false)`,
explicitly reparsing. Investigate why the mutable cache boundary was chosen
before removing it. Split immutable topology/distance data from task-local
mutable caches, then reuse immutable data with exact board-content keys.

Shared or transferred buffers need clear ownership. Do not transfer a buffer
still used by another task. Shared mutable caches require concurrency design;
copying immutable typed arrays may be preferable before introducing shared
memory. Include clone/reservation overhead in memory grants.

### 12.4 Flood and search-node allocation

`fixedOrderBoxReschedule.walk` creates new distance and queue arrays per flood.
Reuse per-task scratch buffers or generation-stamped arrays, with separate
ownership for concurrently live searches and path reconstruction. Check wrap
handling for stamps and ensure a reconstruction pass cannot overwrite distances
still needed by the search.

Consider compact arena indices and a numeric heap instead of object parent
chains when profiles show allocation/GC pressure. Keep exact identities and
collision checks. A dense best-cost table is not automatically cheaper: compute
the full phase-by-box-by-robot domain before allocating it, especially for
two-box repair. A sparse map may be preferable under tighter limits.

### 12.5 Memory pressure policy

1. Preserve the already verified global best.
2. Stop admitting low-value candidate/continuation data.
3. Evict inactive redundant archive entries and disposable caches.
4. Reduce parallel occupancy or choose smaller neighborhoods.
5. Cooperatively stop the responsible task when its grant is exhausted.
6. Stop the run if the explicit request-wide memory contract requires it.

Never claim the 500,000 expansion cap was live memory enforcement. Conversely,
removing it does not remove the need for real memory checks before large
allocations and during cache growth.

## 13. UI, protocol, and documentation integration

### 13.1 Mode behavior visible to the user

Quality descriptions should say it searches for shorter verified routes for
the selected time. Remove proof-worker wording for Quality in both dialog and
Solver Lab. Keep that wording for Optimal. A separate classic exact solver
selection still has its own behavior; do not change all solver descriptions
globally based only on the Sokomind mode selector.

Display global best moves/pushes and meaningful activity such as refining a
candidate, exploring an alternative plan, or repairing an interacting pair.
Keep task counts and detailed efficiency diagnostics in Solver Lab rather
than flooding the ordinary dialog.

Never label the 476 result optimal or imply that 30 seconds certifies it.
An optional lower bound previously obtained from a legitimate independent
proof may be displayed as such, but Quality does not generate a new proof
envelope or quietly launch proof work to improve that display.

### 13.2 Benchmark comparability

Quality run identity should include relevant search/worker/archive settings,
seeded versus unseeded status, initial route identity and applicable operator
flags. Exclude unused proof-worker settings from Quality comparisons. Update
`compareSolverLabRuns` and benchmark configuration fingerprints together.

The existing production target says within 10% of move optimum. For fixtures
with a frozen independently established optimum, continue checking that ratio.
For Grand Hall, 476 is a best-known audit route, not a proven optimum. Report
distance from a best-known reference separately and label within-10%-of-optimum
qualification unavailable when no adequate independent bound exists. Do not
weaken the benchmark by treating a reference route as mathematical truth.

`qualifySolvedBenchmark` currently permits in-run compatible bounds for unknown
fixtures. Removing Quality proof means that route-quality measurements and
formal target qualification must be represented separately, rather than
mislabeling every legal unknown-optimum run as solver failure or success at
the 10% target.

### 13.3 Documentation changes when implementation lands

Update these owners in the relevant implementation batch:

- [Solver status](../solver-status.md): shipped mode behavior and safeguards.
- [Solver integration](../solver-integration.md): task protocol and lifecycle.
- [Solver benchmarks](../solver-benchmarks.md): controlled comparisons and limits.
- [Project reference](../PROJECT-REFERENCE.md): ownership and generated facts.
- [Solver plan](solver.md): remaining work and superseded design assumptions.
- [Solver Lab](../solver-lab.md): mode descriptions and diagnostics.
- [Performance roadmap](../SOLVER-PERFORMANCE-ROADMAP-2026-09-16.md): reconcile
  old Quality-to-proof scheduling and qualification claims.

Do not rewrite current-behavior guides as if this plan had already shipped.
Regenerate source-derived reference facts when versions or contracts change.
Only bump proof-cache provenance if proof-producing semantics actually change;
this Quality-only redesign should not arbitrarily invalidate valid proofs.

## 14. Testing and qualification

### 14.1 Existing test ownership

| Test file | Extend or preserve |
|---|---|
| [sokomind-solver.test.ts](../../tests/unit/sokomind-solver.test.ts) | Mode routing, fake-worker events, publication retention, fallback, bounded repair |
| [sokomind-modes.test.ts](../../tests/unit/sokomind-modes.test.ts) | Option parsing, Quality no-proof contract, retained Optimal proof tests |
| [sokomind-incumbents.test.ts](../../tests/unit/sokomind-incumbents.test.ts) | Semantic diversity, comparator, duplicate replacement, archive integration |
| [sokomind-integration-budgets.test.ts](../../tests/unit/sokomind-integration-budgets.test.ts) | Explicit overrides, cumulative limits, new grant accounting |
| [box-rescheduling.test.ts](../../tests/unit/box-rescheduling.test.ts) | Independent restricted-search oracle, identity and fixed-chain invariants |
| [sokomind-engine-protocol.test.ts](../../tests/unit/sokomind-engine-protocol.test.ts) | New task/outcome/candidate field validation |
| [budget-tracker.test.ts](../../tests/unit/budget-tracker.test.ts) | Persistent memory, reservation release, hard-kill accounting |
| [worker-registry.test.ts](../../tests/unit/worker-registry.test.ts) | Task identity distinct from worker identity |
| [solver-validation.test.ts](../../tests/unit/solver-validation.test.ts) | Typed initial incumbent and exact request key contract |
| [solver-worker-runtime.test.ts](../../tests/unit/solver-worker-runtime.test.ts) | Worker protocol, cancellation and result verification |
| [solver-lab-model.test.ts](../../tests/unit/solver-lab-model.test.ts) | Seeded comparisons and mode-specific proof configuration |
| [solver-v2-benchmark.test.ts](../../tests/unit/solver-v2-benchmark.test.ts) | Quality curves, qualification availability, provenance and schema checks |
| [node-runner.test.ts](../../tests/unit/node-runner.test.ts) | Node worker compatibility and lifecycle |
| [solver.spec.ts](../../tests/e2e/solver.spec.ts) | Quality options, progress, continue action, no proof UI; current line 162 expects Quality proof parallelism |
| [solver-lab.spec.ts](../../tests/e2e/solver-lab.spec.ts) | Archive/operator display and comparison controls |
| [solver-determinism.spec.ts](../../tests/e2e/solver-determinism.spec.ts) | Deterministic serial behavior under fixed configuration |
| [strategic-analyzer.spec.ts](../../tests/e2e/strategic-analyzer.spec.ts) | Existing public Grand Hall quality gate and isolated repair fixtures |

Proposed new unit files, created only with their implementation: a Quality
scheduler test, candidate archive test, continuation test, and worker-pool
test. Keep fast fake-clock scheduling tests separate from real timing gates.

### 14.2 Required acceptance matrix

| Area | Must demonstrate |
|---|---|
| Mode separation | No Quality proof dispatch on any path; Optimal proof regressions remain valid |
| Publication | Complete valid improvements survive later timeout/failure; partial/late paths do not |
| Best preservation | No accepted-best regression; valid starting incumbent preserved |
| Diversity | Longer novel seeds receive bounded opportunity and can produce accepted descendants |
| Reuse | Exhausted unchanged neighborhoods skipped; incomplete tasks resume or get intentional new grants |
| Fairness | Untried eligible tasks eventually receive work under a sufficient synthetic budget |
| Accounting | Cumulative work monotonic; outstanding grants disjoint; no released memory counted twice |
| Deadlines | Late candidates rejected; cleanup/verification included; no fake timer precision claims |
| Cancellation | No stale workers, dangling queued candidates, or invalid reuse after cancellation |
| Legality | Every returned route independently replayed, including seeded and transformed boards |
| Regression scope | Fast and Optimal retain their contracts and existing quality/proof guardrails |

### 14.3 Benchmark design

Run fresh-from-board and seeded continuation as separate experiment classes.
Record curves at 5, 10, 15, 30 and 60 seconds, and optionally longer budgets
when evaluating new neighborhoods. Do not compare a seed-assisted run against
an unseeded baseline without labeling the additional input.

Include Grand Hall base/mirror/rotation, typed and repeated-label puzzles,
corridors, open rooms, small known-optimum boards, difficult unsolved-within-
budget boards, and an explicit holdout set not used for tuning. Existing
solver fixtures/corpora should be reused where possible.

For exploratory comparisons, use the existing five timed-run convention;
for default promotion, follow the existing plan's 10+ cold/warm browser
repetitions and all supported browser projects. Define machine, power/load
conditions, runtime, worker ceiling, memory limit, source revision, exact
configuration and random seed. Do not overlap benchmark runs with coverage,
builds or other heavy solver runs.

Report:

- Solution success fraction, time to first verified route, and time to declared
  quality thresholds.
- Median and tail latency, best/worst move counts, and distribution across seeds.
- Best verified moves over time and area under the quality curve only with a
  declared treatment of time before first solution.
- Quality at fixed deadlines, not merely the best result from any repetition.
- Per-operator CPU/wall time, work, memory, improvements and useful descendants.
- Archive diversity, evictions, candidate replay cost and publication drops.
- Duplicate exhausted work and restarted-but-unfinished work.
- Worker occupancy, startup/preparation cost and useful search fraction.
- Internal memory estimates versus separately sampled process/browser memory.
- Outcome/cutoff reasons and budget compliance.

A longer **continued** run must preserve the prior best. Independent
wall-clock runs need distribution-based comparisons; occasional different
results do not by themselves prove best-result regression within one run.

### 14.4 Staged commands

For engine source changes, regenerate before tests:

```powershell
npm.cmd run prepare:sokomind-solver
npm.cmd run check:sokomind-solver
npm.cmd run typecheck
node --experimental-strip-types --test tests/unit/sokomind-solver.test.ts tests/unit/sokomind-modes.test.ts tests/unit/sokomind-incumbents.test.ts tests/unit/sokomind-integration-budgets.test.ts tests/unit/box-rescheduling.test.ts tests/unit/sokomind-engine-protocol.test.ts
```

For a completed implementation batch, follow the project's broader gates:

```powershell
npm.cmd run lint
npm.cmd run test:unit
npm.cmd run build
npm.cmd run test:static
npm.cmd run test:coverage
npm.cmd run test:solver:oracle
npm.cmd run test:solver:proof-regressions
npm.cmd run test:solver:multi
npm.cmd run test:solver:huge
npm.cmd run test:browser:dist
npm.cmd run lint:docs
```

Run the browser suite against the fresh build. Do not repeatedly rerun the
entire ladder after a documentation-only correction. Run additional checks
when implementation changes, failures or unresolved risks justify them.
Benchmark CLI options should be checked against the current parser rather than
inventing flags; extend the harness deliberately for new matrix dimensions.

## 15. Delivery sequence and completion checklist

Each batch should be independently reviewable. Update this checklist with
measured evidence as work lands; do not mark an experiment promoted just
because its unit tests pass.

### Batch 0: establish reproducible fixtures and baseline

- [ ] Promote relevant audit routes/events into bounded, versioned test or
  benchmark fixtures during implementation; ignored local artifacts must not
  become hidden prerequisites.
- [ ] Replay user 482, audit 476 and intermediate 916 routes against the pinned
  board; save provenance and unknown-optimality labels.
- [ ] Capture unmodified baseline quality curves on the declared corpus.
- [ ] Record source/runtime/configuration fingerprints and resource limits.

### Batch 1: mode contract and lost-candidate fix

- [ ] Remove Quality proof on normal and greedy-fallback paths.
- [ ] Publish complete rewrite improvements and accept them at the coordinator.
- [ ] Preserve deadline/replay checks and best-on-timeout behavior.
- [ ] Update dialog/Lab mode wording and mode-specific option expectations.
- [ ] Pass targeted mode/publication/proof-preservation tests.

### Batch 2: trustworthy tasks and bounded archive

- [ ] Add task outcomes and cumulative nested-search counters.
- [ ] Add bounded verified archive, provenance and protected global best.
- [ ] Scope exhaustion/history to exact candidate neighborhoods.
- [ ] Remove redundant completed sweeps.
- [ ] Include archive/checkpoint memory in run accounting.
- [ ] Add cursor continuation for untouched neighborhoods.

### Batch 3: serial anytime scheduler and incumbent continuation

- [ ] Replace the fixed Quality loop with a fair task queue.
- [ ] Remove the memory-derived cumulative improvement stop condition.
- [ ] Keep explicit request limits and per-task limits enforced.
- [ ] Make early repair scheduling stable across total time allowances.
- [ ] Add typed replay-validated starting incumbent and continue UI.
- [ ] Measure fresh versus seeded behavior separately.

### Batch 4: parallel task execution and worker reuse

- [ ] Implement disjoint work/memory grants and task-scoped completion.
- [ ] Run independent candidate repairs without a whole-wave barrier.
- [ ] Add persistent workers only with reset/cancellation/stale-event tests.
- [ ] Add frontier continuation where its measured value exceeds retention cost.
- [ ] Profile and reduce preparation, flood and node-allocation overhead.
- [ ] Qualify throughput and memory across worker ceilings.

### Batch 5: stronger neighborhoods and default qualification

- [ ] Add bounded joint-box, goal-assignment and dependency-window experiments.
- [ ] Add bounded perturb-and-repair and alternative discovery where justified.
- [ ] Verify independent-oracle correctness on small restricted cases.
- [ ] Run holdout/cold/warm/browser qualification for each proposed default.
- [ ] Publish quality curves and retain rejected treatments as controls.
- [ ] Consolidate shipped behavior in the owning guides and remove completed
  plan detail only after useful evidence is preserved.

The first functional changes should be mode separation and complete-candidate
publication. Do not block those confirmed fixes on inventing a sophisticated
adaptive scheduler. Conversely, do not call the Quality redesign complete
after only deleting the proof call: that would leave lost routes, repeated work
and the single-candidate quality ceiling in place.

## 16. Risk register and implementation pitfalls

| Risk | Prevention or check |
|---|---|
| Quality still proves through fallback | Test every adapter completion path with a throwing proof factory |
| Publication fixed in engine but ignored by coordinator | Update the algorithm-specific progress gate and test real messages |
| Partial bridge path treated as whole solution | Typed candidate semantics, prefix reconstruction and canonical replay |
| Every intermediate route floods memory | Bounded queues, archive byte limits, semantic selection and backpressure |
| Only shortest candidate retained | Distinct archive policy; synthetic longer-seed/better-descendant regression |
| Timeout mislabeled exhaustion | Explicit outcome reasons and checkpoint validity tests |
| Global stall counters block useful repair of a new route | Candidate/neighborhood-specific task history |
| Same task runs repeatedly under different IDs | Exact neighborhood identity independent of execution ID |
| Worker reuse accepts stale results | Request/task generation IDs and strict dispatch ownership |
| Parallel phases over-allocate the same remaining budget | One run-owned reservation ledger before dispatch |
| Hard-killed work disappears from totals | Cooperative reports plus conservative charging of unresolved grants |
| Phase reset forgets archive/checkpoint memory | Separate persistent and phase-local accounting buckets |
| Fallback metrics counted twice or omitted | Explicit completed-work import/baseline when reentering improvement |
| Saved route used from wrong snapshot | Exact request binding and replay, not puzzle ID alone |
| Better solver route recorded as player achievement | Separate solver-incumbent semantics from user progress |
| Small same-label key hides different physical constraints | Preserve exact physical mapping for restricted repairs |
| More time repeats failed small searches | Resume or deliberately expand scope; log why a task is revisited |
| New neighborhood corrupts an unchanged suffix | Reconstruct complete candidate and replay from original snapshot |
| Memory optimization changes admissibility/identity | Keep proof kernels untouched; differential/oracle tests for altered primitives |
| Grand Hall overfitting | No route-specific policy; declared holdout and transformed boards |
| Best-known reference presented as optimum | Explicit unknown-optimality and qualification-unavailable states |
| One favorable timing reported as a speedup guarantee | Repeated isolated comparisons with equivalent inputs and budgets |

## 17. Audit artifacts and reproduction

The local audit directory is `tmp/quality-audit-2026-09-19`. It contains the
original report, observation harness, pipeline traces, repair results, and
verified routes. It is scratch evidence and may be ignored by Git. Do not link
production tests to it or assume it exists in a clean clone. Section 18 embeds
the critical route evidence in this tracked plan; promote fixtures deliberately
when implementation begins.

Useful local files:

| Artifact | Purpose |
|---|---|
| `AUDIT.md` | Original findings and descriptive experimental scope |
| `pipeline-15-4096.json`, `pipeline-30-4096.json` | Baseline public-adapter traces |
| `pipeline-30-4096-early-box.json` | Combined scheduling treatment; contains the observed discovery route |
| `rewrite-observation.json` | Complete replay-valid private rewrite candidates and observation times |
| `repair-results.json` | User-route restricted repair and large-window results |
| `seed-repair-results.json` | Eighteen isolated seed refinements, including full resulting paths |
| `best-route.json`, `best-route.txt` | Verified 476/238 route and provenance |
| `focused-tests.log` | 101 passing focused tests from the audit |

Local audit commands, if those artifacts still exist:

```powershell
node --experimental-strip-types tmp/quality-audit-2026-09-19/pipeline.mjs 30 4096
node --experimental-strip-types tmp/quality-audit-2026-09-19/pipeline.mjs 30 4096 early-box
node --experimental-strip-types tmp/quality-audit-2026-09-19/observe-rewrite.mjs
node --experimental-strip-types tmp/quality-audit-2026-09-19/seed-repair.mjs
node --experimental-strip-types tmp/quality-audit-2026-09-19/verify-best.mjs
```

The current pipeline harness writes a `-baseline` suffix, unlike the original
baseline filenames. The observation harness recovers the discovery seed from
the early-box artifact. The isolated seed survey uses more total work than a
single production run and must remain labeled accordingly. Do not ship the
observation-only generated-module instrumentation as a production solution.

## 18. Durable route evidence

The following appendix is copied from the audit artifacts, not a new benchmark
run. Route notation is U/D/L/R. Counts refer to moves from Grand Hall's initial
snapshot. All three routes were accepted by canonical replay during the audit;
replay them again when creating fixtures or after changing game/board data.
None of these routes establishes global optimality.

