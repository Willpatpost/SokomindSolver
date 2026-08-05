# Solver V2 Benchmarks

## Current baseline

Raw JSON artifact: `tests/fixtures/solver-v2/baseline-v0.json`

Captured with `npm run benchmark:solver:v2`.

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
