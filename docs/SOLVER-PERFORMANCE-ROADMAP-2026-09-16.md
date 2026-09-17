# Solver performance roadmap — September 16, 2026

The requested targets are 30 seconds to the first verified Fast solution, 60
seconds to a Quality solution within 10% of the minimum total moves, and 120
seconds to a certified move-optimal solution. Fast looks closest to its target.
Quality already makes large improvements but needs a better anytime scheduler
and measurable optimality comparisons. Optimal needs substantially stronger and
cheaper lower bounds as well as useful parallel search; removing the six-worker
ceiling alone will not establish its target.

This is an analysis and implementation plan. No solver source was changed.
Current executable source takes precedence over historical benchmark reports.

## Fresh measurements and their limits

Raw audit evidence (requests, returned routes, replay results, counters,
environment, CPU-profile summary, and the heuristic counterexample below)
was collected during the initial performance audit session.

Measurements used commit `9e6cbd2`, Sokomind 1.2.1, Node 24.14.0, an AMD Ryzen 7
9800X3D with 16 logical processors and about 31.19 GiB reported system memory.
Each mode ran once in a fresh process, sequentially, through the public Node
adapter. Requests used 4 GiB estimated-memory limits, ordinary nondeterministic
mode defaults, automatic proof-algorithm selection, and proof parallelism one.
Global expanded/generated limits were unspecified; internal phase budgets apply.

| Mode | Request deadline | Returned moves / pushes | Elapsed | Proof | Lower bound |
| --- | ---: | ---: | ---: | --- | ---: |
| Fast | 30 s | 893 / 278 | 5.498 s | None | — |
| Quality | 60 s | 515 / 236 | 59.999 s | Bounded | 227 |
| Optimal | 120 s | 520 / 242 | 120.004 s | Bounded | 231 |

All three routes passed canonical replay. Neither bounded result establishes
optimality or the 10% Quality target. For a sound lower bound `L` and verified
route length `U`, `U <= 1.1 * L` certifies the Quality target. A 515-move route
needs an integer lower bound of at least 469; the observed 227 does not suffice.
On fixtures with independently established optimum `C*`, require
`U <= floor(1.1 * C*)` instead.

These are descriptive Node smoke samples, not browser distributions or evidence
that every reasonable puzzle meets a target. The user's 3.8-second Fast and
approximately 15-second Quality observations have a different measurement
boundary. The fresh normal Quality run reports a first incumbent of 952 moves,
whereas Fast and Optimal start at 893. Quality currently changes discovery
settings; its timeline cannot be assumed to be Fast's first four seconds followed
by eleven seconds of repair. The CLI logs do not timestamp individual incumbents.

Current exact preprocessing built 18,684,253 PDB table entries, retaining about
35.66 MiB. PDB construction took 24.038 seconds in Quality and 23.815 seconds in
Optimal, plus about two seconds building deadlock tables. Optimal proof expanded
17,289 states and generated 653,565 after discovery/refinement. Peak reported
solver estimates were 63.30, 621.36, and 754.75 MiB respectively. These are
conservative estimates, not measured peak RSS or browser-process memory.

## Prioritized actions

### 1. P0 — Define and enforce the three benchmark contracts

**Owners:** [benchmark library](../scripts/solver-v2-benchmark-lib.ts), lines
62–73, 115–159, 660–673;
[corpus](../tests/fixtures/solver-v2/benchmark-corpus.ts);
[known optima](../tests/fixtures/solver-v2/known-optima.ts).

Define “reasonable” as a frozen supported suite covering small tactical puzzles,
room transfers, corridor packing, many boxes, repeated labels, typed labels,
large open rooms, and mirrored/rotated equivalents. Keep a holdout suite to catch
tuning that only helps Grand Hall. Include Grand Hall explicitly in the Optimal
target suite: the existing standard exact benchmark eligibility excludes boards
above eight boxes or 96 floor cells, so it cannot qualify this 17-box board.

Add actual 30/60/120-second production profiles. Current Fast/Quality profiles
both permit 180 seconds; adapter Optimal profiles permit 60 seconds and use the
small-board eligibility policy. Quality acceptance presently requires replay,
without a 10% threshold. Align documentation with current code: the general
profile now uses 4 GiB and nondeterministic discovery despite older descriptions.

Record first verified solution time, every incumbent improvement time, final
moves, certificate time, bounds, deadline/cutoff reason, effective active search
workers, preprocessing time, and peak memory. Use isolated repetitions and
median/p95 plus per-fixture failures. A request for “every puzzle” must pass every
declared fixture; an average success rate must not conceal failures. Keep
deterministic work-count controls separately from nondeterministic browser timing.

**Acceptance:** replay-valid Fast within 30 s; Quality within 60 s and the known
optimum threshold or a sound bound certificate; Optimal within 120 s with a
compatible optimal proof and equal lower/upper bounds. Unknown-optimum fixtures
remain unqualified until adequate reference or proof evidence exists.

### 2. P0 prerequisite — Correct the dormant move-cost PDB before enabling it

**Owners:** [move-cost PDB](../src/solver/search/move-cost-pattern-pdb.ts),
lines 167–201 and 493–498;
[its tests](../tests/unit/move-cost-pattern-pdb.test.ts), lines 98–171;
[feature defaults](../src/solver/search/exact-search-features.ts), lines 43–60.

A default-sized two-box candidate returns a lower bound of **5 moves** for a
state whose independent core-engine step BFS proves **4 moves / 2 pushes**.
The rank/unrank functions are incompatible. Reverse predecessor support
geometry also needs correction: a push from `current - direction` to `current`
requires the keeper one further cell behind the predecessor.

Existing local tests use FIFO traversal of variable-cost macro edges and return
the first goal, which cannot serve as an exact move oracle. Replace that oracle
with independent unit-step BFS or Dijkstra, add rank/unrank round trips and
exhaustive two-box admissibility cases, and test mirrors/rotations and cutoffs.
Keep the feature disabled until these pass. It already defaults off, so this is
a promotion blocker, not the cause of the current production timings.

**Acceptance:** every finite heuristic value is at most the independent exact
remaining cost; enabled exact A*/IDA* match independent optimum and proof tests.

### 3. P1 — Expose usable desktop parallelism and memory controls

**Owners:** [worker plans](../src/solver/implementations/sokomind-plans.ts),
lines 15–19;
[worker selection](../src/solver/implementations/sokomind-solver.ts), lines
125–152;
[Auto memory](../src/features/solver/solver-internals.ts), lines 37–45;
[dialog options](../src/features/solver/useSolverController.ts), lines 18–23;
[request options](../src/solver/implementations/sokomind-options.ts), line 30.

Six is an application hard cap. Effective discovery capacity is
`min(6, hardwareConcurrency - 1, memoryBound)`. Budgets through 768 MiB permit
one engine worker; through 1536 MiB permit two. Auto memory returns
384/768/1536 MiB, and the largest dialog option is 1536 MiB. Therefore the current
dialog cannot activate six discovery workers on this desktop. Default proof
parallelism is separately one, and the UI sends only the mode.

Add independent Auto/manual search-worker controls, larger desktop memory
options, and detected/effective count plus the limiting reason. Replace coarse
memory tiers with measured task-memory reservations under one aggregate budget.
Include discovery, preparation, repair, proof, coordinator work, and runtime
overhead in that scheduler. An outer coordinator worker is not an additional
parallel search lane.

Benchmark 1/2/4/6/8/12/14 active search workers with a fixed total memory allowance,
then repeat with sufficient per-worker memory. Start evaluation around six to
eight CPU-heavy lanes, rather than assuming sixteen logical threads double eight
physical cores' throughput. Keep the UI responsive and report actual occupied
slots. Browser `hardwareConcurrency` is a hint and may be lower than the machine's
logical processor count ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/WorkerNavigator/hardwareConcurrency)).

**Acceptance:** resource controls can actually schedule more than two useful
lanes; the selected policy improves target latency/quality/certificate rate
without memory-limit violations or cancellation regressions.

### 4. P1 — Give Quality and Optimal different anytime schedulers

**Owners:** [harvesting/refinement](../src/solver/implementations/sokomind-harvest.ts),
lines 195–373;
[defaults](../src/solver/implementations/sokomind-plans.ts), lines 25–35;
[proof orchestration](../src/solver/implementations/sokomind-proof.ts).

Both modes currently harvest, run bounded window rewriting and one whole-box
refinement, then enter exact proof. Quality therefore spends remaining time on
proof after this finite repair sequence; Optimal delays its main objective while
that same pipeline runs. The 45-second refinement deadline and two repair sweeps
are not an anytime policy.

For Quality, repeatedly allocate short resumable slices to operators according
to recent moves saved per millisecond, with diversified restarts when improvement
stalls. Use a limited exact-bound lane when it helps assess/certify the 10% target.
For Optimal, begin proof after the first verified incumbent, assign most resources
to proof, and run a small improvement helper concurrently. Broadcast every shorter
verified upper bound to all exact lanes.

Experiment with sharing Fast's discovery settings until the first incumbent,
then activating Quality diversity. Separate cumulative work allowance from live
memory: the current default improvement work allowance is still memory-scaled
and capped at 500,000 states. The historical 200,000-state Grand Hall cutoff is
a test-request limit, not a fixed UI limit; UI requests only time and memory.

**Acceptance:** improvement operators can continue productively until the Quality
deadline; Optimal starts useful proof work early; all activities share the same
deadline, accounting, replay boundary, and honest bounded/proven result rules.

### 5. P1 — Make exact preprocessing and heuristic evaluation cheaper

**Owners:** [PDB builder](../src/solver/search/pattern-database.ts), lines
297–363; [PDB evaluator](../src/solver/search/pdb-heuristic.ts), lines 11–40,
78–88; [IDA*](../src/solver/search/ida-star.ts), lines 706–719, 1435–1506;
[A*](../src/solver/search/exact-move-astar.ts), lines 1620–1665.

Give preprocessing a small dedicated time/memory allowance within the global
deadline. Probe useful patterns rather than building every partition eagerly.
Start search with cheaper admissible bounds when construction is too expensive;
never interpret an unfinished table entry as proof of impossibility. Cache
immutable board/PDB/deadlock structures by geometry, labels, and implementation
identity for reuse across partitions and repeated solves.

Replace the object/array PDB BFS queue with packed ranks in chunked typed arrays,
reuse occupancy/decoding buffers, and release consumed chunks. The current queue
retains processed states and clones/sorts successor arrays. Cache push-only PDB
values by boxes, independent of keeper position. A five-box pattern among eleven
generic boxes can require 462 compatible-subset lookups per evaluation.

Evaluate cheap assignment plus walking first. Skip expensive interactions/PDB
evaluation when the cheap bound already crosses the incumbent or IDA* contour.
Preserve IDA* next-contour bookkeeping and A* frontier ordering; stronger deferred
A* estimates require correct reinsertion. Retain existing compact A* arenas,
exact packed identities, and incremental assignments.

**Acceptance:** matched oracle/proof outcomes, materially less preprocessing time,
better search throughput, and lower peak live memory. Measure PDB's marginal bound
increase as well as its build/evaluation cost; fewer expanded states alone can
mean the solver is doing less work because its heuristic is slower.

### 6. P1/P2 — Balance proof work dynamically and budget each lane correctly

**Owner:** [parallel proof](../src/solver/implementations/sokomind-proof.ts),
lines 314–391, 696–742.

Replace private round-robin first-push queues with a common pending-task queue.
Split unusually expensive partitions deeper so idle workers can help the long
tail. Track every disjoint partition and its lower bound; a certificate requires
all outstanding work to be excluded or completed. Initialize task bounds with
admissible estimates rather than zero where possible.

Reserve shared/static memory and divide remaining per-lane memory before choosing
A*/IDA*. The current selector uses total request memory before division, so higher
parallelism can choose A* for lanes with insufficient memory. Publish throttled
aggregate proof progress; the parallel path currently consumes progress internally.

**Acceptance:** uneven-partition tests show useful work redistribution; no missing
coverage or false proof on cancellation, work/memory cutoffs, or worker failure.
Scaling tests count preprocessing and duplication costs, not just CPU occupancy.

### 7. P1 research — Strengthen sound move lower bounds for large puzzles

**Owners:** [interaction heuristic](../src/solver/search/pair-conflict-heuristic.ts),
lines 81–97; [move-cost patterns](../src/solver/search/move-cost-pattern-pdb.ts);
[Grand Hall component evidence](grand-hall-component-pdb-report.md).

The observed 231-versus-520 proof gap is too large to treat as a small tuning
problem. Build small two/three-box interaction abstractions around shared
corridors, staging conflicts, and unavoidable keeper travel. Cover repeated-label
boxes with matching-aware subset selection and sound cost partitioning. Avoid
double-counting keeper walks or pushes across abstractions. Validate against the
independent oracle before timing experiments.

The experimental generic component PDB already exists and defaults off. Its
checked-in Grand Hall report found zero bound improvements and slower search.
Do not simply enlarge it or turn on dormant move-cost patterns without correcting
item 2. Use tighter lower bounds as the main escalation if inexpensive search and
parallelism still cannot certify the large-board target.

**Acceptance:** meaningful root/frontier bound improvement and higher 120-second
certificate rate after preprocessing and evaluation costs, with independent
admissibility checks. No current evidence supports promising Grand Hall's exact
optimum within two minutes.

### 8. P2 — Start a useful Fast portfolio earlier

**Owners:** [discovery coordinator](../src/solver/implementations/sokomind-solver.ts),
lines 482–598; [tuning](../src/solver/implementations/sokomind-tuning.ts), lines
115–117.

Large structural boards prepare, then run one structural lane. The default head
start is 25 seconds, capped at 70% of remaining time. Under a 30-second target,
fallback strategies can wait roughly 21 seconds. Test a short structural-only
interval followed by a genuinely different guided lane; run forward/reverse
search when analysis predicts value. Add deliberate lane diversity or checkpoint
continuations rather than duplicate work to fill worker slots.

Keep the Grand Hall-winning structural policy and measure whether concurrent
lanes slow it through CPU/cache contention. Fast already bypasses rewriting and
uses zero solution-comparison budgets. Stop all competing discovery on the first
complete replay-verified route.

**Acceptance:** fewer 30-second failures on holdout puzzles without material
Grand Hall first-solution latency or route-quality regression.

### 9. P2 — Parallelize and broaden Quality repair

**Owners:** [refinement coordinator](../src/solver/implementations/sokomind-harvest.ts),
lines 269–341; [box repair](../src/solver/implementations/sokomind-engine/source/box-rescheduling.js),
lines 6, 230–258.

Current concurrency mostly rewrites different incumbents; final whole-box repair
uses one worker and tries physical boxes serially. Schedule independent repairs
of different boxes/neighborhoods against the same verified incumbent. Accept the
best complete replayed route, then rebase or invalidate stale jobs. Never merge
independent schedule patches without replaying the whole resulting route.

After single-box repair stalls, escalate selectively to joint two-box repair,
small relaxed push-order neighborhoods, and matching-compatible goal reassignment
for repeated labels. Current repair fixes other boxes' order/identity and the
selected box's final cell, so it can settle into a restricted local optimum.

**Acceptance:** better 60-second final moves and improvement curves, including
fixtures where one-box repair stalls; aggregate limits and route replay still pass.

### 10. P2 — Target measured hot paths and reuse workers

**Owners:** [corral/reachability analysis](../src/solver/implementations/sokomind-engine/source/analysis.js),
lines 658, 2006, 2155;
[rescheduler](../src/solver/implementations/sokomind-engine/source/box-rescheduling.js),
lines 4–44;
[phase worker lifecycle](../src/solver/implementations/sokomind-phase-runner.ts),
lines 273–283, 493–496, 627–636.

A fresh direct-kernel CPU profile returned the 893/278 route. Exclusive sampled
time was 10.7% in sealed-corral deadlock checking, 8.9% in reachability, and 7.1%
in garbage collection. This is one instrumented Node sample, not a browser
distribution or an additive breakdown of nested timings. Fast's 1,329 visited
states conceal 187,672 reachability floods in the public sample.

Reduce repeated corral/topology work with bounded, sound cache reuse and dense
scratch workspaces. Preserve all necessary deadlock checks and differential
reachability controls. In repair, reuse prepared dense adjacency and per-worker
BFS queues/distances/generation stamps instead of rebuilding geometry per attempt
and allocating arrays per expansion. Retained support-distance preprocessing
arrays must remain separate from scratch storage. Consider compact repair arenas.

Use a reusable worker pool and initialize immutable board/proof structures once.
Current phase tasks create and terminate workers, and proof tasks rebuild board
preprocessing. Start with per-worker caches and explicit reset/ownership protocols.
Shared immutable typed arrays can follow where hosting supports cross-origin
isolation; browser SharedArrayBuffer requires the relevant isolation configuration
([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated)).

**Acceptance:** less allocation/GC/startup/preprocessing time, better throughput,
bounded live memory, and identical legality/proof behavior. Existing dense
geometry, incremental layouts, transition memoization, bounded caches, linked
macro paths, and typed-array A* nodes should be retained and extended.

### 11. P2 — Publish usable anytime results and restore experiment controls

**Owners:** [publication retention](../src/solver/implementations/sokomind-phase-runner.ts),
lines 349–365; [progress contract](../src/solver/contracts.ts), lines 145–168;
[Quality auto-strategy](../src/solver/implementations/sokomind-solver.ts), lines
401–414; [memory harness](../scripts/benchmark-solver-memory.ts).

Repair publications are verified and retained, but retained publications do not
immediately update the public incumbent in that code path. Send verified route
updates and timestamps through the outer worker/UI, and add “finish now with best
route” separately from cancellation. Throttle large route/progress traffic.

Respect explicit zero strategic analysis and disabled plan execution. Current
Quality auto-injection treats zero as a trigger for 500 ms analysis and forces
execution on; this contradicts the stated controlled-experiment contract. Fix
that distinction so A/B settings describe the code actually exercised.

Improve memory measurement: the standalone memory harness currently samples
after search, despite describing peak measurement. Distinguish estimates, sampled
peak heap/ArrayBuffer storage, and process RSS across nested workers. Report
unsupported browser metrics as unavailable rather than confirmed zero usage.

**Acceptance:** users see the actual improvement curve and can retain the best
verified result; tuning flags remain effective; memory/worker reports accurately
describe the measurement boundary.

### 12. P3 — Consider WASM/native kernels only after measuring the remaining gap

If the preceding work leaves compute-bound hotspots, prototype a compiled kernel
for packed identity, BFS, assignment, and pattern evaluation, preserving the same
worker-neutral contracts and independent oracle suite. Benchmark transfer costs,
cold initialization, total memory, and browser deployment requirements. A wholesale
port is not the first step: current scheduling, repeated preprocessing, and weak
lower bounds would remain problems in a faster runtime.

## Reproduction and validation

Fresh public samples:

```powershell
node --experimental-strip-types scripts/solve-sokomind.ts --puzzle=huge --mode=fast --timeout-ms=30000 --memory-mib=4096
node --experimental-strip-types scripts/solve-sokomind.ts --puzzle=huge --mode=quality --timeout-ms=60000 --memory-mib=4096
node --experimental-strip-types scripts/solve-sokomind.ts --puzzle=huge --mode=optimal --timeout-ms=120000 --memory-mib=4096
```

Run the following from the repository to reproduce the independent MC-PDB
counterexample. Coordinates passed to `cellAt` are zero-based row/column. The
seed rows select a default two-goal pattern; the queried dynamic state is supplied
separately.

```powershell
@'
import {parsePuzzleRows} from './src/core/index.ts';
import {compileSearchBoard} from './src/solver/search/compiled-board.ts';
import {buildMoveCostPatternPdb,evaluateMoveCostPattern,PatternWalkWorkspace,selectGoalPatterns} from './src/solver/search/move-cost-pattern-pdb.ts';
import {exactRemainingMoves} from './tests/support/exact-solver-oracle.ts';
const board=compileSearchBoard(parsePuzzleRows(['OOOOOOO','O  R  O','O S   O','O S   O','O XX  O','OOOOOOO']));
const p=selectGoalPatterns(board)[0];
const boxes=[{id:'box-1',label:p.label,cell:board.cellAt(2,2)},{id:'box-2',label:p.label,cell:board.cellAt(2,3)}];
const robot=board.cellAt(1,3);
const pdb=buildMoveCostPatternPdb(board,p,{maxSettledStates:1000,maxBuildMs:1000,maxUsefulDistance:80});
console.log({oracle:exactRemainingMoves(board,robot,boxes),bound:evaluateMoveCostPattern(board,pdb,boxes.map(b=>b.cell),robot,new PatternWalkWorkspace(board.cellCount))});
'@ | node --experimental-strip-types --input-type=module
```

Expected: oracle four moves/two pushes, 49 explored states; heuristic five.

Focused existing oracle, Grand Hall safety, move-cost PDB, and proof-contract tests
passed 80/80 in about 15.08 seconds. Another 21 focused worker/memory checks passed.
The independent reproducer demonstrates a gap in the existing MC-PDB validation
despite its tests passing. The full unit/build/browser matrix was not rerun for
this read-only source audit; it would be required when implementing changes.
