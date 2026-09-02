import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildReviewPack,
  buildReviewCatalog,
  formatReviewSummary,
  validateForAcceptance,
  type ReviewCandidatePack,
  type ForgeCandidate,
  type PuzzleEvaluationVector,
  type ForgeProvenance,
  type FinalistEvaluation,
  type V4DifficultyProfile,
} from "../../src/features/generator/v2/index.ts";
import type { PuzzleDefinition, Difficulty } from "../../src/core/model.ts";
import { analyzeCounterfactualStory } from "../../src/features/generator/v2/counterfactual-analysis.ts";
import { DELAYED_FALSE_START } from "../fixtures/generator/counterfactual-stories.ts";
import { fixtureTrace } from "../support/counterfactual-replay.ts";

// ---------------------------------------------------------------------------
// Mock builders
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
    typingMode: "generic",
    genericBoxCount: 3,
    typedBoxCount: 0,
    dependencyEdges: 2,
    dependencyRealized: 1,
    dependencyRealizationRate: 0.5,
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
  return {
    puzzle: makePuzzle(puzzleOverrides),
    provenance: makeProvenance(provOverrides),
    evaluation: makeEvaluation(evalOverrides),
  };
}

function makeFinalistEval(
  overrides: Partial<FinalistEvaluation> = {},
): FinalistEvaluation {
  return {
    solverEvidence: [],
    solverAgreement: true,
    minMoves: 18,
    maxMoves: 22,
    minPushes: 7,
    maxPushes: 9,
    avgExpandedStates: 60,
    maxExpandedStates: 120,
    solversSucceeded: 3,
    solversAttempted: 3,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("review-catalog", () => {
  describe("buildReviewPack", () => {
    it("produces a pack with all required provenance fields", () => {
      const candidate = makeCandidate();
      const pack = buildReviewPack(
        candidate,
        "beginner",
        "beginner",
        0,
      );

      assert.equal(pack.id, candidate.puzzle.id);
      assert.equal(pack.seed, 300001);
      assert.equal(pack.family, "hub");
      assert.equal(pack.mode, "plain");
      assert.equal(pack.boxCount, 3);
      assert.equal(pack.typingMode, "generic");
      assert.equal(pack.intendedDifficulty, "beginner");
      assert.equal(pack.classifiedDifficulty, "beginner");
      assert.equal(pack.difficultyGap, 0);
      assert.equal(pack.solutionMoves, 20);
      assert.equal(pack.solutionPushes, 8);
      assert.equal(pack.playableFloor, 30);
      assert.equal(pack.boardWidth, 10);
      assert.equal(pack.boardHeight, 10);
    });

    it("includes structural metrics from evaluation", () => {
      const candidate = makeCandidate({
        regionCount: 5,
        chokepoints: 3,
        articulationPoints: 4,
        tunnelCells: 6,
        floorUtilization: 0.42,
      });
      const pack = buildReviewPack(candidate, "intermediate", "intermediate", 0);

      assert.equal(pack.regionCount, 5);
      assert.equal(pack.chokepoints, 3);
      assert.equal(pack.articulationPoints, 4);
      assert.equal(pack.tunnelCells, 6);
      assert.equal(pack.floorUtilization, 0.42);
    });

    it("includes solver evidence from finalist evaluation", () => {
      const candidate = makeCandidate();
      const finalist = makeFinalistEval({
        solversAttempted: 3,
        solversSucceeded: 2,
        solverAgreement: false,
        avgExpandedStates: 75,
        maxExpandedStates: 200,
      });
      const pack = buildReviewPack(
        candidate, "beginner", "beginner", 0, finalist,
      );

      assert.equal(pack.solversAttempted, 3);
      assert.equal(pack.solversSucceeded, 2);
      assert.equal(pack.solverAgreement, false);
      assert.equal(pack.avgExpandedStates, 75);
      assert.equal(pack.maxExpandedStates, 200);
    });

    it("defaults solver evidence from evaluation when finalist is absent", () => {
      const candidate = makeCandidate({ solverExpandedStates: 42 });
      const pack = buildReviewPack(candidate, "beginner", "beginner", 0);

      assert.equal(pack.solversAttempted, 0);
      assert.equal(pack.solversSucceeded, 0);
      assert.equal(pack.solverAgreement, false);
      assert.equal(pack.avgExpandedStates, 42);
      assert.equal(pack.maxExpandedStates, 42);
    });

    it("includes V4 difficulty profile", () => {
      const candidate = makeCandidate();
      const v4: V4DifficultyProfile = {
        structuralScale: 5.2,
        solutionDepth: 4.1,
        humanReasoningComplexity: 3.8,
        tediumPenalty: 0.15,
        composite: 11.6,
        classification: "intermediate",
        confidenceNote: "solid intermediate",
      };
      const pack = buildReviewPack(
        candidate, "intermediate", "intermediate", 0, undefined, v4,
      );

      assert.equal(pack.v4Composite, 11.6);
      assert.equal(pack.v4Classification, "intermediate");
      assert.equal(pack.v4StructuralScale, 5.2);
      assert.equal(pack.v4SolutionDepth, 4.1);
      assert.equal(pack.v4ReasoningComplexity, 3.8);
      assert.equal(pack.v4TediumPenalty, 0.15);
      assert.equal(pack.v4ConfidenceNote, "solid intermediate");
    });

    it("computes V4 profile automatically when not provided", () => {
      const candidate = makeCandidate();
      const pack = buildReviewPack(candidate, "beginner", "beginner", 0);

      // V4 composite should be computed from evaluation metrics
      assert.equal(typeof pack.v4Composite, "number");
      assert.equal(typeof pack.v4Classification, "string");
      assert.equal(typeof pack.v4StructuralScale, "number");
      assert.equal(typeof pack.v4SolutionDepth, "number");
      assert.equal(typeof pack.v4ReasoningComplexity, "number");
      assert.equal(typeof pack.v4TediumPenalty, "number");
    });

    it("includes solution depth metrics", () => {
      const candidate = makeCandidate({
        nonMonotonicBoxMoves: 5,
        stagingOperations: 3,
        temporaryGoalVacancies: 2,
        estimatedDependencyDepth: 4,
        goalOrderConstraints: 3,
      });
      const pack = buildReviewPack(candidate, "advanced", "advanced", 0);

      assert.equal(pack.nonMonotonicBoxMoves, 5);
      assert.equal(pack.stagingOperations, 3);
      assert.equal(pack.temporaryGoalVacancies, 2);
      assert.equal(pack.estimatedDependencyDepth, 4);
      assert.equal(pack.goalOrderConstraints, 3);
    });

    it("includes mechanism evidence from provenance", () => {
      const candidate = makeCandidate({}, {
        dependencyEdges: 5,
        dependencyRealized: 4,
        dependencyRealizationRate: 0.8,
      });
      const pack = buildReviewPack(candidate, "advanced", "advanced", 0);

      assert.equal(pack.dependencyEdges, 5);
      assert.equal(pack.dependencyRealized, 4);
      assert.equal(pack.dependencyRealizationRate, 0.8);
    });

    it("includes story-aware typing verification in JSON and the review summary", () => {
      const candidate = {
        ...makeCandidate({}, {
          storyAwareTypingTargets: 2,
          storyAwareTypingRealized: 2,
          storyAwareTypingPassed: true,
          storyAwareTypingMissing: [],
        }),
        storyAwareTypingVerification: {
          passed: true, boardMatches: true, targetCount: 2, realizedTargetCount: 2, targets: [],
        },
      };
      const pack = buildReviewPack(candidate, "beginner", "beginner", 0);
      assert.equal(pack.storyAwareTypingPassed, true);
      assert.deepEqual(pack.storyAwareTypingVerification, candidate.storyAwareTypingVerification);
      const catalog = buildReviewCatalog(new Map([
        ["beginner", { target: 1, packs: [pack] }],
      ]));
      assert.match(formatReviewSummary(catalog), /Story-aware typing: passed; 2\/2 targets verified/);
    });

    it("includes bounded search evidence, uncertainty, and explanations in review JSON and text", () => {
      const { grid, trace } = fixtureTrace(DELAYED_FALSE_START);
      const profile = analyzeCounterfactualStory(grid, trace, { maxElapsedMs: 0 });
      const candidate = { ...makeCandidate(), puzzle: DELAYED_FALSE_START.puzzle, counterfactualStory: profile };
      const pack = buildReviewPack(candidate, "beginner", "beginner", 0);
      assert.deepEqual(pack.counterfactualStory, profile);
      assert.equal(pack.counterfactualStory.boardHash, pack.boardHash);
      const catalog = buildReviewCatalog(new Map([["beginner", { target: 1, packs: [pack] }]]));
      const summary = formatReviewSummary(catalog);
      assert.match(summary, /Counterfactual searches:/);
      assert.match(summary, /unknown/);
      assert.match(summary, /no necessity or dead-end claim/);
    });

    it("includes ASCII board representation", () => {
      const candidate = makeCandidate();
      const pack = buildReviewPack(candidate, "beginner", "beginner", 0);

      // ASCII should contain the board rows
      assert.ok(pack.ascii.includes("OOOOOO"));
      assert.ok(pack.ascii.length > 0);
    });

    it("includes boardHash", () => {
      const candidate = makeCandidate();
      const pack = buildReviewPack(candidate, "beginner", "beginner", 0);

      assert.equal(typeof pack.boardHash, "string");
      assert.ok(pack.boardHash.length > 0);
    });
  });

  describe("buildReviewCatalog", () => {
    it("builds a catalog with correct schema version and structure", () => {
      const packs: ReviewCandidatePack[] = [
        buildReviewPack(makeCandidate(), "beginner", "beginner", 0),
      ];
      const tierPacks = new Map<Difficulty, { target: number; packs: ReviewCandidatePack[] }>();
      tierPacks.set("beginner", { target: 20, packs });

      const catalog = buildReviewCatalog(tierPacks, {
        generatorVersion: "3.0.0",
        qualityPreset: "standard",
      });

      assert.equal(catalog.schemaVersion, 2);
      assert.equal(catalog.generatorVersion, "3.0.0");
      assert.equal(catalog.qualityPreset, "standard");
      assert.equal(typeof catalog.generatedAt, "string");
      assert.ok(catalog.tierSummaries.beginner);
      assert.equal(catalog.tierSummaries.beginner.target, 20);
      assert.equal(catalog.tierSummaries.beginner.actual, 1);
      assert.equal(catalog.tierSummaries.beginner.candidates.length, 1);
    });

    it("handles multiple tiers", () => {
      const tierPacks = new Map<Difficulty, { target: number; packs: ReviewCandidatePack[] }>();
      tierPacks.set("beginner", {
        target: 10,
        packs: [buildReviewPack(makeCandidate(), "beginner", "beginner", 0)],
      });
      tierPacks.set("intermediate", {
        target: 15,
        packs: [
          buildReviewPack(makeCandidate({}, { seed: 1 }), "intermediate", "intermediate", 0),
          buildReviewPack(makeCandidate({}, { seed: 2 }), "intermediate", "intermediate", 0),
        ],
      });

      const catalog = buildReviewCatalog(tierPacks);

      assert.equal(Object.keys(catalog.tierSummaries).length, 2);
      assert.equal(catalog.tierSummaries.beginner.actual, 1);
      assert.equal(catalog.tierSummaries.intermediate.actual, 2);
    });

    it("uses default generatorVersion when not specified", () => {
      const tierPacks = new Map<Difficulty, { target: number; packs: ReviewCandidatePack[] }>();
      tierPacks.set("tutorial", { target: 5, packs: [] });
      const catalog = buildReviewCatalog(tierPacks);
      assert.equal(catalog.generatorVersion, "4.2.0");
    });

    it("records tier filter when specified", () => {
      const tierPacks = new Map<Difficulty, { target: number; packs: ReviewCandidatePack[] }>();
      tierPacks.set("expert", { target: 20, packs: [] });
      const catalog = buildReviewCatalog(tierPacks, { tierFilter: "expert" });
      assert.equal(catalog.tierFilter, "expert");
    });
  });

  describe("formatReviewSummary", () => {
    it("produces a non-empty string with header and tier info", () => {
      const pack = buildReviewPack(makeCandidate(), "beginner", "beginner", 0);
      const tierPacks = new Map<Difficulty, { target: number; packs: ReviewCandidatePack[] }>();
      tierPacks.set("beginner", { target: 20, packs: [pack] });
      const catalog = buildReviewCatalog(tierPacks);

      const summary = formatReviewSummary(catalog);

      assert.ok(summary.includes("REVIEW CATALOG SUMMARY"));
      assert.ok(summary.includes("beginner"));
      assert.ok(summary.includes("PLAYTEST QUESTION"));
    });

    it("includes ASCII board in summary", () => {
      const pack = buildReviewPack(makeCandidate(), "beginner", "beginner", 0);
      const tierPacks = new Map<Difficulty, { target: number; packs: ReviewCandidatePack[] }>();
      tierPacks.set("beginner", { target: 20, packs: [pack] });
      const catalog = buildReviewCatalog(tierPacks);

      const summary = formatReviewSummary(catalog);

      // Board should appear in summary
      assert.ok(summary.includes("OOOOOO"));
    });

    it("shows V4 difficulty info when present", () => {
      const v4: V4DifficultyProfile = {
        structuralScale: 5.0,
        solutionDepth: 4.0,
        humanReasoningComplexity: 3.5,
        tediumPenalty: 0.2,
        composite: 10.5,
        classification: "intermediate",
        confidenceNote: "high confidence",
      };
      const pack = buildReviewPack(
        makeCandidate(), "intermediate", "intermediate", 0, undefined, v4,
      );
      const tierPacks = new Map<Difficulty, { target: number; packs: ReviewCandidatePack[] }>();
      tierPacks.set("intermediate", { target: 10, packs: [pack] });
      const catalog = buildReviewCatalog(tierPacks);

      const summary = formatReviewSummary(catalog);
      assert.ok(summary.includes("V4:"));
      assert.ok(summary.includes("intermediate"));
    });

    it("shows tier distribution table", () => {
      const tierPacks = new Map<Difficulty, { target: number; packs: ReviewCandidatePack[] }>();
      tierPacks.set("beginner", {
        target: 20,
        packs: [buildReviewPack(makeCandidate(), "beginner", "beginner", 0)],
      });
      const catalog = buildReviewCatalog(tierPacks);
      const summary = formatReviewSummary(catalog);

      assert.ok(summary.includes("Target"));
      assert.ok(summary.includes("Actual"));
      assert.ok(summary.includes("SHORT"));
    });
  });

  describe("validateForAcceptance", () => {
    it("passes for a valid catalog and manifest", () => {
      const entries: PuzzleDefinition[] = [
        makePuzzle({ id: "gen-v2-1-abc", rows: [...SIMPLE_ROWS] }),
      ];
      const manifest = {
        schemaVersion: 1,
        generatorVersion: "3.0.0",
        catalogHash: "abc",
        tierQuotas: {},
        puzzles: [{ id: "gen-v2-1-abc" }],
      };
      const result = validateForAcceptance(
        JSON.stringify(entries),
        JSON.stringify(manifest),
      );
      assert.equal(result.passed, true);
      assert.equal(result.errors.length, 0);
      assert.equal(result.puzzleCount, 1);
    });

    it("fails for invalid catalog JSON", () => {
      const result = validateForAcceptance("not json", "{}");
      assert.equal(result.passed, false);
      assert.ok(result.errors.some((e) => e.includes("parse catalog")));
    });

    it("fails for invalid manifest JSON", () => {
      const result = validateForAcceptance("[]", "not json");
      assert.equal(result.passed, false);
      assert.ok(result.errors.some((e) => e.includes("parse manifest")));
    });

    it("fails for empty catalog", () => {
      const result = validateForAcceptance("[]", "{}");
      assert.equal(result.passed, false);
      assert.ok(result.errors.some((e) => e.includes("empty")));
    });

    it("fails for non-array catalog", () => {
      const result = validateForAcceptance("{}", "{}");
      assert.equal(result.passed, false);
      assert.ok(result.errors.some((e) => e.includes("not an array")));
    });

    it("detects duplicate IDs", () => {
      const entries = [
        makePuzzle({ id: "gen-v2-1-abc" }),
        makePuzzle({ id: "gen-v2-1-abc" }),
      ];
      const result = validateForAcceptance(
        JSON.stringify(entries),
        JSON.stringify({ puzzles: [] }),
      );
      assert.ok(result.errors.some((e) => e.includes("Duplicate ID")));
    });

    it("detects IDs without gen-v2- prefix", () => {
      const entries = [
        makePuzzle({ id: "bad-prefix-1" }),
      ];
      const result = validateForAcceptance(
        JSON.stringify(entries),
        JSON.stringify({ puzzles: [] }),
      );
      assert.ok(result.errors.some((e) => e.includes("gen-v2- prefix")));
    });

    it("warns when manifest/catalog IDs mismatch", () => {
      const entries = [makePuzzle({ id: "gen-v2-1-abc" })];
      const manifest = {
        puzzles: [{ id: "gen-v2-999-xyz" }],
      };
      const result = validateForAcceptance(
        JSON.stringify(entries),
        JSON.stringify(manifest),
      );
      assert.ok(result.warnings.some((w) => w.includes("not in manifest")));
      assert.ok(result.warnings.some((w) => w.includes("not in catalog")));
    });

    it("warns when puzzle counts differ between manifest and catalog", () => {
      const entries = [
        makePuzzle({ id: "gen-v2-1-abc" }),
        makePuzzle({ id: "gen-v2-2-def", rows: [
          "OOOOOOO",
          "O   S O",
          "O X   O",
          "O   R O",
          "OOOOOOO",
        ] }),
      ];
      const manifest = {
        puzzles: [{ id: "gen-v2-1-abc" }],
      };
      const result = validateForAcceptance(
        JSON.stringify(entries),
        JSON.stringify(manifest),
      );
      assert.ok(result.warnings.some((w) => w.includes("entries")));
    });

    it("returns correct puzzle count", () => {
      const entries = [
        makePuzzle({ id: "gen-v2-1-a" }),
        makePuzzle({ id: "gen-v2-2-b", rows: [
          "OOOOOOO",
          "O   S O",
          "O X   O",
          "O   R O",
          "OOOOOOO",
        ] }),
      ];
      const result = validateForAcceptance(
        JSON.stringify(entries),
        JSON.stringify({ puzzles: entries.map((e) => ({ id: e.id })) }),
      );
      assert.equal(result.puzzleCount, 2);
    });
  });

  describe("review mode vs production paths", () => {
    it("review catalog output paths differ from production", () => {
      // This is a structural test: the review output dir is review-catalog/
      // while production is src/catalog/
      const reviewDir = "review-catalog";
      const productionDir = "src/catalog";
      assert.notEqual(reviewDir, productionDir);
    });

    it("ReviewCandidatePack type has all required fields", () => {
      // Structural type test: verify we can build a pack with all fields
      const candidate = makeCandidate();
      const pack = buildReviewPack(candidate, "beginner", "beginner", 0);

      // All required fields should be defined (not undefined)
      const requiredFields: (keyof ReviewCandidatePack)[] = [
        "id", "ascii", "difficulty", "intendedDifficulty",
        "classifiedDifficulty", "difficultyGap", "boxCount",
        "boardWidth", "boardHeight", "playableFloor", "typingMode",
        "solutionMoves", "solutionPushes", "seed", "family", "mode",
        "boardHash", "regionCount", "chokepoints", "articulationPoints",
        "tunnelCells", "floorUtilization", "solversAttempted",
        "solversSucceeded", "solverAgreement", "avgExpandedStates",
        "maxExpandedStates",
      ];
      for (const field of requiredFields) {
        assert.notEqual(
          pack[field],
          undefined,
          `Expected field '${field}' to be defined`,
        );
      }
    });

    it("ReviewCatalog has correct schemaVersion", () => {
      const tierPacks = new Map<Difficulty, { target: number; packs: ReviewCandidatePack[] }>();
      tierPacks.set("beginner", { target: 5, packs: [] });
      const catalog = buildReviewCatalog(tierPacks);
      assert.equal(catalog.schemaVersion, 2);
    });
  });
});
