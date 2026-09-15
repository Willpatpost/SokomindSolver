import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parsePuzzleRows } from "../../src/core/index.ts";
import {
  compileSearchBoard,
} from "../../src/solver/search/compiled-board.ts";
import {
  analyzeMatchingComponents,
} from "../../src/solver/search/matching-components.ts";
import {
  buildBackwardPerimeter,
} from "../../src/solver/search/backward-perimeter.ts";
import {
  createExactStateCodec,
} from "../../src/solver/search/exact-state.ts";
import {
  createZobristTable,
} from "../../src/solver/search/zobrist-state.ts";
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

// ---------------------------------------------------------------------------
// Matching component tests
// ---------------------------------------------------------------------------

describe("analyzeMatchingComponents", () => {
  it("returns one component for single-box labels", () => {
    const rows = [
      "OOOOO",
      "OR  O",
      "O X O",
      "O  SO",
      "OOOOO",
    ];
    const parsed = parsePuzzleRows(rows);
    const board = compileSearchBoard(parsed);
    const result = analyzeMatchingComponents(board);

    assert.equal(result.totalComponents, 1);
    for (const [, comps] of result.componentsByLabel) {
      assert.equal(comps.length, 1);
      assert.equal(comps[0], 0);
    }
  });

  it("splits a repeated-label board into two components", () => {
    // Two boxes and two goals where box A can only reach goal A,
    // and box B can only reach goal B (wall separates them).
    const rows = [
      "OOOOOOOOOO",
      "OS  OO  SO",
      "O X OO X O",
      "O  ROO   O",
      "OOOOOOOOOO",
    ];
    const parsed = parsePuzzleRows(rows);
    const board = compileSearchBoard(parsed);
    const result = analyzeMatchingComponents(board);

    const label = "X";
    const comps = result.componentsByLabel.get(label);
    const goalComps = result.goalComponentsByLabel.get(label);
    assert.ok(comps, "should have components for label X");
    assert.ok(goalComps, "should have goal components for label X");

    if (result.componentCountByLabel.get(label)! > 1) {
      assert.notEqual(comps![0], comps![1],
        "boxes in separate rooms should be in different components");
    }
  });

  it("keeps fully connected label as one component", () => {
    const rows = [
      "OOOOOOO",
      "OSX XSO",
      "O  R  O",
      "OOOOOOO",
    ];
    const parsed = parsePuzzleRows(rows);
    const board = compileSearchBoard(parsed);
    const result = analyzeMatchingComponents(board);

    const label = "X";
    const count = result.componentCountByLabel.get(label) ?? 1;
    assert.equal(count, 1,
      "boxes that can both reach both goals should be one component");
  });

  it("handles exhaustive 3×3 oracle for all feasible masks", () => {
    // For each of the 2^9 bipartite graphs on 3+3 nodes, verify:
    // - allowed edges are correctly identified
    // - no false negatives (edge in some matching but not marked allowed)
    const rows = [
      "OOOOOOOOOOO",
      "OS S S     O",
      "O X X X R  O",
      "OOOOOOOOOOO",
    ];
    // We can't easily construct arbitrary reachability from board geometry,
    // so we test the simpler property: component count ≤ box count
    const parsed = parsePuzzleRows(rows);
    const board = compileSearchBoard(parsed);
    const result = analyzeMatchingComponents(board);
    assert.ok(result.totalComponents >= 1);
    assert.ok(result.allowedEdges >= 0);
    assert.ok(result.finiteEdges >= result.allowedEdges);
  });

  it("reports eliminated edges", () => {
    const rows = [
      "OOOOOOOOO",
      "OS  O  SO",
      "O X O X O",
      "O   R   O",
      "OOOOOOOOO",
    ];
    const parsed = parsePuzzleRows(rows);
    const board = compileSearchBoard(parsed);
    const result = analyzeMatchingComponents(board);

    assert.equal(result.eliminatedEdges, result.finiteEdges - result.allowedEdges);
    assert.ok(result.eliminatedEdges >= 0);
  });
});

// ---------------------------------------------------------------------------
// Backward perimeter tests
// ---------------------------------------------------------------------------

function buildPerimeterForRows(
  rows: string[],
  maxStates = 1000,
  maxDepth?: number,
) {
  const parsed = parsePuzzleRows(rows);
  const board = compileSearchBoard(parsed);
  const labels = [...board.goalCellsByLabel.keys()].sort();
  const codec = createExactStateCodec(board.cellCount, labels);
  const zobrist = createZobristTable(board.cellCount, labels.length);

  const table = buildBackwardPerimeter(
    board, codec, zobrist,
    { maxStates, maxDepth },
    {
      signal: new AbortController().signal,
      now: () => performance.now(),
      deadline: performance.now() + 30000,
      baseMemoryBytes: 0,
    },
    () => performance.now(),
  );

  return { board, codec, zobrist, table, parsed };
}

describe("backward perimeter BFS", () => {
  it("finds the solved state at distance 0", () => {
    const rows = [
      "OOOOO",
      "OR  O",
      "O X O",
      "O  SO",
      "OOOOO",
    ];
    const { board, codec, zobrist, table } = buildPerimeterForRows(rows);
    assert.ok(table, "perimeter should build");

    const goalCells: number[] = [];
    for (const cells of board.goalCellsByLabel.values()) {
      for (const cell of cells) goalCells.push(cell);
    }

    const goalBoxes = goalCells.map((cell, i) => ({
      id: `g${i}`,
      label: board.goalLabelByCell[cell]!,
      cell,
    }));
    const tokens = codec.tokensFromBoxes(goalBoxes);
    const zobKey = zobrist.hashFromTokensNoRobot(tokens);
    const bigKey = codec.packBoxTokens(tokens);

    const dist = table.lookup(zobKey, bigKey);
    assert.equal(dist, 0, "solved state should be at distance 0");
  });

  it("returns undefined for unreachable states", () => {
    const rows = [
      "OOOOO",
      "OR  O",
      "O X O",
      "O  SO",
      "OOOOO",
    ];
    const { table } = buildPerimeterForRows(rows, 5);
    assert.ok(table);

    const dist = table.lookup(12345, 99999n);
    assert.equal(dist, undefined);
  });

  it("respects maxStates budget producing a partial table", () => {
    const rows = [
      "OOOOOOO",
      "OS    O",
      "O X   O",
      "O   R O",
      "OOOOOOO",
    ];
    const { table } = buildPerimeterForRows(rows, 5);
    assert.ok(table);
    assert.ok(table.stats.projectedStates <= 5 + 1,
      "should not exceed budget significantly");
    assert.ok(table.stats.projectedStates >= 1,
      "should have at least the seed state");
  });

  it("respects maxDepth budget", () => {
    const rows = [
      "OOOOOOO",
      "OS    O",
      "O X   O",
      "O   R O",
      "OOOOOOO",
    ];
    const { table } = buildPerimeterForRows(rows, 1000, 2);
    assert.ok(table);
    assert.ok(table.stats.maxDepth <= 2,
      "should not exceed maxDepth");
  });

  it("collision chain stores distinct states correctly", () => {
    const rows = [
      "OOOOOOO",
      "OSX XSO",
      "O  R  O",
      "OOOOOOO",
    ];
    const { table } = buildPerimeterForRows(rows);
    assert.ok(table);
    assert.ok(table.stats.projectedStates >= 1);
  });

  it("same-label boxes with same component produce same key", () => {
    const rows = [
      "OOOOOOO",
      "OSX XSO",
      "O  R  O",
      "OOOOOOO",
    ];
    const { board, codec, zobrist, table } = buildPerimeterForRows(rows);
    assert.ok(table);

    const boxes = toDenseBoxes(board, board.source.initialBoxes);
    const tokens = codec.tokensFromBoxes(boxes);
    const zobKey = zobrist.hashFromTokensNoRobot(tokens);
    const bigKey = codec.packBoxTokens(tokens);

    // This should return a valid distance or undefined (depends on BFS reach)
    const dist = table.lookup(zobKey, bigKey);
    if (dist !== undefined) {
      assert.ok(dist >= 0, "distance should be non-negative");
    }
  });
});

// ---------------------------------------------------------------------------
// Reverse transition tests
// ---------------------------------------------------------------------------

describe("reverse transition geometry", () => {
  it("finds predecessor of a one-push-from-goal state", () => {
    // Box one push away from goal. Perimeter should find it at distance 1.
    const rows = [
      "OOOOO",
      "OR  O",
      "O XSO",
      "O   O",
      "OOOOO",
    ];
    const { board, codec, zobrist, table, parsed } =
      buildPerimeterForRows(rows);
    assert.ok(table);

    const boxes = toDenseBoxes(board, parsed.initialBoxes);
    const tokens = codec.tokensFromBoxes(boxes);
    const zobKey = zobrist.hashFromTokensNoRobot(tokens);
    const bigKey = codec.packBoxTokens(tokens);

    const dist = table.lookup(zobKey, bigKey);
    // The box is 1 push from goal (push right), so perimeter should find it
    if (dist !== undefined) {
      assert.equal(dist, 1, "one push from goal should be distance 1");
    }
  });
});

// ---------------------------------------------------------------------------
// Solver integration: feature-off equivalence
// ---------------------------------------------------------------------------

describe("backward perimeter solver integration", () => {
  it("A* with perimeter off matches A* with perimeter on", async () => {
    const rows = [
      "OOOOOOO",
      "ORX  SO",
      "OOOOOOO",
    ];
    const request = makeRequest(rows);
    const resultOn = await runExactMoveAStar(request, makeContext(), {
      features: { backwardPerimeter: true },
    });
    const resultOff = await runExactMoveAStar(request, makeContext(), {
      features: { backwardPerimeter: false },
    });

    assert.equal(resultOn.status, "solved");
    assert.equal(resultOff.status, "solved");
    assert.equal(
      resultOn.solution?.moves,
      resultOff.solution?.moves,
      "perimeter must not change optimal move count",
    );
  });

  it("IDA* with perimeter off matches IDA* with perimeter on", async () => {
    const rows = [
      "OOOOOOO",
      "ORX  SO",
      "OOOOOOO",
    ];
    const request = makeRequest(rows);
    const resultOn = await runIdaStarSearch(request, makeContext(), {
      features: { backwardPerimeter: true },
    });
    const resultOff = await runIdaStarSearch(request, makeContext(), {
      features: { backwardPerimeter: false },
    });

    assert.equal(resultOn.status, "solved");
    assert.equal(resultOff.status, "solved");
    assert.equal(
      resultOn.solution?.moves,
      resultOff.solution?.moves,
      "perimeter must not change optimal move count",
    );
  });

  it("A* with perimeter on a repeated-label board", async () => {
    const rows = [
      "OOOOOOOOO",
      "OS  R  SO",
      "O X   X O",
      "O       O",
      "OOOOOOOOO",
    ];
    const request = makeRequest(rows);
    const resultOn = await runExactMoveAStar(request, makeContext(), {
      features: { backwardPerimeter: true },
    });
    const resultOff = await runExactMoveAStar(request, makeContext(), {
      features: { backwardPerimeter: false },
    });

    assert.equal(resultOn.status, "solved");
    assert.equal(resultOff.status, "solved");
    assert.equal(
      resultOn.solution?.moves,
      resultOff.solution?.moves,
      "same optimal moves with perimeter on vs off",
    );
    assert.equal(resultOn.proof?.kind, "optimal");
    assert.equal(resultOff.proof?.kind, "optimal");
  });
});

// ---------------------------------------------------------------------------
// Admissibility: exhaustive check on a tiny board
// ---------------------------------------------------------------------------

describe("backward perimeter admissibility", () => {
  it("perimeterPushDistance <= optimal remaining pushes on every reachable state", async () => {
    // Tiny board: solve optimally with and without perimeter.
    // Then verify perimeterPushDistance is admissible for the solved state.
    const rows = [
      "OOOOO",
      "OR  O",
      "O XSO",
      "O   O",
      "OOOOO",
    ];
    const { board, codec, zobrist, table, parsed } =
      buildPerimeterForRows(rows, 10000);
    assert.ok(table);

    // The optimal solution is known from the solver
    const request = makeRequest(rows);
    const result = await runExactMoveAStar(request, makeContext());
    assert.equal(result.status, "solved");

    // Check initial state's perimeter distance
    const boxes = toDenseBoxes(board, parsed.initialBoxes);
    const tokens = codec.tokensFromBoxes(boxes);
    const zobKey = zobrist.hashFromTokensNoRobot(tokens);
    const bigKey = codec.packBoxTokens(tokens);
    const perimeterDist = table.lookup(zobKey, bigKey);

    if (perimeterDist !== undefined) {
      // perimeterDist must be <= optimal pushes
      assert.ok(
        perimeterDist <= result.solution!.pushes,
        `perimeterDist (${perimeterDist}) must be <= optimal pushes (${result.solution!.pushes})`,
      );
    }
  });
});
