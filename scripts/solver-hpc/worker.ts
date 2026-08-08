#!/usr/bin/env node --experimental-strip-types
/**
 * HPC worker thread wrapper for Sokomind solver.
 *
 * Receives a puzzle assignment via workerData, runs the solver through the
 * Node adapter (createNodeSolverAdapter), and posts a structured JSONL result
 * back to the parent thread via parentPort.
 *
 * The result schema matches solve-sokomind.ts OutputRecord (schemaVersion 3).
 *
 * Usage (from parent):
 *   new Worker("./worker.ts", { workerData: assignment, execArgv: [...] })
 */

import { parentPort, workerData } from "node:worker_threads";
import { execSync } from "node:child_process";

import { parsePuzzleRows, type ParsedBoard } from "../../src/core/index.ts";
import { PUZZLE_BY_ID } from "../../src/catalog/puzzles.ts";
import type {
  SolverExecutionContext,
  SolverProgress,
  SolverRequest,
  SolverResult,
} from "../../src/solver/contracts.ts";
import { verifySolverSolution } from "../../src/solver/verification.ts";
import {
  sokomindSolverMetadata,
} from "../../src/solver/implementations/sokomind-solver.ts";
import {
  parseSokomindOptions,
} from "../../src/solver/implementations/sokomind-options.ts";
import {
  resolveSokomindTuning,
  sokomindTuningFingerprint,
} from "../../src/solver/implementations/sokomind-tuning.ts";
import { createNodeSolverAdapter } from "../../src/solver/node-runner.ts";

// ---------------------------------------------------------------------------
// Assignment contract (received via workerData)
// ---------------------------------------------------------------------------

interface WorkerAssignment {
  readonly puzzleId: string;
  readonly rows?: readonly string[];
  readonly mode: "fast" | "quality" | "optimal";
  readonly proofAlgorithm: "auto" | "astar" | "ida-star";
  readonly parallelism: number;
  readonly deterministic: boolean;
  readonly timeoutMs?: number;
  readonly memoryMib?: number;
  readonly checkpointFile?: string;
}

// ---------------------------------------------------------------------------
// Result contract (posted back to parent, matches §19.3 OutputRecord)
// ---------------------------------------------------------------------------

interface WorkerResult {
  readonly schemaVersion: 3;
  readonly puzzleId: string;
  readonly rows: readonly string[];
  readonly solution: {
    readonly steps: readonly { readonly direction: string; readonly kind: string }[];
    readonly moves: number;
    readonly pushes: number;
  } | null;
  readonly verified: boolean;
  readonly verificationDetail: string | null;
  readonly lowerBound: number | null;
  readonly upperBound: number | null;
  readonly gap: number | null;
  readonly proofStatus: string | null;
  readonly proofAlgorithm: string | null;
  readonly expandedStates: number | null;
  readonly generatedStates: number | null;
  readonly peakFrontierSize: number | null;
  readonly counters: Readonly<Record<string, number>> | null;
  readonly memory: number | null;
  readonly elapsedMs: number;
  readonly mode: string;
  readonly parallelism: number;
  readonly deterministic: boolean;
  readonly solverVersion: string;
  readonly gitCommit: string;
  readonly tuningFingerprint: string;
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function detectGitCommit(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

function resolveRows(assignment: WorkerAssignment): readonly string[] {
  if (assignment.rows && assignment.rows.length > 0) {
    return assignment.rows;
  }
  const puzzle = PUZZLE_BY_ID[assignment.puzzleId];
  if (!puzzle) {
    throw new Error(`Unknown puzzle ID and no rows provided: ${assignment.puzzleId}`);
  }
  return puzzle.rows;
}

// ---------------------------------------------------------------------------
// Main worker logic
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const port = parentPort;
  if (!port) {
    throw new Error("worker.ts must be run as a worker_thread, not as a main script");
  }

  const assignment = workerData as WorkerAssignment;
  const gitCommit = detectGitCommit();
  const tuningProfile = resolveSokomindTuning();
  const tuningFp = sokomindTuningFingerprint(tuningProfile);

  let rows: readonly string[];
  try {
    rows = resolveRows(assignment);
  } catch (err: unknown) {
    const errorResult: WorkerResult = {
      schemaVersion: 3,
      puzzleId: assignment.puzzleId,
      rows: [],
      solution: null,
      verified: false,
      verificationDetail: null,
      lowerBound: null,
      upperBound: null,
      gap: null,
      proofStatus: null,
      proofAlgorithm: null,
      expandedStates: null,
      generatedStates: null,
      peakFrontierSize: null,
      counters: null,
      memory: null,
      elapsedMs: 0,
      mode: assignment.mode,
      parallelism: assignment.parallelism,
      deterministic: assignment.deterministic,
      solverVersion: sokomindSolverMetadata.version,
      gitCommit,
      tuningFingerprint: tuningFp,
      error: err instanceof Error ? err.message : String(err),
    };
    port.postMessage(errorResult);
    return;
  }

  const board: ParsedBoard = parsePuzzleRows(rows);
  const request: SolverRequest = {
    board,
    snapshot: {
      puzzleId: assignment.puzzleId,
      robot: board.initialRobot,
      boxes: board.initialBoxes,
      moves: 0,
      pushes: 0,
      solved: false,
    },
    objective: { kind: "moves" },
    ...(assignment.timeoutMs !== undefined || assignment.memoryMib !== undefined
      ? {
          limits: {
            ...(assignment.timeoutMs !== undefined
              ? { maxElapsedMs: Math.floor(assignment.timeoutMs) }
              : {}),
            ...(assignment.memoryMib !== undefined
              ? { maxMemoryBytes: Math.floor(assignment.memoryMib * 1024 * 1024) }
              : {}),
          },
        }
      : {}),
    options: {
      "sokomind-solver": parseSokomindOptions({
        mode: assignment.mode,
        proofAlgorithm: assignment.proofAlgorithm,
        deterministic: assignment.deterministic,
        proofParallelism: assignment.parallelism,
      }),
    },
  };

  const adapter = createNodeSolverAdapter();

  // Cancellation: abort when the parent closes the port or sends "cancel"
  const ac = new AbortController();
  port.on("message", (msg: unknown) => {
    if (msg === "cancel") ac.abort();
  });
  port.on("close", () => ac.abort());

  const context: SolverExecutionContext = {
    signal: ac.signal,
    reportProgress(_progress: SolverProgress): void {
      // Progress could be forwarded to parent if needed; suppressed in HPC mode
    },
    now: performance.now.bind(performance),
  };

  let result: SolverResult;
  try {
    result = await adapter.solve(request, context);
  } catch (err: unknown) {
    const errorResult: WorkerResult = {
      schemaVersion: 3,
      puzzleId: assignment.puzzleId,
      rows,
      solution: null,
      verified: false,
      verificationDetail: null,
      lowerBound: null,
      upperBound: null,
      gap: null,
      proofStatus: null,
      proofAlgorithm: null,
      expandedStates: null,
      generatedStates: null,
      peakFrontierSize: null,
      counters: null,
      memory: null,
      elapsedMs: 0,
      mode: assignment.mode,
      parallelism: assignment.parallelism,
      deterministic: assignment.deterministic,
      solverVersion: sokomindSolverMetadata.version,
      gitCommit,
      tuningFingerprint: tuningFp,
      error: err instanceof Error ? err.message : String(err),
    };
    port.postMessage(errorResult);
    return;
  }

  // Build output matching solve-sokomind.ts OutputRecord
  let solution: WorkerResult["solution"] = null;
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

  const output: WorkerResult = {
    schemaVersion: 3,
    puzzleId: assignment.puzzleId,
    rows,
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
    mode: assignment.mode,
    parallelism: assignment.parallelism,
    deterministic: assignment.deterministic,
    solverVersion: sokomindSolverMetadata.version,
    gitCommit,
    tuningFingerprint: tuningFp,
  };

  port.postMessage(output);
}

run().catch((err: unknown) => {
  parentPort?.postMessage({
    schemaVersion: 3,
    puzzleId: "unknown",
    rows: [],
    solution: null,
    verified: false,
    verificationDetail: null,
    lowerBound: null,
    upperBound: null,
    gap: null,
    proofStatus: null,
    proofAlgorithm: null,
    expandedStates: null,
    generatedStates: null,
    peakFrontierSize: null,
    counters: null,
    memory: null,
    elapsedMs: 0,
    mode: "fast",
    parallelism: 1,
    deterministic: false,
    solverVersion: "unknown",
    gitCommit: "unknown",
    tuningFingerprint: "unknown",
    error: err instanceof Error ? err.message : String(err),
  });
});
