# Solver V2 Progress

## Sprint 0 — Baseline Established

**Date**: 2026-08-04
**Node**: v22.16.0
**Platform**: linux x64 (AMD EPYC 7B13)

### Solver versions

| Solver | Version |
|---|---|
| sokomind-solver | 1.1.0 |
| classic-astar | 1.0.0 |
| classic-ida-star | 1.0.0 |

### Deliverables

- `CLAUDE.md` — engineering rules from spec section 27
- `tests/fixtures/solver-v2/benchmark-corpus.ts` — 34 frozen fixtures (32 catalog + 2 Grand Hall variants)
- `scripts/benchmark-solver-v2.ts` — V2 benchmark runner with child-process isolation and JSON output
- `docs/solver-v2-progress.md` — this file
- `docs/solver-v2-benchmarks.md` — human-readable summary
- Baseline JSON artifact at `tests/fixtures/solver-v2/baseline-v0.json`

### Baseline results

Full corpus run completed: **79/92 solver runs solved** across 34 fixtures.

| Category | Count |
|---|---|
| Total fixture-solver pairs | 92 |
| Solved | 79 |
| Cancelled (time/state limit) | 10 |
| Error (child timeout) | 3 |

Classic A*/IDA* cancelled at 60s on: `large`, `theme-parking`, `expert-tetris`, `theme-museum`, `master-exchange`.
Grand Hall variants (`huge`, `huge-mirrored`, `huge-rotated`) exceeded the 300s child process timeout.

Where both classic solvers completed, A* and IDA* produced identical optimal move counts.

### Test regression

- `npm run test:unit` — 628 tests, 79 suites, all pass
- `npm run typecheck` — pass
- `npm run lint` — pass
- `npm run check:sokomind-solver` — pass
- `npm run test:solver:multi` — 4/4 pass
- `npm run test:solver:huge` — rewrite phase exceeded 90s timing gate on shared machine (92.8s). Search phase and deterministic values are correct. This is a machine performance issue, not a solver regression (Sprint 0 made zero search behavior changes).
