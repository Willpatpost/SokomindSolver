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

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";

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
import {
  deserializeCheckpoint,
  validateCheckpointCompatibility,
  serializeCheckpoint,
  type IdaStarCheckpoint,
} from "../src/solver/search/ida-star-checkpoint.ts";

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
  perLaneCounters: Readonly<Record<string, Readonly<Record<string, number>>>> | null;
  memory: number | null;
  elapsedMs: number;
  configuration: {
    mode: string;
    parallelism: number;
    deterministic: boolean;
    proofAlgorithm: string;
    solverVersion: string;
    gitCommit: string;
    tuningFingerprint: string;
  };
}

/**
 * Extract per-lane counters from the flat counters record.
 *
 * The discovery search aggregates per-lane memory/state counters with keys
 * like `memoryCurrent<Stem>Bytes`, `memoryPeak<Stem>Bytes`, etc. Group them
 * by stem so the output record provides a structured per-lane view.
 */
function extractPerLaneCounters(
  counters: Readonly<Record<string, number>> | undefined,
): Readonly<Record<string, Readonly<Record<string, number>>>> | null {
  if (!counters) return null;

  // Lane counter keys follow the pattern: memory{Metric}{Stem}{Suffix}
  // e.g. memoryCurrentDirectPortfolioBytes, memoryPeakBidirectionalForwardBytes
  // Also: memory{Stem}RetainedStates, memory{Stem}FrontierStates, memory{Stem}CacheBytes
  const lanePattern =
    /^memory(Current|Peak)(.+?)(Bytes|ProcessBytes)$|^memory(.+?)(RetainedStates|FrontierStates|CacheBytes)$/;
  const lanes: Record<string, Record<string, number>> = {};

  for (const [key, value] of Object.entries(counters)) {
    const match = lanePattern.exec(key);
    if (!match) continue;

    // Match group layout:
    //   [1]=Current|Peak, [2]=Stem, [3]=Bytes|ProcessBytes  (first alt)
    //   [4]=Stem, [5]=RetainedStates|...                    (second alt)
    const stem = (match[2] ?? match[4] ?? "").replace(/^[A-Z]/, (c) => c.toLowerCase());
    if (!stem) continue;

    // Skip aggregate counters that are not per-lane
    if (
      stem === "estimatedMemory" ||
      stem === "currentEstimatedMemory" ||
      stem === "peakEstimatedMemory" ||
      stem === "currentWorker" ||
      stem === "currentCoordinator" ||
      stem === "currentPreparedBoard" ||
      stem === "workerRuntime" ||
      stem === "workerBoard" ||
      stem === "workerRetained" ||
      stem === "workerFrontier" ||
      stem === "workerCache" ||
      stem === "workerArena" ||
      stem === "workerRecord" ||
      stem === "workerIsolateSample" ||
      stem === "browserProcess" ||
      stem === "peakBrowserProcess"
    ) {
      continue;
    }

    if (!lanes[stem]) lanes[stem] = {};
    lanes[stem][key] = value;
  }

  if (Object.keys(lanes).length === 0) return null;
  return lanes;
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
    perLaneCounters: extractPerLaneCounters(result.metrics.counters),
    memory: (result.metrics.counters as Record<string, number> | undefined)
      ?.peakEstimatedMemoryBytes ?? null,
    elapsedMs: Math.round(result.metrics.elapsedMs * 100) / 100,
    configuration: {
      mode: job.mode,
      parallelism: job.parallelism,
      deterministic: job.deterministic,
      proofAlgorithm: job.proofAlgorithm,
      solverVersion: sokomindSolverMetadata.version,
      gitCommit,
      tuningFingerprint: tuningFp,
    },
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

  // -------------------------------------------------------------------------
  // Checkpoint loading (Gap 1a)
  // -------------------------------------------------------------------------
  let loadedCheckpoint: IdaStarCheckpoint | null = null;
  if (args.checkpointFile) {
    try {
      const checkpointJson = readFileSync(args.checkpointFile, "utf-8");
      const checkpoint = deserializeCheckpoint(checkpointJson);

      // Validate compatibility with the current board / solver
      const labels = [...new Set(board.goals.map((g) => g.label))].sort();
      const compat = validateCheckpointCompatibility(
        checkpoint,
        board,
        sokomindSolverMetadata.version,
        { kind: "moves" },
        board.floor.length,
        labels.length,
      );
      if (compat.compatible) {
        loadedCheckpoint = checkpoint;
        process.stderr.write(
          `Loaded checkpoint: threshold=${checkpoint.currentThreshold} ` +
          `iterations=${checkpoint.counters.iterations}\n`,
        );
      } else {
        process.stderr.write(
          `Warning: checkpoint incompatible (${compat.reason}), starting fresh.\n`,
        );
      }
    } catch (error: unknown) {
      process.stderr.write(
        `Warning: failed to load checkpoint (${error instanceof Error ? error.message : String(error)}), starting fresh.\n`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Checkpoint saving setup (Gap 1b)
  // -------------------------------------------------------------------------
  let checkpointPath: string | undefined;
  if (args.checkpointDir) {
    try {
      mkdirSync(args.checkpointDir, { recursive: true });
    } catch {
      // Directory may already exist
    }
    checkpointPath = join(
      args.checkpointDir,
      `${job.puzzleId}-checkpoint.json`,
    );
    process.stderr.write(`Checkpoint output: ${checkpointPath}\n`);
  }

  /**
   * Write a checkpoint snapshot atomically (write to temp + rename).
   * Called during IDA* proof runs when --checkpoint-dir is set.
   */
  function writeCheckpointSnapshot(cp: IdaStarCheckpoint): void {
    if (!checkpointPath) return;
    try {
      const tmpPath = `${checkpointPath}.${randomBytes(4).toString("hex")}.tmp`;
      writeFileSync(tmpPath, serializeCheckpoint(cp), "utf-8");
      renameSync(tmpPath, checkpointPath);
    } catch (error: unknown) {
      process.stderr.write(
        `Warning: failed to write checkpoint (${error instanceof Error ? error.message : String(error)})\n`,
      );
    }
  }

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

  const adapter = createNodeSolverAdapter({
    ...(loadedCheckpoint || checkpointPath
      ? {
          checkpointOptions: {
            ...(loadedCheckpoint ? { checkpoint: loadedCheckpoint } : {}),
            ...(checkpointPath
              ? { onCheckpoint: writeCheckpointSnapshot }
              : {}),
            solverVersion: sokomindSolverMetadata.version,
          },
        }
      : {}),
  });

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
