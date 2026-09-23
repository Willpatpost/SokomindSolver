/**
 * Tunnel-macro soundness regressions.
 *
 * Both exact kernels used to drop the single push into a tunnel whenever the
 * tunnel macro produced stops. That gave wrong proven optima (es01, es01c,
 * fz-corridor) and false unsolvability proofs (es01d, fz-unsolvable).
 * Forced-push macros hid the flaw on es01a, so every board also runs with
 * `forcedPushMacros: false`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parsePuzzleRows } from "../../src/core/index.ts";
import type {
  SolverExecutionContext,
  SolverRequest,
  SolverResult,
} from "../../src/solver/contracts.ts";
import {
  classicAStarSolver,
  classicIdaStarSolver,
} from "../../src/solver/implementations/classic-solvers.ts";
import { collectProofIssues } from "../../src/solver/proof.ts";
import { compileSearchBoard } from "../../src/solver/search/compiled-board.ts";
import { runExactMoveAStar } from "../../src/solver/search/exact-move-astar.ts";
import type { ExactSearchFeatures } from "../../src/solver/search/exact-search-features.ts";
import { runIdaStarSearch } from "../../src/solver/search/ida-star.ts";
import { toDenseBoxes } from "../../src/solver/search/model.ts";
import { TunnelMacroDetector } from "../../src/solver/search/tunnel-macros.ts";
import { verifySolverSolution } from "../../src/solver/verification.ts";
import { exactRemainingMoves } from "../support/exact-solver-oracle.ts";
import {
  TUNNEL_SOUNDNESS_BY_ID,
  TUNNEL_SOUNDNESS_FIXTURES,
  type TunnelSoundnessFixture,
} from "../fixtures/solver-v2/tunnel-soundness.ts";

type Features = Partial<ExactSearchFeatures>;

const FEATURE_CONFIGS: readonly {
  readonly label: string;
  readonly features?: Features;
}[] = [
  { label: "default features" },
  { label: "tunnelMacros:true", features: { tunnelMacros: true } },
  { label: "forcedPushMacros:false", features: { forcedPushMacros: false } },
  {
    label: "forcedPushMacros:false + tunnelMacros:true",
    features: { forcedPushMacros: false, tunnelMacros: true },
  },
];

function requestFor(fixture: TunnelSoundnessFixture): SolverRequest {
  const board = parsePuzzleRows(fixture.rows);
  return {
    board,
    snapshot: {
      puzzleId: `tunnel-soundness-${fixture.id}`,
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
  fixture: TunnelSoundnessFixture,
  features: Features | undefined,
): Promise<SolverResult> {
  const options = features === undefined ? undefined : { features };
  return engine === "A*"
    ? runExactMoveAStar(requestFor(fixture), context(), options)
    : runIdaStarSearch(requestFor(fixture), context(), options);
}

function assertProvenOptimum(
  result: SolverResult,
  fixture: TunnelSoundnessFixture,
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

describe("tunnel-macro soundness fixtures", () => {
  it("frozen optima match the independent step oracle", () => {
    for (const fixture of TUNNEL_SOUNDNESS_FIXTURES) {
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

for (const fixture of TUNNEL_SOUNDNESS_FIXTURES) {
  describe(`tunnel-macro soundness: ${fixture.id} (${fixture.moves} moves)`, () => {
    for (const { label, features } of FEATURE_CONFIGS) {
      it(`A* and IDA* prove the oracle optimum with ${label}`, async () => {
        for (const engine of ["A*", "IDA*"] as const) {
          const result = await runExact(engine, fixture, features);
          assertProvenOptimum(result, fixture, `${engine} ${label} ${fixture.id}`);
        }
      });
    }
  });
}

describe("tunnel-macro soundness through the classic adapters", () => {
  const solvers = [classicAStarSolver, classicIdaStarSolver] as const;
  for (const id of ["es01c", "es01d", "fz-unsolvable"] as const) {
    const fixture = TUNNEL_SOUNDNESS_BY_ID[id];
    it(`classic-astar and classic-ida-star never report ${id} unsolvable and prove ${fixture.moves}`, async () => {
      for (const solver of solvers) {
        const result = await solver.solve(requestFor(fixture), context());
        assertProvenOptimum(result, fixture, `${solver.metadata.id} ${id}`);
      }
    });
  }
});

describe("IDA* tunnel stops with pushCount >= 2", () => {
  // Guard for the IDA* macro-frame key (exactKey/zobristKey must use
  // stop.robotCell). No known board fails on the key defect alone, so this
  // test checks that multi-push stops are generated and that IDA* agrees
  // with A* and the oracle when they are.
  for (const id of ["es01d"] as const) {
    const fixture = TUNNEL_SOUNDNESS_BY_ID[id];
    it(`IDA* agrees with A* and the oracle on ${id} with multi-push tunnel stops`, async (t) => {
      const resolveSpy = t.mock.method(TunnelMacroDetector.prototype, "resolve");
      const maxStopPushCount = (): number => {
        let max = 0;
        for (const call of resolveSpy.mock.calls) {
          for (const stop of call.result?.stops ?? []) {
            max = Math.max(max, stop.pushCount);
          }
        }
        return max;
      };

      for (const features of [
        { tunnelMacros: true },
        { forcedPushMacros: false, tunnelMacros: true },
      ] satisfies Features[]) {
        const label = JSON.stringify(features);
        resolveSpy.mock.resetCalls();
        const ida = await runExact("IDA*", fixture, features);
        assert.ok(
          maxStopPushCount() >= 2,
          `${id} ${label}: IDA* must generate a tunnel stop with pushCount >= 2`,
        );
        assert.ok(
          (ida.metrics.counters?.tunnelMacroApplications ?? 0) > 0,
          `${id} ${label}: IDA* must apply a tunnel macro`,
        );
        assertProvenOptimum(ida, fixture, `IDA* ${label} ${id}`);

        const astar = await runExact("A*", fixture, features);
        assertProvenOptimum(astar, fixture, `A* ${label} ${id}`);
      }
    });
  }
});
