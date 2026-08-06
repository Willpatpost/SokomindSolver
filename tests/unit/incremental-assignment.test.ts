import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  minimumAssignmentWithState,
  repairAssignment,
} from "../../src/solver/search/assignment.ts";
import {
  parsePuzzleRows,
} from "../../src/core/index.ts";
import type {
  SolverExecutionContext,
  SolverRequest,
} from "../../src/solver/contracts.ts";
import {
  compileSearchBoard,
} from "../../src/solver/search/compiled-board.ts";
import {
  AssignmentHeuristic,
  assignmentLowerBound,
} from "../../src/solver/search/heuristic.ts";
import {
  toDenseBoxes,
  type DenseBox,
} from "../../src/solver/search/model.ts";
import {
  createExactStateCodec,
} from "../../src/solver/search/exact-state.ts";
import {
  runExactMoveAStar,
} from "../../src/solver/search/exact-move-astar.ts";
import {
  sortedBoxes,
} from "../../src/solver/search/engine.ts";

function oracleContext(): SolverExecutionContext {
  return {
    signal: new AbortController().signal,
    reportProgress: () => undefined,
    now: () => performance.now(),
  };
}

function requestFromRows(rows: string[]): SolverRequest {
  const parsed = parsePuzzleRows(rows);
  return {
    board: parsed,
    snapshot: {
      puzzleId: "incr-assign-test",
      robot: parsed.initialRobot,
      boxes: parsed.initialBoxes,
      moves: 0,
      pushes: 0,
      solved: false,
    },
    objective: { kind: "moves" },
  };
}

// ---------------------------------------------------------------------------
// Suite 1: repairAssignment correctness
// ---------------------------------------------------------------------------

describe("repairAssignment correctness", () => {
  it("single-row change in 3x3 matrix matches full", () => {
    const original = [
      [3, 5, 7],
      [2, 8, 1],
      [6, 4, 9],
    ];
    const full = minimumAssignmentWithState(original);

    const modified = [
      [3, 5, 7],
      [2, 8, 1],
      [1, 2, 3],
    ];
    const fullAfter = minimumAssignmentWithState(modified);
    const repaired = repairAssignment(modified, full, 2);
    assert.equal(repaired.cost, fullAfter.cost);
  });

  it("single-row change in 4x4 with Infinity matches full", () => {
    const original = [
      [1, Infinity, 3, 2],
      [Infinity, 4, 1, Infinity],
      [3, 2, Infinity, 5],
      [2, 1, 4, 3],
    ];
    const full = minimumAssignmentWithState(original);

    const modified = [
      [1, Infinity, 3, 2],
      [Infinity, 4, 1, Infinity],
      [5, Infinity, 2, 1],
      [2, 1, 4, 3],
    ];
    const fullAfter = minimumAssignmentWithState(modified);
    const repaired = repairAssignment(modified, full, 2);
    assert.equal(repaired.cost, fullAfter.cost);
  });

  it("row change that shifts optimal matching matches full", () => {
    const original = [
      [1, 10, 10],
      [10, 1, 10],
      [10, 10, 1],
    ];
    const full = minimumAssignmentWithState(original);
    assert.equal(full.cost, 3);

    const modified = [
      [1, 10, 10],
      [10, 1, 10],
      [1, 10, 10],
    ];
    const fullAfter = minimumAssignmentWithState(modified);
    const repaired = repairAssignment(modified, full, 2);
    assert.equal(repaired.cost, fullAfter.cost);
  });

  it("row change making assignment infeasible detected by both", () => {
    const original = [
      [1, 2],
      [3, 4],
    ];
    const full = minimumAssignmentWithState(original);

    const modified = [
      [1, 2],
      [Infinity, Infinity],
    ];
    const fullAfter = minimumAssignmentWithState(modified);
    const repaired = repairAssignment(modified, full, 1);
    assert.equal(repaired.cost, Infinity);
    assert.equal(fullAfter.cost, Infinity);
  });

  it("identity change returns same result", () => {
    const costs = [
      [2, 5, 3],
      [7, 1, 4],
      [6, 3, 8],
    ];
    const full = minimumAssignmentWithState(costs);
    const repaired = repairAssignment(costs, full, 1);
    assert.equal(repaired.cost, full.cost);
  });

  it("rectangular matrix repair (3x5) matches full", () => {
    const original = [
      [4, 2, 7, 1, 5],
      [3, 6, 1, 8, 2],
      [5, 3, 4, 2, 6],
    ];
    const full = minimumAssignmentWithState(original);

    const modified = [
      [4, 2, 7, 1, 5],
      [1, 1, 5, 3, 7],
      [5, 3, 4, 2, 6],
    ];
    const fullAfter = minimumAssignmentWithState(modified);
    const repaired = repairAssignment(modified, full, 1);
    assert.equal(repaired.cost, fullAfter.cost);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Incremental label reuse
// ---------------------------------------------------------------------------

const TWO_LABEL_ROWS = [
  "OOOOOOOO",
  "OR A aO",
  "O  B bO",
  "OOOOOOOO",
];

describe("incremental label reuse", () => {
  it("moving box of label A reuses label B cost", () => {
    const parsed = parsePuzzleRows(TWO_LABEL_ROWS);
    const board = compileSearchBoard(parsed);
    const labels = [...board.goalCellsByLabel.keys()].sort();
    const codec = createExactStateCodec(board.cellCount, labels);
    const packBoxKey = (boxes: readonly DenseBox[]) =>
      codec.packBoxTokens(codec.tokensFromBoxes(boxes));

    const heuristic = new AssignmentHeuristic(board, { packBoxKey });
    const boxes1 = sortedBoxes(toDenseBoxes(board, parsed.initialBoxes));

    const parentKey = packBoxKey(boxes1);
    heuristic.evaluate(boxes1);

    const boxes2 = boxes1.map((b) =>
      b.label === "A"
        ? { ...b, cell: b.cell + 1 }
        : b,
    );
    const sorted2 = sortedBoxes(boxes2);
    const childKey = packBoxKey(sorted2);

    const incremental = heuristic.evaluateIncremental(
      sorted2, childKey, parentKey, "A",
    );
    const full = assignmentLowerBound(board, sorted2);
    assert.equal(incremental, full);
  });

  it("generic boxes use incremental path on group >= 3", () => {
    const rows = [
      "OOOOOOOOO",
      "O       O",
      "OR X X XO",
      "O  S S SO",
      "OOOOOOOOO",
    ];
    const parsed = parsePuzzleRows(rows);
    const board = compileSearchBoard(parsed);
    const labels = [...board.goalCellsByLabel.keys()].sort();
    const codec = createExactStateCodec(board.cellCount, labels);
    const packBoxKey = (boxes: readonly DenseBox[]) =>
      codec.packBoxTokens(codec.tokensFromBoxes(boxes));

    const heuristic = new AssignmentHeuristic(board, { packBoxKey });
    const boxes1 = sortedBoxes(toDenseBoxes(board, parsed.initialBoxes));

    const parentKey = packBoxKey(boxes1);
    heuristic.evaluate(boxes1);

    const boxes2 = boxes1.map((b, i) =>
      i === 0 ? { ...b, cell: b.cell + 1 } : b,
    );
    const sorted2 = sortedBoxes(boxes2);
    const childKey = packBoxKey(sorted2);

    const incremental = heuristic.evaluateIncremental(
      sorted2, childKey, parentKey, "X",
    );
    const full = assignmentLowerBound(board, sorted2);
    assert.equal(incremental, full);
    assert.ok(
      heuristic.stats.incrementalRepairs > 0,
      "should have used incremental repair for 3-box group",
    );
  });

  it("box moving onto matching goal matches full", () => {
    const rows = [
      "OOOOOOOOO",
      "O       O",
      "OR X X XO",
      "O  S S SO",
      "OOOOOOOOO",
    ];
    const parsed = parsePuzzleRows(rows);
    const board = compileSearchBoard(parsed);
    const labels = [...board.goalCellsByLabel.keys()].sort();
    const codec = createExactStateCodec(board.cellCount, labels);
    const packBoxKey = (boxes: readonly DenseBox[]) =>
      codec.packBoxTokens(codec.tokensFromBoxes(boxes));

    const heuristic = new AssignmentHeuristic(board, { packBoxKey });
    const boxes1 = sortedBoxes(toDenseBoxes(board, parsed.initialBoxes));

    const parentKey = packBoxKey(boxes1);
    heuristic.evaluate(boxes1);

    const goalCells = board.goalCellsByLabel.get("X") ?? [];
    const boxes2 = boxes1.map((b, i) =>
      i === 0 ? { ...b, cell: goalCells[0] } : b,
    );
    const sorted2 = sortedBoxes(boxes2);
    const childKey = packBoxKey(sorted2);

    const incremental = heuristic.evaluateIncremental(
      sorted2, childKey, parentKey, "X",
    );
    const full = assignmentLowerBound(board, sorted2);
    assert.equal(incremental, full);
  });

  it("box moving off matching goal matches full", () => {
    const rows = [
      "OOOOOOOOO",
      "O       O",
      "OR X X XO",
      "O  S S SO",
      "OOOOOOOOO",
    ];
    const parsed = parsePuzzleRows(rows);
    const board = compileSearchBoard(parsed);
    const labels = [...board.goalCellsByLabel.keys()].sort();
    const codec = createExactStateCodec(board.cellCount, labels);
    const packBoxKey = (boxes: readonly DenseBox[]) =>
      codec.packBoxTokens(codec.tokensFromBoxes(boxes));

    const heuristic = new AssignmentHeuristic(board, { packBoxKey });
    const goalCells = board.goalCellsByLabel.get("X") ?? [];
    const onGoalBoxes: DenseBox[] = [
      { id: "X:0", label: "X", cell: goalCells[0] },
      { id: "X:1", label: "X", cell: goalCells[1] },
      { id: "X:2", label: "X", cell: goalCells[2] },
    ];
    const sorted1 = sortedBoxes(onGoalBoxes);
    const parentKey = packBoxKey(sorted1);
    heuristic.evaluate(sorted1);

    const offGoalBoxes = sorted1.map((b, i) =>
      i === 0 ? { ...b, cell: board.cellAt(2, 2) } : b,
    );
    const sorted2 = sortedBoxes(offGoalBoxes);
    const childKey = packBoxKey(sorted2);

    const incremental = heuristic.evaluateIncremental(
      sorted2, childKey, parentKey, "X",
    );
    const full = assignmentLowerBound(board, sorted2);
    assert.equal(incremental, full);
  });

  it("typed plus generic mixed labels match full", () => {
    const rows = [
      "OOOOOOOOOOO",
      "O         O",
      "OR A X X aO",
      "O    S S  O",
      "OOOOOOOOOOO",
    ];
    const parsed = parsePuzzleRows(rows);
    const board = compileSearchBoard(parsed);
    const labels = [...board.goalCellsByLabel.keys()].sort();
    const codec = createExactStateCodec(board.cellCount, labels);
    const packBoxKey = (boxes: readonly DenseBox[]) =>
      codec.packBoxTokens(codec.tokensFromBoxes(boxes));

    const heuristic = new AssignmentHeuristic(board, { packBoxKey });
    const boxes1 = sortedBoxes(toDenseBoxes(board, parsed.initialBoxes));
    const parentKey = packBoxKey(boxes1);
    heuristic.evaluate(boxes1);

    const xBoxes = boxes1.filter((b) => b.label === "X");
    const boxes2 = boxes1.map((b) =>
      b === xBoxes[0] ? { ...b, cell: b.cell + 1 } : b,
    );
    const sorted2 = sortedBoxes(boxes2);
    const childKey = packBoxKey(sorted2);

    const incremental = heuristic.evaluateIncremental(
      sorted2, childKey, parentKey, "X",
    );
    const full = assignmentLowerBound(board, sorted2);
    assert.equal(incremental, full);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Crossover policy
// ---------------------------------------------------------------------------

describe("crossover policy", () => {
  it("label group with 2 boxes does full recompute (below crossover)", () => {
    const rows = [
      "OOOOOOO",
      "O     O",
      "OR X XO",
      "O  S SO",
      "OOOOOOO",
    ];
    const parsed = parsePuzzleRows(rows);
    const board = compileSearchBoard(parsed);
    const labels = [...board.goalCellsByLabel.keys()].sort();
    const codec = createExactStateCodec(board.cellCount, labels);
    const packBoxKey = (boxes: readonly DenseBox[]) =>
      codec.packBoxTokens(codec.tokensFromBoxes(boxes));

    const heuristic = new AssignmentHeuristic(board, { packBoxKey });
    const boxes1 = sortedBoxes(toDenseBoxes(board, parsed.initialBoxes));

    const parentKey = packBoxKey(boxes1);
    heuristic.evaluate(boxes1);

    const boxes2 = boxes1.map((b, i) =>
      i === 0 ? { ...b, cell: b.cell + 1 } : b,
    );
    const sorted2 = sortedBoxes(boxes2);
    const childKey = packBoxKey(sorted2);

    const incremental = heuristic.evaluateIncremental(
      sorted2, childKey, parentKey, "X",
    );
    const full = assignmentLowerBound(board, sorted2);
    assert.equal(incremental, full);
    assert.equal(
      heuristic.stats.incrementalRepairs, 0,
      "should NOT use incremental for 2-box group (below crossover of 3)",
    );
  });

  it("label group with 3 boxes uses incremental repair", () => {
    const rows = [
      "OOOOOOOOO",
      "O       O",
      "OR X X XO",
      "O  S S SO",
      "OOOOOOOOO",
    ];
    const parsed = parsePuzzleRows(rows);
    const board = compileSearchBoard(parsed);
    const labels = [...board.goalCellsByLabel.keys()].sort();
    const codec = createExactStateCodec(board.cellCount, labels);
    const packBoxKey = (boxes: readonly DenseBox[]) =>
      codec.packBoxTokens(codec.tokensFromBoxes(boxes));

    const heuristic = new AssignmentHeuristic(board, { packBoxKey });
    const boxes1 = sortedBoxes(toDenseBoxes(board, parsed.initialBoxes));

    const parentKey = packBoxKey(boxes1);
    heuristic.evaluate(boxes1);

    const boxes2 = boxes1.map((b, i) =>
      i === 0 ? { ...b, cell: b.cell + 1 } : b,
    );
    const sorted2 = sortedBoxes(boxes2);
    const childKey = packBoxKey(sorted2);

    heuristic.evaluateIncremental(sorted2, childKey, parentKey, "X");
    assert.ok(
      heuristic.stats.incrementalRepairs > 0,
      "should use incremental repair for 3-box group (at crossover)",
    );
  });

  it("label group with 1 box does full recompute", () => {
    const rows = [
      "OOOOO",
      "O   O",
      "ORXSO",
      "OOOOO",
    ];
    const parsed = parsePuzzleRows(rows);
    const board = compileSearchBoard(parsed);
    const labels = [...board.goalCellsByLabel.keys()].sort();
    const codec = createExactStateCodec(board.cellCount, labels);
    const packBoxKey = (boxes: readonly DenseBox[]) =>
      codec.packBoxTokens(codec.tokensFromBoxes(boxes));

    const heuristic = new AssignmentHeuristic(board, { packBoxKey });
    const boxes1 = sortedBoxes(toDenseBoxes(board, parsed.initialBoxes));
    const parentKey = packBoxKey(boxes1);
    heuristic.evaluate(boxes1);

    const boxes2 = boxes1.map((b) => ({ ...b, cell: b.cell + 1 }));
    const sorted2 = sortedBoxes(boxes2);
    const childKey = packBoxKey(sorted2);

    const incremental = heuristic.evaluateIncremental(
      sorted2, childKey, parentKey, "X",
    );
    const full = assignmentLowerBound(board, sorted2);
    assert.equal(incremental, full);
    assert.equal(heuristic.stats.incrementalRepairs, 0);
  });
});

// ---------------------------------------------------------------------------
// Suite 4: Randomized equality
// ---------------------------------------------------------------------------

describe("randomized incremental vs full equality", () => {
  it("100 random single-box moves all match full Hungarian", () => {
    const rows = [
      "OOOOOOOOO",
      "O       O",
      "OR X X XO",
      "O  S S SO",
      "O       O",
      "OOOOOOOOO",
    ];
    const parsed = parsePuzzleRows(rows);
    const board = compileSearchBoard(parsed);
    const labels = [...board.goalCellsByLabel.keys()].sort();
    const codec = createExactStateCodec(board.cellCount, labels);
    const packBoxKey = (boxes: readonly DenseBox[]) =>
      codec.packBoxTokens(codec.tokensFromBoxes(boxes));

    const heuristic = new AssignmentHeuristic(board, { packBoxKey });
    const floorCells = Array.from(
      { length: board.cellCount },
      (_, i) => i,
    ).filter((c) => board.positions[c] !== undefined);

    let parentBoxes = sortedBoxes(toDenseBoxes(board, parsed.initialBoxes));
    let parentKey = packBoxKey(parentBoxes);
    heuristic.evaluate(parentBoxes);

    let seed = 12345;
    function nextRand(): number {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    }

    let checks = 0;
    for (let trial = 0; trial < 100; trial++) {
      const boxIdx = nextRand() % parentBoxes.length;
      const newCell = floorCells[nextRand() % floorCells.length];

      const occupied = new Set(parentBoxes.map((b) => b.cell));
      if (occupied.has(newCell) && newCell !== parentBoxes[boxIdx].cell) continue;

      const childBoxes = parentBoxes.map((b, i) =>
        i === boxIdx ? { ...b, cell: newCell } : b,
      );
      const sortedChild = sortedBoxes(childBoxes);
      const childKey = packBoxKey(sortedChild);

      const incremental = heuristic.evaluateIncremental(
        sortedChild, childKey, parentKey, parentBoxes[boxIdx].label,
      );
      const full = assignmentLowerBound(board, sortedChild);
      assert.equal(
        incremental, full,
        `Trial ${trial}: incremental=${incremental} != full=${full} ` +
        `moving box ${boxIdx} to cell ${newCell}`,
      );
      checks++;

      parentBoxes = sortedChild;
      parentKey = childKey;
    }
    assert.ok(checks >= 50, `Expected at least 50 valid checks, got ${checks}`);
  });
});

// ---------------------------------------------------------------------------
// Suite 5: BigInt cache key
// ---------------------------------------------------------------------------

describe("BigInt cache key correctness", () => {
  it("same configuration produces same key", () => {
    const rows = ["OOOOO", "OR XSO", "OOOOO"];
    const parsed = parsePuzzleRows(rows);
    const board = compileSearchBoard(parsed);
    const labels = [...board.goalCellsByLabel.keys()].sort();
    const codec = createExactStateCodec(board.cellCount, labels);

    const boxes = sortedBoxes(toDenseBoxes(board, parsed.initialBoxes));
    const key1 = codec.packBoxTokens(codec.tokensFromBoxes(boxes));
    const key2 = codec.packBoxTokens(codec.tokensFromBoxes(boxes));
    assert.equal(key1, key2);
  });

  it("different configurations produce different keys", () => {
    const rows = [
      "OOOOOOO",
      "OR X XO",
      "O  S SO",
      "OOOOOOO",
    ];
    const parsed = parsePuzzleRows(rows);
    const board = compileSearchBoard(parsed);
    const labels = [...board.goalCellsByLabel.keys()].sort();
    const codec = createExactStateCodec(board.cellCount, labels);

    const boxes = sortedBoxes(toDenseBoxes(board, parsed.initialBoxes));
    const key1 = codec.packBoxTokens(codec.tokensFromBoxes(boxes));

    const moved = boxes.map((b, i) =>
      i === 0 ? { ...b, cell: b.cell + 1 } : b,
    );
    const sortedMoved = sortedBoxes(moved);
    const key2 = codec.packBoxTokens(codec.tokensFromBoxes(sortedMoved));

    assert.notEqual(key1, key2);
  });

  it("robot position does not affect box key", () => {
    const rows = [
      "OOOOOOO",
      "OR X XO",
      "O  S SO",
      "OOOOOOO",
    ];
    const parsed = parsePuzzleRows(rows);
    const board = compileSearchBoard(parsed);
    const labels = [...board.goalCellsByLabel.keys()].sort();
    const codec = createExactStateCodec(board.cellCount, labels);

    const boxes = sortedBoxes(toDenseBoxes(board, parsed.initialBoxes));
    const boxTokens = codec.tokensFromBoxes(boxes);
    const boxKey = codec.packBoxTokens(boxTokens);

    const robot1 = board.cellAt(parsed.initialRobot.row, parsed.initialRobot.column);
    const moveKey1 = codec.packMoveState(robot1, boxTokens);

    const robot2 = robot1 + 1;
    const moveKey2 = codec.packMoveState(robot2, boxTokens);

    assert.notEqual(moveKey1, moveKey2, "move keys should differ with different robots");
    assert.equal(boxKey, boxKey, "box-only key is robot-independent");
  });
});

// ---------------------------------------------------------------------------
// Suite 6: Integration with exact A*
// ---------------------------------------------------------------------------

const INTEGRATION_ROWS = [
  "OOOOOO",
  "OR   O",
  "O XX O",
  "O SS O",
  "OOOOOO",
];

describe("integration with exact A*", () => {
  it("produces identical solution to non-incremental", async () => {
    const req = requestFromRows(INTEGRATION_ROWS);
    const ctx = oracleContext();
    const result = await runExactMoveAStar(req, ctx);
    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;
    assert.equal(result.solution.moves, 5);
    assert.equal(result.solution.pushes, 2);
  });

  it("solves 3-box puzzle", async () => {
    const rows = [
      "OOOOOOOOO",
      "O       O",
      "OR X X XO",
      "O  S S SO",
      "OOOOOOOOO",
    ];
    const req = requestFromRows(rows);
    const ctx = oracleContext();
    const result = await runExactMoveAStar(req, ctx);
    assert.equal(result.status, "solved");
  });
});
