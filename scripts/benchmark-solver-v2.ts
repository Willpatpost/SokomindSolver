/**
 * Solver V2 benchmark runner.
 *
 * Produces versioned raw JSON baselines from the frozen benchmark corpus.
 * Each fixture is run in an isolated child process so heap/RSS measurements
 * are not contaminated by prior puzzles.
 *
 * Usage:
 *   npm run benchmark:solver:v2
 *   npm run benchmark:solver:v2 -- --fixture=huge
 *   npm run benchmark:solver:v2 -- --fixture=v2-17box-handdesigned
 *   npm run benchmark:solver:v2 -- --save=tests/fixtures/solver-v2/baseline-v0.json
 */

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import os from "node:os";

import {
  BENCHMARK_CORPUS,
  BENCHMARK_FIXTURE_BY_ID,
  computeBoardHash,
  isClassicEligible,
  type BenchmarkFixture,
  type BenchmarkFixtureGroup,
} from "../tests/fixtures/solver-v2/benchmark-corpus.ts";
import { createSession, type PuzzleDefinition } from "../src/core/index.ts";
import type {
  SolverExecutionContext,
  SolverRequest,
  SolverResult,
} from "../src/solver/contracts.ts";
import {
  classicAStarSolver,
  classicIdaStarSolver,
} from "../src/solver/implementations/classic-solvers.ts";
import { sokomindSolverMetadata } from "../src/solver/implementations/sokomind-solver.ts";
import { search } from "../src/solver/implementations/sokomind-engine/engine.generated.js";
import {
  solutionFromLegacyPath,
  toLegacyState,
  sokomindDiscoveryBeamWidth,
} from "../src/solver/implementations/sokomind-solver.ts";
import { verifySolverSolution } from "../src/solver/verification.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BenchmarkResultFile {
  schemaVersion: 2;
  captureDate: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  cpuInfo?: string;
  totalMemoryBytes?: number;
  hostname?: string;
  solverVersions: Record<string, string>;
  fixtures: BenchmarkFixtureResult[];
}

interface BenchmarkFixtureResult {
  fixtureId: string;
  fixtureGroup: BenchmarkFixtureGroup;

  boardHash: string;
  width: number;
  height: number;
  floorCount: number;
  boxCount: number;

  solver: string;
  solverVersion?: string;

  configuration: {
    deterministic: boolean;
    workerCount?: number;
    limits: {
      maxElapsedMs?: number;
      maxExpandedStates?: number;
      maxGeneratedStates?: number;
      maxMemoryBytes?: number;
    };
    [key: string]: unknown;
  };

  status: "solved" | "unsolved" | "cancelled" | "error";
  optimality?: "unknown" | "proven";
  reason?: string;
  detail?: string;

  moves?: number;
  pushes?: number;
  lowerBound?: number;
  gap?: number;
  expandedStates?: number;
  generatedStates?: number;
  reachabilityFloods?: number;
  reopens?: number;
  peakFrontierSize?: number;
  estimatedMemoryBytes?: number;
  processRssBytes?: number;
  assignmentCalls?: number;
  assignmentCacheHits?: number;
  elapsedMs: number;
  counters?: Record<string, number>;
  perLaneCounters?: Record<string, Record<string, number>>;

  verified?: boolean;
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const CLASSIC_LIMITS = Object.freeze({
  maxElapsedMs: 60_000,
  maxExpandedStates: 500_000,
  maxGeneratedStates: 5_000_000,
  maxMemoryBytes: 512 * 1024 * 1024,
});

const SOKOMIND_LIMITS = Object.freeze({
  maxElapsedMs: 180_000,
  maxMemoryBytes: 768 * 1024 * 1024,
});

const CHILD_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// Solver versions
// ---------------------------------------------------------------------------

const SOLVER_VERSIONS: Record<string, string> = {
  "sokomind-solver": sokomindSolverMetadata.version,
  "classic-astar": classicAStarSolver.metadata.version,
  "classic-ida-star": classicIdaStarSolver.metadata.version,
};

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const DEFAULT_TIMED_RUNS = 5;
const DEFAULT_WARMUP_RUNS = 1;

function parseArguments(): {
  fixtureIds: string[];
  savePath: string | undefined;
  childMode: boolean;
  childFixtureId: string | undefined;
  childSolver: string | undefined;
  timedRuns: number;
  warmupRuns: number;
} {
  const fixtureIds = process.argv
    .filter((a) => a.startsWith("--fixture="))
    .map((a) => a.slice("--fixture=".length))
    .filter(Boolean);
  const saveArg = process.argv.find((a) => a.startsWith("--save="));
  const savePath = saveArg ? saveArg.slice("--save=".length) : undefined;
  const childMode = process.argv.includes("--child");
  const runsArg = process.argv.find((a) => a.startsWith("--runs="));
  const timedRuns = runsArg ? Math.max(1, parseInt(runsArg.slice("--runs=".length), 10) || DEFAULT_TIMED_RUNS) : DEFAULT_TIMED_RUNS;
  const warmupArg = process.argv.find((a) => a.startsWith("--warmup="));
  const warmupRuns = warmupArg ? Math.max(0, parseInt(warmupArg.slice("--warmup=".length), 10) || DEFAULT_WARMUP_RUNS) : DEFAULT_WARMUP_RUNS;
  const childFixtureArg = process.argv.find((a) =>
    a.startsWith("--child-fixture="),
  );
  const childFixtureId = childFixtureArg
    ? childFixtureArg.slice("--child-fixture=".length)
    : undefined;
  const childSolverArg = process.argv.find((a) =>
    a.startsWith("--child-solver="),
  );
  const childSolver = childSolverArg
    ? childSolverArg.slice("--child-solver=".length)
    : undefined;
  return { fixtureIds, savePath, childMode, childFixtureId, childSolver, timedRuns, warmupRuns };
}

function selectMedian(results: BenchmarkFixtureResult[]): BenchmarkFixtureResult {
  const sorted = [...results].sort((a, b) => a.elapsedMs - b.elapsedMs);
  return sorted[Math.floor(sorted.length / 2)];
}

// ---------------------------------------------------------------------------
// Pre-constructed metadata template
// ---------------------------------------------------------------------------

function buildMetadata(
  fixture: BenchmarkFixture,
  solver: string,
): Omit<BenchmarkFixtureResult, "status" | "elapsedMs"> {
  const isSokomind = solver === "sokomind-solver";
  const limits = isSokomind ? { ...SOKOMIND_LIMITS } : { ...CLASSIC_LIMITS };

  return {
    fixtureId: fixture.fixtureId,
    fixtureGroup: fixture.fixtureGroup,
    boardHash: computeBoardHash(fixture.rows),
    width: fixture.width,
    height: fixture.height,
    floorCount: fixture.floorCount,
    boxCount: fixture.boxes,
    solver,
    solverVersion: SOLVER_VERSIONS[solver],
    configuration: {
      deterministic: !isSokomind,
      workerCount: 1,
      limits,
    },
  };
}

// ---------------------------------------------------------------------------
// Request construction from frozen rows
// ---------------------------------------------------------------------------

function requestFromRows(
  fixtureId: string,
  rows: readonly string[],
  boxes: number,
): SolverRequest {
  const puzzle: PuzzleDefinition = {
    id: fixtureId,
    title: fixtureId,
    difficulty: "beginner",
    boxes,
    rows: rows as string[],
  };
  const session = createSession(puzzle);
  return Object.freeze({
    board: session.board,
    snapshot: session.snapshot,
    objective: Object.freeze({ kind: "moves" as const }),
  });
}

// ---------------------------------------------------------------------------
// Classic solver runner (A*, IDA*)
// ---------------------------------------------------------------------------

async function runClassicSolver(
  solverId: "classic-astar" | "classic-ida-star",
  fixture: BenchmarkFixture,
): Promise<BenchmarkFixtureResult> {
  const meta = buildMetadata(fixture, solverId);
  const request = requestFromRows(
    fixture.fixtureId,
    fixture.rows,
    fixture.boxes,
  );
  const adapter =
    solverId === "classic-astar" ? classicAStarSolver : classicIdaStarSolver;

  const ac = new AbortController();
  const timeout = setTimeout(
    () => ac.abort(),
    CLASSIC_LIMITS.maxElapsedMs,
  );

  const context: SolverExecutionContext = {
    signal: ac.signal,
    reportProgress() {},
    now: performance.now.bind(performance),
  };

  const startedAt = performance.now();
  let result: SolverResult | undefined;
  let error: string | undefined;
  try {
    result = await adapter.solve(request, context);
  } catch (e) {
    error = String(e);
  }
  clearTimeout(timeout);
  const elapsedMs = Math.round(performance.now() - startedAt);

  if (error || !result) {
    return {
      ...meta,
      status: "error",
      detail: error ?? "No result returned",
      elapsedMs,
    };
  }

  const base: BenchmarkFixtureResult = {
    ...meta,
    status: result.status,
    elapsedMs,
    expandedStates: result.metrics.expandedStates,
    generatedStates: result.metrics.generatedStates,
    peakFrontierSize: result.metrics.peakFrontierSize,
    counters: result.metrics.counters
      ? { ...result.metrics.counters }
      : undefined,
  };

  base.processRssBytes = process.memoryUsage.rss();

  if (result.status === "solved") {
    base.optimality = result.solution.optimality;
    base.moves = result.solution.moves;
    base.pushes = result.solution.pushes;
    if (result.proof) {
      base.lowerBound = result.proof.lowerBound;
      base.gap = result.proof.gap;
    }
    const verification = verifySolverSolution(request, result.solution);
    base.verified = verification.valid;
  } else if (result.status === "unsolved") {
    base.reason = result.reason;
    base.detail = result.detail;
    if (result.proof) {
      base.lowerBound = result.proof.lowerBound;
      base.gap = result.proof.gap;
    }
  }

  return base;
}

// ---------------------------------------------------------------------------
// Sokomind solver runner
// ---------------------------------------------------------------------------

function runSokomindSolver(
  fixture: BenchmarkFixture,
): BenchmarkFixtureResult {
  const meta = buildMetadata(fixture, "sokomind-solver");
  const request = requestFromRows(
    fixture.fixtureId,
    fixture.rows,
    fixture.boxes,
  );
  const memoryBytes = SOKOMIND_LIMITS.maxMemoryBytes;
  const moderate =
    request.snapshot.boxes.length >= 5 || request.board.floor.length >= 45;
  const structural =
    request.snapshot.boxes.length >= 10 || request.board.floor.length >= 100;

  const startedAt = performance.now();

  let payload: Record<string, unknown>;
  if (structural) {
    payload = {
      algorithm: "plan-macro-beam",
      state: toLegacyState(request),
      maxDepth: 460,
      maxVisited: 6_000,
      transpositionLimit:
        memoryBytes <= 384 * 1024 * 1024
          ? 24_000
          : memoryBytes <= 768 * 1024 * 1024
            ? 36_000
            : 48_000,
      sequenceMacroExplored: 48,
      sequenceMacroResults: 4,
      targetedMacroExplored: 64,
      progressIntervalMs: 5_000,
    };
  } else {
    payload = {
      algorithm: "ultimate",
      state: toLegacyState(request),
      maxDepth: moderate ? 360 : 180,
      maxVisited: moderate ? 180_000 : 80_000,
      maxGenerated: moderate ? 1_200_000 : 300_000,
      transpositionLimit: !moderate
        ? 30_000
        : memoryBytes <= 384 * 1024 * 1024
          ? 24_000
          : memoryBytes <= 768 * 1024 * 1024
            ? 36_000
            : 48_000,
      beamWidth: sokomindDiscoveryBeamWidth(
        request.snapshot.boxes.length,
        request.board.floor.length,
        memoryBytes,
      ),
      seed: 0,
      sequenceMacros: moderate,
      checkpointLimit: 8,
      progressInterval: 5_000,
      progressIntervalMs: 5_000,
    };
  }

  const originalPostMessage = globalThis.postMessage;
  globalThis.postMessage = (() => {}) as typeof globalThis.postMessage;

  let initial: Record<string, unknown>;
  let lane = structural ? "structural" : "discovery";
  try {
    initial = search(payload) as Record<string, unknown>;
    if (!Array.isArray(initial.path) && structural) {
      payload = {
        algorithm: "ultimate",
        state: toLegacyState(request),
        maxDepth: moderate ? 360 : 180,
        maxVisited: moderate ? 180_000 : 80_000,
        maxGenerated: moderate ? 1_200_000 : 300_000,
        transpositionLimit: !moderate
          ? 30_000
          : memoryBytes <= 384 * 1024 * 1024
            ? 24_000
            : memoryBytes <= 768 * 1024 * 1024
              ? 36_000
              : 48_000,
        beamWidth: sokomindDiscoveryBeamWidth(
          request.snapshot.boxes.length,
          request.board.floor.length,
          memoryBytes,
        ),
        seed: 0,
        sequenceMacros: moderate,
        checkpointLimit: 8,
        progressInterval: 5_000,
        progressIntervalMs: 5_000,
      };
      initial = search(payload) as Record<string, unknown>;
      lane = "structural+discovery";
    }
  } finally {
    if (originalPostMessage === undefined) {
      Reflect.deleteProperty(globalThis, "postMessage");
    } else {
      globalThis.postMessage = originalPostMessage;
    }
  }

  const initialPath = Array.isArray(initial.path) ? initial.path : null;
  const solution = initialPath
    ? solutionFromLegacyPath(request, initialPath as readonly string[])
    : null;
  const verified =
    solution !== null && verifySolverSolution(request, solution).valid;
  const elapsedMs = Math.round(performance.now() - startedAt);
  const solved = solution !== null && verified;

  const numeric = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;

  const result: BenchmarkFixtureResult = {
    ...meta,
    status: solved ? "solved" : "unsolved",
    elapsedMs,
    expandedStates: numeric(initial.visited),
    generatedStates: numeric(initial.generated),
    peakFrontierSize: numeric(initial.peakFrontier),
    verified: solved ? true : undefined,
  };

  result.configuration = {
    ...result.configuration,
    lane,
    algorithm: payload.algorithm,
    limits: {
      maxElapsedMs: SOKOMIND_LIMITS.maxElapsedMs,
      maxMemoryBytes: SOKOMIND_LIMITS.maxMemoryBytes,
      maxExpandedStates: numeric(payload.maxVisited),
      maxGeneratedStates: numeric(payload.maxGenerated),
    },
  };

  if (solved && solution) {
    result.optimality = "unknown";
    result.moves = solution.moves;
    result.pushes = solution.pushes;
  } else {
    result.reason = "limit-reached";
  }

  return result;
}

// ---------------------------------------------------------------------------
// Child-process entry point
// ---------------------------------------------------------------------------

async function runChild(fixtureId: string, solver: string): Promise<void> {
  const fixture = BENCHMARK_FIXTURE_BY_ID[fixtureId];
  if (!fixture) {
    process.stdout.write(
      JSON.stringify({
        fixtureId,
        fixtureGroup: "primary-v2",
        boardHash: "unknown",
        width: 0, height: 0, floorCount: 0, boxCount: 0,
        solver,
        status: "error",
        detail: `Unknown fixture "${fixtureId}"`,
        elapsedMs: 0,
        configuration: { deterministic: false, limits: {} },
      }) + "\n",
    );
    process.exit(1);
  }

  let result: BenchmarkFixtureResult;
  if (solver === "sokomind-solver") {
    result = runSokomindSolver(fixture);
  } else if (
    solver === "classic-astar" ||
    solver === "classic-ida-star"
  ) {
    result = await runClassicSolver(solver, fixture);
  } else {
    const meta = buildMetadata(fixture, solver);
    process.stdout.write(
      JSON.stringify({
        ...meta,
        status: "error",
        detail: `Unknown solver "${solver}"`,
        elapsedMs: 0,
      }) + "\n",
    );
    process.exit(1);
  }

  process.stdout.write(JSON.stringify(result) + "\n");
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArguments();

  if (args.childMode) {
    if (!args.childFixtureId || !args.childSolver) {
      process.stderr.write("Child mode requires --child-fixture and --child-solver\n");
      process.exit(1);
    }
    await runChild(args.childFixtureId, args.childSolver);
    return;
  }

  const scriptPath = fileURLToPath(import.meta.url);

  // Resolve fixture IDs including aliases
  const selectedFixtures =
    args.fixtureIds.length > 0
      ? BENCHMARK_CORPUS.filter((f) => {
          if (args.fixtureIds.includes(f.fixtureId)) return true;
          if (f.aliases) {
            for (const alias of f.aliases) {
              if (args.fixtureIds.includes(alias)) return true;
            }
          }
          return false;
        })
      : BENCHMARK_CORPUS;

  if (selectedFixtures.length === 0) {
    process.stderr.write(
      `No fixtures matched: ${args.fixtureIds.join(", ")}\n`,
    );
    process.exit(1);
  }

  const allResults: BenchmarkFixtureResult[] = [];
  const solvers = ["sokomind-solver", "classic-astar", "classic-ida-star"];
  const totalRuns = args.warmupRuns + args.timedRuns;

  process.stderr.write(
    `Benchmark: ${args.warmupRuns} warm-up run(s), median of ${args.timedRuns} timed run(s)\n`,
  );

  function runChildProcess(
    fixtureId: string,
    solver: string,
  ): BenchmarkFixtureResult | null {
    const parentStarted = performance.now();
    const child = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        scriptPath,
        "--child",
        `--child-fixture=${fixtureId}`,
        `--child-solver=${solver}`,
      ],
      {
        encoding: "utf8",
        env: process.env,
        timeout: CHILD_TIMEOUT_MS,
        windowsHide: true,
      },
    );

    const parentElapsedMs = Math.round(performance.now() - parentStarted);

    if (child.stdout) {
      for (const line of child.stdout.split("\n").filter(Boolean)) {
        try {
          return JSON.parse(line) as BenchmarkFixtureResult;
        } catch {
          /* skip malformed lines */
        }
      }
    }

    const meta = buildMetadata(
      BENCHMARK_FIXTURE_BY_ID[fixtureId] ?? BENCHMARK_CORPUS[0],
      solver,
    );
    return {
      ...meta,
      fixtureId,
      status: "error",
      detail:
        child.error?.message ??
        (child.signal
          ? `terminated-${child.signal}`
          : `exit-${child.status ?? "unknown"}`),
      elapsedMs: parentElapsedMs,
    };
  }

  for (const fixture of selectedFixtures) {
    for (const solver of solvers) {
      if (
        (solver === "classic-astar" || solver === "classic-ida-star") &&
        !isClassicEligible(fixture)
      ) {
        continue;
      }

      for (let w = 0; w < args.warmupRuns; w++) {
        process.stderr.write(
          `  ${fixture.fixtureId} / ${solver}: warm-up ${w + 1}/${args.warmupRuns}\n`,
        );
        runChildProcess(fixture.fixtureId, solver);
      }

      const timedResults: BenchmarkFixtureResult[] = [];
      for (let r = 0; r < args.timedRuns; r++) {
        const result = runChildProcess(fixture.fixtureId, solver);
        if (result) {
          timedResults.push(result);
          process.stderr.write(
            `  ${result.fixtureId} / ${result.solver}: ${result.status}` +
              (result.moves !== undefined ? ` (${result.moves} moves)` : "") +
              ` [${result.elapsedMs}ms] run ${r + 1}/${args.timedRuns}\n`,
          );
        }
      }

      if (timedResults.length > 0) {
        allResults.push(selectMedian(timedResults));
      }
    }
  }

  const cpus = os.cpus();
  const output: BenchmarkResultFile = {
    schemaVersion: 2,
    captureDate: new Date().toISOString(),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuInfo: cpus.length > 0 ? cpus[0].model : undefined,
    totalMemoryBytes: os.totalmem(),
    hostname: hostname(),
    solverVersions: {
      "sokomind-solver": sokomindSolverMetadata.version,
      "classic-astar": classicAStarSolver.metadata.version,
      "classic-ida-star": classicIdaStarSolver.metadata.version,
    },
    fixtures: allResults,
  };

  process.stdout.write(JSON.stringify(output, null, 2) + "\n");

  if (args.savePath) {
    writeFileSync(args.savePath, JSON.stringify(output, null, 2) + "\n");
    process.stderr.write(`Saved to ${args.savePath}\n`);
  }

  const solved = allResults.filter((r) => r.status === "solved").length;
  const total = allResults.length;
  process.stderr.write(
    `\nSummary: ${solved}/${total} solved across ${selectedFixtures.length} fixtures\n`,
  );
}

main().catch((e) => {
  process.stderr.write(String(e) + "\n");
  process.exit(1);
});
