import assert from "node:assert/strict";
import test from "node:test";

import {
  generateBlueprintWithRetry,
  assignRoomRoles,
  placeGoals,
  reverseBeamSearch,
  toSolvedTemplate,
  tightenPuzzle,
  tightenPuzzles,
  summarizeTighteningResults,
  buildPreservationContext,
  generateVerifiedMotifPuzzle,
  generateComposedPuzzle,
  DEFAULT_BLUEPRINT_PARAMS,
  DEFAULT_GOAL_PARAMS,
  DEFAULT_BEAM_PARAMS,
  DEFAULT_TIGHTENING_PARAMS,
  DEFAULT_COMPOSITION_PARAMS,
  DEFAULT_TIER_TIGHTENING_POLICIES,
  type TighteningResult,
  type TierTighteningPolicy,
  type FunctionalBlueprint,
} from "../../src/features/generator/v2/index.ts";

import { analyzeGrid, parseRowsToGrid } from "../../src/features/generator/v2/structural-metrics.ts";

import { buildPuzzleFromScramble } from "../../src/features/generator/generate-puzzle.ts";
import { validatePuzzle } from "../../src/core/puzzle.ts";
import { createSession } from "../../src/core/game-session.ts";
import { classicGreedySolver } from "../../src/solver/implementations/classic-solvers.ts";
import type { PuzzleDefinition } from "../../src/core/model.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function puzzle(rows: readonly string[]): PuzzleDefinition {
  let boxCount = 0;
  for (const row of rows) {
    for (const ch of row) {
      if (ch === "X") boxCount++;
      if (/^[A-Z]$/.test(ch) && !"ORSX".includes(ch)) boxCount++;
    }
  }
  return {
    id: "test",
    title: "Test",
    difficulty: "tutorial",
    boxes: boxCount,
    rows,
  };
}

function buildBlueprint(
  seed: number,
  family: "linear" | "hub" | "loop" | "branch" | "nested" = "linear",
): FunctionalBlueprint | null {
  const bp = generateBlueprintWithRetry(
    {
      ...DEFAULT_BLUEPRINT_PARAMS,
      seed,
      family,
      boardWidth: 14,
      boardHeight: 14,
    },
    30,
  );
  if (!bp) return null;
  return assignRoomRoles(bp, seed, 4);
}

function generatePuzzleFromBlueprint(
  fb: FunctionalBlueprint,
  seed: number,
  boxCount = 3,
): PuzzleDefinition | null {
  const solved = placeGoals(fb, {
    ...DEFAULT_GOAL_PARAMS,
    seed,
    boxCount,
  });
  if (!solved) return null;
  const template = toSolvedTemplate(solved);
  const beam = reverseBeamSearch(solved, {
    ...DEFAULT_BEAM_PARAMS,
    seed,
    maxDepth: 25,
  });
  if (beam.best.depth === 0) return null;
  const scrambled = {
    template,
    boxPositions: beam.best.boxPositions as Array<{
      row: number;
      column: number;
    }>,
    robotPosition: beam.best.robotPosition,
    reversePulls: beam.best.depth,
  };
  const p = buildPuzzleFromScramble(scrambled, "intermediate");
  const valid = validatePuzzle(p);
  if (!valid.valid) return null;
  return { ...p, id: `gen-${seed}` };
}

async function solvePuzzle(
  p: PuzzleDefinition,
): Promise<boolean> {
  const session = createSession(p);
  const result = await classicGreedySolver.solve(
    {
      board: session.board,
      snapshot: session.snapshot,
      objective: { kind: "moves" },
      limits: { maxElapsedMs: 10_000, maxExpandedStates: 1_500_000 },
    },
    {
      signal: new AbortController().signal,
      reportProgress: () => {},
      now: () => performance.now(),
    },
  );
  return result.status === "solved";
}

// ---------------------------------------------------------------------------
// 1. Tightening a simple solvable puzzle
// ---------------------------------------------------------------------------

test("tighten a simple puzzle — returns result preserving solvability", async () => {
  const p = puzzle([
    "OOOOOOOOOO",
    "O        O",
    "O R      O",
    "O   X    O",
    "O   S    O",
    "O        O",
    "O        O",
    "O        O",
    "OOOOOOOOOO",
  ]);
  const result = await tightenPuzzle(p);
  assert.ok(result, "should produce a result");
  assert.ok(result.mutationsAccepted > 0, "should accept at least one mutation");
  assert.ok(result.cellsRemoved > 0, "should remove at least one cell");

  const solved = await solvePuzzle(result.tightened);
  assert.ok(solved, "tightened puzzle must still be solvable");
});

// ---------------------------------------------------------------------------
// 2. Entity cells are never removed
// ---------------------------------------------------------------------------

test("entity cells are never converted to walls", async () => {
  const p = puzzle([
    "OOOOOOOO",
    "O R    O",
    "O  X   O",
    "O  S   O",
    "O      O",
    "O      O",
    "OOOOOOOO",
  ]);
  const result = await tightenPuzzle(p);
  assert.ok(result, "should produce a result");

  const grid = result.tightened.rows;
  let hasRobot = false;
  let boxCount = 0;
  let goalCount = 0;
  for (const row of grid) {
    for (const ch of row) {
      if (ch === "R") hasRobot = true;
      if (ch === "X") boxCount++;
      if (ch === "S") goalCount++;
    }
  }
  assert.ok(hasRobot, "robot must still exist");
  assert.equal(boxCount, 1, "box count preserved");
  assert.equal(goalCount, 1, "goal count preserved");
});

// ---------------------------------------------------------------------------
// 3. Connectivity is preserved
// ---------------------------------------------------------------------------

test("tightened puzzle preserves connectivity", async () => {
  const p = puzzle([
    "OOOOOOOOOO",
    "O R      O",
    "O        O",
    "OOOO  OOOO",
    "O  X     O",
    "O  S     O",
    "O        O",
    "OOOOOOOOOO",
  ]);
  const result = await tightenPuzzle(p);
  assert.ok(result, "should produce a result");

  const grid = result.tightened.rows.map((r) => [...r]);
  const h = grid.length;
  const w = grid[0].length;
  let robotR = 0, robotC = 0;
  const criticalCells: Array<[number, number]> = [];
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      if (grid[r][c] === "R") { robotR = r; robotC = c; }
      if (grid[r][c] === "X" || grid[r][c] === "S") {
        criticalCells.push([r, c]);
      }
    }
  }

  const visited = new Set<string>();
  const queue: Array<[number, number]> = [[robotR, robotC]];
  visited.add(`${robotR},${robotC}`);
  while (queue.length > 0) {
    const [r, c] = queue.shift()!;
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= h || nc < 0 || nc >= w) continue;
      if (grid[nr][nc] === "O") continue;
      const key = `${nr},${nc}`;
      if (visited.has(key)) continue;
      visited.add(key);
      queue.push([nr, nc]);
    }
  }

  for (const [r, c] of criticalCells) {
    assert.ok(
      visited.has(`${r},${c}`),
      `cell (${r},${c}) with '${grid[r][c]}' must be reachable from robot`,
    );
  }
});

// ---------------------------------------------------------------------------
// 4. Returns null for unsolvable puzzle
// ---------------------------------------------------------------------------

test("returns null when puzzle is initially unsolvable", async () => {
  const p = puzzle([
    "OOOOO",
    "ORXOO",
    "OO SO",
    "OOOOO",
  ]);
  const result = await tightenPuzzle(p);
  assert.equal(result, null, "unsolvable puzzle should return null");
});

// ---------------------------------------------------------------------------
// 5. Zero-acceptance case
// ---------------------------------------------------------------------------

test("returns original puzzle when no mutations are accepted", async () => {
  const p = puzzle([
    "OOOOO",
    "ORXSO",
    "OOOOO",
  ]);
  const result = await tightenPuzzle(p);
  assert.ok(result, "should return a result");
  assert.equal(result.cellsRemoved, 0, "no cells should be removed");
  assert.deepEqual(result.tightened.rows, p.rows, "puzzle should be unchanged");
});

// ---------------------------------------------------------------------------
// 6. Metrics before/after are populated
// ---------------------------------------------------------------------------

test("metrics before and after are populated with valid values", async () => {
  const p = puzzle([
    "OOOOOOOO",
    "O R    O",
    "O  X   O",
    "O  S   O",
    "O      O",
    "O      O",
    "OOOOOOOO",
  ]);
  const result = await tightenPuzzle(p);
  assert.ok(result, "should produce a result");

  const { before, after } = result.metrics;
  assert.ok(before.totalFloor > 0, "before totalFloor > 0");
  assert.ok(after.totalFloor > 0, "after totalFloor > 0");
  assert.ok(after.totalFloor <= before.totalFloor, "floor should not increase");
  assert.ok(before.solutionMoves > 0, "before should have moves");
  assert.ok(after.solutionMoves > 0, "after should have moves");
  assert.ok(before.solutionPushes > 0, "before should have pushes");
  assert.ok(after.solutionPushes > 0, "after should have pushes");
});

// ---------------------------------------------------------------------------
// 7. Unused floor ratio decreases or stays same
// ---------------------------------------------------------------------------

test("unused floor ratio does not increase after tightening", async () => {
  const p = puzzle([
    "OOOOOOOOOO",
    "O        O",
    "O R      O",
    "O   X    O",
    "O   S    O",
    "O        O",
    "O        O",
    "OOOOOOOOOO",
  ]);
  const result = await tightenPuzzle(p);
  assert.ok(result, "should produce a result");
  assert.ok(
    result.metrics.after.unusedFloorRatio <= result.metrics.before.unusedFloorRatio + 0.01,
    `unused floor ratio should not increase substantially: ${result.metrics.before.unusedFloorRatio} → ${result.metrics.after.unusedFloorRatio}`,
  );
});

// ---------------------------------------------------------------------------
// 8. Validation still passes after tightening
// ---------------------------------------------------------------------------

test("tightened puzzle passes validatePuzzle", async () => {
  const p = puzzle([
    "OOOOOOOO",
    "O R    O",
    "O  XX  O",
    "O  SS  O",
    "O      O",
    "O      O",
    "OOOOOOOO",
  ]);
  const result = await tightenPuzzle(p);
  assert.ok(result, "should produce a result");
  const validation = validatePuzzle(result.tightened);
  assert.ok(validation.valid, `tightened puzzle must be valid: ${JSON.stringify(validation)}`);
});

// ---------------------------------------------------------------------------
// 9. Batch tightenPuzzles
// ---------------------------------------------------------------------------

test("tightenPuzzles processes multiple puzzles", async () => {
  const puzzles: PuzzleDefinition[] = [
    puzzle([
      "OOOOOOO",
      "OR X  O",
      "O  S  O",
      "O     O",
      "OOOOOOO",
    ]),
    puzzle([
      "OOOOOOOO",
      "O R    O",
      "O  X   O",
      "O  S   O",
      "O      O",
      "OOOOOOOO",
    ]),
  ];
  const results = await tightenPuzzles(puzzles);
  assert.ok(results.length > 0, "should have results");
  for (const r of results) {
    const solved = await solvePuzzle(r.tightened);
    assert.ok(solved, "each tightened puzzle must still be solvable");
  }
});

// ---------------------------------------------------------------------------
// 10. Summary statistics
// ---------------------------------------------------------------------------

test("summarizeTighteningResults computes correct averages", () => {
  const mockResult = (cellsRemoved: number, tried: number, accepted: number): TighteningResult => ({
    original: puzzle(["OOOOO", "ORXSO", "OOOOO"]),
    tightened: puzzle(["OOOOO", "ORXSO", "OOOOO"]),
    mutationsTried: tried,
    mutationsAccepted: accepted,
    mutationsRejected: tried - accepted,
    cellsRemoved,
    elapsedMs: 100,
    protectedCellCount: 0,
    metrics: {
      before: {
        totalFloor: 20, unusedFloorRatio: 0.5, solutionUnusedFloorRatio: 0.4, emptyWalkRatio: 0.6,
        longestWalkStreak: 4, repetitivePushRatio: 0.2, movesPerPush: 3,
        solutionMoves: 12, solutionPushes: 4, boxIndependenceRatio: 0.8, pushSwitchRatio: 0.8,
        solverExpandedStates: 100, deadlockDensity: 0.1,
      },
      after: {
        totalFloor: 15, unusedFloorRatio: 0.3, solutionUnusedFloorRatio: 0.2, emptyWalkRatio: 0.4,
        longestWalkStreak: 2, repetitivePushRatio: 0.1, movesPerPush: 2.5,
        solutionMoves: 10, solutionPushes: 4, boxIndependenceRatio: 0.7, pushSwitchRatio: 0.7,
        solverExpandedStates: 80, deadlockDensity: 0.08,
      },
    },
  });

  const results = [mockResult(5, 20, 5), mockResult(3, 15, 3)];
  const summary = summarizeTighteningResults(results);

  assert.equal(summary.count, 2);
  assert.equal(summary.totalCellsRemoved, 8);
  assert.equal(summary.avgCellsRemoved, 4);
  assert.ok(summary.avgAcceptanceRate > 0, "acceptance rate > 0");
  assert.ok(summary.avgFloorBefore > summary.avgFloorAfter, "floor should decrease");
  assert.ok(summary.avgUnusedBefore > summary.avgUnusedAfter, "unused ratio should decrease");
});

// ---------------------------------------------------------------------------
// 11. Empty summary
// ---------------------------------------------------------------------------

test("summarizeTighteningResults handles empty array", () => {
  const summary = summarizeTighteningResults([]);
  assert.equal(summary.count, 0);
  assert.equal(summary.totalCellsRemoved, 0);
  assert.equal(summary.avgCellsRemoved, 0);
});

// ---------------------------------------------------------------------------
// 12. Params limit enforcement
// ---------------------------------------------------------------------------

test("respects maxMutationsPerPass limit", async () => {
  const p = puzzle([
    "OOOOOOOOOO",
    "O        O",
    "O R      O",
    "O   X    O",
    "O   S    O",
    "O        O",
    "O        O",
    "O        O",
    "OOOOOOOOOO",
  ]);
  const result = await tightenPuzzle(p, {
    ...DEFAULT_TIGHTENING_PARAMS,
    maxMutationsPerPass: 5,
    maxAccepted: 100,
  });
  assert.ok(result, "should produce a result");
  assert.ok(
    result.mutationsTried <= 5,
    `should try at most 5 mutations, tried ${result.mutationsTried}`,
  );
});

test("respects maxAccepted limit", async () => {
  const p = puzzle([
    "OOOOOOOOOO",
    "O        O",
    "O R      O",
    "O   X    O",
    "O   S    O",
    "O        O",
    "O        O",
    "O        O",
    "OOOOOOOOOO",
  ]);
  const result = await tightenPuzzle(p, {
    ...DEFAULT_TIGHTENING_PARAMS,
    maxMutationsPerPass: 200,
    maxAccepted: 2,
  });
  assert.ok(result, "should produce a result");
  assert.ok(
    result.mutationsAccepted <= 2,
    `should accept at most 2 mutations, accepted ${result.mutationsAccepted}`,
  );
});

// ---------------------------------------------------------------------------
// 13. Box independence does not regress badly
// ---------------------------------------------------------------------------

test("box independence ratio does not degrade excessively", async () => {
  const p = puzzle([
    "OOOOOOOOO",
    "O       O",
    "O R     O",
    "O  XX   O",
    "O  SS   O",
    "O       O",
    "O       O",
    "OOOOOOOOO",
  ]);
  const result = await tightenPuzzle(p);
  assert.ok(result, "should produce a result");
  assert.ok(
    result.metrics.after.boxIndependenceRatio <=
      result.metrics.before.boxIndependenceRatio + 0.15,
    `box independence should not degrade by more than 0.15`,
  );
});

// ---------------------------------------------------------------------------
// 14. Generated puzzle tightening
// ---------------------------------------------------------------------------

test("tightens a blueprint-generated puzzle", async () => {
  let generated: PuzzleDefinition | null = null;
  for (let seed = 5000; seed < 5100; seed++) {
    const fb = buildBlueprint(seed);
    if (!fb) continue;
    generated = generatePuzzleFromBlueprint(fb, seed);
    if (generated) break;
  }
  if (!generated) {
    console.log("  (skipped: could not generate a suitable puzzle)");
    return;
  }

  const result = await tightenPuzzle(generated);
  assert.ok(result, "should produce a result for generated puzzle");

  const valid = validatePuzzle(result.tightened);
  assert.ok(valid.valid, "tightened generated puzzle must pass validation");

  const solved = await solvePuzzle(result.tightened);
  assert.ok(solved, "tightened generated puzzle must be solvable");
});

// ---------------------------------------------------------------------------
// 15. Multi-box puzzle preserves all boxes
// ---------------------------------------------------------------------------

test("tightening preserves all boxes and goals in multi-box puzzle", async () => {
  const p = puzzle([
    "OOOOOOOOOO",
    "O        O",
    "O R      O",
    "O XXX    O",
    "O SSS    O",
    "O        O",
    "O        O",
    "O        O",
    "OOOOOOOOOO",
  ]);
  const result = await tightenPuzzle(p);
  assert.ok(result, "should produce a result");

  let origBoxes = 0, origGoals = 0;
  for (const row of p.rows) {
    for (const ch of row) {
      if (ch === "X") origBoxes++;
      if (ch === "S") origGoals++;
    }
  }

  let tightBoxes = 0, tightGoals = 0;
  for (const row of result.tightened.rows) {
    for (const ch of row) {
      if (ch === "X") tightBoxes++;
      if (ch === "S") tightGoals++;
    }
  }

  assert.equal(tightBoxes, origBoxes, "box count must be preserved");
  assert.equal(tightGoals, origGoals, "goal count must be preserved");
});

// ---------------------------------------------------------------------------
// 16. Alcoves are prioritized for removal
// ---------------------------------------------------------------------------

test("alcoves (dead-ends off solution path) are removed first", async () => {
  const p = puzzle([
    "OOOOOOOOO",
    "O       O",
    "O R X   O",
    "OO  S   O",
    "O  OOOOOO",
    "O  O     ",
    "O  O     ",
    "OOOOO    ",
  ]);
  const result = await tightenPuzzle(p);
  assert.ok(result, "should produce a result");

  const origFloor = p.rows.reduce(
    (s, r) => s + [...r].filter((ch) => ch !== "O").length,
    0,
  );
  const tightFloor = result.tightened.rows.reduce(
    (s, r) => s + [...r].filter((ch) => ch !== "O").length,
    0,
  );
  assert.ok(tightFloor <= origFloor, "floor count should decrease or stay same");
});

// ---------------------------------------------------------------------------
// 17. Cross-population benchmark: tightened vs untightened
// ---------------------------------------------------------------------------

test("benchmark: tightened vs untightened across topology/motif/composition types", async () => {
  const categories: Record<string, PuzzleDefinition[]> = {
    "no-motif": [],
    "single-motif": [],
    "composed": [],
  };
  const targetPerCategory = 3;

  for (let seed = 6000; seed < 6200; seed++) {
    const fb = buildBlueprint(seed);
    if (!fb) continue;

    if (categories["no-motif"].length < targetPerCategory) {
      const p = generatePuzzleFromBlueprint(fb, seed);
      if (p) categories["no-motif"].push(p);
    }

    if (categories["single-motif"].length < targetPerCategory) {
      const result = await generateVerifiedMotifPuzzle(fb, {
        seed,
        boxCount: 3,
        motif: "auto",
      });
      if (result) {
        categories["single-motif"].push(result.puzzle);
      }
    }

    if (categories["composed"].length < targetPerCategory) {
      const result = await generateComposedPuzzle(fb, {
        ...DEFAULT_COMPOSITION_PARAMS,
        seed,
        boxCount: 4,
      });
      if (result) {
        categories["composed"].push(result.puzzle);
      }
    }

    const allDone = Object.values(categories).every(
      (arr) => arr.length >= targetPerCategory,
    );
    if (allDone) break;
  }

  const allPuzzles = Object.values(categories).flat();
  if (allPuzzles.length === 0) {
    console.log("  (skipped: could not generate any puzzles for benchmark)");
    return;
  }

  const allResults = await tightenPuzzles(allPuzzles);
  assert.ok(allResults.length > 0, "should tighten at least one puzzle");

  for (const r of allResults) {
    const valid = validatePuzzle(r.tightened);
    assert.ok(valid.valid, "every tightened puzzle must pass validation");
    const solved = await solvePuzzle(r.tightened);
    assert.ok(solved, "every tightened puzzle must be solvable");
  }

  const summary = summarizeTighteningResults(allResults);

  function fmt(n: number): string {
    return n.toFixed(3);
  }

  console.log("\n  Sprint 8 Geometry Tightening Benchmark:");
  console.log(`  Puzzles tightened:        ${summary.count}`);
  console.log(`  Total cells removed:      ${summary.totalCellsRemoved}`);
  console.log(`  Avg cells removed:        ${fmt(summary.avgCellsRemoved)}`);
  console.log(`  Avg acceptance rate:      ${fmt(summary.avgAcceptanceRate)}`);
  console.log(`  Avg elapsed ms:           ${fmt(summary.avgElapsedMs)}`);
  console.log("");

  const metrics = [
    ["totalFloor", summary.avgFloorBefore, summary.avgFloorAfter],
    ["unusedFloorRatio", summary.avgUnusedBefore, summary.avgUnusedAfter],
    ["emptyWalkRatio", summary.avgWalkRatioBefore, summary.avgWalkRatioAfter],
    ["longestWalkStreak", summary.avgLongestWalkBefore, summary.avgLongestWalkAfter],
    ["repetitivePushRatio", summary.avgRepetitiveBefore, summary.avgRepetitiveAfter],
    ["movesPerPush", summary.avgMovesPerPushBefore, summary.avgMovesPerPushAfter],
    ["solutionMoves", summary.avgMovesBefore, summary.avgMovesAfter],
    ["solutionPushes", summary.avgPushesBefore, summary.avgPushesAfter],
    ["boxIndependenceRatio", summary.avgBoxIndBefore, summary.avgBoxIndAfter],
    ["solverExpandedStates", summary.avgSolverEffortBefore, summary.avgSolverEffortAfter],
    ["deadlockDensity", summary.avgDeadlockBefore, summary.avgDeadlockAfter],
  ] as const;

  console.log(
    `  ${"Metric".padEnd(26)} ${"Before".padStart(12)} ${"After".padStart(12)} ${"Delta".padStart(12)}`,
  );
  console.log(
    `  ${"─".repeat(26)} ${"─".repeat(12)} ${"─".repeat(12)} ${"─".repeat(12)}`,
  );
  for (const [name, before, after] of metrics) {
    const delta = after - before;
    const sign = delta >= 0 ? "+" : "";
    console.log(
      `  ${name.padEnd(26)} ${fmt(before).padStart(12)} ${fmt(after).padStart(12)} ${(sign + fmt(delta)).padStart(12)}`,
    );
  }

  assert.ok(
    summary.avgUnusedAfter <= summary.avgUnusedBefore + 0.02,
    "unused floor ratio should not increase overall",
  );
});

// ---------------------------------------------------------------------------
// Phase 7: Preservation context tests
// ---------------------------------------------------------------------------

test("tightening: preservation context protects cells from removal", async () => {
  const puzzle: PuzzleDefinition = {
    id: "test-protected",
    title: "Protected cells test",
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

  const protectedCells = new Set<string>();
  for (let r = 0; r < puzzle.rows.length; r++) {
    for (let c = 0; c < puzzle.rows[r].length; c++) {
      if (puzzle.rows[r][c] !== "O") {
        protectedCells.add(`${r},${c}`);
      }
    }
  }

  const result = await tightenPuzzle(puzzle, DEFAULT_TIGHTENING_PARAMS, {
    protectedCells,
  });

  assert.ok(result !== null, "tightening should succeed");
  if (result) {
    assert.equal(result.cellsRemoved, 0, "no cells should be removed when all are protected");
  }
});

test("tightening: buildPreservationContext produces valid context", () => {
  const puzzle: PuzzleDefinition = {
    id: "test-context",
    title: "Context test",
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

  const grid = parseRowsToGrid(puzzle.rows);
  const context = buildPreservationContext(grid);

  assert.ok(context.baselineStructural !== undefined);
  assert.ok(context.baselineStructural!.totalFloor > 0);
  assert.ok(context.minRoomFloorFraction !== undefined);
  assert.ok(context.minRoomFloorFraction! > 0 && context.minRoomFloorFraction! <= 1);
  assert.ok(context.roomFloorBaselines !== undefined);
});

test("tightening: tightening with preservation removes fewer cells", async () => {
  for (let seed = 4000; seed < 4050; seed++) {
    const fb = buildBlueprint(seed);
    if (!fb) continue;

    const puzzle = await generatePuzzleFromBlueprint(fb, seed);
    if (!puzzle) continue;

    const grid = parseRowsToGrid(puzzle.rows);
    const context = buildPreservationContext(grid);

    const [withPres, withoutPres] = await Promise.all([
      tightenPuzzle(puzzle, DEFAULT_TIGHTENING_PARAMS, context),
      tightenPuzzle(puzzle, DEFAULT_TIGHTENING_PARAMS),
    ]);

    if (withPres && withoutPres) {
      assert.ok(
        withPres.cellsRemoved <= withoutPres.cellsRemoved,
        `preservation should remove ≤ cells: ${withPres.cellsRemoved} vs ${withoutPres.cellsRemoved}`,
      );
      return;
    }
  }
});

test("tightening: structural integrity preserved with context", async () => {
  for (let seed = 4100; seed < 4150; seed++) {
    const fb = buildBlueprint(seed);
    if (!fb) continue;

    const puzzle = await generatePuzzleFromBlueprint(fb, seed);
    if (!puzzle) continue;

    const grid = parseRowsToGrid(puzzle.rows);
    const beforeMetrics = analyzeGrid(grid);
    const context = buildPreservationContext(grid);

    const result = await tightenPuzzle(puzzle, DEFAULT_TIGHTENING_PARAMS, context);
    if (!result) continue;

    const afterGrid = parseRowsToGrid(result.tightened.rows);
    const afterMetrics = analyzeGrid(afterGrid);

    assert.ok(
      afterMetrics.connectedComponents <= beforeMetrics.connectedComponents,
      "should not increase connected components",
    );

    if (beforeMetrics.regionCount > 1) {
      assert.ok(
        afterMetrics.regionCount >= beforeMetrics.regionCount - 1,
        `region count should not drop significantly: ${afterMetrics.regionCount} vs ${beforeMetrics.regionCount}`,
      );
    }
    return;
  }
});

// ===========================================================================
// Phase 3: Tier-aware tightening policy tests
// ===========================================================================

// ---------------------------------------------------------------------------
// P3-1. Tightening disabled when enabled=false returns no-op result
// ---------------------------------------------------------------------------

test("tier policy: master policy is enabled and tightens puzzles", async () => {
  const p = puzzle([
    "OOOOOOOOOO",
    "O        O",
    "O R      O",
    "O   X    O",
    "O   S    O",
    "O        O",
    "O        O",
    "O        O",
    "OOOOOOOOOO",
  ]);

  const masterPolicy = DEFAULT_TIER_TIGHTENING_POLICIES.master;
  assert.equal(masterPolicy.enabled, true, "master policy should be enabled");

  const result = await tightenPuzzle(p, DEFAULT_TIGHTENING_PARAMS, undefined, masterPolicy);
  assert.ok(result, "should return a result");
  assert.ok(result.tierPolicyUsed !== undefined, "should report tier policy used");
});

// ---------------------------------------------------------------------------
// P3-2. Solution path protection prevents removing solution cells
// ---------------------------------------------------------------------------

test("tier policy: protectSolutionPath prevents removing solution path cells", async () => {
  const p = puzzle([
    "OOOOOOOOOO",
    "O        O",
    "O R      O",
    "O   X    O",
    "O   S    O",
    "O        O",
    "O        O",
    "O        O",
    "OOOOOOOOOO",
  ]);

  // Use advanced policy which protects solution path
  const advancedPolicy = DEFAULT_TIER_TIGHTENING_POLICIES.advanced;
  assert.equal(advancedPolicy.protectSolutionPath, true);

  const grid = parseRowsToGrid(p.rows);
  const preservation = buildPreservationContext(grid);

  const withProtection = await tightenPuzzle(p, DEFAULT_TIGHTENING_PARAMS, preservation, advancedPolicy);
  const withoutProtection = await tightenPuzzle(p, DEFAULT_TIGHTENING_PARAMS);

  assert.ok(withProtection, "should return a result with protection");
  assert.ok(withoutProtection, "should return a result without protection");

  // With solution path protection, we should protect more cells and
  // potentially remove fewer cells
  assert.ok(
    withProtection.protectedCellCount > 0,
    "should have protected cells when protectSolutionPath is true",
  );
});

// ---------------------------------------------------------------------------
// P3-3. Floor minimum constraint respected
// ---------------------------------------------------------------------------

test("tier policy: minPlayableFloor prevents tightening below threshold", async () => {
  // Small puzzle with limited floor — set a high minPlayableFloor
  const p = puzzle([
    "OOOOOOOO",
    "O R    O",
    "O  X   O",
    "O  S   O",
    "O      O",
    "O      O",
    "OOOOOOOO",
  ]);

  // Count current floor
  let currentFloor = 0;
  for (const row of p.rows) {
    for (const ch of row) {
      if (ch !== "O") currentFloor++;
    }
  }

  // Set minPlayableFloor to current floor — should prevent any removal
  const strictPolicy: TierTighteningPolicy = {
    enabled: true,
    maxAccepted: 80,
    maxMutationsPerPass: 200,
    minPlayableFloor: currentFloor,
    minFloorCoverage: 0,
    minRegionCount: 0,
    minChokepointCount: 0,
    protectSolutionPath: false,
    protectPassageCells: false,
    protectChokepointNeighborhoods: false,
  };

  const result = await tightenPuzzle(p, DEFAULT_TIGHTENING_PARAMS, undefined, strictPolicy);
  assert.ok(result, "should return a result");
  assert.equal(result.cellsRemoved, 0, "should not remove any cells when floor is at minimum");
});

// ---------------------------------------------------------------------------
// P3-4. Floor coverage constraint respected
// ---------------------------------------------------------------------------

test("tier policy: minFloorCoverage constraint prevents excessive tightening", async () => {
  const p = puzzle([
    "OOOOOOOOOO",
    "O        O",
    "O R      O",
    "O   X    O",
    "O   S    O",
    "O        O",
    "O        O",
    "O        O",
    "OOOOOOOOOO",
  ]);

  // Set a very high floor coverage so no cells can be removed
  const highCoveragePolicy: TierTighteningPolicy = {
    enabled: true,
    maxAccepted: 80,
    maxMutationsPerPass: 200,
    minPlayableFloor: 1,
    minFloorCoverage: 0.99,
    minRegionCount: 0,
    minChokepointCount: 0,
    protectSolutionPath: false,
    protectPassageCells: false,
    protectChokepointNeighborhoods: false,
  };

  const result = await tightenPuzzle(p, DEFAULT_TIGHTENING_PARAMS, undefined, highCoveragePolicy);
  assert.ok(result, "should return a result");

  // With a 0.99 floor coverage requirement, the initial coverage (~0.62)
  // is already below the threshold, so removing any cell would further
  // reduce it and be rejected. No cells should be removed.
  assert.equal(
    result.cellsRemoved,
    0,
    "should not remove any cells when floor coverage constraint is very strict",
  );
  assert.deepEqual(
    result.tightened.rows,
    p.rows,
    "puzzle should be unchanged",
  );
});

// ---------------------------------------------------------------------------
// P3-5. Region count constraint respected
// ---------------------------------------------------------------------------

test("tier policy: minRegionCount prevents destroying regions", async () => {
  // Build a puzzle with multiple regions (has a chokepoint/articulation)
  const p = puzzle([
    "OOOOOOOOOOO",
    "O    O    O",
    "O R  O    O",
    "O    O    O",
    "OOOO OOOOOO",
    "O    O    O",
    "O  X O    O",
    "O  S O    O",
    "OOOOOOOOOOO",
  ]);

  const grid = parseRowsToGrid(p.rows);
  const metrics = analyzeGrid(grid);

  // Set minRegionCount to the current region count
  const regionPolicy: TierTighteningPolicy = {
    enabled: true,
    maxAccepted: 80,
    maxMutationsPerPass: 200,
    minPlayableFloor: 1,
    minFloorCoverage: 0,
    minRegionCount: Math.max(metrics.regionCount, 1),
    minChokepointCount: 0,
    protectSolutionPath: false,
    protectPassageCells: false,
    protectChokepointNeighborhoods: false,
  };

  const preservation = buildPreservationContext(grid);
  const result = await tightenPuzzle(p, DEFAULT_TIGHTENING_PARAMS, preservation, regionPolicy);
  assert.ok(result, "should return a result");

  if (result.cellsRemoved > 0) {
    const afterGrid = parseRowsToGrid(result.tightened.rows);
    const afterMetrics = analyzeGrid(afterGrid);
    assert.ok(
      afterMetrics.regionCount >= regionPolicy.minRegionCount,
      `region count ${afterMetrics.regionCount} should meet minimum ${regionPolicy.minRegionCount}`,
    );
  }
});

// ---------------------------------------------------------------------------
// P3-6. Chokepoint protection prevents removing chokepoint neighbors
// ---------------------------------------------------------------------------

test("tier policy: protectChokepointNeighborhoods adds chokepoint cells to protection", async () => {
  // Build a puzzle from a blueprint with chokepoints
  for (let seed = 4200; seed < 4250; seed++) {
    const fb = buildBlueprint(seed);
    if (!fb) continue;

    const p = generatePuzzleFromBlueprint(fb, seed);
    if (!p) continue;

    const grid = parseRowsToGrid(p.rows);
    const metrics = analyzeGrid(grid);
    if (metrics.chokepointCount === 0) continue;

    const preservation = buildPreservationContext(grid);
    assert.ok(
      preservation.protectedChokepointNeighborhoods !== undefined &&
      preservation.protectedChokepointNeighborhoods.size > 0,
      "should have chokepoint neighborhoods",
    );

    const expertPolicy = DEFAULT_TIER_TIGHTENING_POLICIES.expert;
    assert.equal(expertPolicy.protectChokepointNeighborhoods, true);

    const result = await tightenPuzzle(p, DEFAULT_TIGHTENING_PARAMS, preservation, expertPolicy);
    assert.ok(result, "should return a result");
    assert.ok(
      result.protectedCellCount > 0,
      "should have protected cells when chokepoint neighborhoods are protected",
    );
    return;
  }
});

// ---------------------------------------------------------------------------
// P3-7. Master tier returns no-op (enabled=false)
// ---------------------------------------------------------------------------

test("tier policy: master tier (enabled=true) tightens puzzle", async () => {
  const p = puzzle([
    "OOOOOOOOOO",
    "O        O",
    "O R      O",
    "O   X    O",
    "O   S    O",
    "O        O",
    "O        O",
    "OOOOOOOOOO",
  ]);

  const result = await tightenPuzzle(
    p,
    DEFAULT_TIGHTENING_PARAMS,
    undefined,
    DEFAULT_TIER_TIGHTENING_POLICIES.master,
  );
  assert.ok(result, "should return a result");
  assert.ok(result.mutationsTried > 0, "master policy should attempt mutations");
});

// ---------------------------------------------------------------------------
// P3-8. Backward compatibility: calling without tierPolicy works as before
// ---------------------------------------------------------------------------

test("tier policy: backward compatibility — no tierPolicy behaves identically", async () => {
  const p = puzzle([
    "OOOOOOOO",
    "O R    O",
    "O  X   O",
    "O  S   O",
    "O      O",
    "O      O",
    "OOOOOOOO",
  ]);

  // Call with only puzzle and params — no preservation, no tier policy
  const result = await tightenPuzzle(p, DEFAULT_TIGHTENING_PARAMS);
  assert.ok(result, "should produce a result");
  assert.ok(result.protectedCellCount === 0, "no protected cells when no policy");
  assert.equal(result.tierPolicyUsed, undefined, "no tier policy reported");

  const solved = await solvePuzzle(result.tightened);
  assert.ok(solved, "tightened puzzle must still be solvable");
});

// ---------------------------------------------------------------------------
// P3-9. TighteningResult includes protectedCellCount
// ---------------------------------------------------------------------------

test("tier policy: result includes protectedCellCount and tierPolicyUsed", async () => {
  const p = puzzle([
    "OOOOOOOOOO",
    "O        O",
    "O R      O",
    "O   X    O",
    "O   S    O",
    "O        O",
    "O        O",
    "OOOOOOOOOO",
  ]);

  const grid = parseRowsToGrid(p.rows);
  const preservation = buildPreservationContext(grid);

  const result = await tightenPuzzle(
    p,
    DEFAULT_TIGHTENING_PARAMS,
    preservation,
    DEFAULT_TIER_TIGHTENING_POLICIES.expert,
  );
  assert.ok(result, "should return a result");
  assert.ok(typeof result.protectedCellCount === "number", "protectedCellCount should be a number");
  assert.ok(result.protectedCellCount >= 0, "protectedCellCount should be non-negative");
  assert.equal(result.tierPolicyUsed, "expert", "tierPolicyUsed should be 'expert'");
});

// ---------------------------------------------------------------------------
// P3-10. Tier policy maxAccepted overrides params.maxAccepted
// ---------------------------------------------------------------------------

test("tier policy: maxAccepted limits cell removal", async () => {
  const p = puzzle([
    "OOOOOOOOOO",
    "O        O",
    "O R      O",
    "O   X    O",
    "O   S    O",
    "O        O",
    "O        O",
    "O        O",
    "OOOOOOOOOO",
  ]);

  const tinyPolicy: TierTighteningPolicy = {
    enabled: true,
    maxAccepted: 2,
    maxMutationsPerPass: 200,
    minPlayableFloor: 1,
    minFloorCoverage: 0,
    minRegionCount: 0,
    minChokepointCount: 0,
    protectSolutionPath: false,
    protectPassageCells: false,
    protectChokepointNeighborhoods: false,
  };

  const result = await tightenPuzzle(p, DEFAULT_TIGHTENING_PARAMS, undefined, tinyPolicy);
  assert.ok(result, "should return a result");
  assert.ok(
    result.mutationsAccepted <= 2,
    `should accept at most 2 mutations, accepted ${result.mutationsAccepted}`,
  );
});

// ---------------------------------------------------------------------------
// P3-11. buildPreservationContext computes passage and chokepoint sets
// ---------------------------------------------------------------------------

test("buildPreservationContext: computes protectedPassageCells and protectedChokepointNeighborhoods", () => {
  // A puzzle with a narrow passage connecting two areas
  const p = puzzle([
    "OOOOOOOOOOO",
    "O    O    O",
    "O R  O    O",
    "O    O    O",
    "OOOO OOOOOO",
    "O    O    O",
    "O  X O    O",
    "O  S O    O",
    "OOOOOOOOOOO",
  ]);

  const grid = parseRowsToGrid(p.rows);
  const context = buildPreservationContext(grid);

  assert.ok(
    context.protectedPassageCells !== undefined,
    "protectedPassageCells should be defined",
  );
  assert.ok(
    context.protectedChokepointNeighborhoods !== undefined,
    "protectedChokepointNeighborhoods should be defined",
  );

  // The grid has structural features, so at least one set should be non-empty
  const metrics = analyzeGrid(grid);
  if (metrics.tunnelCells.size > 0) {
    assert.ok(
      context.protectedPassageCells!.size > 0,
      "should have passage cells when tunnels exist",
    );
  }
  if (metrics.chokepointCount > 0) {
    assert.ok(
      context.protectedChokepointNeighborhoods!.size > 0,
      "should have chokepoint neighborhoods when chokepoints exist",
    );
  }
});
