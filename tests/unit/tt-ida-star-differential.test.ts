import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parsePuzzleRows,
  type ParsedBoard,
  type GameSnapshot,
} from "../../src/core/index.ts";
import type {
  SolverExecutionContext,
  SolverRequest,
  SolverResult,
} from "../../src/solver/contracts.ts";
import {
  compileSearchBoard,
} from "../../src/solver/search/compiled-board.ts";
import {
  runExactMoveAStar,
} from "../../src/solver/search/exact-move-astar.ts";
import {
  runIdaStarSearch,
} from "../../src/solver/search/ida-star.ts";
import {
  toDenseBoxes,
} from "../../src/solver/search/model.ts";
import {
  exactRemainingMoves,
} from "../support/exact-solver-oracle.ts";

function makeBoard(rows: string[]): ParsedBoard {
  return parsePuzzleRows(rows);
}

function makeRequest(board: ParsedBoard): SolverRequest {
  const snapshot: GameSnapshot = {
    puzzleId: "tt-diff-test",
    robot: board.initialRobot,
    boxes: board.initialBoxes,
    moves: 0,
    pushes: 0,
    solved: false,
  };
  return {
    board,
    snapshot,
    objective: { kind: "moves" },
    limits: { maxElapsedMs: 30_000, maxExpandedStates: 500_000 },
  };
}

function makeContext(): SolverExecutionContext {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    reportProgress: () => {},
    now: () => performance.now(),
  };
}

function assertAgreement(
  label: string,
  oracle: number | null,
  result: SolverResult,
): void {
  if (oracle === null) {
    assert.notEqual(
      result.status, "solved",
      `${label}: oracle says unsolvable but solver found solution`,
    );
    return;
  }
  assert.equal(
    result.status, "solved",
    `${label}: oracle found solution with cost ${oracle} but solver reported ${result.status}`,
  );
  if (result.status === "solved") {
    assert.equal(
      result.solution.moves, oracle,
      `${label}: expected ${oracle} moves but got ${result.solution.moves}`,
    );
  }
}

/**
 * Boards designed so that the same box configuration is reachable through
 * robot paths of different lengths. The robot can reach the same push
 * position via a short path or a long detour.
 */
const REPEATED_STATE_BOARDS = [
  {
    name: "L-shaped corridor with two approach paths",
    rows: [
      "OOOOOOO",
      "O     O",
      "O OOO O",
      "O O   O",
      "O O XSO",
      "OR    O",
      "OOOOOOO",
    ],
  },
  {
    name: "ring corridor forces different-cost arrivals",
    rows: [
      "OOOOOOO",
      "OR    O",
      "O OOO O",
      "O     O",
      "OOO OOO",
      "O XS  O",
      "OOOOOOO",
    ],
  },
  {
    name: "2-box with shared corridor",
    rows: [
      "OOOOOOO",
      "O  R  O",
      "O X X O",
      "O S S O",
      "O     O",
      "OOOOOOO",
    ],
  },
  {
    name: "open room with corner goal",
    rows: [
      "OOOOOO",
      "O    O",
      "O X  O",
      "O  R O",
      "O   SO",
      "OOOOOO",
    ],
  },
  {
    name: "2-box T-junction",
    rows: [
      "OOOOOOO",
      "O  R  O",
      "O OXO O",
      "O  X  O",
      "O OSO O",
      "O  S  O",
      "OOOOOOO",
    ],
  },
];

describe("TT-IDA* differential correctness", () => {
  for (const { name, rows } of REPEATED_STATE_BOARDS) {
    it(`oracle vs IDA*(contour-scoped TT) on "${name}"`, async () => {
      const board = makeBoard(rows);
      const compiled = compileSearchBoard(board);
      const robot = compiled.cellAt(
        board.initialRobot.row,
        board.initialRobot.column,
      );
      const denseBoxes = toDenseBoxes(compiled, board.initialBoxes);
      const oracleResult = exactRemainingMoves(compiled, robot, denseBoxes);
      const request = makeRequest(board);

      const idaContourScoped = await runIdaStarSearch(
        request,
        makeContext(),
        { persistTransposition: false },
      );

      assertAgreement(
        `${name} [IDA* contour-scoped]`,
        oracleResult.exactMoves,
        idaContourScoped,
      );
    });

    it(`oracle vs IDA*(persistent TT) on "${name}"`, async () => {
      const board = makeBoard(rows);
      const compiled = compileSearchBoard(board);
      const robot = compiled.cellAt(
        board.initialRobot.row,
        board.initialRobot.column,
      );
      const denseBoxes = toDenseBoxes(compiled, board.initialBoxes);
      const oracleResult = exactRemainingMoves(compiled, robot, denseBoxes);
      const request = makeRequest(board);

      const idaPersistent = await runIdaStarSearch(
        request,
        makeContext(),
        { persistTransposition: true },
      );

      assertAgreement(
        `${name} [IDA* persistent]`,
        oracleResult.exactMoves,
        idaPersistent,
      );
    });

    it(`oracle vs exact A* on "${name}"`, async () => {
      const board = makeBoard(rows);
      const compiled = compileSearchBoard(board);
      const robot = compiled.cellAt(
        board.initialRobot.row,
        board.initialRobot.column,
      );
      const denseBoxes = toDenseBoxes(compiled, board.initialBoxes);
      const oracleResult = exactRemainingMoves(compiled, robot, denseBoxes);
      const request = makeRequest(board);

      const astarResult = await runExactMoveAStar(request, makeContext());

      assertAgreement(
        `${name} [A*]`,
        oracleResult.exactMoves,
        astarResult,
      );
    });
  }

  it("contour-scoped and persistent IDA* agree on all boards", async () => {
    for (const { name, rows } of REPEATED_STATE_BOARDS) {
      const board = makeBoard(rows);
      const request = makeRequest(board);

      const contourScoped = await runIdaStarSearch(
        request,
        makeContext(),
        { persistTransposition: false },
      );
      const persistent = await runIdaStarSearch(
        request,
        makeContext(),
        { persistTransposition: true },
      );

      if (contourScoped.status === "solved" && persistent.status === "solved") {
        assert.equal(
          contourScoped.solution.moves,
          persistent.solution.moves,
          `"${name}": contour-scoped (${contourScoped.solution.moves}) != persistent (${persistent.solution.moves})`,
        );
      }
      assert.equal(
        contourScoped.status === "solved",
        persistent.status === "solved",
        `"${name}": solvability mismatch (contour-scoped=${contourScoped.status}, persistent=${persistent.status})`,
      );
    }
  });

  it("all three solvers agree on optimality proof classification", async () => {
    for (const { name, rows } of REPEATED_STATE_BOARDS) {
      const board = makeBoard(rows);
      const request = makeRequest(board);

      const [contourScoped, persistent, astar] = await Promise.all([
        runIdaStarSearch(request, makeContext(), { persistTransposition: false }),
        runIdaStarSearch(request, makeContext(), { persistTransposition: true }),
        runExactMoveAStar(request, makeContext()),
      ]);

      const results = [
        { label: "contour-scoped IDA*", r: contourScoped },
        { label: "persistent IDA*", r: persistent },
        { label: "A*", r: astar },
      ];

      const solvedResults = results.filter(({ r }) => r.status === "solved");
      if (solvedResults.length > 1) {
        const firstMoves = (solvedResults[0].r as Extract<SolverResult, { status: "solved" }>).solution.moves;
        for (const { label, r } of solvedResults.slice(1)) {
          const moves = (r as Extract<SolverResult, { status: "solved" }>).solution.moves;
          assert.equal(
            moves,
            firstMoves,
            `"${name}": ${label} (${moves} moves) disagrees with ${solvedResults[0].label} (${firstMoves} moves)`,
          );
        }
      }
    }
  });
});
