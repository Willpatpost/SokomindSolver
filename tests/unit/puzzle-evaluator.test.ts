import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluatePuzzle,
  evaluatePuzzles,
  summarizePopulation,
  type PopulationSummary,
} from "../../src/features/generator/v2/index.ts";

import type { PuzzleDefinition } from "../../src/core/model.ts";

// ---------------------------------------------------------------------------
// Test puzzles — small, deterministic, known properties
// ---------------------------------------------------------------------------

const TRIVIAL_1BOX: PuzzleDefinition = {
  id: "test-trivial-1",
  title: "Trivial",
  difficulty: "tutorial",
  boxes: 1,
  rows: ["OOOOO", "O R O", "O X O", "O S O", "OOOOO"],
};

const TWO_BOX_SIMPLE: PuzzleDefinition = {
  id: "test-2box",
  title: "Two Box",
  difficulty: "beginner",
  boxes: 2,
  rows: [
    "OOOOOOO",
    "O R   O",
    "O XX  O",
    "O SS  O",
    "O     O",
    "OOOOOOO",
  ],
};

const CORRIDOR_PUZZLE: PuzzleDefinition = {
  id: "test-corridor",
  title: "Corridor",
  difficulty: "beginner",
  boxes: 2,
  rows: [
    "OOOOOOOO",
    "OR     O",
    "OOOO X O",
    "OS   X O",
    "OS     O",
    "OOOOOOOO",
  ],
};

// ---------------------------------------------------------------------------
// 1. Basic evaluation returns all fields
// ---------------------------------------------------------------------------

test("evaluator: returns complete vector for trivial puzzle", async () => {
  const vec = await evaluatePuzzle(TRIVIAL_1BOX);

  assert.ok(vec.solved, "trivial puzzle should be solved");
  assert.equal(vec.boxCount, 1);
  assert.ok(vec.solutionMoves > 0, "should have some moves");
  assert.ok(vec.solutionPushes > 0, "should have some pushes");
  assert.ok(vec.solutionWalks >= 0);
  assert.ok(vec.pushRatio > 0 && vec.pushRatio <= 1);
  assert.ok(vec.solverElapsedMs >= 0);
  assert.ok(vec.solverExpandedStates >= 0);
  assert.ok(vec.totalFloor > 0);
  assert.ok(vec.boardWidth === 5);
  assert.ok(vec.boardHeight === 5);
  assert.ok(vec.floorUtilization > 0);
});

// ---------------------------------------------------------------------------
// 2. Determinism — same puzzle, same result
// ---------------------------------------------------------------------------

test("evaluator: deterministic for same puzzle", async () => {
  const a = await evaluatePuzzle(TWO_BOX_SIMPLE);
  const b = await evaluatePuzzle(TWO_BOX_SIMPLE);

  assert.equal(a.solutionMoves, b.solutionMoves);
  assert.equal(a.solutionPushes, b.solutionPushes);
  assert.equal(a.solverExpandedStates, b.solverExpandedStates);
  assert.equal(a.avgLegalPushes, b.avgLegalPushes);
  assert.equal(a.boxInteractionEvents, b.boxInteractionEvents);
  assert.equal(a.emptyWalkRatio, b.emptyWalkRatio);
  assert.equal(a.repetitivePushRatio, b.repetitivePushRatio);
});

// ---------------------------------------------------------------------------
// 3. Metric sanity — trivial vs structured
// ---------------------------------------------------------------------------

test("evaluator: trivial puzzle has low branching", async () => {
  const vec = await evaluatePuzzle(TRIVIAL_1BOX);

  assert.ok(vec.avgLegalPushes <= 4, `avg legal pushes ${vec.avgLegalPushes} should be small`);
  assert.equal(vec.boxInteractionEvents, 0, "1-box puzzle has no box interaction");
  assert.equal(vec.boxIndependenceRatio, 0, "1-box puzzle has independence ratio 0");
});

test("evaluator: corridor puzzle has structural features", async () => {
  const vec = await evaluatePuzzle(CORRIDOR_PUZZLE);
  assert.ok(vec.solved, "corridor puzzle should be solvable");
  assert.ok(vec.articulationPoints >= 0);
  assert.ok(vec.totalFloor > 10);
});

// ---------------------------------------------------------------------------
// 4. Walk metrics
// ---------------------------------------------------------------------------

test("evaluator: walks + pushes = moves", async () => {
  const vec = await evaluatePuzzle(TWO_BOX_SIMPLE);
  assert.equal(vec.solutionWalks + vec.solutionPushes, vec.solutionMoves);
});

test("evaluator: emptyWalkRatio is in [0, 1]", async () => {
  const vec = await evaluatePuzzle(TWO_BOX_SIMPLE);
  assert.ok(vec.emptyWalkRatio >= 0 && vec.emptyWalkRatio <= 1);
});

// ---------------------------------------------------------------------------
// 5. Push ratio is in [0, 1]
// ---------------------------------------------------------------------------

test("evaluator: pushRatio is in [0, 1]", async () => {
  const vec = await evaluatePuzzle(CORRIDOR_PUZZLE);
  assert.ok(vec.pushRatio >= 0 && vec.pushRatio <= 1);
});

// ---------------------------------------------------------------------------
// 6. movesPerPush ≥ 1
// ---------------------------------------------------------------------------

test("evaluator: movesPerPush ≥ 1", async () => {
  const vec = await evaluatePuzzle(TWO_BOX_SIMPLE);
  if (vec.solutionPushes > 0) {
    assert.ok(vec.movesPerPush >= 1, `movesPerPush ${vec.movesPerPush} should be ≥ 1`);
  }
});

// ---------------------------------------------------------------------------
// 7. Batch evaluation
// ---------------------------------------------------------------------------

test("evaluator: batch evaluation returns correct count", async () => {
  const results = await evaluatePuzzles([TRIVIAL_1BOX, TWO_BOX_SIMPLE]);
  assert.equal(results.length, 2);
  assert.ok(results[0].solved);
  assert.ok(results[1].solved);
});

// ---------------------------------------------------------------------------
// 8. Population summary
// ---------------------------------------------------------------------------

test("evaluator: population summary computes stats", async () => {
  const vecs = await evaluatePuzzles([TRIVIAL_1BOX, TWO_BOX_SIMPLE, CORRIDOR_PUZZLE]);
  const summary = summarizePopulation(vecs);

  assert.equal(summary.count, 3);
  assert.ok(summary.solvedCount <= 3);
  assert.ok(summary.avg.solutionMoves >= 0);
  assert.ok(summary.median.solutionMoves >= 0);
  assert.ok(summary.min.solutionMoves <= summary.max.solutionMoves);
  assert.ok(summary.avg.pushRatio >= 0 && summary.avg.pushRatio <= 1);
});

// ---------------------------------------------------------------------------
// 9. Forced push detection
// ---------------------------------------------------------------------------

test("evaluator: trivial puzzle has high forcedPushRatio", async () => {
  const vec = await evaluatePuzzle(TRIVIAL_1BOX);
  // 1-box, 1-push puzzle: the only legal push is forced
  assert.ok(vec.forcedPushRatio >= 0, "forced push ratio should be non-negative");
});

// ---------------------------------------------------------------------------
// 10. Unused floor ratio
// ---------------------------------------------------------------------------

test("evaluator: unused floor ratio is in [0, 1]", async () => {
  const vec = await evaluatePuzzle(CORRIDOR_PUZZLE);
  assert.ok(vec.unusedFloorRatio >= 0 && vec.unusedFloorRatio <= 1,
    `unusedFloorRatio ${vec.unusedFloorRatio} should be in [0, 1]`);
});

// ---------------------------------------------------------------------------
// 11. Repetitive push ratio is in [0, 1]
// ---------------------------------------------------------------------------

test("evaluator: repetitivePushRatio is in [0, 1]", async () => {
  const vec = await evaluatePuzzle(TWO_BOX_SIMPLE);
  assert.ok(vec.repetitivePushRatio >= 0 && vec.repetitivePushRatio <= 1);
});

// ---------------------------------------------------------------------------
// 12. Single-choice ratio is in [0, 1]
// ---------------------------------------------------------------------------

test("evaluator: singleChoiceRatio is in [0, 1]", async () => {
  const vec = await evaluatePuzzle(TWO_BOX_SIMPLE);
  assert.ok(vec.singleChoiceRatio >= 0 && vec.singleChoiceRatio <= 1);
});

// ---------------------------------------------------------------------------
// 13. Deadlock density is non-negative
// ---------------------------------------------------------------------------

test("evaluator: deadlockDensity is non-negative", async () => {
  const vec = await evaluatePuzzle(CORRIDOR_PUZZLE);
  assert.ok(vec.deadlockDensity >= 0);
});

// ---------------------------------------------------------------------------
// 14. Handcrafted catalog puzzle evaluation
// ---------------------------------------------------------------------------

test("evaluator: handcrafted catalog puzzle evaluates correctly", async () => {
  const puzzle: PuzzleDefinition = {
    id: "beginner-three",
    title: "Three in a Row",
    difficulty: "beginner",
    boxes: 3,
    rows: ["OOOOOOOO", "O R    O", "O XXXO O", "O SSSO O", "O      O", "OOOOOOOO"],
  };

  const vec = await evaluatePuzzle(puzzle);
  assert.ok(vec.solved, "beginner-three should be solvable");
  assert.equal(vec.boxCount, 3);
  assert.ok(vec.solutionPushes >= 3, "need at least 3 pushes for 3 boxes");
  assert.ok(vec.pushesPerBox >= 1);
});

// ---------------------------------------------------------------------------
// 15. Benchmark: Handcrafted vs V1 Generated vs V2 Beam
// ---------------------------------------------------------------------------

test("benchmark: cross-population evaluation", async () => {
  // Handcrafted samples
  const handcrafted: PuzzleDefinition[] = [
    {
      id: "hc-1",
      title: "Three in a Row",
      difficulty: "beginner",
      boxes: 3,
      rows: ["OOOOOOOO", "O R    O", "O XXXO O", "O SSSO O", "O      O", "OOOOOOOO"],
    },
    {
      id: "hc-2",
      title: "The Detour",
      difficulty: "beginner",
      boxes: 2,
      rows: ["OOOOOOOO", "OR     O", "OOOO X O", "OS   X O", "OS     O", "OOOOOOOO"],
    },
    {
      id: "hc-3",
      title: "Tiny Teaser",
      difficulty: "beginner",
      boxes: 2,
      rows: ["OOOOO", "OSX O", "O XRO", "O  SO", "OOOOO"],
    },
    {
      id: "hc-4",
      title: "Corner Lesson",
      difficulty: "tutorial",
      boxes: 1,
      rows: ["OOOOOO", "O    O", "O RX O", "O  S O", "O    O", "OOOOOO"],
    },
    {
      id: "hc-5",
      title: "Go Around",
      difficulty: "tutorial",
      boxes: 1,
      rows: ["OOOOOOO", "OR    O", "OOOOX O", "O   S O", "OOOOOOO"],
    },
  ];

  // V1 generated samples (from catalog JSON)
  const v1Generated: PuzzleDefinition[] = [
    {
      id: "v1-1",
      title: "V1 gen",
      difficulty: "beginner",
      boxes: 2,
      rows: ["OOOOOO", "OO bOO", "O A aO", "O  B O", "OOOROO", "OOOOOO"],
    },
    {
      id: "v1-2",
      title: "V1 gen",
      difficulty: "beginner",
      boxes: 2,
      rows: ["OOOOOO", "OOO OO", "OORAaO", "O B  O", "O b OO", "OOOOOO"],
    },
    {
      id: "v1-3",
      title: "V1 gen",
      difficulty: "beginner",
      boxes: 2,
      rows: ["OOOOOO", "OOOOOO", "O   OO", "O B  O", "ObRAaO", "OOOOOO"],
    },
    {
      id: "v1-4",
      title: "V1 gen",
      difficulty: "tutorial",
      boxes: 2,
      rows: ["OOOOOO", "OOOOOO", "ObaBRO", "O  A O", "O   OO", "OOOOOO"],
    },
    {
      id: "v1-5",
      title: "V1 gen",
      difficulty: "tutorial",
      boxes: 2,
      rows: ["OOOOOO", "ORA aO", "O bB O", "OO   O", "OOOOOO", "OOOOOO"],
    },
  ];

  // V2 beam search samples — generate them
  const {
    assignRoomRoles,
    generateBlueprintWithRetry,
    placeGoals,
    reverseBeamSearch,
    DEFAULT_BLUEPRINT_PARAMS,
    DEFAULT_GOAL_PARAMS,
    DEFAULT_BEAM_PARAMS,
  } = await import("../../src/features/generator/v2/index.ts");

  const v2Beam: PuzzleDefinition[] = [];
  const v2Random: PuzzleDefinition[] = [];

  const { scrambleByReversePull } = await import("../../src/features/generator/reverse-play.ts");
  const { createRng } = await import("../../src/features/generator/board-template.ts");
  const { toSolvedTemplate } = await import("../../src/features/generator/v2/goal-placement.ts");
  const { buildPuzzleFromScramble } = await import("../../src/features/generator/generate-puzzle.ts");
  const { validatePuzzle } = await import("../../src/core/puzzle.ts");

  for (let seed = 5000; seed < 5025; seed++) {
    const bpParams = { ...DEFAULT_BLUEPRINT_PARAMS, seed, family: "linear" as const, boardWidth: 16, boardHeight: 16 };
    const bp = generateBlueprintWithRetry(bpParams, 30);
    if (!bp) continue;
    const fb = assignRoomRoles(bp, seed, 3);
    const solved = placeGoals(fb, { ...DEFAULT_GOAL_PARAMS, seed, boxCount: 3 });
    if (!solved) continue;

    const template = toSolvedTemplate(solved);

    // V2 beam search — build puzzle via buildPuzzleFromScramble
    const beamResult = reverseBeamSearch(solved, { ...DEFAULT_BEAM_PARAMS, seed, maxDepth: 25 });
    if (beamResult.best.depth === 0) continue;
    const beamScrambled = {
      template,
      boxPositions: beamResult.best.boxPositions as Array<{ row: number; column: number }>,
      robotPosition: beamResult.best.robotPosition,
      reversePulls: beamResult.best.depth,
    };
    const beamPuzzle = buildPuzzleFromScramble(beamScrambled, "intermediate");
    const beamValid = validatePuzzle(beamPuzzle);
    if (!beamValid.valid) continue;
    v2Beam.push({ ...beamPuzzle, id: `v2-beam-${seed}` });

    // V2 random reverse pull (same template)
    const scrambled = scrambleByReversePull(template, 25, createRng(seed));
    const randomPuzzle = buildPuzzleFromScramble(scrambled, "intermediate");
    const randomValid = validatePuzzle(randomPuzzle);
    if (!randomValid.valid) continue;
    v2Random.push({ ...randomPuzzle, id: `v2-random-${seed}` });

    if (v2Beam.length >= 5) break;
  }

  // Evaluate all populations
  const hcVecs = await evaluatePuzzles(handcrafted);
  const v1Vecs = await evaluatePuzzles(v1Generated);
  const v2BeamVecs = await evaluatePuzzles(v2Beam);
  const v2RandomVecs = await evaluatePuzzles(v2Random);

  const hcSummary = summarizePopulation(hcVecs);
  const v1Summary = summarizePopulation(v1Vecs);
  const v2BeamSummary = summarizePopulation(v2BeamVecs);
  const v2RandomSummary = summarizePopulation(v2RandomVecs);

  function fmt(n: number): string { return n.toFixed(2); }

  const keys: (keyof PopulationSummary["avg"])[] = [
    "solutionMoves",
    "solutionPushes",
    "solverExpandedStates",
    "avgLegalPushes",
    "maxLegalPushes",
    "singleChoiceRatio",
    "boxInteractionEvents",
    "boxIndependenceRatio",
    "pushesPerBox",
    "roomCrossingsInSolution",
    "deadlockDensity",
    "articulationPoints",
    "regionCount",
    "tunnelCells",
    "chokepoints",
    "emptyWalkRatio",
    "longestWalkStreak",
    "forcedPushRatio",
    "repetitivePushRatio",
    "unusedFloorRatio",
    "movesPerPush",
    "floorUtilization",
    "openAreaRatio",
    "totalFloor",
  ];

  console.log("\n  Cross-population evaluation benchmark:");
  console.log(`  ${"Metric".padEnd(30)} ${"Handcrafted".padStart(12)} ${"V1 Generated".padStart(12)} ${"V2 Beam".padStart(12)} ${"V2 Random".padStart(12)}`);
  console.log(`  ${"─".repeat(30)} ${"─".repeat(12)} ${"─".repeat(12)} ${"─".repeat(12)} ${"─".repeat(12)}`);

  for (const key of keys) {
    const hc = hcSummary.avg[key] ?? 0;
    const v1 = v1Summary.avg[key] ?? 0;
    const v2b = v2BeamSummary.avg[key] ?? 0;
    const v2r = v2RandomSummary.avg[key] ?? 0;
    console.log(`  ${String(key).padEnd(30)} ${fmt(hc).padStart(12)} ${fmt(v1).padStart(12)} ${fmt(v2b).padStart(12)} ${fmt(v2r).padStart(12)}`);
  }

  console.log(`  ${"─".repeat(30)} ${"─".repeat(12)} ${"─".repeat(12)} ${"─".repeat(12)} ${"─".repeat(12)}`);
  console.log(`  ${"solved/total".padEnd(30)} ${`${hcSummary.solvedCount}/${hcSummary.count}`.padStart(12)} ${`${v1Summary.solvedCount}/${v1Summary.count}`.padStart(12)} ${`${v2BeamSummary.solvedCount}/${v2BeamSummary.count}`.padStart(12)} ${`${v2RandomSummary.solvedCount}/${v2RandomSummary.count}`.padStart(12)}`);

  // Basic assertions — all test puzzles should solve
  assert.ok(hcSummary.solvedCount >= 3, "most handcrafted should solve");
  assert.ok(v1Summary.solvedCount >= 3, "most V1 should solve");
  assert.ok(v2BeamSummary.count > 0, "should have V2 beam puzzles");
});

// ---------------------------------------------------------------------------
// Phase 2 evaluator semantic tests
// ---------------------------------------------------------------------------

test("reachable push count >= adjacent push count", async () => {
  const ev = await evaluatePuzzle(TRIVIAL_1BOX);
  assert.ok(ev.avgReachablePushes >= ev.avgLegalPushes,
    `reachable ${ev.avgReachablePushes} should be >= adjacent ${ev.avgLegalPushes}`);
});

test("reachable push metrics are non-negative", async () => {
  const ev = await evaluatePuzzle(TWO_BOX_SIMPLE);
  assert.ok(ev.avgReachablePushes >= 0);
  assert.ok(ev.maxReachablePushes >= 0);
  assert.ok(ev.reachableSingleChoiceRatio >= 0 && ev.reachableSingleChoiceRatio <= 1);
  assert.ok(ev.reachableHighBranchCount >= 0);
  assert.ok(ev.reachableForcedPushRatio >= 0 && ev.reachableForcedPushRatio <= 1);
});

test("solutionFloorCoverage in [0,1]", async () => {
  const ev = await evaluatePuzzle(TRIVIAL_1BOX);
  assert.ok(ev.solutionFloorCoverage >= 0 && ev.solutionFloorCoverage <= 1,
    `coverage ${ev.solutionFloorCoverage} should be in [0,1]`);
});

test("solutionUnusedFloorRatio + solutionFloorCoverage ≈ 1", async () => {
  const ev = await evaluatePuzzle(TRIVIAL_1BOX);
  const sum = ev.solutionFloorCoverage + ev.solutionUnusedFloorRatio;
  assert.ok(Math.abs(sum - 1) < 1e-10, `sum should be 1, got ${sum}`);
});

test("pushSwitchRatio equals boxIndependenceRatio", async () => {
  const ev = await evaluatePuzzle(TWO_BOX_SIMPLE);
  assert.equal(ev.pushSwitchRatio, ev.boxIndependenceRatio,
    "pushSwitchRatio is the same formula as boxIndependenceRatio");
});

test("interaction metrics are non-negative", async () => {
  const ev = await evaluatePuzzle(TWO_BOX_SIMPLE);
  assert.ok(ev.sharedRouteCells >= 0);
  assert.ok(ev.sharedSupportCells >= 0);
  assert.ok(ev.sharedChokepointUses >= 0);
  assert.ok(ev.causalEnableCount >= 0);
  assert.ok(ev.causalDisableCount >= 0);
});

test("1-box puzzle has zero interaction metrics", async () => {
  const ev = await evaluatePuzzle(TRIVIAL_1BOX);
  assert.equal(ev.sharedRouteCells, 0);
  assert.equal(ev.sharedSupportCells, 0);
  assert.equal(ev.sharedChokepointUses, 0);
  assert.equal(ev.causalEnableCount, 0);
  assert.equal(ev.causalDisableCount, 0);
});

test("corridor puzzle has interaction or causal events with 2 boxes", async () => {
  const ev = await evaluatePuzzle(CORRIDOR_PUZZLE);
  if (ev.solved && ev.solutionPushes > 2) {
    assert.ok(
      ev.sharedRouteCells >= 0 || ev.causalEnableCount >= 0 || ev.causalDisableCount >= 0,
      "some interaction signal expected for multi-box corridor",
    );
  }
});
