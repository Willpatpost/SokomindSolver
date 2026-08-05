import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parsePuzzleRows,
} from "../../src/core/index.ts";
import {
  minimumAssignment,
  minimumAssignmentCost,
} from "../../src/solver/search/assignment.ts";
import {
  compileSearchBoard,
  type CompiledSearchBoard,
} from "../../src/solver/search/compiled-board.ts";
import {
  createsFullyBlockedTwoByTwoDeadlock,
  isStaticDeadCell,
} from "../../src/solver/search/deadlocks.ts";
import {
  AssignmentHeuristic,
  assignmentLowerBound,
} from "../../src/solver/search/heuristic.ts";
import {
  canonicalBoxSignature,
  toDenseBoxes,
  type DenseBox,
} from "../../src/solver/search/model.ts";

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

/**
 * Independent step-state 0/1 BFS: walking costs zero and pushing costs one.
 *
 * It deliberately uses neither the assignment code nor either deadlock rule.
 */
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

  // Integer-keyed deque avoids Array.unshift while preserving 0/1 BFS order.
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

describe("compiled search board", () => {
  it("uses row-major dense ids and deterministic U/D/L/R neighbors", () => {
    const parsed = parsePuzzleRows([
      "OOOOOO",
      "OR   O",
      "O X SO",
      "OOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const center = board.cellAt(2, 2);

    assert.equal(board.cellCount, parsed.floor.length);
    assert.deepEqual(board.positions[center], { row: 2, column: 2 });
    assert.deepEqual(
      [...board.neighbors[center]].map((cell) =>
        cell < 0 ? null : board.positions[cell]),
      [
        { row: 1, column: 2 },
        null,
        { row: 2, column: 1 },
        { row: 2, column: 3 },
      ],
    );
    assert.equal(board.cellAt(-1, 0), -1);
    assert.equal(board.cellAt(0, 0), -1);
  });

  it("precomputes reverse pushes only when both box and support cells are floor", () => {
    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOOO",
      "OR   O",
      "O X SO",
      "OOOOOO",
    ]));
    const goal = board.goalCellsByLabel.get("X")?.[0];
    assert.notEqual(goal, undefined);
    const distances = board.reversePushDistancesByGoal.get(goal as number);

    assert.equal(distances?.[board.cellAt(2, 2)], 2);
    // The left corner cannot be pushed right because its support is a wall.
    assert.equal(distances?.[board.cellAt(2, 1)], -1);
  });
});

describe("deterministic Hungarian assignment", () => {
  it("returns the optimal matching and stable columns for ties", () => {
    assert.deepEqual(
      minimumAssignment([
        [4, 1, 3],
        [2, 0, 5],
        [3, 2, 2],
      ]),
      { cost: 5, columns: [1, 0, 2] },
    );
    assert.deepEqual(
      minimumAssignment([
        [1, 1],
        [1, 1],
      ]),
      { cost: 2, columns: [0, 1] },
    );
  });

  it("supports rectangular matrices and reports impossible finite matchings", () => {
    assert.equal(
      minimumAssignmentCost([
        [3, 1, 5],
        [2, 4, 1],
      ]),
      2,
    );
    assert.equal(
      minimumAssignmentCost([
        [1, Number.POSITIVE_INFINITY],
        [2, Number.POSITIVE_INFINITY],
      ]),
      Number.POSITIVE_INFINITY,
    );
    assert.throws(() => minimumAssignment([[1], [1, 2]]), RangeError);
    assert.throws(() => minimumAssignment([[Number.NaN]]), RangeError);
  });
});

describe("assignment heuristic", () => {
  it("canonicalizes same-label boxes without conflating different labels", () => {
    // canonicalBoxSignature requires pre-sorted input (label ascending,
    // then cell ascending) — the order produced by sortedBoxes() in engine.ts.
    const first = [
      { id: "A:0", label: "A", cell: 5 },
      { id: "X:1", label: "X", cell: 2 },
      { id: "X:0", label: "X", cell: 7 },
    ];
    const reordered = [
      { id: "renamed", label: "A", cell: 5 },
      { id: "other", label: "X", cell: 2 },
      { id: "another", label: "X", cell: 7 },
    ];
    const relabeled = [
      { id: "A:0", label: "A", cell: 7 },
      { id: "X:0", label: "X", cell: 2 },
      { id: "X:1", label: "X", cell: 5 },
    ];

    assert.equal(canonicalBoxSignature(first), canonicalBoxSignature(reordered));
    assert.notEqual(canonicalBoxSignature(first), canonicalBoxSignature(relabeled));
  });

  it("matches boxes only to goals carrying the same label", () => {
    const parsed = parsePuzzleRows([
      "OOOOOOOOO",
      "OR A a  O",
      "O  B b  O",
      "OOOOOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const initial = toDenseBoxes(board, parsed.initialBoxes);
    const swapped = [
      { ...initial[0], label: "B" },
      { ...initial[1], label: "A" },
    ];

    assert.equal(assignmentLowerBound(board, initial), 4);
    assert.equal(
      assignmentLowerBound(board, swapped),
      Number.POSITIVE_INFINITY,
    );
  });

  it("bounds its LRU cache and reports calls and hits exactly", () => {
    const parsed = parsePuzzleRows([
      "OOOOOOO",
      "OR XX O",
      "O SS  O",
      "O     O",
      "OOOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const initial = toDenseBoxes(board, parsed.initialBoxes);
    const heuristic = new AssignmentHeuristic(board, { maxCacheEntries: 2 });

    const first = heuristic.evaluate(initial);
    // canonicalBoxSignature now requires pre-sorted input.  Swapping box ids
    // while preserving sorted order tests that same-label boxes still share a
    // cache entry (ids are excluded from the canonical signature).
    const sameButRenamedIds = initial.map((box, i) => ({
      ...box,
      id: `renamed-${i}`,
    }));
    assert.equal(heuristic.evaluate(sameButRenamedIds), first);
    assert.deepEqual(heuristic.stats, {
      calls: 2,
      cacheHits: 1,
      cacheEntries: 1,
    });

    heuristic.evaluate([
      { ...initial[0], cell: board.cellAt(2, 2) },
      { ...initial[1], cell: board.cellAt(2, 3) },
    ]);
    heuristic.evaluate([
      { ...initial[0], cell: board.cellAt(3, 2) },
      { ...initial[1], cell: board.cellAt(3, 3) },
    ]);
    assert.equal(heuristic.stats.cacheEntries, 2);
    heuristic.clearCache();
    assert.equal(heuristic.stats.cacheEntries, 0);
  });

  it("never exceeds exact remaining pushes on an exhaustive tiny state family", () => {
    const parsed = parsePuzzleRows([
      "OOOOOO",
      "ORXX O",
      "O    O",
      "O SS O",
      "OOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    let solvableStates = 0;
    let checkedStates = 0;

    for (let left = 0; left < board.cellCount; left += 1) {
      for (let right = left + 1; right < board.cellCount; right += 1) {
        for (let robot = 0; robot < board.cellCount; robot += 1) {
          if (robot === left || robot === right) continue;
          const boxes: readonly DenseBox[] = [
            { id: "X:0", label: "X", cell: left },
            { id: "X:1", label: "X", cell: right },
          ];
          const exact = exactRemainingPushes(board, robot, boxes);
          checkedStates += 1;
          if (exact === null) continue;
          solvableStates += 1;
          const estimate = assignmentLowerBound(board, boxes);
          assert.ok(
            estimate <= exact,
            `h=${estimate} exceeded exact=${exact} for robot=${robot}, boxes=${left},${right}`,
          );
        }
      }
    }

    assert.equal(checkedStates, 660);
    assert.ok(solvableStates >= 50, `expected broad solvable coverage; got ${solvableStates}`);
  });
});

describe("conservative deadlocks", () => {
  it("marks reverse-push-inaccessible cells but never a matching goal", () => {
    const parsed = parsePuzzleRows([
      "OOOOOO",
      "OR   O",
      "OX  SO",
      "OOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const box = toDenseBoxes(board, parsed.initialBoxes)[0];
    const goal = board.goalCellsByLabel.get("X")?.[0];

    assert.equal(isStaticDeadCell(board, box.cell, box.label), true);
    assert.equal(isStaticDeadCell(board, board.cellAt(2, 2), "X"), false);
    assert.equal(isStaticDeadCell(board, goal as number, "X"), false);
    assert.equal(isStaticDeadCell(board, -1, "X"), true);
  });

  it("detects a fully blocked unsolved 2x2 and ignores an open square", () => {
    const parsed = parsePuzzleRows([
      "OOOOOOOO",
      "OR     O",
      "O XX   O",
      "O XX   O",
      "O SSSSO",
      "OOOOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const boxes = toDenseBoxes(board, parsed.initialBoxes);

    assert.equal(
      createsFullyBlockedTwoByTwoDeadlock(board, boxes, boxes[3].cell),
      true,
    );
    assert.equal(
      createsFullyBlockedTwoByTwoDeadlock(board, boxes.slice(1), boxes[3].cell),
      false,
    );
  });

  it("does not reject a fully occupied 2x2 when every box matches its goal", () => {
    const parsed = parsePuzzleRows([
      "OOOOOOOO",
      "ORXXXX O",
      "O SS   O",
      "O SS   O",
      "OOOOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const goalCells = [...(board.goalCellsByLabel.get("X") ?? [])];
    const boxes: readonly DenseBox[] = goalCells.map((cell, index) => ({
      id: `X:${index}`,
      label: "X",
      cell,
    }));

    assert.equal(goalCells.length, 4);
    assert.equal(createsFullyBlockedTwoByTwoDeadlock(board, boxes), false);
  });
});
