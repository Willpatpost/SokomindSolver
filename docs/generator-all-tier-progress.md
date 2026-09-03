# All-tier generator implementation

The approved order is measurement, redundant-solve removal, one success per
tier, repeatable variety, throughput tuning, and human playtesting/release.
Tutorial generation remains disabled. Catalog promotion is not automatic.

## 1. Measurement

The catalog and measurement harness share `scripts/lib/generator-tier-config.ts`.
Run `npm.cmd run measure:generator -- --attempts 32 --seconds 60 --workers 8`.
Optional flags include `--tier intermediate,advanced`, `--reverse-candidates 4`,
`--seed-offset 10000`, `--repeats 3`, and `--output new-directory`.

Each exclusive output directory records revision, dirty state, hardware,
configuration, completed task checkpoints, qualified candidates with witnesses,
and per-tier summaries. A time limit records an incomplete run, not zero retained
yield. Task duration includes queue wait; process CPU is reported separately.
Qualified checkpoint candidates have not passed finalist selection, catalog
diversity, independent release verification, or human review.

## Acceptance milestones

- Preserve all existing replay, typing, participation, story, and release rules.
- Demonstrate one independently verified generator success at each tier.
- Then demonstrate five distinct successes per tier from multiple seed batches.
- Measure held-out yield and scaling before choosing per-tier worker defaults.
- Human playtesting is required before declaring enjoyment or release readiness.
- The proposed full catalog target is twenty approved puzzles per tier; this is
  a goal, not a claim about current yield or a reason to weaken gates.

## Current status

Measurement, bounded witness-first evaluation, and one generated success per
tier are implemented. The production catalog is unchanged.

The fixed eight-attempt baseline completed at every tier: Beginner retained
three, the other tiers zero. It is stored locally under
`review-catalog/all-tier-baseline-2026-09-03/`. Larger interrupted probes from
earlier investigation are not counted as completed negative experiments.

`npm.cmd run verify:generator-tiers` independently replays saved generated
examples at every tier and rechecks their story and quality evidence. Seeds are
310006 (Beginner), 320022 (Intermediate), 330010 (Advanced), 340010 (Expert), and
350057 (Master). These fixtures are generated evidence, not human endorsements
or optimality proofs. They retain the source configurations for reproduction;
the fast test replays artifacts rather than rerunning the full search batches.

Witness-first refinement requires an exact legal route after each proposed
mutation. Invalidated routes are not repaired by repeated expensive solves.
Generic and typed evaluations still perform bounded independent probes, sharing
a candidate-local limit of 12,000 expansions, eight calls, and five seconds.
Each probe is capped at 2,000 expansions and 500 ms. Recorded work distinguishes
verification from real search. Unmeasured solver effort is never invented.
The composed constructor can now verify its existing route directly.

Participation-aware search rewards only the first two pulls per box and only
archives starts representable in the row format (no goal/entity overlaps).
Forward participation and quality gates remain authoritative. Compactness
refinement respects the catalog geometry profile and a coverage target instead
of stopping just because a large floor-per-box allowance was met.

Scalable motif/composition recipes preserve a small real mechanism's goals,
then allocate additional goals across rooms without overwriting anchors or
blocking their pull supports. Added boxes still must pass the full forward
participation and interaction rules. All modes can retain alternate starts from
their actual solved blueprint; alternatives reuse construction instead of
rebuilding it independently. Recipes and search guidance are opt-in config
fields, enabled by the catalog CLI and measurement harness.

The fresh 128-attempt seed window at offset 10,000 is being measured under
`review-catalog/variety-window-a-2026-09-03/`. Completed results so far include
45 Beginner, 30 Intermediate, 23 Advanced, and 16 Expert qualified candidates.
Master hit the 240-second run limit with twelve qualified checkpoint candidates;
unfinished jobs have no recorded outcome. Recovery plus the earlier Master
example produced a five-puzzle Master selection. The recovered candidates were
replayed, remeasured, and finalized by `npm.cmd run review:generator`.

The resulting `review-catalog/five-per-tier-review-2026-09-03/` contains five
puzzles per tier and passes the automated release gate. Human playtesting and
approval are still pending; passing the gate is not a promotion command.

## Throughput evaluation

The balanced finalist policy uses a 10,000-state/500 ms greedy probe and a
50,000-state/2 s A* probe. The original deep policy remains available through
`--evaluation deep`. Neither policy requires an optimality proof or changes
qualification floors. The catalog defaults to balanced screening; review
checkpoint recovery uses deep finalization for candidates lacking evidence.

On the same 128-seed offset-10,000 workloads at eight workers, balanced screening
retained identical boards, routes, quality reports, and rejection decisions:
Intermediate 69.04 s to 12.53 s; Advanced 67.39 s to 19.17 s. These are single
completed A/B runs, not median benchmark claims, and weaker probe budgets provide
less solver evidence. Extra deep review remains useful for shortcut investigation.

`benchmark:generator -- --tier intermediate --seed-offset 10000` now uses actual
catalog tier settings. Without `--tier`, the original Beginner calibration
benchmark is retained. Worker recommendations require positive identical results.

For controlled comparisons the measurement harness accepts
`--legacy-evaluation`, `--legacy-search`, and `--legacy-recipes`. These are
research controls, not ways to relax quality or release policy.
