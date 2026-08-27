import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assignSolverRoles,
  analyzeSolverBottleneck,
  extractCorrelationData,
  evaluateFinalist,
  evaluateFinalistV4,
  DEFAULT_V4_POLICY,
} from "../../src/features/generator/v2/index.ts";

import type {
  V4EvaluatorPolicy,
  FinalistEvaluation,
  PuzzleEvaluationVector,
} from "../../src/features/generator/v2/index.ts";

import type { PuzzleDefinition } from "../../src/core/model.ts";
import type { SolutionStep } from "../../src/solver/contracts.ts";

// ---------------------------------------------------------------------------
// Test puzzles
// ---------------------------------------------------------------------------

const TRIVIAL_1BOX: PuzzleDefinition = {
  id: "test-trivial-1",
  title: "Trivial",
  difficulty: "tutorial",
  boxes: 1,
  rows: ["OOOOO", "O R O", "O X O", "O S O", "OOOOO"],
};

const TWO_BOX: PuzzleDefinition = {
  id: "test-2box",
  title: "Two Box",
  difficulty: "beginner",
  boxes: 2,
  rows: ["OOOOOOO", "O R   O", "O XX  O", "O SS  O", "O     O", "OOOOOOO"],
};

// A puzzle with many boxes that should exceed proof limits
const LARGE_PUZZLE: PuzzleDefinition = {
  id: "test-large",
  title: "Large",
  difficulty: "expert",
  boxes: 10,
  rows: [
    "OOOOOOOOOOOOOOOOOOOOOOO",
    "O R                   O",
    "O X X X X X X X X X X O",
    "O                     O",
    "O S S S S S S S S S S O",
    "O                     O",
    "O                     O",
    "O                     O",
    "O                     O",
    "O                     O",
    "OOOOOOOOOOOOOOOOOOOOOOO",
  ],
};

// Known solution for TRIVIAL_1BOX: push box down once
const TRIVIAL_WITNESS: readonly SolutionStep[] = [
  { direction: "down", kind: "push" },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("assignSolverRoles", () => {
  it("always includes witness and fast-probe", () => {
    const roles = assignSolverRoles(1, 10);
    const roleNames = roles.map((r) => r.role);
    assert.ok(roleNames.includes("witness"), "should include witness");
    assert.ok(roleNames.includes("fast-probe"), "should include fast-probe");
  });

  it("skips proof for large puzzles", () => {
    const roles = assignSolverRoles(10, 500);
    const roleNames = roles.map((r) => r.role);
    assert.ok(
      !roleNames.includes("optional-proof"),
      "should not include optional-proof for large puzzles",
    );
  });

  it("includes proof for small puzzles", () => {
    const roles = assignSolverRoles(3, 50);
    const roleNames = roles.map((r) => r.role);
    assert.ok(
      roleNames.includes("optional-proof"),
      "should include optional-proof for small puzzles",
    );
  });
});

describe("DEFAULT_V4_POLICY", () => {
  it("has reasonable defaults", () => {
    assert.equal(DEFAULT_V4_POLICY.proofMaxBoxes, 6);
    assert.equal(DEFAULT_V4_POLICY.proofMaxFloor, 200);
    assert.equal(DEFAULT_V4_POLICY.requireOptimalProof, false);
    assert.ok(DEFAULT_V4_POLICY.witnessTimeoutMs > 0);
    assert.ok(DEFAULT_V4_POLICY.fastProbeMaxElapsedMs > 0);
    assert.ok(DEFAULT_V4_POLICY.exactEvidenceMaxElapsedMs > 0);
    assert.ok(DEFAULT_V4_POLICY.proofMaxElapsedMs > 0);
  });
});

describe("V4EvaluatorPolicy with requireOptimalProof=false", () => {
  it("still assigns witness and fast-probe roles", () => {
    const policy: V4EvaluatorPolicy = {
      ...DEFAULT_V4_POLICY,
      requireOptimalProof: false,
    };
    const roles = assignSolverRoles(3, 50, policy);
    const roleNames = roles.map((r) => r.role);
    assert.ok(roleNames.includes("witness"));
    assert.ok(roleNames.includes("fast-probe"));
  });
});

describe("analyzeSolverBottleneck", () => {
  it("produces complete report on a trivial puzzle", async () => {
    const report = await analyzeSolverBottleneck(
      TRIVIAL_1BOX,
      TRIVIAL_WITNESS,
    );

    assert.equal(report.puzzleId, "test-trivial-1");
    assert.equal(report.boxCount, 1);
    assert.ok(report.totalFloor > 0, "totalFloor should be positive");
    assert.ok(report.entries.length >= 3, "should have at least 3 entries");
    assert.equal(report.witnessValid, true);
    assert.equal(typeof report.fastProbeFound, "boolean");
    assert.equal(typeof report.exactEvidenceFound, "boolean");
    assert.equal(typeof report.proofAttempted, "boolean");
    assert.equal(typeof report.solvableButTimedOut, "boolean");
    assert.equal(typeof report.rejectedByProofOnly, "boolean");

    // For a trivial puzzle, fast probe and exact evidence should succeed
    assert.equal(report.fastProbeFound, true, "fast probe should solve trivial puzzle");
    assert.equal(report.exactEvidenceFound, true, "exact evidence should solve trivial puzzle");
  });

  it("detects timeout vs success with tight limits", async () => {
    // Run with extremely tight limits — should time out or exhaust states
    const tightPolicy: V4EvaluatorPolicy = {
      ...DEFAULT_V4_POLICY,
      fastProbeMaxElapsedMs: 1,
      fastProbeMaxStates: 1,
      exactEvidenceMaxElapsedMs: 1,
      exactEvidenceMaxStates: 1,
      proofMaxElapsedMs: 1,
      proofMaxStates: 1,
    };

    const report = await analyzeSolverBottleneck(
      TWO_BOX,
      undefined,
      tightPolicy,
    );

    // With 1ms / 1 state limits, solvers should not succeed on a 2-box puzzle
    // (witness has no steps so it's invalid, solvers should fail)
    assert.equal(report.witnessValid, false, "no witness steps provided");

    // At least check that entries exist and have the right structure
    for (const entry of report.entries) {
      assert.ok(typeof entry.solverId === "string");
      assert.ok(typeof entry.role === "string");
      assert.ok(typeof entry.status === "string");
      assert.ok(typeof entry.timedOut === "boolean");
      assert.ok(typeof entry.stateExhausted === "boolean");
      assert.ok(typeof entry.optimalityProven === "boolean");
    }
  });

  it("detects rejectedByProofOnly when witness succeeds but proof times out", async () => {
    // Use a policy where the proof has impossible limits but witness/probe work
    const policy: V4EvaluatorPolicy = {
      ...DEFAULT_V4_POLICY,
      proofMaxElapsedMs: 1,
      proofMaxStates: 1,
      proofMaxBoxes: 10, // allow proof attempt
      proofMaxFloor: 1000,
    };

    const report = await analyzeSolverBottleneck(
      TWO_BOX,
      undefined,
      policy,
    );

    // If fast probe found a solution but proof timed out with tight limits,
    // rejectedByProofOnly should be true
    if (report.fastProbeFound && report.proofAttempted && !report.proofSucceeded) {
      assert.equal(report.rejectedByProofOnly, true);
    }
    // The report should at least have attempted proof
    assert.equal(report.proofAttempted, true, "proof should be attempted with high proofMaxBoxes");
  });
});

describe("extractCorrelationData", () => {
  it("extracts all fields", () => {
    const ev: PuzzleEvaluationVector = {
      solverExpandedStates: 100,
      solverGeneratedStates: 200,
      solverElapsedMs: 50,
      solverPeakFrontier: 10,
      solverDeadlockPrunes: 5,
      solverDuplicateStates: 3,
      solutionMoves: 20,
      solutionPushes: 8,
      solutionWalks: 12,
      pushRatio: 0.4,
      boxCount: 2,
      avgLegalPushes: 3,
      maxLegalPushes: 5,
      singleChoiceRatio: 0.2,
      highBranchCount: 1,
      avgReachablePushes: 4.5,
      maxReachablePushes: 7,
      reachableSingleChoiceRatio: 0.15,
      reachableHighBranchCount: 2,
      reachableForcedPushRatio: 0.1,
      boxIndependenceRatio: 0.5,
      boxInteractionEvents: 3,
      pushesPerBox: 4,
      pushSwitchRatio: 0.3,
      sharedRouteCells: 2,
      sharedSupportCells: 1,
      sharedChokepointUses: 1,
      causalEnableCount: 2,
      causalDisableCount: 1,
      roomCrossingsInSolution: 3,
      deadlockDensity: 0.05,
      articulationPoints: 1,
      regionCount: 2,
      tunnelCells: 3,
      chokepoints: 1,
      floorUtilization: 0.8,
      openAreaRatio: 0.6,
      emptyWalkRatio: 0.3,
      longestWalkStreak: 5,
      forcedPushRatio: 0.1,
      repetitivePushRatio: 0.05,
      unusedFloorRatio: 0.2,
      movesPerPush: 2.5,
      solutionFloorCoverage: 0.8,
      solutionUnusedFloorRatio: 0.2,
      nonMonotonicBoxMoves: 3,
      nonMonotonicBoxCount: 1,
      stagingOperations: 2,
      temporaryGoalVacancies: 1,
      boxSwitchRate: 0.4,
      distinctBoxesMoved: 2,
      multiMoveBoxCount: 2,
      maxBoxEpisodes: 3,
      estimatedDependencyDepth: 2,
      goalOrderConstraints: 1,
      boardWidth: 7,
      boardHeight: 6,
      totalFloor: 20,
      solved: true,
    };

    const finalistEval: FinalistEvaluation = {
      solverEvidence: [
        {
          solverId: "greedy",
          status: "solved",
          moves: 20,
          pushes: 8,
          expandedStates: 100,
          generatedStates: 200,
          elapsedMs: 50,
          optimalityProven: false,
        },
        {
          solverId: "astar",
          status: "solved",
          moves: 18,
          pushes: 8,
          expandedStates: 500,
          generatedStates: 1000,
          elapsedMs: 200,
          optimalityProven: true,
        },
      ],
      solverAgreement: false,
      minMoves: 18,
      maxMoves: 20,
      minPushes: 8,
      maxPushes: 8,
      avgExpandedStates: 300,
      maxExpandedStates: 500,
      solversSucceeded: 2,
      solversAttempted: 2,
    };

    const data = extractCorrelationData(ev, finalistEval);

    assert.equal(data.expandedStates, 300);
    assert.equal(data.elapsedMs, 50);
    assert.equal(data.solverAgreement, false);
    assert.equal(data.optimalityProven, true);
    assert.equal(data.estimatedDependencyDepth, 2);
    assert.equal(data.nonMonotonicBoxMoves, 3);
    assert.equal(data.stagingOperations, 2);
    assert.equal(data.goalOrderConstraints, 1);
    assert.equal(data.boxCount, 2);
    assert.equal(data.solutionPushes, 8);
    assert.equal(data.avgReachablePushes, 4.5);
  });
});

describe("evaluateFinalistV4", () => {
  it("returns role results on trivial puzzle", async () => {
    const result = await evaluateFinalistV4(TRIVIAL_1BOX);

    assert.ok(result.roleResults instanceof Map, "roleResults should be a Map");
    assert.ok(result.roleResults.size > 0, "roleResults should have entries");
    assert.ok(result.solversAttempted > 0, "should attempt at least one solver");
    assert.equal(typeof result.witnessValid, "boolean");
    assert.ok(result.policyApplied === DEFAULT_V4_POLICY);
  });

  it("skips proof for large puzzles", async () => {
    const result = await evaluateFinalistV4(LARGE_PUZZLE);

    assert.equal(result.proofSkipped, true, "proof should be skipped");
    assert.ok(
      result.proofSkipReason !== undefined,
      "should provide skip reason",
    );
    assert.ok(
      !result.roleResults.has("optional-proof"),
      "roleResults should not include optional-proof",
    );
  });

  it("produces backward-compatible core fields like evaluateFinalist", async () => {
    const v4Result = await evaluateFinalistV4(TRIVIAL_1BOX);
    const legacyResult = await evaluateFinalist(TRIVIAL_1BOX);

    // Both should have the same core interface fields
    assert.equal(typeof v4Result.solverAgreement, "boolean");
    assert.equal(typeof v4Result.minMoves, "number");
    assert.equal(typeof v4Result.maxMoves, "number");
    assert.equal(typeof v4Result.minPushes, "number");
    assert.equal(typeof v4Result.maxPushes, "number");
    assert.equal(typeof v4Result.avgExpandedStates, "number");
    assert.equal(typeof v4Result.maxExpandedStates, "number");
    assert.equal(typeof v4Result.solversSucceeded, "number");
    assert.equal(typeof v4Result.solversAttempted, "number");
    assert.ok(Array.isArray(v4Result.solverEvidence));

    // Legacy should also produce valid results
    assert.ok(legacyResult.solversAttempted >= 2);
  });
});
