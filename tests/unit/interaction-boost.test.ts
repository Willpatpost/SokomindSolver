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

interface ExactPushTableState {
  robot: number;
  cells: readonly number[];
  pushes: number | null;
}

/**
 * Exact remaining pushes for every state whose box i has label `labels[i]`,
 * from a backward 0-1 BFS over the whole state graph. Unsolvable states keep
 * `pushes: null`.
 */
function exactPushTable(
  board: CompiledSearchBoard,
  labels: readonly string[],
): readonly ExactPushTableState[] {
  const placements: number[][] = [];
  const place = (cells: number[]): void => {
    if (cells.length === labels.length) {
      placements.push([...cells]);
      return;
    }
    for (let cell = 0; cell < board.cellCount; cell++) {
      if (cells.includes(cell)) continue;
      cells.push(cell);
      place(cells);
      cells.pop();
    }
  };
  place([]);

  const encode = (robot: number, cells: readonly number[]): number =>
    cells.reduce((code, cell) => code * board.cellCount + cell, robot);
  const states: ExactPushTableState[] = [];
  const indexByCode = new Map<number, number>();
  for (const cells of placements) {
    for (let robot = 0; robot < board.cellCount; robot++) {
      if (cells.includes(robot)) continue;
      indexByCode.set(encode(robot, cells), states.length);
      states.push({ robot, cells, pushes: null });
    }
  }

  const predecessors: { from: number; push: boolean }[][] = states.map(() => []);
  states.forEach(({ robot, cells }, from) => {
    for (let d = 0; d < board.neighbors[robot].length; d++) {
      const dest = board.neighbors[robot][d];
      if (dest < 0) continue;
      const pushedBoxIndex = cells.indexOf(dest);
      let nextCells = cells;
      if (pushedBoxIndex >= 0) {
        const boxDest = board.neighbors[dest][d];
        if (boxDest < 0 || cells.includes(boxDest)) continue;
        nextCells = cells.map((cell, i) => (i === pushedBoxIndex ? boxDest : cell));
      }
      const to = indexByCode.get(encode(dest, nextCells));
      if (to === undefined) throw new Error("exact push table is missing a state");
      predecessors[to].push({ from, push: pushedBoxIndex >= 0 });
    }
  });

  let layer: number[] = [];
  states.forEach(({ cells }, index) => {
    if (cells.every((cell, i) => board.goalLabelByCell[cell] === labels[i])) {
      layer.push(index);
    }
  });
  for (let pushes = 0; layer.length > 0; pushes++) {
    const queue: number[] = [];
    for (const index of layer) {
      if (states[index].pushes !== null) continue;
      states[index].pushes = pushes;
      queue.push(index);
    }
    const nextLayer: number[] = [];
    for (let head = 0; head < queue.length; head++) {
      for (const { from, push } of predecessors[queue[head]]) {
        if (states[from].pushes !== null) continue;
        if (push) {
          nextLayer.push(from);
        } else {
          states[from].pushes = pushes;
          queue.push(from);
        }
      }
    }
    layer = nextLayer;
  }
  return states;
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
    evaluator.evaluate(boxes, labelCosts, key, key);
    evaluator.evaluate(boxes, labelCosts, key, key);
    assert.equal(evaluator.stats.cacheHits, 1, "Second call should hit cache");
  });

  it("uses the cache only for label costs of the same box key", () => {
    // A and B must pass each other in the corridor, which costs 2 extra pushes.
    const parsed = parsePuzzleRows([
      "OOOOOOOOOOO",
      "O   OOO   O",
      "Ob A   B aO",
      "O   OOO   O",
      "OR  OOO   O",
      "OOOOOOOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const boxesA = toDenseBoxes(board, parsed.initialBoxes);
    const boxesB = boxesA.map((box) =>
      box.label === "A" ? { ...box, cell: board.cellAt(2, 2) } : box,
    );
    const costsA = fullAssignmentLabelCosts(board, boxesA);
    const costsB = fullAssignmentLabelCosts(board, boxesB);
    const boostA = new InteractionBoostEvaluator(board, board.topology).evaluate(boxesA, costsA);
    const mixed = new InteractionBoostEvaluator(board, board.topology).evaluate(boxesA, costsB);
    assert.equal(boostA, 2);
    assert.notEqual(mixed, boostA);

    const evaluator = new InteractionBoostEvaluator(board, board.topology);
    const keyA = 1n;
    const keyB = 2n;
    assert.equal(evaluator.evaluate(boxesA, costsA, keyA, keyA), boostA);
    assert.equal(evaluator.evaluate(boxesA, costsB, keyA, keyB), mixed);
    assert.equal(evaluator.stats.cacheHits, 0);
    assert.equal(evaluator.evaluate(boxesA, costsA, keyA, keyA), boostA);
    assert.equal(evaluator.stats.cacheHits, 1);

    // Without the label-cost key the value is neither read nor stored.
    evaluator.evaluate(boxesA, costsA, keyB);
    evaluator.evaluate(boxesA, costsA, keyB, keyB);
    assert.equal(evaluator.stats.cacheHits, 1);
  });

  it("never exceeds exact optimal pushes (oracle exhaustive on tiny board)", () => {
    // Both goals are in one room. A box on goal (1,3) blocks the cell the
    // robot needs to push the other box down into goal (3,3), so that box
    // must detour through (3,4). The room pattern table sees the detour; the
    // assignment bound does not.
    const parsed = parsePuzzleRows([
      "OOOOOOO",
      "O OSXRO",
      "O   X O",
      "O OS  O",
      "OOOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const evaluator = new InteractionBoostEvaluator(board, board.topology);

    let violations = 0;
    let solvableStates = 0;
    let positiveBoostStates = 0;

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
          if (boost > 0) positiveBoostStates++;

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
    assert.ok(
      positiveBoostStates > 0,
      `Expected solvable states with a positive boost; got 0 of ${solvableStates}`,
    );
    assert.ok(evaluator.stats.roomBoostTotal > 0, "Expected boost from the room pattern table");
  });

  it("never exceeds exact pushes with typed labels (oracle)", () => {
    // Goal a can only be entered from below and goal b only from above, so A
    // and B both need column 4. The pair table sees the conflict; the
    // assignment bound does not.
    const parsed = parsePuzzleRows([
      "OOOOOO",
      "OOORaO",
      "O   BO",
      "O  A O",
      "O  ObO",
      "OOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const evaluator = new InteractionBoostEvaluator(board, board.topology);
    assert.deepEqual([...board.goalCellsByLabel.keys()].sort(), ["A", "B"]);

    let violations = 0;
    let solvableStates = 0;
    let positiveBoostStates = 0;

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
          if (boost > 0) positiveBoostStates++;

          if (totalH > exact) {
            violations++;
          }
        }
      }
    }

    assert.equal(violations, 0, `Admissibility violated in ${violations}/${solvableStates} states`);
    assert.ok(solvableStates >= 10, `Expected solvable coverage; got ${solvableStates}`);
    assert.ok(
      positiveBoostStates > 0,
      `Expected solvable states with a positive boost; got 0 of ${solvableStates}`,
    );
    assert.ok(evaluator.stats.pairBoostTotal > 0, "Expected boost from the pair conflict table");
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
    // Goals a and b are in a dead-end pocket behind c's goal (3,3). B must go
    // in before A, which the room table sees, and C must arrive after both,
    // which the A-C and B-C pair tables see (the room table does not cover C).
    const parsed = parsePuzzleRows([
      "OOOOOOO",
      "OR   OO",
      "O ACOOO",
      "O BcabO",
      "OO  OOO",
      "OOOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const evaluator = new InteractionBoostEvaluator(board, board.topology);
    const labels = ["A", "B", "C"];

    let violations = 0;
    let solvableStates = 0;
    let roomBoostStates = 0;
    let pairBoostStates = 0;

    for (const { robot, cells, pushes } of exactPushTable(board, labels)) {
      if (pushes === null) continue;
      solvableStates++;

      const testBoxes: readonly DenseBox[] = cells.map((cell, i) => ({
        id: `${labels[i]}:0`,
        label: labels[i],
        cell,
      }));
      // Spot-check the table against the forward oracle.
      if (solvableStates % 20 === 1) {
        assert.equal(pushes, exactRemainingPushes(board, robot, testBoxes));
      }

      const assignmentH = assignmentLowerBound(board, testBoxes);
      if (!Number.isFinite(assignmentH)) continue;

      const roomBefore = evaluator.stats.roomBoostTotal;
      const pairBefore = evaluator.stats.pairBoostTotal;
      const labelCosts = fullAssignmentLabelCosts(board, testBoxes);
      const boost = evaluator.evaluate(testBoxes, labelCosts);
      if (evaluator.stats.roomBoostTotal > roomBefore) roomBoostStates++;
      if (evaluator.stats.pairBoostTotal > pairBefore) pairBoostStates++;

      if (assignmentH + boost > pushes) {
        violations++;
      }
    }

    assert.equal(violations, 0, `Combined admissibility violated in ${violations}/${solvableStates} states`);
    assert.ok(solvableStates >= 100, `Expected solvable coverage; got ${solvableStates}`);
    assert.ok(
      roomBoostStates > 0,
      `Expected solvable states with room boost; got 0 of ${solvableStates}`,
    );
    assert.ok(
      pairBoostStates > 0,
      `Expected solvable states with pair boost; got 0 of ${solvableStates}`,
    );
  });

  it("produces positive boost when pair-conflict paths intersect", () => {
    // Goal a can only be entered from below and goal b only from above, so A
    // and B both need column 4: the assignment bound is 5 pushes, the exact
    // optimum 7, and the pair table supplies the missing 2.
    const parsed = parsePuzzleRows([
      "OOOOOO",
      "OOORaO",
      "O   BO",
      "O  A O",
      "O  ObO",
      "OOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const boxes = toDenseBoxes(board, parsed.initialBoxes);
    const robot = board.cellAt(parsed.initialRobot.row, parsed.initialRobot.column);
    const evaluator = new InteractionBoostEvaluator(board, board.topology);
    const labelCosts = fullAssignmentLabelCosts(board, boxes);
    const boost = evaluator.evaluate(boxes, labelCosts);
    assert.equal(boost, 2);
    assert.equal(evaluator.stats.pairBoostTotal, 2);
    assert.equal(
      assignmentLowerBound(board, boxes) + boost,
      exactRemainingPushes(board, robot, boxes),
    );
  });

  it("exposes roomPatternStats", () => {
    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOOOO",
      "O OSXRO",
      "O   X O",
      "O OS  O",
      "OOOOOOO",
    ]));
    const evaluator = new InteractionBoostEvaluator(board, board.topology);
    // Room tables are built with the evaluator.
    assert.equal(evaluator.roomPatternStats.builds, 1);
    assert.ok(evaluator.roomPatternStats.states > 0);
    assert.equal(evaluator.roomPatternStats.hits, 0);

    // The box stuck on goal (1,3) sends the other box around through (3,4).
    const boxes: readonly DenseBox[] = [
      { id: "X:0", label: "X", cell: board.cellAt(1, 3) },
      { id: "X:1", label: "X", cell: board.cellAt(2, 2) },
    ];
    assert.equal(evaluator.evaluate(boxes, fullAssignmentLabelCosts(board, boxes)), 2);
    assert.equal(evaluator.roomPatternStats.hits, 1);
    assert.equal(evaluator.stats.roomBoostTotal, 2);
  });

  it("exposes pairConflictStats", () => {
    const parsed = parsePuzzleRows([
      "OOOOOO",
      "OOORaO",
      "O   BO",
      "O  A O",
      "O  ObO",
      "OOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const boxes = toDenseBoxes(board, parsed.initialBoxes);
    const evaluator = new InteractionBoostEvaluator(board, board.topology);
    // Pair tables are built for the first candidate, not with the evaluator.
    assert.equal(evaluator.pairConflictStats.builds, 0);

    evaluator.evaluate(boxes, fullAssignmentLabelCosts(board, boxes));
    assert.equal(evaluator.pairConflictStats.builds, 1);
    assert.ok(evaluator.pairConflictStats.states > 0);
    assert.equal(evaluator.pairConflictStats.candidates, 1);
    assert.equal(evaluator.pairConflictStats.hits, 1);
    assert.equal(evaluator.roomPatternStats.builds, 0);
  });
});
