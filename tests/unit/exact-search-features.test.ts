import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parsePuzzleRows } from "../../src/core/index.ts";
import type {
  SolverExecutionContext,
  SolverRequest,
} from "../../src/solver/contracts.ts";
import { runExactMoveAStar } from "../../src/solver/search/exact-move-astar.ts";
import { runIdaStarSearch } from "../../src/solver/search/ida-star.ts";
import {
  ALL_OFF_EXACT_SEARCH_FEATURES,
  DEFAULT_EXACT_SEARCH_FEATURES,
  EXACT_SEARCH_FEATURE_KEYS,
  exactSearchFeatureFingerprint,
  exactSearchFeatureMask,
  resolveExactSearchFeatures,
} from "../../src/solver/search/exact-search-features.ts";
import { TUNNEL_SOUNDNESS_BY_ID } from "../fixtures/solver-v2/tunnel-soundness.ts";

const ROWS = [
  "OOOOOOOOOOO",
  "O    O    O",
  "O RX   XS O",
  "O XO O OX O",
  "OSSO   OS O",
  "OOOOOOOOOOO",
] as const;

function request(
  rows: readonly string[] = ROWS,
  puzzleId = "feature-inter-rooms",
): SolverRequest {
  const board = parsePuzzleRows(rows);
  return {
    board,
    snapshot: {
      puzzleId,
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
      maxGeneratedStates: 5_000_000,
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

// Inter-rooms plus the es01 tunnel boards (move optima from the step
// oracle, frozen in tests/fixtures/solver-v2/tunnel-soundness.ts). Only
// inter-rooms pins a push count; es01 pushes are tie-break dependent.
const SWEEP_BOARDS: readonly {
  readonly id: string;
  readonly rows: readonly string[];
  readonly moves: number;
  readonly pushes?: number;
}[] = [
  { id: "inter-rooms", rows: ROWS, moves: 28, pushes: 7 },
  TUNNEL_SOUNDNESS_BY_ID.es01a,
  TUNNEL_SOUNDNESS_BY_ID.es01c,
  TUNNEL_SOUNDNESS_BY_ID.es01d,
];

// Every single-feature-off variant, plus explicit tunnelMacros:true variants.
// tunnelMacros defaults to false, so { tunnelMacros: false } equals the
// defaults and the macro needs to be switched on explicitly to be covered.
const SWEEP_CONFIGS: readonly {
  readonly label: string;
  readonly features: Partial<Record<string, boolean>>;
}[] = [
  ...EXACT_SEARCH_FEATURE_KEYS.map((feature) => ({
    label: `${feature} off`,
    features: { [feature]: false },
  })),
  { label: "tunnelMacros on", features: { tunnelMacros: true } },
  {
    label: "forcedPushMacros off, tunnelMacros on",
    features: { forcedPushMacros: false, tunnelMacros: true },
  },
];

describe("exact-search feature configuration", () => {
  it("resolves frozen defaults and a stable ordered fingerprint", () => {
    const resolved = resolveExactSearchFeatures();
    assert.deepEqual(resolved, DEFAULT_EXACT_SEARCH_FEATURES);
    assert.ok(Object.isFrozen(resolved));
    assert.match(exactSearchFeatureFingerprint(resolved), /^exact-v1:/);
    assert.equal(
      exactSearchFeatureFingerprint(resolveExactSearchFeatures()),
      exactSearchFeatureFingerprint(resolveExactSearchFeatures({})),
    );
    assert.equal(DEFAULT_EXACT_SEARCH_FEATURES.tunnelMacros, false);
    assert.equal(exactSearchFeatureMask(resolved), 0b1011_1111_1111);
    assert.equal(resolveExactSearchFeatures({piCorralPruning: false}).piCorralPruning, false);
  });

  it("rejects unknown and non-boolean feature overrides", () => {
    assert.throws(
      () => resolveExactSearchFeatures({ unknown: true } as never),
      /Unknown exact-search feature/,
    );
    assert.throws(
      () => resolveExactSearchFeatures({ patternDatabase: 1 } as never),
      /must be boolean/,
    );
  });

  it("provides an explicit all-off control vector", () => {
    assert.ok(Object.values(ALL_OFF_EXACT_SEARCH_FEATURES).every((value) => !value));
    assert.equal(exactSearchFeatureMask(ALL_OFF_EXACT_SEARCH_FEATURES), 0);
  });

  it("keeps A* and IDA* optimal with every optional feature disabled", async () => {
    const [astar, ida] = await Promise.all([
      runExactMoveAStar(request(), context(), {
        features: ALL_OFF_EXACT_SEARCH_FEATURES,
      }),
      runIdaStarSearch(request(), context(), {
        features: ALL_OFF_EXACT_SEARCH_FEATURES,
        reachabilityPolicy: "none",
      }),
    ]);

    for (const result of [astar, ida]) {
      assert.equal(result.status, "solved");
      if (result.status !== "solved") continue;
      assert.equal(result.solution.moves, 28);
      assert.equal(result.solution.pushes, 7);
      assert.equal(result.solution.optimality, "proven");
      assert.equal(result.proof?.lowerBound, 28);
      assert.equal(result.proof?.upperBound, 28);
      assert.equal(result.metrics.counters?.pdbBuildTimeMs, 0);
      assert.equal(result.metrics.counters?.pdbTableEntries, 0);
      assert.equal(result.metrics.counters?.pdbEvaluations, 0);
      assert.equal(result.metrics.counters?.deadlockTableChecks, 0);
      assert.equal(result.metrics.counters?.forcedPushMacroChecks, 0);
      assert.equal(result.metrics.counters?.piCorralChecks, 0);
      assert.equal(result.metrics.counters?.corralOrderingChecks, 0);
      assert.equal(result.metrics.counters?.patternDeadlockChecks, 0);
      assert.equal(result.metrics.counters?.goalCommitmentChecks, 0);
    }
  });

  for (const board of SWEEP_BOARDS) {
    it(`keeps every individual A/B-off variant at the ${board.id} optimum`, async () => {
      for (const { label, features } of SWEEP_CONFIGS) {
        const [astar, ida] = await Promise.all([
          runExactMoveAStar(request(board.rows, `feature-${board.id}`), context(), {
            features,
          }),
          runIdaStarSearch(request(board.rows, `feature-${board.id}`), context(), {
            features,
            reachabilityPolicy: "none",
          }),
        ]);
        for (const [engine, result] of [["A*", astar], ["IDA*", ida]] as const) {
          const tag = `${board.id} ${engine} ${label}`;
          assert.equal(result.status, "solved", `${tag} must solve`);
          if (result.status !== "solved") continue;
          assert.equal(result.solution.moves, board.moves, `${tag} move optimum`);
          if (board.pushes !== undefined) {
            assert.equal(result.solution.pushes, board.pushes, `${tag} push count`);
          }
          assert.equal(result.solution.optimality, "proven", `${tag} proof`);
          assert.equal(result.proof?.kind, "optimal", `${tag} proof kind`);
        }
      }
    });
  }

  it("rejects non-default IDA* features when checkpointing is requested", async () => {
    await assert.rejects(
      runIdaStarSearch(request(), context(), {
        features: { patternDatabase: false },
        onCheckpoint() {},
      }),
      /default exact-search feature vector/,
    );
  });
});
