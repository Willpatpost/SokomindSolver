# Sokomind Solver Engineering Rules

## Game rules

- O is wall.
- R is robot.
- X may only occupy S.
- Only X may occupy S.
- Typed uppercase boxes may only occupy their matching lowercase goals.
- Repeated typed labels are allowed.
- The robot pushes but never pulls during forward play.

## Solver truth rules

- Sokomind fast discovery is bounded, not optimal.
- Only a completed exact move proof may set optimality to proven.
- A timeout is never proof.
- A push optimum is not a move optimum.
- Every returned solution must replay through the core game engine.
- Exact proof must use collision-free state identity.
- Exact move search includes exact robot position.
- Proof heuristics must be admissible.
- Ordering heuristics may not affect proof f-cost.
- Incomplete local analysis is not a deadlock.
- Never use a greedy or weighted result as an exact proof.

## Source rules

- Do not edit engine.generated.js directly.
- Edit sokomind-engine/source and regenerate.
- Do not change the puzzle generator or catalog during solver work.
- Main agent owns code edits.
- Subagents are read-only unless assigned isolated non-overlapping work.

## Test commands

- npm run check:sokomind-solver
- npm run typecheck
- npm run lint
- npm run test:unit
- npm run build
- npm run test
- npm run test:coverage
- npm run test:solver:oracle
- npm run test:solver:optimal
- npm run test:solver:multi
- npm run test:solver:huge
- npm run benchmark:solver
- npm run benchmark:solver:v2
- npm run benchmark:solver:memory

## Environment variables

- SOKOMIND_TIMING_SCALE: multiplier for wall-clock timing gates in performance tests (default 1). Set to 2 on slower hardware (e.g. Waterfield login node). State-count and deterministic-result assertions are unaffected.

## Sprint rules

- Implement one approved sprint at a time.
- Add tests with implementation.
- Update docs/solver-v2-progress.md.
- Run targeted and required tests.
- Use one focused reversible commit.
- Stop after the sprint report.
