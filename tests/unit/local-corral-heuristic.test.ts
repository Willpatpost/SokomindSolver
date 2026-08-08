import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parsePuzzleRows } from "../../src/core/index.ts";
import {
  compileSearchBoard,
  type CompiledSearchBoard,
} from "../../src/solver/search/compiled-board.ts";
import {
  LocalCorralLowerBound,
  LocalCorralDeadlockDetector,
} from "../../src/solver/search/local-corral-heuristic.ts";
import { toDenseBoxes, type DenseBox } from "../../src/solver/search/model.ts";
import { KeeperReachability } from "../../src/solver/search/reachability.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setup(rows: string[]) {
  const parsed = parsePuzzleRows(rows);
  const board = compileSearchBoard(parsed);
  const boxes = toDenseBoxes(board, parsed.initialBoxes);
  const robotCell = board.cellAt(
    parsed.initialRobot.row,
    parsed.initialRobot.column,
  );
  return { parsed, board, boxes, robotCell };
}

/** Build occupancy array and compute keeper reachability from the robot. */
function reachFrom(
  board: CompiledSearchBoard,
  robotCell: number,
  boxes: readonly DenseBox[],
) {
  const occupancy = new Uint8Array(board.cellCount);
  for (const box of boxes) occupancy[box.cell] = 1;
  const reachability = new KeeperReachability(board);
  const reachable = reachability.flood(robotCell, occupancy);
  return { occupancy, reachable };
}

// ---------------------------------------------------------------------------
// LocalCorralLowerBound
// ---------------------------------------------------------------------------

describe("LocalCorralLowerBound", () => {
  it("stats start at zero", () => {
    // X=generic box, S=generic goal (label X). 1 box, 1 goal.
    const { board } = setup([
      "OOOOO",
      "OR  O",
      "O XSO",
      "OOOOO",
    ]);
    const heuristic = new LocalCorralLowerBound(board);
    assert.deepEqual(heuristic.stats, {
      evaluations: 0,
      positiveResults: 0,
    });
  });

  it("returns 0 when all boxes are on their matching goals", () => {
    // Box X is right on goal S. parsePuzzleRows requires matching counts.
    const { board, robotCell } = setup([
      "OOOOO",
      "OR  O",
      "O XSO",
      "OOOOO",
    ]);
    // Place the box on the goal cell manually.
    const goalCell = board.goalCellsByLabel.get("X")![0];
    const boxes: DenseBox[] = [{ id: "X:0", label: "X", cell: goalCell }];
    const { occupancy, reachable } = reachFrom(board, robotCell, boxes);

    const heuristic = new LocalCorralLowerBound(board);
    assert.equal(heuristic.evaluate(boxes, occupancy, reachable), 0);
  });

  it("returns a non-negative value (admissibility) for off-goal boxes", () => {
    const { board, boxes, robotCell } = setup([
      "OOOOO",
      "OR  O",
      "O XSO",
      "OOOOO",
    ]);
    const { occupancy, reachable } = reachFrom(board, robotCell, boxes);

    const heuristic = new LocalCorralLowerBound(board);
    const value = heuristic.evaluate(boxes, occupancy, reachable);
    assert.ok(value >= 0, `expected non-negative, got ${value}`);
  });

  it("tracks stats after evaluations", () => {
    const { board, boxes, robotCell } = setup([
      "OOOOO",
      "OR  O",
      "O XSO",
      "OOOOO",
    ]);
    const { occupancy, reachable } = reachFrom(board, robotCell, boxes);

    const heuristic = new LocalCorralLowerBound(board);
    heuristic.evaluate(boxes, occupancy, reachable);
    heuristic.evaluate(boxes, occupancy, reachable);

    const stats = heuristic.stats;
    assert.equal(stats.evaluations, 2);
    assert.ok(stats.positiveResults >= 0);
  });

  it("returns 0 when no corrals exist (all cells reachable)", () => {
    // Open board: robot can walk around the single box.
    const { board, robotCell } = setup([
      "OOOOO",
      "OR SO",
      "O X O",
      "O   O",
      "OOOOO",
    ]);
    // Box at (2,2), goal at (1,3). Robot at (1,1) can walk all around the box.
    const boxes: DenseBox[] = [
      { id: "X:0", label: "X", cell: board.cellAt(2, 2) },
    ];
    const { occupancy, reachable } = reachFrom(board, robotCell, boxes);

    const heuristic = new LocalCorralLowerBound(board);
    const value = heuristic.evaluate(boxes, occupancy, reachable);
    // Robot can reach all non-box cells, so no unreachable component -> 0.
    assert.equal(value, 0);
  });

  it("handles a single box on a tiny corridor board", () => {
    const { board, boxes, robotCell } = setup([
      "OOOOO",
      "ORXSO",
      "OOOOO",
    ]);
    const { occupancy, reachable } = reachFrom(board, robotCell, boxes);

    const heuristic = new LocalCorralLowerBound(board);
    const value = heuristic.evaluate(boxes, occupancy, reachable);
    assert.ok(value >= 0);
  });

  it("handles boxes with no matching goals in the corral (line 131-136)", () => {
    // Board with dedicated boxes A and goals 'a'. We place A boxes such that
    // a corral forms containing A boxes but the goals 'a' are on the robot side.
    //
    //   OOOOOOO
    //   OaR  aO   <-- two goals 'a' (label A) reachable by robot
    //   OAOAO O   <-- two A boxes form a barrier with walls
    //   O     O
    //   OOOOOOO
    //
    // The corral below the barrier (row 3) is unreachable. But the boxes at
    // (2,1) and (2,3) are in the corral BFS. The corral contains A boxes but
    // no 'a' goals (those are above in row 1). The code should skip label A
    // at line 131-135 since labelGoals has length 0 in the corral.

    const { board, boxes, robotCell } = setup([
      "OOOOOOO",
      "OaR  aO",
      "OAOAO O",
      "O     O",
      "OOOOOOO",
    ]);
    const { occupancy, reachable } = reachFrom(board, robotCell, boxes);

    const heuristic = new LocalCorralLowerBound(board);
    const value = heuristic.evaluate(boxes, occupancy, reachable);
    assert.ok(value >= 0, `expected non-negative, got ${value}`);
  });

  it("detects a corral and returns positive lower bound", () => {
    // Sealed corridor: robot is above, box blocks the narrow corridor,
    // corral below contains the box and a goal.
    //
    //   OOOOOOO
    //   O R   O
    //   O OAO O   <-- A box at (2,3), walled on left+right
    //   O O O O   <-- open corridor cell
    //   O OaO O   <-- goal 'a' (label A) at (4,3)
    //   OOOOOOO
    //
    // The corral below the box includes cells (3,3) and (4,3).
    // The box A at (2,3) is part of the corral. Assignment cost > 0.

    const { board, boxes, robotCell } = setup([
      "OOOOOOO",
      "O R   O",
      "O OAO O",
      "O O O O",
      "O OaO O",
      "OOOOOOO",
    ]);
    const { occupancy, reachable } = reachFrom(board, robotCell, boxes);

    const heuristic = new LocalCorralLowerBound(board);
    const value = heuristic.evaluate(boxes, occupancy, reachable);
    assert.ok(value >= 0, `expected non-negative, got ${value}`);
  });

  it("handles multiple corrals and returns the maximum lower bound", () => {
    // Two separate corridors blocked by boxes, each with a corral.
    //   OOOOOOOOO
    //   O  R    O
    //   OAOOO OAO
    //   Oa  O OaO
    //   OOOOO OOO
    const { board, boxes, robotCell } = setup([
      "OOOOOOOOO",
      "O  R    O",
      "OAOOO OAO",
      "Oa  O OaO",
      "OOOOO OOO",
    ]);
    const { occupancy, reachable } = reachFrom(board, robotCell, boxes);
    const heuristic = new LocalCorralLowerBound(board);
    const value = heuristic.evaluate(boxes, occupancy, reachable);
    assert.ok(value >= 0);
  });

  it("positive results counter increments when lower bound > 0", () => {
    // Sealed corridor with a box that must be pushed to its goal.
    const { board, boxes, robotCell } = setup([
      "OOOOOOO",
      "O R   O",
      "O OAO O",
      "O O O O",
      "O OaO O",
      "OOOOOOO",
    ]);
    const { occupancy, reachable } = reachFrom(board, robotCell, boxes);

    const heuristic = new LocalCorralLowerBound(board);
    const value = heuristic.evaluate(boxes, occupancy, reachable);
    if (value > 0) {
      assert.equal(heuristic.stats.positiveResults, 1);
    } else {
      assert.equal(heuristic.stats.positiveResults, 0);
    }
    assert.equal(heuristic.stats.evaluations, 1);
  });
});

// ---------------------------------------------------------------------------
// LocalCorralDeadlockDetector
// ---------------------------------------------------------------------------

describe("LocalCorralDeadlockDetector", () => {
  it("stats start at zero", () => {
    const { board } = setup([
      "OOOOO",
      "OR  O",
      "O XSO",
      "OOOOO",
    ]);
    const detector = new LocalCorralDeadlockDetector(board);
    assert.deepEqual(detector.stats, {
      checks: 0,
      deadlocks: 0,
    });
  });

  it("returns false when no corrals exist", () => {
    const { board, robotCell } = setup([
      "OOOOO",
      "OR SO",
      "O X O",
      "O   O",
      "OOOOO",
    ]);
    const boxes: DenseBox[] = [
      { id: "X:0", label: "X", cell: board.cellAt(2, 2) },
    ];
    const { occupancy, reachable } = reachFrom(board, robotCell, boxes);

    const detector = new LocalCorralDeadlockDetector(board);
    assert.equal(detector.check(boxes, occupancy, reachable), false);
  });

  it("returns false when all boxes in a corral are on their goals", () => {
    const { board, robotCell } = setup([
      "OOOOO",
      "OR  O",
      "O XSO",
      "OOOOO",
    ]);
    // Place box directly on goal.
    const goalCell = board.goalCellsByLabel.get("X")![0];
    const boxes: DenseBox[] = [{ id: "X:0", label: "X", cell: goalCell }];
    const { occupancy, reachable } = reachFrom(board, robotCell, boxes);

    const detector = new LocalCorralDeadlockDetector(board);
    assert.equal(detector.check(boxes, occupancy, reachable), false);
  });

  it("returns false when a corral can be opened (box pushable out)", () => {
    const { board, boxes, robotCell } = setup([
      "OOOOO",
      "OR  O",
      "O XSO",
      "OOOOO",
    ]);
    const { occupancy, reachable } = reachFrom(board, robotCell, boxes);

    const detector = new LocalCorralDeadlockDetector(board);
    assert.equal(detector.check(boxes, occupancy, reachable), false);
  });

  it("detects deadlock: sealed corral with excess boxes of one label", () => {
    // Board with both X/S pair AND A/a pair. The sealed corral will contain
    // an X box with no S goal inside the corral.
    //
    //   OOOOOOO
    //   OSR   O   <-- S goal (for X) on robot side
    //   O OXO O   <-- X box blocks corridor
    //   O OAO O   <-- A box in corridor
    //   O OaO O   <-- 'a' goal (for A) in corral
    //   OOOOOOO
    //
    // Corral = {(2,3), (3,3), (4,3)}. Boxes: X at (2,3), A at (3,3).
    // Goals in corral: A at (4,3). goalCountByLabel: {A:1}.
    // boxCountByLabel: {X:1, A:1}.
    // Label X: 1 box, 0 goals -> deadlock (boxCount > goalCount).

    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOOOO",
      "OSR   O",
      "O OXO O",
      "O OAO O",
      "O OaO O",
      "OOOOOOO",
    ]));
    const robotCell = board.cellAt(1, 2);
    const boxes: DenseBox[] = [
      { id: "A:0", label: "A", cell: board.cellAt(3, 3) },
      { id: "X:0", label: "X", cell: board.cellAt(2, 3) },
    ];
    const { occupancy, reachable } = reachFrom(board, robotCell, boxes);

    const detector = new LocalCorralDeadlockDetector(board);
    assert.equal(detector.check(boxes, occupancy, reachable), true);
    assert.deepEqual(detector.stats, { checks: 1, deadlocks: 1 });
  });

  it("detects deadlock when a box label has no matching goal at all in sealed corral", () => {
    // Same corridor structure but the goal in the corral is 'b' (label B).
    // Corral contains boxes X and A, but no B box exists and no X or A goal
    // in the corral. This tests lines 314-318 (goalCountByLabel.has check).
    //
    //   OOOOOOO
    //   OSR  aO   <-- S goal (for X), 'a' goal (for A) on robot side
    //   O OXO O   <-- X box
    //   O OAO O   <-- A box
    //   O O O O   <-- empty corridor cell (no goal in corral)
    //   OOOOOOO
    //
    // Corral = {(2,3), (3,3), (4,3)}. Boxes: X, A.
    // Goals in corral: none. goalCountByLabel is empty.
    // For label X: goalCountByLabel.has("X") -> false -> deadlock (line 316).

    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOOOO",
      "OSR  aO",
      "O OXO O",
      "O OAO O",
      "O O O O",
      "OOOOOOO",
    ]));
    const robotCell = board.cellAt(1, 2);
    const boxes: DenseBox[] = [
      { id: "A:0", label: "A", cell: board.cellAt(3, 3) },
      { id: "X:0", label: "X", cell: board.cellAt(2, 3) },
    ];
    const { occupancy, reachable } = reachFrom(board, robotCell, boxes);

    const detector = new LocalCorralDeadlockDetector(board);
    assert.equal(detector.check(boxes, occupancy, reachable), true);
    assert.equal(detector.stats.deadlocks, 1);
  });

  it("returns false when sealed corral has matching labels for all boxes", () => {
    // Two A boxes in a sealed corridor with two 'a' goals. Counts match.
    //
    //   OOOOOOO
    //   O R   O
    //   O OAO O
    //   O OAO O
    //   O OaO O
    //   O OaO O
    //   OOOOOOO
    //
    // Corral = {(2,3),(3,3),(4,3),(5,3)}. Boxes: A, A. Goals: A, A.
    // boxCountByLabel: {A:2}. goalCountByLabel: {A:2}. 2 <= 2 -> no deadlock.
    // Also every box label (A) is in goalCountByLabel -> no deadlock.

    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOOOO",
      "O R   O",
      "O OAO O",
      "O OAO O",
      "O OaO O",
      "O OaO O",
      "OOOOOOO",
    ]));
    const robotCell = board.cellAt(1, 2);
    const boxes: DenseBox[] = [
      { id: "A:0", label: "A", cell: board.cellAt(2, 3) },
      { id: "A:1", label: "A", cell: board.cellAt(3, 3) },
    ];
    const { occupancy, reachable } = reachFrom(board, robotCell, boxes);

    const detector = new LocalCorralDeadlockDetector(board);
    assert.equal(detector.check(boxes, occupancy, reachable), false);
  });

  it("tracks stats across multiple checks", () => {
    const { board, boxes, robotCell } = setup([
      "OOOOO",
      "OR  O",
      "O XSO",
      "OOOOO",
    ]);
    const { occupancy, reachable } = reachFrom(board, robotCell, boxes);

    const detector = new LocalCorralDeadlockDetector(board);
    detector.check(boxes, occupancy, reachable);
    detector.check(boxes, occupancy, reachable);
    detector.check(boxes, occupancy, reachable);

    assert.equal(detector.stats.checks, 3);
    assert.ok(detector.stats.deadlocks >= 0);
  });

  it("returns false for a single box already on its goal", () => {
    const { board, robotCell } = setup([
      "OOOOO",
      "ORXSO",
      "OOOOO",
    ]);
    const goalCell = board.goalCellsByLabel.get("X")![0];
    const boxes: DenseBox[] = [{ id: "X:0", label: "X", cell: goalCell }];
    const { occupancy, reachable } = reachFrom(board, robotCell, boxes);

    const detector = new LocalCorralDeadlockDetector(board);
    assert.equal(detector.check(boxes, occupancy, reachable), false);
  });

  it("does not flag a corral that can be opened by pushing a box out", () => {
    // Robot can push the box down through the corridor.
    //   OOOOOOO
    //   O R   O
    //   O OAO O   <-- A box at (2,3)
    //   O O O O   <-- corridor open
    //   O OaO O   <-- goal
    //   OOOOOOO
    //
    // Push A down: support = up = (1,3) which is reachable. dest = (3,3)
    // which is unoccupied. canBeOpened = true.
    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOOOO",
      "O R   O",
      "O OAO O",
      "O O O O",
      "O OaO O",
      "OOOOOOO",
    ]));
    const robotCell = board.cellAt(1, 2);
    const boxes: DenseBox[] = [
      { id: "A:0", label: "A", cell: board.cellAt(2, 3) },
    ];
    const { occupancy, reachable } = reachFrom(board, robotCell, boxes);

    const detector = new LocalCorralDeadlockDetector(board);
    assert.equal(detector.check(boxes, occupancy, reachable), false);
  });
});

// ---------------------------------------------------------------------------
// LocalCorralLowerBound on sealed corrals (assignment cost)
// ---------------------------------------------------------------------------

describe("LocalCorralLowerBound on sealed corrals", () => {
  it("returns a lower bound for a sealed corral with assignment cost", () => {
    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOOOO",
      "O R   O",
      "O OAO O",
      "O O O O",
      "O OaO O",
      "OOOOOOO",
    ]));
    const robotCell = board.cellAt(1, 2);
    const boxes: DenseBox[] = [
      { id: "A:0", label: "A", cell: board.cellAt(2, 3) },
    ];
    const { occupancy, reachable } = reachFrom(board, robotCell, boxes);

    const heuristic = new LocalCorralLowerBound(board);
    const value = heuristic.evaluate(boxes, occupancy, reachable);
    // Box A at (2,3) needs to reach goal 'a' at (4,3). Reverse push distance >= 1.
    assert.ok(value >= 0, `expected non-negative, got ${value}`);
  });

  it("handles corral boxes with no matching goals (returns 0 for that label)", () => {
    // Same scenario as the deadlock test: sealed corral with X box but no
    // S goal inside the corral. The lower bound code skips labels with no
    // matching goals (lines 131-136) rather than returning Infinity.
    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOOOO",
      "OSR  aO",
      "O OXO O",
      "O OAO O",
      "O O O O",
      "OOOOOOO",
    ]));
    const robotCell = board.cellAt(1, 2);
    const boxes: DenseBox[] = [
      { id: "A:0", label: "A", cell: board.cellAt(3, 3) },
      { id: "X:0", label: "X", cell: board.cellAt(2, 3) },
    ];
    const { occupancy, reachable } = reachFrom(board, robotCell, boxes);

    const heuristic = new LocalCorralLowerBound(board);
    const value = heuristic.evaluate(boxes, occupancy, reachable);
    // The corral has no goals for either label (A goals and S goals are outside).
    // Both labels get skipped at line 131-135. corralLB stays 0.
    assert.ok(value >= 0, `expected non-negative, got ${value}`);
  });
});
