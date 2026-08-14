import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parsePuzzleRows } from "../../src/core/index.ts";
import type { SolverExecutionContext, SolverRequest } from "../../src/solver/contracts.ts";
import { collectProofIssues } from "../../src/solver/proof.ts";
import { runExactMoveAStar } from "../../src/solver/search/exact-move-astar.ts";
import { verifySolverSolution } from "../../src/solver/verification.ts";
import { BENCHMARK_CORPUS } from "../fixtures/solver-v2/benchmark-corpus.ts";
import {
  KNOWN_FIXTURE_OUTCOMES_BY_ID,
  KNOWN_OPTIMA_EXTENDED_GATE_FIXTURE_IDS,
} from "../fixtures/solver-v2/known-optima.ts";

const fixtureById = new Map(BENCHMARK_CORPUS.map((fixture) => [fixture.fixtureId, fixture]));

describe("frozen known-optimum extended gate", () => {
  for (const fixtureId of KNOWN_OPTIMA_EXTENDED_GATE_FIXTURE_IDS) {
    it(`${fixtureId} reproduces its frozen outcome and exact proof`, async () => {
      const fixture = fixtureById.get(fixtureId);
      assert.ok(fixture, `missing benchmark fixture ${fixtureId}`);
      const parsed = parsePuzzleRows([...fixture.rows]);
      const expected = KNOWN_FIXTURE_OUTCOMES_BY_ID[fixtureId];
      const request: SolverRequest = {
        board: parsed,
        snapshot: {
          puzzleId: fixtureId,
          robot: parsed.initialRobot,
          boxes: parsed.initialBoxes,
          moves: 0,
          pushes: 0,
          solved: expected.kind === "solved" && expected.moves === 0,
        },
        objective: { kind: "moves" },
        limits: { maxElapsedMs: 600_000, maxMemoryBytes: 2_147_483_648 },
      };
      const context: SolverExecutionContext = {
        signal: new AbortController().signal,
        reportProgress: () => undefined,
        now: () => performance.now(),
      };
      const result = await runExactMoveAStar(request, context);
      if (expected.kind === "unsolvable") {
        assert.equal(result.status, "unsolved");
        if (result.status !== "unsolved") return;
        assert.equal(result.reason, "exhausted");
        assert.equal(result.proof?.kind, "unsolvable");
        assert.deepEqual(collectProofIssues(result.proof, null), []);
        return;
      }
      assert.equal(result.status, "solved");
      if (result.status !== "solved") return;
      assert.equal(result.solution.moves, expected.moves);
      assert.equal(result.solution.pushes, expected.pushes);
      assert.equal(verifySolverSolution(request, result.solution).valid, true);
      assert.deepEqual(collectProofIssues(result.proof, result.solution), []);
      assert.equal(result.proof?.kind, "optimal");
      assert.equal(result.proof?.lowerBound, expected.moves);
      assert.equal(result.proof?.upperBound, expected.moves);
      assert.equal(result.proof?.gap, 0);
    });
  }
});
