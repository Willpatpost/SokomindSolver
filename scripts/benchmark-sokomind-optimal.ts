/**
 * Optimal-mode (proof-producing) benchmark runner.
 *
 * Runs each puzzle through a classic A* or IDA* solver in optimal mode,
 * records proof-specific metrics, and outputs JSONL per-puzzle results.
 *
 * Each fixture is run in an isolated child process so heap/RSS measurements
 * are not contaminated by prior puzzles.
 *
 * Usage:
 *   npx --experimental-strip-types scripts/benchmark-sokomind-optimal.ts
 *   npx --experimental-strip-types scripts/benchmark-sokomind-optimal.ts --fixture=beginner-three
 *   npx --experimental-strip-types scripts/benchmark-sokomind-optimal.ts --algorithm=ida-star
 *   npx --experimental-strip-types scripts/benchmark-sokomind-optimal.ts --output=results.jsonl
 *   npx --experimental-strip-types scripts/benchmark-sokomind-optimal.ts --baseline=previous.jsonl
 *   npx --experimental-strip-types scripts/benchmark-sokomind-optimal.ts --deterministic
 */

import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { hostname, cpus, totalmem } from "node:os";
import { fileURLToPath } from "node:url";

import {
  BENCHMARK_CORPUS,
  BENCHMARK_FIXTURE_BY_ID,
  computeBoardHash,
  isClassicEligible,
  type BenchmarkFixture,
} from "../tests/fixtures/solver-v2/benchmark-corpus.ts";
import { createSession, type PuzzleDefinition } from "../src/core/index.ts";
import type {
  SolverExecutionContext,
  SolverRequest,
  SolverResult,
  SolverProof,
} from "../src/solver/contracts.ts";
import {
  classicAStarSolver,
  classicIdaStarSolver,
} from "../src/solver/implementations/classic-solvers.ts";
import { verifySolverSolution } from "../src/solver/verification.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OptimalBenchmarkRecord {
  // Puzzle identity
  fixtureId: string;
  boardHash: string;
  title: string;
  boxCount: number;
  width: number;
  height: number;
  floorCount: number;

  // Solution
  status: "solved" | "unsolved" | "cancelled" | "error" | "timeout";
  moves?: number;
  pushes?: number;
  actionLog?: string;

  // Proof data
  proofKind?: string;
  proofAlgorithm?: string;
  lowerBound?: number;
  upperBound?: number;
  gap?: number;
  optimality?: "unknown" | "proven";

  // Search metrics
  expandedStates?: number;
  generatedStates?: number;
  peakFrontierSize?: number;
  assignmentCalls?: number;
  assignmentCacheHits?: number;
  counters?: Record<string, number>;

  // Memory
  processRssBytes?: number;

  // Runtime
  elapsedMs: number;

  // Configuration
  solver: string;
  algorithm: string;
  deterministic: boolean;
  commitSha: string;
  solverVersion: string;

  // Verification
  verified?: boolean;

  // Error detail
  reason?: string;
  detail?: string;
}

interface BaselineRecord {
  fixtureId: string;
  status: string;
  moves?: number;
  optimality?: string;
  proofKind?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 120_000;
const CHILD_TIMEOUT_MS = 180_000; // generous margin over per-puzzle timeout

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArguments(): {
  fixtureIds: string[];
  algorithm: "astar" | "ida-star";
  solver: string;
  outputPath: string | undefined;
  baselinePath: string | undefined;
  deterministic: boolean;
  timeoutMs: number;
  childMode: boolean;
  childFixtureId: string | undefined;
} {
  const fixtureIds = process.argv
    .filter((a) => a.startsWith("--fixture="))
    .map((a) => a.slice("--fixture=".length))
    .filter(Boolean);

  const algorithmArg = process.argv.find((a) => a.startsWith("--algorithm="));
  const algorithmRaw = algorithmArg
    ? algorithmArg.slice("--algorithm=".length)
    : "astar";
  const algorithm: "astar" | "ida-star" =
    algorithmRaw === "ida-star" ? "ida-star" : "astar";

  const solverArg = process.argv.find((a) => a.startsWith("--solver="));
  const solver = solverArg
    ? solverArg.slice("--solver=".length)
    : algorithm === "ida-star"
      ? "classic-ida-star"
      : "classic-astar";

  const outputArg = process.argv.find((a) => a.startsWith("--output="));
  const outputPath = outputArg ? outputArg.slice("--output=".length) : undefined;

  const baselineArg = process.argv.find((a) => a.startsWith("--baseline="));
  const baselinePath = baselineArg
    ? baselineArg.slice("--baseline=".length)
    : undefined;

  const deterministic = process.argv.includes("--deterministic");

  const timeoutArg = process.argv.find((a) => a.startsWith("--timeout="));
  const timeoutMs = timeoutArg
    ? Math.max(1_000, parseInt(timeoutArg.slice("--timeout=".length), 10) || DEFAULT_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;

  const childMode = process.argv.includes("--child");
  const childFixtureArg = process.argv.find((a) =>
    a.startsWith("--child-fixture="),
  );
  const childFixtureId = childFixtureArg
    ? childFixtureArg.slice("--child-fixture=".length)
    : undefined;

  return {
    fixtureIds,
    algorithm,
    solver,
    outputPath,
    baselinePath,
    deterministic,
    timeoutMs,
    childMode,
    childFixtureId,
  };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function getCommitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", {
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
  } catch {
    return "unknown";
  }
}

function getSolverVersion(solver: string): string {
  if (solver === "classic-astar") return classicAStarSolver.metadata.version;
  if (solver === "classic-ida-star") return classicIdaStarSolver.metadata.version;
  return "unknown";
}

function selectAdapter(solver: string) {
  if (solver === "classic-ida-star") return classicIdaStarSolver;
  return classicAStarSolver;
}

// ---------------------------------------------------------------------------
// Request construction from frozen rows
// ---------------------------------------------------------------------------

function requestFromFixture(fixture: BenchmarkFixture): SolverRequest {
  const puzzle: PuzzleDefinition = {
    id: fixture.fixtureId,
    title: fixture.fixtureId,
    difficulty: "beginner",
    boxes: fixture.boxes,
    rows: fixture.rows as string[],
  };
  const session = createSession(puzzle);
  return Object.freeze({
    board: session.board,
    snapshot: session.snapshot,
    objective: Object.freeze({ kind: "moves" as const }),
  });
}

// ---------------------------------------------------------------------------
// Proof extraction
// ---------------------------------------------------------------------------

function extractProofFields(
  proof: SolverProof | undefined,
): Pick<
  OptimalBenchmarkRecord,
  "proofKind" | "proofAlgorithm" | "lowerBound" | "upperBound" | "gap"
> {
  if (!proof) return {};
  return {
    proofKind: proof.kind,
    proofAlgorithm: proof.algorithm,
    lowerBound: proof.lowerBound,
    upperBound: proof.upperBound,
    gap: proof.gap,
  };
}

// ---------------------------------------------------------------------------
// Child-process solver runner
// ---------------------------------------------------------------------------

async function runOptimalSolver(
  fixture: BenchmarkFixture,
  args: ReturnType<typeof parseArguments>,
): Promise<OptimalBenchmarkRecord> {
  const request = requestFromFixture(fixture);
  const adapter = selectAdapter(args.solver);
  const commitSha = getCommitSha();

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), args.timeoutMs);

  const context: SolverExecutionContext = {
    signal: ac.signal,
    reportProgress() {},
    now: performance.now.bind(performance),
  };

  const base: Partial<OptimalBenchmarkRecord> = {
    fixtureId: fixture.fixtureId,
    boardHash: computeBoardHash(fixture.rows),
    title: fixture.fixtureId,
    boxCount: fixture.boxes,
    width: fixture.width,
    height: fixture.height,
    floorCount: fixture.floorCount,
    solver: args.solver,
    algorithm: args.algorithm,
    deterministic: args.deterministic,
    commitSha,
    solverVersion: getSolverVersion(args.solver),
  };

  const startedAt = performance.now();
  let result: SolverResult | undefined;
  let error: string | undefined;
  try {
    result = await adapter.solve(request, context);
  } catch (e) {
    if (ac.signal.aborted) {
      clearTimeout(timeout);
      return {
        ...base,
        status: "timeout",
        elapsedMs: Math.round(performance.now() - startedAt),
        processRssBytes: process.memoryUsage.rss(),
        detail: `Timed out after ${args.timeoutMs}ms`,
      } as OptimalBenchmarkRecord;
    }
    error = String(e);
  }
  clearTimeout(timeout);
  const elapsedMs = Math.round(performance.now() - startedAt);

  if (error || !result) {
    return {
      ...base,
      status: "error",
      elapsedMs,
      processRssBytes: process.memoryUsage.rss(),
      detail: error ?? "No result returned",
    } as OptimalBenchmarkRecord;
  }

  const record: OptimalBenchmarkRecord = {
    ...base,
    status: result.status,
    elapsedMs,
    expandedStates: result.metrics.expandedStates,
    generatedStates: result.metrics.generatedStates,
    peakFrontierSize: result.metrics.peakFrontierSize,
    counters: result.metrics.counters
      ? { ...result.metrics.counters }
      : undefined,
    processRssBytes: process.memoryUsage.rss(),
  } as OptimalBenchmarkRecord;

  // Extract assignment-specific counters if present
  if (result.metrics.counters) {
    record.assignmentCalls = result.metrics.counters["assignmentCalls"];
    record.assignmentCacheHits =
      result.metrics.counters["assignmentCacheHits"];
  }

  if (result.status === "solved") {
    record.optimality = result.solution.optimality;
    record.moves = result.solution.moves;
    record.pushes = result.solution.pushes;
    record.actionLog = result.solution.steps
      .map((s) => `${s.kind[0]}${s.direction[0]}`)
      .join("");
    Object.assign(record, extractProofFields(result.proof));
    const verification = verifySolverSolution(request, result.solution);
    record.verified = verification.valid;
  } else if (result.status === "unsolved") {
    record.reason = result.reason;
    record.detail = result.detail;
    Object.assign(record, extractProofFields(result.proof));
  } else if (result.status === "cancelled") {
    Object.assign(record, extractProofFields(result.proof));
  }

  return record;
}

// ---------------------------------------------------------------------------
// Child-process entry point
// ---------------------------------------------------------------------------

async function runChild(fixtureId: string): Promise<void> {
  const fixture = BENCHMARK_FIXTURE_BY_ID[fixtureId];
  if (!fixture) {
    const errorRecord: OptimalBenchmarkRecord = {
      fixtureId,
      boardHash: "unknown",
      title: fixtureId,
      boxCount: 0,
      width: 0,
      height: 0,
      floorCount: 0,
      status: "error",
      detail: `Unknown fixture "${fixtureId}"`,
      elapsedMs: 0,
      solver: args.solver,
      algorithm: args.algorithm,
      deterministic: args.deterministic,
      commitSha: getCommitSha(),
      solverVersion: getSolverVersion(args.solver),
    };
    process.stdout.write(JSON.stringify(errorRecord) + "\n");
    process.exit(1);
  }

  const result = await runOptimalSolver(fixture, args);
  process.stdout.write(JSON.stringify(result) + "\n");
}

// ---------------------------------------------------------------------------
// Baseline comparison
// ---------------------------------------------------------------------------

function loadBaseline(path: string): Map<string, BaselineRecord> {
  const map = new Map<string, BaselineRecord>();
  try {
    const content = readFileSync(path, "utf8");
    for (const line of content.split("\n").filter(Boolean)) {
      try {
        const record = JSON.parse(line) as BaselineRecord;
        if (record.fixtureId) {
          map.set(record.fixtureId, record);
        }
      } catch {
        /* skip malformed lines */
      }
    }
  } catch (e) {
    process.stderr.write(`Warning: could not load baseline: ${e}\n`);
  }
  return map;
}

function reportRegressions(
  results: OptimalBenchmarkRecord[],
  baseline: Map<string, BaselineRecord>,
): string[] {
  const regressions: string[] = [];
  for (const result of results) {
    const base = baseline.get(result.fixtureId);
    if (!base) continue;

    // Regression: was solved, now unsolved
    if (base.status === "solved" && result.status !== "solved") {
      regressions.push(
        `REGRESSION ${result.fixtureId}: was solved, now ${result.status}`,
      );
    }

    // Regression: move count increased
    if (
      base.status === "solved" &&
      result.status === "solved" &&
      base.moves !== undefined &&
      result.moves !== undefined &&
      result.moves > base.moves
    ) {
      regressions.push(
        `REGRESSION ${result.fixtureId}: moves ${base.moves} -> ${result.moves} (+${result.moves - base.moves})`,
      );
    }

    // Regression: proof status downgraded
    if (
      base.optimality === "proven" &&
      result.optimality !== "proven" &&
      result.status === "solved"
    ) {
      regressions.push(
        `REGRESSION ${result.fixtureId}: proof was "proven", now "${result.optimality ?? "missing"}"`,
      );
    }
  }
  return regressions;
}

// ---------------------------------------------------------------------------
// Summary table
// ---------------------------------------------------------------------------

function printSummaryTable(results: OptimalBenchmarkRecord[]): void {
  const COL = {
    id: 30,
    status: 9,
    moves: 7,
    pushes: 7,
    optimal: 9,
    proof: 10,
    lb: 6,
    ub: 6,
    gap: 5,
    expanded: 12,
    time: 10,
    rss: 10,
  };

  const pad = (s: string, w: number) => s.slice(0, w).padEnd(w);
  const rpad = (s: string, w: number) => s.slice(0, w).padStart(w);

  const header =
    pad("FIXTURE", COL.id) +
    pad("STATUS", COL.status) +
    rpad("MOVES", COL.moves) +
    rpad("PUSHES", COL.pushes) +
    pad("OPTIMAL", COL.optimal) +
    pad("PROOF", COL.proof) +
    rpad("LB", COL.lb) +
    rpad("UB", COL.ub) +
    rpad("GAP", COL.gap) +
    rpad("EXPANDED", COL.expanded) +
    rpad("TIME(ms)", COL.time) +
    rpad("RSS(MiB)", COL.rss);

  process.stderr.write("\n" + header + "\n");
  process.stderr.write("-".repeat(header.length) + "\n");

  for (const r of results) {
    const rssMiB =
      r.processRssBytes !== undefined
        ? (r.processRssBytes / (1024 * 1024)).toFixed(1)
        : "-";
    const row =
      pad(r.fixtureId, COL.id) +
      pad(r.status, COL.status) +
      rpad(r.moves !== undefined ? String(r.moves) : "-", COL.moves) +
      rpad(r.pushes !== undefined ? String(r.pushes) : "-", COL.pushes) +
      pad(r.optimality ?? "-", COL.optimal) +
      pad(r.proofKind ?? "-", COL.proof) +
      rpad(r.lowerBound !== undefined ? String(r.lowerBound) : "-", COL.lb) +
      rpad(r.upperBound !== undefined ? String(r.upperBound) : "-", COL.ub) +
      rpad(r.gap !== undefined ? String(r.gap) : "-", COL.gap) +
      rpad(
        r.expandedStates !== undefined ? String(r.expandedStates) : "-",
        COL.expanded,
      ) +
      rpad(String(r.elapsedMs), COL.time) +
      rpad(rssMiB, COL.rss);
    process.stderr.write(row + "\n");
  }

  const solved = results.filter((r) => r.status === "solved").length;
  const proven = results.filter((r) => r.optimality === "proven").length;
  const timedOut = results.filter((r) => r.status === "timeout").length;
  const totalTime = results.reduce((s, r) => s + r.elapsedMs, 0);

  process.stderr.write("-".repeat(header.length) + "\n");
  process.stderr.write(
    `Summary: ${solved}/${results.length} solved, ${proven} proven optimal, ${timedOut} timed out, total ${(totalTime / 1000).toFixed(1)}s\n`,
  );
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

const args = parseArguments();

async function main(): Promise<void> {
  // Child mode: solve a single fixture and output JSON
  if (args.childMode) {
    if (!args.childFixtureId) {
      process.stderr.write("Child mode requires --child-fixture\n");
      process.exit(1);
    }
    await runChild(args.childFixtureId);
    return;
  }

  const scriptPath = fileURLToPath(import.meta.url);
  const commitSha = getCommitSha();

  // Select fixtures: only classic-eligible puzzles (optimal solvers cannot
  // handle very large state spaces within reasonable time)
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
      : BENCHMARK_CORPUS.filter(isClassicEligible);

  if (selectedFixtures.length === 0) {
    process.stderr.write(
      `No fixtures matched: ${args.fixtureIds.join(", ")}\n`,
    );
    process.exit(1);
  }

  // Emit header to stderr
  const cpuInfo = cpus();
  process.stderr.write(
    `Optimal-mode benchmark\n` +
      `  Solver:       ${args.solver}\n` +
      `  Algorithm:    ${args.algorithm}\n` +
      `  Deterministic:${args.deterministic ? " yes" : " no"}\n` +
      `  Timeout:      ${args.timeoutMs}ms per puzzle\n` +
      `  Fixtures:     ${selectedFixtures.length}\n` +
      `  Node:         ${process.version}\n` +
      `  Platform:     ${process.platform} ${process.arch}\n` +
      `  CPU:          ${cpuInfo.length > 0 ? cpuInfo[0].model : "unknown"}\n` +
      `  Memory:       ${(totalmem() / (1024 ** 3)).toFixed(1)} GiB\n` +
      `  Hostname:     ${hostname()}\n` +
      `  Commit:       ${commitSha}\n\n`,
  );

  // Forward arguments to child process
  const forwardedArgs = [
    `--algorithm=${args.algorithm}`,
    `--solver=${args.solver}`,
    `--timeout=${args.timeoutMs}`,
  ];
  if (args.deterministic) forwardedArgs.push("--deterministic");

  const allResults: OptimalBenchmarkRecord[] = [];
  const outputLines: string[] = [];

  for (const fixture of selectedFixtures) {
    process.stderr.write(
      `  Running ${fixture.fixtureId} (${fixture.boxes} boxes, ${fixture.floorCount} floor)...`,
    );

    const parentStarted = performance.now();
    const child = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        scriptPath,
        "--child",
        `--child-fixture=${fixture.fixtureId}`,
        ...forwardedArgs,
      ],
      {
        encoding: "utf8",
        env: process.env,
        timeout: CHILD_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    const parentElapsedMs = Math.round(performance.now() - parentStarted);

    let record: OptimalBenchmarkRecord | null = null;

    if (child.stdout) {
      for (const line of child.stdout.split("\n").filter(Boolean)) {
        try {
          record = JSON.parse(line) as OptimalBenchmarkRecord;
        } catch {
          /* skip malformed lines */
        }
      }
    }

    if (!record) {
      // Child crashed or timed out at the process level
      record = {
        fixtureId: fixture.fixtureId,
        boardHash: computeBoardHash(fixture.rows),
        title: fixture.fixtureId,
        boxCount: fixture.boxes,
        width: fixture.width,
        height: fixture.height,
        floorCount: fixture.floorCount,
        status: child.signal === "SIGTERM" ? "timeout" : "error",
        elapsedMs: parentElapsedMs,
        solver: args.solver,
        algorithm: args.algorithm,
        deterministic: args.deterministic,
        commitSha,
        solverVersion: getSolverVersion(args.solver),
        detail:
          child.error?.message ??
          (child.signal
            ? `terminated-${child.signal}`
            : `exit-${child.status ?? "unknown"}`),
      };
    }

    allResults.push(record);

    const jsonLine = JSON.stringify(record);
    outputLines.push(jsonLine);

    // Write JSONL to stdout immediately
    process.stdout.write(jsonLine + "\n");

    // Status line to stderr
    const statusSuffix =
      record.status === "solved"
        ? ` solved (${record.moves} moves${record.optimality === "proven" ? ", proven" : ""}) [${record.elapsedMs}ms]`
        : record.status === "timeout"
          ? ` timeout [${record.elapsedMs}ms]`
          : ` ${record.status} [${record.elapsedMs}ms]`;
    process.stderr.write(statusSuffix + "\n");
  }

  // Write output file if requested
  if (args.outputPath) {
    writeFileSync(args.outputPath, outputLines.join("\n") + "\n");
    process.stderr.write(`\nResults saved to ${args.outputPath}\n`);
  }

  // Summary table
  printSummaryTable(allResults);

  // Baseline comparison
  if (args.baselinePath) {
    const baseline = loadBaseline(args.baselinePath);
    const regressions = reportRegressions(allResults, baseline);
    if (regressions.length > 0) {
      process.stderr.write("\n--- REGRESSIONS ---\n");
      for (const r of regressions) {
        process.stderr.write(`  ${r}\n`);
      }
      process.stderr.write(`\n${regressions.length} regression(s) detected.\n`);
      process.exit(1);
    } else {
      process.stderr.write(
        `\nBaseline comparison: no regressions (${baseline.size} baseline entries checked).\n`,
      );
    }
  }
}

main().catch((e) => {
  process.stderr.write(String(e) + "\n");
  process.exit(1);
});
