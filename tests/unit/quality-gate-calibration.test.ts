import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

import {
  assessQuality,
  computePurposefulGeometry,
  computeInteractionQuality,
  computeCausalDepth,
  computeDecisionQuality,
  computeMechanismIntegrity,
  computeElegance,
  computeTedium,
  QUALITY_FLOORS,
} from "../../src/features/generator/v2/quality-gate.ts";

import {
  buildCalibrationReport,
  formatCalibrationReport,
  computeV4Profile,
} from "../../src/features/generator/v2/difficulty-model.ts";

import type { PuzzleEvaluationVector } from "../../src/features/generator/v2/puzzle-evaluator.ts";
import type { Difficulty } from "../../src/core/model.ts";

// ---------------------------------------------------------------------------
// Shared vector builder
// ---------------------------------------------------------------------------

function makeVector(overrides: Partial<PuzzleEvaluationVector> = {}): PuzzleEvaluationVector {
  return {
    solverExpandedStates: 100,
    solverGeneratedStates: 200,
    solverElapsedMs: 50,
    solverPeakFrontier: 50,
    solverDeadlockPrunes: 10,
    solverDuplicateStates: 5,
    solutionMoves: 20,
    solutionPushes: 10,
    solutionWalks: 10,
    pushRatio: 0.5,
    boxCount: 3,
    avgLegalPushes: 3,
    maxLegalPushes: 6,
    singleChoiceRatio: 0.2,
    highBranchCount: 2,
    avgReachablePushes: 4,
    maxReachablePushes: 8,
    reachableSingleChoiceRatio: 0.15,
    reachableHighBranchCount: 3,
    reachableForcedPushRatio: 0.1,
    boxIndependenceRatio: 0.3,
    boxInteractionEvents: 2,
    pushesPerBox: 5,
    pushSwitchRatio: 0.3,
    sharedRouteCells: 2,
    sharedSupportCells: 1,
    sharedChokepointUses: 0,
    causalEnableCount: 1,
    causalDisableCount: 1,
    roomCrossingsInSolution: 0,
    deadlockDensity: 0.1,
    articulationPoints: 1,
    regionCount: 2,
    tunnelCells: 0,
    chokepoints: 1,
    floorUtilization: 0.7,
    openAreaRatio: 0.5,
    emptyWalkRatio: 0.3,
    longestWalkStreak: 5,
    forcedPushRatio: 0.1,
    repetitivePushRatio: 0.2,
    unusedFloorRatio: 0.3,
    movesPerPush: 2.0,
    solutionFloorCoverage: 0.7,
    solutionUnusedFloorRatio: 0.3,
    nonMonotonicBoxMoves: 1,
    nonMonotonicBoxCount: 1,
    stagingOperations: 1,
    temporaryGoalVacancies: 0,
    boxSwitchRate: 0.3,
    distinctBoxesMoved: 3,
    multiMoveBoxCount: 1,
    maxBoxEpisodes: 2,
    estimatedDependencyDepth: 1,
    goalOrderConstraints: 1,
    boardWidth: 10,
    boardHeight: 8,
    totalFloor: 40,
    solved: true,
    ...overrides,
  };
}

// A deliberately bad vector: long corridor pushing, independent boxes, giant unused floor
function makeBadVector(): PuzzleEvaluationVector {
  return makeVector({
    boxCount: 5,
    solutionPushes: 40,
    solutionMoves: 100,
    solutionWalks: 60,
    pushRatio: 0.4,
    emptyWalkRatio: 0.7,
    longestWalkStreak: 25,
    repetitivePushRatio: 0.8,
    unusedFloorRatio: 0.8,
    solutionFloorCoverage: 0.2,
    solutionUnusedFloorRatio: 0.8,
    boxIndependenceRatio: 0.95,
    boxInteractionEvents: 0,
    boxSwitchRate: 0.0,
    sharedRouteCells: 0,
    sharedSupportCells: 0,
    sharedChokepointUses: 0,
    causalEnableCount: 0,
    causalDisableCount: 0,
    nonMonotonicBoxMoves: 0,
    nonMonotonicBoxCount: 0,
    stagingOperations: 0,
    temporaryGoalVacancies: 0,
    multiMoveBoxCount: 0,
    estimatedDependencyDepth: 0,
    goalOrderConstraints: 0,
    avgReachablePushes: 1.2,
    maxReachablePushes: 2,
    reachableSingleChoiceRatio: 0.8,
    reachableHighBranchCount: 0,
    reachableForcedPushRatio: 0.7,
    movesPerPush: 5.0,
    regionCount: 1,
    chokepoints: 0,
    articulationPoints: 0,
    totalFloor: 100,
    boardWidth: 20,
    boardHeight: 10,
  });
}

// A rich Expert-level vector
function makeRichVector(): PuzzleEvaluationVector {
  return makeVector({
    boxCount: 5,
    solutionPushes: 30,
    solutionMoves: 50,
    solutionWalks: 20,
    pushRatio: 0.6,
    emptyWalkRatio: 0.15,
    longestWalkStreak: 3,
    repetitivePushRatio: 0.1,
    unusedFloorRatio: 0.15,
    solutionFloorCoverage: 0.85,
    solutionUnusedFloorRatio: 0.15,
    boxIndependenceRatio: 0.1,
    boxInteractionEvents: 8,
    boxSwitchRate: 0.6,
    sharedRouteCells: 8,
    sharedSupportCells: 5,
    sharedChokepointUses: 3,
    causalEnableCount: 5,
    causalDisableCount: 3,
    nonMonotonicBoxMoves: 4,
    nonMonotonicBoxCount: 3,
    stagingOperations: 3,
    temporaryGoalVacancies: 2,
    multiMoveBoxCount: 4,
    estimatedDependencyDepth: 4,
    goalOrderConstraints: 3,
    avgReachablePushes: 6,
    maxReachablePushes: 12,
    reachableSingleChoiceRatio: 0.05,
    reachableHighBranchCount: 6,
    reachableForcedPushRatio: 0.05,
    movesPerPush: 1.7,
    regionCount: 4,
    chokepoints: 3,
    articulationPoints: 2,
    totalFloor: 50,
    boardWidth: 12,
    boardHeight: 10,
    solverExpandedStates: 5000,
  });
}

// ---------------------------------------------------------------------------
// Quality gate dimension tests
// ---------------------------------------------------------------------------

describe("quality-gate", () => {
  describe("quality dimension scoring", () => {
    it("all dimensions return values in [0, 1]", () => {
      const ev = makeVector();
      assert.ok(computePurposefulGeometry(ev) >= 0 && computePurposefulGeometry(ev) <= 1);
      assert.ok(computeInteractionQuality(ev) >= 0 && computeInteractionQuality(ev) <= 1);
      assert.ok(computeCausalDepth(ev) >= 0 && computeCausalDepth(ev) <= 1);
      assert.ok(computeDecisionQuality(ev) >= 0 && computeDecisionQuality(ev) <= 1);
      assert.ok(computeMechanismIntegrity(ev) >= 0 && computeMechanismIntegrity(ev) <= 1);
      assert.ok(computeElegance(ev) >= 0 && computeElegance(ev) <= 1);
      assert.ok(computeTedium(ev) >= 0 && computeTedium(ev) <= 1);
    });

    it("bad vector has low quality scores", () => {
      const ev = makeBadVector();
      assert.ok(computeInteractionQuality(ev) < 0.1, "bad puzzle should have low interaction");
      assert.ok(computeCausalDepth(ev) < 0.1, "bad puzzle should have low causal depth");
      assert.ok(computeMechanismIntegrity(ev) < 0.1, "bad puzzle should have low mechanism integrity");
      assert.ok(computeTedium(ev) > 0.4, "bad puzzle should have high tedium");
    });

    it("rich vector has high quality scores", () => {
      const ev = makeRichVector();
      assert.ok(computeInteractionQuality(ev) > 0.3, "rich puzzle should have high interaction");
      assert.ok(computeCausalDepth(ev) > 0.3, "rich puzzle should have high causal depth");
      assert.ok(computeDecisionQuality(ev) > 0.3, "rich puzzle should have high decision quality");
      assert.ok(computeMechanismIntegrity(ev) > 0.3, "rich puzzle should have high mechanism integrity");
      assert.ok(computeTedium(ev) < 0.3, "rich puzzle should have low tedium");
    });

    it("interactionQuality is 0 for single-box puzzles", () => {
      const ev = makeVector({ boxCount: 1 });
      assert.equal(computeInteractionQuality(ev), 0);
    });
  });

  describe("QUALITY_FLOORS", () => {
    it("has entries for all 6 tiers", () => {
      const tiers: Difficulty[] = ["tutorial", "beginner", "intermediate", "advanced", "expert", "master"];
      for (const t of tiers) {
        assert.ok(QUALITY_FLOORS[t], `missing floor for ${t}`);
      }
    });

    it("floors become stricter in higher tiers", () => {
      const order: Difficulty[] = ["tutorial", "beginner", "intermediate", "advanced", "expert", "master"];
      for (let i = 1; i < order.length; i++) {
        const prev = QUALITY_FLOORS[order[i - 1]];
        const curr = QUALITY_FLOORS[order[i]];
        assert.ok(
          curr.minInteractionQuality >= prev.minInteractionQuality,
          `${order[i]} interaction floor should be >= ${order[i - 1]}`,
        );
        assert.ok(
          curr.maxTedium <= prev.maxTedium,
          `${order[i]} tedium ceiling should be <= ${order[i - 1]}`,
        );
      }
    });
  });

  describe("assessQuality", () => {
    it("passes a decent puzzle for tutorial tier", () => {
      const ev = makeVector();
      const profile = assessQuality(ev, "tutorial");
      assert.ok(profile.passed, "decent puzzle should pass tutorial quality gate");
      assert.equal(profile.reasons.length, 0);
    });

    it("passes a decent puzzle for beginner tier", () => {
      const ev = makeVector();
      const profile = assessQuality(ev, "beginner");
      assert.ok(profile.passed, "decent puzzle should pass beginner quality gate");
    });

    it("returns all dimension scores", () => {
      const ev = makeVector();
      const profile = assessQuality(ev, "intermediate");
      assert.equal(typeof profile.purposefulGeometry, "number");
      assert.equal(typeof profile.interactionQuality, "number");
      assert.equal(typeof profile.causalDepth, "number");
      assert.equal(typeof profile.decisionQuality, "number");
      assert.equal(typeof profile.mechanismIntegrity, "number");
      assert.equal(typeof profile.elegance, "number");
      assert.equal(typeof profile.tedium, "number");
      assert.equal(typeof profile.passed, "boolean");
      assert.ok(Array.isArray(profile.reasons));
    });

    it("rich puzzle passes expert quality gate", () => {
      const ev = makeRichVector();
      const profile = assessQuality(ev, "expert");
      assert.ok(profile.passed, `rich puzzle should pass expert quality gate, reasons: ${profile.reasons.join("; ")}`);
    });

    it("rich puzzle passes master quality gate", () => {
      const ev = makeRichVector();
      const profile = assessQuality(ev, "master");
      assert.ok(profile.passed, `rich puzzle should pass master quality gate, reasons: ${profile.reasons.join("; ")}`);
    });
  });

  // Phase 11 negative test: synthetic bad puzzles should not qualify as Expert/Master
  describe("quality gate negative tests (Section 19.10)", () => {
    it("long corridor pushing does not qualify as expert", () => {
      const ev = makeBadVector();
      const profile = assessQuality(ev, "expert");
      assert.ok(!profile.passed, "long corridor pushing should not pass expert quality gate");
      assert.ok(profile.reasons.length > 0, "should have rejection reasons");
    });

    it("long corridor pushing does not qualify as master", () => {
      const ev = makeBadVector();
      const profile = assessQuality(ev, "master");
      assert.ok(!profile.passed, "long corridor pushing should not pass master quality gate");
    });

    it("independent box rows do not qualify as expert", () => {
      const ev = makeVector({
        boxIndependenceRatio: 0.95,
        boxInteractionEvents: 0,
        boxSwitchRate: 0.0,
        sharedRouteCells: 0,
        sharedSupportCells: 0,
        causalEnableCount: 0,
        causalDisableCount: 0,
        nonMonotonicBoxMoves: 0,
        stagingOperations: 0,
        temporaryGoalVacancies: 0,
        estimatedDependencyDepth: 0,
      });
      const profile = assessQuality(ev, "expert");
      assert.ok(!profile.passed, "independent box rows should not pass expert quality gate");
    });

    it("giant unused room does not qualify as expert", () => {
      const ev = makeVector({
        unusedFloorRatio: 0.9,
        solutionFloorCoverage: 0.1,
        solutionUnusedFloorRatio: 0.9,
        totalFloor: 200,
      });
      const profile = assessQuality(ev, "expert");
      assert.ok(!profile.passed, "giant unused room should not pass expert quality gate");
    });

    it("forced-only repetitive solution does not qualify as advanced", () => {
      const ev = makeVector({
        reachableForcedPushRatio: 0.9,
        reachableSingleChoiceRatio: 0.9,
        avgReachablePushes: 1.1,
        reachableHighBranchCount: 0,
        repetitivePushRatio: 0.9,
        emptyWalkRatio: 0.6,
      });
      const profile = assessQuality(ev, "advanced");
      assert.ok(!profile.passed, "forced-only repetitive solution should not pass advanced quality gate");
    });

    it("bad puzzle still passes tutorial (low floor)", () => {
      const ev = makeBadVector();
      const profile = assessQuality(ev, "tutorial");
      assert.ok(profile.passed, "even a bad puzzle should pass tutorial quality gate");
    });
  });
});

// ---------------------------------------------------------------------------
// Calibration report tests
// ---------------------------------------------------------------------------

describe("calibration-report", () => {
  describe("buildCalibrationReport", () => {
    it("produces empty report for no data", () => {
      const report = buildCalibrationReport([]);
      assert.equal(report.totalPuzzles, 0);
      assert.equal(report.exactMatchAccuracy, 0);
      assert.equal(report.withinOneTierAccuracy, 0);
      assert.equal(report.entries.length, 0);
      assert.equal(report.worstOverclassification, null);
      assert.equal(report.worstUnderclassification, null);
    });

    it("identifies perfect matches", () => {
      const ev = makeVector();
      const profile = computeV4Profile(ev);
      const report = buildCalibrationReport([
        { puzzleId: "test-1", expectedTier: profile.classification, vector: ev },
      ]);
      assert.equal(report.totalPuzzles, 1);
      assert.equal(report.exactMatchAccuracy, 1.0);
      assert.equal(report.withinOneTierAccuracy, 1.0);
      assert.ok(report.entries[0].tierMatch);
      assert.equal(report.entries[0].tierDelta, 0);
    });

    it("confusion matrix rows and columns sum correctly", () => {
      const data = [
        { puzzleId: "a", expectedTier: "tutorial" as Difficulty, vector: makeVector({ boxCount: 1, solutionPushes: 2, avgReachablePushes: 1 }) },
        { puzzleId: "b", expectedTier: "beginner" as Difficulty, vector: makeVector({ boxCount: 2, solutionPushes: 5 }) },
        { puzzleId: "c", expectedTier: "intermediate" as Difficulty, vector: makeVector() },
      ];
      const report = buildCalibrationReport(data);

      const tiers: Difficulty[] = ["tutorial", "beginner", "intermediate", "advanced", "expert", "master"];
      // Each expected row should sum to the count of puzzles with that expected tier
      for (const tier of tiers) {
        let rowSum = 0;
        for (const t2 of tiers) {
          rowSum += report.confusionMatrix[tier][t2];
        }
        const expected = data.filter((d) => d.expectedTier === tier).length;
        assert.equal(rowSum, expected, `row sum for ${tier} should equal puzzle count for that tier`);
      }

      // Total sum should equal total puzzles
      let totalSum = 0;
      for (const t1 of tiers) {
        for (const t2 of tiers) {
          totalSum += report.confusionMatrix[t1][t2];
        }
      }
      assert.equal(totalSum, data.length, "total confusion matrix sum should equal total puzzles");
    });

    it("detects overclassification and underclassification", () => {
      // Create a vector that classifies high (many boxes, complex) but label it tutorial
      const highVec = makeRichVector();
      // Create a simple vector but label it master
      const lowVec = makeVector({
        boxCount: 1,
        solutionPushes: 2,
        avgReachablePushes: 1,
        reachableForcedPushRatio: 0.9,
        regionCount: 1,
        chokepoints: 0,
        articulationPoints: 0,
        nonMonotonicBoxMoves: 0,
        stagingOperations: 0,
        causalEnableCount: 0,
        sharedRouteCells: 0,
        totalFloor: 10,
      });

      const report = buildCalibrationReport([
        { puzzleId: "over", expectedTier: "tutorial", vector: highVec },
        { puzzleId: "under", expectedTier: "master", vector: lowVec },
      ]);

      assert.ok(report.worstOverclassification !== null, "should detect overclassification");
      assert.ok(report.worstOverclassification!.tierDelta > 0, "overclassification should have positive delta");
      assert.ok(report.worstUnderclassification !== null, "should detect underclassification");
      assert.ok(report.worstUnderclassification!.tierDelta < 0, "underclassification should have negative delta");
    });

    it("within-one-tier accuracy is >= exact-match accuracy", () => {
      const data = [
        { puzzleId: "a", expectedTier: "tutorial" as Difficulty, vector: makeVector() },
        { puzzleId: "b", expectedTier: "intermediate" as Difficulty, vector: makeVector() },
        { puzzleId: "c", expectedTier: "advanced" as Difficulty, vector: makeRichVector() },
      ];
      const report = buildCalibrationReport(data);
      assert.ok(
        report.withinOneTierAccuracy >= report.exactMatchAccuracy,
        "within-one-tier accuracy should be >= exact-match accuracy",
      );
    });

    it("entries contain all required fields", () => {
      const report = buildCalibrationReport([
        { puzzleId: "test-puzzle", expectedTier: "intermediate", vector: makeVector() },
      ]);
      const entry = report.entries[0];
      assert.equal(entry.puzzleId, "test-puzzle");
      assert.equal(entry.expectedTier, "intermediate");
      assert.equal(typeof entry.predictedTier, "string");
      assert.equal(typeof entry.structuralScore, "number");
      assert.equal(typeof entry.solutionDepthScore, "number");
      assert.equal(typeof entry.reasoningScore, "number");
      assert.equal(typeof entry.tedium, "number");
      assert.equal(typeof entry.composite, "number");
      assert.equal(typeof entry.tierMatch, "boolean");
      assert.equal(typeof entry.tierDelta, "number");
      assert.equal(typeof entry.withinOne, "boolean");
    });

    it("per-tier accuracy sums correctly", () => {
      const data = [
        { puzzleId: "a", expectedTier: "beginner" as Difficulty, vector: makeVector() },
        { puzzleId: "b", expectedTier: "beginner" as Difficulty, vector: makeVector() },
        { puzzleId: "c", expectedTier: "advanced" as Difficulty, vector: makeRichVector() },
      ];
      const report = buildCalibrationReport(data);
      const beginnerStats = report.perTierAccuracy.beginner;
      assert.equal(beginnerStats.total, 2, "beginner should have 2 entries");
      assert.ok(beginnerStats.accuracy >= 0 && beginnerStats.accuracy <= 1);
    });
  });

  describe("formatCalibrationReport", () => {
    it("produces a non-empty string", () => {
      const report = buildCalibrationReport([
        { puzzleId: "test", expectedTier: "intermediate", vector: makeVector() },
      ]);
      const text = formatCalibrationReport(report);
      assert.ok(text.length > 0, "report text should not be empty");
      assert.ok(text.includes("V4 Handcrafted Calibration Report"), "should contain header");
      assert.ok(text.includes("Exact-match accuracy"), "should contain accuracy");
      assert.ok(text.includes("Confusion matrix"), "should contain confusion matrix");
      assert.ok(text.includes("test"), "should contain puzzle id");
    });

    it("produces valid output for empty report", () => {
      const report = buildCalibrationReport([]);
      const text = formatCalibrationReport(report);
      assert.ok(text.includes("Total puzzles: 0"));
    });
  });
});
