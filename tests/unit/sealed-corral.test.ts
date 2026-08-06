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
  hasSealedCorralDeadlock,
  SealedCorralDetector,
} from "../../src/solver/search/sealed-corral.ts";
import {
  toDenseBoxes,
  type DenseBox,
} from "../../src/solver/search/model.ts";
import { KeeperReachability } from "../../src/solver/search/reachability.ts";

function checkCorral(
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
    if (
      current.boxes.every(
        ({ label, cell }) => board.goalLabelByCell[cell] === label,
      )
    ) {
      return current.pushes;
    }

    const boxIndexByCell = new Int32Array(board.cellCount);
    boxIndexByCell.fill(-1);
    current.boxes.forEach(({ cell }, index) => {
      boxIndexByCell[cell] = index;
    });

    for (
      let directionIndex = 0;
      directionIndex < board.neighbors[current.robot].length;
      directionIndex += 1
    ) {
      const destination = board.neighbors[current.robot][directionIndex];
      if (destination < 0) continue;

      const pushedBoxIndex = boxIndexByCell[destination];
      let nextBoxes = current.boxes;
      let pushCost = 0;
      if (pushedBoxIndex >= 0) {
        const boxDestination = board.neighbors[destination][directionIndex];
        if (
          boxDestination < 0 ||
          boxIndexByCell[boxDestination] >= 0
        ) {
          continue;
        }
        nextBoxes = current.boxes.map((box, index) =>
          index === pushedBoxIndex
            ? { ...box, cell: boxDestination }
            : box,
        );
        pushCost = 1;
      }

      const next: OracleState = {
        robot: destination,
        boxes: nextBoxes,
        pushes: current.pushes + pushCost,
      };
      const nextKey = exactStateKey(next.robot, next.boxes);
      if (next.pushes >= (distances.get(nextKey) ?? Number.POSITIVE_INFINITY)) {
        continue;
      }
      distances.set(nextKey, next.pushes);
      if (pushCost) pushBack(next);
      else pushFront(next);
    }
  }

  return null;
}

describe("sealed corral detection", () => {
  it("detects a trivially sealed corral with misplaced box", () => {
    // Box X is in a sealed area (keeper on the other side, no way to push in)
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

    const result = checkCorral(board, boxes, robotCell);
    assert.equal(result, true, "Box sealed behind wall partition should be detected as deadlock");
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

    assert.equal(
      checkCorral(board, boxes, robotCell),
      false,
      "All boxes reachable → no sealed corral",
    );
  });

  it("returns false when sealed boxes are all on matching goals", () => {
    // Box starts on its matching goal in a sealed area → not a deadlock
    // The puzzle has X on S so parsePuzzleRows sees 1 box, 1 goal.
    const parsed = parsePuzzleRows([
      "OOOOOOO",
      "OR    O",
      "O OOO O",
      "O OXS O",
      "O OO  O",
      "O     O",
      "OOOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const goalCells = [...(board.goalCellsByLabel.get("X") ?? [])];
    assert.equal(goalCells.length, 1);
    // Place the box on the goal inside the sealed area
    const solvedBoxes: DenseBox[] = [
      { id: "X:0", label: "X", cell: goalCells[0] },
    ];
    const robotCell = board.cellAt(1, 1);

    assert.equal(
      checkCorral(board, solvedBoxes, robotCell),
      false,
      "Box on its goal in sealed area should not be deadlock",
    );
  });

  it("detects sealed corral when box cannot be opened (no reachable support)", () => {
    // Keeper is on one side of a wall, box is in a dead-end on the other side
    const parsed = parsePuzzleRows([
      "OOOOOOO",
      "OR    O",
      "OOOOO O",
      "OX  S O",
      "OOOOO O",
      "O     O",
      "OOOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const boxes = toDenseBoxes(board, parsed.initialBoxes);
    const robotCell = board.cellAt(1, 1);

    assert.equal(
      checkCorral(board, boxes, robotCell),
      true,
      "Box in sealed pocket with no pushable access should be deadlock",
    );
  });

  it("returns false when a box can be pushed into the corral (openable)", () => {
    // Box is not reachable by keeper, but keeper CAN push it from a reachable support
    const parsed = parsePuzzleRows([
      "OOOOOOO",
      "OR    O",
      "O  X  O",
      "O  S  O",
      "OOOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const boxes = toDenseBoxes(board, parsed.initialBoxes);
    const robotCell = board.cellAt(1, 1);

    // Keeper can reach all cells → no sealed corral
    assert.equal(
      checkCorral(board, boxes, robotCell),
      false,
    );
  });

  it("reports statistics", () => {
    const parsed = parsePuzzleRows([
      "OOOOOO",
      "OR   O",
      "O X SO",
      "OOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const boxes = toDenseBoxes(board, parsed.initialBoxes);
    const robotCell = board.cellAt(1, 1);

    const occupancy = new Uint8Array(board.cellCount);
    for (const box of boxes) occupancy[box.cell] = 1;
    const reachability = new KeeperReachability(board);
    const reachable = reachability.flood(robotCell, occupancy);
    const detector = new SealedCorralDetector(board.cellCount);

    hasSealedCorralDeadlock(board, boxes, occupancy, reachable, detector);
    assert.equal(detector.stats.checks, 1);

    hasSealedCorralDeadlock(board, boxes, occupancy, reachable, detector);
    assert.equal(detector.stats.checks, 2);
  });

  it("never prunes a solvable state (oracle exhaustive on tiny board)", () => {
    const parsed = parsePuzzleRows([
      "OOOOOO",
      "ORXX O",
      "O    O",
      "O SS O",
      "OOOOOO",
    ]);
    const board = compileSearchBoard(parsed);

    let falsePositives = 0;
    let solvableStates = 0;

    for (let left = 0; left < board.cellCount; left++) {
      for (let right = left + 1; right < board.cellCount; right++) {
        for (let robot = 0; robot < board.cellCount; robot++) {
          if (robot === left || robot === right) continue;

          const testBoxes: readonly DenseBox[] = [
            { id: "X:0", label: "X", cell: left },
            { id: "X:1", label: "X", cell: right },
          ];

          const exact = exactRemainingPushes(board, robot, testBoxes);
          if (exact === null) continue;
          solvableStates++;

          const pruned = checkCorral(board, testBoxes, robot);
          if (pruned) {
            falsePositives++;
          }
        }
      }
    }

    assert.equal(
      falsePositives,
      0,
      `Sealed corral produced ${falsePositives} false positives out of ${solvableStates} solvable states`,
    );
    assert.ok(solvableStates >= 50, `Expected broad solvable coverage; got ${solvableStates}`);
  });
});
