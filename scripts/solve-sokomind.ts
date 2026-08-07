/**
 * Node CLI runner for the Sokomind solver.
 *
 * Usage:
 *   node --experimental-strip-types scripts/solve-sokomind.ts --puzzle=beginner-three
 *   node --experimental-strip-types scripts/solve-sokomind.ts --input=job.json
 *   echo '{"puzzleId":"huge","rows":[...]}' | node --experimental-strip-types scripts/solve-sokomind.ts
 *
 * Output is a single JSON Lines record to stdout (§19.3).
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

import { parsePuzzleRows, type ParsedBoard } from "../src/core/index.ts";
import { PUZZLE_BY_ID } from "../src/catalog/puzzles.ts";
import type {
  SolverExecutionContext,
  SolverProgress,
  SolverRequest,
  SolverResult,
} from "../src/solver/contracts.ts";
import { verifySolverSolution } from "../src/solver/verification.ts";
import {
  sokomindSolverMetadata,
} from "../src/solver/implementations/sokomind-solver.ts";
import {
  parseSokomindOptions,
} from "../src/solver/implementations/sokomind-options.ts";
import {
  resolveSokomindTuning,
  sokomindTuningFingerprint,
} from "../src/solver/implementations/sokomind-tuning.ts";
import { createNodeSolverAdapter } from "../src/solver/node-runner.ts";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  puzzleId?: string;
  inputFile?: string;
  mode: "fast" | "quality" | "optimal";
  proofAlgorithm: "auto" | "astar" | "ida-star";
  parallelism: number;
  deterministic: boolean;
  timeoutMs?: number;
  memoryMib?: number;
  checkpointFile?: string;
  checkpointDir?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const result: CliArgs = {
    mode: "fast",
    proofAlgorithm: "auto",
    parallelism: 1,
    deterministic: false,
  };

  for (const arg of argv) {
    if (arg.startsWith("--puzzle=")) {
      result.puzzleId = arg.slice("--puzzle=".length);
    } else if (arg.startsWith("--input=")) {
      result.inputFile = arg.slice("--input=".length);
    } else if (arg.startsWith("--mode=")) {
      const mode = arg.slice("--mode=".length);
      if (mode !== "fast" && mode !== "quality" && mode !== "optimal") {
        process.stderr.write(`Invalid mode: ${mode}\n`);
        process.exit(1);
      }
      result.mode = mode;
    } else if (arg.startsWith("--proof-algorithm=")) {
      const algo = arg.slice("--proof-algorithm=".length);
      if (algo !== "auto" && algo !== "astar" && algo !== "ida-star") {
        process.stderr.write(`Invalid proof algorithm: ${algo}\n`);
        process.exit(1);
      }
      result.proofAlgorithm = algo;
    } else if (arg.startsWith("--parallelism=")) {
      const v = parseInt(arg.slice("--parallelism=".length), 10);
      if (!Number.isFinite(v) || v < 1) {
        process.stderr.write(`Invalid parallelism: ${arg}\n`);
        process.exit(1);
      }
      result.parallelism = v;
    } else if (arg === "--deterministic") {
      result.deterministic = true;
    } else if (arg.startsWith("--timeout-ms=")) {
      const v = parseInt(arg.slice("--timeout-ms=".length), 10);
      if (!Number.isFinite(v) || v < 1) {
        process.stderr.write(`Invalid timeout-ms: ${arg}\n`);
        process.exit(1);
      }
      result.timeoutMs = v;
    } else if (arg.startsWith("--memory-mib=")) {
      const v = parseInt(arg.slice("--memory-mib=".length), 10);
      if (!Number.isFinite(v) || v < 1) {
        process.stderr.write(`Invalid memory-mib: ${arg}\n`);
        process.exit(1);
      }
      result.memoryMib = v;
    } else if (arg.startsWith("--checkpoint=")) {
      result.checkpointFile = arg.slice("--checkpoint=".length);
    } else if (arg.startsWith("--checkpoint-dir=")) {
      result.checkpointDir = arg.slice("--checkpoint-dir=".length);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Input resolution
// ---------------------------------------------------------------------------

interface JobInput {
  puzzleId: string;
  rows: readonly string[];
  mode: "fast" | "quality" | "optimal";
  proofAlgorithm: "auto" | "astar" | "ida-star";
  parallelism: number;
  deterministic: boolean;
  timeoutMs?: number;
  memoryMib?: number;
  solverVersion?: string;
  gitCommit?: string;
  tuningFingerprint?: string;
}

function resolveInput(args: CliArgs): JobInput {
  let rows: readonly string[] | undefined;
  let puzzleId: string | undefined = args.puzzleId;
  let inputSolverVersion: string | undefined;
  let inputGitCommit: string | undefined;
  let inputTuningFingerprint: string | undefined;

  if (args.inputFile) {
    const raw = JSON.parse(readFileSync(args.inputFile, "utf-8")) as Record<string, unknown>;
    if (Array.isArray(raw.rows)) {
      rows = raw.rows as string[];
    }
    if (typeof raw.puzzleId === "string") {
      puzzleId = raw.puzzleId;
    }
    if (typeof raw.mode === "string") {
      const m = raw.mode as string;
      if (m === "fast" || m === "quality" || m === "optimal") {
        if (args.mode === "fast") args.mode = m;
      }
    }
    if (typeof raw.proofAlgorithm === "string") {
      const a = raw.proofAlgorithm as string;
      if (a === "auto" || a === "astar" || a === "ida-star") {
        if (args.proofAlgorithm === "auto") args.proofAlgorithm = a;
      }
    }
    if (typeof raw.parallelism === "number" && args.parallelism === 1) {
      args.parallelism = raw.parallelism as number;
    }
    if (raw.deterministic === true && !args.deterministic) {
      args.deterministic = true;
    }
    if (typeof raw.limits === "object" && raw.limits !== null) {
      const limits = raw.limits as Record<string, unknown>;
      if (typeof limits.maxElapsedMs === "number" && args.timeoutMs === undefined) {
        args.timeoutMs = limits.maxElapsedMs as number;
      }
      if (typeof limits.maxMemoryBytes === "number" && args.memoryMib === undefined) {
        args.memoryMib = Math.round((limits.maxMemoryBytes as number) / (1024 * 1024));
      }
    }
    if (typeof raw.solverVersion === "string") {
      inputSolverVersion = raw.solverVersion as string;
    }
    if (typeof raw.gitCommit === "string") {
      inputGitCommit = raw.gitCommit as string;
    }
    if (typeof raw.tuningFingerprint === "string") {
      inputTuningFingerprint = raw.tuningFingerprint as string;
    }
  }

  if (!rows && !puzzleId) {
    try {
      const stdin = readFileSync(0, "utf-8").trim();
      if (stdin) {
        const raw = JSON.parse(stdin) as Record<string, unknown>;
        if (Array.isArray(raw.rows)) rows = raw.rows as string[];
        if (typeof raw.puzzleId === "string") puzzleId = raw.puzzleId;
      }
    } catch {
      // No stdin available
    }
  }

  if (puzzleId && !rows) {
    const puzzle = PUZZLE_BY_ID[puzzleId];
    if (!puzzle) {
      process.stderr.write(`Unknown puzzle ID: ${puzzleId}\n`);
      process.exit(1);
    }
    rows = puzzle.rows;
  }

  if (!rows || rows.length === 0) {
    process.stderr.write(
      "No puzzle specified. Use --puzzle=<id> or --input=<file> or pipe JSON to stdin.\n",
    );
    process.exit(1);
  }

  return {
    puzzleId: puzzleId ?? "unknown",
    rows,
    mode: args.mode,
    proofAlgorithm: args.proofAlgorithm,
    parallelism: args.parallelism,
    deterministic: args.deterministic,
    timeoutMs: args.timeoutMs,
    memoryMib: args.memoryMib,
    solverVersion: inputSolverVersion,
    gitCommit: inputGitCommit,
    tuningFingerprint: inputTuningFingerprint,
  };
}

// ---------------------------------------------------------------------------
// Git commit detection
// ---------------------------------------------------------------------------

function detectGitCommit(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Output record (§19.3)
// ---------------------------------------------------------------------------

interface OutputRecord {
  schemaVersion: 3;
  puzzleId: string;
  rows: readonly string[];
  solution: {
    steps: readonly { direction: string; kind: string }[];
    moves: number;
    pushes: number;
  } | null;
  verified: boolean;
  verificationDetail: string | null;
  lowerBound: number | null;
  upperBound: number | null;
  gap: number | null;
  proofStatus: string | null;
  proofAlgorithm: string | null;
  expandedStates: number | null;
  generatedStates: number | null;
  peakFrontierSize: number | null;
  counters: Readonly<Record<string, number>> | null;
  memory: number | null;
  elapsedMs: number;
  mode: string;
  parallelism: number;
  deterministic: boolean;
  solverVersion: string;
  gitCommit: string;
  tuningFingerprint: string;
}

function buildOutputRecord(
  job: JobInput,
  result: SolverResult,
  request: SolverRequest,
  gitCommit: string,
  tuningFp: string,
): OutputRecord {
  let solution: OutputRecord["solution"] = null;
  let verified = false;
  let verificationDetail: string | null = null;

  if (result.status === "solved") {
    solution = {
      steps: result.solution.steps,
      moves: result.solution.moves,
      pushes: result.solution.pushes,
    };
    const verification = verifySolverSolution(request, result.solution);
    verified = verification.valid;
    if (!verification.valid) {
      verificationDetail = verification.message;
    }
  }

  return {
    schemaVersion: 3,
    puzzleId: job.puzzleId,
    rows: job.rows,
    solution,
    verified,
    verificationDetail,
    lowerBound: result.proof?.lowerBound ?? null,
    upperBound: result.proof?.upperBound ?? null,
    gap: result.proof?.gap ?? null,
    proofStatus: result.proof?.kind ?? null,
    proofAlgorithm: result.proof?.algorithm ?? null,
    expandedStates: result.metrics.expandedStates ?? null,
    generatedStates: result.metrics.generatedStates ?? null,
    peakFrontierSize: result.metrics.peakFrontierSize ?? null,
    counters: result.metrics.counters ?? null,
    memory: (result.metrics.counters as Record<string, number> | undefined)
      ?.peakEstimatedMemoryBytes ?? null,
    elapsedMs: Math.round(result.metrics.elapsedMs * 100) / 100,
    mode: job.mode,
    parallelism: job.parallelism,
    deterministic: job.deterministic,
    solverVersion: sokomindSolverMetadata.version,
    gitCommit,
    tuningFingerprint: tuningFp,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const job = resolveInput(args);
  const gitCommit = detectGitCommit();

  const tuningProfile = resolveSokomindTuning();
  const tuningFp = sokomindTuningFingerprint(tuningProfile);

  const board: ParsedBoard = parsePuzzleRows(job.rows);
  const request: SolverRequest = {
    board,
    snapshot: {
      puzzleId: job.puzzleId,
      robot: board.initialRobot,
      boxes: board.initialBoxes,
      moves: 0,
      pushes: 0,
      solved: false,
    },
    objective: { kind: "moves" },
    ...(job.timeoutMs !== undefined || job.memoryMib !== undefined
      ? {
          limits: {
            ...(job.timeoutMs !== undefined
              ? { maxElapsedMs: Math.floor(job.timeoutMs) }
              : {}),
            ...(job.memoryMib !== undefined
              ? { maxMemoryBytes: Math.floor(job.memoryMib * 1024 * 1024) }
              : {}),
          },
        }
      : {}),
    options: {
      "sokomind-solver": parseSokomindOptions({
        mode: job.mode,
        proofAlgorithm: job.proofAlgorithm,
        deterministic: job.deterministic,
        proofParallelism: job.parallelism,
      }),
    },
  };

  const adapter = createNodeSolverAdapter();

  const ac = new AbortController();
  const handleSignal = () => ac.abort();
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  const context: SolverExecutionContext = {
    signal: ac.signal,
    reportProgress(progress: SolverProgress): void {
      if (progress.incumbent) {
        process.stderr.write(
          `[progress] ${progress.phase} ` +
          `moves=${progress.incumbent.moves} ` +
          `expanded=${progress.expandedStates ?? "?"}\n`,
        );
      }
    },
    now: performance.now.bind(performance),
  };

  process.stderr.write(
    `Solving ${job.puzzleId} mode=${job.mode} ` +
    `proof=${job.proofAlgorithm} parallelism=${job.parallelism}\n`,
  );

  let result: SolverResult;
  try {
    result = await adapter.solve(request, context);
  } catch (error: unknown) {
    process.stderr.write(
      `Error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }

  const record = buildOutputRecord(job, result, request, gitCommit, tuningFp);
  process.stdout.write(JSON.stringify(record) + "\n");

  if (result.status === "solved") {
    process.stderr.write(
      `Solved: ${result.solution.moves} moves, ${result.solution.pushes} pushes ` +
      `(${record.verified ? "verified" : "VERIFICATION FAILED"})` +
      (result.solution.optimality === "proven" ? " [OPTIMAL]" : "") +
      "\n",
    );
  } else if (result.status === "unsolved") {
    process.stderr.write(`Unsolved: ${result.reason}\n`);
  } else {
    process.stderr.write("Cancelled\n");
    process.exit(2);
  }

  process.exit(0);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Fatal: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
