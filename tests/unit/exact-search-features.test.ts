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

const ROWS = [
  "OOOOOOOOOOO",
  "O    O    O",
  "O RX   XS O",
  "O XO O OX O",
  "OSSO   OS O",
  "OOOOOOOOOOO",
] as const;

function request(): SolverRequest {
  const board = parsePuzzleRows(ROWS);
  return {
    board,
    snapshot: {
      puzzleId: "feature-inter-rooms",
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
    assert.equal(exactSearchFeatureMask(resolved), 0b1_1111_1111);
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
      assert.equal(result.metrics.counters?.patternDeadlockChecks, 0);
      assert.equal(result.metrics.counters?.goalCommitmentChecks, 0);
    }
  });

  it("keeps every individual A/B-off variant at the inter-rooms optimum", async () => {
    for (const feature of EXACT_SEARCH_FEATURE_KEYS) {
      const features = { [feature]: false };
      const [astar, ida] = await Promise.all([
        runExactMoveAStar(request(), context(), { features }),
        runIdaStarSearch(request(), context(), {
          features,
          reachabilityPolicy: "none",
        }),
      ]);
      for (const result of [astar, ida]) {
        assert.equal(result.status, "solved", `${feature} off must solve`);
        if (result.status !== "solved") continue;
        assert.equal(result.solution.moves, 28, `${feature} off move optimum`);
        assert.equal(result.solution.pushes, 7, `${feature} off push count`);
        assert.equal(result.solution.optimality, "proven", `${feature} off proof`);
      }
    }
  });

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
