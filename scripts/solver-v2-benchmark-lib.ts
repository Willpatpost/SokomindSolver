import { createHash } from "node:crypto";

import { createSession, type PuzzleDefinition } from "../src/core/index.ts";
import type {
  SolverAdapter,
  SolverExecutionContext,
  SolverLimits,
  SolverRequest,
  SolverResult,
} from "../src/solver/contracts.ts";
import {
  classicAStarSolver,
  classicIdaStarSolver,
} from "../src/solver/implementations/classic-solvers.ts";
import {
  DEFAULT_SOKOMIND_REQUEST_OPTIONS,
  parseSokomindOptions,
  type SokomindRequestOptions,
} from "../src/solver/implementations/sokomind-options.ts";
import { sokomindSolverMetadata } from "../src/solver/implementations/sokomind-solver.ts";
import {
  resolveSokomindTuning,
  sokomindTuningPayload,
} from "../src/solver/implementations/sokomind-tuning.ts";
import { createNodeSolverAdapter } from "../src/solver/node-runner.ts";
import { collectProofIssues } from "../src/solver/proof.ts";
import { verifySolverSolution } from "../src/solver/verification.ts";
import { runExactMoveAStar } from "../src/solver/search/exact-move-astar.ts";
import {
  EXACT_SEARCH_FEATURE_KEYS,
  exactSearchFeatureFingerprint,
  resolveExactSearchFeatures,
  type ExactSearchFeatureKey,
  type ExactSearchFeatures,
} from "../src/solver/search/exact-search-features.ts";
import { runIdaStarSearch } from "../src/solver/search/ida-star.ts";
import {
  BENCHMARK_CORPUS,
  BENCHMARK_FIXTURE_BY_ID,
  computeBoardHash,
  isClassicEligible,
  type BenchmarkFixture,
  type BenchmarkFixtureGroup,
} from "../tests/fixtures/solver-v2/benchmark-corpus.ts";
import {
  KNOWN_FIXTURE_OUTCOMES_BY_ID,
  type KnownFixtureOutcome,
} from "../tests/fixtures/solver-v2/known-optima.ts";

export const BENCHMARK_SCHEMA_VERSION = 3 as const;
export const DEFAULT_TIMED_RUNS = 5;
export const DEFAULT_WARMUP_RUNS = 0;
/**
 * The solver owns its configured elapsed cutoff. This watchdog is only a
 * last-resort escape hatch if the solver fails to observe that cutoff.
 */
export const BENCHMARK_ABORT_GRACE_MS = 5_000;

export const CLASSIC_LIMITS: Readonly<SolverLimits> = Object.freeze({
  maxElapsedMs: 60_000,
  maxExpandedStates: 500_000,
  maxGeneratedStates: 5_000_000,
  maxMemoryBytes: 512 * 1024 * 1024,
});

export const SOKOMIND_LIMITS: Readonly<SolverLimits> = Object.freeze({
  maxElapsedMs: 180_000,
  maxExpandedStates: 500_000,
  maxGeneratedStates: 5_000_000,
  maxMemoryBytes: 768 * 1024 * 1024,
});

export const BENCHMARK_PROFILE_IDS = Object.freeze([
  "sokomind-fast",
  "sokomind-quality",
  "sokomind-optimal-astar",
  "sokomind-optimal-ida",
  "classic-astar",
  "classic-ida-star",
] as const);

export type BenchmarkProfileId = (typeof BENCHMARK_PROFILE_IDS)[number];

export interface BenchmarkProfile {
  readonly id: BenchmarkProfileId;
  readonly solverId: string;
  readonly solverVersion: string;
  readonly deterministic: boolean;
  readonly workerCount: number;
  readonly requiresKnownOptimum: boolean;
  readonly classicEligibleOnly: boolean;
  readonly limits: Readonly<SolverLimits>;
  readonly sokomindOptions?: SokomindRequestOptions;
}

function productionSokomindOptions(
  mode: SokomindRequestOptions["mode"],
  proofAlgorithm: SokomindRequestOptions["proofAlgorithm"],
): SokomindRequestOptions {
  return parseSokomindOptions({
    ...DEFAULT_SOKOMIND_REQUEST_OPTIONS,
    mode,
    proofAlgorithm,
    deterministic: true,
    proofParallelism: 1,
  });
}

export const BENCHMARK_PROFILES: Readonly<
  Record<BenchmarkProfileId, BenchmarkProfile>
> = Object.freeze({
  "sokomind-fast": Object.freeze({
    id: "sokomind-fast",
    solverId: sokomindSolverMetadata.id,
    solverVersion: sokomindSolverMetadata.version,
    deterministic: true,
    workerCount: 1,
    requiresKnownOptimum: false,
    classicEligibleOnly: false,
    limits: SOKOMIND_LIMITS,
    sokomindOptions: productionSokomindOptions("fast", "auto"),
  }),
  "sokomind-quality": Object.freeze({
    id: "sokomind-quality",
    solverId: sokomindSolverMetadata.id,
    solverVersion: sokomindSolverMetadata.version,
    deterministic: true,
    workerCount: 1,
    requiresKnownOptimum: false,
    classicEligibleOnly: false,
    limits: SOKOMIND_LIMITS,
    sokomindOptions: productionSokomindOptions("quality", "auto"),
  }),
  "sokomind-optimal-astar": Object.freeze({
    id: "sokomind-optimal-astar",
    solverId: sokomindSolverMetadata.id,
    solverVersion: sokomindSolverMetadata.version,
    deterministic: true,
    workerCount: 1,
    requiresKnownOptimum: true,
    classicEligibleOnly: true,
    limits: CLASSIC_LIMITS,
    sokomindOptions: productionSokomindOptions("optimal", "astar"),
  }),
  "sokomind-optimal-ida": Object.freeze({
    id: "sokomind-optimal-ida",
    solverId: sokomindSolverMetadata.id,
    solverVersion: sokomindSolverMetadata.version,
    deterministic: true,
    workerCount: 1,
    requiresKnownOptimum: true,
    classicEligibleOnly: true,
    limits: CLASSIC_LIMITS,
    sokomindOptions: productionSokomindOptions("optimal", "ida-star"),
  }),
  "classic-astar": Object.freeze({
    id: "classic-astar",
    solverId: classicAStarSolver.metadata.id,
    solverVersion: classicAStarSolver.metadata.version,
    deterministic: true,
    workerCount: 1,
    requiresKnownOptimum: true,
    classicEligibleOnly: true,
    limits: CLASSIC_LIMITS,
  }),
  "classic-ida-star": Object.freeze({
    id: "classic-ida-star",
    solverId: classicIdaStarSolver.metadata.id,
    solverVersion: classicIdaStarSolver.metadata.version,
    deterministic: true,
    workerCount: 1,
    requiresKnownOptimum: true,
    classicEligibleOnly: true,
    limits: CLASSIC_LIMITS,
  }),
});

export interface BenchmarkArguments {
  readonly fixtureIds: readonly string[];
  readonly profileIds: readonly BenchmarkProfileId[];
  readonly savePath?: string;
  readonly force: boolean;
  readonly childMode: boolean;
  readonly childFixtureId?: string;
  readonly childProfileId?: BenchmarkProfileId;
  readonly timedRuns: number;
  readonly warmupRuns: number;
  readonly compareFeature?: ExactSearchFeatureKey;
  readonly childFeature?: ExactSearchFeatureKey;
  readonly childFeatureEnabled?: boolean;
}

function optionValues(argv: readonly string[], name: string): readonly string[] {
  const prefix = `--${name}=`;
  return argv
    .filter((argument) => argument.startsWith(prefix))
    .map((argument) => argument.slice(prefix.length));
}

function optionalValue(argv: readonly string[], name: string): string | undefined {
  const values = optionValues(argv, name);
  if (values.length > 1) throw new Error(`--${name} may be supplied only once`);
  return values[0];
}

function parseIntegerOption(
  raw: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
): number {
  if (raw === undefined) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(raw)) {
    throw new Error(`--${name} must be a base-10 integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`--${name} must be at least ${minimum}`);
  }
  return value;
}

function isProfileId(value: string): value is BenchmarkProfileId {
  return BENCHMARK_PROFILE_IDS.some((profileId) => profileId === value);
}

function isFeatureKey(value: string): value is ExactSearchFeatureKey {
  return EXACT_SEARCH_FEATURE_KEYS.some((key) => key === value);
}

export function parseBenchmarkArguments(
  argv: readonly string[],
): BenchmarkArguments {
  const compareFeature = optionalValue(argv, "compare-feature");
  if (compareFeature !== undefined && !isFeatureKey(compareFeature)) {
    throw new Error(
      `Unknown exact-search feature '${compareFeature}'. Expected one of: ${EXACT_SEARCH_FEATURE_KEYS.join(", ")}`,
    );
  }
  const childFeature = optionalValue(argv, "child-feature");
  if (childFeature !== undefined && !isFeatureKey(childFeature)) {
    throw new Error(`Unknown child exact-search feature '${childFeature}'`);
  }
  const childFeatureEnabledRaw = optionalValue(argv, "child-feature-enabled");
  if (
    childFeatureEnabledRaw !== undefined &&
    childFeatureEnabledRaw !== "0" &&
    childFeatureEnabledRaw !== "1"
  ) {
    throw new Error("--child-feature-enabled must be 0 or 1");
  }
  const requestedProfiles = optionValues(argv, "profile");
  for (const profileId of requestedProfiles) {
    if (!isProfileId(profileId)) {
      throw new Error(
        `Unknown benchmark profile '${profileId}'. Expected one of: ${BENCHMARK_PROFILE_IDS.join(", ")}`,
      );
    }
  }
  const childProfile = optionalValue(argv, "child-profile");
  if (childProfile !== undefined && !isProfileId(childProfile)) {
    throw new Error(`Unknown child benchmark profile '${childProfile}'`);
  }
  return Object.freeze({
    fixtureIds: Object.freeze(optionValues(argv, "fixture").filter(Boolean)),
    profileIds: Object.freeze(
      requestedProfiles.length > 0
        ? [...new Set(requestedProfiles as readonly BenchmarkProfileId[])]
        : compareFeature !== undefined
          ? (["classic-astar", "classic-ida-star"] as BenchmarkProfileId[])
        : [...BENCHMARK_PROFILE_IDS],
    ),
    savePath: optionalValue(argv, "save"),
    force: argv.includes("--force"),
    childMode: argv.includes("--child"),
    childFixtureId: optionalValue(argv, "child-fixture"),
    childProfileId: childProfile,
    timedRuns: parseIntegerOption(
      optionalValue(argv, "runs"),
      "runs",
      DEFAULT_TIMED_RUNS,
      1,
    ),
    warmupRuns: parseIntegerOption(
      optionalValue(argv, "warmup"),
      "warmup",
      DEFAULT_WARMUP_RUNS,
      0,
    ),
    compareFeature,
    childFeature,
    childFeatureEnabled: childFeatureEnabledRaw === undefined
      ? undefined
      : childFeatureEnabledRaw === "1",
  });
}

export function selectBenchmarkFixtures(
  fixtureIds: readonly string[],
): readonly BenchmarkFixture[] {
  if (fixtureIds.length === 0) return BENCHMARK_CORPUS;
  const selected = new Map<string, BenchmarkFixture>();
  for (const fixtureId of fixtureIds) {
    const fixture = BENCHMARK_FIXTURE_BY_ID[fixtureId];
    if (!fixture) throw new Error(`Unknown benchmark fixture '${fixtureId}'`);
    selected.set(fixture.fixtureId, fixture);
  }
  return Object.freeze([...selected.values()]);
}

export function isProfileEligible(
  fixture: BenchmarkFixture,
  profile: BenchmarkProfile,
): boolean {
  if (profile.classicEligibleOnly && !isClassicEligible(fixture)) return false;
  return !profile.requiresKnownOptimum ||
    KNOWN_FIXTURE_OUTCOMES_BY_ID[fixture.fixtureId] !== undefined;
}

export function benchmarkWatchdogDelayMs(
  maximumElapsedMs: number | undefined,
): number | undefined {
  if (maximumElapsedMs === undefined) return undefined;
  return Math.min(
    2_147_483_647,
    Math.max(0, maximumElapsedMs) + BENCHMARK_ABORT_GRACE_MS,
  );
}

export function benchmarkRequest(
  fixture: BenchmarkFixture,
  profile: BenchmarkProfile,
): SolverRequest {
  const puzzle: PuzzleDefinition = {
    id: fixture.fixtureId,
    title: fixture.fixtureId,
    difficulty: "beginner",
    boxes: fixture.boxes,
    rows: [...fixture.rows],
  };
  const session = createSession(puzzle);
  return Object.freeze({
    board: session.board,
    snapshot: session.snapshot,
    objective: Object.freeze({ kind: "moves" as const }),
    limits: Object.freeze({ ...profile.limits }),
    ...(profile.sokomindOptions
      ? {
          options: Object.freeze({
            "sokomind-solver": Object.freeze({ ...profile.sokomindOptions }),
          }),
        }
      : {}),
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record).sort().map(
      (key) => `${JSON.stringify(key)}:${stableJson(record[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 16);
}

export function benchmarkCorpusFingerprint(): string {
  return fingerprint(
    BENCHMARK_CORPUS.map((fixture) => ({
      id: fixture.fixtureId,
      boardHash: computeBoardHash(fixture.rows),
    })),
  );
}

export function benchmarkTuningFingerprint(): string {
  return fingerprint(sokomindTuningPayload(resolveSokomindTuning()));
}

export interface BenchmarkSample {
  readonly runIdentity: string;
  readonly fixtureId: string;
  readonly fixtureGroup: BenchmarkFixtureGroup;
  readonly boardHash: string;
  readonly width: number;
  readonly height: number;
  readonly floorCount: number;
  readonly boxCount: number;
  readonly profileId: BenchmarkProfileId;
  readonly solverId: string;
  readonly solverVersion: string;
  readonly configuration: Readonly<{
    deterministic: boolean;
    workerCount: number;
    limits: Readonly<SolverLimits>;
    sokomindOptions?: SokomindRequestOptions;
    exactFeatures?: ExactSearchFeatures;
    exactFeatureFingerprint?: string;
  }>;
  readonly status: "solved" | "unsolved" | "cancelled" | "error";
  readonly optimality?: "unknown" | "proven";
  readonly reason?: string;
  readonly detail?: string;
  readonly moves?: number;
  readonly pushes?: number;
  readonly lowerBound?: number;
  readonly upperBound?: number;
  readonly gap?: number;
  readonly expandedStates?: number;
  readonly generatedStates?: number;
  readonly peakFrontierSize?: number;
  readonly estimatedMemoryBytes?: number;
  readonly rssBeforeBytes: number;
  readonly rssAfterBytes: number;
  readonly peakRssBytes: number;
  readonly elapsedMs: number;
  readonly counters?: Readonly<Record<string, number>>;
  readonly verified?: boolean;
  readonly proofValid?: boolean;
  readonly knownOutcomeKind?: KnownFixtureOutcome["kind"];
  readonly knownOptimalMoves?: number;
  readonly knownOptimalPushes?: number;
  readonly matchesKnownOptimum?: boolean;
  readonly accepted: boolean;
  readonly featureUnderTest?: ExactSearchFeatureKey;
  readonly featureEnabled?: boolean;
}

export interface BenchmarkFeatureRun {
  readonly feature: ExactSearchFeatureKey;
  readonly enabled: boolean;
}

export function benchmarkRunIdentity(
  fixtureId: string,
  profileId: BenchmarkProfileId,
  featureRun?: BenchmarkFeatureRun,
): string {
  return featureRun
    ? `${fixtureId}:${profileId}:${featureRun.enabled ? "control" : "without"}:${featureRun.feature}`
    : `${fixtureId}:${profileId}`;
}

function profileAdapter(profileId: BenchmarkProfileId): SolverAdapter {
  switch (profileId) {
    case "classic-astar":
      return classicAStarSolver;
    case "classic-ida-star":
      return classicIdaStarSolver;
    case "sokomind-fast":
    case "sokomind-quality":
    case "sokomind-optimal-astar":
    case "sokomind-optimal-ida":
      return createNodeSolverAdapter({ hardwareConcurrency: 2 });
  }
}

function resultStatus(result: SolverResult): BenchmarkSample["status"] {
  return result.status;
}

async function solveBenchmarkProfile(
  request: SolverRequest,
  context: SolverExecutionContext,
  profile: BenchmarkProfile,
  featureRun?: BenchmarkFeatureRun,
): Promise<SolverResult> {
  if (!featureRun) return profileAdapter(profile.id).solve(request, context);
  const featureOverrides = {
    [featureRun.feature]: featureRun.enabled,
  } as Partial<ExactSearchFeatures>;
  if (profile.id === "classic-astar") {
    return runExactMoveAStar(request, context, { features: featureOverrides });
  }
  if (profile.id === "classic-ida-star") {
    return runIdaStarSearch(request, context, {
      features: featureOverrides,
      reachabilityPolicy: "none",
    });
  }
  throw new Error(
    `Feature comparisons require classic-astar or classic-ida-star, got ${profile.id}`,
  );
}

export async function runBenchmarkSample(
  fixture: BenchmarkFixture,
  profile: BenchmarkProfile,
  featureRun?: BenchmarkFeatureRun,
): Promise<BenchmarkSample> {
  const request = benchmarkRequest(fixture, profile);
  const controller = new AbortController();
  const watchdogDelay = benchmarkWatchdogDelayMs(profile.limits.maxElapsedMs);
  const timeout = watchdogDelay === undefined
    ? undefined
    : setTimeout(() => controller.abort(), watchdogDelay);
  const context: SolverExecutionContext = {
    signal: controller.signal,
    reportProgress() {},
    now: performance.now.bind(performance),
  };
  const rssBeforeBytes = process.memoryUsage.rss();
  const startedAt = performance.now();
  let result: SolverResult | undefined;
  let error: string | undefined;
  try {
    result = await solveBenchmarkProfile(request, context, profile, featureRun);
  } catch (caught) {
    error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
  const elapsedMs = Math.round(performance.now() - startedAt);
  const rssAfterBytes = process.memoryUsage.rss();
  const peakRssBytes = process.resourceUsage().maxRSS * 1024;
  const knownOutcome = KNOWN_FIXTURE_OUTCOMES_BY_ID[fixture.fixtureId];
  const exactFeatures = featureRun
    ? resolveExactSearchFeatures({ [featureRun.feature]: featureRun.enabled })
    : undefined;
  const common = {
    runIdentity: benchmarkRunIdentity(fixture.fixtureId, profile.id, featureRun),
    fixtureId: fixture.fixtureId,
    fixtureGroup: fixture.fixtureGroup,
    boardHash: computeBoardHash(fixture.rows),
    width: fixture.width,
    height: fixture.height,
    floorCount: fixture.floorCount,
    boxCount: fixture.boxes,
    profileId: profile.id,
    solverId: profile.solverId,
    solverVersion: profile.solverVersion,
    configuration: Object.freeze({
      deterministic: profile.deterministic,
      workerCount: profile.workerCount,
      limits: profile.limits,
      ...(profile.sokomindOptions
        ? { sokomindOptions: profile.sokomindOptions }
        : {}),
      ...(exactFeatures
        ? {
            exactFeatures,
            exactFeatureFingerprint: exactSearchFeatureFingerprint(exactFeatures),
          }
        : {}),
    }),
    elapsedMs,
    rssBeforeBytes,
    rssAfterBytes,
    peakRssBytes,
    ...(knownOutcome
      ? {
          knownOutcomeKind: knownOutcome.kind,
          ...(knownOutcome.kind === "solved"
            ? {
                knownOptimalMoves: knownOutcome.moves,
                knownOptimalPushes: knownOutcome.pushes,
              }
            : {}),
        }
      : {}),
    ...(featureRun
      ? {
          featureUnderTest: featureRun.feature,
          featureEnabled: featureRun.enabled,
        }
      : {}),
  } as const;
  if (!result || error) {
    return Object.freeze({
      ...common,
      status: "error" as const,
      detail: error ?? "Solver returned no result",
      accepted: false,
    });
  }
  const metrics = result.metrics;
  const base = {
    ...common,
    status: resultStatus(result),
    expandedStates: metrics.expandedStates,
    generatedStates: metrics.generatedStates,
    peakFrontierSize: metrics.peakFrontierSize,
    estimatedMemoryBytes: metrics.counters?.estimatedMemoryBytes,
    counters: metrics.counters ? Object.freeze({ ...metrics.counters }) : undefined,
    lowerBound: result.proof?.lowerBound ?? metrics.counters?.lowerBound,
    upperBound: result.proof?.upperBound,
    gap: result.proof?.gap,
  } as const;
  if (result.status === "solved") {
    const verification = verifySolverSolution(request, result.solution);
    const proofValid = collectProofIssues(result.proof, result.solution).length === 0;
    const matchesKnownOptimum = knownOutcome === undefined
      ? undefined
      : knownOutcome.kind === "solved" &&
        result.solution.moves === knownOutcome.moves;
    const accepted = verification.valid &&
      (!profile.requiresKnownOptimum ||
        (knownOutcome?.kind === "solved" &&
          result.solution.optimality === "proven" &&
          proofValid &&
          matchesKnownOptimum === true));
    return Object.freeze({
      ...base,
      status: "solved" as const,
      optimality: result.solution.optimality,
      moves: result.solution.moves,
      pushes: result.solution.pushes,
      verified: verification.valid,
      proofValid,
      matchesKnownOptimum,
      accepted,
      ...(!accepted
        ? {
            detail: !verification.valid
              ? verification.message
              : knownOutcome === undefined
                ? "No independent frozen outcome is available"
                : knownOutcome.kind === "unsolvable"
                  ? "Independent truth marks this fixture unsolvable"
                  : !proofValid
                    ? "Expected a structurally valid optimal proof"
                    : `Expected the frozen ${knownOutcome.moves}-move optimum`,
          }
        : {}),
    });
  }
  if (result.status === "unsolved") {
    const proofValid = collectProofIssues(result.proof, null).length === 0;
    const independentlyProvenUnsolvable =
      knownOutcome?.kind === "unsolvable" &&
      result.reason === "exhausted" &&
      result.proof?.kind === "unsolvable" &&
      proofValid;
    return Object.freeze({
      ...base,
      status: "unsolved" as const,
      reason: result.reason,
      detail: result.detail,
      proofValid,
      accepted: independentlyProvenUnsolvable,
    });
  }
  return Object.freeze({ ...base, status: "cancelled" as const, accepted: false });
}

export interface BenchmarkSampleSummary {
  readonly runIdentity: string;
  readonly fixtureId: string;
  readonly profileId: BenchmarkProfileId;
  readonly featureUnderTest?: ExactSearchFeatureKey;
  readonly featureEnabled?: boolean;
  readonly accepted: boolean;
  readonly consistent: boolean;
  readonly consistencyDetail?: string;
  readonly elapsedMs: Readonly<{
    minimum: number;
    median: number;
    maximum: number;
    medianAbsoluteDeviation: number;
  }>;
  readonly representative: BenchmarkSample;
  readonly samples: readonly BenchmarkSample[];
}

const FEATURE_EXERCISE_COUNTER: Readonly<
  Record<ExactSearchFeatureKey, string>
> = Object.freeze({
  incrementalAssignment: "incrementalAssignmentRepairs",
  linearConflict: "linearConflictEvaluations",
  interactionBoost: "interactionBoostEvaluations",
  patternDatabase: "pdbEvaluations",
  forcedPushMacros: "forcedPushMacroChecks",
  piCorralPruning: "piCorralChecks",
  patternDeadlockPruning: "patternDeadlockChecks",
  deadlockTablePruning: "deadlockTableChecks",
  goalCommitmentPruning: "goalCommitmentChecks",
});

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

function deterministicSignature(sample: BenchmarkSample): string {
  const featureCounter = sample.featureUnderTest === undefined
    ? undefined
    : sample.counters?.[FEATURE_EXERCISE_COUNTER[sample.featureUnderTest]];
  return stableJson({
    status: sample.status,
    optimality: sample.optimality,
    moves: sample.moves,
    pushes: sample.pushes,
    lowerBound: sample.lowerBound,
    upperBound: sample.upperBound,
    gap: sample.gap,
    expandedStates: sample.expandedStates,
    generatedStates: sample.generatedStates,
    verified: sample.verified,
    proofValid: sample.proofValid,
    matchesKnownOptimum: sample.matchesKnownOptimum,
    exactFeatureMask: sample.counters?.exactFeatureMask,
    featureCounter,
  });
}

export function summarizeBenchmarkSamples(
  samples: readonly BenchmarkSample[],
): BenchmarkSampleSummary {
  if (samples.length === 0) throw new Error("Cannot summarize zero samples");
  const first = samples[0];
  if (samples.some((sample) => sample.runIdentity !== first.runIdentity)) {
    throw new Error("Cannot summarize samples with different run identities");
  }
  const signatures = new Set(samples.map(deterministicSignature));
  const consistent = signatures.size === 1;
  const elapsed = samples.map((sample) => sample.elapsedMs);
  const elapsedMedian = median(elapsed);
  const representative = [...samples].sort(
    (left, right) =>
      Math.abs(left.elapsedMs - elapsedMedian) -
        Math.abs(right.elapsedMs - elapsedMedian) ||
      left.elapsedMs - right.elapsedMs,
  )[0];
  return Object.freeze({
    runIdentity: first.runIdentity,
    fixtureId: first.fixtureId,
    profileId: first.profileId,
    ...(first.featureUnderTest
      ? {
          featureUnderTest: first.featureUnderTest,
          featureEnabled: first.featureEnabled,
        }
      : {}),
    accepted: consistent && samples.every((sample) => sample.accepted),
    consistent,
    ...(consistent
      ? {}
      : { consistencyDetail: "Deterministic status, proof, optimum, or state counters varied" }),
    elapsedMs: Object.freeze({
      minimum: Math.min(...elapsed),
      median: elapsedMedian,
      maximum: Math.max(...elapsed),
      medianAbsoluteDeviation: median(
        elapsed.map((value) => Math.abs(value - elapsedMedian)),
      ),
    }),
    representative,
    samples: Object.freeze([...samples]),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function assertBenchmarkChildSampleShape(value: unknown): asserts value is BenchmarkSample {
  if (!isRecord(value)) throw new Error("Benchmark child record must be an object");
  const requiredStrings = [
    "runIdentity",
    "fixtureId",
    "boardHash",
    "profileId",
    "solverId",
    "solverVersion",
  ] as const;
  for (const name of requiredStrings) {
    if (typeof value[name] !== "string" || value[name].length === 0) {
      throw new Error(`Benchmark child field ${name} must be a non-empty string`);
    }
  }
  if (!["primary-v2", "legacy-regression", "supplemental"].includes(
    value.fixtureGroup as string,
  )) {
    throw new Error("Benchmark child field fixtureGroup is invalid");
  }
  const requiredNonNegative = [
    "width",
    "height",
    "floorCount",
    "boxCount",
    "rssBeforeBytes",
    "rssAfterBytes",
    "peakRssBytes",
    "elapsedMs",
  ] as const;
  for (const name of requiredNonNegative) {
    if (!isFiniteNonNegative(value[name])) {
      throw new Error(`Benchmark child field ${name} must be finite and non-negative`);
    }
  }
  for (const name of ["width", "height", "floorCount", "boxCount"] as const) {
    if (!Number.isSafeInteger(value[name])) {
      throw new Error(`Benchmark child field ${name} must be a safe integer`);
    }
  }
  if (!isRecord(value.configuration)) {
    throw new Error("Benchmark child field configuration must be an object");
  }
  if (typeof value.configuration.deterministic !== "boolean") {
    throw new Error("Benchmark child configuration.deterministic must be boolean");
  }
  if (
    !Number.isSafeInteger(value.configuration.workerCount) ||
    (value.configuration.workerCount as number) < 1
  ) {
    throw new Error("Benchmark child configuration.workerCount must be a positive integer");
  }
  if (!isRecord(value.configuration.limits)) {
    throw new Error("Benchmark child configuration.limits must be an object");
  }
  for (const name of [
    "maxElapsedMs",
    "maxExpandedStates",
    "maxGeneratedStates",
    "maxMemoryBytes",
  ] as const) {
    const metric = value.configuration.limits[name];
    if (metric !== undefined && !isFiniteNonNegative(metric)) {
      throw new Error(
        `Benchmark child configuration.limits.${name} must be finite and non-negative`,
      );
    }
  }
  if (!["solved", "unsolved", "cancelled", "error"].includes(value.status as string)) {
    throw new Error("Benchmark child field status is invalid");
  }
  if (typeof value.accepted !== "boolean") {
    throw new Error("Benchmark child field accepted must be boolean");
  }
  const optionalNumbers = [
    "moves",
    "pushes",
    "lowerBound",
    "upperBound",
    "gap",
    "expandedStates",
    "generatedStates",
    "peakFrontierSize",
    "estimatedMemoryBytes",
    "knownOptimalMoves",
    "knownOptimalPushes",
  ] as const;
  for (const name of optionalNumbers) {
    if (value[name] !== undefined && !isFiniteNonNegative(value[name])) {
      throw new Error(`Benchmark child field ${name} must be finite and non-negative`);
    }
  }
  for (const name of [
    "moves",
    "pushes",
    "lowerBound",
    "upperBound",
    "gap",
    "expandedStates",
    "generatedStates",
    "peakFrontierSize",
    "estimatedMemoryBytes",
    "knownOptimalMoves",
    "knownOptimalPushes",
  ] as const) {
    if (value[name] !== undefined && !Number.isSafeInteger(value[name])) {
      throw new Error(`Benchmark child field ${name} must be a safe integer`);
    }
  }
  for (const name of ["verified", "proofValid", "matchesKnownOptimum"] as const) {
    if (value[name] !== undefined && typeof value[name] !== "boolean") {
      throw new Error(`Benchmark child field ${name} must be boolean`);
    }
  }
  for (const name of ["reason", "detail"] as const) {
    if (value[name] !== undefined && typeof value[name] !== "string") {
      throw new Error(`Benchmark child field ${name} must be a string`);
    }
  }
  if (
    value.knownOutcomeKind !== undefined &&
    value.knownOutcomeKind !== "solved" &&
    value.knownOutcomeKind !== "unsolvable"
  ) {
    throw new Error("Benchmark child field knownOutcomeKind is invalid");
  }
  if (value.counters !== undefined) {
    if (!isRecord(value.counters)) {
      throw new Error("Benchmark child field counters must be an object");
    }
    for (const [name, metric] of Object.entries(value.counters)) {
      if (!isFiniteNonNegative(metric)) {
        throw new Error(
          `Benchmark child counter ${name} must be finite and non-negative`,
        );
      }
    }
  }
  if (value.featureUnderTest !== undefined && !isFeatureKey(value.featureUnderTest as string)) {
    throw new Error("Benchmark child field featureUnderTest is invalid");
  }
  if (
    (value.featureUnderTest === undefined) !==
    (value.featureEnabled === undefined)
  ) {
    throw new Error(
      "Benchmark child featureUnderTest and featureEnabled must appear together",
    );
  }
  if (value.featureEnabled !== undefined && typeof value.featureEnabled !== "boolean") {
    throw new Error("Benchmark child field featureEnabled must be boolean");
  }
  if (value.status === "solved") {
    if (!Number.isSafeInteger(value.moves) || (value.moves as number) < 0) {
      throw new Error("Benchmark child solved sample requires non-negative integer moves");
    }
    if (!Number.isSafeInteger(value.pushes) || (value.pushes as number) < 0) {
      throw new Error("Benchmark child solved sample requires non-negative integer pushes");
    }
    if (value.optimality !== "unknown" && value.optimality !== "proven") {
      throw new Error("Benchmark child solved sample has invalid optimality");
    }
    if (typeof value.verified !== "boolean" || typeof value.proofValid !== "boolean") {
      throw new Error(
        "Benchmark child solved sample requires verified and proofValid booleans",
      );
    }
  } else if (value.status === "unsolved") {
    if (typeof value.reason !== "string" || value.reason.length === 0) {
      throw new Error("Benchmark child unsolved sample requires a reason");
    }
    if (typeof value.proofValid !== "boolean") {
      throw new Error("Benchmark child unsolved sample requires proofValid");
    }
  } else if (value.status === "error") {
    if (typeof value.detail !== "string" || value.detail.length === 0) {
      throw new Error("Benchmark child error sample requires detail");
    }
  }
}

export function parseChildSample(
  stdout: string,
  expectedFixtureId: string,
  expectedProfileId: BenchmarkProfileId,
  exitStatus: number | null,
  featureRun?: BenchmarkFeatureRun,
): BenchmarkSample {
  if (exitStatus !== 0) {
    throw new Error(`Benchmark child exited with status ${String(exitStatus)}`);
  }
  const lines = stdout.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length !== 1) {
    throw new Error(`Benchmark child must emit exactly one JSON record; got ${lines.length}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(lines[0]);
  } catch {
    throw new Error("Benchmark child emitted malformed JSON");
  }
  assertBenchmarkChildSampleShape(parsed);
  const sample = parsed;
  const expectedIdentity = benchmarkRunIdentity(
    expectedFixtureId,
    expectedProfileId,
    featureRun,
  );
  if (
    sample.fixtureId !== expectedFixtureId ||
    sample.profileId !== expectedProfileId ||
    sample.runIdentity !== expectedIdentity
  ) {
    throw new Error(
      `Benchmark child identity mismatch; expected ${expectedIdentity}`,
    );
  }
  return sample;
}

export interface BenchmarkFeatureComparison {
  readonly fixtureId: string;
  readonly profileId: BenchmarkProfileId;
  readonly feature: ExactSearchFeatureKey;
  readonly accepted: boolean;
  readonly knownOptimumAvailable: boolean;
  readonly featureExercised: boolean;
  readonly disabledCounterZero: boolean;
  readonly elapsedQualification: "improved" | "neutral" | "regressed";
  readonly rssQualification: "improved" | "neutral" | "regressed";
  readonly resourceVeto: boolean;
  readonly classification:
    | "improvement"
    | "regression"
    | "mixed"
    | "no-effect"
    | "inconclusive-not-exercised"
    | "invalid-correctness";
  readonly expandedDelta: number;
  readonly generatedDelta: number;
  readonly peakRssDeltaBytes: number;
  readonly medianElapsedDeltaMs: number;
  readonly control: BenchmarkSampleSummary;
  readonly withoutFeature: BenchmarkSampleSummary;
}

export const FEATURE_AB_ELAPSED_REVIEW_MS = 25;
export const FEATURE_AB_ELAPSED_REVIEW_RATIO = 0.1;
export const FEATURE_AB_RSS_REVIEW_BYTES = 8 * 1024 * 1024;
export const FEATURE_AB_RSS_REVIEW_RATIO = 0.1;
export const PROMOTABLE_BASELINE_MIN_TIMED_RUNS = DEFAULT_TIMED_RUNS;

export interface BenchmarkGitSnapshot {
  readonly commit: string;
  /** Empty means clean; "unknown" means the status command failed. */
  readonly status: string;
}

export function hasStableCleanBenchmarkGitProvenance(
  start: BenchmarkGitSnapshot,
  end: BenchmarkGitSnapshot,
): boolean {
  const knownCommit = (commit: string): boolean =>
    /^[0-9a-f]{40}$/iu.test(commit.trim());
  return knownCommit(start.commit) &&
    knownCommit(end.commit) &&
    start.commit.trim().toLowerCase() === end.commit.trim().toLowerCase() &&
    start.status === "" &&
    end.status === "";
}

function finiteMetric(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function compareFeatureSummaries(
  control: BenchmarkSampleSummary,
  withoutFeature: BenchmarkSampleSummary,
): BenchmarkFeatureComparison {
  if (
    control.fixtureId !== withoutFeature.fixtureId ||
    control.profileId !== withoutFeature.profileId ||
    control.featureUnderTest === undefined ||
    control.featureUnderTest !== withoutFeature.featureUnderTest ||
    control.featureEnabled !== true ||
    withoutFeature.featureEnabled !== false
  ) {
    throw new Error("Feature comparison summaries are not a matched pair");
  }
  const feature = control.featureUnderTest;
  const exerciseCounter = FEATURE_EXERCISE_COUNTER[feature];
  const featureExercised = control.samples.every(
    (sample) => finiteMetric(sample.counters?.[exerciseCounter]) > 0,
  );
  const disabledCounterZero = withoutFeature.samples.every(
    (sample) => finiteMetric(sample.counters?.[exerciseCounter]) === 0,
  );
  const correctnessAccepted = control.accepted && withoutFeature.accepted;
  const expandedDelta =
    finiteMetric(withoutFeature.representative.expandedStates) -
    finiteMetric(control.representative.expandedStates);
  const generatedDelta =
    finiteMetric(withoutFeature.representative.generatedStates) -
    finiteMetric(control.representative.generatedStates);
  const medianElapsedDeltaMs =
    withoutFeature.elapsedMs.median - control.elapsedMs.median;
  const peakRssDeltaBytes =
    withoutFeature.representative.peakRssBytes -
    control.representative.peakRssBytes;
  const elapsedReviewThreshold = Math.max(
    FEATURE_AB_ELAPSED_REVIEW_MS,
    Math.abs(withoutFeature.elapsedMs.median) * FEATURE_AB_ELAPSED_REVIEW_RATIO,
  );
  const rssReviewThreshold = Math.max(
    FEATURE_AB_RSS_REVIEW_BYTES,
    Math.abs(withoutFeature.representative.peakRssBytes) *
      FEATURE_AB_RSS_REVIEW_RATIO,
  );
  const elapsedQualification = medianElapsedDeltaMs > elapsedReviewThreshold
    ? "improved"
    : medianElapsedDeltaMs < -elapsedReviewThreshold
      ? "regressed"
      : "neutral";
  const rssQualification = peakRssDeltaBytes > rssReviewThreshold
    ? "improved"
    : peakRssDeltaBytes < -rssReviewThreshold
      ? "regressed"
      : "neutral";
  const resourceVeto =
    elapsedQualification === "regressed" || rssQualification === "regressed";
  let classification: BenchmarkFeatureComparison["classification"];
  if (!correctnessAccepted || !disabledCounterZero) {
    classification = "invalid-correctness";
  } else if (!featureExercised) {
    classification = "inconclusive-not-exercised";
  } else if (expandedDelta === 0 && generatedDelta === 0) {
    classification = resourceVeto ? "regression" : "no-effect";
  } else if (expandedDelta >= 0 && generatedDelta >= 0) {
    classification = resourceVeto ? "mixed" : "improvement";
  } else if (expandedDelta <= 0 && generatedDelta <= 0) {
    classification = "regression";
  } else {
    classification = "mixed";
  }
  return Object.freeze({
    fixtureId: control.fixtureId,
    profileId: control.profileId,
    feature,
    accepted: correctnessAccepted && disabledCounterZero && featureExercised,
    knownOptimumAvailable:
      control.representative.knownOutcomeKind !== undefined &&
      withoutFeature.representative.knownOutcomeKind !== undefined,
    featureExercised,
    disabledCounterZero,
    elapsedQualification,
    rssQualification,
    resourceVeto,
    classification,
    expandedDelta,
    generatedDelta,
    peakRssDeltaBytes,
    medianElapsedDeltaMs,
    control,
    withoutFeature,
  });
}

export function isPromotableBenchmarkBaseline(input: {
  readonly partial: boolean;
  readonly compareFeature?: ExactSearchFeatureKey;
  readonly summaryCount: number;
  readonly expectedPairs: number;
  readonly allAccepted: boolean;
  readonly timedRuns: number;
  readonly gitStart: BenchmarkGitSnapshot;
  readonly gitEnd: BenchmarkGitSnapshot;
}): boolean {
  return !input.partial &&
    input.compareFeature === undefined &&
    input.summaryCount === input.expectedPairs &&
    input.allAccepted &&
    input.timedRuns >= PROMOTABLE_BASELINE_MIN_TIMED_RUNS &&
    hasStableCleanBenchmarkGitProvenance(input.gitStart, input.gitEnd);
}

export function expectedBenchmarkPairs(
  fixtures: readonly BenchmarkFixture[],
  profileIds: readonly BenchmarkProfileId[],
): number {
  return fixtures.reduce(
    (total, fixture) => total + profileIds.filter(
      (profileId) => isProfileEligible(fixture, BENCHMARK_PROFILES[profileId]),
    ).length,
    0,
  );
}
