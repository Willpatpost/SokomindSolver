# Phase 8: small-sample quality verification

The immediate objective is to demonstrate quality generation, not fill or
promote a catalog. Production generated-puzzle files remain unchanged.

## Reproducible positive examples

Run `npm.cmd run verify:generator-quality`. It makes one generation attempt for
each of two known seeds, twice each, and requires identical final rows and
witness steps. No batch search or production write occurs. Each result must
pass the current numeric quality gates, mixed typing, participation,
cross-class interaction, and fresh canonical replay/story verification.

| Seed | Boxes | Generic / typed | Recorded moves / pushes | Actual pushes per box |
| --- | --- | --- | --- | --- |
| 310005 | 5 | 2 / 3 | 91 / 36 | 8, 2, 8, 9, 9 |
| 310049 | 3 | 2 / 1 | 60 / 27 | 11, 8, 8 |

Seed 310005 demonstrates productive reversal, multi-room transport, gate
traffic, shared routes/support, and causal dependencies. Seed 310049 adds
generic-goal assignment misdirection. All boxes in both examples have concrete
work partners. The routes are legal solved witnesses, **not optimality proofs**.

Exact rows, compact witnesses, expected measurements, and the generation
configuration are in
`tests/fixtures/generator/generated-quality-samples.json`.
Lowercase `u/d/l/r` means walking; uppercase means pushing. The executable
regressions are in `tests/unit/generated-quality-samples.test.ts`.

These are positive examples at Beginner box counts. They establish that the
generator can produce the requested kinds of interaction, not that all tiers
are ready or that human enjoyment has been established by automated metrics.
Playtesting is still the way to judge whether the reversals and ambiguity feel
satisfying rather than tedious.

## Limits observed on 2026-09-02

Before the request was narrowed to small-sample verification:

- A 200-attempt Beginner dry run retained 10 qualified puzzles.
- A subsequent 60-attempt Beginner run retained 5.
- The 60-attempt Intermediate run retained none. Its 21 structural survivors
  failed during construction/completion, before the final story-quality gate.
  Rejections included goal placement, composition/motif construction, missing
  mechanism evidence, and insufficient box participation.
- A separate 5-attempt Master probe retained none; its three structural
  survivors failed composition, motif construction, or validation.
- The larger sweep was stopped at the user's request when Advanced had just
  started. No completed Advanced or Expert sample was established.

Therefore higher-tier quality generation is **not yet demonstrated**. More
catalog volume is not the next objective. The next useful work is a small,
targeted construction/yield investigation that obtains one qualifying larger
puzzle without relaxing the quality rules.

Local, ignored diagnostic artifacts are under
`review-catalog/phase8-initial-2026-09-02/runs/` and
`review-catalog/phase8-master-probe-2026-09-02/`.
Only completed tier checkpoints are saved; the interrupted tier is not counted
as a completed negative experiment. No candidate from these runs was promoted.

## Generation and promotion safeguards prepared

The CLI now supports bounded `--attempts`, `--target`, `--seed-offset`,
`--max-seed-windows`, `--tier`, and optional `--skip-benchmark`. Budgets change
search effort, never quality thresholds. Runs default to separate timestamped
review directories; `--output` can select a new directory explicitly. Existing
nonempty review runs are not overwritten. Each completed run saves its full
configuration, candidates, rejection diagnostics, and selection decisions.

Catalog conversion preserves the exact evaluated rows rather than reframing
them after story evidence and coordinate-bound plans were recorded. Difficulty
mismatches are rejected; quotas cannot cause reclassification. Optional optimal
proof searches are disabled in catalog generation, and existing finalist
evidence is reused rather than collected twice.

For a future complete catalog, `--accept <review-directory> --dry-run` performs
all promotion verification without creating backups or writing production.
Actual `--accept` requires the unchanged release gate and exact
catalog/manifest/review binding. It then independently replays every saved
solution, remeasures its story, and rechecks its typing and construction plans.
Missing witnesses, changed rows, forged measurements, stale landmarks,
duplicate manifest entries, and inconsistent identities or counts fail closed.

Successful promotion backs up both old production files and installs the exact
validated in-memory bytes. An installation error attempts to restore both old
files; backup paths are reported for recovery. Two file replacements are not a
filesystem-wide atomic transaction, so transaction records and backups are
also retained for recovery after a process or machine interruption.

After any future promotion, regenerate catalog metadata and run typecheck,
tests, and the production build. The promotion machinery has been exercised
only in isolated temporary test directories in this phase; the real catalog
has not been changed.
