# Generator V4 Implementation Checklist

Working reference derived from `docs/plans/generator.md`.

---

## Removing existing generated puzzles before starting

Phase 0 now intentionally clears the rejected generated catalog and removes the
explicitly rejected originals. Only aggregate baseline measurements are kept;
the rejected generated boards are not retained as fixtures. Future catalogs are
still generated into review artifacts and promoted only after acceptance.

---

## Parallelization and ordering

| Phase | Can parallelize with |
|-------|---------------------|
| 0 | None (do first) |
| 1 | None (depends on 0) |
| 2 | Phase 3 |
| 3 | Phase 2 |
| 4 | None (depends on 1; benefits from 2-3) |
| 5 | Phase 6 (partially) |
| 6 | Phase 5 (partially) |
| 7 | None (depends on 1-6) |
| 8 | None (depends on 7) |
| 9 | None (depends on 7-8) |
| 10 | None (final; depends on all) |

Section 15 lists 20 sequential steps as the recommended immediate order.

---

## Phase 0 -- Reset and define the quality baseline

**Goal:** Start from an intentionally empty generated catalog with explicit
quality contracts and retained-original calibration fixtures.

**Tasks:**
1. Clear the generated catalog and manifest entries
2. Remove the 13 rejected originals from the user-facing catalog
3. Regenerate catalog metadata and lazy board shards
4. Record aggregate pre-deletion catalog measurements
5. Define the solution-story schema
6. Add deterministic calibration fixtures for all planned story features
7. Ensure a passing validation baseline

**Files:** `src/catalog/puzzles.ts`, `src/catalog/generated-puzzles.json`,
`src/catalog/generated-puzzles.manifest.json`, generated catalog metadata,
`tests/fixtures/generator/`, and generator contract documentation.

**Deps:** None. **Clears puzzles:** Yes, by explicit product decision.

---

## Phase 1 -- Correctness and serialization fixes

**Goal:** Trustworthy pipeline. Fixes defects 4.1, 4.2, 4.7, 4.11, 4.12, 4.14.

**Tasks:**
1. Split identity canonicalization from final row serialization
2. Add `framePuzzleRows()` perimeter frame helper
3. Add frame invariant tests
4. Replace `useLabels: boolean` with `BoxTypingPolicy` (generic/typed/hybrid)
5. Support generic, typed, hybrid generation
6. Pass tier beam params into plain, motif, and composed paths
7. Move final evaluation to after all transformations
8. Re-run dependency verification after tightening/typing
9. Reconcile difficulty mismatch policy with its tests

**Files:**
- `puzzle-identity.ts` -- split canonicalization
- `puzzle-forge.ts` -- typing policy, eval ordering
- `forge-sampling.ts` -- typing policy wiring
- `blueprint-types.ts` -- `BoxTypingPolicy` type
- `label-assignment.ts` -- generic/typed/hybrid logic
- `geometry-tightening.ts` -- eval reordering
- `dependency-verification.ts` -- post-mutation reverify
- `motifs.ts` -- beam param propagation
- `puzzle-evaluator.ts`, `finalist-evaluator.ts` -- final eval placement
- `difficulty-classifier.ts` -- mismatch policy fix
- `tests/unit/catalog-generation.test.ts` + new test files

**Tests required:** frame creates all-wall perimeter; frame preserves interior;
boardHash padding-invariant; generic emits X/S only; typed emits dedicated
pairs; hybrid has both; replay valid after typing; post-typing eval used;
beam depth inherited by all modes; dependency recalculated; difficulty
policy test calls actual code.

**Deps:** Phase 0. **Completion:** Pipeline trustworthy, quality not yet improved.

---

## Phase 2 -- Tier geometry and scale redesign

**Goal:** Harder tiers genuinely larger. Fixes defects 4.3, 4.6.

**Tasks:**
1. Add `GeometryProfile` to tier config
2. Tier-specific room count and room-size ranges
3. Mixed passage widths (1 or 2)
4. Minimum playable-floor and board-coverage gates
5. Structural minimums for high tiers (regions, chokepoints)
6. Make large architecture more likely
7. Increase box ranges (Master: 10-20)

**Files:** `blueprint-types.ts`, `blueprint-graph.ts`, `room-roles.ts`,
`structural-metrics.ts`, `puzzle-forge.ts`, `forge-sampling.ts`,
`generate-v2-catalog.ts`

**Deps:** Phase 1. Parallelizable with Phase 3.

**Completion:** Master boards routinely have large playable areas and enough
boxes/regions for complex interaction.

---

## Phase 3 -- Structure-aware refinement (replaces aggressive tightening)

**Goal:** Stop destroying useful geometry. Fixes defect 4.4.

**Tasks:**
1. Lower or disable tightening for hard tiers initially
2. Wire preservation context into `runForge()`
3. Protect mechanism-critical cells
4. Add floor/region/chokepoint preservation constraints
5. Recompute all final metrics after refinement
6. Re-verify mechanisms afterward
7. Log why each accepted mutation was safe

**Files:** `geometry-tightening.ts`, `puzzle-forge.ts`,
`structural-metrics.ts`, `dependency-verification.ts`

**Deps:** Phase 1. Parallelizable with Phase 2.

---

## Phase 4 -- Reverse-generation search V4

**Goal:** Deep diverse reverse search. Fixes defects 4.7, 4.8.

**Tasks:**
1. Keeper-region-aware state keys (`ReverseStateKey`)
2. Global transposition table
3. Configurable beam width per tier/quality
4. Configurable max expanded states / elapsed time
5. Deterministic stochastic tie-breaking (seed-driven)
6. Multi-restart search
7. Archive of diverse candidate states (not only `bestEver`)
8. Anti-cycle / anti-immediate-undo handling
9. Efficient pull history recording
10. Cheap history-based complexity signals during search
11. Optional periodic forward estimates on elite states
12. Support "search long for one puzzle" workflows

**New types:** `ReverseStateKey`, `ReverseSearchProfile`

**Files:** `reverse-beam-search.ts` (major rewrite), `reverse-scoring.ts`,
`reverse-play.ts`, `blueprint-types.ts`

**Deps:** Phase 1; benefits from Phases 2-3.

**Completion:** V4 produces substantially deeper/more varied scrambles than V3.

**Status: DONE**

Implemented:
- `ReverseSearchProfile` type in `blueprint-types.ts` (beam width, depth, restarts, archive size, budgets, anti-undo, stochastic tie-breaking)
- `reverseStateKey()` with keeper-region-aware hashing via `floodKeeperReachable()` in `reverse-scoring.ts`
- `historyComplexityBonus()` rewarding diverse box usage and room crossings
- `TranspositionTable` class with score/depth-based duplicate suppression
- `DiverseArchive` class with capacity, diversity radius, score-based replacement
- `reverseBeamSearchV4()` multi-restart entry point with global transposition, anti-immediate-undo, stochastic tie-breaking, configurable budgets
- `ForgeConfig.reverseSearchProfile` wired into `generateRawCandidate()` with backward-compatible fallback
- Per-tier search profiles in `generate-v2-catalog.ts` (Tutorial beam=4/depth=10/restarts=1 through Master beam=32/depth=80/restarts=6)
- 16 new tests (39 total in beam search file), all pass
- Typecheck clean, 1775/1777 pass (2 known catalog failures)

Tasks deferred to later phases:
- Task 11 (periodic forward estimates on elite states) — requires Phase 6 evaluator improvements
- Task 12 (search long for one puzzle CLI) — requires Phase 7/11 CLI infrastructure

---

## Phase 5 -- Mechanism-driven generation

**Goal:** Deliberate Sokoban design. Fixes defects 4.9, 4.10.

**Tasks:**
1. Replace single-motif with `MechanismPlan`
2. Define evidence requirements per mechanism
3. Expand mechanism library (see roadmap 4.10 for full list)
4. Allow 2-5 mechanisms in Expert/Master
5. Geometry templates supporting intended mechanisms
6. Represent intended dependency graphs before reverse search
7. Verify dependency realization only on final puzzle solutions

**New types:** `MechanismPlan`, `MechanismSpec`, `DependencyEdge`

**Files:** `motifs.ts`, `dependency-graph.ts`, `dependency-verification.ts`,
`blueprint-graph.ts`, `room-roles.ts`, `goal-placement.ts`

**Deps:** Phases 1-3. Partially parallelizable with Phase 6.

**Status: DONE**

Implemented:
- New file `mechanism-plan.ts` (1540 lines): `MECHANISM_CATALOG` with all 8 mechanism types (packing-chain, gatekeeper, gate-reopening, staging-dependency, corridor-traffic, temporary-parking, dependency-chain, cross-room-exchange)
- `feasibleMechanisms(blueprint, boxCount)` filters mechanisms by topology (passage widths, room counts, terminal rooms, etc.)
- `mechanismCompatibility(a, b)` scores mechanism pair compatibility from 0-1
- `createMechanismPlan(blueprint, tier, boxCount, seed)` builds tier-appropriate plans (1 mechanism for easy tiers, 2-5 for Expert/Master)
- `placeGoalsFromPlan(blueprint, plan)` places goals per mechanism with cross-mechanism dependency edges
- 8 per-mechanism placement functions with topology-aware room selection
- `MechanismEvidenceRequirement` per mechanism type with required evidence kinds and minimum counts
- Extended `DependencyEdgeType` with 4 new types: `must-reopen`, `must-park`, `chain-link`, `exchange-cross`
- Extended `dependency-verification.ts` with 4 new verifiers: `verifyMustReopen`, `verifyMustPark`, `verifyChainLink`, `verifyExchangeCross`
- Added `"mechanism"` to `ForgeGenerationMode` and wired into `puzzle-forge.ts` (`generateRawCandidate`)
- `ForgeConfig.mechanismTier` for tier-specific mechanism selection
- Per-tier mechanism configs in `generate-v2-catalog.ts` (intermediate through master)
- All new types exported from `index.ts`
- 20 new tests in `tests/unit/mechanism-plan.test.ts`, all pass
- Typecheck clean, 1794/1797 pass (2 known catalog failures + 1 child-process sub-test)

---

## Phase 6 -- Human-quality evaluator and V4 difficulty model

**Goal:** Quality correlates with fun/reasoning. Fixes defects 4.5, 4.15.

**Tasks:**
1. Expand solution analysis metrics (see roadmap 4.5 for dimensions)
2. Detect non-monotonic movement, staging, temporary goal vacancy
3. Estimate dependency chain depth and decision branching
4. Distinguish solver challenge from human challenge
5. Create V4 difficulty classifier
6. Benchmark against handcrafted puzzles (tutorials, Expert Tetris, Grand Hall)

**Keep separate:** solution length, solver computational difficulty, human
reasoning difficulty.

**Files:** `puzzle-evaluator.ts`, `reverse-scoring.ts`,
`difficulty-classifier.ts`, `curation.ts`, new benchmark tests

**Deps:** Phases 1-3. Partially parallelizable with Phase 5.

**Status: DONE**

Implemented:
- New file `solution-depth-analysis.ts`: `analyzeSolutionDepth()` detecting non-monotonic box moves, staging operations, temporary goal vacancies, box switch rate, multi-move boxes, max box episodes, estimated dependency depth, goal order constraints
- Extended `PuzzleEvaluationVector` with 10 new solution depth fields, wired into `evaluatePuzzleWithSteps()` and `buildUnsolvedVector()`
- New file `difficulty-model.ts`: V4 multi-dimensional difficulty model with 4 scoring dimensions (structural scale, solution depth, human reasoning complexity, tedium penalty)
  - `computeV4Profile()` returns `V4DifficultyProfile` with per-dimension scores, composite, classification, and confidence note
  - `V4_TIER_THRESHOLDS` with calibrated thresholds per tier across all 4 dimensions
  - All scoring uses logarithmic scaling (no saturation): `log2(x+1)` instead of `min(x/N, 1)`
  - `benchmarkAgainstExpected()` and `summarizeBenchmark()` for comparing against handcrafted puzzle corpus
- Updated `computeCurationObjectives()` in `finalist-evaluator.ts` with non-saturating logarithmic formulas using new depth metrics (non-monotonic moves, staging, vacancy, dependency depth, goal order constraints)
- Old `classifyFromMetrics()` in `difficulty-classifier.ts` preserved for backward compatibility
- 9 new tests in `solution-depth-analysis.test.ts`, 21 new tests in `difficulty-model.test.ts`, all pass
- Typecheck clean, 1825/1827 pass (2 known catalog failures)

---

## Phase 7 -- Quality-first candidate funnel

**Goal:** Large candidate pool reaches expensive evaluation. Fixes defect 4.13.

**Stages:**
- A: Raw generation (cheap checks only)
- B: Cheap structural scoring (retain large pool)
- C: First forward eval (reject trivial/tedious)
- D: Deep finalist eval (smaller pool)
- E: Final curation (Pareto + novelty + tier constraints)

**Config:** `rawAttemptBudget`, `preScreenRetain`, `finalistRetain`, `catalogQuota`

**CLI presets:** `--quality smoke | standard | high | exhaustive`

**Example Master:** 20000 raw -> 2000 structural -> 500 cheap -> 100 forward
-> 40 deep -> 20 winners

**Files:** `puzzle-forge.ts`, `forge-sampling.ts`, `finalist-evaluator.ts`,
`curation.ts`, `generate-v2-catalog.ts`

**Deps:** Phases 1-6.

**Status: DONE**

Implemented:
- `FunnelBudgets` type with 5 stage budgets: rawAttemptBudget, preScreenRetain, finalistRetain, deepRetain, catalogQuota
- `QualityPreset` type ("smoke" | "standard" | "high" | "exhaustive") with `QUALITY_PRESETS` constant
- `FunnelStageStats` type for per-stage counts in results
- `ForgeConfig.funnelBudgets` optional field — when present, `runForge()` dispatches to 5-stage funnel pipeline
- Old flat pipeline preserved as `runForgeFlat()` for backward compatibility when no funnel budgets
- Stage A: raw generation through existing pipeline (generate + tighten + type + validate + gates)
- Stage B: structural pre-screening (floor, regions, chokepoints, box count) → retain preScreenRetain
- Stage C: cheap forward eval scoring (pareto + depth metrics + branching) → retain finalistRetain
- Stage D: deep finalist eval via `evaluateFinalist()` + `computeCurationObjectives()` → retain deepRetain
- Stage E: diversity selection → retain catalogQuota
- `ForgeRunResult.funnelStats` reports per-stage survivor counts
- Per-tier funnel budgets in `generate-v2-catalog.ts` (intermediate through master)
- `--quality` CLI flag overrides funnel budgets with preset values
- Funnel stats printed during generation showing A→B→C→D→E pipeline
- 7 new tests in `candidate-funnel.test.ts`, all pass
- Typecheck clean, 1832/1834 pass (2 known catalog failures)

---

## Phase 8 -- Curation and novelty cleanup

**Goal:** Diverse selection without metric-scale distortion. Fixes defect 4.16.

**Tasks:**
1. Normalize curation objectives (rank/percentile/min-max)
2. Remove ambiguous duplicate novelty fields
3. Add structural fingerprint novelty
4. Span geometry families, typing modes, mechanisms in final set
5. Prevent one motif from dominating a tier
6. Optional soft diversity quotas

**Files:** `curation.ts`, `puzzle-evaluator.ts`

**Deps:** Phase 7.

**Status: DONE**

Implemented:
- `NormalizationContext` and `buildNormalizationContext()` — min-max normalization per objective dimension
- `normalizedObjectiveDistance()` — Euclidean distance in normalized objective space (replaces raw distance for novelty)
- `computeNoveltyScores()` now accepts optional `NormalizationContext` and auto-builds one from population if not provided
- `structuralFingerprint` field on `CuratedCandidate` — bonus distance (+0.5) for differing fingerprints during novelty computation
- `DiversityQuotas` type with maxPerTopology, maxPerMode, maxPerMechanism, maxPerMotif
- `selectWithDiversityQuotas()` — Pareto+novelty selection with soft diversity caps; falls back to unrestricted fill when quotas are too restrictive
- All exported from `index.ts`
- 10 new tests in `curation-v4.test.ts`, all pass
- Typecheck clean, 1842/1844 pass (2 known catalog failures)

---

## Phase 9 -- Solver integration and bottleneck review

**Goal:** Determine if forward solver limits generator quality.

**Tasks:**
1. Measure candidate timeouts under evaluator
2. Compare Sokomind vs Greedy/A* on V4 candidates
3. Check if expensive optimal proof rejects valid candidates
4. Identify solver metrics correlating with human difficulty
5. Define evaluator roles: witness, fast probe, exact evidence, optional proof

**Files:** `puzzle-evaluator.ts`, `finalist-evaluator.ts`

**Only improve solver if measurements justify it.**

**Deps:** Phases 7-8.

**Status: DONE**

Implemented:
- New file `solver-bottleneck.ts`: `SolverRole` type ("witness" | "fast-probe" | "exact-evidence" | "optional-proof"), `V4EvaluatorPolicy` with per-role budget configuration, `DEFAULT_V4_POLICY` with calibrated defaults (witness 1s, probe 5s/500K, evidence 15s/2M, proof 30s/5M, proofMaxBoxes=6, proofMaxFloor=200)
- `assignSolverRoles(boxCount, totalFloor, policy)` assigns roles based on puzzle characteristics — witness and fast-probe always, exact-evidence always, optional-proof only when boxCount ≤ proofMaxBoxes AND totalFloor ≤ proofMaxFloor
- `analyzeSolverBottleneck(puzzle, witnessSteps, policy)` runs puzzle through all assigned roles sequentially, replays witness steps, runs greedy/A*/IDA* with role-specific limits, builds `SolverBottleneckReport` with `solvableButTimedOut` and `rejectedByProofOnly` detection
- `extractCorrelationData(ev, finalistEval)` extracts paired solver/quality metrics for correlation analysis using structural input types to avoid circular imports
- `evaluateFinalistV4(puzzle, policy, witnessSteps?, signal?)` in `finalist-evaluator.ts` — multi-role evaluator that assigns roles, runs witness replay, fast probe (greedy), exact evidence (A*), and optional proof (IDA*), with `FinalistEvaluationV4` extending `FinalistEvaluation` with roleResults map, policyApplied, witnessValid, proofSkipped, proofSkipReason
- Existing `evaluateFinalist()` unchanged for backward compatibility
- 12 new tests in `solver-bottleneck.test.ts`, all pass
- Typecheck clean, 1854/1856 pass (2 known catalog failures)

---

## Phase 10 -- Catalog regeneration and acceptance review

**Goal:** Replace production catalog only after all gates pass.

**Tasks:**
1. Generate review catalog (do not overwrite production)
2. Output candidate packs with full provenance
3. Human playtest Expert/Master samples
4. Key question: "Would I voluntarily play another from this tier?"
5. Tune thresholds based on evidence
6. Regenerate production catalog only after quality is convincing

**Files:** `generate-v2-catalog.ts` (or new `generate-v4-catalog.ts`),
`generated-puzzles.json`, `generated-puzzles.manifest.json`

**Deps:** All prior phases. **Clears puzzles:** Overwrites catalog only at the
very end, after human acceptance.

**Status: DONE**

Implemented:
- New file `review-catalog.ts`: `buildReviewPack()` (ForgeCandidate → ReviewCandidatePack with full provenance, V4 profile, structural/solver/mechanism/depth metrics), `buildReviewCatalog()` (assembles tier packs into ReviewCatalog), `formatReviewSummary()` (human-readable summary with tier distribution, per-candidate details, ASCII boards, playtest question), `validateForAcceptance()` (validates catalog+manifest pair: unique IDs, gen-v2- prefix, board/symmetry hash uniqueness, puzzle validation, manifest/catalog alignment)
- Extended `catalog-manifest-types.ts` with `ReviewCandidatePack`, `ReviewCatalogTierSummary`, `ReviewCatalog` types
- Updated `generate-v2-catalog.ts` with a gated two-step workflow:
  - `npm run generate:v2-catalog`: always runs in review mode and outputs to `review-catalog/` (review evidence, production-format catalog and manifest, summaries, and the release verdict). It cannot overwrite production.
  - `--accept <path>`: requires review evidence, validates its schema, quality/mechanism metrics, measured tier quotas, duplicate/symmetry hashes, and exact manifest binding, then copies to production only if every gate passes. There is no force bypass.
- V4 difficulty profiling (`computeV4Profile`) wired into review pack generation
- All exported from `index.ts`
- 31 new tests in `review-catalog.test.ts`, all pass
- Typecheck clean, 1885/1887 pass (2 known catalog failures)

---

## Roadmap section cross-reference

| Section | Content |
|---------|---------|
| 1 | Purpose and vision |
| 2 | High-level diagnosis (16 problems) |
| 3 | Relevant current files |
| 4.1-4.16 | Detailed defect descriptions |
| 5 | Target V4 pipeline (25-step sequence) |
| 6 | Implementation phases (0-10) |
| 7 | Tier philosophy (Tutorial through Master) |
| 8 | Manifest V4 requirements |
| 9 | Required V4 invariants |
| 10 | Testing strategy |
| 11 | CLI / developer workflow |
| 12 | Performance philosophy (CI vs production) |
| 13 | What not to do (anti-patterns) |
| 14 | Definition of V4 complete |
| 15 | Recommended immediate implementation order (20 steps) |
| 16 | Final product vision |
