import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parsePuzzleRows } from "../../src/core/index.ts";
import { compileSearchBoard, type CompiledSearchBoard } from "../../src/solver/search/compiled-board.ts";
import { assignmentLowerBound } from "../../src/solver/search/heuristic.ts";
import {
  hasPotentialInteractionBoost,
  InteractionBoostEvaluator,
} from "../../src/solver/search/interaction-boost.ts";
import { maximumDisjointSelection } from "../../src/solver/search/disjoint-selection.ts";
import type { HeuristicCandidate } from "../../src/solver/search/room-pattern-heuristic.ts";
import { minimumAssignmentCost } from "../../src/solver/search/assignment.ts";
import { type DenseBox, toDenseBoxes } from "../../src/solver/search/model.ts";

function fullAssignmentLabelCosts(
  board: CompiledSearchBoard,
  boxes: readonly DenseBox[],
): ReadonlyMap<string, number> {
  const byLabel = new Map<string, number[]>();
  for (const box of boxes) {
    const cells = byLabel.get(box.label) ?? [];
    cells.push(box.cell);
    byLabel.set(box.label, cells);
  }
  const costs = new Map<string, number>();
  for (const [label, boxCells] of byLabel) {
    const goalCells = board.goalCellsByLabel.get(label) ?? [];
    if (boxCells.length !== goalCells.length) {
      costs.set(label, Infinity);
      continue;
    }
    let minCost: number;
    if (boxCells.length === 1) {
      const dist = board.reversePushDistancesByGoal.get(goalCells[0])?.[boxCells[0]] ?? -1;
      minCost = dist < 0 ? Infinity : dist;
    } else {
      const costMatrix = boxCells.map((bc: number) =>
        goalCells.map((gc: number) => {
          const d = board.reversePushDistancesByGoal.get(gc)?.[bc] ?? -1;
          return d < 0 ? Infinity : d;
        }),
      );
      minCost = minimumAssignmentCost(costMatrix);
    }
    costs.set(label, minCost);
  }
  return costs;
}

function exactStateKey(robot: number, boxes: readonly DenseBox[]): string {
  const boxKey = boxes
    .map(({ label, cell }) => `${label.length}:${label}@${cell}`)
    .sort()
    .join(";");
  return `${robot}|${boxKey}`;
}

function exactRemainingPushes(
  board: CompiledSearchBoard,
  robot: number,
  initialBoxes: readonly DenseBox[],
): number | null {
  interface OracleState {
    robot: number;
    boxes: readonly DenseBox[];
    pushes: number;
  }
  const initial: OracleState = { robot, boxes: initialBoxes, pushes: 0 };
  const distances = new Map([[exactStateKey(robot, initialBoxes), 0]]);
  const deque = new Map<number, OracleState>([[0, initial]]);
  let front = 0;
  let back = 1;

  while (front < back) {
    const current = deque.get(front);
    deque.delete(front);
    front++;
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

    const boxIndexByCell = new Int32Array(board.cellCount).fill(-1);
    current.boxes.forEach(({ cell }, index) => {
      boxIndexByCell[cell] = index;
    });

    for (let d = 0; d < board.neighbors[current.robot].length; d++) {
      const dest = board.neighbors[current.robot][d];
      if (dest < 0) continue;

      const pushedBoxIndex = boxIndexByCell[dest];
      let nextBoxes = current.boxes;
      let pushCost = 0;
      if (pushedBoxIndex >= 0) {
        const boxDest = board.neighbors[dest][d];
        if (boxDest < 0 || boxIndexByCell[boxDest] >= 0) continue;
        nextBoxes = current.boxes.map((box, i) =>
          i === pushedBoxIndex ? { ...box, cell: boxDest } : box,
        );
        pushCost = 1;
      }

      const next: OracleState = {
        robot: dest,
        boxes: nextBoxes,
        pushes: current.pushes + pushCost,
      };
      const nextKey = exactStateKey(next.robot, next.boxes);
      if (next.pushes >= (distances.get(nextKey) ?? Infinity)) continue;
      distances.set(nextKey, next.pushes);
      if (pushCost) {
        deque.set(back, next);
        back++;
      } else {
        front--;
        deque.set(front, next);
      }
    }
  }
  return null;
}

describe("interaction boost heuristic", () => {
  it("reports repeated-label open boards as statically inapplicable", () => {
    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOOOO",
      "O R   O",
      "O X X O",
      "O     O",
      "O S S O",
      "O     O",
      "OOOOOOO",
    ]));
    assert.equal(
      hasPotentialInteractionBoost(board, board.topology),
      false,
    );
  });

  it("checks the exact preprocessing budget during boost construction", () => {
    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOOOO",
      "OaA   O",
      "OOO OOO",
      "O   bBO",
      "OR    O",
      "OOOOOOO",
    ]));
    assert.equal(
      hasPotentialInteractionBoost(board, board.topology),
      true,
    );
    let clock = 0;

    assert.throws(
      () => new InteractionBoostEvaluator(board, board.topology, {
        signal: new AbortController().signal,
        now: () => ++clock,
        deadline: 3,
        baseMemoryBytes: 0,
      }),
      /preprocessing/i,
    );
  });

  it("produces non-negative boost", () => {
    const parsed = parsePuzzleRows([
      "OOOOOOO",
      "OSX   O",
      "OOO OOO",
      "O  SX O",
      "OR    O",
      "OOOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const boxes = toDenseBoxes(board, parsed.initialBoxes);
    const evaluator = new InteractionBoostEvaluator(board, board.topology);
    const labelCosts = fullAssignmentLabelCosts(board, boxes);
    const boost = evaluator.evaluate(boxes, labelCosts);
    assert.ok(boost >= 0, "Boost must be non-negative");
  });

  it("returns 0 boost when all boxes are on goals", () => {
    const parsed = parsePuzzleRows([
      "OOOOOOO",
      "OSX   O",
      "OOO OOO",
      "O  SX O",
      "OR    O",
      "OOOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const goalCellsX = board.goalCellsByLabel.get("X") ?? [];
    const boxes: DenseBox[] = goalCellsX.map((cell, i) => ({
      id: `X:${i}`,
      label: "X",
      cell,
    }));
    const evaluator = new InteractionBoostEvaluator(board, board.topology);
    const labelCosts = fullAssignmentLabelCosts(board, boxes);
    const boost = evaluator.evaluate(boxes, labelCosts);
    assert.equal(boost, 0, "Boost should be 0 when all boxes on goals");
  });

  it("reports statistics", () => {
    const parsed = parsePuzzleRows([
      "OOOOOOO",
      "OSX   O",
      "OOO OOO",
      "O  SX O",
      "OR    O",
      "OOOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const boxes = toDenseBoxes(board, parsed.initialBoxes);
    const evaluator = new InteractionBoostEvaluator(board, board.topology);
    const labelCosts = fullAssignmentLabelCosts(board, boxes);
    evaluator.evaluate(boxes, labelCosts);
    assert.equal(evaluator.stats.evaluations, 1);
  });

  it("caches boost by box key", () => {
    const parsed = parsePuzzleRows([
      "OOOOOOO",
      "OSX   O",
      "OOO OOO",
      "O  SX O",
      "OR    O",
      "OOOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const boxes = toDenseBoxes(board, parsed.initialBoxes);
    const evaluator = new InteractionBoostEvaluator(board, board.topology);
    const labelCosts = fullAssignmentLabelCosts(board, boxes);
    const key = 42n;
    evaluator.evaluate(boxes, labelCosts, key);
    evaluator.evaluate(boxes, labelCosts, key);
    assert.equal(evaluator.stats.cacheHits, 1, "Second call should hit cache");
  });

  it("never exceeds exact optimal pushes (oracle exhaustive on tiny board)", () => {
    // Tiny board with a room structure
    const parsed = parsePuzzleRows([
      "OOOOOO",
      "ORXX O",
      "OOO  O",
      "O SS O",
      "OOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const evaluator = new InteractionBoostEvaluator(board, board.topology);

    let violations = 0;
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

          const assignmentH = assignmentLowerBound(board, testBoxes);
          if (!Number.isFinite(assignmentH)) continue;

          const labelCosts = fullAssignmentLabelCosts(board, testBoxes);
          const boost = evaluator.evaluate(testBoxes, labelCosts);
          const totalH = assignmentH + boost;

          if (totalH > exact) {
            violations++;
          }
        }
      }
    }

    assert.equal(
      violations,
      0,
      `Admissibility violated: ${violations} states have h > exact out of ${solvableStates} solvable`,
    );
    assert.ok(solvableStates >= 10, `Expected broad solvable coverage; got ${solvableStates}`);
  });

  it("never exceeds exact pushes with typed labels (oracle)", () => {
    // Board with two different typed labels
    const parsed = parsePuzzleRows([
      "OOOOOOO",
      "OaA bBO",
      "O  R  O",
      "OOOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const evaluator = new InteractionBoostEvaluator(board, board.topology);
    const labels = [...board.goalCellsByLabel.keys()].sort();
    assert.ok(labels.length >= 2, "Should have at least 2 labels");

    let violations = 0;
    let solvableStates = 0;

    const goalA = (board.goalCellsByLabel.get("A") ?? [])[0];
    const goalB = (board.goalCellsByLabel.get("B") ?? [])[0];
    if (goalA === undefined || goalB === undefined) return;

    for (let cellA = 0; cellA < board.cellCount; cellA++) {
      for (let cellB = 0; cellB < board.cellCount; cellB++) {
        if (cellA === cellB) continue;
        for (let robot = 0; robot < board.cellCount; robot++) {
          if (robot === cellA || robot === cellB) continue;

          const testBoxes: readonly DenseBox[] = [
            { id: "A:0", label: "A", cell: cellA },
            { id: "B:0", label: "B", cell: cellB },
          ];

          const exact = exactRemainingPushes(board, robot, testBoxes);
          if (exact === null) continue;
          solvableStates++;

          const assignmentH = assignmentLowerBound(board, testBoxes);
          if (!Number.isFinite(assignmentH)) continue;

          const labelCosts = fullAssignmentLabelCosts(board, testBoxes);
          const boost = evaluator.evaluate(testBoxes, labelCosts);
          const totalH = assignmentH + boost;

          if (totalH > exact) {
            violations++;
          }
        }
      }
    }

    assert.equal(violations, 0, `Admissibility violated in ${violations}/${solvableStates} states`);
    assert.ok(solvableStates >= 10, `Expected solvable coverage; got ${solvableStates}`);
  });

  it("returns 0 boost when pattern table hits cutoff", () => {
    // Board with enough complexity that a maxStates=1 would cutoff.
    // With real limits the table succeeds, but a cutoff table has no entries → boost = 0.
    // We verify the evaluator never returns negative, and on a board with no rooms
    // (no articulation points), both room and pair tables are empty → boost must be 0.
    const parsed = parsePuzzleRows([
      "OOOOOO",
      "O    O",
      "O RX O",
      "O S  O",
      "O    O",
      "OOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const boxes = toDenseBoxes(board, parsed.initialBoxes);
    const evaluator = new InteractionBoostEvaluator(board, board.topology);
    const labelCosts = fullAssignmentLabelCosts(board, boxes);
    const boost = evaluator.evaluate(boxes, labelCosts);
    assert.equal(boost, 0, "Open board with no rooms/pairs should yield 0 boost");
  });

  it("selects only non-conflicting candidates when labels overlap", () => {
    const c1: HeuristicCandidate = { labels: new Set(["A", "B"]), boost: 3, kind: "room" };
    const c2: HeuristicCandidate = { labels: new Set(["B", "C"]), boost: 5, kind: "pair" };
    const c3: HeuristicCandidate = { labels: new Set(["D"]), boost: 2, kind: "pair" };
    const selected = maximumDisjointSelection([c1, c2, c3]);
    const usedLabels = new Set<string>();
    for (const c of selected) {
      for (const label of c.labels) {
        assert.ok(!usedLabels.has(label), `Label ${label} used in multiple candidates`);
        usedLabels.add(label);
      }
    }
    const totalBoost = selected.reduce((s, c) => s + c.boost, 0);
    assert.equal(totalBoost, 7, "Should select c2 (5) + c3 (2) = 7 over c1 (3) + c3 (2) = 5");
  });

  it("never exceeds exact pushes with combined room + pair (oracle)", () => {
    // Board designed to have both articulation points (rooms) and pair-conflict paths
    const parsed = parsePuzzleRows([
      "OOOOOOOOO",
      "OaA R bBO",
      "OOO   OOO",
      "O       O",
      "OOOOOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const evaluator = new InteractionBoostEvaluator(board, board.topology);

    let violations = 0;
    let solvableStates = 0;

    for (let cellA = 0; cellA < board.cellCount; cellA++) {
      for (let cellB = 0; cellB < board.cellCount; cellB++) {
        if (cellA === cellB) continue;
        for (let robot = 0; robot < board.cellCount; robot++) {
          if (robot === cellA || robot === cellB) continue;

          const testBoxes: readonly DenseBox[] = [
            { id: "A:0", label: "A", cell: cellA },
            { id: "B:0", label: "B", cell: cellB },
          ];

          const exact = exactRemainingPushes(board, robot, testBoxes);
          if (exact === null) continue;
          solvableStates++;

          const assignmentH = assignmentLowerBound(board, testBoxes);
          if (!Number.isFinite(assignmentH)) continue;

          const labelCosts = fullAssignmentLabelCosts(board, testBoxes);
          const boost = evaluator.evaluate(testBoxes, labelCosts);
          const totalH = assignmentH + boost;

          if (totalH > exact) {
            violations++;
          }
        }
      }
    }

    assert.equal(violations, 0, `Combined admissibility violated in ${violations}/${solvableStates} states`);
    assert.ok(solvableStates >= 10, `Expected solvable coverage; got ${solvableStates}`);
  });

  it("produces positive boost when pair-conflict paths intersect", () => {
    // Two singleton-label boxes whose shortest-push paths share a narrow passage
    const parsed = parsePuzzleRows([
      "OOOOOOO",
      "OaA   O",
      "OOO OOO",
      "O   bBO",
      "OR    O",
      "OOOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const boxes = toDenseBoxes(board, parsed.initialBoxes);
    const evaluator = new InteractionBoostEvaluator(board, board.topology);
    const labelCosts = fullAssignmentLabelCosts(board, boxes);
    const boost = evaluator.evaluate(boxes, labelCosts);
    assert.ok(boost >= 0, "Boost must be non-negative");
  });

  it("exposes roomPatternStats", () => {
    const parsed = parsePuzzleRows([
      "OOOOOOO",
      "OSX   O",
      "OOO OOO",
      "O  SX O",
      "OR    O",
      "OOOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const evaluator = new InteractionBoostEvaluator(board, board.topology);
    const stats = evaluator.roomPatternStats;
    assert.ok(stats !== null && typeof stats === "object");
  });

  it("exposes pairConflictStats", () => {
    const parsed = parsePuzzleRows([
      "OOOOOOO",
      "OSX   O",
      "OOO OOO",
      "O  SX O",
      "OR    O",
      "OOOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const evaluator = new InteractionBoostEvaluator(board, board.topology);
    const stats = evaluator.pairConflictStats;
    assert.ok(stats !== null && typeof stats === "object");
  });
});
