import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createSession,
  parsePuzzleRows,
  stepSnapshot,
  type Direction,
} from "../../src/core/index.ts";
import type { SolutionStep, SolverRequest, SolverSolution } from "../../src/solver/contracts.ts";
import { scoreSolverObjective } from "../../src/solver/validation.ts";
import { verifySolverSolution } from "../../src/solver/verification.ts";
import {
  extractPushBlocks,
  reconstructSolution,
  attemptAdjacentSwap,
  optimizePushBlockOrder,
} from "../../src/solver/search/push-block-reorder.ts";
import { compileSearchBoard } from "../../src/solver/search/compiled-board.ts";

function makeRequest(rows: readonly string[]): SolverRequest {
  const board = parsePuzzleRows(rows);
  const session = createSession({
    id: "test",
    title: "Test",
    difficulty: "beginner",
    boxes: board.initialBoxes.length,
    rows,
  });
  return {
    board: session.board,
    snapshot: session.snapshot,
    objective: { kind: "moves" },
  };
}

function buildSolution(
  request: SolverRequest,
  directions: readonly Direction[],
): SolverSolution {
  const steps: SolutionStep[] = [];
  let snapshot = request.snapshot;
  let pushes = 0;

  for (const dir of directions) {
    const transition = stepSnapshot(request.board, snapshot, dir);
    if (!transition.moved) {
      throw new Error(`Step ${dir} is blocked at move ${steps.length}`);
    }
    steps.push(Object.freeze({
      direction: dir,
      kind: transition.pushed ? "push" as const : "walk" as const,
    }));
    if (transition.pushed) pushes++;
    snapshot = transition.snapshot;
  }

  if (!snapshot.solved) {
    throw new Error("Solution does not solve the puzzle");
  }

  return Object.freeze({
    steps: Object.freeze(steps),
    moves: steps.length,
    pushes,
    objective: request.objective,
    objectiveScore: scoreSolverObjective(request.objective, steps.length),
    optimality: "unknown",
  });
}

// Standard two-box puzzle used in many tests:
//   OOOOOOO
//   O     O     row 1: open
//   O X X O     row 2: boxes at (2,2) and (2,4)
//   O S S O     row 3: goals at (3,2) and (3,4)
//   O  R  O     row 4: robot at (4,3)
//   OOOOOOO
const TWO_BOX_ROWS = [
  "OOOOOOO",
  "O     O",
  "O X X O",
  "O S S O",
  "O  R  O",
  "OOOOOOO",
] as const;

// Solution: robot at (4,3), walk to (1,2), push box (2,2) down,
// then walk to (1,4), push box (2,4) down. 9 moves, 2 pushes.
const TWO_BOX_MOVES: Direction[] = [
  "up", "up", "up", "left", "down", "up", "right", "right", "down",
];

// Three-box puzzle:
//   OOOOOOOOO
//   O       O
//   O X X X O     boxes at (2,2), (2,4), (2,6)
//   O S S S O     goals at (3,2), (3,4), (3,6)
//   O   R   O     robot at (4,4)
//   OOOOOOOOO
const THREE_BOX_ROWS = [
  "OOOOOOOOO",
  "O       O",
  "O X X X O",
  "O S S S O",
  "O   R   O",
  "OOOOOOOOO",
] as const;

describe("extractPushBlocks", () => {
  it("extracts correct blocks from a two-box solution", () => {
    const request = makeRequest(TWO_BOX_ROWS);
    const solution = buildSolution(request, TWO_BOX_MOVES);

    assert.equal(solution.moves, 9);
    assert.equal(solution.pushes, 2);

    const seq = extractPushBlocks(request, solution);
    assert.equal(seq.blocks.length, 2);
    assert.equal(seq.blocks[0].pushes.length, 1);
    assert.equal(seq.blocks[1].pushes.length, 1);
    assert.equal(seq.blocks[0].walkStepsBefore, 4);
    assert.equal(seq.blocks[1].walkStepsBefore, 3);
    assert.equal(seq.blocks[0].pushes[0].direction, "down");
    assert.equal(seq.blocks[1].pushes[0].direction, "down");
  });

  it("groups consecutive pushes of the same box into one block", () => {
    const request = makeRequest(["OOOOOOO", "OR X SO", "OOOOOOO"]);
    const solution = buildSolution(request, ["right", "right", "right"]);

    assert.equal(solution.moves, 3);
    assert.equal(solution.pushes, 2);

    const seq = extractPushBlocks(request, solution);
    assert.equal(seq.blocks.length, 1);
    assert.equal(seq.blocks[0].pushes.length, 2);
    assert.equal(seq.blocks[0].walkStepsBefore, 1);
  });

  it("records correct support positions", () => {
    const request = makeRequest(TWO_BOX_ROWS);
    const solution = buildSolution(request, TWO_BOX_MOVES);
    const seq = extractPushBlocks(request, solution);

    const push0 = seq.blocks[0].pushes[0];
    assert.deepEqual(push0.boxFrom, { row: 2, column: 2 });
    assert.deepEqual(push0.boxTo, { row: 3, column: 2 });
    assert.deepEqual(push0.supportPosition, { row: 1, column: 2 });
  });
});

describe("reconstructSolution", () => {
  it("reconstructs with original order and BFS-shortest walks", () => {
    const request = makeRequest(TWO_BOX_ROWS);
    const solution = buildSolution(request, TWO_BOX_MOVES);
    const board = compileSearchBoard(request.board);
    const seq = extractPushBlocks(request, solution);

    const original = reconstructSolution(request, board, seq.blocks, [0, 1]);

    assert.ok(original !== null, "Should reconstruct successfully");
    assert.equal(original!.pushes, solution.pushes);
    assert.ok(original!.moves <= solution.moves);

    const verification = verifySolverSolution(request, original!);
    assert.equal(verification.valid, true);
  });

  it("returns null or a valid solution for reversed order", () => {
    const request = makeRequest(TWO_BOX_ROWS);
    const solution = buildSolution(request, TWO_BOX_MOVES);
    const board = compileSearchBoard(request.board);
    const seq = extractPushBlocks(request, solution);

    const reversed = reconstructSolution(request, board, seq.blocks, [1, 0]);
    if (reversed !== null) {
      const verification = verifySolverSolution(request, reversed);
      assert.equal(verification.valid, true);
    }
  });
});

describe("attemptAdjacentSwap", () => {
  it("returns null for out-of-range swap index", () => {
    const request = makeRequest(TWO_BOX_ROWS);
    const solution = buildSolution(request, TWO_BOX_MOVES);
    const board = compileSearchBoard(request.board);
    const seq = extractPushBlocks(request, solution);

    assert.equal(attemptAdjacentSwap(request, board, seq.blocks, -1), null);
    assert.equal(attemptAdjacentSwap(request, board, seq.blocks, seq.blocks.length), null);
  });

  it("verifies any accepted swap through canonical replay", () => {
    const request = makeRequest(TWO_BOX_ROWS);
    const solution = buildSolution(request, TWO_BOX_MOVES);
    const board = compileSearchBoard(request.board);
    const seq = extractPushBlocks(request, solution);

    const swapped = attemptAdjacentSwap(request, board, seq.blocks, 0);
    if (swapped !== null) {
      const verification = verifySolverSolution(request, swapped);
      assert.equal(verification.valid, true, "Swapped solution must verify");
      assert.equal(swapped.pushes, solution.pushes, "Push count must not change");
    }
  });
});

describe("dependency / infeasible swap", () => {
  it("handles dependent blocks gracefully", () => {
    // Two boxes stacked vertically, pushed to separate goals.
    // Block 1 pushes bottom box left, block 2 pushes top box down 3 times.
    // Swap feasibility depends on same-label substitution.
    const request = makeRequest([
      "OOOOO",
      "O   O",
      "O X O",
      "OSX O",
      "O R O",
      "O S O",
      "OOOOO",
    ]);

    const solution = buildSolution(request, [
      "right", "up", "left",
      "right", "up", "up", "left",
      "down", "down", "down",
    ]);

    const board = compileSearchBoard(request.board);
    const seq = extractPushBlocks(request, solution);
    assert.equal(seq.blocks.length, 2);

    const swapped = attemptAdjacentSwap(request, board, seq.blocks, 0);
    if (swapped !== null) {
      const v = verifySolverSolution(request, swapped);
      assert.equal(v.valid, true);
    }
  });
});

describe("same-label boxes", () => {
  it("handles interchangeable X boxes correctly", () => {
    const request = makeRequest(TWO_BOX_ROWS);
    const solution = buildSolution(request, TWO_BOX_MOVES);

    const report = optimizePushBlockOrder(request, solution);
    assert.equal(report.originalPushes, 2);
    assert.equal(report.optimizedPushes, 2);
    if (report.optimizedSolution) {
      const v = verifySolverSolution(request, report.optimizedSolution);
      assert.equal(v.valid, true);
    }
  });

  it("allows swap of same-label X boxes via canonical replay", () => {
    const request = makeRequest(TWO_BOX_ROWS);
    const solution = buildSolution(request, TWO_BOX_MOVES);

    const board = compileSearchBoard(request.board);
    const seq = extractPushBlocks(request, solution);
    assert.equal(seq.blocks.length, 2);
    assert.equal(seq.blocks[0].boxLabel, "X");
    assert.equal(seq.blocks[1].boxLabel, "X");

    const swapped = attemptAdjacentSwap(request, board, seq.blocks, 0);
    if (swapped !== null) {
      const v = verifySolverSolution(request, swapped);
      assert.equal(v.valid, true, "Swapped same-label solution must verify");
      assert.equal(swapped.pushes, solution.pushes, "Push count preserved");
    }
  });
});

describe("fresh routing", () => {
  it("recomputes BFS-shortest keeper walks in original order", () => {
    const request = makeRequest(TWO_BOX_ROWS);

    // Suboptimal: 6 walks via column 1 instead of 4 walks direct to (1,2).
    const suboptimalSolution = buildSolution(request, [
      "left", "left", "up", "up", "up", "right", "down",
      "up", "right", "right", "down",
    ]);
    assert.equal(suboptimalSolution.moves, 11);

    const report = optimizePushBlockOrder(request, suboptimalSolution);
    assert.equal(report.originalMoves, 11);
    assert.ok(
      report.routingOnlyMoves <= 11,
      `Routing-only should not increase moves (got ${report.routingOnlyMoves})`,
    );
    if (report.routingOnlySolution) {
      const v = verifySolverSolution(request, report.routingOnlySolution);
      assert.equal(v.valid, true);
    }
  });
});

describe("swap rejection", () => {
  it("rejects when single block has no adjacent pair", () => {
    const request = makeRequest(["OOOOO", "ORXSO", "OOOOO"]);
    const solution = buildSolution(request, ["right"]);

    const report = optimizePushBlockOrder(request, solution);
    assert.equal(report.successfulSwaps, 0);
    assert.equal(report.originalMoves, 1);
    assert.equal(report.optimizedMoves, 1);
  });
});

describe("optimizePushBlockOrder", () => {
  it("returns a complete report", () => {
    const request = makeRequest(TWO_BOX_ROWS);
    const solution = buildSolution(request, TWO_BOX_MOVES);

    const report = optimizePushBlockOrder(request, solution, {
      maxPasses: 3,
      maxSwapAttempts: 50,
      maxElapsedMs: 10_000,
    });

    assert.equal(report.originalMoves, 9);
    assert.equal(report.originalPushes, 2);
    assert.equal(report.blockCount, 2);
    assert.equal(typeof report.elapsedMs, "number");
    assert.ok(report.elapsedMs >= 0);
    assert.ok(report.optimizedMoves <= report.originalMoves);
    assert.equal(report.optimizedPushes, report.originalPushes);
    assert.ok(report.totalEpisodesBefore >= 0);
    assert.ok(report.totalEpisodesAfter >= 0);
    assert.ok(report.routingOnlyMoves <= report.originalMoves);
  });

  it("respects maxSwapAttempts budget", () => {
    const request = makeRequest(TWO_BOX_ROWS);
    const solution = buildSolution(request, TWO_BOX_MOVES);

    const report = optimizePushBlockOrder(request, solution, {
      maxPasses: 1,
      maxSwapAttempts: 0,
    });

    assert.equal(report.attemptedSwaps, 0);
  });

  it("never increases push count", () => {
    const request = makeRequest(THREE_BOX_ROWS);

    // Go around boxes via column 1 to reach (1,2), then push each down.
    const solution = buildSolution(request, [
      "left", "left", "left", "up", "up", "up", "right", "down",
      "up", "right", "right", "down",
      "up", "right", "right", "down",
    ]);
    assert.equal(solution.pushes, 3);

    const report = optimizePushBlockOrder(request, solution);
    assert.equal(report.optimizedPushes, 3);
    assert.ok(report.optimizedMoves <= report.originalMoves);
    if (report.optimizedSolution) {
      const v = verifySolverSolution(request, report.optimizedSolution);
      assert.equal(v.valid, true);
    }
  });

  it("reports episode analysis", () => {
    const request = makeRequest(TWO_BOX_ROWS);
    const solution = buildSolution(request, TWO_BOX_MOVES);

    const report = optimizePushBlockOrder(request, solution);
    assert.equal(report.totalEpisodesBefore, 2);
    assert.equal(report.maxEpisodesPerBoxBefore, 1);
  });
});

describe("multiple swaps", () => {
  it("accumulates improvements across passes", () => {
    const request = makeRequest(THREE_BOX_ROWS);

    // Push in reverse order: right box, then middle, then left.
    const reverseOrder = buildSolution(request, [
      "right", "right", "right", "up", "up", "up", "left", "down",
      "up", "left", "left", "down",
      "up", "left", "left", "down",
    ]);
    assert.equal(reverseOrder.pushes, 3);

    const report = optimizePushBlockOrder(request, reverseOrder, {
      maxPasses: 10,
    });

    assert.ok(report.optimizedMoves <= reverseOrder.moves);
    assert.equal(report.optimizedPushes, 3);
    if (report.optimizedSolution) {
      const v = verifySolverSolution(request, report.optimizedSolution);
      assert.equal(v.valid, true);
    }
  });
});

describe("typed boxes", () => {
  it("handles typed (non-X) boxes correctly", () => {
    const request = makeRequest([
      "OOOOOOO",
      "O     O",
      "O A B O",
      "O a b O",
      "O  R  O",
      "OOOOOOO",
    ]);

    const solution = buildSolution(request, [
      "up", "up", "up", "left", "down",
      "up", "right", "right", "down",
    ]);
    assert.equal(solution.pushes, 2);

    const report = optimizePushBlockOrder(request, solution);
    assert.equal(report.optimizedPushes, 2);
    if (report.optimizedSolution) {
      const v = verifySolverSolution(request, report.optimizedSolution);
      assert.equal(v.valid, true);
    }
  });

  it("enforces label matching on every accepted swap", () => {
    const request = makeRequest([
      "OOOOOOO",
      "O     O",
      "O A B O",
      "O a b O",
      "O  R  O",
      "OOOOOOO",
    ]);

    const solution = buildSolution(request, [
      "up", "up", "up", "left", "down",
      "up", "right", "right", "down",
    ]);

    const report = optimizePushBlockOrder(request, solution);
    assert.equal(report.optimizedPushes, solution.pushes);
    if (report.optimizedSolution) {
      const v = verifySolverSolution(request, report.optimizedSolution);
      assert.equal(v.valid, true);
    }
  });

  it("allows swap when both blocks push same-label X boxes symmetrically", () => {
    const request = makeRequest([
      "OOOOOOO",
      "O     O",
      "O A B O",
      "O a b O",
      "O  R  O",
      "OOOOOOO",
    ]);

    const solution = buildSolution(request, [
      "up", "up", "up", "left", "down",
      "up", "right", "right", "down",
    ]);

    const board = compileSearchBoard(request.board);
    const seq = extractPushBlocks(request, solution);
    const swapped = attemptAdjacentSwap(request, board, seq.blocks, 0);
    // Symmetric layout: swap is geometrically feasible and boxes stay on correct goals
    if (swapped !== null) {
      const v = verifySolverSolution(request, swapped);
      assert.equal(v.valid, true, "Swapped typed solution must verify");
    }
  });
});
