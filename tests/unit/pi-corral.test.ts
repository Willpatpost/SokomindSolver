import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parsePuzzleRows,
} from "../../src/core/index.ts";
import {
  compileSearchBoard,
  type CompiledSearchBoard,
} from "../../src/solver/search/compiled-board.ts";
import {
  hasPiCorralDeadlock,
  PiCorralDetector,
} from "../../src/solver/search/pi-corral.ts";
import {
  hasSealedCorralDeadlock,
  SealedCorralDetector,
} from "../../src/solver/search/sealed-corral.ts";
import {
  toDenseBoxes,
  type DenseBox,
} from "../../src/solver/search/model.ts";
import { KeeperReachability } from "../../src/solver/search/reachability.ts";

function checkPiCorral(
  board: CompiledSearchBoard,
  boxes: readonly DenseBox[],
  robotCell: number,
): boolean {
  const occupancy = new Uint8Array(board.cellCount);
  for (const box of boxes) occupancy[box.cell] = 1;
  const reachability = new KeeperReachability(board);
  const reachable = reachability.flood(robotCell, occupancy);
  const detector = new PiCorralDetector(board.cellCount);
  return hasPiCorralDeadlock(board, boxes, occupancy, reachable, detector);
}

function checkSealedCorral(
  board: CompiledSearchBoard,
  boxes: readonly DenseBox[],
  robotCell: number,
): boolean {
  const occupancy = new Uint8Array(board.cellCount);
  for (const box of boxes) occupancy[box.cell] = 1;
  const reachability = new KeeperReachability(board);
  const reachable = reachability.flood(robotCell, occupancy);
  const detector = new SealedCorralDetector(board.cellCount);
  return hasSealedCorralDeadlock(board, boxes, occupancy, reachable, detector);
}

describe("PI-corral detection", () => {
  it("detects a trivially sealed corral (subsumes sealed corral)", () => {
    const parsed = parsePuzzleRows([
      "OOOOOOOO",
      "OR     O",
      "O  OOO O",
      "O  OX  O",
      "O  OOS O",
      "O      O",
      "OOOOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const boxes = toDenseBoxes(board, parsed.initialBoxes);
    const robotCell = board.cellAt(1, 1);

    assert.equal(checkSealedCorral(board, boxes, robotCell), true);
    assert.equal(checkPiCorral(board, boxes, robotCell), true);
  });

  it("returns false when keeper can reach all boxes", () => {
    const parsed = parsePuzzleRows([
      "OOOOOO",
      "OR   O",
      "O X SO",
      "OOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const boxes = toDenseBoxes(board, parsed.initialBoxes);
    const robotCell = board.cellAt(1, 1);

    assert.equal(checkPiCorral(board, boxes, robotCell), false);
  });

  it("returns false when sealed boxes are all on matching goals", () => {
    const parsed = parsePuzzleRows([
      "OOOOOOOO",
      "OR     O",
      "O  OOO O",
      "O  O   O",
      "O  OOXSO",
      "O      O",
      "OOOOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const goalCells = board.goalCellsByLabel.get("X") ?? [];
    assert.ok(goalCells.length > 0, "should have at least one X goal");
    const boxes: readonly DenseBox[] = goalCells.map((cell, i) => ({
      id: `X:${i}`,
      label: "X",
      cell,
    }));
    const robotCell = board.cellAt(1, 1);

    assert.equal(checkPiCorral(board, boxes, robotCell), false);
  });

  it("subsumes sealed corral: PI-corral detects everything sealed corral does", () => {
    const parsed = parsePuzzleRows([
      "OOOOOOOO",
      "OR     O",
      "O  OOO O",
      "O  OX  O",
      "O  OOS O",
      "O      O",
      "OOOOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const boxes = toDenseBoxes(board, parsed.initialBoxes);
    const robotCell = board.cellAt(1, 1);

    const sealed = checkSealedCorral(board, boxes, robotCell);
    const pi = checkPiCorral(board, boxes, robotCell);
    if (sealed) {
      assert.equal(pi, true, "PI-corral must detect sealed corral deadlocks");
    }
  });

  it("returns false for a solvable configuration with accessible box", () => {
    const parsed = parsePuzzleRows([
      "OOOOOOO",
      "OR    O",
      "O  X  O",
      "O  S  O",
      "O     O",
      "OOOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const boxes = toDenseBoxes(board, parsed.initialBoxes);
    const robotCell = board.cellAt(1, 1);

    assert.equal(checkPiCorral(board, boxes, robotCell), false);
  });

  it("returns false for a solved state", () => {
    const parsed = parsePuzzleRows([
      "OOOOO",
      "OR  O",
      "O XSO",
      "OOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const goalCells = board.goalCellsByLabel.get("X") ?? [];
    const boxes: readonly DenseBox[] = goalCells.map((cell, i) => ({
      id: `X:${i}`,
      label: "X",
      cell,
    }));
    const robotCell = board.cellAt(1, 1);

    assert.equal(checkPiCorral(board, boxes, robotCell), false);
  });

  it("tracks stats correctly", () => {
    const parsed = parsePuzzleRows([
      "OOOOOOOO",
      "OR     O",
      "O  OOO O",
      "O  OX  O",
      "O  OOS O",
      "O      O",
      "OOOOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const boxes = toDenseBoxes(board, parsed.initialBoxes);
    const robotCell = board.cellAt(1, 1);
    const occupancy = new Uint8Array(board.cellCount);
    for (const box of boxes) occupancy[box.cell] = 1;
    const reachability = new KeeperReachability(board);
    const reachable = reachability.flood(robotCell, occupancy);

    const detector = new PiCorralDetector(board.cellCount);
    assert.equal(detector.stats.checks, 0);
    detector.check(board, boxes, occupancy, reachable);
    assert.equal(detector.stats.checks, 1);
    assert.ok(detector.stats.sealedDeadlocks > 0 || detector.stats.piDeadlocks > 0);
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
    let falsePositives = 0;

    for (let left = 0; left < board.cellCount; left++) {
      for (let right = left + 1; right < board.cellCount; right++) {
        for (let robot = 0; robot < board.cellCount; robot++) {
          if (robot === left || robot === right) continue;
          const boxes: readonly DenseBox[] = [
            { id: "X:0", label: "X", cell: left },
            { id: "X:1", label: "X", cell: right },
          ];
          const piDead = checkPiCorral(board, boxes, robot);
          if (!piDead) continue;
          // If PI-corral says dead, verify with oracle BFS
          const exact = exactRemainingPushes(board, robot, boxes);
          if (exact !== null) {
            falsePositives++;
          }
        }
      }
    }

    assert.equal(falsePositives, 0, "PI-corral must not prune solvable states");
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
  const initial: OracleState = {
    robot,
    boxes: initialBoxes,
    pushes: 0,
  };
  const distances = new Map([[exactStateKey(robot, initialBoxes), 0]]);
  const deque = new Map<number, OracleState>([[0, initial]]);
  let front = 0;
  let back = 1;
  const pushFront = (state: OracleState): void => {
    front -= 1;
    deque.set(front, state);
  };
  const pushBack = (state: OracleState): void => {
    deque.set(back, state);
    back += 1;
  };

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
      if (pushCost) pushBack(next); else pushFront(next);
    }
  }

  return null;
}
