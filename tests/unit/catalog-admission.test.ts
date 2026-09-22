import assert from "node:assert/strict";
import test from "node:test";

import {
  verifyPromotionFreshness,
  checkReleaseGate,
  DEFAULT_RELEASE_GATE_CONFIG,
} from "../../src/features/generator/v2/release-gate.ts";
import type { ReviewCandidatePack, PlaytestEvidence } from "../../src/features/generator/v2/catalog-manifest-types.ts";
import { boardHash } from "../../src/features/generator/v2/puzzle-identity.ts";
import { assessQuality } from "../../src/features/generator/v2/quality-gate.ts";
import { evaluatePuzzleWithSteps } from "../../src/features/generator/v2/puzzle-evaluator.ts";
import { scoreSolution } from "../../src/features/generator/v2/solution-scoring.ts";
import type { PuzzleDefinition } from "../../src/core/model.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SIMPLE_ROWS = [
  "OOOOOOO",
  "O  S  O",
  "O     O",
  "O  X  O",
  "O     O",
  "O  R  O",
  "OOOOOOO",
];

function makePlaytest(overrides?: Partial<PlaytestEvidence>): PlaytestEvidence {
  return {
    testerIds: ["tester-1"],
    solveTimeSeconds: 45,
    difficultyRating: 3,
    enjoymentRating: 4,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeMinimalPack(overrides?: Partial<ReviewCandidatePack>): ReviewCandidatePack {
  return {
    id: "test-puzzle-1",
    ascii: SIMPLE_ROWS.join("\n"),
    rows: SIMPLE_ROWS,
    solutionSteps: [
      { kind: "walk", direction: "up" },
      { kind: "push", direction: "up" },
      { kind: "push", direction: "up" },
    ],
    difficulty: "beginner",
    intendedDifficulty: "beginner",
    classifiedDifficulty: "beginner",
    difficultyGap: 0,
    boxCount: 1,
    boardWidth: 7,
    boardHeight: 7,
    playableFloor: 25,
    typingMode: "hybrid",
    genericBoxCount: 1,
    typedBoxCount: 0,
    solutionMoves: 3,
    solutionPushes: 2,
    minPushesPerBox: 2,
    inactiveBoxCount: 0,
    onePushBoxCount: 0,
    crossTypeInteractionCount: 0,
    seed: 42,
    family: "grid",
    mode: "standard",
    boardHash: boardHash(SIMPLE_ROWS),
    symmetryHash: boardHash(SIMPLE_ROWS),
    qualityPassed: true,
    qualityReasons: [],
    qualityPurposefulGeometry: 0.5,
    qualityInteraction: 0.5,
    qualityCausalDepth: 0.5,
    qualityDecision: 0.5,
    qualityMechanismIntegrity: 0.5,
    qualityElegance: 0.5,
    qualityTedium: 0.2,
    regionCount: 1,
    chokepoints: 0,
    articulationPoints: 0,
    tunnelCells: 0,
    floorUtilization: 0.8,
    solversAttempted: 1,
    solversSucceeded: 1,
    solverAgreement: true,
    avgExpandedStates: 100,
    maxExpandedStates: 100,
    v4Classification: "beginner",
    v4Composite: 0.3,
    ...overrides,
  } as ReviewCandidatePack;
}

// ---------------------------------------------------------------------------
// Item 27 — Playtest evidence
// ---------------------------------------------------------------------------

test("release gate requires playtest evidence when configured", () => {
  const pack = makeMinimalPack();
  const catalog = {
    schemaVersion: 2,
    generatorVersion: "4.2.0",
    generatedAt: new Date().toISOString(),
    tierSummaries: {
      beginner: { target: 1, actual: 1, candidates: [pack] },
    },
  };
  const config = { ...DEFAULT_RELEASE_GATE_CONFIG, minTotalPuzzles: 1, requirePlaytestEvidence: true };
  const verdict = checkReleaseGate(catalog, config);
  assert.ok(verdict.errors.some(e => e.includes("playtest")), `should require playtest, got: ${verdict.errors}`);
});

test("release gate passes with playtest evidence present", () => {
  const pack = makeMinimalPack({ playtestEvidence: makePlaytest() });
  const catalog = {
    schemaVersion: 2,
    generatorVersion: "4.2.0",
    generatedAt: new Date().toISOString(),
    tierSummaries: {
      beginner: { target: 1, actual: 1, candidates: [pack] },
    },
  };
  const config = { ...DEFAULT_RELEASE_GATE_CONFIG, minTotalPuzzles: 1, requirePlaytestEvidence: true };
  const verdict = checkReleaseGate(catalog, config);
  assert.ok(!verdict.errors.some(e => e.includes("playtest")), `should not flag playtest: ${verdict.errors.filter(e => e.includes("playtest"))}`);
});

test("release gate rejects low enjoyment rating", () => {
  const pack = makeMinimalPack({ playtestEvidence: makePlaytest({ enjoymentRating: 1 }) });
  const catalog = {
    schemaVersion: 2,
    generatorVersion: "4.2.0",
    generatedAt: new Date().toISOString(),
    tierSummaries: {
      beginner: { target: 1, actual: 1, candidates: [pack] },
    },
  };
  const config = { ...DEFAULT_RELEASE_GATE_CONFIG, minTotalPuzzles: 1, requirePlaytestEvidence: true, minEnjoymentRating: 3 };
  const verdict = checkReleaseGate(catalog, config);
  assert.ok(verdict.errors.some(e => e.includes("enjoyment")));
});

// ---------------------------------------------------------------------------
// Item 28 — Fresh promotion verification
// ---------------------------------------------------------------------------

test("verifyPromotionFreshness passes with valid pack", () => {
  const pack = makeMinimalPack();
  const result = verifyPromotionFreshness([pack]);
  assert.ok(result.passed, `should pass: ${result.errors}`);
});

test("verifyPromotionFreshness detects hash mismatch", () => {
  const pack = makeMinimalPack({ boardHash: "wrong-hash" });
  const result = verifyPromotionFreshness([pack]);
  assert.ok(!result.passed);
  assert.ok(result.errors.some(e => e.includes("hash mismatch")));
});

test("verifyPromotionFreshness detects missing solution steps", () => {
  const pack = makeMinimalPack({ solutionSteps: [] });
  const result = verifyPromotionFreshness([pack]);
  assert.ok(!result.passed);
  assert.ok(result.errors.some(e => e.includes("missing solution")));
});

test("verifyPromotionFreshness detects invalid replay", () => {
  const pack = makeMinimalPack({
    solutionSteps: [
      { kind: "push", direction: "left" },
      { kind: "push", direction: "left" },
      { kind: "push", direction: "left" },
    ],
  });
  const result = verifyPromotionFreshness([pack]);
  assert.ok(!result.passed);
  assert.ok(result.errors.some(e => e.includes("replay")));
});

// ---------------------------------------------------------------------------
// Item 29 — Adversarial quality fixtures
// ---------------------------------------------------------------------------

test("trivial puzzle scores low on quality dimensions", async () => {
  const trivialRows = [
    "OOOOO",
    "OSXRO",
    "OOOOO",
  ];
  const puzzle: PuzzleDefinition = { id: "trivial", title: "trivial", rows: trivialRows, difficulty: "beginner", boxes: 1 };
  const steps = [{ kind: "push" as const, direction: "left" as const }];
  const evalResult = await evaluatePuzzleWithSteps(puzzle, undefined, undefined, steps);
  const quality = assessQuality(evalResult.vector, "beginner");
  assert.ok(quality.interactionQuality < 0.3, `trivial puzzle should have low interaction, got ${quality.interactionQuality}`);
  assert.ok(quality.causalDepth < 0.3, `trivial puzzle should have low causal depth, got ${quality.causalDepth}`);
});

test("quality gate rejects dead-box puzzle (box cannot reach any goal)", async () => {
  const deadBoxRows = [
    "OOOOOOO",
    "O  S  O",
    "O OOO O",
    "O X R O",
    "OOOOOOO",
  ];
  const puzzle: PuzzleDefinition = { id: "dead-box", title: "dead-box", rows: deadBoxRows, difficulty: "beginner", boxes: 1 };
  const evalResult = await evaluatePuzzleWithSteps(puzzle);
  assert.ok(!evalResult.vector.solved, "dead-box puzzle should be unsolvable");
});

// ---------------------------------------------------------------------------
// Item 30 — Lifecycle regressions
// ---------------------------------------------------------------------------

test("evaluation vector includes structural metrics", async () => {
  const puzzle: PuzzleDefinition = {
    id: "lifecycle-test", title: "lifecycle", rows: SIMPLE_ROWS, difficulty: "beginner", boxes: 1,
  };
  const result = await evaluatePuzzleWithSteps(puzzle, undefined, undefined, [
    { kind: "walk", direction: "up" },
    { kind: "push", direction: "up" },
    { kind: "push", direction: "up" },
  ]);
  assert.ok(result.vector.totalFloor > 0, "should have floor count");
  assert.ok(result.vector.solutionMoves > 0, "should have move count");
  assert.ok(result.vector.solutionPushes > 0, "should have push count");
  assert.equal(result.vector.solved, true, "should be solved");
});

test("solution scoring produces finite composite", async () => {
  const steps = [
    { kind: "walk" as const, direction: "up" as const },
    { kind: "push" as const, direction: "up" as const },
    { kind: "push" as const, direction: "up" as const },
  ];
  const puzzle: PuzzleDefinition = {
    id: "score-test", title: "score", rows: SIMPLE_ROWS, difficulty: "beginner", boxes: 1,
  };
  const solution = { steps, moves: 3, pushes: 2, objective: { kind: "moves" as const }, objectiveScore: 3, optimality: "unknown" as const };
  const score = scoreSolution(puzzle, solution);
  assert.ok(Number.isFinite(score.composite), `composite should be finite, got ${score.composite}`);
  assert.ok(score.composite >= 0 && score.composite <= 1, `composite should be in [0,1], got ${score.composite}`);
});

// ---------------------------------------------------------------------------
// Item 31 — Heuristic validation (calibration sanity)
// ---------------------------------------------------------------------------

test("quality assessment dimensions are bounded [0, 1]", async () => {
  const puzzle: PuzzleDefinition = {
    id: "bounds-test", title: "bounds", rows: SIMPLE_ROWS, difficulty: "beginner", boxes: 1,
  };
  const steps = [
    { kind: "walk" as const, direction: "up" as const },
    { kind: "push" as const, direction: "up" as const },
    { kind: "push" as const, direction: "up" as const },
  ];
  const evalResult = await evaluatePuzzleWithSteps(puzzle, undefined, undefined, steps);
  const solution = { steps, moves: 3, pushes: 2, objective: { kind: "moves" as const }, objectiveScore: 3, optimality: "unknown" as const };
  scoreSolution(puzzle, solution);
  const quality = assessQuality(evalResult.vector, "beginner");
  for (const key of ["purposefulGeometry", "interactionQuality", "causalDepth", "decisionQuality", "mechanismIntegrity", "elegance", "tedium"] as const) {
    const value = quality[key];
    assert.ok(value >= 0 && value <= 1, `${key} should be in [0,1], got ${value}`);
  }
});
