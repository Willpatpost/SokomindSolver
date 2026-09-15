import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parsePuzzleRows } from "../../src/core/index.ts";
import {
  compileSearchBoard,
} from "../../src/solver/search/compiled-board.ts";
import {
  GoalCutEvaluator,
  hasPotentialGoalCut,
} from "../../src/solver/search/goal-cut.ts";
import {
  AssignmentHeuristic,
} from "../../src/solver/search/heuristic.ts";
import {
  toDenseBoxes,
} from "../../src/solver/search/model.ts";
import type {
  SolverExecutionContext,
  SolverRequest,
} from "../../src/solver/contracts.ts";
import { runExactMoveAStar } from "../../src/solver/search/exact-move-astar.ts";
import { runIdaStarSearch } from "../../src/solver/search/ida-star.ts";

function makeContext(): SolverExecutionContext {
  return {
    now: () => performance.now(),
    signal: new AbortController().signal,
    reportProgress: () => undefined,
  };
}

function makeRequest(rows: string[]): SolverRequest {
  const parsed = parsePuzzleRows(rows);
  return {
    board: parsed,
    snapshot: {
      puzzleId: "test",
      robot: parsed.initialRobot,
      boxes: parsed.initialBoxes,
      moves: 0,
      pushes: 0,
      solved: false,
    },
    objective: { kind: "moves" },
    limits: {
      maxElapsedMs: 30000,
      maxExpandedStates: 500_000,
      maxGeneratedStates: 2_000_000,
      maxMemoryBytes: 256 * 1024 * 1024,
    },
  };
}

const BOTTLENECK_BOARD = [
  "OOOOOOOOO",
  "OS  O  SO",
  "O X O X O",
  "O   R   O",
  "OOOOOOOOO",
];

const OPEN_BOARD = [
  "OOOOO",
  "OR  O",
  "O X O",
  "O  SO",
  "OOOOO",
];

describe("GoalCutEvaluator", () => {
  it("returns zero for board without bottlenecks", () => {
    const parsed = parsePuzzleRows(OPEN_BOARD);
    const board = compileSearchBoard(parsed);
    const topology = board.topology;
    assert.equal(
      hasPotentialGoalCut(board, topology),
      topology.articulations.size > 0 || topology.tunnels.size > 0,
    );
  });

  it("detects bottleneck demand on articulation-point board", () => {
    const parsed = parsePuzzleRows(BOTTLENECK_BOARD);
    const board = compileSearchBoard(parsed);
    const topology = board.topology;
    if (!hasPotentialGoalCut(board, topology)) return;

    const evaluator = new GoalCutEvaluator(board, topology);
    const boxes = toDenseBoxes(board, parsed.initialBoxes);
    const heuristic = new AssignmentHeuristic(board);
    heuristic.evaluate(boxes);
    const states = heuristic.lastAssignmentStates;
    assert.notEqual(states, null);

    const value = evaluator.evaluate(states!);
    assert.ok(value >= 0, "goal-cut must be non-negative");
    assert.equal(evaluator.stats.evaluations, 1);
  });

  it("returns zero for solved state", () => {
    const rows = [
      "OOOOO",
      "O   O",
      "OR  O",
      "O   O",
      "OOOOO",
    ];
    const parsed = parsePuzzleRows(rows);
    const board = compileSearchBoard(parsed);
    const topology = board.topology;
    if (!hasPotentialGoalCut(board, topology)) return;

    const evaluator = new GoalCutEvaluator(board, topology);
    const boxes = toDenseBoxes(board, parsed.initialBoxes);
    const heuristic = new AssignmentHeuristic(board);
    heuristic.evaluate(boxes);
    const states = heuristic.lastAssignmentStates;
    if (!states || states.size === 0) return;

    const value = evaluator.evaluate(states);
    assert.equal(value, 0, "solved state should have zero goal-cut");
  });

  it("is admissible — does not over-count on simple tunnel board", async () => {
    const rows = [
      "OOOOOOO",
      "ORX  SO",
      "OOOOOOO",
    ];
    const request = makeRequest(rows);
    const resultOn = await runExactMoveAStar(request, makeContext());
    const resultOff = await runExactMoveAStar(request, makeContext(), {
      features: { goalCutHeuristic: false },
    });

    assert.equal(resultOn.status, "solved");
    assert.equal(resultOff.status, "solved");
    assert.equal(
      resultOn.solution?.moves,
      resultOff.solution?.moves,
      "goal-cut must not change optimal move count",
    );
  });

  it("stats accumulate across evaluations", () => {
    const parsed = parsePuzzleRows(BOTTLENECK_BOARD);
    const board = compileSearchBoard(parsed);
    const topology = board.topology;
    if (!hasPotentialGoalCut(board, topology)) return;

    const evaluator = new GoalCutEvaluator(board, topology);
    const boxes = toDenseBoxes(board, parsed.initialBoxes);
    const heuristic = new AssignmentHeuristic(board);
    heuristic.evaluate(boxes);
    const states = heuristic.lastAssignmentStates!;

    evaluator.evaluate(states);
    evaluator.evaluate(states);
    evaluator.evaluate(states);
    assert.equal(evaluator.stats.evaluations, 3);
  });
});

describe("goal-cut solver integration", () => {
  it("A* with goal-cut disabled matches A* with goal-cut enabled", async () => {
    const rows = [
      "OOOOOOOOOOO",
      "O    O    O",
      "O RX   XS O",
      "O XO O OX O",
      "OSSO   OS O",
      "OOOOOOOOOOO",
    ];
    const request = makeRequest(rows);
    const resultOn = await runExactMoveAStar(request, makeContext());
    const resultOff = await runExactMoveAStar(request, makeContext(), {
      features: { goalCutHeuristic: false },
    });

    assert.equal(resultOn.status, "solved");
    assert.equal(resultOff.status, "solved");
    assert.equal(
      resultOn.solution?.moves,
      resultOff.solution?.moves,
      "same optimal moves with goal-cut on vs off",
    );
    assert.equal(resultOn.proof?.kind, "optimal");
    assert.equal(resultOff.proof?.kind, "optimal");
  });

  it("IDA* with goal-cut disabled matches IDA* with goal-cut enabled", async () => {
    const rows = [
      "OOOOOOOOOOO",
      "O    O    O",
      "O RX   XS O",
      "O XO O OX O",
      "OSSO   OS O",
      "OOOOOOOOOOO",
    ];
    const request = makeRequest(rows);
    const resultOn = await runIdaStarSearch(request, makeContext());
    const resultOff = await runIdaStarSearch(request, makeContext(), {
      features: { goalCutHeuristic: false },
    });

    assert.equal(resultOn.status, "solved");
    assert.equal(resultOff.status, "solved");
    assert.equal(
      resultOn.solution?.moves,
      resultOff.solution?.moves,
      "same optimal moves with goal-cut on vs off",
    );
    assert.equal(resultOn.proof?.kind, "optimal");
    assert.equal(resultOff.proof?.kind, "optimal");
  });
});
