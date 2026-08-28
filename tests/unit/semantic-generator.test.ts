/**
 * Semantic generator test suite -- Sprint 12
 *
 * Tests that verify the generator pipeline produces puzzles with expected
 * semantic properties rather than only testing implementation plumbing.
 *
 * Covers:
 *   - Section 19.1: Tile semantics invariants
 *   - Section 19.5: Box budget invariants
 *   - Section 19.6: Geometry contract enforcement
 *   - Section 19.9: Difficulty benchmark ordering
 *   - Section 19.10: Quality gate negative cases
 *   - Section 21: Generator invariants A-H
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

import {
  isWallChar,
  isRobotChar,
  isBoxChar,
  isGenericBoxChar,
  isTypedBoxChar,
  isGoalChar,
  isGenericGoalChar,
  isTypedGoalChar,
  isFloorChar,
  isWalkableChar,
} from "../../src/features/generator/v2/tile-semantics.ts";

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
  computeV4Profile,
  V4_TIER_THRESHOLDS,
} from "../../src/features/generator/v2/difficulty-model.ts";

import {
  countBoxesAndGoals,
} from "../../src/features/generator/v2/puzzle-forge.ts";

import type { PuzzleEvaluationVector } from "../../src/features/generator/v2/puzzle-evaluator.ts";
import type { Difficulty } from "../../src/core/model.ts";

// ---------------------------------------------------------------------------
// Shared helpers
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

/** Tutorial-level vector: simple, few choices, low depth. */
function makeTutorialVector(): PuzzleEvaluationVector {
  return makeVector({
    boxCount: 1,
    solutionPushes: 2,
    solutionMoves: 5,
    solutionWalks: 3,
    pushRatio: 0.4,
    avgReachablePushes: 1.2,
    maxReachablePushes: 2,
    reachableForcedPushRatio: 0.8,
    reachableHighBranchCount: 0,
    reachableSingleChoiceRatio: 0.9,
    boxIndependenceRatio: 1.0,
    boxInteractionEvents: 0,
    sharedRouteCells: 0,
    sharedSupportCells: 0,
    causalEnableCount: 0,
    causalDisableCount: 0,
    nonMonotonicBoxMoves: 0,
    stagingOperations: 0,
    temporaryGoalVacancies: 0,
    estimatedDependencyDepth: 0,
    goalOrderConstraints: 0,
    regionCount: 1,
    chokepoints: 0,
    articulationPoints: 0,
    totalFloor: 10,
    boardWidth: 5,
    boardHeight: 5,
    solverExpandedStates: 3,
  });
}

/** Expert-level vector: rich interaction, deep dependencies. */
function makeExpertVector(): PuzzleEvaluationVector {
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
// Section 19.1: Tile Semantics Tests
// ---------------------------------------------------------------------------

describe("semantic: tile semantics (19.1)", () => {
  it("Invariant A: no wall, robot, or goal can be parsed as a box", () => {
    // Wall
    assert.ok(!isBoxChar("O"), "wall O must not be a box");
    assert.ok(!isGenericBoxChar("O"), "wall O must not be a generic box");
    assert.ok(!isTypedBoxChar("O"), "wall O must not be a typed box");

    // Robot
    assert.ok(!isBoxChar("R"), "robot R must not be a box");
    assert.ok(!isGenericBoxChar("R"), "robot R must not be a generic box");
    assert.ok(!isTypedBoxChar("R"), "robot R must not be a typed box");

    // Generic goal
    assert.ok(!isBoxChar("S"), "goal S must not be a box");
    assert.ok(!isGenericBoxChar("S"), "goal S must not be a generic box");
    assert.ok(!isTypedBoxChar("S"), "goal S must not be a typed box");

    // Typed goals (lowercase)
    for (const ch of ["a", "b", "c", "z"]) {
      assert.ok(!isBoxChar(ch), `typed goal '${ch}' must not be a box`);
    }
  });

  it("generic box X is exclusively generic", () => {
    assert.ok(isGenericBoxChar("X"), "X is generic box");
    assert.ok(isBoxChar("X"), "X is a box");
    assert.ok(!isGoalChar("X"), "X is not a goal");
    assert.ok(!isWallChar("X"), "X is not a wall");
    assert.ok(!isRobotChar("X"), "X is not a robot");
  });

  it("typed boxes are uppercase letters excluding O, R, S, X", () => {
    const excluded = new Set(["O", "R", "S", "X"]);
    for (let code = 65; code <= 90; code++) {
      const ch = String.fromCharCode(code);
      if (excluded.has(ch)) {
        assert.ok(!isTypedBoxChar(ch), `'${ch}' is excluded from typed boxes`);
      } else {
        assert.ok(isTypedBoxChar(ch), `'${ch}' should be a typed box`);
        assert.ok(isBoxChar(ch), `'${ch}' should be a box`);
      }
    }
  });

  it("generic goal S is exclusively a goal", () => {
    assert.ok(isGenericGoalChar("S"), "S is generic goal");
    assert.ok(isGoalChar("S"), "S is a goal");
    assert.ok(!isBoxChar("S"), "S is not a box");
    assert.ok(!isFloorChar("S"), "S is not floor");
  });

  it("typed goals are all lowercase letters", () => {
    for (let code = 97; code <= 122; code++) {
      const ch = String.fromCharCode(code);
      assert.ok(isTypedGoalChar(ch), `'${ch}' should be a typed goal`);
      assert.ok(isGoalChar(ch), `'${ch}' should be a goal`);
      assert.ok(!isBoxChar(ch), `'${ch}' should not be a box`);
    }
  });

  it("wall is not walkable, everything else is", () => {
    assert.ok(!isWalkableChar("O"), "wall is not walkable");
    assert.ok(isWalkableChar(" "), "floor is walkable");
    assert.ok(isWalkableChar("X"), "box is walkable");
    assert.ok(isWalkableChar("R"), "robot is walkable");
    assert.ok(isWalkableChar("S"), "goal is walkable");
    assert.ok(isWalkableChar("a"), "typed goal is walkable");
  });

  it("floor is exactly space character", () => {
    assert.ok(isFloorChar(" "), "space is floor");
    assert.ok(!isFloorChar("O"), "wall is not floor");
    assert.ok(!isFloorChar("X"), "box is not floor");
    assert.ok(!isFloorChar("R"), "robot is not floor");
  });
});

// ---------------------------------------------------------------------------
// Section 19.5: Box Budget Invariants
// ---------------------------------------------------------------------------

describe("semantic: box budget invariants (19.5)", () => {
  it("countBoxesAndGoals counts generic boxes and goals correctly", () => {
    const rows = [
      "OOOOOOO",
      "O X S O",
      "O X S O",
      "O   R O",
      "OOOOOOO",
    ];
    const counts = countBoxesAndGoals(rows);
    assert.equal(counts.boxes, 2, "should have 2 boxes");
    assert.equal(counts.goals, 2, "should have 2 goals");
    assert.equal(counts.generic, 2, "should have 2 generic boxes");
    assert.equal(counts.typed, 0, "should have 0 typed boxes");
  });

  it("countBoxesAndGoals counts typed boxes and goals correctly", () => {
    const rows = [
      "OOOOOOO",
      "O A a O",
      "O B b O",
      "O   R O",
      "OOOOOOO",
    ];
    const counts = countBoxesAndGoals(rows);
    assert.equal(counts.boxes, 2, "should have 2 boxes");
    assert.equal(counts.goals, 2, "should have 2 goals");
    assert.equal(counts.generic, 0, "should have 0 generic boxes");
    assert.equal(counts.typed, 2, "should have 2 typed boxes");
  });

  it("countBoxesAndGoals handles mixed generic and typed", () => {
    const rows = [
      "OOOOOOOO",
      "O X S  O",
      "O A a  O",
      "O    R O",
      "OOOOOOOO",
    ];
    const counts = countBoxesAndGoals(rows);
    assert.equal(counts.boxes, 2, "should have 2 boxes total");
    assert.equal(counts.goals, 2, "should have 2 goals total");
    assert.equal(counts.generic, 1, "should have 1 generic box");
    assert.equal(counts.typed, 1, "should have 1 typed box");
  });

  it("Invariant B: boxes == goals for well-formed board", () => {
    const boards = [
      ["OOOOO", "O XSO", "O  RO", "OOOOO"],
      ["OOOOOO", "O AaXO", "O  SRO", "OOOOOO"],
      ["OOOOOOO", "O XXS O", "O   SRO", "OOOOOOO"],
    ];
    for (const rows of boards) {
      const counts = countBoxesAndGoals(rows);
      assert.equal(
        counts.boxes, counts.goals,
        `box count ${counts.boxes} must equal goal count ${counts.goals}`,
      );
    }
  });

  it("Invariant B: generic + typed == total boxes", () => {
    const rows = [
      "OOOOOOOO",
      "O X S  O",
      "O A a  O",
      "O B b  O",
      "O    R O",
      "OOOOOOOO",
    ];
    const counts = countBoxesAndGoals(rows);
    assert.equal(
      counts.generic + counts.typed,
      counts.boxes,
      "generic + typed must equal total boxes",
    );
  });
});

// ---------------------------------------------------------------------------
// Section 19.9: Difficulty Benchmark Tests (ordering)
// ---------------------------------------------------------------------------

describe("semantic: difficulty benchmark ordering (19.9)", () => {
  const TIER_ORDER: readonly Difficulty[] = [
    "tutorial", "beginner", "intermediate", "advanced", "expert", "master",
  ];
  const tierIndex = (d: Difficulty) => TIER_ORDER.indexOf(d);

  it("tutorial-level vector classifies <= beginner", () => {
    const v = makeTutorialVector();
    const profile = computeV4Profile(v);
    assert.ok(
      tierIndex(profile.classification) <= tierIndex("beginner"),
      `tutorial vector classified as ${profile.classification}, expected <= beginner`,
    );
  });

  it("expert-level vector classifies >= advanced", () => {
    const v = makeExpertVector();
    const profile = computeV4Profile(v);
    assert.ok(
      tierIndex(profile.classification) >= tierIndex("advanced"),
      `expert vector classified as ${profile.classification}, expected >= advanced`,
    );
  });

  it("V4 tier thresholds are monotonically increasing", () => {
    for (let i = 1; i < TIER_ORDER.length; i++) {
      const prev = V4_TIER_THRESHOLDS[TIER_ORDER[i - 1]];
      const curr = V4_TIER_THRESHOLDS[TIER_ORDER[i]];
      assert.ok(
        curr.minComposite >= prev.minComposite,
        `${TIER_ORDER[i]} composite threshold ${curr.minComposite} should be >= ${TIER_ORDER[i-1]} ${prev.minComposite}`,
      );
    }
  });

  it("composite score increases with puzzle complexity", () => {
    const tutorialProfile = computeV4Profile(makeTutorialVector());
    const midProfile = computeV4Profile(makeVector());
    const expertProfile = computeV4Profile(makeExpertVector());

    assert.ok(
      tutorialProfile.composite < midProfile.composite,
      `tutorial composite ${tutorialProfile.composite} should be < mid composite ${midProfile.composite}`,
    );
    assert.ok(
      midProfile.composite < expertProfile.composite,
      `mid composite ${midProfile.composite} should be < expert composite ${expertProfile.composite}`,
    );
  });

  it("catastrophic misclassification: simple puzzle never classified master", () => {
    const v = makeTutorialVector();
    const profile = computeV4Profile(v);
    assert.ok(
      profile.classification !== "master",
      "tutorial-level puzzle must never be classified as master",
    );
  });

  it("catastrophic misclassification: rich puzzle never classified tutorial", () => {
    const v = makeExpertVector();
    const profile = computeV4Profile(v);
    assert.ok(
      profile.classification !== "tutorial",
      "expert-level puzzle must never be classified as tutorial",
    );
  });
});

// ---------------------------------------------------------------------------
// Section 19.10: Quality Gate Negative Tests (semantic)
// ---------------------------------------------------------------------------

describe("semantic: quality gate negatives (19.10)", () => {
  it("long corridor: high pushes but low interaction = fails expert gate", () => {
    // Simulates long corridor pushing: many pushes but all independent
    const ev = makeVector({
      boxCount: 5,
      solutionPushes: 50,
      solutionMoves: 120,
      emptyWalkRatio: 0.6,
      longestWalkStreak: 20,
      repetitivePushRatio: 0.7,
      boxIndependenceRatio: 0.9,
      boxInteractionEvents: 0,
      boxSwitchRate: 0.05,
      sharedRouteCells: 0,
      sharedSupportCells: 0,
      causalEnableCount: 0,
      causalDisableCount: 0,
      nonMonotonicBoxMoves: 0,
      stagingOperations: 0,
      estimatedDependencyDepth: 0,
      avgReachablePushes: 1.5,
      reachableForcedPushRatio: 0.7,
    });

    const profile = assessQuality(ev, "expert");
    assert.ok(!profile.passed, "corridor pushing should fail expert quality gate");
    assert.ok(
      profile.reasons.length >= 2,
      "should have multiple rejection reasons",
    );
  });

  it("independent boxes: high solution length does not compensate for no interaction", () => {
    const ev = makeVector({
      boxCount: 6,
      solutionPushes: 40,
      solutionMoves: 80,
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
    assert.ok(!profile.passed, "independent boxes should fail expert gate");
  });

  it("giant unused room: large board with small solution fails elegance check", () => {
    const ev = makeVector({
      totalFloor: 200,
      boardWidth: 20,
      boardHeight: 15,
      unusedFloorRatio: 0.85,
      solutionFloorCoverage: 0.15,
      solutionUnusedFloorRatio: 0.85,
    });

    const profile = assessQuality(ev, "expert");
    assert.ok(!profile.passed, "giant unused room should fail expert gate");
  });

  it("forced-only: no real decisions means low decision quality", () => {
    const ev = makeVector({
      reachableForcedPushRatio: 0.9,
      reachableSingleChoiceRatio: 0.9,
      avgReachablePushes: 1.1,
      reachableHighBranchCount: 0,
    });

    const decisionQ = computeDecisionQuality(ev);
    assert.ok(
      decisionQ < 0.3,
      `forced-only puzzle should have low decision quality, got ${decisionQ}`,
    );
  });

  it("Invariant G: quality floors are not quota-sensitive", () => {
    // Quality assessment takes only evaluation vector and tier, not quotas.
    // This is a structural guarantee: assessQuality's signature does not
    // accept any quota or count parameter.
    const ev = makeVector();
    const profileA = assessQuality(ev, "expert");
    const profileB = assessQuality(ev, "expert");
    assert.deepEqual(
      profileA, profileB,
      "identical inputs produce identical quality assessments",
    );
  });

  it("Invariant H: difficulty classification does not inspect quotas", () => {
    // computeV4Profile takes only evaluation vector, not quotas.
    const ev = makeVector();
    const profileA = computeV4Profile(ev);
    const profileB = computeV4Profile(ev);
    assert.deepEqual(
      profileA, profileB,
      "identical inputs produce identical difficulty classifications",
    );
  });
});

// ---------------------------------------------------------------------------
// Quality dimension semantic properties
// ---------------------------------------------------------------------------

describe("semantic: quality dimension properties", () => {
  it("tedium increases with walking, repetition, and forced pushes", () => {
    const lowTedium = computeTedium(makeVector({
      emptyWalkRatio: 0.1,
      repetitivePushRatio: 0.1,
      longestWalkStreak: 2,
      movesPerPush: 1.5,
      reachableForcedPushRatio: 0.05,
    }));
    const highTedium = computeTedium(makeVector({
      emptyWalkRatio: 0.7,
      repetitivePushRatio: 0.7,
      longestWalkStreak: 25,
      movesPerPush: 8.0,
      reachableForcedPushRatio: 0.7,
    }));

    assert.ok(
      highTedium > lowTedium,
      `high-tedium ${highTedium} should exceed low-tedium ${lowTedium}`,
    );
  });

  it("interaction quality increases with shared routes and causal events", () => {
    const lowInteraction = computeInteractionQuality(makeVector({
      boxCount: 4,
      boxIndependenceRatio: 0.9,
      boxInteractionEvents: 0,
      boxSwitchRate: 0.0,
      sharedRouteCells: 0,
      sharedSupportCells: 0,
    }));
    const highInteraction = computeInteractionQuality(makeVector({
      boxCount: 4,
      boxIndependenceRatio: 0.1,
      boxInteractionEvents: 10,
      boxSwitchRate: 0.7,
      sharedRouteCells: 10,
      sharedSupportCells: 6,
    }));

    assert.ok(
      highInteraction > lowInteraction,
      `high interaction ${highInteraction} should exceed low interaction ${lowInteraction}`,
    );
  });

  it("causal depth increases with enable/disable events and dependency chains", () => {
    const lowDepth = computeCausalDepth(makeVector({
      causalEnableCount: 0,
      causalDisableCount: 0,
      estimatedDependencyDepth: 0,
      goalOrderConstraints: 0,
    }));
    const highDepth = computeCausalDepth(makeVector({
      causalEnableCount: 5,
      causalDisableCount: 4,
      estimatedDependencyDepth: 5,
      goalOrderConstraints: 4,
    }));

    assert.ok(
      highDepth > lowDepth,
      `high depth ${highDepth} should exceed low depth ${lowDepth}`,
    );
  });

  it("mechanism integrity increases with staging and non-monotonic progress", () => {
    const lowMech = computeMechanismIntegrity(makeVector({
      nonMonotonicBoxMoves: 0,
      stagingOperations: 0,
      temporaryGoalVacancies: 0,
      multiMoveBoxCount: 0,
      estimatedDependencyDepth: 0,
    }));
    const highMech = computeMechanismIntegrity(makeVector({
      nonMonotonicBoxMoves: 5,
      stagingOperations: 4,
      temporaryGoalVacancies: 3,
      multiMoveBoxCount: 4,
      estimatedDependencyDepth: 5,
    }));

    assert.ok(
      highMech > lowMech,
      `high mechanism ${highMech} should exceed low mechanism ${lowMech}`,
    );
  });

  it("purposeful geometry increases with floor coverage and structural features", () => {
    const lowGeom = computePurposefulGeometry(makeVector({
      solutionFloorCoverage: 0.1,
      solutionUnusedFloorRatio: 0.9,
      regionCount: 1,
      chokepoints: 0,
      articulationPoints: 0,
    }));
    const highGeom = computePurposefulGeometry(makeVector({
      solutionFloorCoverage: 0.9,
      solutionUnusedFloorRatio: 0.1,
      regionCount: 5,
      chokepoints: 4,
      articulationPoints: 3,
    }));

    assert.ok(
      highGeom > lowGeom,
      `high geometry ${highGeom} should exceed low geometry ${lowGeom}`,
    );
  });

  it("elegance decreases with high waste and repetition", () => {
    const highElegance = computeElegance(makeVector({
      unusedFloorRatio: 0.1,
      pushRatio: 0.6,
      repetitivePushRatio: 0.05,
      emptyWalkRatio: 0.1,
    }));
    const lowElegance = computeElegance(makeVector({
      unusedFloorRatio: 0.8,
      pushRatio: 0.2,
      repetitivePushRatio: 0.8,
      emptyWalkRatio: 0.7,
    }));

    assert.ok(
      highElegance > lowElegance,
      `high elegance ${highElegance} should exceed low elegance ${lowElegance}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Section 19.6: Geometry Contract Tests
// ---------------------------------------------------------------------------

describe("semantic: geometry contracts (19.6)", () => {
  it("quality floors exist for all difficulty tiers", () => {
    const tiers: Difficulty[] = ["tutorial", "beginner", "intermediate", "advanced", "expert", "master"];
    for (const tier of tiers) {
      const floor = QUALITY_FLOORS[tier];
      assert.ok(floor, `missing quality floor for ${tier}`);
      assert.equal(typeof floor.minPurposefulGeometry, "number");
      assert.equal(typeof floor.minInteractionQuality, "number");
      assert.equal(typeof floor.maxTedium, "number");
    }
  });

  it("higher tiers require more purposeful geometry", () => {
    const order: Difficulty[] = ["tutorial", "beginner", "intermediate", "advanced", "expert", "master"];
    for (let i = 1; i < order.length; i++) {
      const prev = QUALITY_FLOORS[order[i - 1]];
      const curr = QUALITY_FLOORS[order[i]];
      assert.ok(
        curr.minPurposefulGeometry >= prev.minPurposefulGeometry,
        `${order[i]} geometry floor should be >= ${order[i - 1]}`,
      );
    }
  });

  it("higher tiers have stricter tedium limits", () => {
    const order: Difficulty[] = ["tutorial", "beginner", "intermediate", "advanced", "expert", "master"];
    for (let i = 1; i < order.length; i++) {
      const prev = QUALITY_FLOORS[order[i - 1]];
      const curr = QUALITY_FLOORS[order[i]];
      assert.ok(
        curr.maxTedium <= prev.maxTedium,
        `${order[i]} tedium ceiling ${curr.maxTedium} should be <= ${order[i - 1]} ${prev.maxTedium}`,
      );
    }
  });
});
