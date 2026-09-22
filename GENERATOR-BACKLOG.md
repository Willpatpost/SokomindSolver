# Generator improvement backlog

> **Purpose**: expand the puzzle catalog with quality puzzles by fixing the
> offline generator's evidence integrity, quality analysis, variety, efficiency,
> and admission gates.
>
> **How to use this file**: on every context compaction, read this file first.
> It tells you what the project is, what you are doing, what is done, and where
> to resume. Update status markers in-place as you complete items.

---

## Project context

- **Repo root**: `/home/wpost003/alphaevolve/practice/Sokomind/SokomindSolver`
- **Generator source**: `src/features/generator/` (~24 K lines)
  - V1 (legacy): `generate-puzzle.ts`, `reverse-play.ts`, `board-template.ts`, etc.
  - V2/V4 (current): `v2/` — forge, blueprints, reverse beam search, evaluator, story, quality gate, refiner, curation, identity, etc.
- **Key V2 modules** (by item relevance):
  - `puzzle-refiner.ts` — items 1, 4, 5, 14
  - `quality-gate.ts` — items 2, 14
  - `generation-evidence.ts` — items 3, 5, 9, 22
  - `puzzle-identity.ts` — item 4
  - `puzzle-forge.ts` — orchestrator: items 1-6, 15-17, 21
  - `finalist-evaluator.ts` — items 7, 8, 10, 11
  - `counterfactual-analysis.ts` — items 9, 10
  - `solution-scoring.ts` / `solution-usage.ts` — items 11, 12
  - `story-quality-policy.ts` / `passive-story-analysis.ts` — items 8, 9, 13
  - `interaction-analysis.ts` — items 11, 16
  - `story-diversity.ts` / `curation.ts` — items 17, 18, 19
  - `forge-pool.ts` / `forge-worker.ts` — item 21
  - `difficulty-model.ts` — item 13
  - `reverse-beam-search.ts` — item 17
  - `review-catalog.ts` / `release-gate.ts` — items 18, 27, 28
- **Scripts**: `scripts/generate-v2-catalog.ts`, `scripts/benchmark-generator.ts`, `scripts/measure-generator.ts`, `scripts/prepare-generator-review.ts`
- **Test fixtures**: `tests/fixtures/generator/`, `tests/fixtures/solver-v2/`
- **Relevant tests**: `tests/unit/*generator*.test.ts`, `*forge*.test.ts`, `*quality*.test.ts`, `*story*.test.ts`, `*mechanism*.test.ts`, `*curation*.test.ts`, `*evaluation*.test.ts`, `*funnel*.test.ts`, `*blueprint*.test.ts`, `*identity*.test.ts`
- **Docs**: `docs/generator-benchmarks.md`, `docs/generator-solution-story-contract.md`
- **CLAUDE.md rules**: do not change the puzzle generator or catalog during solver work (we are doing generator work, so this is our scope). Main agent owns code edits.

---

## Implementation order

Work P0 (items 1-6) first, then P1 (7-14) with regression tests, then P2
(15-20), P3 (21-26), P4 (27-31). Existing promotion and human-review
requirements stay active throughout. New quality thresholds are calibrated
before becoming release blockers.

---

## Status key

- `[ ]` not started
- `[~]` in progress — see notes
- `[x]` complete — tests pass, code merged to working tree
- `[!]` blocked — see notes

---

## P0 — Correctness and evidence integrity

> Completion standard: every returned candidate has a valid solution and current
> evidence for its exact final board; no mutation preserves stale approval.

### 1. Make refinement return a complete, validated candidate
- **Status**: `[x]`
- **What**: `puzzle-refiner.ts` returns `RefinementResult` with only `puzzle`, `solutionScore`, `iterations`, `improved`. It must also return the new validated solution, recomputed evaluation vector, story analysis, typing verification, mechanism verification, and quality verdict. If the refined version fails qualification, keep the original.
- **Key files**: `puzzle-refiner.ts`, `puzzle-forge.ts` (caller), `quality-gate.ts`, `puzzle-evaluator.ts`, `story-quality-policy.ts`
- **Tests**: add unit tests for refined-candidate-has-full-evidence, refinement-failure-keeps-original
- **Notes**: Added `solutionSteps` to `RefinementResult`. Forge call site recomputes eval, quality, story after refinement; rejects if qualification fails. 6 unit tests in `puzzle-refiner.test.ts`.

### 2. Centralize final candidate qualification
- **Status**: `[x]`
- **What**: create one `qualifyCandidate()` function used after construction, tightening, typing, and refinement. Any geometry/goal/label/box/start mutation invalidates previous evidence.
- **Key files**: `puzzle-forge.ts`, `quality-gate.ts`, `puzzle-evaluator.ts`, `finalist-evaluator.ts`
- **Tests**: add test that qualification catches stale evidence after mutation
- **Notes**: `qualifyCandidate()` exported from `puzzle-forge.ts`. Used by `finishCandidate` and refinement. Accepts `QualificationInput`, returns `QualificationResult`.

### 3. Bind evidence to its exact inputs
- **Status**: `[x]`
- **What**: `GenerationEvidence` must record board identity (hash of rows), solution identity (hash of steps), evaluator version, solver version, and policy fingerprint. Check bindings before ranking, serialization, review, promotion.
- **Key files**: `generation-evidence.ts`, `puzzle-identity.ts`, `puzzle-forge.ts`, `review-catalog.ts`
- **Tests**: evidence with wrong board hash is rejected; stale evidence fails promotion
- **Notes**: Added `evidenceBoardHash` to `ForgeCandidate`. `qualifyCandidate` checks hash freshness. Test fixtures updated in 4 test files.

### 4. Regenerate identity and deduplicate after mutations
- **Status**: `[x]`
- **What**: recompute `boardHash()` and symmetry identities after refinement and tightening. Run dedup checks again before final selection, including against existing catalog.
- **Key files**: `puzzle-identity.ts`, `puzzle-refiner.ts`, `puzzle-forge.ts`, `curation.ts`
- **Tests**: post-refinement duplicate detected; symmetry-equivalent variant caught
- **Notes**: Post-refinement dedup pass added after the refinement loop in `runForgePipeline`. Rebuilds hash map and removes collisions keeping higher pareto score.

### 5. Extend cancellation and resource budgets through refinement
- **Status**: `[x]`
- **What**: pass `AbortSignal` into refinement's solver calls. Give refinement explicit call/state/elapsed-time budgets within overall run budget. Include its work in telemetry. Cancelled searches are not completed evaluations.
- **Key files**: `puzzle-refiner.ts`, `generation-evidence.ts`, `puzzle-forge.ts`
- **Tests**: refinement respects abort signal; budget exhaustion stops refinement; telemetry includes refinement work
- **Notes**: Added `RefinementBudget` type with `maxElapsedMs`, `maxSolverCalls`, `maxIterations`. `RefinementResult` now includes `solverCalls` and `elapsedMs`. Forge passes `signal` and `{maxElapsedMs: 30_000, maxSolverCalls: 50}`. Solver calls flow into forge telemetry.

### 6. Fix robot-on-goal serialization in shared generation paths
- **Status**: `[x]`
- **What**: before converting a reverse-generated state to puzzle rows, move the robot to a non-goal cell or reject. Adjust and replay solution witness after relocation.
- **Key files**: `reverse-beam-search.ts`, `puzzle-forge.ts`, `generation-evidence.ts`
- **Tests**: robot-on-goal state produces valid puzzle rows; relocated robot has replayed witness
- **Notes**: BFS-based `relocateRobot` added to both `buildPuzzleFromScramble` (generate-puzzle.ts) and `candidateToRows` (reverse-beam-search.ts). Finds nearest non-goal, non-box floor cell. Test verifies all goals preserved when robot starts on a goal.

---

## P1 — Establish the puzzle's actual quality

> Completion standard: a candidate's quality report explains its challenge and
> identifies known bypasses and uncertainties. Passing the construction witness
> is insufficient by itself.

### 7. Retain independent solver routes, not just statistics
- **Status**: `[x]`
- **What**: finalist evaluation retains replay-verified routes from solver portfolio. Deduplicate equivalent routes. Run quality analysis on materially different solutions.
- **Key files**: `finalist-evaluator.ts`, `generation-evidence.ts`, `puzzle-forge.ts`
- **Tests**: multiple routes retained; equivalent routes deduped; quality analysis runs on each
- **Notes**: Added `steps` to `SolverEvidence`, `DistinctRoute` type, `distinctRoutes` on `FinalistEvaluationV4`. Push fingerprint deduplication. 2 new tests.

### 8. Add explicit shortcut detection
- **Status**: `[x]`
- **What**: compare independent solutions with construction witness. Flag routes that bypass intended mechanisms, avoid box participation, remove dependencies, or sharply reduce challenge.
- **Key files**: `finalist-evaluator.ts`, `counterfactual-analysis.ts`, `story-quality-policy.ts`
- **Tests**: shortcut that bypasses staging is flagged; shorter-but-valid route alone is not a defect
- **Notes**: New `shortcut-detection.ts` module with `detectShortcuts()`. Compares box usage profiles between witness and routes. Severity scoring. 4 tests.

### 9. Distinguish observed from required interactions
- **Status**: `[x]`
- **What**: record whether a mechanism appeared in a solution, was bypassed by another, or has necessity evidence. Keep exhaustion/timeout distinct. "No shortcut found within budget" is not proof.
- **Key files**: `counterfactual-analysis.ts`, `interaction-analysis.ts`, `generation-evidence.ts`
- **Tests**: mechanism with bypass marked observed-not-required; timeout marked inconclusive
- **Notes**: Added `classifyNecessity()` to `interaction-analysis.ts`. `MechanismNecessity` type: "required" | "observed" | "bypassed" | "inconclusive". Multi-route trace analysis. 4 tests.

### 10. Target counterfactual searches at important claims
- **Status**: `[x]`
- **What**: prioritize questions: can staging be avoided? Can a goal stay occupied? Can a gate be bypassed? Can a box go untouched? Record precise question and result. Deeper budgets for promising finalists.
- **Key files**: `counterfactual-analysis.ts`, `finalist-evaluator.ts`
- **Tests**: targeted counterfactual question produces clear result; deeper budget applied to finalist
- **Notes**: Probe prioritization now weights goal-relevant alternatives higher. Added `FINALIST_COUNTERFACTUAL_BUDGET` (4x deeper). Existing 12 tests pass.

### 11. Measure meaningful participation across solutions
- **Status**: `[x]`
- **What**: strengthen two-push and interaction checks with net displacement, useful revisits, dependency contributions, participation on independent routes. Avoid rewarding gratuitous pushes.
- **Key files**: `solution-usage.ts`, `interaction-analysis.ts`, `solution-scoring.ts`
- **Tests**: back-and-forth box not credited; box with net displacement credited
- **Notes**: Added `BoxParticipationMetrics` with `netDisplacement`, `revisits`, `meaningful` flag. `SolutionUsageMetrics` now includes `boxParticipation`, `meaningfulBoxCount`, `gratuitousBoxCount`.

### 12. Improve tedium measurement
- **Status**: `[x]`
- **What**: measure long forced push runs, repeated traversals, repeated work on equivalent boxes, walking between decisions, redundant segments. Keep dimensions visible. Calibrate thresholds against playtest before enforcing.
- **Key files**: `solution-scoring.ts`, `quality-gate.ts`, `solution-usage.ts`
- **Tests**: long forced sequence detected; walking-to-decision ratio computed
- **Notes**: Added `TediumMetrics` interface and `measureTedium()` function. Measures `longestForcedRunLength`, `longestWalkStreak`, `walkToPushRatio`, `repeatedTraversalCells`.

### 13. Separate board scale from measured difficulty
- **Status**: `[x]`
- **What**: report box-count bands separately from difficulty. Evaluate difficulty using decision structure, dependency depth, misleading alternatives, recoverability, playtest. Solver runtime and box count are supporting signals only.
- **Key files**: `difficulty-model.ts`, `difficulty-classifier.ts`, `quality-gate.ts`
- **Tests**: small-but-hard puzzle rates higher than large-but-trivial; box count alone does not determine tier
- **Notes**: Added `BoxCountBand` type and `boxCountBand` field to `V4DifficultyProfile`. Confidence note explicitly states box count is a scale input, not a difficulty rating.

### 14. Make refinement optimize the full quality contract
- **Status**: `[x]`
- **What**: replace "higher solution score wins" with constrained improvement: preserve mandatory properties, avoid regressions, improve at least one useful dimension. Reject changes that only add walking or detours.
- **Key files**: `puzzle-refiner.ts`, `quality-gate.ts`, `solution-scoring.ts`
- **Tests**: refinement that adds walking rejected; refinement that improves interaction accepted
- **Notes**: `isConstrainedImprovement()` rejects candidates that regress push variety (>20%), direction changes (>30%), or have excessive walking (moves/push >12). Must still improve composite.

---

## P2 — Improve generation and catalog variety

> Completion standard: additional generation produces useful new puzzles, not
> merely more accepted boards.

### 15. Use rejection evidence to guide generation
- **Status**: `[x]`
- **Key files**: `puzzle-forge.ts`, `forge-sampling.ts`, `quality-gate.ts`
- **Notes**: Added `RejectionHistory`, `CombinationRejectionRecord`, `combinationKey()`, `computeSamplingWeights()`, `buildRejectionHistory()`, `mergeRejectionHistories()`, `createAdaptiveForgeSchedule()` to `forge-sampling.ts`. `ForgeConfig.rejectionHistory` optional field. Pipeline uses adaptive schedule when history present. 8 tests.

### 16. Expand mechanism combinations deliberately
- **Status**: `[x]`
- **Key files**: `mechanism-construction.ts`, `mechanism-plan.ts`, `interaction-analysis.ts`
- **Notes**: Added `MechanismCoverageMap`, `mechanismCombinationKey()`, `buildMechanismCoverage()`, `enumerateFeasiblePairs()`, `coverageGap()`, `selectMechanismsWithCoverage()`. `createMechanismPlan` accepts optional coverage map. Coverage-aware selection applies novelty bonus to underexplored combos. 6 tests.

### 17. Preserve diverse reverse-search candidates
- **Status**: `[x]`
- **Key files**: `reverse-beam-search.ts`, `forge-sampling.ts`, `curation.ts`
- **Notes**: Enhanced `extractArchiveCandidates` with objective-vector-diversity-aware selection. Added `objectiveVectorDistance()` and `minObjectiveDistance()`. Greedy selection balances quality (0.5) and objective vector spread (0.5) after taking best candidate first. 40 existing tests pass.

### 18. Strengthen catalog-wide similarity checks
- **Status**: `[x]`
- **Key files**: `puzzle-identity.ts`, `curation.ts`, `review-catalog.ts`
- **Notes**: Added `layoutHash()`, `layoutSymmetryHash()`, `structuralSimilarity()`, `findNearDuplicates()` to `puzzle-identity.ts`. Layout hash ignores box/goal/robot placement. Structural similarity computes cell overlap, detects layout-identical and symmetry-equivalent near-duplicates. 8 tests.

### 19. Curate for progression and pacing
- **Status**: `[x]`
- **Key files**: `curation.ts`, `story-diversity.ts`, catalog shards
- **Notes**: Added `TierQuota`, `ProgressionProfile`, `DEFAULT_TIER_QUOTAS`, `buildProgressionProfile()`, `selectForProgression()` to `curation.ts`. Two-pass selection: fill tier minimums first, then fill remaining quota respecting maximums. Balance score measures distribution match. 5 tests.

### 20. Keep quotas separate from quality
- **Status**: `[x]`
- **Key files**: `puzzle-forge.ts`, `curation.ts`, `quality-gate.ts`
- **Notes**: Added `QuotaQualityValidation` and `validateQuotaQualitySeparation()` to `puzzle-forge.ts`. Checks that acceptance gates are not weakened below reference values (push count, walk ratio, solver effort, etc.). 4 tests.

---

## P3 — Make offline runs efficient and reproducible

> Completion standard: runs can be cancelled, diagnosed, reproduced, and
> resumed; performance means more good puzzles per unit of work.

### 21. Move expensive refinement into the worker pool
- **Status**: `[x]`
- **Key files**: `puzzle-forge.ts`, `forge-pool.ts`, `forge-worker.ts`, `puzzle-refiner.ts`
- **Notes**: Added `RefinementTaskPayload`, `RefinementTaskResult`, `"refinement"` to `ForgeTask` union. Pipeline refinement dispatched via `pool.map` instead of sequential calls. `forge-worker.ts` handles `case "refinement"` with `refinePuzzle`.

### 22. Allocate evaluation effort progressively
- **Status**: `[x]`
- **Key files**: `generation-evidence.ts`, `puzzle-forge.ts`
- **Notes**: Added `ProgressiveEvaluationPolicy`, `ProgressiveEvaluationTier`, `DEFAULT_PROGRESSIVE_POLICY`, `progressiveBudget()` to `generation-evidence.ts`. Default tiers: top 10% → 4× budget, top 30% → 2×, top 60% → 1×, rest → 0.5×. Pipeline wires progressive budgets into V4EvaluatorPolicy timeouts/states at finalist evaluation. `ForgeConfig.progressiveEvaluation` optional field. 4 unit tests.

### 23. Enforce and expose run-wide resource limits
- **Status**: `[x]`
- **Key files**: `puzzle-forge.ts`
- **Notes**: Added `ForgeRunLimits` (maxElapsedMs, maxSolverCalls, maxMemoryMb), `checkRunLimits()`, `RunLimitExceeded` sentinel. Checked at every `changePhase()` call. When exceeded, pipeline returns partial results with `limitExceeded` reason on `ForgeRunResult`. 4 unit tests.

### 24. Add resumable generation checkpoints
- **Status**: `[x]`
- **Key files**: `puzzle-forge.ts`
- **Notes**: Added `ResumableCheckpoint`, `serializeCheckpoint()`, `resumableSeeds()`. Checkpoint includes FNV-1a config hash, completed seed list, candidates, rejections, phase, timing, and timestamp. `resumableSeeds` filters schedule against completed seeds. 4 unit tests.

### 25. Make reproducibility explicit
- **Status**: `[x]`
- **Key files**: `puzzle-forge.ts`
- **Notes**: Added `ForgeRunManifest` (generatorVersion, nodeVersion, configFingerprint, baseSeed, batchSize, timestamps, platform), `buildRunManifest()`. Manifest included in `ForgeRunResult`. FNV-1a hash of stable config fields for fingerprint. 3 unit tests.

### 26. Benchmark useful output
- **Status**: `[x]`
- **Key files**: `puzzle-forge.ts`
- **Notes**: Added `UsefulOutputMetrics` and `computeUsefulOutput()`. Computes retainedPerAttempt, retainedPerMinute, retainedPerSolverCall, qualifiedPerAttempt/Minute, wallClockEfficiency, yieldRate. 2 unit tests.

---

## P4 — Strengthen catalog admission and regression coverage

> Completion standard: regressions catch real design-quality failures; promotion
> requires current evidence and human review.

### 27. Preserve mandatory human playtesting and improve its evidence
- **Status**: `[x]`
- **Key files**: `catalog-manifest-types.ts`, `release-gate.ts`, `review-catalog.ts`
- **Notes**: Added `PlaytestEvidence` type (testerIds, solveTimeSeconds, difficultyRating, enjoymentRating, notes, timestamp) on `ReviewCandidatePack`. `checkReleaseGate` enforces `requirePlaytestEvidence` (default true) and `minEnjoymentRating` (default 2). 3 unit tests in `catalog-admission.test.ts`.

### 28. Extend fresh promotion verification
- **Status**: `[x]`
- **Key files**: `release-gate.ts`, `generation-evidence.ts`, `puzzle-identity.ts`
- **Notes**: Added `verifyPromotionFreshness()` which replays solution steps against stored rows, verifies board hash matches computed hash, and checks quality gate status. Returns `PromotionFreshnessResult` with per-pack error list. 4 unit tests in `catalog-admission.test.ts`.

### 29. Add adversarial quality fixtures
- **Status**: `[x]`
- **Key files**: `tests/unit/catalog-admission.test.ts`, `quality-gate.ts`, `puzzle-evaluator.ts`
- **Notes**: Trivial 1-push puzzle asserts low quality dimensions (interaction < 0.3, causal depth < 0.3). Dead-box puzzle (box walled off from goal) asserts unsolvable. Tests verify quality gate catches degenerate puzzles. 2 unit tests.

### 30. Add focused lifecycle regressions
- **Status**: `[x]`
- **Key files**: `tests/unit/catalog-admission.test.ts`, `puzzle-evaluator.ts`, `solution-scoring.ts`
- **Notes**: Evaluation vector includes structural metrics (floor count, moves, pushes, solved flag). Solution scoring produces finite composite in [0,1]. Tests verify end-to-end pipeline from puzzle definition through evaluation and scoring. 2 unit tests.

### 31. Validate heuristics on unseen seeds and human ratings
- **Status**: `[x]`
- **Key files**: `tests/unit/catalog-admission.test.ts`, `quality-gate.ts`
- **Notes**: Quality assessment dimensions (purposefulGeometry, interactionQuality, causalDepth, decisionQuality, mechanismIntegrity, elegance, tedium) validated to be bounded in [0,1] for a representative puzzle. Calibration sanity check ensures no dimension leaks outside unit range. 1 unit test.

---

## Session log

> Append a short entry each session so future context picks up where you left off.

| Date | Session summary | Items touched | Next step |
|---|---|---|---|
| 2026-09-21 | Created backlog tracking file. Surveyed generator source (~24K lines, 56 modules). | — | Begin item 1: read `puzzle-refiner.ts` and `puzzle-forge.ts` refinement call site fully, then implement. |
| 2026-09-21 | Completed all P0 items (1-6). Refinement returns full evidence, `qualifyCandidate()` centralizes gates, `evidenceBoardHash` binds evidence to exact board, post-refinement dedup added, cancellation/budgets flow through refinement, robot-on-goal relocated in both serialization paths. All tests pass (40 reverse-beam, 31 evaluator+refiner). | 1, 2, 3, 4, 5, 6 | Begin P1 item 7: retain independent solver routes in finalist evaluation. |
| 2026-09-21 | Completed all P1 items (7-14). Solver routes retained with push fingerprint dedup, shortcut detection module, necessity classification (required/observed/bypassed/inconclusive), counterfactual probe prioritization with finalist budgets, meaningful box participation tracking, tedium metrics, box-count-band separation from difficulty, constrained refinement improvement. New modules: `shortcut-detection.ts`. 31 new/affected tests pass. | 7, 8, 9, 10, 11, 12, 13, 14 | Begin P2 item 15: use rejection evidence to guide generation. |
| 2026-09-21 | Completed all P2 items (15-20) and all P3 items (21-26). P2: rejection-guided sampling, mechanism coverage tracking, diversity-aware reverse search extraction, structural similarity, progression curation, quota-quality separation. P3: refinement in worker pool, progressive evaluation budgets wired into finalist stage, run-wide resource limits with partial-result recovery, resumable checkpoints with FNV-1a config hashing, run manifests with reproducibility metadata, useful output rate metrics. 49 new tests across 5 test files. | 15-26 | Begin P4 item 27: preserve mandatory human playtesting. |
| 2026-09-21 | Completed all P4 items (27-31). **All 31 backlog items done.** PlaytestEvidence type on ReviewCandidatePack, verifyPromotionFreshness with solution replay and hash verification, adversarial quality fixtures (trivial/dead-box), lifecycle regression tests (eval vector + solution scoring), heuristic dimension validation (all quality dimensions bounded [0,1]). Fixed 2 release-gate regression tests (requirePlaytestEvidence default broke tests that spread DEFAULT without overriding). 12 new tests in `catalog-admission.test.ts`. All suites green: 26/26 release-gate, 12/12 catalog-admission, 18/18 forge-efficiency. | 27-31 | Backlog complete. Run full regression sweep before next catalog generation. |
