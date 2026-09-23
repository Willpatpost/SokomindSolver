/**
 * Pattern-deadlock memo soundness regressions.
 *
 * One pattern cache serves a whole exact search. Its key used to leave out
 * the floor just outside the local window, so a deadlock cached for a closed
 * pocket also pruned an open pocket with the same in-window floor. That gave
 * a wrong proven optimum (pd-false-optimum) and a false unsolvability proof
 * (pd-false-unsolvable) with pattern-deadlock pruning on.
 */

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
import type { ExactSearchFeatures } from "../../src/solver/search/exact-search-features.ts";
import { runIdaStarSearch } from "../../src/solver/search/ida-star.ts";
import { toDenseBoxes } from "../../src/solver/search/model.ts";
import { verifySolverSolution } from "../../src/solver/verification.ts";
import { exactRemainingMoves } from "../support/exact-solver-oracle.ts";
import {
  PATTERN_DEADLOCK_SOUNDNESS_FIXTURES,
  type PatternDeadlockSoundnessFixture,
} from "../fixtures/solver-v2/pattern-deadlock-soundness.ts";

type Features = Partial<ExactSearchFeatures>;

const FEATURE_CONFIGS: readonly {
  readonly label: string;
  readonly features?: Features;
}[] = [
  { label: "default features" },
  { label: "tunnelMacros:true", features: { tunnelMacros: true } },
];

function requestFor(fixture: PatternDeadlockSoundnessFixture): SolverRequest {
  const board = parsePuzzleRows(fixture.rows);
  return {
    board,
    snapshot: {
      puzzleId: `pattern-deadlock-soundness-${fixture.id}`,
      robot: board.initialRobot,
      boxes: board.initialBoxes,
      moves: 0,
      pushes: 0,
      solved: false,
    },
    objective: { kind: "moves" },
    limits: {
      maxElapsedMs: 30_000,
      maxExpandedStates: 500_000,
      maxGeneratedStates: 2_000_000,
    },
  };
}

function context(): SolverExecutionContext {
  return {
    signal: new AbortController().signal,
    reportProgress() {},
    now: performance.now.bind(performance),
  };
}

function runExact(
  engine: "A*" | "IDA*",
  fixture: PatternDeadlockSoundnessFixture,
  features: Features | undefined,
): Promise<SolverResult> {
  const options = features === undefined ? undefined : { features };
  return engine === "A*"
    ? runExactMoveAStar(requestFor(fixture), context(), options)
    : runIdaStarSearch(requestFor(fixture), context(), options);
}

function assertProvenOptimum(
  result: SolverResult,
  fixture: PatternDeadlockSoundnessFixture,
  label: string,
): void {
  assert.notEqual(
    result.proof?.kind,
    "unsolvable",
    `${label}: ${fixture.id} is solvable in ${fixture.moves} moves`,
  );
  assert.equal(
    result.status,
    "solved",
    `${label}: expected solved, got ${result.status}` +
      (result.status === "unsolved" ? ` (${result.reason})` : ""),
  );
  if (result.status !== "solved") return;
  assert.equal(result.solution.moves, fixture.moves, `${label}: move optimum`);
  assert.equal(result.solution.optimality, "proven", `${label}: optimality`);
  assert.equal(result.proof?.kind, "optimal", `${label}: proof kind`);
  assert.deepEqual(
    collectProofIssues(result.proof, result.solution),
    [],
    `${label}: proof issues`,
  );
  assert.equal(
    verifySolverSolution(requestFor(fixture), result.solution).valid,
    true,
    `${label}: replay`,
  );
}

describe("pattern-deadlock soundness fixtures", () => {
  it("frozen optima match the independent step oracle", () => {
    for (const fixture of PATTERN_DEADLOCK_SOUNDNESS_FIXTURES) {
      const parsed = parsePuzzleRows(fixture.rows);
      const board = compileSearchBoard(parsed);
      const oracle = exactRemainingMoves(
        board,
        board.cellAt(parsed.initialRobot.row, parsed.initialRobot.column),
        toDenseBoxes(board, parsed.initialBoxes),
      );
      assert.equal(oracle.exactMoves, fixture.moves, `${fixture.id} moves`);
    }
  });
});

for (const fixture of PATTERN_DEADLOCK_SOUNDNESS_FIXTURES) {
  describe(`pattern-deadlock soundness: ${fixture.id} (${fixture.moves} moves)`, () => {
    for (const { label, features } of FEATURE_CONFIGS) {
      it(`A* and IDA* prove the oracle optimum with ${label}`, async () => {
        for (const engine of ["A*", "IDA*"] as const) {
          const result = await runExact(engine, fixture, features);
          const run = `${engine} ${label} ${fixture.id}`;
          assertProvenOptimum(result, fixture, run);
          // The fixture only guards the memo while pattern pruning runs on it.
          assert.ok(
            (result.metrics.counters?.patternDeadlockPrunes ?? 0) > 0,
            `${run}: pattern-deadlock pruning must fire`,
          );
        }
      });
    }
  });
}
