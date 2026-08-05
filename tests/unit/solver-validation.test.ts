import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createSession,
  type PuzzleDefinition,
} from "../../src/core/index.ts";
import {
  isSolverWorkerCommand,
  isSolverWorkerEvent,
  SOLVER_WORKER_PROTOCOL_VERSION,
} from "../../src/solver/protocol.ts";
import {
  getSolverRequestValidationIssues,
  isSolverProgress,
  isSolverRequest,
  isSolverResult,
  isSolverSolution,
  scoreSolverObjective,
} from "../../src/solver/validation.ts";
import type {
  SolverRequest,
  SolverSolution,
} from "../../src/solver/contracts.ts";

const puzzle: PuzzleDefinition = {
  id: "validation",
  title: "Validation",
  difficulty: "tutorial",
  boxes: 1,
  rows: ["OOOOO", "ORXSO", "OOOOO"],
};

function request(): SolverRequest {
  const session = createSession(puzzle);
  return {
    board: session.board,
    snapshot: session.snapshot,
    objective: { kind: "moves" },
    limits: {
      maxElapsedMs: 10_000,
      maxExpandedStates: 1_000,
    },
    options: {
      heuristic: "assignment",
      weights: [1, 2, 3],
      nested: { enabled: true },
    },
  };
}

function solution(): SolverSolution {
  return {
    steps: [{ direction: "right", kind: "push" }],
    moves: 1,
    pushes: 1,
    objective: { kind: "moves" },
    objectiveScore: 1,
    optimality: "unknown",
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("solver runtime validation", () => {
  it("accepts a complete request and rejects inconsistent board/state data", () => {
    const valid = request();
    assert.equal(isSolverRequest(valid), true);
    assert.deepEqual(getSolverRequestValidationIssues(valid), []);

    const badGeometry = clone(valid) as unknown as {
      board: { floor: Array<{ row: number; column: number }> };
    };
    badGeometry.board.floor.pop();
    assert.equal(isSolverRequest(badGeometry), false);

    const badSolvedFlag = clone(valid) as unknown as {
      snapshot: { solved: boolean };
    };
    badSolvedFlag.snapshot.solved = true;
    const issues = getSolverRequestValidationIssues(badSolvedFlag);
    assert.ok(issues.some(({ path }) => path === "request.snapshot.solved"));
  });

  it("enforces objective, limits, and JSON-safe option invariants", () => {
    const invalidObjective = {
      ...request(),
      objective: { kind: "pushes" },
    };
    assert.equal(isSolverRequest(invalidObjective), false);

    const invalidLimit = {
      ...request(),
      limits: { maxElapsedMs: 0 },
    };
    assert.equal(isSolverRequest(invalidLimit), false);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.equal(
      isSolverRequest({ ...request(), options: cyclic }),
      false,
    );
    assert.equal(
      isSolverRequest({ ...request(), options: { score: Number.NaN } }),
      false,
    );
  });

  it("checks progress bounds and exact solution counters/scores", () => {
    assert.equal(
      isSolverProgress({
        phase: "searching",
        elapsedMs: 12.5,
        expandedStates: 20,
        counters: { duplicateStates: 4, heuristicCacheHits: 2 },
        fraction: 0.25,
      }),
      true,
    );
    assert.equal(
      isSolverProgress({
        phase: "searching",
        elapsedMs: 12.5,
        fraction: 1.1,
      }),
      false,
    );
    assert.equal(
      isSolverProgress({
        phase: "searching",
        elapsedMs: 12.5,
        counters: { duplicateStates: -1 },
      }),
      false,
    );

    assert.equal(isSolverSolution(solution()), true);
    assert.equal(isSolverSolution({ ...solution(), pushes: 0 }), false);
    assert.equal(
      isSolverSolution({ ...solution(), objectiveScore: 99 }),
      false,
    );
    assert.equal(
      scoreSolverObjective({ kind: "moves" }, 10),
      10,
    );
  });

  it("strictly validates nested command and event payloads", () => {
    const command = {
      protocolVersion: SOLVER_WORKER_PROTOCOL_VERSION,
      type: "solver/run",
      jobId: "job-1",
      solverId: "test-solver",
      request: request(),
    };
    assert.equal(isSolverWorkerCommand(command), true);
    assert.equal(
      isSolverWorkerCommand({ ...command, unexpected: true }),
      false,
    );
    assert.equal(
      isSolverWorkerCommand({
        ...command,
        request: { ...request(), limits: { maxMemoryBytes: -1 } },
      }),
      false,
    );

    const result = {
      protocolVersion: SOLVER_WORKER_PROTOCOL_VERSION,
      type: "solver/result",
      jobId: "job-1",
      result: {
        status: "solved",
        solution: solution(),
        metrics: { elapsedMs: 4 },
      },
    };
    assert.equal(isSolverWorkerEvent(result), true);
    assert.equal(isSolverResult(result.result), true);
    assert.equal(
      isSolverWorkerEvent({
        ...result,
        result: { ...result.result, metrics: { elapsedMs: -1 } },
      }),
      false,
    );
  });
});
