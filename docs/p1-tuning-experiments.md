# P1 tuning experiments — 2026-09-10

Three controlled A/B experiments testing the tuning parameters documented in
[solver status](solver-status.md). All runs used deterministic mode, a single
worker, five timed samples per fixture/profile pair, zero warmup, and the full
43-fixture benchmark corpus on commit `d04254c4`.

Hardware: AMD Ryzen 7 9800X3D, 32 GB, Windows (hostname Willpatpost).

## Experiment definitions

Each experiment sets one tuning parameter via `SOKOMIND_TUNING_JSON`. Control
uses the production default (disabled, value 0). Treatment enables the feature.

| Experiment | Parameter | Control | Treatment | Affected code path |
|---|---|---:|---:|---|
| P1.1 | `macroIntermediateQuota` | 0 | 2 | Retains up to N non-endpoint intermediate states per macro expansion, selected by shortest path and side diversity |
| P1.2 | `moveAwareDiscovery` | 0 | 1 | Discovery beam search uses `BoundedKeeperArrivalMap` for transpositions, retaining states with distinct keeper approach directions |
| P1.3 | `firstPushWalkWeight` | 0 | 0.05 | Adds exact keeper walk-to-support distance as a penalty term in the structural planner's first-push ranking |

Commands (run sequentially, control then treatment for each pair):

```text
# P1.3
SOKOMIND_TUNING_JSON='{"firstPushWalkWeight":0}'    npm run benchmark:solver:v2 -- --runs=5 --warmup=0 --save=results/p1.3-control.jsonl
SOKOMIND_TUNING_JSON='{"firstPushWalkWeight":0.05}' npm run benchmark:solver:v2 -- --runs=5 --warmup=0 --save=results/p1.3-treatment.jsonl

# P1.2
SOKOMIND_TUNING_JSON='{"moveAwareDiscovery":0}' npm run benchmark:solver:v2 -- --runs=5 --warmup=0 --save=results/p1.2-control.jsonl
SOKOMIND_TUNING_JSON='{"moveAwareDiscovery":1}' npm run benchmark:solver:v2 -- --runs=5 --warmup=0 --save=results/p1.2-treatment.jsonl

# P1.1
SOKOMIND_TUNING_JSON='{"macroIntermediateQuota":0}' npm run benchmark:solver:v2 -- --runs=5 --warmup=0 --save=results/p1.1-control.jsonl
SOKOMIND_TUNING_JSON='{"macroIntermediateQuota":2}' npm run benchmark:solver:v2 -- --runs=5 --warmup=0 --save=results/p1.1-treatment.jsonl
```

## Results

No experiment changed solution quality. Move counts, push counts, and solve
status are identical between control and treatment across all 218 fixture/profile
pairs in every experiment. Only timing varied.

Classic profiles (A\*, IDA\*) are unaffected by these tuning parameters. Timing
fluctuations in classic profiles are system noise. The analysis below focuses on
Sokomind profiles.

### P1.1: macroIntermediateQuota (0 vs 2)

**Verdict: no effect.**

Retaining intermediate states per macro expansion produced no measurable change.

| Profile | Aggregate timing | Notable outliers |
|---|---|---|
| sokomind-fast | +1.7% slower | None above noise threshold |
| sokomind-quality | +0.0% | None |
| sokomind-optimal-astar | -0.0% | None |
| sokomind-optimal-ida | -0.2% | None |

The few individual-puzzle timing fluctuations (ultra-tiny, tiny, beginner-typed-line)
are sub-second puzzles where jitter dominates. No puzzle exceeded a 15% swing.

### P1.2: moveAwareDiscovery (0 vs 1)

**Verdict: mixed, most interesting of the three.**

Keeper-arrival transpositions produced a 6.1% aggregate speedup in fast mode,
driven by large typed-box puzzles. However, maze-style puzzles regressed.

| Profile | Aggregate timing | Notable outliers |
|---|---|---|
| sokomind-fast | **-6.1% faster** | See detail below |
| sokomind-quality | +0.0% | inter-rooms +10.6% |
| sokomind-optimal-astar | -0.9% | sym-diamond -14.6%, box-5x5-a +14.1% |
| sokomind-optimal-ida | +0.1% | None |

Fast-mode detail:

| Fixture | Control | Treatment | Change |
|---|---:|---:|---|
| master-typed-grid | 11,901 ms | 9,656 ms | **-18.9%** |
| master-exchange | 11,013 ms | 9,704 ms | **-11.9%** |
| v2-caleb-022 | 463 ms | 409 ms | -11.7% |
| expert-maze | 1,385 ms | 1,650 ms | +19.1% |
| adv-gallery | 881 ms | 1,017 ms | +15.4% |

The wins are concentrated on large typed-grid puzzles where keeper approach
direction meaningfully constrains the search. The losses are on maze-style
puzzles where extra transposition tracking adds overhead without reducing the
frontier. A puzzle-class-specific activation policy could capture the wins
without the regressions.

### P1.3: firstPushWalkWeight (0 vs 0.05)

**Verdict: net negative.**

The walk-distance penalty shifted search effort toward keeper-proximate first
pushes. This helped a few puzzles but hurt more, with a 4.6% aggregate slowdown
in fast mode.

| Profile | Aggregate timing | Notable outliers |
|---|---|---|
| sokomind-fast | **+4.6% slower** | See detail below |
| sokomind-quality | +0.5% | open-field +13.0%, garden-1 +13.2% |
| sokomind-optimal-astar | +1.7% | adv-gallery +14.3% |
| sokomind-optimal-ida | +0.4% | adv-gallery +11.3% |

Fast-mode detail:

| Fixture | Control | Treatment | Change |
|---|---:|---:|---|
| expert-maze | 1,646 ms | 1,419 ms | -13.8% |
| theme-museum | 8,741 ms | 7,697 ms | -11.9% |
| open-field | 3,167 ms | 2,846 ms | -10.1% |
| master-exchange | 8,395 ms | 10,485 ms | **+24.9%** |
| adv-four-color | 3,142 ms | 3,644 ms | +16.0% |
| corridor-2 | 2,061 ms | 2,321 ms | +12.6% |
| master-typed-grid | 8,820 ms | 9,826 ms | +11.4% |

The feature penalizes first pushes that require long keeper walks. This
occasionally shortcuts a good opening move but more often delays a structurally
necessary long walk, forcing the solver to discover it through search instead.

## Observations

1. All three parameters are correctly defaulted to disabled. None should be
   enabled globally based on this evidence.

2. The tuning fingerprint in the benchmark output is identical between control
   and treatment because the fingerprint is computed from the profile
   configuration, not the `SOKOMIND_TUNING_JSON` environment override. Future
   benchmark runs should record the active tuning JSON for self-documenting
   evidence.

3. The expanded-state count differences between control and treatment are
   confined to timeout-bound runs (60 s or 180 s wall clock). These reflect
   how many states the solver expanded before the timer fired, not a solution
   quality signal.

4. `moveAwareDiscovery` is the only parameter that shows a structural effect
   worth investigating further. A possible next step is puzzle-class-specific
   activation — enable keeper-arrival transpositions on typed-grid layouts
   (where approach direction matters) and leave them off on open mazes (where
   they add overhead).

## Raw data

Result files in `results/`:

- `p1.1-control.jsonl`, `p1.1-treatment.jsonl` — macroIntermediateQuota
- `p1.2-control.jsonl`, `p1.2-treatment.jsonl` — moveAwareDiscovery
- `p1.3-control.jsonl`, `p1.3-treatment.jsonl` — firstPushWalkWeight
