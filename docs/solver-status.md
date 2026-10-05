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
lane. Automatic algorithm selection uses the lane's divided memory, and since
Sokomind 1.8.0 it runs fewer lanes when that keeps A* (see below). Active or
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
Deadline cutoff remains bounded. Deeper partition splitting remains open.
Since Sokomind 1.11.0, a partition whose first push solves the board gets a
snapshot marked solved, so its lane returns the prefix as the route. Before,
the lane's request failed validation and the lane errored, which left the run
unproven whenever the incumbent was longer than that prefix.

Sokomind 1.3.1 keeps busy proof lanes alive and accounts for coordinator
memory in single-lane proofs. The coordinator presumes a lane dead after 30 s
without a message. Table builds before the search report no progress, so a lane
now resends its last progress every 5 s from their yields while it holds a
partition. A heartbeat's bound never drops below the partition's prefix cost,
and the coordinator ignores heartbeats for partitions it has already closed. A
lane that stops yielding still falls silent and is stopped. The single-lane
proof gives its kernel the memory limit less the 128 MiB coordinator
reservation, as each parallel lane already was, and starts no proof when the
reservation takes the whole limit. Reported peak memory adds discovery's
retained memory to the proof's peak. Neither change alters proof logic, so the
proof revision is unchanged.

Sokomind 1.4.0 publishes the first replay-verified route as soon as discovery
finds it. Quality and Optimal progress then carries that route's move count as
the incumbent and upper bound from the start of harvesting, instead of only
from the improvement or proof phase. Every later verified route that is
strictly better (fewer moves, then fewer pushes) replaces it, so the upper
bound only falls. Quality returns the published route if the candidate archive
dropped it under memory pressure, and the Optimal proof starts from it if no
later phase improved on it. Quality progress still never carries a lower
bound or gap. When a time or work limit ends the run, the result is the best
published route; a user cancel still returns cancelled. Fast is unchanged.
The upper bound comes only from verified routes, never from proof, so the
proof revision is unchanged.

Sokomind 1.5.0 proves small Optimal boards first. A board with at most 8 boxes
and 96 floor cells (the classic exact profile's limits) runs the unmodified
proof straight after discovery, from the discovery route's cost, for at most
30% of the time limit. Only a completed proof (`proof.kind === "optimal"`)
ends the run there. Otherwise its work is charged to the run's state limits,
a better route it returns continues as an unproven incumbent once it replays,
and harvest, rewrite, reschedule and a fresh proof use the rest of the budget.
Nothing from the first proof carries into the second: no bound, table or
partition state. Its progress omits the lower bound and gap, which end with
it, and repeats the published incumbent as the upper bound. Deterministic
runs, resumed IDA* checkpoints and requests without a time limit skip this
step. Both exact kernels report `firstExpansionMs`, the time from kernel start
to the first expansion (table builds included). Proof logic is unchanged, so
the proof revision is unchanged.

Sokomind 1.6.0 gives small Quality boards an exact lane. The same small
boards run the same unmodified proof straight after discovery, for at most
half of the time left, but only as a route improver: Quality never proves.
When the lane completes, Quality returns its route (or the incumbent, if the
lane's route does not replay or is not shorter) with optimality `unknown`,
no proof, and no lower bound or gap. When it stops early, a better route it
returns continues as an unproven incumbent once it replays, and harvest,
rewrite and reschedule use the rest of the budget. Its progress reports phase
`improving`, never `proving`, and omits the lower bound and gap. Deterministic
runs and requests without a time limit skip the lane. Proof logic is
unchanged, so the proof revision is unchanged.

Sokomind 1.6.1 keeps the push endpoints on the discovery engine's collapsed
forced-push chains. A chain now carries its first push's source, its last
push's destination, and every box cell it touched. Before, a chain had no
endpoints: push-astar's goal-cut decomposition dropped every chain that began
with a push into a tunnel and fell back to the undecomposed search, the
push-ordering terms read nothing for it, and the packed-room check counted it
as not touching the room even when it moved a box in or out. The goal-cut
domain filter now admits a chain only when every touched cell lies in the
component, and the packed-room check requires every touched cell to lie
outside the room. Discovery routes can change; they are still replayed and
reported as unproven. The exact kernels and proof are untouched, so the proof
revision is unchanged.

Sokomind 1.6.2 passes each diverse harvest profile's move weight to the
discovery engine's push-beam lane. Harvest runs the guided push portfolio,
whose beam reads `moveWeight`, but the profiles set `planMoveWeight`, which only
the structural plan search reads, so every harvest beam ran with the default
weight. The balanced, detour and milestone profiles now weigh moves at 0.005,
0.003 and 0.008. Only Quality and Optimal harvest; Fast is unchanged. Harvest
routes can change; they are still replayed and reported as unproven. The exact
kernels and proof are untouched, so the proof revision is unchanged.

Sokomind 1.6.3 lets bounded rewrite and reschedule repair routes of any length.
They used to skip routes under 100 moves, which only mattered once the Quality
exact lane timed out or was skipped. On theme-museum, where the lane times out,
Optimal returned 77 moves in three of three runs; with the floor it returned 88
in five of six. The `improvementMinimumMoves` adapter option still sets a floor.
Repaired routes are still replayed and reported as unproven, and the exact
kernels and proof are untouched, so the proof revision is unchanged.

Classic A* 2.2.3 cuts a pushed child on `g + push bound + walk bound >= U`
before it computes the linear-conflict, interaction-boost, PDB-surplus and
goal-cut extras, on the ordinary and tunnel successor paths (the forced-push
path already did). Each extra is non-negative and the full bound adds the
largest of them to the push bound, so the full bound is never below push plus
walk; every child the cheap test cuts would fail the existing `f >= U` test.
Retained successors, expanded, generated and duplicate counts, moves and
proofs are unchanged while no memory limit binds; only extras telemetry, the
secondary-cutoff count and search-cache bytes fall. The proof revision is
unchanged.

Classic A* 2.2.4 and IDA* 2.2.2 keep searching when a pattern-database build
reaches the memory limit, which used to end the run with no lower bound. A
build stopped after its table is allocated keeps the partial table under the
rule a build deadline already used: breadth-first order has stored the exact
distance of every state up to the last expanded depth, so a missing entry
reads that depth plus one, and no state it stands for can be reached sooner. A
partition whose table does not fit before allocation gets a disabled table
that holds no bytes and adds nothing to h; later partitions still build.
Either way h only falls relative to a complete table, so proofs stay
admissible. `pdbDegradedPartitions` counts partitions a deadline or the memory
limit left partial or disabled, and `pdbMemoryFallbacks` those the memory
limit stopped. The proof revision is unchanged.

Classic A* 2.2.5 and IDA* 2.2.3 bound the deadlock-table build by work
instead of wall time. The old 2 s budget kept fewer patterns on a slower or
busier machine, so the same request could prune differently from one run to
the next. The build now stops after a fixed number of dequeued region-search
states (`MAX_TABLE_WORK`, 2,000,000: about 2 s on a c4-standard-32 core, and
no benchmark fixture's complete table needs more than 1.2 million), so every
machine builds the same table; the run's deadline and memory limit can still
stop it sooner. A pattern
is added only when its region search runs to exhaustion without solving or
emptying the region. A search the work cap, the deadline or the memory limit
cuts short adds nothing, and the build keeps the patterns it has proven
instead of ending the run. Each region enumerates label classes rather than
labels: a label with a goal in the region is its own class, and the labels
without one share a class, since none of them can be solved inside the region
and the region search treats them alike. One stored pattern covers every label
assignment that maps to it, so a completed build prunes the same states as
before with less work. Patterns are stored per region because two regions can
start at the same cell. `deadlockTableWorkUnits` and `deadlockTableTruncated`
report the build. The deadlock rules are unchanged, so the proof revision is
unchanged.

IDA* 2.2.4 floods the keeper's reachable area once per frame and keeps the
keeper walk to each of the frame's pushes, one 32-bit entry per push, so a
frame resumed after a child returns reads the walk instead of flooding again.
Classic IDA* used to copy the whole flood workspace on every frame, and the
Sokomind proof's IDA* lanes on every fourth level, flooding again on each child
return elsewhere. The `idaReachabilitySnapshots` and `idaSnapshotPeriod`
options chose that policy; both are still accepted and now ignored. The walks
come from the flood the frame's pi-corral, expansion-recheck and forced-push
checks already use, so children, their order and their costs are unchanged:
expanded and generated counts, moves and proofs match 2.2.3 while no memory
limit binds. `memoryReachabilitySnapshotBytes` now reports the kept walks. The
proof revision is unchanged.

IDA* 2.2.5 and Sokomind 1.12.1 end a contour loop that could not progress. A
lane with a move bound U but no route cut every child at f >= U, and the
backed-up f of those cuts became the next threshold, so the lane repeated its
last contour until a limit stopped it. Lanes start that way under a numeric or
channel bound, and in the parallel proof the partition that holds the
discovery route gets that route's cost as its exclusive bound, so its IDA*
lane never closed and the proof never finished. A finished contour now ends the
lane once its threshold or the next threshold reaches U. The argument:

- h is admissible, and a value cut short by a table limit is still a lower
  bound.
- A route the contour did not complete was either cut at f > threshold, which
  lowers the next threshold to at most the route's cost, or pruned by the
  contour's best-g table, which searches the same state at no greater cost.
- No route cheaper than U meets an f >= U cut.

So the next threshold bounds every route cheaper than U that the contour did
not complete, and a route it did complete is the incumbent. Once either
threshold reaches U, nothing cheaper than U remains: the lane proves its
incumbent optimal or, without one, reports that no route exists below U. The
same bound makes the next threshold the lane's lower bound before that contour
starts. A goal found in the contour has h = 0, so it costs exactly the
threshold, and it is now proven optimal even when a limit stops the contour
right after; before, it was a bounded result one contour behind. A lane that
reports a limit reports at most U as its lower bound. Checkpoints store the
next threshold as the last exhausted one, and the version change restarts
earlier checkpoints. No false certificate is known; proof revision
`exact-moves-ida-contour-exit-v1` and storage key `sokomind.optimal.v10`
reject earlier records as a precaution.

A* and IDA* 2.2.6 and Sokomind 1.12.2 bound the box selections a cut room
table lacks. A room-pattern table behind the interaction boost stops at 12,000
states. A cut table used to skip a selection it did not hold, so the boost
could take a cheaper replacement than any route needs: on 27 boards, 60 of 87
tables were cut and three boosts exceeded the remaining pushes, by up to 2.
A selection a cut table lacks now costs the table's depth, the deepest push
count it stored, plus the cost outside the room. The argument:

- The table is a breadth-first search, so it inserts states in nondecreasing
  push count.
- Once one insert is refused for size, every later insert is refused too.
- The state expanded at the first refusal has some push count D, so every
  state with D or fewer pushes was already stored, and the depth is D or D+1.
- So a state the table lacks needs at least the depth in relaxed pushes.
- A memory or time stop throws instead of returning a partial table.

A complete table still skips a missing selection: that selection is
unreachable even in the relaxed game, so no route uses it. The bundled engine
uses the same rule in discovery, where it also covers the capacity tables that
share the replacement cost. Pair-conflict tables skip a missing pattern only
when it has no replacement, which was already sound. The version change
restarts earlier IDA* checkpoints, and proof revision
`exact-moves-ida-contour-exit-v1` and storage key `sokomind.optimal.v10`
reject earlier records.

Sokomind 1.7.0 keeps its workers for the whole request. A discovery engine
used to start for every plan and a proof lane for every proof run, each
loading the engine or kernels again. The next plan now takes an engine whose
last message was a done that did not fail: the engine runs each command
synchronously and posts done last, so such an engine is idle. Any other engine
is terminated, and so is a parked engine that no plan takes within 1 s. A
proof lane that ended its partition serves the next proof run. A lane
cancelled mid-partition serves it once it posts the idle that ends that
partition, and is terminated if that takes over 2 s; a failed lane is never
reused. Every lane message carries its run's id, and a run ignores messages
from any other run. A parked worker that reports an error is dropped, and
every worker stops when the request ends. A parked worker is lent before a new
one starts. An engine becomes lendable only once the done that freed it has
reached every listener, so a plan started from that done takes another engine,
and a request can hold one engine more than it ran at once. Parked workers
hold no lease against the request's budget. Outside tests no
heap reading feeds an engine's memory estimate (Chromium's covers the whole
process and Node gives none), so reuse leaves memory accounting unchanged.
Each plan and proof run sends the same
commands as before; the exact kernels and proof logic are untouched, and the
proof revision is unchanged.

A kept proof lane also holds the board-only tables of its last run: the deadlock table,
the room-pattern tables behind the interaction boost and the pattern
databases. The next partition or proof run on that lane reuses them when its
key matches: the board, the resolved features, the algorithm, the box count
and the memory limit. The snapshot is not part of the key, so a lane builds
the tables once for all the partitions of a proof. The memory limit and the
work cap stop a build at a count, so a fresh build with the same key gives the
same tables. A table the deadline cut short, or a pattern database that lost a
partition to it, is never kept. A hit therefore searches exactly as a fresh
build would, with one exception: a complete cached table can stand in where a
fresh build under a tighter deadline would have stopped early. Its h is larger
but still admissible, and no proof logic changes. Each run reads the tables
through fresh views (its own lookup counters and an empty PDB surplus cache),
re-checks the room tables against its own budget and counts the cached bytes
in its memory estimate as it would its own build. A lane holds one entry and
drops it on a miss before building, so a run never holds tables its estimate
leaves out. Two gaps remain: an idle lane's tables are not yet charged
against the request's budget between runs, and the single-lane proof, which
runs in the coordinator, does not cache. `preprocessingCacheHits`,
`preprocessingCacheMisses` and `preprocessingCacheRetainedBytes` report the
cache. On a hit, table statistics such as `deadlockTableWorkUnits` describe
the cached table and the build times read 0. The proof revision is unchanged.

Sokomind 1.7.1 skips Optimal proof-first and the Quality exact lane when the
request sets an expanded- or generated-state limit. Their caps limit only time,
so the capped attempt spent the state budget the pipeline's proof needs. On
expert-tetris under the capped `sokomind-optimal-astar` benchmark profile (5M
generated states), proof-first used about 2.6M generated states before its time
share ran out, and the pipeline proof then stopped at the state limit with
bounds 37 and 39 in five of five runs; Sokomind 1.3.0 proved 38. The app sets
only time and memory limits, so production runs are unchanged. Proof logic is
unchanged, so the proof revision is unchanged.

Sokomind 1.8.0 chooses the parallel proof's algorithm and lane count
together. Automatic selection keeps the most lanes whose share of memory
still selects A*, and runs IDA* on every lane only when no lane count can.
Before, it split memory across every lane first: seven lanes at 4 GiB got
about 567 MiB each, below A*'s 768 MiB floor, so every lane ran IDA*, which
searches each transposition again. At 4 GiB a board within A*'s 768 MiB
thresholds now gets five A* lanes, and a board within its 2 GiB thresholds
gets one. Explicit `astar` and `ida-star` requests keep every lane. Both
algorithms are unchanged exact kernels, so the proof revision is unchanged.

On the production-optimal-parallel benchmark profile (job 47198, three
rounds), six light boards that seven IDA* lanes left unproven at 120 s now
prove: sym-diamond in 398 ms, v2-wide-multi-entry in 450 ms, garden-1 in
810 ms, expert-maze in 1.9 s, adv-four-color in 3.8 s and expert-tetris in
14.7 s. Moves are unchanged on every board. The four heavy boards stay
unproven at 120 s with unchanged routes (job 47199). A* lanes keep their
states, so peak process memory rises on large (3.1 to 4.0 GB) and
theme-parking (3.2 to 4.9 GB), and falls on master-exchange and theme-museum.

Sokomind 1.9.0 sends each published route with its progress incumbent
(worker protocol 2), so the solver dialog can offer **Stop and keep best**.
The worker host replays a route before it leaves the worker, and the client
replays it again before returning it. A kept route is a solved result with
optimality `"unknown"` and no proof, whatever mode produced it: a stopped run
never claims a bound or a proof. A proof that completes before the stop
arrives keeps its own result. Search and proof logic are unchanged, so the
proof revision is unchanged.

Sokomind 1.10.0 adds pair repair to Quality's anytime loop on boards with at
most 200 floor cells, the two-box reschedule's limit. Two-box repair frees two
boxes while every other box's push events stay fixed. The engine now picks
the pairs from the route: the boxes with the largest push detours, meaning
pushes in the route minus the shortest player-aware push distance. The
coordinator's consecutive-push pairs never improved a measured route. Goal
reassignment becomes a same-label goal swap: two boxes that share a label are
freed and each is sent to the other's goal. Before, it handed swapped targets
to the single-box reschedule, where the other box still ended on the target,
so it never produced a route. Both were experimental options; Quality now runs
them by default, and listing them in `experimentalOperators` adds nothing. A
candidate is kept only if it is shorter and the other boxes' push events
replay unchanged. Routes are still replayed and reported as unproven.
Optimal's improvement and the exact kernels are untouched, so the proof
revision is unchanged.

Sokomind 1.11.0 runs the small-board proof beside the route improvement when
proof workers run in parallel. This applies on the boards 1.5.0 and 1.6.0
cover, with at least two proof workers, no checkpoint hooks, and a memory
limit whose eighth holds at least one engine worker (256 MiB). Optimal's proof
and Quality's exact lane keep the lane plan chosen from all of the memory, but
their lanes' memory limit leaves that eighth to the engines (at 4 GiB, five
A* lanes of 691 MiB instead of 793 MiB). The proof runs alone for 5 s, or for
its cap when that is shorter. A proof that completes by then ends the run as
before, and one that stops short leaves the improvement every core. Otherwise
the improvement starts beside the same proof, which is not restarted, on the
worker threads and memory its lanes leave: Optimal's
harvest, rewrite and reschedule, or Quality's harvest, rewrite wave and repair
loop. While the improvement runs, the proof's progress carries no bounds.
Optimal's proof runs to the time limit instead of 30% of it, and a completed
proof ends the run at once. When the improvement ends first, the same proof
continues, and its bounds reach progress, held below the published route. A
proof that ends unproven is followed by a fresh proof from the best route when
at least 500 ms remain. That proof's result stands unless the earlier one has
a replaying route that is no longer and a strictly smaller gap; the two
proofs' bounds are never merged. Quality's lane keeps its cap of half the time
left, and a lane capped at 5 s or less runs before the repair as in 1.10.0.
Otherwise a completed lane stops the repair and returns its route, unproven and
without a proof. An unfinished lane's shorter route joins the repair's archive
once it replays. Quality's progress beside the repair still carries no bounds
and never speaks of proof. Single-lane proofs, deterministic runs and the other 1.5.0
and 1.7.1 exclusions keep the proof first and the improvement after it. Proof
logic is unchanged: only the lanes' memory limits shrink, a lane that reaches
its limit keeps its kernel's own bound, and no outside route enters a running
proof, so the proof revision is unchanged.

Sokomind 1.12.0 runs Fast's discovery beside the structural head start on
structural boards (at least 10 boxes or 100 floor cells). With at least two
engine workers and no expanded- or generated-state limit, structural search
keeps its head start on one worker while discovery starts on the others. With
at least four workers, discovery runs the forward and reverse frontiers, and
the guided push portfolio starts only if they end without a route; with two or
three workers, it runs the portfolio. Beside the frontiers, the portfolio
added about 300 MiB on `v2-27box-open` and found no route sooner. The first
replayed route wins: the other lanes stop, and the better of any routes they
already hold is kept. When the head start ends
without a route, its checkpoint continuations take its place beside discovery
that is still running. Each lane leases one memory share of the lanes that can
run at once. If no lane finds a route, the two-worker bidirectional search and
the classic fallback run as before. Before, discovery waited for the head
start: on `v2-27box-open` the structural search timed out after 21 s, and
discovery then found its route in 5 s. Fast's route can now differ from
1.11.0's when discovery finishes first. Quality, Optimal, deterministic and
single-worker runs, and runs with a state limit, keep the sequential order.
Fast still returns bounded, unproven routes that replay, and the exact kernels
and proof are untouched, so the proof revision is unchanged.

Exact PDB preprocessing checks estimated memory before table/queue allocation,
releases consumed packed queue chunks, and propagates cancellation. Optional
PDB-cache growth is included in both kernels' live estimates and cannot consume
unavailable residual memory. The move-cost PDB's reverse build now charges
each push from the cell the box vacated, where the push leaves the keeper;
the earlier edge could overestimate. A build whose table fills stops and
falls back to its completed radius instead of dropping states. It remains
disabled pending broader performance qualification. Quality strategic defaults
preserve explicit zero-analysis and false-plan-execution controls.

Persisted optimality records use schema 7, proof revision
`exact-moves-ida-contour-exit-v1`, and storage key `sokomind.optimal.v10`.
Earlier revisions are rejected in both storage tiers, including schema-7 records
that can predate the A* frontier correction, the tunnel-macro soundness fix or
the pattern-deadlock key fix, that were proven with the goal-cut heuristic on
by default, that used the earlier linear conflict or region-bound pattern
database, or that predate the IDA* contour exit and the cut room-table bound.
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

The goal-cut heuristic no longer runs by default. It was documented as an
admissible push bound but is not one, and no move-level bound has been proven
(see the goal-cut paragraph below). No false certificate has been found, so
this is a precaution: the proof revision and storage key `sokomind.optimal.v8`
reject records proven while it was on.

The linear conflict no longer overestimates the remaining pushes (see the
linear-conflict paragraph below). It ran by default in both exact kernels and
in classic A*, but no move-level overestimate has been found, so proof revision
`exact-moves-linear-conflict-v1` rejecting earlier records is a precaution.

The pattern database no longer overestimates the remaining pushes (see the
pattern-database paragraph below). It runs by default in both exact kernels.
No false certificate has been found; on the probe board the walking moves
absorbed the excess. Proof revision `exact-moves-pdb-exit-cap-v1` and storage
key `sokomind.optimal.v9` rejecting earlier records is therefore a precaution.

Sokomind 1.3.0 also versions the earlier Quality changes: Quality no longer
dispatches proof and always reports unknown optimality, `SolverRequest` accepts
a replay-validated `initialSolution` seed, and Quality repair runs on a
parallel task-slot coordinator. Quality artifacts labelled 1.2.1 may predate
these changes.

Quality and optimal modes can refine a complete incumbent with whole-box
rescheduling. Every physical box is eligible, including repeated-label boxes;
route-length and remaining-budget checks still govern execution. Each repair
frees one box while preserving the other boxes' push order and identity;
Quality's pair repair frees two (see 1.10.0 above). This restricted
optimization is not a global optimality proof. See the
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

Quality and Optimal modes both reschedule whenever `supportsBoxRescheduling()`
holds. `predictRescheduleValue()` in `sokomind-reschedule-predictor.ts` is
tested but not wired into any production path; gating Quality rescheduling on
it would change behavior and needs benchmark qualification first.

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
  bounds. Computed `h` values are cached across contours. The full bound
  depends only on box positions and robot cell, but when the cheap push+walk
  bound or the secondary heuristic sum already exceeds the contour, that
  truncated value is cached with a flag. It is reused only while it still
  exceeds the contour bound; a later contour recomputes the full bound.
- The unproved goal-depth macro prune is disconnected from both exact kernels.
- A numeric upper bound is an exclusive pruning ceiling. Only a complete,
  replay-valid incumbent can become a public solution.
- A* resource exits retain the active minimum-`f` node's bound rather than
  deriving proof progress from the remaining heap alone.
- Forced successors obey the same frontier ordering and projected-memory
  checks as other successors, including the initial node arena allocation.
- Pattern-database, deadlock-table, and related preprocessing share the run's
  cancellation, elapsed-time, state, and estimated-memory budgets.
- A pattern-database lookup never exceeds the full-board relaxation. A table
  built over a goal region is capped by an exit bound for plans that move a box
  out of the region. A box outside the region gets that bound instead of no
  bound. Entries a build deadline left missing get one more than the last
  depth the build expanded.
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

The exit-route board in `tests/unit/pattern-database.test.ts` is the regression
for the former region-bound pattern database. On every cell, a single-box
lookup must equal the full-board push distance; from the box's starting cell
that is 12 pushes, where the table alone stores 16. For two and three goals,
every box subset must stay within the table built over the whole board. A label
with more boxes than goals must take the cheaper outside box. Both exact
kernels must prove the 20-move optimum.

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
- goal-cut heuristic (default off); and
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

Linear conflict adds two pushes for each pair of boxes that must pass each
other on a row or column. A pair counts only when both boxes' labels have a
single goal, each box's goal is on that line, and each box's relaxed push
distance equals its straight distance. Two boxes that both stay on the line
keep their order, so one box of a crossing pair must leave it, which costs a
push off the line and one back. Each box joins at most one counted pair per
axis, and the row and column terms count pushes along different axes, so they
add. The former rule counted every crossing in one minimum assignment. A label
with several goals can have another assignment of the same cost that crosses
nothing, and a box whose shortest route already leaves the line passes the
other box at no extra cost, so the old term could exceed the push optimum. The
oracle tests in `tests/unit/linear-conflict.test.ts` check the push and move
bounds over every reachable state of boards for both cases.

Pattern-database partitions contribute to the heuristic via per-label surplus:
for each label, any excess of the PDB value over the assignment cost is added to
the heuristic as `h = assignment + max(LC, boost, pdb_surplus) + walk`, with
the goal-cut surplus joining that maximum when enabled. The PDB surplus is
admissible because each label's boxes and goals are disjoint.

Each partition's table is a reverse push search over the goal region: the cells
within walking distance 8 of the partition's goals. It is a relaxation. The
robot is ignored, and a push needs only a floor support cell, which may lie
outside the region or be occupied. Boxes, however, move only onto region cells.
So a table value bounds only plans that keep every box inside the region, and
a box's cheapest route may leave it. On the exit-route board the table stores
16 pushes where 12 suffice.

A lookup therefore returns the smaller of the table value and an exit bound.
The exit bound is `sum of d(b) + min over boxes of (out(b) - d(b))`. Here
`d(b)` is the box's full-board single-box push distance to the nearest
partition goal, and `out(b)` is the same distance for routes through a cell
outside the region. A plan that moves some box out of the region costs at
least that much. A box outside the region is answered by the exit bound alone,
which is then `sum of d(b)`.

Such lookups used to return no bound. When a label has more boxes than the
partition has goals, the heuristic takes the minimum over box subsets and skips
subsets without a bound, so that minimum could land on a larger in-region
value. A build cut short by its deadline answers missing entries with one more
than the last depth it expanded, for the same reason.

The `pdbLookups`, `pdbExitCapTrims`, `pdbExitCapTrimTotal` and
`pdbOutsideRegionLookups` counters report how often the exit bound applies.

The interaction boost and the PDB surplus both subtract the assignment label
costs, but cache their results by box key alone. The assignment heuristic
reports the box key its last label costs belong to (`lastBoxKey`), and both
evaluators read or write their caches only when that key matches the state
being scored. Otherwise they recompute and store nothing, so a value computed
from another state's label costs is never reused.

Goal-cut (`goalCutHeuristic`, default off) detects bottleneck conflicts when
multiple boxes' shortest push-paths share articulation points or tunnel cells.
For each bottleneck with demand N > 1, the surplus is (N-1)*2 pushes; the
heuristic takes the maximum across all bottlenecks. This is not a push lower
bound: boxes can cross a shared bottleneck one after another without yielding.
On the shared-tunnel board in `tests/unit/goal-cut.test.ts` the assignment
bound and the push optimum are both 7, yet the surplus adds 2. Added to the
move bound it has not been shown to overestimate: the same tests check
assignment + surplus + walk against the exact remaining moves of every
reachable state on two small boards. That is evidence, not a proof, so the
feature stays off until a move-level bound is proven.

Mixed-label deadlock tables cover the complete label assignment product
within the work budget, through per-region label classes. Deeper PI-corral
boundary-table checks and relaxed pattern-window eligibility remain rejected
because each produced a false positive under its abstraction.

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
A seeded differential fuzz compares exact A* and IDA* under each feature
variant with an independent step oracle on generated boards: a fixed 100-board
slice in the unit suite and a timed long run in `test:solver:fuzz`.

```text
npm.cmd run test:solver:oracle
npm.cmd run test:solver:fuzz
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
