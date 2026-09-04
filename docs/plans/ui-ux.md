# Active UI/UX work

Sprints 1-10 of the former UI/UX V2 roadmap are complete. Their current
behavior is documented in [Experience](../experience.md),
[Persistence and sharing](../persistence-and-sharing.md), and
[Solver Lab](../solver-lab.md). This plan retains only unimplemented work.

## Product constraints

- The guided path recommends an order but never locks the catalog.
- Theme family and light/dark appearance remain separate settings.
- Accessibility controls work across every theme.
- Saved routes must replay successfully before becoming records.
- Regular play exposes simple Hint and Solve actions; algorithm controls remain
  in Solver Lab.
- The application remains local-first until a separately reviewed backend plan
  defines privacy, identity, synchronization, moderation, and operating cost.

## Creator intelligence

Help puzzle authors make intentional, playable puzzles without turning the
editor into a solver console.

Scope:

- add optional solvability checks and solution summaries;
- show dead squares, certain frozen boxes, unreachable areas, and duplicate
  layouts;
- present heuristic difficulty signals with explicit limits; and
- transfer the current editor playtest to Solver Lab.

Acceptance:

- static warnings distinguish proved errors from heuristic concerns;
- analysis is cancellable and preserves editor state; and
- exported puzzles remain compatible with the existing format.

## Online-readiness boundary

Prepare domain contracts for accounts and cross-device sync before selecting a
backend.

Scope:

- define server-authoritative and client-authoritative data;
- define stable sync IDs, revisions, conflicts, and deletion behavior;
- keep local repositories separate from domain services where needed;
- retain versioned, validated, round-trippable progress and route export/import;
  and
- write a backend decision record and migration plan before implementation.

Acceptance:

- the static application remains fully functional without an account or
  network;
- exported data remains versioned and round-trippable; and
- no backend SDK is added until privacy, authentication, hosting, and cost
  decisions are explicit.

## Deferred product experiments

These ideas require separate product and technical review and are not committed
implementation work:

- weather, seasonal, or time-of-day theme variants;
- heavy particle systems or screen shake;
- public profiles, leaderboards, social feeds, and ranking;
- user-generated puzzle hosting and moderation;
- cloud accounts and cross-device sync;
- shared or community hint systems;
- downloadable asset packs; and
- procedural daily puzzle generation.
