/**
 * Production Solver V2 benchmark CLI.
 *
 * Timed samples run in isolated processes. `--warmup` therefore means
 * untimed cold preflight runs; it does not claim to warm a later process.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { cpus, hostname, totalmem } from "node:os";
import { fileURLToPath } from "node:url";

import {
  BENCHMARK_PROFILE_IDS,
  BENCHMARK_PROFILES,
  BENCHMARK_SCHEMA_VERSION,
  benchmarkCorpusFingerprint,
  benchmarkTuningFingerprint,
  benchmarkRunIdentity,
  compareFeatureSummaries,
  expectedBenchmarkPairs,
  hasStableCleanBenchmarkGitProvenance,
  isPromotableBenchmarkBaseline,
  isProfileEligible,
  parseBenchmarkArguments,
  parseChildSample,
  runBenchmarkSample,
  selectBenchmarkFixtures,
  summarizeBenchmarkSamples,
  type BenchmarkProfileId,
  type BenchmarkFeatureRun,
  type BenchmarkGitSnapshot,
  type BenchmarkSample,
  type BenchmarkSampleSummary,
} from "./solver-v2-benchmark-lib.ts";
import { BENCHMARK_CORPUS } from "../tests/fixtures/solver-v2/benchmark-corpus.ts";

function gitValue(args: readonly string[]): string {
  const result = spawnSync("git", [...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
  });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

function captureGitSnapshot(): BenchmarkGitSnapshot {
  return Object.freeze({
    commit: gitValue(["rev-parse", "HEAD"]),
    status: gitValue(["status", "--porcelain"]),
  });
}

function childErrorSample(
  fixtureId: string,
  profileId: BenchmarkProfileId,
  detail: string,
  elapsedMs: number,
  featureRun?: BenchmarkFeatureRun,
): BenchmarkSample {
  const profile = BENCHMARK_PROFILES[profileId];
  return Object.freeze({
    runIdentity: benchmarkRunIdentity(fixtureId, profileId, featureRun),
    fixtureId,
    fixtureGroup: "primary-v2",
    boardHash: "unknown",
    width: 0,
    height: 0,
    floorCount: 0,
    boxCount: 0,
    profileId,
    solverId: profile.solverId,
    solverVersion: profile.solverVersion,
    configuration: Object.freeze({
      deterministic: profile.deterministic,
      workerCount: profile.workerCount,
      limits: profile.limits,
      ...(profile.sokomindOptions
        ? { sokomindOptions: profile.sokomindOptions }
        : {}),
    }),
    status: "error",
    detail,
    elapsedMs,
    rssBeforeBytes: 0,
    rssAfterBytes: 0,
    peakRssBytes: 0,
    accepted: false,
    ...(featureRun
      ? {
          featureUnderTest: featureRun.feature,
          featureEnabled: featureRun.enabled,
        }
      : {}),
  });
}

function runIsolatedSample(
  scriptPath: string,
  fixtureId: string,
  profileId: BenchmarkProfileId,
  featureRun?: BenchmarkFeatureRun,
): BenchmarkSample {
  const startedAt = performance.now();
  const profile = BENCHMARK_PROFILES[profileId];
  const timeout = (profile.limits.maxElapsedMs ?? 300_000) + 30_000;
  const child = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      scriptPath,
      "--child",
      `--child-fixture=${fixtureId}`,
      `--child-profile=${profileId}`,
      ...(featureRun
        ? [
            `--child-feature=${featureRun.feature}`,
            `--child-feature-enabled=${featureRun.enabled ? 1 : 0}`,
          ]
        : []),
    ],
    {
      encoding: "utf8",
      env: process.env,
      timeout,
      windowsHide: true,
    },
  );
  const elapsedMs = Math.round(performance.now() - startedAt);
  try {
    return parseChildSample(
      child.stdout ?? "",
      fixtureId,
      profileId,
      child.status,
      featureRun,
    );
  } catch (caught) {
    const detail = [
      caught instanceof Error ? caught.message : String(caught),
      child.error?.message,
      child.signal ? `signal=${child.signal}` : undefined,
      child.stderr?.trim(),
    ].filter(Boolean).join("; ");
    return childErrorSample(
      fixtureId,
      profileId,
      detail,
      elapsedMs,
      featureRun,
    );
  }
}

async function main(): Promise<void> {
  const args = parseBenchmarkArguments(process.argv.slice(2));
  if (args.childMode) {
    if (!args.childFixtureId || !args.childProfileId) {
      throw new Error("Child mode requires --child-fixture and --child-profile");
    }
    const fixtures = selectBenchmarkFixtures([args.childFixtureId]);
    const fixture = fixtures[0];
    const profile = BENCHMARK_PROFILES[args.childProfileId];
    if (!isProfileEligible(fixture, profile)) {
      throw new Error(`${profile.id} is not eligible for ${fixture.fixtureId}`);
    }
    if (
      (args.childFeature === undefined) !==
      (args.childFeatureEnabled === undefined)
    ) {
      throw new Error(
        "Child feature runs require --child-feature and --child-feature-enabled together",
      );
    }
    const featureRun = args.childFeature === undefined
      ? undefined
      : {
          feature: args.childFeature,
          enabled: args.childFeatureEnabled!,
        };
    const sample = await runBenchmarkSample(fixture, profile, featureRun);
    process.stdout.write(`${JSON.stringify(sample)}\n`);
    return;
  }

  const fixtures = selectBenchmarkFixtures(args.fixtureIds);
  const scriptPath = fileURLToPath(import.meta.url);
  const summaries: BenchmarkSampleSummary[] = [];
  if (
    args.compareFeature &&
    args.profileIds.some(
      (profileId) =>
        profileId !== "classic-astar" && profileId !== "classic-ida-star",
    )
  ) {
    throw new Error(
      "--compare-feature accepts only classic-astar and classic-ida-star profiles",
    );
  }
  const gitStart = captureGitSnapshot();
  process.stderr.write(
    `Benchmark methodology: cold isolated; ${args.warmupRuns} untimed preflight(s), ` +
      `${args.timedRuns} timed sample(s)\n`,
  );

  for (const fixture of fixtures) {
    for (const profileId of args.profileIds) {
      const profile = BENCHMARK_PROFILES[profileId];
      if (!isProfileEligible(fixture, profile)) continue;
      const variants: readonly (BenchmarkFeatureRun | undefined)[] =
        args.compareFeature
          ? [
              { feature: args.compareFeature, enabled: true },
              { feature: args.compareFeature, enabled: false },
            ]
          : [undefined];
      for (const featureRun of variants) {
        for (let index = 0; index < args.warmupRuns; index += 1) {
          process.stderr.write(
            `  ${benchmarkRunIdentity(fixture.fixtureId, profileId, featureRun)}: ` +
              `preflight ${index + 1}/${args.warmupRuns}\n`,
          );
          runIsolatedSample(
            scriptPath,
            fixture.fixtureId,
            profileId,
            featureRun,
          );
        }
        const samples: BenchmarkSample[] = [];
        for (let index = 0; index < args.timedRuns; index += 1) {
          const sample = runIsolatedSample(
            scriptPath,
            fixture.fixtureId,
            profileId,
            featureRun,
          );
          samples.push(sample);
          process.stderr.write(
            `  ${sample.runIdentity}: ${sample.status}` +
              (sample.moves === undefined ? "" : ` ${sample.moves} moves`) +
              ` [${sample.elapsedMs}ms] ${index + 1}/${args.timedRuns}\n`,
          );
        }
        summaries.push(summarizeBenchmarkSamples(samples));
      }
    }
  }

  const comparisons = args.compareFeature
    ? summaries
        .filter((summary) => summary.featureEnabled === true)
        .map((control) => {
          const without = summaries.find(
            (candidate) =>
              candidate.fixtureId === control.fixtureId &&
              candidate.profileId === control.profileId &&
              candidate.featureUnderTest === control.featureUnderTest &&
              candidate.featureEnabled === false,
          );
          if (!without) throw new Error(`Missing A/B pair for ${control.runIdentity}`);
          return compareFeatureSummaries(control, without);
        })
    : [];

  const fullExpectedPairs = expectedBenchmarkPairs(
    BENCHMARK_CORPUS,
    BENCHMARK_PROFILE_IDS,
  );
  const selectedExpectedPairs = expectedBenchmarkPairs(fixtures, args.profileIds) *
    (args.compareFeature ? 2 : 1);
  const partial = args.compareFeature !== undefined ||
    fixtures.length !== BENCHMARK_CORPUS.length ||
    args.profileIds.length !== BENCHMARK_PROFILE_IDS.length;
  const gitEnd = captureGitSnapshot();
  const stableCleanGit = hasStableCleanBenchmarkGitProvenance(gitStart, gitEnd);
  const output = Object.freeze({
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    captureDate: new Date().toISOString(),
    methodology: "cold-isolated" as const,
    warmupSemantics: "untimed-cold-preflight" as const,
    timedRuns: args.timedRuns,
    warmupRuns: args.warmupRuns,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuInfo: cpus()[0]?.model,
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    hostname: hostname(),
    git: Object.freeze({
      commit: gitEnd.commit,
      dirty: gitEnd.status !== "",
      statusKnown: gitEnd.status !== "unknown",
      stableClean: stableCleanGit,
      start: Object.freeze({
        commit: gitStart.commit,
        dirty: gitStart.status !== "",
        statusKnown: gitStart.status !== "unknown",
      }),
      end: Object.freeze({
        commit: gitEnd.commit,
        dirty: gitEnd.status !== "",
        statusKnown: gitEnd.status !== "unknown",
      }),
    }),
    corpus: Object.freeze({
      fingerprint: benchmarkCorpusFingerprint(),
      totalFixtures: BENCHMARK_CORPUS.length,
      selectedFixtures: fixtures.length,
      fullExpectedPairs,
      selectedExpectedPairs,
      partial,
    }),
    tuningFingerprint: benchmarkTuningFingerprint(),
    compareFeature: args.compareFeature,
    profiles: Object.freeze(
      Object.fromEntries(args.profileIds.map((profileId) => [
        profileId,
        BENCHMARK_PROFILES[profileId],
      ])),
    ),
    promotableBaseline: isPromotableBenchmarkBaseline({
      partial,
      compareFeature: args.compareFeature,
      summaryCount: summaries.length,
      expectedPairs: fullExpectedPairs,
      allAccepted: summaries.every((summary) => summary.accepted),
      timedRuns: args.timedRuns,
      gitStart,
      gitEnd,
    }),
    results: Object.freeze(summaries),
    comparisons: Object.freeze(comparisons),
  });

  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  process.stdout.write(serialized);
  if (args.savePath) {
    const destination = resolve(args.savePath);
    if (existsSync(destination) && !args.force) {
      throw new Error(
        `Refusing to overwrite existing benchmark artifact: ${destination}. ` +
          "Choose a versioned filename or pass --force explicitly.",
      );
    }
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, serialized, { flag: args.force ? "w" : "wx" });
    process.stderr.write(`Saved immutable benchmark artifact to ${destination}\n`);
  }

  const accepted = summaries.filter((summary) => summary.accepted).length;
  process.stderr.write(
    `Summary: ${accepted}/${summaries.length} accepted deterministic sample groups\n`,
  );
  if (summaries.some((summary) => !summary.accepted)) process.exitCode = 2;
}

main().catch((caught) => {
  process.stderr.write(`${caught instanceof Error ? caught.stack ?? caught.message : String(caught)}\n`);
  process.exitCode = 1;
});
