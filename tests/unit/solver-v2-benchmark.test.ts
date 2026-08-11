import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BENCHMARK_PROFILES,
  benchmarkRequest,
  compareFeatureSummaries,
  expectedBenchmarkPairs,
  parseBenchmarkArguments,
  parseChildSample,
  selectBenchmarkFixtures,
  summarizeBenchmarkSamples,
  type BenchmarkSample,
} from "../../scripts/solver-v2-benchmark-lib.ts";
import {
  BENCHMARK_CORPUS,
  INTER_ROOMS,
} from "../fixtures/solver-v2/benchmark-corpus.ts";

function sample(overrides: Partial<BenchmarkSample> = {}): BenchmarkSample {
  return {
    runIdentity: "inter-rooms:classic-astar",
    fixtureId: "inter-rooms",
    fixtureGroup: "primary-v2",
    boardHash: "hash",
    width: 11,
    height: 6,
    floorCount: 30,
    boxCount: 4,
    profileId: "classic-astar",
    solverId: "classic-astar",
    solverVersion: "test",
    configuration: {
      deterministic: true,
      workerCount: 1,
      limits: {},
    },
    status: "solved",
    optimality: "proven",
    moves: 28,
    pushes: 7,
    lowerBound: 28,
    upperBound: 28,
    gap: 0,
    expandedStates: 10,
    generatedStates: 20,
    rssBeforeBytes: 1,
    rssAfterBytes: 2,
    peakRssBytes: 3,
    elapsedMs: 5,
    verified: true,
    knownOptimalMoves: 28,
    knownOptimalPushes: 7,
    matchesKnownOptimum: true,
    accepted: true,
    ...overrides,
  };
}

describe("Solver V2 benchmark harness", () => {
  it("parses zero warmups without falling back", () => {
    const parsed = parseBenchmarkArguments(["--warmup=0", "--runs=1"]);
    assert.equal(parsed.warmupRuns, 0);
    assert.equal(parsed.timedRuns, 1);
  });

  it("selects exact profiles and validates controlled feature names", () => {
    const parsed = parseBenchmarkArguments([
      "--compare-feature=patternDatabase",
    ]);
    assert.deepEqual(parsed.profileIds, ["classic-astar", "classic-ida-star"]);
    assert.equal(parsed.compareFeature, "patternDatabase");
    assert.throws(
      () => parseBenchmarkArguments(["--compare-feature=goalMacros"]),
      /Unknown exact-search feature/,
    );
  });

  it("rejects malformed numeric arguments", () => {
    assert.throws(
      () => parseBenchmarkArguments(["--runs=wat"]),
      /base-10 integer/,
    );
    assert.throws(
      () => parseBenchmarkArguments(["--warmup=-1"]),
      /base-10 integer/,
    );
  });

  it("puts the exact recorded limits and production options on requests", () => {
    const profile = BENCHMARK_PROFILES["sokomind-optimal-ida"];
    const request = benchmarkRequest(INTER_ROOMS, profile);
    assert.deepEqual(request.limits, profile.limits);
    assert.deepEqual(
      request.options?.["sokomind-solver"],
      profile.sokomindOptions,
    );
  });

  it("resolves aliases once and counts the full eligible profile matrix", () => {
    assert.deepEqual(
      selectBenchmarkFixtures(["huge", "grand-hall"]).map(({ fixtureId }) => fixtureId),
      ["v2-17box-handdesigned"],
    );
    const pairs = expectedBenchmarkPairs(
      BENCHMARK_CORPUS,
      ["classic-astar", "classic-ida-star"],
    );
    assert.equal(pairs, 74);
  });

  it("rejects child output with the wrong identity or exit status", () => {
    const encoded = `${JSON.stringify(sample())}\n`;
    assert.throws(
      () => parseChildSample(encoded, "tiny", "classic-astar", 0),
      /identity mismatch/,
    );
    assert.throws(
      () => parseChildSample(encoded, "inter-rooms", "classic-astar", 1),
      /exited with status/,
    );
  });

  it("keeps every raw sample and rejects deterministic counter drift", () => {
    const summary = summarizeBenchmarkSamples([
      sample({ elapsedMs: 10 }),
      sample({ elapsedMs: 20, expandedStates: 11 }),
      sample({ elapsedMs: 30 }),
    ]);
    assert.equal(summary.samples.length, 3);
    assert.equal(summary.elapsedMs.median, 20);
    assert.equal(summary.consistent, false);
    assert.equal(summary.accepted, false);
  });

  it("classifies a matched, exercised A/B pair from deterministic states", () => {
    const control = summarizeBenchmarkSamples([
      sample({
        runIdentity: "inter-rooms:classic-astar:control:patternDatabase",
        featureUnderTest: "patternDatabase",
        featureEnabled: true,
        expandedStates: 8,
        generatedStates: 16,
        counters: { pdbEvaluations: 10 },
      }),
    ]);
    const without = summarizeBenchmarkSamples([
      sample({
        runIdentity: "inter-rooms:classic-astar:without:patternDatabase",
        featureUnderTest: "patternDatabase",
        featureEnabled: false,
        expandedStates: 10,
        generatedStates: 20,
        counters: { pdbEvaluations: 0 },
      }),
    ]);
    const comparison = compareFeatureSummaries(control, without);
    assert.equal(comparison.accepted, true);
    assert.equal(comparison.featureExercised, true);
    assert.equal(comparison.classification, "improvement");
    assert.equal(comparison.expandedDelta, 2);
    assert.equal(comparison.generatedDelta, 4);
  });
});
