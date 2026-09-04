/**
 * Release gate tests -- Sprint 12
 *
 * Tests for checkReleaseGate, formatReleaseVerdict, and
 * buildFinalReviewCatalog.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

import {
  checkReleaseGate,
  checkReviewManifestBinding,
  formatReleaseVerdict,
  DEFAULT_RELEASE_GATE_CONFIG,
  type ReleaseGateConfig,
} from "../../src/features/generator/v2/release-gate.ts";

import {
  buildReviewPack,
  buildReviewCatalog,
  buildFinalReviewCatalog,
  type FinalReviewTierTarget,
} from "../../src/features/generator/v2/review-catalog.ts";

import type {
  ReviewCandidatePack,
  ReviewCatalog,
} from "../../src/features/generator/v2/catalog-manifest-types.ts";

import type {
  ForgeCandidate,
  ForgeProvenance,
} from "../../src/features/generator/v2/puzzle-forge.ts";

import type { PuzzleEvaluationVector } from "../../src/features/generator/v2/puzzle-evaluator.ts";
import type { PuzzleDefinition, Difficulty } from "../../src/core/model.ts";
import { syntheticStoryReport } from "../support/story-quality.ts";
import { boardHash } from "../../src/features/generator/v2/puzzle-identity.ts";
import { computeV4Profile } from "../../src/features/generator/v2/difficulty-model.ts";
import { DIFFICULTIES } from "../../src/core/model.ts";

// ---------------------------------------------------------------------------
// Mock builders (same shape as review-catalog.test.ts)
// ---------------------------------------------------------------------------

function makeEvaluation(
  overrides: Partial<PuzzleEvaluationVector> = {},
): PuzzleEvaluationVector {
  return {
    solverExpandedStates: 50,
    solverGeneratedStates: 100,
    solverElapsedMs: 10,
    solverPeakFrontier: 20,
    solverDeadlockPrunes: 5,
    solverDuplicateStates: 15,
    solutionMoves: 20,
    solutionPushes: 8,
    solutionWalks: 12,
    pushRatio: 0.4,
    boxCount: 3,
    avgLegalPushes: 2.5,
    maxLegalPushes: 5,
    singleChoiceRatio: 0.3,
    highBranchCount: 2,
    avgReachablePushes: 3.0,
    maxReachablePushes: 6,
    reachableSingleChoiceRatio: 0.25,
    reachableHighBranchCount: 3,
    reachableForcedPushRatio: 0.2,
    boxIndependenceRatio: 0.5,
    boxInteractionEvents: 4,
    pushesPerBox: 2.67,
    pushSwitchRatio: 0.6,
    sharedRouteCells: 2,
    sharedSupportCells: 1,
    sharedChokepointUses: 1,
    causalEnableCount: 2,
    causalDisableCount: 1,
    crossTypeSharedRouteCells: 1,
    crossTypeSharedSupportCells: 1,
    crossTypeSharedChokepoints: 0,
    crossTypeCausalEnableCount: 1,
    crossTypeCausalDisableCount: 0,
    minPushesPerBox: 2,
    inactiveBoxCount: 0,
    onePushBoxCount: 0,
    roomCrossingsInSolution: 3,
    deadlockDensity: 0.05,
    articulationPoints: 2,
    regionCount: 3,
    tunnelCells: 4,
    chokepoints: 2,
    floorUtilization: 0.35,
    openAreaRatio: 0.15,
    emptyWalkRatio: 0.3,
    longestWalkStreak: 5,
    forcedPushRatio: 0.2,
    repetitivePushRatio: 0.1,
    unusedFloorRatio: 0.25,
    movesPerPush: 2.5,
    solutionFloorCoverage: 0.75,
    solutionUnusedFloorRatio: 0.25,
    nonMonotonicBoxMoves: 2,
    nonMonotonicBoxCount: 1,
    stagingOperations: 1,
    temporaryGoalVacancies: 0,
    boxSwitchRate: 0.4,
    distinctBoxesMoved: 3,
    multiMoveBoxCount: 2,
    maxBoxEpisodes: 3,
    estimatedDependencyDepth: 2,
    goalOrderConstraints: 1,
    criticalMoveCount: 0,
    criticalMoveRatio: 0,
    boardWidth: 10,
    boardHeight: 10,
    totalFloor: 30,
    solved: true,
    ...overrides,
  };
}

function makeProvenance(
  overrides: Partial<ForgeProvenance> = {},
): ForgeProvenance {
  return {
    seed: 300001,
    family: "hub",
    boxCount: 3,
    mode: "plain",
    difficulty: "beginner",
    tightened: true,
    cellsRemoved: 4,
    typingMode: "hybrid",
    genericBoxCount: 2,
    typedBoxCount: 1,
    ...overrides,
  };
}

const SIMPLE_ROWS: readonly string[] = [
  "OOOOOO",
  "O   SO",
  "O X  O",
  "O  R O",
  "OOOOOO",
];

function makePuzzle(overrides: Partial<PuzzleDefinition> = {}): PuzzleDefinition {
  return {
    id: "gen-v2-300001-abc123",
    title: "Beginner 1",
    difficulty: "beginner" as Difficulty,
    boxes: 1,
    rows: SIMPLE_ROWS,
    collection: "Sokomind Generated",
    ...overrides,
  };
}

function makeCandidate(
  evalOverrides: Partial<PuzzleEvaluationVector> = {},
  provOverrides: Partial<ForgeProvenance> = {},
  puzzleOverrides: Partial<PuzzleDefinition> = {},
): ForgeCandidate {
  const puzzle = makePuzzle(puzzleOverrides);
  const provenance = makeProvenance(provOverrides);
  return {
    puzzle,
    provenance,
    evaluation: makeEvaluation(evalOverrides),
    qualityProfile: {
      story: syntheticStoryReport(boardHash(puzzle.rows), provenance.boxCount, provenance.genericBoxCount),
      purposefulGeometry: 0.7,
      interactionQuality: 0.6,
      causalDepth: 0.5,
      decisionQuality: 0.6,
      mechanismIntegrity: 0.5,
      elegance: 0.7,
      tedium: 0.2,
      passed: true,
      reasons: [],
    },
  };
}

/**
 * Counter-based unique row generator. Each call produces distinct rows so that
 * board hashes never collide across test packs.
 */
let _uniqueRowCounter = 0;

function makeUniqueRows(): readonly string[] {
  const n = _uniqueRowCounter++;
  // Vary both width and the internal layout for uniqueness.
  // Width ranges from 7 to 26 for the first 20 calls, then wraps but adds
  // extra interior spaces at different positions.
  const extraWidth = (n % 20);
  const extraHeight = Math.floor(n / 20);
  const w = 7 + extraWidth;
  const topBot = "O".repeat(w);
  const goalRow = "O" + " ".repeat(w - 4) + "SO";
  const boxRow = "O" + " ".repeat(Math.max(1, w - 5)) + "X" + " ".repeat(1) + "O";
  const robotRow = "O" + " ".repeat(w - 3) + "RO";
  const rows = [topBot, goalRow, boxRow, robotRow];
  // Add unique extra rows for height variation
  for (let i = 0; i < extraHeight; i++) {
    rows.push("O" + " ".repeat(w - 2) + "O");
  }
  rows.push(topBot);
  return rows;
}

/** Build a diverse pack with unique hash for each seed. */
function makeDiversePack(
  seed: number,
  family: "hub" | "linear" | "loop" | "branch" | "nested",
  mode: "plain" | "motif" | "composed" | "mechanism",
  boxCount: number,
  difficulty: Difficulty,
): ReviewCandidatePack {
  const rows = makeUniqueRows();
  const genericBoxCount = difficulty === "beginner" ? 1 : 2;
  const candidate = makeCandidate(
    { boxCount },
    {
      seed,
      family,
      mode,
      boxCount,
      difficulty,
      typingMode: "hybrid",
      genericBoxCount,
      typedBoxCount: boxCount - genericBoxCount,
    },
    { id: `gen-v2-${seed}-hash${seed}`, rows, difficulty },
  );
  const measured = computeV4Profile(candidate.evaluation);
  const pack = buildReviewPack(candidate, difficulty, difficulty, 0, undefined, {
    ...measured,
    classification: difficulty,
  });
  return { ...pack, storyQuality: syntheticStoryReport(pack.boardHash, boxCount, genericBoxCount) };
}

/**
 * Build a catalog with diverse packs across tiers.
 */
function buildDiverseCatalog(
  packsPerTier: Partial<Record<Difficulty, number>> = {},
  familyRotation: readonly ("hub" | "linear" | "loop" | "branch" | "nested")[] = ["hub", "linear", "loop"],
  modeRotation: readonly ("plain" | "motif" | "composed")[] = ["plain", "motif", "composed"],
): ReviewCatalog {
  const tierPacks = new Map<Difficulty, { target: number; packs: ReviewCandidatePack[] }>();
  let seedCounter = 1000;

  const tiers: Difficulty[] = ["tutorial", "beginner", "intermediate", "advanced", "expert", "master"];
  const tierBoxCounts: Readonly<Record<Difficulty, readonly number[]>> = {
    tutorial: [2],
    beginner: [3, 4, 5, 6],
    intermediate: [7, 8, 9],
    advanced: [10, 11, 12, 13],
    expert: [14, 15, 16, 17],
    master: [18, 19, 20, 21, 22],
  };
  for (const tier of tiers) {
    const count = packsPerTier[tier] ?? 0;
    const packs: ReviewCandidatePack[] = [];
    for (let i = 0; i < count; i++) {
      const family = familyRotation[i % familyRotation.length];
      const mode = modeRotation[i % modeRotation.length];
      const range = tierBoxCounts[tier];
      const boxCount = range[i % range.length];
      packs.push(makeDiversePack(seedCounter++, family, mode, boxCount, tier));
    }
    tierPacks.set(tier, { target: Math.max(count, 5), packs });
  }

  return buildReviewCatalog(tierPacks);
}

// ---------------------------------------------------------------------------
// checkReleaseGate tests
// ---------------------------------------------------------------------------

describe("release-gate", () => {
  describe("checkReleaseGate", () => {
    it("passes for a well-populated diverse catalog", () => {
      const catalog = buildDiverseCatalog({
        beginner: 3,
        intermediate: 4,
        advanced: 3,
        expert: 2,
        master: 1,
      });
      const config: ReleaseGateConfig = {
        minTotalPuzzles: 10,
        tierQuotas: {
          tutorial: { min: 0, target: 0 },
          beginner: { min: 2, target: 10 },
          intermediate: { min: 2, target: 15 },
          advanced: { min: 1, target: 10 },
          expert: { min: 0, target: 5 },
          master: { min: 0, target: 3 },
        },
        maxTopologyConcentration: 0.60,
        maxModeConcentration: 0.70,
        maxDifficultyGap: 2,
        minDistinctTopologies: 2,
        minDistinctModes: 2,
        minDistinctBoxCounts: 2,
      };
      const verdict = checkReleaseGate(catalog, config);
      assert.ok(verdict.passed, `should pass, errors: ${verdict.errors.join("; ")}`);
      assert.equal(verdict.totalPuzzles, 13);
    });

    it("fails when total puzzles below minimum", () => {
      const catalog = buildDiverseCatalog({ beginner: 1 });
      const config: ReleaseGateConfig = {
        ...DEFAULT_RELEASE_GATE_CONFIG,
        minTotalPuzzles: 50,
      };
      const verdict = checkReleaseGate(catalog, config);
      assert.ok(!verdict.passed);
      assert.ok(verdict.errors.some((e) => e.includes("Total puzzles")));
    });

    it("fails when a tier is below minimum quota", () => {
      const catalog = buildDiverseCatalog({
        tutorial: 0,
        beginner: 5,
        intermediate: 5,
      });
      const config: ReleaseGateConfig = {
        ...DEFAULT_RELEASE_GATE_CONFIG,
        minTotalPuzzles: 5,
        tierQuotas: {
          tutorial: { min: 3, target: 5 },
          beginner: { min: 2, target: 10 },
          intermediate: { min: 2, target: 15 },
        },
      };
      const verdict = checkReleaseGate(catalog, config);
      assert.ok(!verdict.passed);
      assert.ok(verdict.errors.some((e) => e.includes('Tier "tutorial"')));
    });

    it("warns when a tier is below target but above minimum", () => {
      const catalog = buildDiverseCatalog({
        beginner: 3,
        intermediate: 3,
        advanced: 2,
      });
      const config: ReleaseGateConfig = {
        ...DEFAULT_RELEASE_GATE_CONFIG,
        minTotalPuzzles: 5,
        tierQuotas: {
          tutorial: { min: 0, target: 0 },
          beginner: { min: 1, target: 10 },
          intermediate: { min: 1, target: 10 },
          advanced: { min: 1, target: 10 },
        },
      };
      const verdict = checkReleaseGate(catalog, config);
      // Should pass (all mins met) but have warnings
      assert.ok(verdict.passed, `should pass, errors: ${verdict.errors.join("; ")}`);
      assert.ok(verdict.warnings.some((w) => w.includes("target")));
    });

    it("fails when diversity is too low (single topology)", () => {
      const catalog = buildDiverseCatalog(
        { beginner: 5, intermediate: 5 },
        ["hub"],       // only one topology
        ["plain", "motif", "composed"],
      );
      const config: ReleaseGateConfig = {
        ...DEFAULT_RELEASE_GATE_CONFIG,
        minTotalPuzzles: 5,
        tierQuotas: {
          beginner: { min: 2, target: 5 },
          intermediate: { min: 2, target: 5 },
        },
        minDistinctTopologies: 3,
      };
      const verdict = checkReleaseGate(catalog, config);
      assert.ok(!verdict.passed);
      assert.ok(verdict.errors.some((e) => e.includes("distinct topologies")));
    });

    it("fails when diversity is too low (single mode)", () => {
      const catalog = buildDiverseCatalog(
        { beginner: 5, intermediate: 5 },
        ["hub", "linear", "loop"],
        ["plain"],    // only one mode
      );
      const config: ReleaseGateConfig = {
        ...DEFAULT_RELEASE_GATE_CONFIG,
        minTotalPuzzles: 5,
        tierQuotas: {
          beginner: { min: 2, target: 5 },
          intermediate: { min: 2, target: 5 },
        },
        minDistinctModes: 2,
      };
      const verdict = checkReleaseGate(catalog, config);
      assert.ok(!verdict.passed);
      assert.ok(verdict.errors.some((e) => e.includes("distinct modes")));
    });

    it("warns about topology concentration", () => {
      // 9 out of 10 from hub = 90% concentration
      const catalog = buildDiverseCatalog(
        { beginner: 9, intermediate: 1 },
        ["hub", "hub", "hub", "hub", "hub", "hub", "hub", "hub", "hub", "linear"],
        ["plain", "motif"],
      );
      const config: ReleaseGateConfig = {
        ...DEFAULT_RELEASE_GATE_CONFIG,
        minTotalPuzzles: 5,
        tierQuotas: {
          beginner: { min: 1, target: 5 },
          intermediate: { min: 1, target: 5 },
        },
        maxTopologyConcentration: 0.5,
      };
      const verdict = checkReleaseGate(catalog, config);
      assert.ok(verdict.warnings.some((w) => w.includes("Topology concentration")));
    });

    it("detects duplicate board hashes", () => {
      // Build a catalog with two puzzles sharing identical rows (= same board hash)
      const sharedRows = [
        "OOOOOOO",
        "O   S O",
        "O  X  O",
        "O   R O",
        "OOOOOOO",
      ];
      const cand1 = makeCandidate(
        { boxCount: 3 },
        { seed: 1, family: "hub", mode: "plain", boxCount: 3 },
        { id: "gen-v2-1-dup1", rows: sharedRows },
      );
      const cand2 = makeCandidate(
        { boxCount: 3 },
        { seed: 2, family: "linear", mode: "motif", boxCount: 3 },
        { id: "gen-v2-2-dup2", rows: sharedRows },
      );
      const pack1 = buildReviewPack(cand1, "beginner", "beginner", 0);
      const pack2 = buildReviewPack(cand2, "beginner", "beginner", 0);

      const tierPacks = new Map<Difficulty, { target: number; packs: ReviewCandidatePack[] }>();
      tierPacks.set("beginner", { target: 10, packs: [pack1, pack2] });
      const catalog = buildReviewCatalog(tierPacks);

      const verdict = checkReleaseGate(catalog, {
        ...DEFAULT_RELEASE_GATE_CONFIG,
        minTotalPuzzles: 1,
        tierQuotas: { beginner: { min: 1, target: 2 } },
        minDistinctTopologies: 1,
        minDistinctModes: 1,
        minDistinctBoxCounts: 1,
      });
      assert.ok(!verdict.passed);
      assert.ok(verdict.errors.some((e) => e.includes("Duplicate board hash")));
    });

    it("rejects failed quality evidence and inconsistent tier counts", () => {
      const catalog = buildDiverseCatalog({ beginner: 2 });
      const summary = catalog.tierSummaries.beginner;
      const forged: ReviewCatalog = {
        ...catalog,
        tierSummaries: {
          ...catalog.tierSummaries,
          beginner: {
            ...summary,
            actual: 99,
            candidates: [
              { ...summary.candidates[0], qualityPassed: false, qualityReasons: ["quality floor"] },
              summary.candidates[1],
            ],
          },
        },
      };
      const verdict = checkReleaseGate(forged, {
        ...DEFAULT_RELEASE_GATE_CONFIG,
        minTotalPuzzles: 1,
        tierQuotas: { beginner: { min: 1, target: 2 } },
        minDistinctTopologies: 1,
        minDistinctModes: 1,
        minDistinctBoxCounts: 1,
      });
      assert.ok(!verdict.passed);
      assert.ok(verdict.errors.some((e) => e.includes("quality gate did not pass")));
      assert.ok(verdict.errors.some((e) => e.includes("reported actual 99")));
    });

    it("rejects symmetry duplicates and unverified mechanism claims", () => {
      const catalog = buildDiverseCatalog({ beginner: 2 });
      const summary = catalog.tierSummaries.beginner;
      const first = summary.candidates[0];
      const second = summary.candidates[1];
      const forged: ReviewCatalog = {
        ...catalog,
        tierSummaries: {
          ...catalog.tierSummaries,
          beginner: {
            ...summary,
            candidates: [
              first,
              {
                ...second,
                symmetryHash: first.symmetryHash,
                mode: "mechanism",
                mechanismEvidencePassed: false,
                mechanismEvidenceMissing: ["must-precede"],
              },
            ],
          },
        },
      };
      const verdict = checkReleaseGate(forged, {
        ...DEFAULT_RELEASE_GATE_CONFIG,
        minTotalPuzzles: 1,
        tierQuotas: { beginner: { min: 1, target: 2 } },
        minDistinctTopologies: 1,
        minDistinctModes: 1,
        minDistinctBoxCounts: 1,
      });
      assert.ok(!verdict.passed);
      assert.ok(verdict.errors.some((e) => e.includes("Symmetry duplicate")));
      assert.ok(verdict.errors.some((e) => e.includes("mechanism claim is not verified")));
      assert.ok(verdict.errors.some((e) => e.includes("missing mechanism evidence")));
    });

    it("uses measured classifications rather than requested tiers for quotas", () => {
      const catalog = buildDiverseCatalog({ beginner: 2 });
      const summary = catalog.tierSummaries.beginner;
      const forged: ReviewCatalog = {
        ...catalog,
        tierSummaries: {
          ...catalog.tierSummaries,
          beginner: {
            ...summary,
            candidates: summary.candidates.map((pack) => ({
              ...pack,
              classifiedDifficulty: "intermediate" as const,
              difficultyGap: 1,
            })),
          },
        },
      };
      const verdict = checkReleaseGate(forged, {
        ...DEFAULT_RELEASE_GATE_CONFIG,
        minTotalPuzzles: 1,
        tierQuotas: { beginner: { min: 1, target: 2 } },
        minDistinctTopologies: 1,
        minDistinctModes: 1,
        minDistinctBoxCounts: 1,
      });
      assert.ok(!verdict.passed);
      assert.equal(verdict.tierCoverage.beginner.actual, 0);
      assert.ok(verdict.errors.some((e) => e.includes('Tier "beginner"')));
    });

    it("binds review evidence to the exact promoted manifest", () => {
      const catalog = buildDiverseCatalog({ beginner: 2 });
      const packs = catalog.tierSummaries.beginner.candidates;
      const manifest = {
        schemaVersion: 1,
        puzzles: packs.map((pack) => ({
          id: pack.id,
          boardHash: pack.boardHash,
          symmetryHash: pack.symmetryHash,
          seed: pack.seed,
          family: pack.family,
          mode: pack.mode,
          boxCount: pack.boxCount,
          typingMode: pack.typingMode,
          genericBoxCount: pack.genericBoxCount,
          typedBoxCount: pack.typedBoxCount,
          minPushesPerBox: pack.minPushesPerBox,
          inactiveBoxCount: pack.inactiveBoxCount,
          onePushBoxCount: pack.onePushBoxCount,
          crossTypeInteractionCount: pack.crossTypeInteractionCount,
          intendedDifficulty: pack.intendedDifficulty,
          classifiedDifficulty: pack.classifiedDifficulty,
          difficultyGap: pack.difficultyGap,
        })),
      };

      assert.deepEqual(checkReviewManifestBinding(catalog, manifest), []);
      const mismatched = {
        ...manifest,
        puzzles: manifest.puzzles.map((entry, index) =>
          index === 0 ? { ...entry, boardHash: "tampered" } : entry),
      };
      assert.ok(
        checkReviewManifestBinding(catalog, mismatched)
          .some((error) => error.includes("boardHash does not match")),
      );
    });

    it("detects difficulty gap exceeding maximum", () => {
      const candidate = makeCandidate();
      // Build pack with gap of 3
      const pack = buildReviewPack(candidate, "tutorial", "advanced", 3);

      const tierPacks = new Map<Difficulty, { target: number; packs: ReviewCandidatePack[] }>();
      tierPacks.set("tutorial", { target: 5, packs: [pack] });
      const catalog = buildReviewCatalog(tierPacks);

      const config: ReleaseGateConfig = {
        ...DEFAULT_RELEASE_GATE_CONFIG,
        minTotalPuzzles: 1,
        tierQuotas: { tutorial: { min: 1, target: 5 } },
        maxDifficultyGap: 1,
        minDistinctTopologies: 1,
        minDistinctModes: 1,
        minDistinctBoxCounts: 1,
      };
      const verdict = checkReleaseGate(catalog, config);
      assert.ok(!verdict.passed);
      assert.ok(verdict.errors.some((e) => e.includes("difficulty gap")));
    });

    it("returns correct tier coverage breakdown", () => {
      const catalog = buildDiverseCatalog({ beginner: 3, intermediate: 5 });
      const config: ReleaseGateConfig = {
        ...DEFAULT_RELEASE_GATE_CONFIG,
        minTotalPuzzles: 5,
        tierQuotas: {
          beginner: { min: 2, target: 10 },
          intermediate: { min: 2, target: 10 },
        },
      };
      const verdict = checkReleaseGate(catalog, config);
      assert.equal(verdict.tierCoverage.beginner.actual, 3);
      assert.equal(verdict.tierCoverage.beginner.min, 2);
      assert.ok(verdict.tierCoverage.beginner.metMin);
      assert.ok(!verdict.tierCoverage.beginner.metTarget);
    });

    it("returns diversity metrics", () => {
      const catalog = buildDiverseCatalog(
        { beginner: 5, intermediate: 5 },
        ["hub", "linear", "loop"],
        ["plain", "motif", "composed"],
      );
      const verdict = checkReleaseGate(catalog, DEFAULT_RELEASE_GATE_CONFIG);
      assert.ok(verdict.diversity.distinctTopologies >= 2);
      assert.ok(verdict.diversity.distinctModes >= 2);
      assert.ok(verdict.diversity.distinctBoxCounts >= 1);
      assert.ok(verdict.diversity.topologyConcentration >= 0);
      assert.ok(verdict.diversity.topologyConcentration <= 1);
      assert.ok(verdict.diversity.modeConcentration >= 0);
      assert.ok(verdict.diversity.modeConcentration <= 1);
    });

    it("empty catalog fails with meaningful error", () => {
      const tierPacks = new Map<Difficulty, { target: number; packs: ReviewCandidatePack[] }>();
      tierPacks.set("beginner", { target: 10, packs: [] });
      const catalog = buildReviewCatalog(tierPacks);

      const verdict = checkReleaseGate(catalog);
      assert.ok(!verdict.passed);
      assert.ok(verdict.errors.some((e) => e.includes("Total puzzles")));
      assert.equal(verdict.totalPuzzles, 0);
    });
  });

  describe("DEFAULT_RELEASE_GATE_CONFIG", () => {
    it("has reasonable defaults", () => {
      assert.ok(DEFAULT_RELEASE_GATE_CONFIG.minTotalPuzzles > 0);
      assert.ok(DEFAULT_RELEASE_GATE_CONFIG.maxTopologyConcentration > 0);
      assert.ok(DEFAULT_RELEASE_GATE_CONFIG.maxTopologyConcentration <= 1);
      assert.ok(DEFAULT_RELEASE_GATE_CONFIG.maxModeConcentration > 0);
      assert.ok(DEFAULT_RELEASE_GATE_CONFIG.maxModeConcentration <= 1);
      assert.equal(DEFAULT_RELEASE_GATE_CONFIG.maxDifficultyGap, 0);
      assert.ok(DEFAULT_RELEASE_GATE_CONFIG.minDistinctTopologies >= 1);
      assert.ok(DEFAULT_RELEASE_GATE_CONFIG.minDistinctModes >= 1);
    });

    it("has tier quotas for standard tiers", () => {
      const tiers: Difficulty[] = ["tutorial", "beginner", "intermediate", "advanced", "expert", "master"];
      for (const tier of tiers) {
        const quota = DEFAULT_RELEASE_GATE_CONFIG.tierQuotas[tier];
        assert.ok(quota, `missing tier quota for ${tier}`);
        assert.ok(quota!.target >= quota!.min, `target should be >= min for ${tier}`);
      }
    });
  });

  describe("formatReleaseVerdict", () => {
    it("produces readable text for a passing verdict", () => {
      const catalog = buildDiverseCatalog({
        beginner: 3,
        intermediate: 4,
        advanced: 3,
        expert: 2,
        master: 1,
      });
      const verdict = checkReleaseGate(catalog, {
        ...DEFAULT_RELEASE_GATE_CONFIG,
        minTotalPuzzles: 10,
        tierQuotas: {
          tutorial: { min: 0, target: 0 },
          beginner: { min: 2, target: 3 },
          intermediate: { min: 2, target: 4 },
          advanced: { min: 1, target: 2 },
          expert: { min: 0, target: 1 },
          master: { min: 0, target: 1 },
        },
      });
      const text = formatReleaseVerdict(verdict);

      assert.ok(text.includes("RELEASE GATE: PASSED"));
      assert.ok(text.includes("Tier Coverage"));
      assert.ok(text.includes("Diversity"));
      assert.ok(text.includes("Total puzzles"));
    });

    it("produces readable text for a failing verdict", () => {
      const catalog = buildDiverseCatalog({ beginner: 1 });
      const verdict = checkReleaseGate(catalog);
      const text = formatReleaseVerdict(verdict);

      assert.ok(text.includes("RELEASE GATE: FAILED"));
      assert.ok(text.includes("[ERROR]"));
    });

    it("shows warnings when present", () => {
      const catalog = buildDiverseCatalog({
        beginner: 3,
        intermediate: 3,
        advanced: 2,
        expert: 1,
        master: 1,
      });
      const config: ReleaseGateConfig = {
        ...DEFAULT_RELEASE_GATE_CONFIG,
        minTotalPuzzles: 5,
        tierQuotas: {
          tutorial: { min: 0, target: 0 },
          beginner: { min: 1, target: 100 },
          intermediate: { min: 1, target: 100 },
          advanced: { min: 1, target: 100 },
          expert: { min: 0, target: 100 },
          master: { min: 0, target: 100 },
        },
      };
      const verdict = checkReleaseGate(catalog, config);
      const text = formatReleaseVerdict(verdict);
      assert.ok(text.includes("[WARN]"));
    });
  });
});

// ---------------------------------------------------------------------------
// buildFinalReviewCatalog tests
// ---------------------------------------------------------------------------

describe("buildFinalReviewCatalog", () => {
  it("builds a catalog from ForgeCandidate arrays", () => {
    const candidates = new Map<Difficulty, readonly ForgeCandidate[]>();
    candidates.set("beginner", [
      makeCandidate({}, { seed: 1 }, { id: "gen-v2-1-a" }),
      makeCandidate({}, { seed: 2 }, { id: "gen-v2-2-b" }),
    ]);
    candidates.set("intermediate", [
      makeCandidate({}, { seed: 3 }, { id: "gen-v2-3-c" }),
    ]);

    const tiers: FinalReviewTierTarget[] = [
      { difficulty: "beginner", target: 10 },
      { difficulty: "intermediate", target: 15 },
    ];

    const catalog = buildFinalReviewCatalog(tiers, candidates, {
      generatorVersion: "4.1.0",
      qualityPreset: "standard",
    });

    assert.equal(catalog.schemaVersion, 2);
    assert.equal(catalog.generatorVersion, "4.1.0");
    assert.equal(catalog.qualityPreset, "standard");
    assert.equal(catalog.tierSummaries.beginner.actual, 2);
    assert.equal(catalog.tierSummaries.beginner.target, 10);
    assert.equal(catalog.tierSummaries.intermediate.actual, 1);
    assert.equal(catalog.tierSummaries.intermediate.target, 15);
  });

  it("computes V4 profile and difficulty gap for each candidate", () => {
    const candidates = new Map<Difficulty, readonly ForgeCandidate[]>();
    candidates.set("beginner", [
      makeCandidate({}, { seed: 10 }, { id: "gen-v2-10-x" }),
    ]);

    const tiers: FinalReviewTierTarget[] = [
      { difficulty: "beginner", target: 5 },
    ];

    const catalog = buildFinalReviewCatalog(tiers, candidates);
    const pack = catalog.tierSummaries.beginner.candidates[0];

    assert.equal(pack.intendedDifficulty, "beginner");
    assert.equal(typeof pack.classifiedDifficulty, "string");
    assert.equal(typeof pack.difficultyGap, "number");
    assert.equal(typeof pack.v4Composite, "number");
    assert.equal(typeof pack.v4Classification, "string");
  });

  it("handles empty candidate map for a tier", () => {
    const candidates = new Map<Difficulty, readonly ForgeCandidate[]>();
    // beginner not in map at all

    const tiers: FinalReviewTierTarget[] = [
      { difficulty: "beginner", target: 10 },
    ];

    const catalog = buildFinalReviewCatalog(tiers, candidates);
    assert.equal(catalog.tierSummaries.beginner.actual, 0);
    assert.equal(catalog.tierSummaries.beginner.target, 10);
  });

  it("recomputes metric classification instead of trusting stale provenance", () => {
    const candidates = new Map<Difficulty, readonly ForgeCandidate[]>();
    candidates.set("advanced", [
      makeCandidate(
        { boxCount: 14 },
        { seed: 20, boxCount: 14, v4Classification: "master" },
        { id: "gen-v2-20-y" },
      ),
    ]);

    const tiers: FinalReviewTierTarget[] = [
      { difficulty: "advanced", target: 5 },
    ];

    const catalog = buildFinalReviewCatalog(tiers, candidates);
    const pack = catalog.tierSummaries.advanced.candidates[0];

    const expected = computeV4Profile(makeEvaluation({ boxCount: 14 })).classification;
    assert.equal(pack.classifiedDifficulty, expected);
    assert.notEqual(pack.classifiedDifficulty, "master");
    assert.equal(pack.difficultyGap, DIFFICULTIES.indexOf(expected) - DIFFICULTIES.indexOf("advanced"));
  });

  it("produced catalog can be validated by release gate", () => {
    const candidates = new Map<Difficulty, readonly ForgeCandidate[]>();
    const makeUniqueCandidate = (seed: number, diff: Difficulty, fam: "hub" | "linear" | "loop", mode: "plain" | "motif" | "composed") => {
      const rows = makeUniqueRows();
      const boxCount = diff === "beginner" ? 4 + (seed % 3)
        : diff === "intermediate" ? 7 + (seed % 3)
        : diff === "advanced" ? 10 + (seed % 4)
        : diff === "expert" ? 14 + (seed % 4)
        : 18 + (seed % 5);
      const genericBoxCount = 2;
      return makeCandidate(
        { boxCount },
        {
          seed,
          family: fam,
          mode,
          boxCount,
          difficulty: diff,
          v4Classification: diff,
          typingMode: "hybrid",
          genericBoxCount,
          typedBoxCount: boxCount - genericBoxCount,
        },
        { id: `gen-v2-${seed}-h${seed}`, rows, difficulty: diff },
      );
    };

    candidates.set("beginner", [
      makeUniqueCandidate(100, "beginner", "hub", "plain"),
      makeUniqueCandidate(101, "beginner", "linear", "motif"),
      makeUniqueCandidate(102, "beginner", "loop", "composed"),
    ]);
    candidates.set("intermediate", [
      makeUniqueCandidate(200, "intermediate", "hub", "motif"),
      makeUniqueCandidate(201, "intermediate", "linear", "plain"),
      makeUniqueCandidate(202, "intermediate", "loop", "composed"),
      makeUniqueCandidate(203, "intermediate", "hub", "plain"),
    ]);
    candidates.set("advanced", [
      makeUniqueCandidate(300, "advanced", "hub", "composed"),
      makeUniqueCandidate(301, "advanced", "linear", "motif"),
      makeUniqueCandidate(302, "advanced", "loop", "plain"),
    ]);

    const tiers: FinalReviewTierTarget[] = [
      { difficulty: "beginner", target: 10 },
      { difficulty: "intermediate", target: 15 },
      { difficulty: "advanced", target: 10 },
    ];

    const catalog = buildFinalReviewCatalog(tiers, candidates, {
      generatorVersion: "4.1.0",
    });

    const classifiedCounts = new Map<Difficulty, number>();
    for (const summary of Object.values(catalog.tierSummaries)) {
      for (const pack of summary.candidates) {
        classifiedCounts.set(pack.classifiedDifficulty, (classifiedCounts.get(pack.classifiedDifficulty) ?? 0) + 1);
      }
    }
    const gateConfig: ReleaseGateConfig = {
      minTotalPuzzles: 5,
      tierQuotas: Object.fromEntries(DIFFICULTIES.map((tier) => {
        const count = classifiedCounts.get(tier) ?? 0;
        return [tier, { min: count > 0 ? 1 : 0, target: count }];
      })),
      maxTopologyConcentration: 0.60,
      maxModeConcentration: 0.70,
      maxDifficultyGap: 5,
      minDistinctTopologies: 2,
      minDistinctModes: 2,
      minDistinctBoxCounts: 1,
    };

    const verdict = checkReleaseGate(catalog, gateConfig);
    assert.ok(
      verdict.passed,
      `integrated pipeline should pass, errors: ${verdict.errors.join("; ")}`,
    );
    assert.equal(verdict.totalPuzzles, 10);
  });
});
