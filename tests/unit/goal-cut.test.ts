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
  minimumManhattanWalkToPotentialPush,
} from "../../src/solver/search/heuristic.ts";
import {
  toDenseBoxes,
} from "../../src/solver/search/model.ts";
import { DEFAULT_EXACT_SEARCH_FEATURES } from "../../src/solver/search/exact-search-features.ts";
import type {
  SolverExecutionContext,
  SolverRequest,
} from "../../src/solver/contracts.ts";
import { runExactMoveAStar } from "../../src/solver/search/exact-move-astar.ts";
import { runIdaStarSearch } from "../../src/solver/search/ida-star.ts";
import {
  allReachableStates,
  exactRemainingMoves,
} from "../support/exact-solver-oracle.ts";

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

// The right box's only route to a goal crosses the tunnel cell (3,6), which
// is also the left box's goal. The boxes cross it one after the other, so the
// bottleneck surplus buys no extra pushes.
const SHARED_TUNNEL_BOARD = [
  "OOOOOOOO",
  "O   O  O",
  "O A R AO",
  "OOO OOaO",
  "O     aO",
  "OOOOOOOO",
];

const SHARED_TUNNEL_X_BOARD = [
  "OOOOOOOOO",
  "O   O   O",
  "O X R X O",
  "OOO OOO O",
  "O  S   SO",
  "OOOOOOOOO",
];

function compileRows(rows: readonly string[]) {
  const parsed = parsePuzzleRows(rows);
  const board = compileSearchBoard(parsed);
  return {
    board,
    boxes: toDenseBoxes(board, parsed.initialBoxes),
    robot: board.cellAt(parsed.initialRobot.row, parsed.initialRobot.column),
  };
}

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
    const resultOn = await runExactMoveAStar(request, makeContext(), {
      features: { goalCutHeuristic: true },
    });
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
    const resultOn = await runExactMoveAStar(request, makeContext(), {
      features: { goalCutHeuristic: true },
    });
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
    const resultOn = await runIdaStarSearch(request, makeContext(), {
      features: { goalCutHeuristic: true },
    });
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

describe("goal-cut admissibility", () => {
  it("is off by default", () => {
    assert.equal(DEFAULT_EXACT_SEARCH_FEATURES.goalCutHeuristic, false);
  });

  it("is not a push lower bound", () => {
    const { board, boxes, robot } = compileRows(SHARED_TUNNEL_BOARD);
    const heuristic = new AssignmentHeuristic(board, { maxCacheEntries: 0 });
    const pushBound = heuristic.evaluate(boxes);
    const surplus = new GoalCutEvaluator(board, board.topology)
      .evaluate(heuristic.lastAssignmentStates!);
    const oracle = exactRemainingMoves(board, robot, boxes);
    // The move optimum uses as many pushes as the assignment bound, so that
    // count is also the push optimum.
    assert.equal(pushBound, 7);
    assert.equal(oracle.exactPushes, 7);
    assert.equal(oracle.exactMoves, 20);
    assert.equal(surplus, 2);
    assert.ok(pushBound + surplus > oracle.exactPushes!);
  });

  for (const [name, rows] of [
    ["typed", SHARED_TUNNEL_BOARD],
    ["X", SHARED_TUNNEL_X_BOARD],
  ] as const) {
    it(`stays within the exact remaining moves of every reachable state (${name})`, () => {
      const { board, boxes, robot } = compileRows(rows);
      // Uncached: a fallback cache hit does not refresh lastAssignmentStates.
      const heuristic = new AssignmentHeuristic(board, { maxCacheEntries: 0 });
      const evaluator = new GoalCutEvaluator(board, board.topology);
      let surplusStates = 0;
      for (const state of allReachableStates(board, robot, boxes).values()) {
        if (state.exactMoves === null) continue;
        const pushBound = heuristic.evaluate(state.boxes);
        assert.ok(Number.isFinite(pushBound));
        const surplus = evaluator.evaluate(heuristic.lastAssignmentStates!);
        if (surplus > 0) surplusStates += 1;
        const walk = minimumManhattanWalkToPotentialPush(board, state.robot, state.boxes);
        assert.ok(
          pushBound + surplus + walk <= state.exactMoves,
          `h ${pushBound}+${surplus}+${walk} exceeds ${state.exactMoves} moves`,
        );
      }
      assert.ok(surplusStates > 0, "some state must carry a bottleneck surplus");
    });
  }

  it("keeps the shared-tunnel optimum when enabled in A* and IDA*", async () => {
    const request = makeRequest([...SHARED_TUNNEL_BOARD]);
    const features = { goalCutHeuristic: true };
    const results = await Promise.all([
      runExactMoveAStar(request, makeContext(), { features }),
      runIdaStarSearch(request, makeContext(), { features }),
    ]);
    for (const result of results) {
      assert.equal(result.status, "solved");
      if (result.status !== "solved") continue;
      assert.equal(result.solution.moves, 20);
      assert.equal(result.proof?.kind, "optimal");
      assert.ok((result.metrics.counters?.goalCutEvaluations ?? 0) > 0);
    }
  });
});
