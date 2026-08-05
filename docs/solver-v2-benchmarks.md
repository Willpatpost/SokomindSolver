# Solver V2 Benchmarks

## Current baseline

Raw JSON artifact: `tests/fixtures/solver-v2/baseline-v0.json`

Captured with `npm run benchmark:solver:v2`.

### Schema

Schema version: **2**

Every benchmark record includes:

- `fixtureId` — canonical V2 fixture identifier
- `fixtureGroup` — `"primary-v2"` or `"legacy-regression"`
- `boardHash` — truncated SHA-256 of exact snapshotted row content
- `width`, `height`, `floorCount`, `boxCount` — board dimensions
- `solver` — solver identifier
- `solverVersion` — solver semantic version
- `configuration.deterministic` — whether deterministic mode was used
- `configuration.workerCount` — number of solver workers
- `configuration.limits` — all resource limits (always populated, including for error records)
- `status` — `"solved"`, `"unsolved"`, `"cancelled"`, or `"error"`
- `verified` — whether replay verification succeeded (for solved records)
- `elapsedMs` — actual elapsed time (including for error/timeout records)

### Fixture groups

| Group | Count | Description |
|---|---|---|
| primary-v2 | 23 | Typed boxes, multi-box, proof candidates, Grand Hall, complex topology |
| legacy-regression | 11 | Tutorial, beginner, and simple puzzles for regression coverage |

### Canonical 17-box fixture

The Grand Hall puzzle is the 17-box hand-designed fixture from spec §20.1 item 17.

- Canonical ID: `v2-17box-handdesigned`
- Aliases: `huge`, `grand-hall`
- Variants: `v2-17box-mirrored`, `v2-17box-rotated`

### Solver configurations

| Solver | Deterministic | Time limit | State limit | Generated limit | Memory limit |
|---|---|---|---|---|---|
| sokomind-solver | No | 180s | varies | varies | 768 MiB |
| classic-astar | Yes | 60s | 500,000 | 5,000,000 | 512 MiB |
| classic-ida-star | Yes | 60s | 500,000 | 5,000,000 | 512 MiB |

### Eligibility

Classic A* and IDA* run on fixtures with ≤8 boxes and ≤96 floor cells (29 of 34 fixtures).
Sokomind solver runs on all 34 fixtures.

### Notes

- Elapsed milliseconds are recorded for reference but NOT used as a cross-machine correctness gate.
- State counts and memory counts are the primary stable gates.
- Sokomind solver is nondeterministic; exact state-count equality is not enforced.
- Grand Hall (17-box, 127-floor) exceeds classic-eligible thresholds and runs sokomind-solver only.
- Error records preserve the intended configuration and limits, and report actual parent-process elapsed time.
