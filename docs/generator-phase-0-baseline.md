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

## Post-reset catalog contract

- `generated-puzzles.json` is an empty array.
- The generated manifest contains zero puzzles and zero actual tier counts.
- Tutorial generation remains disabled.
- Only the 19 retained Sokomind Originals are user-facing.
- New generated puzzles must be reviewed and pass release gates before
  production promotion.
