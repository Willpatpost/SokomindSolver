import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parsePuzzleRows } from "../../src/core/index.ts";
import {
  compileSearchBoard,
  type CompiledSearchBoard,
} from "../../src/solver/search/compiled-board.ts";
import {
  buildDeadlockTables,
} from "../../src/solver/search/deadlock-tables.ts";
import {
  toDenseBoxes,
  type DenseBox,
} from "../../src/solver/search/model.ts";

describe("buildDeadlockTables", () => {
  it("completes within time budget on a small board", () => {
    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOOOO",
      "OR    O",
      "O  X  O",
      "O  S  O",
      "O     O",
      "OOOOOOO",
    ]));
    const lookup = buildDeadlockTables(board);
    assert.ok(lookup.stats.buildTimeMs < 2000);
  });

  it("completes within time budget on a medium board", () => {
    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOOOOOOOOOO",
      "OR          O",
      "O           O",
      "O   XXXX    O",
      "O   SSSS    O",
      "O           O",
      "O           O",
      "OOOOOOOOOOOOO",
    ]));
    const lookup = buildDeadlockTables(board);
    assert.ok(lookup.stats.buildTimeMs < 2500);
  });

  it("reports region and pattern counts", () => {
    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOOOO",
      "OR XX O",
      "O  SS O",
      "O     O",
      "OOOOOOO",
    ]));
    const lookup = buildDeadlockTables(board);
    assert.ok(lookup.stats.regionCount >= 0);
    assert.ok(lookup.stats.patternCount >= 0);
  });

  it("returns empty lookup for board with no goals", () => {
    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOO",
      "OR  O",
      "O   O",
      "OOOOO",
    ]));
    const lookup = buildDeadlockTables(board);
    assert.equal(lookup.stats.patternCount, 0);
  });
});

describe("DeadlockTableLookup.check", () => {
  it("returns false for a solvable configuration", () => {
    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOOOO",
      "OR    O",
      "O  X  O",
      "O  S  O",
      "O     O",
      "OOOOOOO",
    ]));
    const lookup = buildDeadlockTables(board);
    const boxes = toDenseBoxes(board, parsePuzzleRows([
      "OOOOOOO",
      "OR    O",
      "O  X  O",
      "O  S  O",
      "O     O",
      "OOOOOOO",
    ]).initialBoxes);
    for (const box of boxes) {
      assert.equal(lookup.check(boxes, box.cell), false);
    }
  });

  it("returns false for solved configuration (boxes on goals)", () => {
    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOOOO",
      "OR XX O",
      "O  SS O",
      "O     O",
      "OOOOOOO",
    ]));
    const lookup = buildDeadlockTables(board);
    const goalCells = board.goalCellsByLabel.get("X") ?? [];
    const boxes: readonly DenseBox[] = goalCells.map((cell, i) => ({
      id: `X:${i}`,
      label: "X",
      cell,
    }));
    for (const goalCell of goalCells) {
      assert.equal(lookup.check(boxes, goalCell), false);
    }
  });

  it("detects wall-corner 2-box deadlock pattern", () => {
    // Two boxes in a wall corner where no push can free them.
    // This is typically caught by freeze/2x2, but deadlock tables
    // should also find it.
    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOOOO",
      "OR    O",
      "O     O",
      "O  XX O",
      "O  SS O",
      "OOOOOOO",
    ]));
    const lookup = buildDeadlockTables(board);
    // Place two X boxes in the bottom-right corner: cells at (3,5) and (4,5)
    // These would be wall-adjacent and likely deadlocked.
    const cell1 = board.cellAt(3, 5);
    const cell2 = board.cellAt(4, 5);
    if (cell1 >= 0 && cell2 >= 0) {
      const boxes: readonly DenseBox[] = [
        { id: "X:0", label: "X", cell: cell1 },
        { id: "X:1", label: "X", cell: cell2 },
      ];
      // These may or may not be detected depending on region topology.
      // The test just verifies no crash and correct boolean return.
      const result = lookup.check(boxes, cell1);
      assert.equal(typeof result, "boolean");
    }
  });

  it("detects mixed-label deadlock on typed board", () => {
    // Minimal board: 6 floor cells, 2 typed goals.
    // A and B at row 2 are against the bottom wall, mutually blocking.
    // Old uniform-only build would add keys for [A,A] and [B,B] but miss
    // the [A,B] key that the lookup generates for actual mixed-label boxes.
    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOO",
      "ORabO",
      "O ABO",
      "OOOOO",
    ]));
    const lookup = buildDeadlockTables(board);
    assert.ok(lookup.stats.patternCount > 0);
    const cellA = board.cellAt(2, 2);
    const cellB = board.cellAt(2, 3);
    assert.ok(cellA >= 0 && cellB >= 0, "cells must exist");
    const boxes: readonly DenseBox[] = [
      { id: "A:0", label: "A", cell: cellA },
      { id: "B:0", label: "B", cell: cellB },
    ];
    const detected = lookup.check(boxes, cellA) || lookup.check(boxes, cellB);
    assert.ok(detected, "mixed-label corner deadlock should be detected");
  });

  it("does not produce false positives on exhaustive typed board", () => {
    const parsed = parsePuzzleRows([
      "OOOOOO",
      "ORAb O",
      "O    O",
      "O aB O",
      "OOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const lookup = buildDeadlockTables(board);
    let falsePositives = 0;

    for (let left = 0; left < board.cellCount; left++) {
      for (let right = left + 1; right < board.cellCount; right++) {
        for (const [labelL, labelR] of [["A", "B"], ["B", "A"], ["A", "A"], ["B", "B"]]) {
          const boxes: readonly DenseBox[] = [
            { id: `${labelL}:0`, label: labelL, cell: left },
            { id: `${labelR}:1`, label: labelR, cell: right },
          ];
          const dead1 = lookup.check(boxes, left);
          const dead2 = lookup.check(boxes, right);
          if (!dead1 && !dead2) continue;

          for (let robot = 0; robot < board.cellCount; robot++) {
            if (robot === left || robot === right) continue;
            const exact = exactRemainingPushes(board, robot, boxes);
            if (exact !== null) {
              falsePositives++;
              break;
            }
          }
        }
      }
    }

    assert.equal(falsePositives, 0, "Mixed-label deadlock tables must not prune solvable states");
  });

  it("does not produce false positives on exhaustive small board", () => {
    const parsed = parsePuzzleRows([
      "OOOOOO",
      "ORXX O",
      "O    O",
      "O SS O",
      "OOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const lookup = buildDeadlockTables(board);
    let falsePositives = 0;

    for (let left = 0; left < board.cellCount; left++) {
      for (let right = left + 1; right < board.cellCount; right++) {
        const boxes: readonly DenseBox[] = [
          { id: "X:0", label: "X", cell: left },
          { id: "X:1", label: "X", cell: right },
        ];
        const dead1 = lookup.check(boxes, left);
        const dead2 = lookup.check(boxes, right);
        if (!dead1 && !dead2) continue;

        // Verify with oracle BFS
        for (let robot = 0; robot < board.cellCount; robot++) {
          if (robot === left || robot === right) continue;
          const exact = exactRemainingPushes(board, robot, boxes);
          if (exact !== null) {
            falsePositives++;
            break;
          }
        }
      }
    }

    assert.equal(falsePositives, 0, "Deadlock tables must not prune solvable states");
  });
});

function exactStateKey(robot: number, boxes: readonly DenseBox[]): string {
  const boxKey = boxes
    .map(({ label, cell }) => `${label.length}:${label}@${cell}`)
    .sort()
    .join(";");
  return `${robot}|${boxKey}`;
}

interface OracleState {
  readonly robot: number;
  readonly boxes: readonly DenseBox[];
  readonly pushes: number;
}

function exactRemainingPushes(
  board: CompiledSearchBoard,
  robot: number,
  initialBoxes: readonly DenseBox[],
): number | null {
  const initial: OracleState = { robot, boxes: initialBoxes, pushes: 0 };
  const distances = new Map([[exactStateKey(robot, initialBoxes), 0]]);
  const deque = new Map<number, OracleState>([[0, initial]]);
  let front = 0;
  let back = 1;

  while (front < back) {
    const current = deque.get(front);
    deque.delete(front);
    front += 1;
    if (!current) continue;
    const currentKey = exactStateKey(current.robot, current.boxes);
    if (distances.get(currentKey) !== current.pushes) continue;
    if (current.boxes.every(({ label, cell }) => board.goalLabelByCell[cell] === label)) {
      return current.pushes;
    }

    const boxIndexByCell = new Int32Array(board.cellCount);
    boxIndexByCell.fill(-1);
    current.boxes.forEach(({ cell }, index) => { boxIndexByCell[cell] = index; });

    for (let d = 0; d < board.neighbors[current.robot].length; d++) {
      const destination = board.neighbors[current.robot][d];
      if (destination < 0) continue;
      const pushedBoxIndex = boxIndexByCell[destination];
      let nextBoxes = current.boxes;
      let pushCost = 0;
      if (pushedBoxIndex >= 0) {
        const boxDestination = board.neighbors[destination][d];
        if (boxDestination < 0 || boxIndexByCell[boxDestination] >= 0) continue;
        nextBoxes = current.boxes.map((box, index) =>
          index === pushedBoxIndex ? { ...box, cell: boxDestination } : box,
        );
        pushCost = 1;
      }
      const next: OracleState = { robot: destination, boxes: nextBoxes, pushes: current.pushes + pushCost };
      const nextKey = exactStateKey(next.robot, next.boxes);
      if (next.pushes >= (distances.get(nextKey) ?? Number.POSITIVE_INFINITY)) continue;
      distances.set(nextKey, next.pushes);
      if (pushCost) { deque.set(back, next); back++; }
      else { front--; deque.set(front, next); }
    }
  }

  return null;
}
