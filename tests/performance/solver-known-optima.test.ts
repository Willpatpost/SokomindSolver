import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parsePuzzleRows } from "../../src/core/index.ts";
import type {
  SolverExecutionContext,
  SolverRequest,
  SolverResult,
} from "../../src/solver/contracts.ts";
import { collectProofIssues } from "../../src/solver/proof.ts";
import { compileSearchBoard } from "../../src/solver/search/compiled-board.ts";
import { runExactMoveAStar } from "../../src/solver/search/exact-move-astar.ts";
import { runIdaStarSearch } from "../../src/solver/search/ida-star.ts";
import { toDenseBoxes } from "../../src/solver/search/model.ts";
import { verifySolverSolution } from "../../src/solver/verification.ts";
import { exactRemainingMoves } from "../support/exact-solver-oracle.ts";
import { BENCHMARK_CORPUS } from "../fixtures/solver-v2/benchmark-corpus.ts";
import {
  KNOWN_FIXTURE_OUTCOMES_BY_ID,
  KNOWN_FIXTURE_ROWS_OUTSIDE_CORPUS,
  KNOWN_OPTIMA_BY_FIXTURE_ID,
  KNOWN_OPTIMA_EXTENDED_GATE_FIXTURE_IDS,
  KNOWN_OPTIMA_IDA_STAR_GATE_FIXTURE_IDS,
  KNOWN_OPTIMA_STANDARD_GATE_FIXTURE_IDS,
  KNOWN_UNSOLVABLE_BY_FIXTURE_ID,
  type KnownFixtureOutcome,
} from "../fixtures/solver-v2/known-optima.ts";
import { TUNNEL_SOUNDNESS_FIXTURES } from "../fixtures/solver-v2/tunnel-soundness.ts";

function context(): SolverExecutionContext {
  return {
    signal: new AbortController().signal,
    reportProgress: () => undefined,
    now: () => performance.now(),
  };
}

const fixtureById = new Map(BENCHMARK_CORPUS.map((fixture) => [fixture.fixtureId, fixture]));

function fixtureRows(fixtureId: string): readonly string[] {
  const rows = fixtureById.get(fixtureId)?.rows ??
    KNOWN_FIXTURE_ROWS_OUTSIDE_CORPUS[fixtureId];
  assert.ok(rows, `missing fixture rows for ${fixtureId}`);
  return rows;
}

function requestFor(fixtureId: string): SolverRequest {
  const parsed = parsePuzzleRows([...fixtureRows(fixtureId)]);
  const expected = KNOWN_FIXTURE_OUTCOMES_BY_ID[fixtureId];
  return {
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
    limits: { maxElapsedMs: 60_000, maxMemoryBytes: 1_073_741_824 },
  };
}

function assertFrozenOutcome(
  request: SolverRequest,
  result: SolverResult,
  expected: KnownFixtureOutcome,
): void {
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
  assert.equal(result.solution.optimality, "proven");
  assert.equal(verifySolverSolution(request, result.solution).valid, true);
  assert.deepEqual(collectProofIssues(result.proof, result.solution), []);
  assert.equal(result.proof?.kind, "optimal");
  assert.equal(result.proof?.lowerBound, expected.moves);
  assert.equal(result.proof?.upperBound, expected.moves);
  assert.equal(result.proof?.gap, 0);
}

describe("frozen known-optimum executable gate", () => {
  it("partitions the manifest exactly once and references only frozen fixtures", () => {
    const manifest = Object.keys(KNOWN_FIXTURE_OUTCOMES_BY_ID).sort();
    assert.equal(
      manifest.length,
      Object.keys(KNOWN_OPTIMA_BY_FIXTURE_ID).length +
        Object.keys(KNOWN_UNSOLVABLE_BY_FIXTURE_ID).length,
      "no fixture may be frozen as both solved and unsolvable",
    );
    const policy = [
      ...KNOWN_OPTIMA_STANDARD_GATE_FIXTURE_IDS,
      ...KNOWN_OPTIMA_EXTENDED_GATE_FIXTURE_IDS,
    ].sort();
    assert.deepEqual(policy, manifest);
    assert.equal(new Set(policy).size, policy.length);
    for (const fixtureId of policy) {
      assert.notEqual(
        fixtureById.has(fixtureId),
        Object.hasOwn(KNOWN_FIXTURE_ROWS_OUTSIDE_CORPUS, fixtureId),
        `${fixtureId} needs exactly one row source`,
      );
    }
    for (const fixtureId of Object.keys(KNOWN_FIXTURE_ROWS_OUTSIDE_CORPUS)) {
      assert.ok(Object.hasOwn(KNOWN_FIXTURE_OUTCOMES_BY_ID, fixtureId));
    }
  });

  it("gates both proof kinds through both exact engines", () => {
    for (const fixtureIds of [
      KNOWN_OPTIMA_STANDARD_GATE_FIXTURE_IDS,
      KNOWN_OPTIMA_IDA_STAR_GATE_FIXTURE_IDS,
    ]) {
      const kinds = new Set(
        fixtureIds.map((fixtureId) => KNOWN_FIXTURE_OUTCOMES_BY_ID[fixtureId].kind),
      );
      assert.deepEqual([...kinds].sort(), ["solved", "unsolvable"]);
    }
  });

  it("keeps the move optima of the tunnel-soundness boards it reuses", () => {
    const reused = TUNNEL_SOUNDNESS_FIXTURES.filter((fixture) =>
      Object.hasOwn(KNOWN_FIXTURE_ROWS_OUTSIDE_CORPUS, fixture.id));
    assert.deepEqual(reused.map((fixture) => fixture.id), ["es01c", "es01d"]);
    for (const fixture of reused) {
      assert.equal(KNOWN_OPTIMA_BY_FIXTURE_ID[fixture.id]?.moves, fixture.moves);
    }
  });

  it("reproduces the step-oracle provenance of every IDA*-gated entry", () => {
    for (const fixtureId of KNOWN_OPTIMA_IDA_STAR_GATE_FIXTURE_IDS) {
      const parsed = parsePuzzleRows([...fixtureRows(fixtureId)]);
      const board = compileSearchBoard(parsed);
      const oracle = exactRemainingMoves(
        board,
        board.cellAt(parsed.initialRobot.row, parsed.initialRobot.column),
        toDenseBoxes(board, parsed.initialBoxes),
      );
      const expected = KNOWN_FIXTURE_OUTCOMES_BY_ID[fixtureId];
      assert.deepEqual(
        {
          moves: oracle.exactMoves,
          pushes: oracle.exactPushes,
          oracleStates: oracle.statesExplored,
        },
        expected.kind === "solved"
          ? {
              moves: expected.moves,
              pushes: expected.pushes,
              oracleStates: expected.oracleStates,
            }
          : { moves: null, pushes: null, oracleStates: expected.oracleStates },
        fixtureId,
      );
    }
  });

  for (const fixtureId of KNOWN_OPTIMA_STANDARD_GATE_FIXTURE_IDS) {
    it(`${fixtureId} reproduces its frozen outcome and exact proof`, async () => {
      const request = requestFor(fixtureId);
      const result = await runExactMoveAStar(request, context());
      assertFrozenOutcome(request, result, KNOWN_FIXTURE_OUTCOMES_BY_ID[fixtureId]);
    });
  }

  for (const fixtureId of KNOWN_OPTIMA_IDA_STAR_GATE_FIXTURE_IDS) {
    it(`${fixtureId} reproduces its frozen outcome and exact proof under IDA*`, async () => {
      const request = requestFor(fixtureId);
      const result = await runIdaStarSearch(request, context());
      assertFrozenOutcome(request, result, KNOWN_FIXTURE_OUTCOMES_BY_ID[fixtureId]);
    });
  }
});
