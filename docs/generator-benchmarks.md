# Generator benchmarks and qualification evidence

This guide owns generator measurements, reproducible qualification examples,
and throughput results. Benchmarks only create review evidence; catalog
installation is a separate promotion step. Automated evidence does not
establish human enjoyment or solution optimality.

## Commands

```powershell
npm.cmd run measure:generator -- --attempts 32 --seconds 60 --workers 8
npm.cmd run benchmark:generator -- --workers 1,4,8,12,15 --attempts 64 --repeats 3
npm.cmd run verify:generator-quality
npm.cmd run verify:generator-tiers
```

The measurement harness records revision and dirty state, hardware,
configuration, completed checkpoints, witnesses, and per-tier summaries in a
new output directory. A time limit makes a run incomplete; it does not mean
zero yield. Qualified checkpoint candidates still require finalist selection,
catalog diversity checks, independent release verification, and human review.

The worker benchmark uses identical seeds and gates at every concurrency and
requires matching boards, routes, quality reports, and rejection decisions
before recommending a worker count. Use `--output path.json` to save a report;
existing reports are not overwritten.

## Current all-tier evidence

The fixed eight-attempt baseline completed at every tier on September 3, 2026:

| Tier | Qualified candidates |
| --- | ---: |
| Beginner | 3 |
| Intermediate | 0 |
| Advanced | 0 |
| Expert | 0 |
| Master | 0 |

The fresh 128-attempt seed window at offset 10,000 produced 45 Beginner, 30
Intermediate, 23 Advanced, and 16 Expert qualified candidates. Master reached
the 240-second run limit with 12 qualified checkpoints; unfinished jobs had no
recorded outcome. Recovery plus the earlier Master example produced a
five-puzzle Master selection. That historical five-per-tier review set passed
the automated release gate. The current production catalog is a later
38-puzzle selection: 10 Beginner, 10 Intermediate, 7 Advanced, 6 Expert, and 5
Master puzzles. The repository does not retain a completed `human-review.json`
for either selection, so these benchmark records do not prove human approval.

`verify:generator-tiers` regenerates or replays one independently verified
example at each tier:

| Tier | Seed |
| --- | ---: |
| Beginner | 310006 |
| Intermediate | 320022 |
| Advanced | 330010 |
| Expert | 340010 |
| Master | 350057 |

The fixtures retain their source configurations. The fast test replays saved
artifacts instead of rerunning full search batches.

## Finalist policy A/B

The balanced policy uses a 10,000-state/500 ms greedy probe and a
50,000-state/2 s A* probe. On the same 128-seed offset-10,000 workloads at eight
workers, it retained the same boards, routes, reports, and rejection decisions
as the original deep policy:

| Tier | Deep | Balanced |
| --- | ---: | ---: |
| Intermediate | 69.04 s | 12.53 s |
| Advanced | 67.39 s | 19.17 s |

These are single completed A/B runs, not median timing claims. The smaller
probe budget provides less solver evidence, so deep review remains useful when
investigating shortcuts.

## Worker scaling

Measured on a Ryzen 7 9800X3D (8 cores/16 threads), 31.2 GiB usable RAM, and
Node 24.14.0 using 64 Beginner seeds, four reverse candidates, and three runs:

| Workers | Median runtime | Average busy cores | Peak RSS |
| ---: | ---: | ---: | ---: |
| 1 | 9.57 s | 1.20 | 448 MiB |
| 4 | 3.26 s | 4.50 | 1,013 MiB |
| 8 | 2.96 s | 7.83 | 1,824 MiB |
| 12 | 3.07 s | 10.66 | 1,917 MiB |
| 15 | 4.04 s | 9.04 | 2,119 MiB |

Every configuration produced 80 qualified candidates and 64 retained puzzles
with matching results. Eight workers delivered about 3.2 times the throughput
of one worker for this workload. Larger tiers can have different memory and
scaling behavior.

The catalog generator reuses one pool across tiers. `--workers 1..64` chooses
concurrency; otherwise `SOKOMIND_FORGE_CONCURRENCY` overrides an automatic
default capped at eight workers and approximately one GiB of available memory
per worker. `--memory-mb` also caps the pool and assigns per-worker V8 heap
limits. Cancellation joins the workers and preserves completed checkpoints.

## Reproducible Beginner quality samples

`verify:generator-quality` checks these fixtures twice and requires identical
rows and witnesses:

| Seed | Boxes | Generic / typed | Moves / pushes | Pushes per box |
| ---: | ---: | ---: | ---: | --- |
| 310005 | 5 | 2 / 3 | 91 / 36 | 8, 2, 8, 9, 9 |
| 310049 | 3 | 2 / 1 | 60 / 27 | 11, 8, 8 |

The fixtures live in
`tests/fixtures/generator/generated-quality-samples.json`. Both routes are
legal solved witnesses. They are not optimality proofs.

Earlier September 2 yield probes recorded:

- 10 qualified puzzles from 200 Beginner attempts;
- 5 qualified puzzles from a later 60 Beginner attempts;
- 0 from 60 Intermediate attempts, where 21 structural survivors failed
  construction or completion before the story-quality gate; and
- 0 from a five-attempt Master probe, where three structural survivors failed
  composition, motif construction, or validation.

The larger sweep stopped as Advanced began, so it supplied no completed
Advanced or Expert result. These limits were superseded by the all-tier evidence
above but remain useful yield history.

## Pre-reset baseline

Recorded August 31 through September 1, 2026 before the rejected catalog was
cleared. The 47 generated puzzles comprised 16 Tutorial, 9 Beginner, 0
Intermediate, 9 Advanced, 8 Expert, and 5 Master entries; 23 used generic
typing, 8 hybrid typing, and 16 typed-only. Solutions ranged from 7 to 229 moves
(65.21 average) and 5 to 74 pushes (25.62 average).

That catalog violated the current product contract through generated tutorials,
non-hybrid puzzles, obsolete box-count tiers, weak participation and
dependencies, and shallow repetitive solutions. Its boards are not retained.

A deterministic 20-attempt Beginner smoke retained three candidates (15%).
They contained 3-5 boxes, 54-119 moves, and 21-42 pushes; all were hybrid and
every box moved more than once.

Seven warm-process evaluator samples on Node 24 produced:

| Fixture | Minimum | Median | Maximum |
| --- | ---: | ---: | ---: |
| First Steps (`ultra-tiny`) | 0.458 ms | 0.588 ms | 5.970 ms |
| Color Wheel (`medium`) | 5.540 ms | 15.434 ms | 17.022 ms |

The executable non-timing vectors live in
`tests/fixtures/generator/evaluation-vector-baseline.json`. Grand Hall's saved
893-move/278-push route measured 5 assignment misdirections, 3 productive
reversal episodes, 10 multi-room journeys, 33 ordered packing pairs, 9 gate
traffic sequences, 155 cross-type causal dependencies, 24 cross-type work
switches, 38 phases with 21 revisits, 5 used zones, and 32 cross-zone pushes.

## Historical V2 prototype captures

These pre-reset experiments explain why the generator adopted structure-first
blueprints, scored reverse search, staging motifs, and composed dependencies.
They are design history, not current regression baselines. The V1 comparison
sample was mutable, small samples often contained five puzzles, and
`avgLegalPushes` measured adjacent rather than keeper-reachable pushes. Current
claims must use the commands and frozen fixtures above.

### Structure-first geometry

| Metric | Handcrafted (n=32) | V1 generated (n=100) | V2 blueprint (n=20) |
| --- | ---: | ---: | ---: |
| Floor utilization | 0.488 | 0.326 | 0.185 |
| Open area ratio | 0.266 | 0.233 | 0.227 |
| Articulation points | 1.19 | 0.33 | 8.20 |
| Detected regions | 0.44 | 0.06 | 1.65 |
| Tunnel cells | 3.66 | 0.00 | 5.65 |
| Chokepoints | 0.41 | 0.00 | 5.15 |
| Terminal regions | 0.00 | 0.06 | 0.00 |
| Cycle rate | 1.000 | 1.000 | 1.000 |
| Largest region ratio | 0.117 | 0.020 | 0.516 |

Across 30 blueprints, 92 intended rooms became 52 detected regions, with 40
merges and 24 unintended shortcuts. Passage lengths ranged from 0 to 16 cells
with a mean of 6.0.

| Family | Articulation points | Regions | Tunnels | Chokepoints | Largest region ratio |
| --- | ---: | ---: | ---: | ---: | ---: |
| Linear | 11.5 | 2.0 | 8.75 | 7.88 | 0.562 |
| Hub | 20.0 | 2.0 | 13.0 | 12.75 | 0.657 |
| Loop | 2.88 | 0.88 | 16.0 | 1.63 | 0.232 |
| Branch | 11.1 | 1.88 | 10.0 | 7.50 | 0.587 |
| Nested | 9.13 | 1.88 | 7.63 | 6.25 | 0.607 |

Ten 18x18, three-box seeds per family produced these room-role counts:

| Family | Goal room | Transit | Staging | General | Exchange |
| --- | ---: | ---: | ---: | ---: | ---: |
| Linear | 10 | 8 | 8 | 14 | 0 |
| Hub | 30 | 10 | 2 | 0 | 6 |
| Loop | 10 | 9 | 10 | 14 | 5 |
| Branch | 10 | 2 | 9 | 22 | 0 |
| Nested | 10 | 0 | 16 | 2 | 0 |

Auto goal-style counts over the same ten seeds were 8 concentrated and 2
mixed for linear, loop, branch, and nested; hub produced 5 concentrated, 3
mixed, and 2 multi-room layouts.

### Scored beam search

Five hub-topology, three-box trials compared beam search with random reverse
pulls:

| Metric | Beam search | Random reverse pull |
| --- | ---: | ---: |
| Average composite score | 57.5 | 43.3 |
| Average depth | 17.0 | 26.4 |
| Average time | 37.2 ms | 1.2 ms |
| Score improvement | 33% | baseline |

At `maxDepth=20`, linear, hub, loop, branch, and nested blueprints respectively
recorded best depth/score/expanded counts of 20/68.0/148, 20/66.5/149,
20/58.8/150, 20/68.7/150, and 16/58.2/146.

### Population, motif, and composition comparisons

Five-puzzle population averages were:

| Metric | Handcrafted | V1 | V2 beam | V2 random |
| --- | ---: | ---: | ---: | ---: |
| Solution moves | 9.4 | 7.0 | 41.7 | 31.0 |
| Solution pushes | 3.6 | 3.2 | 18.3 | 12.0 |
| Solver expanded states | 3.6 | 3.2 | 18.3 | 16.0 |
| Average legal pushes | 0.31 | 1.22 | 0.85 | 0.76 |
| Single-choice ratio | 1.00 | 0.78 | 0.96 | 0.95 |
| Box interaction events | 1.0 | 1.0 | 2.7 | 3.6 |
| Box independence ratio | 0.26 | 0.47 | 0.84 | 0.63 |
| Pushes per box | 1.9 | 1.6 | 6.1 | 4.0 |
| Deadlock density | 1.73 | 1.35 | 2.01 | 0.94 |
| Articulation points | 1.8 | 0.4 | 7.5 | 7.4 |
| Region count | 0.6 | 0.0 | 2.0 | 2.0 |
| Tunnel cells | 2.0 | 0.0 | 4.0 | 4.0 |
| Chokepoints | 1.2 | 0.0 | 4.2 | 4.2 |
| Empty-walk ratio | 0.62 | 0.51 | 0.56 | 0.62 |
| Longest walk streak | 3.2 | 3.2 | 13.5 | 9.0 |
| Forced-push ratio | 1.00 | 0.78 | 0.96 | 0.95 |
| Repetitive-push ratio | 0.31 | 0.30 | 0.75 | 0.64 |
| Unused floor ratio | 0.69 | 0.55 | 0.87 | 0.87 |
| Moves per push | 2.81 | 2.15 | 2.31 | 2.88 |
| Floor utilization | 0.41 | 0.31 | 0.22 | 0.22 |
| Total floor | 16 | 11 | 55 | 56 |
| Solved | 5/5 | 5/5 | 6/6 | 5/5 |

| Metric | Handcrafted | No motif | Packing | Doorway | Staging | Gatekeeper | Mixed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Box independence ratio | 0.26 | 0.85 | 0.80 | 0.82 | 0.54 | 0.84 | 0.80 |
| Box interaction events | 1.00 | 2.40 | 2.40 | 3.00 | 2.80 | 2.80 | 2.40 |
| Pushes per box | 1.90 | 6.07 | 5.67 | 5.87 | 3.53 | 6.40 | 5.67 |
| Solution moves | 9.4 | 41.6 | 39.4 | 38.2 | 25.2 | 46.8 | 39.4 |
| Solution pushes | 3.6 | 18.2 | 17.0 | 17.6 | 10.6 | 19.2 | 17.0 |
| Solver expanded states | 3.6 | 109.0 | 17.0 | 22.2 | 11.0 | 20.4 | 17.0 |
| Average legal pushes | 0.31 | 0.87 | 0.88 | 0.90 | 0.67 | 0.94 | 0.88 |
| Single-choice ratio | 1.00 | 0.95 | 0.93 | 0.92 | 0.95 | 0.92 | 0.93 |
| Empty-walk ratio | 0.62 | 0.56 | 0.56 | 0.54 | 0.59 | 0.59 | 0.56 |
| Longest walk streak | 3.2 | 10.2 | 10.4 | 7.6 | 8.0 | 10.4 | 10.4 |
| Repetitive-push ratio | 0.31 | 0.69 | 0.71 | 0.71 | 0.70 | 0.65 | 0.71 |
| Unused floor ratio | 0.69 | 0.82 | 0.81 | 0.85 | 0.81 | 0.81 | 0.81 |
| Deadlock density | 1.73 | 0.59 | 0.91 | 0.41 | 1.39 | 1.54 | 0.91 |
| Total floor | 16 | 41 | 39 | 47 | 39 | 39 | 39 |
| Solved | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 |

Packing-order, doorway-traffic, staging-dependency, and gatekeeper each
succeeded on 400/400 tested blueprints.

The composition comparison recorded:

| Metric | Handcrafted | No motif | Single motif | Composed |
| --- | ---: | ---: | ---: | ---: |
| Box independence ratio | 0.26 | 0.87 | 0.84 | 0.61 |
| Box interaction events | 1.00 | 2.20 | 2.60 | 4.60 |
| Pushes per box | 1.90 | 6.13 | 5.60 | 3.55 |
| Solution moves | 9.4 | 43.4 | 42.2 | 43.0 |
| Solution pushes | 3.6 | 18.4 | 16.8 | 14.2 |
| Solver expanded states | 3.6 | 18.4 | 17.0 | 15.8 |
| Average legal pushes | 0.31 | 1.07 | 1.02 | 0.80 |
| Single-choice ratio | 1.00 | 0.76 | 0.81 | 0.96 |
| Empty-walk ratio | 0.62 | 0.57 | 0.59 | 0.64 |
| Longest walk streak | 3.2 | 10.0 | 11.0 | 9.8 |
| Repetitive-push ratio | 0.31 | 0.76 | 0.72 | 0.69 |
| Unused floor ratio | 0.69 | 0.87 | 0.87 | 0.84 |
| Moves per push | 2.81 | 2.35 | 2.49 | 2.92 |
| Deadlock density | 1.73 | 1.27 | 1.06 | 1.34 |
| Total floor | 16 | 53.2 | 53.2 | 57.6 |
| Solved | 5/5 | 5/5 | 5/5 | 5/5 |

Five gate-pack puzzles realized 14 of 25 intended dependency edges (56%), with
individual rates of 40%, 60%, 60%, 100%, and 20%. Gate-pack, gate-staging, and
traffic-staging construction each succeeded on 400/400 tested blueprints. The
small, gate-pack-dominated sample and flawed legacy measurements prevent these
figures from supporting current quality claims.

### Geometry tightening

Nine puzzles across no-motif, single-motif, and composed populations produced:

| Metric | Before | After | Delta |
| --- | ---: | ---: | ---: |
| Total floor | 56.1 | 25.0 | -31.1 |
| Unused floor ratio | 0.863 | 0.678 | -0.184 |
| Empty-walk ratio | 0.560 | 0.579 | +0.019 |
| Longest walk streak | 8.8 | 9.8 | +1.0 |
| Repetitive-push ratio | 0.675 | 0.666 | -0.009 |
| Moves per push | 2.384 | 2.508 | +0.124 |
| Solution moves | 36.2 | 38.9 | +2.7 |
| Solution pushes | 15.3 | 15.6 | +0.2 |
| Box independence ratio | 0.765 | 0.759 | -0.005 |
| Solver expanded states | 15.4 | 15.8 | +0.3 |
| Deadlock density | 1.144 | 0.583 | -0.560 |

The pass removed 280 cells (31.1 average), accepted 64.5% of attempted
mutations, and averaged 85.4 ms per puzzle.

### Prototype forge yield

A 60-attempt batch across five families, three construction modes, and 3-4 box
counts produced 40 valid and 15 retained candidates. Rejections were 6 motif
failures, 3 dependency-realization failures, 3 repetitive-push failures, 2
composition failures, 2 validation failures, 2 box-independence failures, 1
goal-placement failure, and 1 walk-streak failure.

The 15 retained candidates comprised 5 hub, 3 branch, 3 loop, 2 nested, and 2
linear boards; 8 used composed mode, 4 plain, and 3 motif. Their metric ranges
were:

| Metric | Minimum | Maximum | Average |
| --- | ---: | ---: | ---: |
| Solution moves | 34 | 76 | 55.0 |
| Solution pushes | 9 | 29 | 20.6 |
| Box independence ratio | 0.500 | 0.818 | 0.732 |
| Box interaction events | 3 | 7 | 5.0 |
| Empty-walk ratio | 0.490 | 0.735 | 0.625 |
| Longest walk streak | 6 | 19 | 11.6 |
| Repetitive-push ratio | 0.462 | 0.778 | 0.667 |
| Unused floor ratio | 0.625 | 0.781 | 0.704 |
| Moves per push | 1.96 | 3.78 | 2.73 |
| Deadlock density | 0.105 | 1.611 | 0.766 |
| Solver expanded states | 10 | 101 | 34 |
| Total floor | 23 | 37 | 29.6 |
| Pushes per box | 2.25 | 7.67 | 5.49 |

The batch took 6.1 seconds, or 102 ms per attempted candidate.

### First V2 catalog run

The first V2 catalog attempt generated 118 boards in about 5.5 minutes:

| Tier | Generated | Canonical | Combined |
| --- | ---: | ---: | ---: |
| Tutorial | 10 | 5 | 15 |
| Beginner | 15 | 5 | 20 |
| Intermediate | 25 | 7 | 32 |
| Advanced | 25 | 9 | 34 |
| Expert | 25 | 4 | 29 |
| Master | 18 | 2 | 20 |
| Total | 118 | 32 | 150 |

Against its mutable V1 comparison, non-Tutorial averages changed by -0.10
unused-floor ratio, -0.19 moves per push, -0.02 empty-walk ratio, +0.17 box
independence, and +0.19 repetitive-push ratio. The quality pass later rejected
this release approach and replaced its output with the pre-reset baseline and
current qualification workflow above.

## Evidence and release rules

Witness-first evaluation requires a legal replay after every mutation. Cached
results are keyed by exact rows and solver identity/version and require
compatible budgets; geometry or label changes cannot reuse them. A construction
or typing witness establishes solvability only. Participation, story, geometry,
quality, diversity, release verification, and human review remain separate
requirements. The exact semantic contract is documented in
[Solution-story contract](generator-solution-story-contract.md).
