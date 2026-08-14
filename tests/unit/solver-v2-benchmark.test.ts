import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BENCHMARK_PROFILES,
  BENCHMARK_ABORT_GRACE_MS,
  benchmarkRequest,
  benchmarkWatchdogDelayMs,
  compareFeatureSummaries,
  expectedBenchmarkPairs,
  isPromotableBenchmarkBaseline,
  isProfileEligible,
  PROMOTABLE_BASELINE_MIN_TIMED_RUNS,
  parseBenchmarkArguments,
  parseChildSample,
  runBenchmarkSample,
  selectBenchmarkFixtures,
  summarizeBenchmarkSamples,
  type BenchmarkSample,
} from "../../scripts/solver-v2-benchmark-lib.ts";
import {
  BENCHMARK_CORPUS,
  INTER_ROOMS,
  isClassicEligible,
  ULTRA_TINY,
} from "../fixtures/solver-v2/benchmark-corpus.ts";
import { KNOWN_FIXTURE_OUTCOMES_BY_ID } from "../fixtures/solver-v2/known-optima.ts";

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
    proofValid: true,
    knownOutcomeKind: "solved",
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
    assert.equal(pairs, 66);
  });

  it("runs exact profiles only where independent frozen truth exists", () => {
    const exactProfile = BENCHMARK_PROFILES["classic-astar"];
    const fastProfile = BENCHMARK_PROFILES["sokomind-fast"];
    for (const fixtureId of [
      "large",
      "theme-parking",
      "theme-museum",
      "master-exchange",
    ]) {
      const fixture = BENCHMARK_CORPUS.find(
        (candidate) => candidate.fixtureId === fixtureId,
      );
      assert.ok(fixture);
      assert.equal(isProfileEligible(fixture, exactProfile), false);
      assert.equal(isProfileEligible(fixture, fastProfile), true);
    }
    const newlyFrozen = BENCHMARK_CORPUS.find(
      (fixture) => fixture.fixtureId === "v2-wide-multi-entry",
    );
    assert.ok(newlyFrozen);
    assert.equal(isProfileEligible(newlyFrozen, exactProfile), true);

    const expectedExactFixtureIds = BENCHMARK_CORPUS
      .filter((fixture) =>
        isClassicEligible(fixture) &&
        KNOWN_FIXTURE_OUTCOMES_BY_ID[fixture.fixtureId] !== undefined)
      .map((fixture) => fixture.fixtureId);
    for (const profileId of [
      "sokomind-optimal-astar",
      "sokomind-optimal-ida",
      "classic-astar",
      "classic-ida-star",
    ] as const) {
      assert.deepEqual(
        BENCHMARK_CORPUS
          .filter((fixture) =>
            isProfileEligible(fixture, BENCHMARK_PROFILES[profileId]))
          .map((fixture) => fixture.fixtureId),
        expectedExactFixtureIds,
      );
    }
  });

  it("fails closed when an exact sample has no independent outcome", async () => {
    const fixture = Object.freeze({
      ...ULTRA_TINY,
      fixtureId: "unfrozen-ultra-tiny",
    });
    const result = await runBenchmarkSample(
      fixture,
      BENCHMARK_PROFILES["classic-astar"],
    );
    assert.equal(result.status, "solved");
    assert.equal(result.verified, true);
    assert.equal(result.proofValid, true);
    assert.equal(result.accepted, false);
    assert.match(result.detail ?? "", /No independent frozen outcome/);
  });

  it("accepts a frozen exact result only with replay and a valid certificate", async () => {
    const result = await runBenchmarkSample(
      ULTRA_TINY,
      BENCHMARK_PROFILES["classic-astar"],
    );
    assert.equal(result.status, "solved");
    assert.equal(result.verified, true);
    assert.equal(result.proofValid, true);
    assert.equal(result.matchesKnownOptimum, true);
    assert.equal(result.lowerBound, 1);
    assert.equal(result.upperBound, 1);
    assert.equal(result.gap, 0);
    assert.equal(result.accepted, true);
  });

  it("does not accept an exhausted unsolved sample without frozen unsolvable truth", async () => {
    const fixture = Object.freeze({
      fixtureId: "unfrozen-unsolvable",
      catalogId: null,
      fixtureGroup: "supplemental" as const,
      boxes: 1,
      floorCount: 6,
      width: 5,
      height: 4,
      rows: Object.freeze(["OOOOO", "OAR O", "O  aO", "OOOOO"]),
    });
    const baseProfile = BENCHMARK_PROFILES["classic-astar"];
    const nonOptimalProfile = Object.freeze({
      ...baseProfile,
      requiresKnownOptimum: false,
    });
    const result = await runBenchmarkSample(fixture, nonOptimalProfile);
    assert.equal(result.status, "unsolved");
    assert.equal(result.reason, "exhausted");
    assert.equal(result.proofValid, true);
    assert.equal(result.knownOutcomeKind, undefined);
    assert.equal(result.accepted, false);
  });

  it("lets the solver own cutoffs and retains their deterministic lower bound", async () => {
    assert.equal(benchmarkWatchdogDelayMs(undefined), undefined);
    assert.equal(
      benchmarkWatchdogDelayMs(60_000),
      60_000 + BENCHMARK_ABORT_GRACE_MS,
    );
    const baseProfile = BENCHMARK_PROFILES["classic-astar"];
    const cutoffProfile = Object.freeze({
      ...baseProfile,
      limits: Object.freeze({
        ...baseProfile.limits,
        maxElapsedMs: 5_000,
        maxExpandedStates: 1,
      }),
    });
    const result = await runBenchmarkSample(INTER_ROOMS, cutoffProfile);
    assert.equal(result.status, "unsolved");
    assert.equal(result.reason, "limit-reached");
    assert.equal(typeof result.lowerBound, "number");
    assert.ok((result.lowerBound ?? -1) >= 0);
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

  it("rejects malformed child samples even when their identity matches", () => {
    assert.throws(
      () => parseChildSample(
        `${JSON.stringify({ ...sample(), elapsedMs: null })}\n`,
        "inter-rooms",
        "classic-astar",
        0,
      ),
      /elapsedMs must be finite and non-negative/,
    );
    assert.throws(
      () => parseChildSample(
        `${JSON.stringify({
          ...sample(),
          counters: { heuristicCalls: -1 },
        })}\n`,
        "inter-rooms",
        "classic-astar",
        0,
      ),
      /counter heuristicCalls must be finite and non-negative/,
    );
    const missingRequiredMetric: Record<string, unknown> = { ...sample() };
    delete missingRequiredMetric.peakRssBytes;
    assert.throws(
      () => parseChildSample(
        `${JSON.stringify(missingRequiredMetric)}\n`,
        "inter-rooms",
        "classic-astar",
        0,
      ),
      /peakRssBytes must be finite and non-negative/,
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

  it("rejects a feature that is not exercised in every control sample", () => {
    const controlIdentity =
      "inter-rooms:classic-astar:control:patternDatabase";
    const withoutIdentity =
      "inter-rooms:classic-astar:without:patternDatabase";
    const control = summarizeBenchmarkSamples([
      sample({
        runIdentity: controlIdentity,
        featureUnderTest: "patternDatabase",
        featureEnabled: true,
        counters: { exactFeatureMask: 511, pdbEvaluations: 10 },
      }),
      sample({
        runIdentity: controlIdentity,
        featureUnderTest: "patternDatabase",
        featureEnabled: true,
        counters: { exactFeatureMask: 511, pdbEvaluations: 0 },
      }),
    ]);
    const without = summarizeBenchmarkSamples([
      sample({
        runIdentity: withoutIdentity,
        featureUnderTest: "patternDatabase",
        featureEnabled: false,
        counters: { exactFeatureMask: 503, pdbEvaluations: 0 },
      }),
      sample({
        runIdentity: withoutIdentity,
        featureUnderTest: "patternDatabase",
        featureEnabled: false,
        counters: { exactFeatureMask: 503, pdbEvaluations: 0 },
      }),
    ]);
    const comparison = compareFeatureSummaries(control, without);
    assert.equal(control.consistent, false);
    assert.equal(comparison.featureExercised, false);
    assert.equal(comparison.accepted, false);
    assert.equal(comparison.classification, "invalid-correctness");
  });

  it("rejects a disabled feature counter that is nonzero in any sample", () => {
    const controlIdentity =
      "inter-rooms:classic-astar:control:patternDatabase";
    const withoutIdentity =
      "inter-rooms:classic-astar:without:patternDatabase";
    const control = summarizeBenchmarkSamples([
      sample({
        runIdentity: controlIdentity,
        featureUnderTest: "patternDatabase",
        featureEnabled: true,
        counters: { exactFeatureMask: 511, pdbEvaluations: 10 },
      }),
      sample({
        runIdentity: controlIdentity,
        featureUnderTest: "patternDatabase",
        featureEnabled: true,
        counters: { exactFeatureMask: 511, pdbEvaluations: 10 },
      }),
    ]);
    const without = summarizeBenchmarkSamples([
      sample({
        runIdentity: withoutIdentity,
        featureUnderTest: "patternDatabase",
        featureEnabled: false,
        counters: { exactFeatureMask: 503, pdbEvaluations: 0 },
      }),
      sample({
        runIdentity: withoutIdentity,
        featureUnderTest: "patternDatabase",
        featureEnabled: false,
        counters: { exactFeatureMask: 503, pdbEvaluations: 1 },
      }),
    ]);
    const comparison = compareFeatureSummaries(control, without);
    assert.equal(without.consistent, false);
    assert.equal(comparison.disabledCounterZero, false);
    assert.equal(comparison.accepted, false);
    assert.equal(comparison.classification, "invalid-correctness");
  });

  it("vetoes an apparent work reduction when reviewed elapsed time regresses", () => {
    const control = summarizeBenchmarkSamples([
      sample({
        runIdentity: "inter-rooms:classic-astar:control:patternDatabase",
        featureUnderTest: "patternDatabase",
        featureEnabled: true,
        expandedStates: 8,
        generatedStates: 16,
        elapsedMs: 1_000,
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
        elapsedMs: 10,
        counters: { pdbEvaluations: 0 },
      }),
    ]);
    const comparison = compareFeatureSummaries(control, without);
    assert.equal(comparison.resourceVeto, true);
    assert.equal(comparison.elapsedQualification, "regressed");
    assert.equal(comparison.classification, "mixed");
  });

  it("vetoes an apparent work reduction when reviewed peak RSS regresses", () => {
    const control = summarizeBenchmarkSamples([
      sample({
        runIdentity: "inter-rooms:classic-astar:control:patternDatabase",
        featureUnderTest: "patternDatabase",
        featureEnabled: true,
        expandedStates: 8,
        generatedStates: 16,
        peakRssBytes: 64 * 1024 * 1024,
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
        peakRssBytes: 16 * 1024 * 1024,
        counters: { pdbEvaluations: 0 },
      }),
    ]);
    const comparison = compareFeatureSummaries(control, without);
    assert.equal(comparison.resourceVeto, true);
    assert.equal(comparison.rssQualification, "regressed");
    assert.equal(comparison.classification, "mixed");
  });

  it("requires a clean known commit and reviewed sample count for promotion", () => {
    const candidate = {
      partial: false,
      summaryCount: 2,
      expectedPairs: 2,
      allAccepted: true,
      timedRuns: PROMOTABLE_BASELINE_MIN_TIMED_RUNS,
      gitStart: {
        commit: "0123456789abcdef0123456789abcdef01234567",
        status: "",
      },
      gitEnd: {
        commit: "0123456789abcdef0123456789abcdef01234567",
        status: "",
      },
    } as const;
    assert.equal(isPromotableBenchmarkBaseline(candidate), true);
    assert.equal(
      isPromotableBenchmarkBaseline({
        ...candidate,
        gitEnd: { ...candidate.gitEnd, status: " M src/file.ts" },
      }),
      false,
    );
    assert.equal(
      isPromotableBenchmarkBaseline({
        ...candidate,
        gitEnd: { ...candidate.gitEnd, status: "unknown" },
      }),
      false,
    );
    assert.equal(
      isPromotableBenchmarkBaseline({
        ...candidate,
        gitStart: { ...candidate.gitStart, commit: "unknown" },
      }),
      false,
    );
    assert.equal(
      isPromotableBenchmarkBaseline({
        ...candidate,
        gitEnd: {
          ...candidate.gitEnd,
          commit: "1123456789abcdef0123456789abcdef01234567",
        },
      }),
      false,
    );
    assert.equal(
      isPromotableBenchmarkBaseline({
        ...candidate,
        timedRuns: PROMOTABLE_BASELINE_MIN_TIMED_RUNS - 1,
      }),
      false,
    );
  });
});
