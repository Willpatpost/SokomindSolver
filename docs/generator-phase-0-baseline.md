# Generator Phase 0 baseline

Recorded on 2026-08-31 before the rejected generated catalog was cleared.
This document preserves aggregate evidence only; none of the rejected generated
boards are retained as fixtures.

## Rejected production catalog

- Generated puzzles: 47
- Tutorial: 16
- Beginner: 9
- Intermediate: 0
- Advanced: 9
- Expert: 8
- Master: 5
- Generic typing: 23
- Hybrid typing: 8
- Typed typing: 16
- Solution moves: minimum 7, average 65.21, maximum 229
- Solution pushes: minimum 5, average 25.62, maximum 74

The catalog failed the new product contract because it included generated
tutorials, non-hybrid puzzles, obsolete box-count tiers, low box participation,
weak cross-type dependencies, and solutions that were too shallow and
repetitive for their labels.

## Generator 4.2 smoke baseline

The deterministic Beginner smoke run searched 20 raw attempts and retained 3
candidates. They contained 3-5 boxes, 54-119 solution moves, and 21-42 pushes.
All three were hybrid and every box required multiple pushes. This establishes
that the reset catalog can remain empty while the new generator is developed
and reviewed outside production.

Yield was therefore **3 / 20 raw attempts (15%)** for that frozen smoke run.
The rejected production boards were deleted before per-candidate evaluator
timings and story profiles existed, so those two measurements cannot be
reconstructed honestly. They are replaced by the executable calibration
baseline below rather than by inferred numbers.

## Executable evaluator and story baseline

Recorded on 2026-09-01 with Node 24 on the development Windows host. Seven
warm-process runs were measured per board; elapsed time is diagnostic and is
not part of the frozen vector assertion.

| Fixture | Minimum | Median | Maximum |
| --- | ---: | ---: | ---: |
| First Steps (`ultra-tiny`) | 0.458 ms | 0.588 ms | 5.970 ms |
| Color Wheel (`medium`) | 5.540 ms | 15.434 ms | 17.022 ms |

`tests/fixtures/generator/evaluation-vector-baseline.json` freezes every other
field in both evaluation vectors. `tests/unit/evaluation-vector-baseline.test.ts`
recomputes and compares the complete vectors, and also requires solved
canonical traces.

Grand Hall has a separately stored, deterministic, replay-valid route because
the standard A* evaluator cannot solve that 17-box calibration board inside
its normal limit. The route has 893 moves and 278 pushes. Its passive profile
measures 5 assignment misdirections, 3 productive reversal episodes, 10
multi-room journeys, 33 ordered packing pairs, 9 gate traffic sequences, 155
cross-type causal dependencies, 24 cross-type work switches, 38 phases with 21
revisits, 5 used zones, and 32 cross-zone pushes. The calibration test freezes
the entire summary, replay-validates all 893 actions, and verifies concrete
assignment-misdirection, support-contention, and multi-chain-merge targets
against that final trace.

## Post-reset catalog contract

- `generated-puzzles.json` is an empty array.
- The generated manifest contains zero puzzles and zero actual tier counts.
- Tutorial generation remains disabled.
- Only the 19 retained Sokomind Originals are user-facing.
- New generated puzzles must be reviewed and pass release gates before
  production promotion.
