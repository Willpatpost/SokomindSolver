import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parsePuzzleRows,
} from "../../src/core/index.ts";
import type {
  SolverExecutionContext,
  SolverRequest,
  SolverResult,
} from "../../src/solver/contracts.ts";
import { verifySolverSolution } from "../../src/solver/verification.ts";
import {
  classicAStarSolver,
  classicIdaStarSolver,
} from "../../src/solver/implementations/classic-solvers.ts";
import {
  exactRemainingMoves,
} from "../support/exact-solver-oracle.ts";
import {
  compileSearchBoard,
} from "../../src/solver/search/compiled-board.ts";
import {
  toDenseBoxes,
} from "../../src/solver/search/model.ts";

function oracleContext(): SolverExecutionContext {
  return {
    signal: new AbortController().signal,
    reportProgress: () => undefined,
    now: () => performance.now(),
  };
}

function requestFromRows(rows: string[]): SolverRequest {
  const parsed = parsePuzzleRows(rows);
  return {
    board: parsed,
    snapshot: {
      puzzleId: "optimal-test",
      robot: parsed.initialRobot,
      boxes: parsed.initialBoxes,
      moves: 0,
      pushes: 0,
      solved: false,
    },
    objective: { kind: "moves" },
  };
}

const TINY_1BOX = ["OOOOO", "ORXSO", "OOOOO"];

const SMALL_2BOX = [
  "OOOOOO",
  "OR AaO",
  "O  BbO",
  "OOOOOO",
];

const CORNER_L = [
  "OOOOOO",
  "O  XSO",
  "OR   O",
  "OOOOOO",
];

describe("solver optimality", () => {
  it("classic A* produces proven optimal result on 1-box puzzle", async () => {
    const req = requestFromRows(TINY_1BOX);
    const result = await classicAStarSolver.solve(req, oracleContext()) as SolverResult;
    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;

    assert.equal(result.solution.optimality, "proven");
    assert.ok(result.proof !== undefined);
    assert.equal(result.proof!.kind, "optimal");
    assert.equal(result.proof!.gap, 0);

    const verification = verifySolverSolution(req, result.solution);
    assert.ok(verification.valid, "optimal solution must replay correctly");
  });

  it("classic IDA* produces proven optimal result on 1-box puzzle", async () => {
    const req = requestFromRows(TINY_1BOX);
    const result = await classicIdaStarSolver.solve(req, oracleContext()) as SolverResult;
    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;

    assert.equal(result.solution.optimality, "proven");
    assert.ok(result.proof !== undefined);
    assert.equal(result.proof!.kind, "optimal");
    assert.equal(result.proof!.gap, 0);

    const verification = verifySolverSolution(req, result.solution);
    assert.ok(verification.valid);
  });

  it("A* and IDA* agree on optimal move count", async () => {
    const req = requestFromRows(CORNER_L);
    const ctx = oracleContext();

    const astarResult = await classicAStarSolver.solve(req, ctx) as SolverResult;
    const idaResult = await classicIdaStarSolver.solve(req, ctx) as SolverResult;

    assert.equal(astarResult.status, "solved");
    assert.equal(idaResult.status, "solved");
    if (astarResult.status !== "solved" || idaResult.status !== "solved") return;

    assert.equal(
      astarResult.solution.moves,
      idaResult.solution.moves,
      "A* and IDA* must agree on optimal move count",
    );
  });

  it("optimal move count matches exhaustive oracle", async () => {
    const rows = TINY_1BOX;
    const parsed = parsePuzzleRows(rows);
    const board = compileSearchBoard(parsed);
    const boxes = toDenseBoxes(board, parsed.initialBoxes);
    const robotCell = board.cellAt(parsed.initialRobot.row, parsed.initialRobot.column);

    const oracle = exactRemainingMoves(board, robotCell, boxes);
    assert.notEqual(oracle.exactMoves, null, "oracle must solve this puzzle");

    const req = requestFromRows(rows);
    const result = await classicAStarSolver.solve(req, oracleContext()) as SolverResult;
    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;

    assert.equal(
      result.solution.moves,
      oracle.exactMoves,
      `solver moves (${result.solution.moves}) must equal oracle (${oracle.exactMoves})`,
    );
  });

  it("2-box typed puzzle produces correct optimal proof", async () => {
    const req = requestFromRows(SMALL_2BOX);
    const result = await classicAStarSolver.solve(req, oracleContext()) as SolverResult;
    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;

    assert.equal(result.solution.optimality, "proven");
    assert.ok(result.proof !== undefined);
    assert.equal(result.proof!.kind, "optimal");

    const verification = verifySolverSolution(req, result.solution);
    assert.ok(verification.valid, "2-box optimal solution must replay correctly");
  });
});
