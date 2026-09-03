# Generator CPU usage and throughput

For the ordered all-tier implementation and measurement harness, see
[All-tier generator progress](generator-all-tier-progress.md).

The terminal catalog generator uses one reusable Node worker pool across tiers
and retry windows. Beginner uses the pool too. Blueprint generation and
finalist evaluation run in parallel; reverse construction feeds qualification
jobs into a bounded ready queue. Structural and finalist rankings still wait
for their population, because selection must not depend on which worker wins
a race. Idle workers remain available until the catalog run ends, and all
workers are joined on completion, cancellation, or failure.

## Running it

```powershell
npm.cmd run generate:v2-catalog -- --tier beginner --attempts 200 --target 20 --workers 8 --reverse-candidates 8 --max-seed-windows 0 --skip-benchmark
```

This writes a new review directory. Existing catalog promotion and quality
requirements remain in force. `--skip-benchmark` skips the additional
handcrafted population comparison, not candidate evaluation or quality gates.

- `--workers 1..64` chooses worker concurrency. Otherwise the
  `SOKOMIND_FORGE_CONCURRENCY` environment variable takes precedence over the
  automatic default, which caps at eight workers and reserves approximately
  one GiB of available memory per worker.
- `--reverse-candidates 1..32` bounds start states evaluated per blueprint;
  the catalog default is eight. Only plain/mechanism construction currently
  exposes a reusable reverse archive. Motif/composition still supplies one
  constructed candidate.
- `--memory-mb N` additionally caps the worker count at roughly one worker per
  GiB, allocates per-worker V8 old-generation heap limits, and checks aggregate
  RSS growth between completed jobs. This is an operational bound, not a hard
  OS limit on every native allocation. A breach stops the run with an error.
- Ctrl+C aborts active work and joins workers. Completed tier checkpoints remain
  in the review directory; interrupted jobs do not become accepted puzzles.

Progress reports the current phase, active workers, queued jobs, attempts,
qualified candidates, rejections, rates, and peak process RSS. Saved run
results also include phase timings, CPU time, average busy cores, cache hits,
witness fallbacks, and variant counts. Worker task durations are accumulated
wall time (including startup); they are not per-thread CPU measurements.
Process CPU time includes Node/V8 background threads. With a shared pool,
peak worker counts and peak RSS cover that pool's lifetime.

## Scaling benchmark

```powershell
npm.cmd run benchmark:generator -- --workers 1,4,8,12,15 --attempts 64 --repeats 3
```

The benchmark uses the same seeds and quality/finalist gates for every worker
count. It verifies retained routes and checks identical boards, routes,
quality results, and rejection decisions. It recommends a worker count only
when the workload produces qualified puzzles with identical results.
`--output path.json` saves a new report and refuses to overwrite an existing
file. `--no-evidence-cache` provides a cache-disabled comparison, and
`--reverse-candidates` controls archive breadth.

Development-host measurement (Ryzen 7 9800X3D, 8 cores/16 threads, 31.2 GiB
usable RAM, Node 24.14.0; 64 Beginner seeds, four reverse candidates, three
repeats):

| Workers | Median runtime | Average busy cores | Peak RSS |
| ---: | ---: | ---: | ---: |
| 1 | 9.57 s | 1.20 | 448 MiB |
| 4 | 3.26 s | 4.50 | 1,013 MiB |
| 8 | 2.96 s | 7.83 | 1,824 MiB |
| 12 | 3.07 s | 10.66 | 1,917 MiB |
| 15 | 4.04 s | 9.04 | 2,119 MiB |

All configurations produced 80 qualified candidates and 64 retained puzzles,
with matching results. Eight workers delivered about 3.2 times the throughput
of one worker in the new pipeline. This is not a before/after comparison with
the previous generator, and it does not establish higher-tier generation yield.
Larger boards can have different memory requirements and scaling behavior.

## Quality and evidence

Reverse archives are scheduled before the primary candidate qualifies, so its
failure cannot discard other viable starts. The actual primary is excluded by
board identity, and distinct final boards have distinct candidate IDs. Archive
failures are included in rejection diagnostics. The catalog also tries up to
three deterministic goal placements on the same geometry when construction
fails; these are bounded repairs, not changes to quality thresholds.

Reverse pull history is converted to a complete forward route, including legal
keeper walking, and replayed through the immutable core. Candidate-local caches
retain at most eight solved results, keyed by exact rows and solver identity/
version. Reuse requires compatible budgets. Geometry changes and labeling
changes cannot reuse stale evidence. A valid construction or typing witness
can establish solvability after a bounded solver failure; it never establishes
optimality, and all normal participation, story, geometry, and quality checks
still apply.

The offline worker yields to its event loop at approximately 25 ms intervals
using `setImmediate`. The browser solver keeps its original scheduler. Search
state budgets and cancellation remain active. Wall-clock limits can still
produce different outcomes under severe system contention; the benchmark
reports those differences rather than presenting them as equivalent speedups.

`solverCallsMade` now counts actual evaluator/tightening probes rather than an
assumed two calls per blueprint. The historical `solverCallsAvoided` field
counts blueprints eliminated by structural screening; `reductionRatio` is the
fraction of valid blueprints screened out. Neither is an estimate of saved
solver invocations, because each survivor can trigger many solves.
