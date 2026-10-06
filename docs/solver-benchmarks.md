# Solver benchmarks

The V2 harness measures production solver paths and controlled exact-search
feature variants. Its JSON is evidence, not a substitute for replay and proof.

## Quick start

Run a small production smoke capture:

```text
npm.cmd run benchmark:solver:v2 -- --fixture=ultra-tiny --profile=sokomind-fast --runs=1 --warmup=0
```

Run the full configured matrix with five isolated samples per pair:

```text
npm.cmd run benchmark:solver:v2 -- --runs=5 --warmup=0 --save=tests/fixtures/solver-v2/baseline-v4-YYYYMMDD.json
```

The default matrix is large. It includes every eligible fixture/profile pair
and may take hours on proof-heavy fixtures.

## Production profiles

| Profile | Production path | Deterministic | Eligibility |
|---|---|---:|---|
| `sokomind-fast` | Node Sokomind adapter, fast mode | No | All fixtures |
| `sokomind-quality` | Node Sokomind adapter, harvest + rewrite | No | All fixtures |
| `sokomind-optimal-astar` | Node Sokomind adapter + A* proof | No | Classic-eligible |
| `sokomind-optimal-ida` | Node Sokomind adapter + IDA* proof | No | Classic-eligible |
| `classic-astar` | Exact move A* adapter | Yes | Classic-eligible |
| `classic-ida-star` | Exact move IDA* adapter | Yes | Classic-eligible |
| `production-fast` | Fast, 30-second target | No | All fixtures |
| `production-quality` | Quality, 60-second/10% target | No | All fixtures |
| `production-quality-parallel` | `production-quality` with the app's proof workers | No | All fixtures |
| `production-optimal` | Optimal, 120-second certificate target | No | All fixtures, including Grand Hall |
| `production-optimal-parallel` | `production-optimal` with the app's proof workers | No | All fixtures, including Grand Hall |

Classic eligibility is at most eight boxes and at most 96 floor cells. The
harness derives the eligible matrix from the current corpus and requested
profiles. The all-fixture production matrix includes two 27-box warehouses.
`v2-27box-memory` starts with boxes against the top wall that can never leave
it, so every mode should end at once with `exhausted`; it checks that a large
dead start is recognized quickly. `v2-27box-open` is the same board one row
lower and measures 27-box route quality and memory. In its first run (job
46880, 2026-10-03, one sample each) Fast, Quality and Optimal returned verified
routes of 1,300, 904 and 914 moves. The matrix is not yet a declared
reasonable-puzzle SLO suite.

Every request receives the same immutable limits object recorded in its sample.
Classic proof profiles use 60 seconds, 500,000 expanded states, 5,000,000
generated states, and 512 MiB. General Sokomind profiles use 180 seconds,
500,000 expanded states, 5,000,000 generated states, and 4 GiB. The
production target profiles carry only what the app sends: their 30/60/120-second
deadlines and 4 GiB, with no state caps, so a large board runs until its
deadline as it would in the browser. `production-fast`, `production-quality`
and `production-optimal` keep proof parallelism one, so Quality's exact lane
and Optimal's proof run on the coordinator thread. `production-quality-parallel`
and `production-optimal-parallel` pass the proof worker count the app derives
from the same 4 GiB and the machine's CPU count (`effectiveProofWorkerCount`;
seven on any machine with at least eight CPUs), so their proofs run in parallel
proof workers as they do in the browser. Each sample records the count in
`configuration.sokomindOptions`.

Every solved sample must replay and return within its harness deadline. Quality
requires at most `floor(1.1 * C*)` moves when an independent frozen optimum is
available; otherwise a compatible proof lower bound must certify that ratio.
Metrics-only bounds cannot qualify a result. Production Optimal requires a
compatible optimal certificate with equal bounds, and must match independent
truth when available. Legacy exact profiles additionally require frozen truth.

## Methodology

Each timed sample runs in a new child process. This provides clean process
memory boundaries and cold-start measurements. A preflight requested with
`--warmup=N` also runs in a disposable process; the artifact labels it
`untimed-cold-preflight` and does not claim that it warms a later V8 isolate.

For each fixture/profile group the harness retains:

- every raw sample;
- first observed incumbent time and strictly improving published-incumbent history;
- `movesAt`, the best published route at 1, 5, 10, 30, 60, and 120 seconds
  (`null` before the first route; a run that ended earlier keeps its final route);
- `phaseTimeline`, the time of each reported phase change, and
  `lowerBoundHistory`, each strict rise of the reported lower bound;
- minimum, median, maximum, and median absolute deviation for elapsed time;
- before/after RSS and `process.resourceUsage().maxRSS` peak RSS;
- solver metrics and all counters;
- replay result, proof bounds, and known-optimum comparison;
- exact limits and mode settings;
- solver, corpus, tuning, board, Git commit, and dirty-worktree identity.

Deterministic samples must agree on status, solution/proof outcome, expanded
states, and generated states. A disagreement rejects the group rather than
silently selecting a median record. Milliseconds are descriptive across
machines; the configured production deadline still gates target acceptance.
Incumbent times measure receipt of published verified progress; terminal replay
provides a fallback. Internally retained improvements without publication remain
invisible. Certificate timing, p95, occupied-worker telemetry, supported/holdout
suites, and isolated browser qualification remain open in the
[performance roadmap](SOLVER-PERFORMANCE-ROADMAP-2026-09-16.md).

## Baseline of record

Solver changes from the 2026-10-03 plan are compared against commit `b392ce8`
(Sokomind 1.3.0, classic A* 2.2.2, classic IDA* 2.2.1). The capture used
`--runs=5 --warmup=0` from clean checkouts on Waterfield c4-standard-32 nodes
(Intel Xeon Platinum 8581C, 16 visible CPUs, Node 22.16.0), one exclusive node
per shard. Ten shards (SLURM jobs 46901-46909 and 46944) cover production
fast/quality/optimal on all 44 fixtures, and the four exact profiles on the 33
fixtures with a frozen optimum: 264 sample groups.

The capture is not promotable. Each shard is a partial run, and Optimal cannot
meet its certificate target on the 10 solvable boards without a frozen optimum,
so those shards exit 2. The artifacts and their merged summary are kept with
the SLURM tooling, outside the repository.

| Profile | Groups | Solved | Proven | At frozen optimum | Median time | Median first route | Peak RSS |
|---|---:|---:|---:|---:|---:|---:|---:|
| `classic-astar` | 33 | 33 | 33 | 33 | 134 ms | 134 ms | 561 MiB |
| `classic-ida-star` | 33 | 32 | 32 | 32 | 273 ms | 273 ms | 493 MiB |
| `sokomind-optimal-astar` | 33 | 33 | 33 | 33 | 1.21 s | 1.17 s | 646 MiB |
| `sokomind-optimal-ida` | 33 | 33 | 32 | 32 | 1.45 s | 1.17 s | 535 MiB |
| `production-fast` | 44 | 43 | 0 | 8 of 33 | 182 ms | 180 ms | 1,134 MiB |
| `production-quality` | 44 | 43 | 0 | 15 of 33 | 1.60 s | 1.75 s | 4,311 MiB |
| `production-optimal` | 44 | 43 | 33 | 33 of 33 | 1.83 s | 1.78 s | 2,863 MiB |

Times are the median over groups of each group's median sample; peak RSS is
the largest group median.

- The unsolved production group is `v2-27box-memory`, which every mode ends as
  exhausted in about 640 ms.
- `expert-tetris` is the only exact miss. Classic IDA* stops at the
  5,000,000 generated-state cap after 38 s, and the Sokomind IDA* profile
  returns an unproven 62-move route; the optimum is 38.
- The largest peak RSS is Quality on `open-field`. Process RSS can pass the
  4 GiB request limit because that limit governs the solver's own memory
  estimate.

Boards without a frozen optimum (median moves and final lower bound over five
runs; Quality and Optimal ran to their 60-second and 120-second deadlines on
every one):

| Fixture | Boxes | Fast | Quality | Optimal | Optimal lower bound |
|---|---:|---:|---:|---:|---:|
| `large` | 6 | 168 (0.26 s) | 150 | 150 | 119 |
| `master-exchange` | 8 | 257 (0.25 s) | 137 | 144 | 91 |
| `master-typed-grid` | 8 | 135 (0.28 s) | 114 | 114 | 70 |
| `open-field` | 10 | 180 (4.1 s) | 143 | 145 | 84 |
| `theme-museum` | 6 | 102 (0.24 s) | 77 | 88 | 54 |
| `theme-parking` | 5 | 170 (0.84 s) | 116 | 120 | 88 |
| `v2-17box-handdesigned` | 17 | 893 (7.5 s) | 491 | 520 | 221 |
| `v2-17box-mirrored` | 17 | 893 (7.2 s) | 499 | 548 | 221 |
| `v2-17box-rotated` | 17 | 893 (7.2 s) | 488 | 546 | 221 |
| `v2-27box-open` | 27 | 1,300 (26.3 s) | 912 | 914 | 397 |

## Phase 1 comparison

Commit `ba44091` (Sokomind 1.6.3, classic A* 2.2.5, classic IDA* 2.2.3) ends
the first phase of the 2026-10-03 plan. It was captured like the baseline of
record, with the same ten shards, settings and node type (SLURM jobs
47075-47084), and compared with `b392ce8` group by group.

| Profile | Groups | Solved | Proven | At frozen optimum | Median time | Median first route | Peak RSS |
|---|---:|---:|---:|---:|---:|---:|---:|
| `classic-astar` | 33 | 33 | 33 | 33 | 92 ms | 92 ms | 565 MiB |
| `classic-ida-star` | 33 | 32 | 32 | 32 | 186 ms | 183 ms | 484 MiB |
| `sokomind-optimal-astar` | 33 | 33 | 32 | 32 | 438 ms | 235 ms | 896 MiB |
| `sokomind-optimal-ida` | 33 | 33 | 32 | 32 | 534 ms | 235 ms | 526 MiB |
| `production-fast` | 44 | 43 | 0 | 8 of 33 | 174 ms | 171 ms | 1,140 MiB |
| `production-quality` | 44 | 43 | 0 | 33 of 33 | 322 ms | 172 ms | 3,794 MiB |
| `production-optimal` | 44 | 43 | 33 | 33 of 33 | 320 ms | 172 ms | 3,074 MiB |

178 of the 264 groups got faster, and the geometric mean of the per-group
median time ratios is 0.505.

- Quality reaches the frozen optimum on all 33 boards that have one, up from
  15, and still reports unknown optimality.
- Quality and Optimal publish the discovery route as soon as it replays.
  Their median first route is 172 ms, down from 1.75 s and 1.78 s; on the
  larger boards it arrives with Fast's route instead of 2 to 5 s later.
- Optimal's median time fell from 1.83 s to 320 ms, and Quality's from 1.60 s
  to 322 ms.

The comparison flagged 13 groups:

- `expert-tetris` lost its proof under `sokomind-optimal-astar`: 38 moves,
  proven in five of five runs, became an unproven 39. Proof-first spent most
  of the profile's 5,000,000 generated-state cap, and the pipeline proof ran
  out of states. Sokomind 1.7.1 skips proof-first when a request sets a state
  limit; a five-round same-node A/B (job 47086) proved 38 again in 20.9 s.
  In exchange, the other 32 groups of that profile and of
  `sokomind-optimal-ida` (job 47087) lose the proof-first speedup (geometric
  mean time ×2.86 and ×2.55). Production profiles and the app set no state
  limit. The same board under `sokomind-optimal-ida` expanded 0.2% more states
  for the same unproven 62-move route.
- Quality took longer on `adv-four-color` (5.2 to 11.2 s) and `expert-tetris`
  (5.2 to 20.0 s), where its exact search finds the optimum (79 to 43 and 53
  to 38 moves).
- Peak RSS rose 11-36% for Quality and Optimal on `large`, `master-exchange`
  and `theme-parking`, where the exact lane or proof-first runs without
  finishing.
- Three flags did not reproduce in same-node reruns: classic IDA* RSS on
  `expert-maze` (job 47089), Fast time on `master-typed-grid` (job 47088) and
  Quality RSS on `v2-17box-handdesigned` (job 47090).

On the boards without a frozen optimum, every mode returns the same median
route as at `b392ce8`, except Optimal on `theme-museum` (88 to 77 moves).
Optimal's final lower bound fell by 1 or 2 on `large` (119 to 117),
`master-exchange` (91 to 90), `theme-museum` (54 to 53) and `theme-parking`
(88 to 87), and rose by 1 on `open-field` and `v2-17box-rotated`.

The capture predates Sokomind 1.7.0 (worker reuse) and 1.7.1. Each was
compared with its base in same-node A/B runs instead.

## Phase 2 comparison

Commit `861ca5d` (Sokomind 1.11.0, classic A* 2.2.5, classic IDA* 2.2.4) ends
the second phase of the 2026-10-03 plan. It was captured with the same ten
shards, settings and node type as the Phase 1 capture (SLURM jobs 47985-47992,
47994 and 48002), and compared with `ba44091` group by group. Seven more shards
(jobs 47995-47998, 48000, 48001 and 48003) ran the two parallel profiles, which
have no earlier capture.

| Profile | Groups | Solved | Proven | At frozen optimum | Median time | Median first route | Peak RSS |
|---|---:|---:|---:|---:|---:|---:|---:|
| `classic-astar` | 33 | 33 | 33 | 33 | 82 ms | 82 ms | 587 MiB |
| `classic-ida-star` | 33 | 32 | 32 | 32 | 164 ms | 159 ms | 465 MiB |
| `sokomind-optimal-astar` | 33 | 33 | 33 | 33 | 707 ms | 234 ms | 636 MiB |
| `sokomind-optimal-ida` | 33 | 33 | 32 | 32 | 975 ms | 242 ms | 625 MiB |
| `production-fast` | 44 | 43 | 0 | 8 of 33 | 182 ms | 181 ms | 1,145 MiB |
| `production-quality` | 44 | 43 | 0 | 33 of 33 | 316 ms | 184 ms | 4,154 MiB |
| `production-optimal` | 44 | 43 | 33 | 33 of 33 | 315 ms | 182 ms | 3,200 MiB |
| `production-quality-parallel` | 44 | 43 | 0 | 33 of 33 | 465 ms | 176 ms | 4,679 MiB |
| `production-optimal-parallel` | 44 | 43 | 33 | 33 of 33 | 470 ms | 180 ms | 7,142 MiB |

46 of the 264 compared groups got faster, and the geometric mean of the
per-group median time ratios is 1.087. Without the two state-capped
`sokomind-optimal` profiles, whose proof-first speedup Sokomind 1.7.1 removed
on purpose, it is 0.955.

- `sokomind-optimal-astar` proves `expert-tetris` again: 38 moves in five of
  five runs. Under `sokomind-optimal-ida` the same board's route fell from 62
  to 39 moves, still unproven.
- The classic kernels expand the same states in less time: the geometric mean
  is 0.895 for classic A* and 0.876 for classic IDA*.
- Quality's median route improved on five boards without a frozen optimum:
  `large` 150 to 148, `master-exchange` 137 to 132, `theme-museum` 77 to 71,
  `v2-17box-mirrored` 499 to 493 and `v2-27box-open` 912 to 908.
- Fast's median time and first route are about 10 ms later (174 to 182 ms
  and 171 to 181 ms, geometric mean 1.024), with no Fast group flagged.
- The parallel profiles prove and reach the same boards as their single-lane
  counterparts and return the same median routes, except Quality on
  `v2-27box-open` (904 moves instead of 908).

The comparison flagged 75 groups:

- 65 are in the `sokomind-optimal` profiles. Their time and state flags come
  from Sokomind 1.7.1, described in the Phase 1 comparison; against that
  change's own A/B (jobs 47086 and 47087), `861ca5d` expands the same states
  and is as fast or faster. Their 39 peak RSS flags come from Sokomind 1.7.0's
  worker reuse. A same-node A/B with 1.7.1 on both sides (job 48005, nine
  boards, three rounds) measured 74-152 MiB more per run (+23% to +52%) and
  a time geometric mean of 0.843. The rest of Phase 2 changed neither (job
  48006: no flags).
- `v2-27box-memory` used about 45 MiB more in all three production modes
  (218 to about 265 MiB) while finishing sooner (629 to 550 ms). Same-node
  reruns reproduced it (jobs 48007 and 48008), and worker reuse alone accounts
  for it (job 48010, `ba44091` against the 1.7.0 merge: +41 to +58 MiB, time
  geometric mean 0.853).
- Seven flags did not reproduce in same-node reruns: Optimal peak RSS on
  `master-exchange`, `open-field` and the mirrored and rotated 17-box boards,
  Quality peak RSS on `large` and the rotated 17-box board (jobs 48007 and
  48008, +0.3% to +5%), and classic IDA* RSS on `expert-tetris` (job 48009,
  +1.5%).

On the boards without a frozen optimum, Fast and Optimal return the same median
routes as at `ba44091`. Optimal's final lower bound rose by 1 on `large` (117
to 118), `theme-museum` (53 to 54) and `v2-17box-mirrored` (221 to 222).

With the app's proof workers, the final lower bound on most heavy boards stays
far below the single-lane bound: 1 to 9 on `master-exchange`,
`master-typed-grid`, `open-field`, `theme-museum`, `theme-parking`, the 17-box
boards and `v2-27box-open`, against 54 to 397 with one lane. `large` is the
exception at 123. The parallel proof reports the minimum over its partitions,
and a partition that no lane has started counts only the moves that lead to
it.
The bound is sound but weak. On `theme-parking` it fell from 74 to 7 when the
proof started keeping fewer A* lanes (job 47199).

### Fast race beside the structural head start

Sokomind 1.12.0, merged after this capture, runs Fast's discovery beside the
structural head start. A same-node A/B (job 48085, `wf-c4-standard-32-5`,
three interleaved rounds of `production-fast`) compared it with `2e629de` on
the ten structural boards:

| Board | Moves | Median time | Peak RSS |
|---|---:|---:|---:|
| `open-field` | 180 → 176 | 4,091 → 537 ms | 379 → 371 MiB |
| `v2-27box-open` | 1,300 | 26.1 → 5.3 s | 1,173 → 1,004 MiB |
| `v2-17box-handdesigned` | 893 | 7.0 → 7.4 s | 505 → 1,246 MiB |
| `v2-17box-mirrored` | 893 | 6.8 → 7.2 s | 496 → 1,170 MiB |
| `v2-17box-rotated` | 893 | 6.8 → 7.1 s | 489 → 1,068 MiB |

On `large`, `master-exchange`, `master-typed-grid`, `theme-museum` and
`theme-parking`, routes did not change, median times stayed within 1%, and
peak RSS stayed within 5%. On the 17-box boards structural search still finds
the route, and the discovery lanes beside it hold 580 to 740 MiB more for about
7 s. That cost was accepted for the two wins.

Two other lane sets were measured against a race that ran the guided push
portfolio beside the forward and reverse frontiers. The portfolio alone lost
both wins (job 47952): `v2-27box-open` was unsolved at 30 s, and `open-field`
went back to 180 moves at 4.3 s. The frontiers alone kept both wins with less
memory (job 47954): `v2-27box-open` fell from 1,300 to 989 MiB, and the 17-box
boards from 1,441-1,634 to 1,079-1,219 MiB. Sokomind 1.12.0 runs the frontiers
first and starts the portfolio only if they end without a route.

## Phase 3 comparison

Commit `edbeed6` (Sokomind 1.13.7, classic A* 2.2.11, classic IDA* 2.2.11)
ends the third phase of the 2026-10-03 plan. It was captured with the same
seventeen shards, settings and node type as the Phase 2 capture: ten
single-lane shards (SLURM jobs 48370-48379) and seven parallel shards (jobs
48380-48386). Each group was compared with the `861ca5d` capture.

| Profile | Groups | Solved | Proven | At frozen optimum | Median time | Median first route | Peak RSS |
|---|---:|---:|---:|---:|---:|---:|---:|
| `classic-astar` | 33 | 33 | 33 | 33 | 78 ms | 78 ms | 448 MiB |
| `classic-ida-star` | 33 | 32 | 32 | 32 | 158 ms | 156 ms | 358 MiB |
| `sokomind-optimal-astar` | 33 | 33 | 33 | 33 | 665 ms | 219 ms | 620 MiB |
| `sokomind-optimal-ida` | 33 | 33 | 32 | 32 | 909 ms | 218 ms | 623 MiB |
| `production-fast` | 44 | 43 | 0 | 8 of 33 | 168 ms | 165 ms | 1,233 MiB |
| `production-quality` | 44 | 43 | 0 | 33 of 33 | 298 ms | 165 ms | 3,726 MiB |
| `production-optimal` | 44 | 43 | 33 | 33 of 33 | 297 ms | 165 ms | 3,281 MiB |
| `production-quality-parallel` | 44 | 43 | 0 | 33 of 33 | 449 ms | 164 ms | 4,269 MiB |
| `production-optimal-parallel` | 44 | 43 | 33 | 33 of 33 | 445 ms | 165 ms | 6,966 MiB |

25 of the 264 single-lane groups got faster, and the geometric mean of the
per-group median time ratios is 0.917. Every profile's geometric mean is below
1, from 0.875 for Fast to 0.949 for classic IDA*. Of the 88 parallel groups,
21 got faster, with a geometric mean of 0.919.

- Every proven group is still proven at the same move count. Every median
  route matches `861ca5d` except two. Fast on `open-field` fell from 180 to
  176 moves, from the structural race described above. Quality's median on
  `v2-27box-open` rose from 908 to 914 moves, but its runs overlap (904-914
  against 912-914), and a same-node A/B (job 48392) returned 912 moves on both
  sides.
- Lazy extras make classic A* much faster where the extras dominate, on the
  same expanded states: `adv-four-color` went from 10.7 to 4.1 s and
  `expert-tetris` from 17.5 to 9.6 s. Quality and Optimal prove these boards
  with classic A*, so they gain about the same: 10.5 to 4.1 s and 17.3 to
  9.0 s. The parallel profiles finish them in 2.4 s (from 3.4 s) and 7.6 s
  (from 12.8 s).
- Classic IDA* expands fewer states on 21 of 33 boards, and
  `sokomind-optimal-ida` on 18.
- In the same 120 s, Optimal expands up to twice as many states on the
  heavy boards: `master-exchange` 254k to 456k, `theme-museum` 356k to 726k
  and `master-typed-grid` 191k to 352k. Its final lower bound rose on all ten
  boards without a frozen optimum: `large` 118 to 121, `master-exchange` 90 to
  92, `master-typed-grid` 70 to 72, `open-field` 85 to 86, `theme-museum` 54
  to 55, `theme-parking` 87 to 90, the 17-box boards from 221-222 to 222-223,
  and `v2-27box-open` 397 to 399.
- Fast's geometric mean is 0.875, but Phase 3 changed little that Fast runs.
  A same-node A/B on four heavy boards (job 48393, `a11ac44` against
  `edbeed6`) measured 1.005 with no flags, so most of that difference is node
  to node.

The comparison flagged 15 single-lane groups and 4 parallel groups:

- Eight state flags in the exact profiles, on `adv-four-color`,
  `adv-rotary`, `corridor-2`, `expert-maze` and `expert-tetris`. Every one of
  these runs was as fast or faster. Phase 3's bound and ordering changes shift
  which equal-cost nodes are expanded first, so a few boards expand slightly
  more states, at most 4% (`corridor-2` under `sokomind-optimal-astar`, 20,504
  to 21,359).
- Peak RSS under `sokomind-optimal-astar` on `theme-library` (376 to 431 MiB)
  and `corridor-2` (470 to 537 MiB). The `corridor-2` runs overlap. A
  same-node A/B on `theme-library` (job 48387) measured +4.5%, in line with
  the 5% that lazy extras added in its own equal-work A/B (job 48286).
- Fast time on `large`, `theme-parking` and the hand-designed and mirrored
  17-box boards, and Fast peak RSS on all three 17-box boards. The RSS is the
  structural race described above, which this capture includes and `861ca5d`
  does not. The same-node A/B above (job 48393) found no Fast slowdown from
  the rest of Phase 3.
- Optimal peak RSS on `master-typed-grid` (+10%), with 85% more states
  expanded in the same 120 s, and parallel Optimal peak RSS on `open-field`
  (+10%, with 16% more states).
- Parallel Optimal peak RSS on `v2-27box-open` (5,366 to 6,134 MiB). A
  same-node A/B (job 48394) reproduced it at +16%. The pattern databases were
  the same size on both sides. In the same 120 s, the IDA* lanes reached 67%
  more unique states and kept 77% more cached heuristic values.
- Parallel Quality peak RSS on the hand-designed and rotated 17-box boards
  (+13% and +12%). Neither reproduced in same-node A/B runs (jobs 48395 and
  48396): the runs overlapped, and on the hand-designed board `861ca5d` itself
  peaked at 3,283 to 3,320 MiB.

With the app's proof workers, the final lower bound rose on most heavy boards:
`large` 123 to 138, `open-field` 9 to 13, the 17-box boards from 2-7 to 8,
`master-exchange` 5 to 7, `theme-museum` 4 to 6 and `v2-27box-open` 2 to 4.
`master-typed-grid` stayed at 1, and `theme-parking` fell from 7 to 3 while
its proof expanded twice as many states (3.9M to 7.9M). The bound is still far
below the single-lane bound, for the reason given in the Phase 2 comparison:
it is the minimum over the partitions, and a partition no lane has started
counts only the moves that lead to it.

## Controlled feature A/B runs

Use `--compare-feature` with exact profiles:

```text
npm.cmd run benchmark:solver:v2 -- --fixture=inter-rooms --profile=classic-astar --profile=classic-ida-star --compare-feature=patternDatabase --runs=5 --warmup=0
```

Accepted names are:

- `incrementalAssignment`
- `linearConflict`
- `interactionBoost`
- `patternDatabase`
- `forcedPushMacros`
- `piCorralPruning`
- `patternDeadlockPruning`
- `deadlockTablePruning`
- `goalCommitmentPruning`
- `tunnelMacros`

The harness creates a matched control and `without:<feature>` variant. Every
other feature, board, solver, limit, and deterministic setting stays identical.
It refuses Sokomind discovery profiles for this mode because those profiles do
not expose the exact-kernel vector directly.

A pair is valid only when both sides replay and prove the expected optimum and
the disabled side reports zero exercise for the selected mechanism. A benefit
classification additionally requires a nonzero control-side exercise counter.
Results are classified as improvement, regression, mixed, no effect,
inconclusive/not exercised, or invalid correctness. Expanded/generated deltas
are deterministic; timing uses the sample median. Median elapsed and peak RSS
receive explicit qualification thresholds. A material regression in either is
a resource veto: it prevents an apparent state-count reduction from being
accepted as an uncomplicated improvement, and conflicting directions are
reported as mixed evidence.

The September 4, 2026 `inter-rooms` PDB smoke results were replay-valid and
proven on both sides, with identical work: A* expanded 312 and generated 1,433
states, while IDA* expanded 2,831 and generated 12,738. In one five-run cold
capture, the PDB-on/PDB-off medians were 196/185 ms for A* and 902/892 ms for
IDA*. PDB construction retained 56,698 extra estimated bytes. Both
fixture/algorithm pairs classify as no effect for PDB; this partial, dirty-tree
smoke capture does not justify an efficiency claim.

The deterministic tunnel-macro prototype also produced no state-count change
on the original four-fixture sample:

| Fixture | Visited before | Visited after | Generated before | Generated after |
| --- | ---: | ---: | ---: | ---: |
| `beginner-three` | 13 | 13 | 30 | 30 |
| `classic-1` | 46 | 46 | 177 | 177 |
| `box-7x7` | 44 | 44 | 437 | 437 |
| `expert-maze` | 381 | 381 | 1,715 | 1,715 |

The result justified preserving the additive implementation for corridor-heavy
coverage, but it did not establish a performance win. A later single-push
replacement was unsound and has been removed; the macros are additive again and
`tunnelMacros` defaults off.

## Historical Grand Hall discovery experiments

These deterministic captures explain the structural reserve and guard policy
retained by the discovery engine. All listed solutions replayed successfully.
Elapsed time is descriptive for the development machine and not a portable
gate.

| Case | Moves | Pushes | Visited | Generated | Retained | Peak frontier |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Former fast baseline | 1,066 | 322 | 1,616 | 9,329 | 3,077 | 330 |
| Current first found | 893 | 278 | 1,329 | 8,425 | 2,538 | 291 |
| After quality rewrite | 789 | 270 | 29,000 | 108,722 | 29,000 | 1 |

Base, mirrored, and 180-degree-rotated Grand Hall produced the same 893/278
route metrics and counters. Direct Node runs took about 5.3-7.2 seconds by
orientation. The rewrite is not part of fast mode.

| Experiment | Result | Decision |
| --- | --- | --- |
| Original branch policy plus stranded hard guard | 1,066 / 322 | Baseline |
| Distinct-box reserve only | 1,020 / 288, more generated work | Incomplete alone |
| Guard relaxation only | Cutoff at 5,043 visited / 30,659 generated | Reject alone |
| Reserve plus guard relaxation | 893 / 278, less search than baseline | Retain together |
| One enabling handoff per box | Cutoff at 54,942 generated | Revert |
| Persistent agenda-resumption slot | 1,121 / 322 | Revert |
| Macro alternate-approach reserve | Cutoff at 27.5 s | Revert |
| Move-aware macro arrival diversity | Cutoff at 20.6 s | Revert |
| Temporary-goal penalty | 918 / 278, more search | Revert |
| Remove temporary goals from milestone identity | Cutoff at 5,025 visited / 39,580 generated | Revert |

The retained structural predicate uses topology and branch pressure rather than
puzzle identity or dimensions. Representative generalization results were:

| Puzzle | Before moves / pushes | After moves / pushes |
| --- | ---: | ---: |
| `gen-expert-057` | 109 / 24 | 87 / 24 |
| `gen-master-090` | 90 / 28 | 86 / 28 |
| `gen-expert-335` | 341 / 95 | 195 / 43 |

Across a reviewed 15-puzzle room-bearing structural corpus, the combined policy
produced four wins, eight ties, and three losses while reducing aggregate moves,
pushes, and generated states. Large room and packing boards remain the principal
regression class.

## September 5 flagship solver audit

The product target is a replay-valid Grand Hall solution of at most 650 moves
within 3 seconds in the browser. The reported browser baseline is 893 moves in
4.3 seconds. A subsequently supplied human route was strictly replayed in
626 moves / 248 pushes. It is a verified upper bound, not an established optimum.
The target requires 243 fewer moves (27.2%) and 30.2% less elapsed time relative
to that reported baseline. No experiment below achieved the target.

### Measurement boundary

Local measurements used Node 24.14.0 on Windows with an AMD Ryzen 7 9800X3D.
Each timed case ran in a fresh process, sequentially. These timings do not
establish browser performance. All reported successful routes passed independent
core replay. Production source and tuning were not changed by this audit.

The production V2 fast adapter returned 893 moves / 278 pushes in all three
samples: 5,592, 5,614, and 5,477 ms (median 5,592 ms). Reproduce with:

```text
npm.cmd run benchmark:solver:v2 -- --fixture=huge --profile=sokomind-fast --runs=3 --warmup=0
```

Isolated kernel experiments used the Grand Hall performance gate's structural
payload, including `planSolutionComparisonBudget: 0`, beam width 32, six box
branches, and targeted macro effort 64. Except for the repeated permutation
case and paired traversal experiment below, these are single samples and cannot
establish reliable timing improvements.

| Experiment | Moves | Pushes | Kernel time | Outcome |
| --- | ---: | ---: | ---: | --- |
| Fast control | 893 | 278 | 5.315 s | Replay valid |
| `planMoveWeight: 0.02` | 885 | 278 | 5.419 s | Small quality gain |
| `planMoveWeight: 0.05` | 889 | 278 | 5.107 s | Small quality gain |
| `planMoveWeight: 0.1` | 1,072 | 298 | 10.592 s | Worse quality and time |
| Beam width 16 | — | — | 12.043 s | Cutoff |
| Targeted and sequence macro effort 32 | — | — | 16.943 s | Cutoff |
| Canonicalize incumbent only | 893 | 278 | 0.093 s additional | No improvement |
| Permutation rewrite and final canonicalization | 833 | 274 | 0.703 / 0.695 s additional | Repeatable quality gain |
| Full reviewed rewrite | 789 | 270 | 7.226 s additional | 29,000 visited; no move-window gain |

Rewrite cases start from the same saved 893-move incumbent. The permutation
case uses 10,000 visited states, windows of 8/16/32 pushes, and a 1,500-state
per-window cap, with push-bridge and move-bridge budgets zero. It reports eight
permutation improvements; final canonicalization can also remove pushes.
The full rewrite uses the executable Grand Hall guardrail's settings. Its
4,000-state move-window probe found no improvement. Simply normalizing walks
does not improve the original route: scheduling and box trajectories matter.

### Search-quality constraints

The structural planner is intentionally incomplete, and several mechanisms
favor pushes over the user's move objective:

- `scoreCandidate` adds pushes at full weight and total moves at only 0.005.
  Two hundred additional moves therefore contribute the same score increment
  as one push, before the other structural terms.
- First-push ranking does not include keeper walking cost. Targeted macro
  priority and endpoint ranking also favor push count; changing the outer
  weight alone does not change these decisions.
- `planArrivalDominates` prefers fewer pushes even when that arrival took more
  moves. The default region identity also merges keeper positions. This is
  useful for bounded push discovery but can discard better move solutions.
- When long macro endpoints exist, only the first two selected first pushes
  retain their ordinary one-push alternative. Useful intermediate handoffs can
  disappear before the outer beam has a chance to compare them.
- Fast mode accepts the first solution. The current full rewrite mostly
  repairs small fixed-endpoint windows rather than reconsidering an entire
  room-transfer agenda.

Relevant owners are `solver-search.js`, `push-generation.js`, and
`heuristic.js` under `src/solver/implementations/sokomind-engine/source/`.
Earlier globally enabled arrival-diversity experiments already regressed this
board; do not repeat them without a narrower hypothesis and bounded budget.

### Verified human reference

`tests/fixtures/solver-v2/grand-hall-reference.json` preserves the supplied
626-move route, its provenance, and board revision `puzzle-v1:9ead120a`.
`tests/unit/grand-hall-reference.test.ts` checks strict replay, exact move/push
counts, and mirrored/rotated equivalents. It is intentionally separate from the
known-optima map and is not a production route lookup.

| Route metric | Fast solver | Human reference | Reduction |
| --- | ---: | ---: | ---: |
| Moves | 893 | 626 | 267 |
| Pushes | 278 | 248 | 30 |
| Walks | 615 | 378 | 237 |
| Switches between pushed boxes | 37 | 33 | 4 |
| Box-work phases revisiting a box | 21 | 17 | 4 |
| Cross-zone pushes | 32 | 28 | 4 |

Walking accounts for 88.8% of the move-count gap. The reference does not merely
avoid all detours: it has five measured reversal episodes versus three and
seven measured assignment misdirections versus five. These observational
signals must not become blanket penalties against strategic staging.

The largest per-box discrepancy is typed box H, initially at row 7, column 10
(zero-based): the solver pushes it 46 times versus 14 in the reference. Walking
immediately preceding its pushes totals 95 versus 15. The generic box initially
at row 12, column 4 takes 36 pushes versus 19, with 91 versus 56 preceding walks.
These are useful diagnostic targets, not independently recoverable savings:
box work interacts, and the reference spends more pushes on some other boxes.
For example, typed B takes 34 pushes in the reference versus 22 in the solver.

The next quality experiment should trace H's staging and the room-transfer
agenda, then determine which reference handoffs are absent from generated
macros or lost at pruning/beam selection. Increasing move weight alone cannot
recover a route that was never retained. The 650-move target allows just 24
extra moves over this verified reference; its runtime feasibility remains open.

### CPU and allocation findings

A separate CPU-profiled fast run returned the same route and counters. It
reported 1,329 visited states but 356,609 macro intermediate states, 187,561
reachability calls, 8,975 full macro expansions, and zero cheap macro expansions.
The adaptive cheap path is restricted to forced macros on boards with at most
four boxes, so it does not reduce Grand Hall's 17-box workload.

The sampled self-time leaders included sealed-corral detection (11.2%),
reachability (6.2%), garbage collection (6.0%), and `floorNeighbors` (6.0%).
Nested timings reported approximately 1.12 s in doorway scheduling, 0.50 s in
reachability, 0.51 s in dynamic deadlocks, and 0.46 s in heuristics. These
measurements overlap and must not be added together. Parsing and graph
compilation together took only about 35 ms in that capture.

A temporary copy of the generated engine replaced only the `crossingAccessible`
loop in `doorwayScheduleState`: traverse `board.dense.neighbors` and map cell IDs
through `board.dense.keys` instead of calling `floorNeighbors` for every queue
entry. Three alternating cold-process control/prototype pairs measured:

| Pair | Control | Dense doorway traversal |
| --- | ---: | ---: |
| 1 | 5,447 ms | 4,804 ms |
| 2 | 5,365 ms | 4,644 ms |
| 3 | 5,262 ms | 4,708 ms |

Median time improved 12.2%. Every run retained 893 moves / 278 pushes and
1,329 visited / 8,425 generated, with successful replay. This is a promising
prototype at the time of the audit. The subsequent analysis upgrade below
integrates the approach in the source modules. Browser benefit and memory
benefit remain unmeasured.

### Integrated pre-search analysis upgrade

The prepared board now compiles ordered room cells, dense membership masks,
doorway IDs, and staging IDs once. Search reuses that geometry for its existing
doorway checks. Prepared seeds carry the geometry across worker boundaries;
older seeds compile it on hydration. The structural beam's scoring and hard
pruning policies are unchanged.

Analysis now also exposes a bounded advisory `transportPlan`, described in
[Solver integration](solver-integration.md). This records full allowed goal
domains, mandatory per-box transfers, initial push move costs, shared-doorway
blockers, and up to four relaxed parking candidates per box. Parking guidance
does not yet affect production search ordering and is not a safety proof.

Three alternating cold-process comparisons against the pre-upgrade engine
measured 5,370/5,335/5,283 ms before and 4,898/4,567/4,770 ms after. Median
kernel time improved **10.6%**, from 5,335 to 4,770 ms. All six routes replayed
at 893 moves / 278 pushes with identical visited/generated counters. These
kernel timings exclude the separate analysis worker and do not establish
browser performance or a route-quality improvement.

Three fresh production V2 fast-adapter samples, including board analysis and
worker execution, measured 4,831/4,890/4,883 ms (median 4,883 ms), all returning
the same verified 893/278 solution. The earlier pre-upgrade production median
was 5,592 ms; these non-interleaved samples are supporting evidence, while the
paired kernel comparison is the controlled speed measurement.

The executable Grand Hall gate also passed base, mirrored, and rotated cases
with exact reviewed counters, including the unchanged 789-move quality rewrite.
Differential traversal tests compare every state of the 626-move human route,
empty and fully occupied boards, and fresh/current/older prepared-board forms.

### Goal-transit prerequisite analysis

The next analysis pass models each goal as permanently occupied and recomputes
relaxed push routes, including the keeper support squares needed for a push.
It retains every compatible target instead of pinning a matching. The resulting
`transportPlan.goalTransit` identifies conditional final-placement prerequisites
and release regions; it does not require the prerequisite box to finish first.

For Grand Hall, it identifies H's goal at `7,4` as blocking G's escape from
`7,2`. The release frontier is `5,4` or `9,4`. Tests check this relation under
mirroring and rotation, its clearance in the 626-move reference, an already
solved board, and a compatible alternative goal inside the pocket.

Seven alternating warm Node analysis samples (one warmup per implementation)
measured a median of 79.58 ms before and 84.75 ms after, approximately 5.17 ms
of additional analysis. These are analysis-only measurements on this machine,
not browser or whole-solver timing claims.

This dependency is **not yet used to change default search ordering**. Local
prototypes that penalized premature goal occupation returned 910–922 moves;
adding keeper approach distance to first-push ranking produced cutoffs or a
922-move route. Deferring goal tasks and substituting temporary destinations
also regressed; the latter produced 1,216 moves. None of those experimental
search changes are retained. The reviewed 893-move discovery and 789-move
rewrite guardrails remain unchanged. Release-aware macro scheduling needs a
measured win before promotion; the analysis upgrade alone does not achieve
the 650-move/3-second target.

### Executable strategic planning experiments

The analyzer now has an experimental path through task simulation, adaptive
interaction groups, serialized verified prefixes, and structural search.
Production defaults remain unchanged. See
[the integration contract](solver-integration.md#strategic-planning).

Run isolated Node kernel comparisons with separate analysis and search timing:

```text
npm.cmd run benchmark:solver:analyzer -- --ids=huge --budgets=0,100,250,500,1000 --search-ms=3000
npm.cmd run benchmark:solver:analyzer -- --ids=huge --budgets=0,250 --runs=3 --search-ms=0 --rewrite
```

The second command is explicitly an unlimited-search quality experiment.
Search-based rewriting does not yet have a cooperative deadline; the runner
rejects combining `--rewrite` with a nonzero search deadline. Each sample gets
a fresh process and a 90-second external watchdog. Results include full
analysis time, planning counters, accepted prefixes, discovery/rewrite times,
verification, and peak process RSS. These are not production browser timings
or a full-corpus promotable baseline.

Three alternating preliminary Grand Hall comparisons reproduced 789 moves /
270 pushes for the control rewrite and 780 moves / 250 pushes for the planned
rewrite. The planned discovery was 894 moves / 262 pushes, compared with the
control's 893 / 278. Thus fewer pushes did not improve discovery move count.
Those initial runs spent about 283–289 ms in analysis; subsequent geometry reuse,
shared analysis timing, and bounded distance caching reduced a follow-up to
about 246 ms with the same 780-move rewritten result. Discovery and rewriting
still took roughly 6 and 6–7 seconds respectively. The 650-move/three-second
search target remains unmet.

A five-puzzle, fixed structural-kernel smoke comparison at a three-second
search limit gave these verified move counts (not the adapter's full portfolio):

| Puzzle | Control | Experimental |
|---|---:|---:|
| beginner-three | 7 | 8 |
| classic-1 | 45 | 43 |
| adv-gallery | 31 | 29 |
| expert-maze | 231 | 231 |
| huge | cutoff | cutoff |

These mixed results do not justify promotion. A dedicated browser test verifies
that separate workers can exchange the plan package and replay a complete
two-box solution without discovery expansions. Chromium and WebKit passed;
Firefox failed to launch on the test machine with an SWGL framebuffer error,
before solver code ran. This is correctness coverage, not browser benchmarking.

### Tuning objective defect

The older `scripts/benchmark-sokomind-solver.ts` fitness uses
`movesBudget = boxes * floor * 0.3`. Grand Hall's 17 boxes and 127 floor cells
produce 647.7, so both 893 and 650 moves score zero. Its elapsed multiplier is
also one whenever the run finishes within the timeout. This metric cannot
reward most of the requested quality improvement or any successful-run speedup.
The V2 harness reports raw timing and route quality separately and does not
depend on that scalar fitness.

For current open work and promotion criteria, see the
[active solver plan](plans/solver.md).

## Consolidated experiment conclusions

### Grand Hall diagnosis (removed doc)

The 267-move gap between discovery (893) and reference (626) is 30 pushes plus
237 walks. Keeper pathfinding is already optimal within each route's fixed push
sequence — the gap requires different box positions, push directions, or task
ordering. Box H is the primary divergence: 46 pushes versus 14 in the
reference due to premature commitment and costly un-fill/re-fill. No
single-push checkpoint intervention tested produced an improvement. Heuristic
changes must not be promoted until an independently generated continuation
demonstrates a real cost reduction. Reproduce with
`scripts/report-grand-hall-diagnosis.mjs`.

### Grand Hall route accounting (removed doc)

Three routes verified: discovery 893/278, rewrite 789/270, reference 626/248
(moves/pushes). Shortest keeper paths within each fixed push sequence show
zero excess walking for discovery and rewrite. H is the dominant cost driver
(46 pushes/95 walks in discovery versus 14/15 in reference). Individual
per-label differences are not independently recoverable savings. The reference
is a witness, not an optimality proof. Reproduce with
`scripts/diagnose-grand-hall.mjs`.

### Planner branch diversity (removed doc)

Widening the structural planner's first-push branch allowance beyond the
default of 6 does not help Grand Hall and actively harms it: allowance 8
yields 1,116 moves; allowances 10/12/16 exhaust the frontier or budget. The
reference's opening direction ranks 21st of 27 candidates at 16 branches and
is never selected. Wider branching is not monotonic — new macro candidates
displace useful states. Not accepted as a production default.

### P1 tuning experiments (removed doc)

Three controlled A/B experiments across the 43-fixture corpus, each toggling
one parameter. All three leave solution quality (moves, pushes, solve status)
identical — only timing changes. **macroIntermediateQuota**: no measurable
effect. **moveAwareDiscovery**: mixed — 6.1% faster on large typed-grid
puzzles but +19.1% regression on maze-style; worth investigating
class-specific activation. **firstPushWalkWeight**: net negative, +4.6%
aggregate slowdown. All three remain correctly defaulted to disabled.

## Schema 4

Top-level fields include environment identity, methodology, profile definitions,
corpus/tuning fingerprints, partial/full coverage, promotability, raw result
groups, and optional A/B comparisons. Schema 4 added the per-sample `movesAt`,
`phaseTimeline`, and `lowerBoundHistory` fields, removed the state caps from the
production targets, and added `v2-27box-open`. Child validation recomputes
`movesAt` from the incumbent history and rejects timelines that are out of
order, outside the run, or not strictly changing.

`promotableBaseline` is true only when:

- the full 44-fixture/default-profile matrix was requested;
- every eligible pair is present exactly once as a sample group;
- all groups are deterministic and accepted;
- at least five timed samples were captured per group;
- Git resolved a full commit identity and the worktree was clean; and
- the run is not a feature-ablation capture.

Partial smoke runs remain useful evidence but cannot be mislabeled as full
baselines.

## Artifact policy

`tests/fixtures/solver-v2/baseline-v0.json` is a historical schema-2 artifact.
It covers only the older subset and older solver versions. Keep it immutable.

Use a new versioned filename for each reviewed capture. Existing files are not
overwritten unless the operator deliberately passes `--force`:

```text
npm.cmd run benchmark:solver:v2 -- --save=tests/fixtures/solver-v2/baseline-v4-YYYYMMDD.json
```

The SLURM wrapper includes the job ID and UTC timestamp in its output filename.

## Memory smoke test

The separate classic A* memory runner now consumes the flat corpus correctly:

```text
npm.cmd run benchmark:solver:memory -- --fixture=ultra-tiny
```

It is a focused diagnostic, not the schema-4 baseline format. Prefer the V2
harness when comparing production profiles or feature vectors.

## Exit behavior

- Exit 0: every requested deterministic sample group was accepted.
- Exit 1: argument, child protocol, or artifact-write failure.
- Exit 2: the capture completed, but one or more sample groups failed
  correctness or consistency acceptance.

JSON is emitted even for rejected completed captures so the failure remains
inspectable.


## Persistent strategic execution sprint 1

September 7, 2026: the V2 task package is now consumed after seeding and rebound
at verified checkpoints. This is an experimental architecture integration;
**its quality gate has not passed**. Both strategic preparation and persistent
execution remain off by default. Preparation alone retains seed-only execution.

Enable the integrated path with request options:

```ts
options: {
  "sokomind-solver": {
    strategicAnalysisMs: 250,
    strategicPlanExecution: true,
  },
}
```

The initial contract covers release/export/stage/commit tasks, box-at-cells and
cells-clear predicates, hypothesis-scoped provenance, and resource availability
between consumer enablement and completion. Runtime changes are advisory ordering
and recovery reservations, not new hard pruning. No full causal repair or
fixed-point resource/assignment inference is implemented yet.

Matched, alternating, isolated Node runs use the same preparation allowance and
kernel settings for seed-only (execution off) and persistent execution (on).
The [raw results](benchmarks/strategic-execution-sprint1.json) record environment,
engine/harness hashes, counters, preparation time, and replay verification.

| Puzzle | Execution | Moves / pushes | Expanded / generated | Search time, two runs |
|---|---|---|---|---|
| expert-maze | off | 231 / 26 | 370 / 1,618 | 240–249 ms |
| expert-maze | on | 107 / 28 | 210 / 900 | 173 ms |
| Grand Hall | off | 894 / 262 | 1,446 / 10,978 | 6,099–6,183 ms |
| Grand Hall | on | 1,009 / 284 | 1,973 / 14,654 | 6,252–6,297 ms |

Analysis took 45–47 ms for the maze and 245–251 ms for Grand Hall. Every returned
solution passed replay. The maze saves 126 walking moves (205 to 79), but Grand
Hall gets worse, so this does not justify promoting the new execution policy.
These are kernel experiments, not production-adapter or browser performance
claims. The previously recorded production maze result uses different settings.
An exploratory rewrite of the 1,009-move Grand Hall path reached 797 moves / 264
pushes in another 5.4 seconds; it does not meet the 650-move/search-time objective.

Reproduce the matched experiment:

```powershell
npm.cmd run benchmark:solver:analyzer -- --ids=expert-maze,huge --budgets=250 --runs=2 --search-ms=0 --execution=both
```

`--execution=both` alternates seed-only and persistent execution; preparation
remains identical in configuration. `--search-ms=0` removes only the wall-clock
search cutoff, retaining existing work/segment limits. Use `--search-ms=3000`
for the strict search allowance. Rewrite experiments remain separate because the
rewriter does not yet implement that cooperative deadline.

Next acceptance work: improve connected transit/staging inference and remaining
walking estimates, then rerun the mechanism corpus and browser Grand Hall gate.
Do not treat more completed tasks as evidence of better solutions.

Sprint validation: 2,353 unit tests, nine static-build checks, type checking,
lint, documentation validation, and production build pass. The fresh-worker
V2 handoff and seed-free execution test passes in Chromium and WebKit. The
default Grand Hall regression retains 893 moves / 278 pushes, 1,329 expanded,
8,425 generated, 2,538 retained, and peak frontier 291 in base/mirrored/rotated
orientations; its rewrite remains 789 / 270. All four production multi-puzzle
regressions pass. These checks establish integration and default preservation,
not browser performance acceptance for the experimental policy.
