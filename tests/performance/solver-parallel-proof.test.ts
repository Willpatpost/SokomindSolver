import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePuzzleRows } from "../../src/core/index.ts";
import type { SolverExecutionContext, SolverRequest } from "../../src/solver/contracts.ts";
import { createNodeSolverAdapter } from "../../src/solver/node-runner.ts";
import { collectProofIssues } from "../../src/solver/proof.ts";
import { verifySolverSolution } from "../../src/solver/verification.ts";
import { INTER_ROOMS } from "../fixtures/solver-v2/benchmark-corpus.ts";

// The partition holding the discovery route gets that route's cost as its
// exclusive bound, so its lane must finish with no route below the bound. An
// IDA* lane once repeated its last contour there instead.
for (const algorithm of ["astar", "ida-star"] as const) {
  test(`parallel Node ${algorithm} proof workers preserve the inter-rooms 28-move optimum`, async () => {
    const parsed = parsePuzzleRows([...INTER_ROOMS.rows]);
    const request: SolverRequest = {
      board: parsed,
      snapshot: {
        puzzleId: INTER_ROOMS.fixtureId,
        robot: parsed.initialRobot,
        boxes: parsed.initialBoxes,
        moves: 0,
        pushes: 0,
        solved: false,
      },
      objective: { kind: "moves" },
      limits: { maxElapsedMs: 30_000 },
      options: {
        "sokomind-solver": {
          mode: "optimal",
          proofAlgorithm: algorithm,
          proofParallelism: 2,
          deterministic: false,
        },
      },
    };
    const context: SolverExecutionContext = {
      signal: new AbortController().signal,
      reportProgress: () => undefined,
      now: () => performance.now(),
    };
    const result = await createNodeSolverAdapter().solve(request, context);
    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;
    assert.equal(result.solution.moves, 28);
    assert.equal(result.solution.pushes, 7);
    assert.equal(result.solution.optimality, "proven");
    assert.equal(result.proof?.algorithm, `parallel-move-${algorithm}`);
    assert.equal(result.metrics.counters?.["proof.proofWorkerCount"], 2);
    assert.equal(verifySolverSolution(request, result.solution).valid, true);
    assert.deepEqual(collectProofIssues(result.proof, result.solution), []);
    assert.equal(result.proof?.lowerBound, 28);
    assert.equal(result.proof?.upperBound, 28);
    assert.equal(result.proof?.gap, 0);
  });
}
