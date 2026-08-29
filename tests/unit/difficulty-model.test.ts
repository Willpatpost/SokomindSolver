import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  computeV4Profile,
  computeStructuralScale,
  computeSolutionDepthScore,
  computeHumanReasoningComplexity,
  computeTediumPenalty,
  benchmarkAgainstExpected,
  summarizeBenchmark,
  V4_TIER_THRESHOLDS,
} from "../../src/features/generator/v2/difficulty-model.ts";
import type { PuzzleEvaluationVector } from "../../src/features/generator/v2/puzzle-evaluator.ts";

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
    boxCount: 2,
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
    emptyWalkRatio: 0.4,
    longestWalkStreak: 5,
    forcedPushRatio: 0.1,
    repetitivePushRatio: 0.2,
    unusedFloorRatio: 0.3,
    movesPerPush: 2.0,
    solutionFloorCoverage: 0.7,
    solutionUnusedFloorRatio: 0.3,
    nonMonotonicBoxMoves: 0,
    nonMonotonicBoxCount: 0,
    stagingOperations: 0,
    temporaryGoalVacancies: 0,
    boxSwitchRate: 0.3,
    distinctBoxesMoved: 2,
    multiMoveBoxCount: 0,
    maxBoxEpisodes: 1,
    estimatedDependencyDepth: 1,
    goalOrderConstraints: 0,
    criticalMoveCount: 0,
    criticalMoveRatio: 0,
    boardWidth: 8,
    boardHeight: 6,
    totalFloor: 30,
    solved: true,
    ...overrides,
  };
}

describe("difficulty-model", () => {
  describe("V4_TIER_THRESHOLDS", () => {
    it("has entries for all 6 tiers", () => {
      const tiers = ["tutorial", "beginner", "intermediate", "advanced", "expert", "master"] as const;
      for (const t of tiers) {
        assert.ok(V4_TIER_THRESHOLDS[t], `missing threshold for ${t}`);
      }
    });

    it("thresholds increase monotonically across tiers", () => {
      const order = ["tutorial", "beginner", "intermediate", "advanced", "expert", "master"] as const;
      for (let i = 1; i < order.length; i++) {
        const prev = V4_TIER_THRESHOLDS[order[i - 1]];
        const curr = V4_TIER_THRESHOLDS[order[i]];
        assert.ok(
          curr.minComposite >= prev.minComposite,
          `${order[i]} composite should be >= ${order[i - 1]}`,
        );
      }
    });
  });

  describe("computeStructuralScale", () => {
    it("increases with box count", () => {
      const low = computeStructuralScale(makeVector({ boxCount: 2 }));
      const high = computeStructuralScale(makeVector({ boxCount: 10 }));
      assert.ok(high > low, "more boxes should increase structural scale");
    });

    it("increases with regions and chokepoints", () => {
      const simple = computeStructuralScale(makeVector({ regionCount: 1, chokepoints: 0 }));
      const complex = computeStructuralScale(makeVector({ regionCount: 5, chokepoints: 4 }));
      assert.ok(complex > simple, "more regions/chokepoints should increase structural scale");
    });
  });

  describe("computeSolutionDepthScore", () => {
    it("increases with pushes", () => {
      const shallow = computeSolutionDepthScore(makeVector({ solutionPushes: 5 }));
      const deep = computeSolutionDepthScore(makeVector({ solutionPushes: 80 }));
      assert.ok(deep > shallow, "more pushes should increase depth");
    });

    it("rewards non-monotonic movement", () => {
      const monotonic = computeSolutionDepthScore(makeVector({ nonMonotonicBoxMoves: 0 }));
      const nonMono = computeSolutionDepthScore(makeVector({ nonMonotonicBoxMoves: 3 }));
      assert.ok(nonMono > monotonic, "non-monotonic moves should increase depth");
    });

    it("rewards staging operations", () => {
      const noStaging = computeSolutionDepthScore(makeVector({ stagingOperations: 0 }));
      const withStaging = computeSolutionDepthScore(makeVector({ stagingOperations: 2 }));
      assert.ok(withStaging > noStaging, "staging should increase depth");
    });

    it("rewards temporary goal vacancies", () => {
      const noVac = computeSolutionDepthScore(makeVector({ temporaryGoalVacancies: 0 }));
      const withVac = computeSolutionDepthScore(makeVector({ temporaryGoalVacancies: 2 }));
      assert.ok(withVac > noVac, "vacancies should increase depth");
    });
  });

  describe("computeHumanReasoningComplexity", () => {
    it("rewards branching", () => {
      const low = computeHumanReasoningComplexity(makeVector({ avgReachablePushes: 1 }));
      const high = computeHumanReasoningComplexity(makeVector({ avgReachablePushes: 8 }));
      assert.ok(high > low, "more branching should increase reasoning complexity");
    });

    it("rewards causal interactions", () => {
      const low = computeHumanReasoningComplexity(makeVector({
        causalEnableCount: 0, causalDisableCount: 0,
      }));
      const high = computeHumanReasoningComplexity(makeVector({
        causalEnableCount: 5, causalDisableCount: 3,
      }));
      assert.ok(high > low, "causal interactions should increase reasoning");
    });

    it("penalizes forced-push-heavy solutions", () => {
      const forced = computeHumanReasoningComplexity(makeVector({ reachableForcedPushRatio: 0.9 }));
      const free = computeHumanReasoningComplexity(makeVector({ reachableForcedPushRatio: 0.1 }));
      assert.ok(free > forced, "low forced ratio should yield higher reasoning score");
    });
  });

  describe("computeTediumPenalty", () => {
    it("penalizes high empty walk ratio", () => {
      const low = computeTediumPenalty(makeVector({ emptyWalkRatio: 0.1 }));
      const high = computeTediumPenalty(makeVector({ emptyWalkRatio: 0.8 }));
      assert.ok(high > low, "more walking should increase tedium");
    });

    it("penalizes repetitive pushes", () => {
      const low = computeTediumPenalty(makeVector({ repetitivePushRatio: 0.1 }));
      const high = computeTediumPenalty(makeVector({ repetitivePushRatio: 0.9 }));
      assert.ok(high > low, "repetitive pushes should increase tedium");
    });

    it("stays bounded", () => {
      const worst = computeTediumPenalty(makeVector({
        emptyWalkRatio: 1.0,
        repetitivePushRatio: 1.0,
        longestWalkStreak: 100,
        movesPerPush: 50,
        solutionUnusedFloorRatio: 1.0,
      }));
      assert.ok(worst <= 1.0, "tedium should not exceed 1.0");
    });
  });

  describe("computeV4Profile", () => {
    it("returns a valid profile with classification", () => {
      const profile = computeV4Profile(makeVector());
      assert.ok(typeof profile.composite === "number");
      assert.ok(typeof profile.classification === "string");
      assert.ok(typeof profile.confidenceNote === "string");
      assert.ok(profile.structuralScale >= 0);
      assert.ok(profile.solutionDepth >= 0);
      assert.ok(profile.humanReasoningComplexity >= 0);
      assert.ok(profile.tediumPenalty >= 0);
    });

    it("classifies a trivial puzzle as tutorial or beginner", () => {
      const profile = computeV4Profile(makeVector({
        boxCount: 1,
        solutionPushes: 2,
        solutionMoves: 4,
        solutionWalks: 2,
        pushRatio: 0.5,
        pushesPerBox: 2,
        movesPerPush: 2,
        totalFloor: 8,
        regionCount: 1,
        chokepoints: 0,
        articulationPoints: 0,
        tunnelCells: 0,
        avgReachablePushes: 1,
        maxReachablePushes: 1,
        reachableSingleChoiceRatio: 1.0,
        reachableHighBranchCount: 0,
        reachableForcedPushRatio: 0.8,
        avgLegalPushes: 1,
        maxLegalPushes: 1,
        singleChoiceRatio: 1.0,
        highBranchCount: 0,
        forcedPushRatio: 0.8,
        sharedRouteCells: 0,
        sharedSupportCells: 0,
        sharedChokepointUses: 0,
        causalEnableCount: 0,
        causalDisableCount: 0,
        roomCrossingsInSolution: 0,
        deadlockDensity: 0,
        boxIndependenceRatio: 1,
        boxInteractionEvents: 0,
        nonMonotonicBoxMoves: 0,
        nonMonotonicBoxCount: 0,
        stagingOperations: 0,
        temporaryGoalVacancies: 0,
        boxSwitchRate: 0,
        distinctBoxesMoved: 1,
        multiMoveBoxCount: 0,
        maxBoxEpisodes: 1,
        estimatedDependencyDepth: 0,
        goalOrderConstraints: 0,
        solverExpandedStates: 5,
        solverGeneratedStates: 10,
        solverElapsedMs: 1,
        emptyWalkRatio: 0.5,
        longestWalkStreak: 2,
        repetitivePushRatio: 0,
        solutionFloorCoverage: 0.5,
        solutionUnusedFloorRatio: 0.5,
        unusedFloorRatio: 0.5,
        boardWidth: 4,
        boardHeight: 4,
      }));
      assert.ok(
        profile.classification === "tutorial" || profile.classification === "beginner",
        `trivial puzzle classified as ${profile.classification}, expected tutorial or beginner`,
      );
    });

    it("classifies a complex puzzle higher than a simple one", () => {
      const simple = computeV4Profile(makeVector({
        boxCount: 2,
        solutionPushes: 8,
        avgReachablePushes: 2,
        causalEnableCount: 0,
      }));
      const complex = computeV4Profile(makeVector({
        boxCount: 8,
        solutionPushes: 60,
        avgReachablePushes: 6,
        causalEnableCount: 5,
        causalDisableCount: 3,
        nonMonotonicBoxMoves: 4,
        stagingOperations: 2,
        temporaryGoalVacancies: 1,
        regionCount: 4,
        chokepoints: 3,
        articulationPoints: 2,
        roomCrossingsInSolution: 5,
        estimatedDependencyDepth: 4,
        goalOrderConstraints: 6,
        totalFloor: 80,
      }));
      assert.ok(
        complex.composite > simple.composite,
        "complex puzzle should have higher composite",
      );
    });

    it("tedium reduces composite score", () => {
      const clean = computeV4Profile(makeVector({
        emptyWalkRatio: 0.1,
        repetitivePushRatio: 0.1,
        movesPerPush: 2,
        longestWalkStreak: 2,
        solutionUnusedFloorRatio: 0.1,
      }));
      const tedious = computeV4Profile(makeVector({
        emptyWalkRatio: 0.8,
        repetitivePushRatio: 0.8,
        movesPerPush: 12,
        longestWalkStreak: 25,
        solutionUnusedFloorRatio: 0.7,
      }));
      assert.ok(
        clean.composite > tedious.composite,
        "tedious puzzle should have lower composite",
      );
    });
  });

  describe("benchmarkAgainstExpected", () => {
    it("returns benchmark entries with tier match info", () => {
      const entries = [
        { puzzleId: "p1", expectedTier: "tutorial" as const, vector: makeVector({ boxCount: 1, solutionPushes: 2, totalFloor: 8, regionCount: 1, chokepoints: 0, articulationPoints: 0, tunnelCells: 0, avgReachablePushes: 1, reachableForcedPushRatio: 0.8, causalEnableCount: 0, causalDisableCount: 0, nonMonotonicBoxMoves: 0, stagingOperations: 0, temporaryGoalVacancies: 0, estimatedDependencyDepth: 0, goalOrderConstraints: 0 }) },
      ];
      const results = benchmarkAgainstExpected(entries);
      assert.equal(results.length, 1);
      assert.equal(results[0].puzzleId, "p1");
      assert.ok(typeof results[0].tierMatch === "boolean");
      assert.ok(typeof results[0].tierDelta === "number");
    });
  });

  describe("summarizeBenchmark", () => {
    it("handles empty input", () => {
      const summary = summarizeBenchmark([]);
      assert.equal(summary.total, 0);
      assert.equal(summary.accuracy, 0);
    });

    it("computes accuracy for matching entries", () => {
      const entries = [
        { puzzleId: "p1", expectedTier: "beginner" as const, profile: computeV4Profile(makeVector()), tierMatch: true, tierDelta: 0 },
        { puzzleId: "p2", expectedTier: "intermediate" as const, profile: computeV4Profile(makeVector()), tierMatch: false, tierDelta: 1 },
      ];
      const summary = summarizeBenchmark(entries);
      assert.equal(summary.total, 2);
      assert.equal(summary.matches, 1);
      assert.equal(summary.accuracy, 0.5);
    });
  });
});
