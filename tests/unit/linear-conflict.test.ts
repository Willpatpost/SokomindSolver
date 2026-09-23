import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parsePuzzleRows } from "../../src/core/index.ts";
import {
  compileSearchBoard,
} from "../../src/solver/search/compiled-board.ts";
import { computeLinearConflict } from "../../src/solver/search/linear-conflict.ts";
import {
  toDenseBoxes,
} from "../../src/solver/search/model.ts";
import {
  AssignmentHeuristic,
  minimumManhattanWalkToPotentialPush,
} from "../../src/solver/search/heuristic.ts";
import {
  allReachableStateCosts,
  exactRemainingMoves,
} from "../support/exact-solver-oracle.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupBoard(rows: string[]) {
  const parsed = parsePuzzleRows(rows);
  const board = compileSearchBoard(parsed);
  const boxes = toDenseBoxes(board, parsed.initialBoxes);
  return { parsed, board, boxes };
}

function getLinearConflict(rows: string[]): number {
  const { board, boxes } = setupBoard(rows);
  const heuristic = new AssignmentHeuristic(board);
  heuristic.evaluate(boxes);
  return heuristic.lastLinearConflict(boxes);
}

function transpose(rows: readonly string[]): string[] {
  return [...rows[0]].map((_, column) => rows.map((row) => row[column]).join(""));
}

function boundsAt(
  rows: string[],
  robotAt: readonly [number, number],
  placed: readonly (readonly [string, number, number])[],
) {
  const { board } = setupBoard(rows);
  const robot = board.cellAt(robotAt[0], robotAt[1]);
  const boxes = placed.map(([label, row, column], index) => ({
    id: `${label}:${index}`,
    label,
    cell: board.cellAt(row, column),
  }));
  const heuristic = new AssignmentHeuristic(board, { maxCacheEntries: 0 });
  const pushBound = heuristic.evaluate(boxes);
  const conflict = heuristic.lastLinearConflict(boxes);
  return { pushBound, conflict, oracle: exactRemainingMoves(board, robot, boxes) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("computeLinearConflict", () => {
  it("returns 0 for an already-solved state", () => {
    const rows = [
      "OOOOO",
      "O   O",
      "ORXSO",
      "O   O",
      "OOOOO",
    ];
    const { board, boxes } = setupBoard(rows);
    const solvedBoxes = boxes.map((b) => {
      const goalCells = board.goalCellsByLabel.get(b.label);
      if (goalCells && goalCells.length > 0) {
        return { ...b, cell: goalCells[0] };
      }
      return b;
    });
    const heuristic = new AssignmentHeuristic(board);
    heuristic.evaluate(solvedBoxes);
    const lc = heuristic.lastLinearConflict(solvedBoxes);
    assert.equal(lc, 0);
  });

  it("returns 0 when there are no conflicts", () => {
    // Two boxes in a row, both heading right (no swap needed)
    const rows = [
      "OOOOOOO",
      "O     O",
      "OXXSSRO",
      "O     O",
      "OOOOOOO",
    ];
    const lc = getLinearConflict(rows);
    assert.equal(lc, 0);
  });

  it("detects row conflict for two typed boxes with swapped goals", () => {
    // A (col 2) -> a (col 4) and B (col 3) -> b (col 1) cross on row 2.
    const rows = [
      "OOOOOOO",
      "O     O",
      "ObABaRO",
      "O     O",
      "OOOOOOO",
    ];
    assert.equal(getLinearConflict(rows), 2);
  });

  it("detects column conflict for two typed boxes with swapped goals", () => {
    const rows = transpose([
      "OOOOOOO",
      "O     O",
      "ObABaRO",
      "O     O",
      "OOOOOOO",
    ]);
    assert.equal(getLinearConflict(rows), 2);
  });

  it("returns 0 for a single box", () => {
    const rows = [
      "OOOOO",
      "O   O",
      "OXRSO",
      "O   O",
      "OOOOO",
    ];
    const lc = getLinearConflict(rows);
    assert.equal(lc, 0);
  });

  it("returns 0 for empty box set", () => {
    const rows = [
      "OOOOO",
      "O R O",
      "OOOOO",
    ];
    const { board } = setupBoard(rows);
    const assignment = new Map<string, {
      boxCells: readonly number[];
      goalCells: readonly number[];
      columns: readonly number[];
    }>();
    const lc = computeLinearConflict(board, [], assignment);
    assert.equal(lc, 0);
  });

  it("each box participates in at most one conflict per axis (greedy pairing)", () => {
    // A (col 3) -> a (col 8), B (col 4) -> b (col 7), C (col 5) -> c (col 1).
    // Every pair crosses, but three boxes form only one disjoint pair.
    const rows = [
      "OOOOOOOOOOO",
      "O         O",
      "Oc ABC ba O",
      "O    R    O",
      "OOOOOOOOOOO",
    ];
    assert.equal(getLinearConflict(rows), 2);
  });

  it("an unkeyed cache hit restores the hit state's assignment", () => {
    // `crossed` is the row-conflict board; `uncrossed` swaps the A and B cells.
    const { board, boxes: crossed } = setupBoard([
      "OOOOOOO",
      "O     O",
      "ObABaRO",
      "O     O",
      "OOOOOOO",
    ]);
    const cellOf = (label: string) => crossed.find((box) => box.label === label)!.cell;
    const uncrossed = crossed.map((box) => ({
      ...box,
      cell: cellOf(box.label === "A" ? "B" : "A"),
    }));

    const heuristic = new AssignmentHeuristic(board);
    heuristic.evaluate(uncrossed);
    heuristic.evaluate(crossed);
    heuristic.evaluate(uncrossed);
    assert.equal(heuristic.stats.cacheHits, 1);
    assert.equal(heuristic.lastLinearConflict(uncrossed), 0);

    heuristic.evaluate(crossed);
    assert.equal(heuristic.stats.cacheHits, 2);
    assert.equal(heuristic.lastLinearConflict(crossed), 2);
    const fresh = new AssignmentHeuristic(board);
    fresh.evaluate(crossed);
    assert.deepEqual(heuristic.lastLabelCosts, fresh.lastLabelCosts);
  });
});

describe("linear conflict admissibility", () => {
  const TIED_X_BOARD = [
    "OOOOOOOO",
    "O      O",
    "O XX   O",
    "O SS R O",
    "OO     O",
    "OOOOOOOO",
  ];
  const DETOUR_BOARD = [
    "OOOOOOOO",
    "O      O",
    "O   R OO",
    "O    O O",
    "ObAOaB O",
    "O  O   O",
    "OOOOOOOO",
  ];
  const CROSSING_ROW_BOARD = [
    "OOOOOOOO",
    "O     OO",
    "O   OR O",
    "ObABa  O",
    "OOO   OO",
    "OOOOOOOO",
  ];

  it("ignores boxes whose label has several goals", () => {
    // Either matching of the boxes to the goals costs 3 pushes. The one that
    // crosses them costs no more than the one that does not, so nothing
    // forces a detour.
    const { pushBound, conflict, oracle } = boundsAt(
      TIED_X_BOARD,
      [2, 5],
      [["X", 3, 5], ["X", 3, 3]],
    );
    assert.equal(pushBound, 3);
    assert.equal(conflict, 0);
    assert.equal(oracle.exactPushes, 3);
    assert.equal(oracle.exactMoves, 10);
  });

  it("ignores pairs whose shortest route already leaves the line", () => {
    // A and B cross on row 4, but the wall between A and its goal means A's
    // shortest route already leaves the row, so it can pass B on the way.
    const { pushBound, conflict, oracle } = boundsAt(
      DETOUR_BOARD,
      [2, 4],
      [["A", 4, 2], ["B", 4, 5]],
    );
    assert.equal(pushBound, 12);
    assert.equal(conflict, 0);
    assert.equal(oracle.exactPushes, 12);
    assert.equal(oracle.exactMoves, 36);
  });

  // The first two boards need crossing detours. On the others the previous
  // rule overestimated the push optimum in some states.
  for (const [name, rows, crossing] of [
    ["crossing row", CROSSING_ROW_BOARD, true],
    ["crossing column", transpose(CROSSING_ROW_BOARD), true],
    ["tied X", TIED_X_BOARD, false],
    ["detour", DETOUR_BOARD, false],
  ] as const) {
    it(`never exceeds the pushes or moves left in any reachable state (${name})`, () => {
      const { parsed, board, boxes } = setupBoard([...rows]);
      const robot = board.cellAt(parsed.initialRobot.row, parsed.initialRobot.column);
      const heuristic = new AssignmentHeuristic(board);
      let conflictStates = 0;
      let tightStates = 0;
      for (const state of allReachableStateCosts(board, robot, boxes).values()) {
        if (state.exactMoves === null || state.exactPushes === null) continue;
        const pushBound = heuristic.evaluate(state.boxes);
        const conflict = heuristic.lastLinearConflict(state.boxes);
        const walk = minimumManhattanWalkToPotentialPush(board, state.robot, state.boxes);
        assert.ok(
          pushBound + conflict <= state.exactPushes,
          `h ${pushBound}+${conflict} exceeds ${state.exactPushes} pushes`,
        );
        assert.ok(
          pushBound + conflict + walk <= state.exactMoves,
          `h ${pushBound}+${conflict}+${walk} exceeds ${state.exactMoves} moves`,
        );
        if (conflict > 0) {
          conflictStates += 1;
          if (pushBound + conflict === state.exactPushes) tightStates += 1;
        }
      }
      if (!crossing) return;
      assert.ok(conflictStates > 0, "some solvable state must have a conflict");
      assert.ok(tightStates > 0, "the conflict must be the whole push gap somewhere");
    });
  }
});
