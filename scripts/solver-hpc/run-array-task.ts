#!/usr/bin/env node --experimental-strip-types
/**
 * SLURM array-task dispatcher for Sokomind solver.
 *
 * Each SLURM array task reads its assignment from a JSON manifest file and
 * invokes solve-sokomind.ts as an isolated child process (reusing the tested
 * CLI rather than duplicating solver wiring).
 *
 * Usage:
 *   # Launched by SLURM; reads SLURM_ARRAY_TASK_ID from environment
 *   node --experimental-strip-types scripts/solver-hpc/run-array-task.ts \
 *     --manifest=jobs/manifest.json \
 *     --output-dir=results/run-20260807
 *
 * Manifest format (JSON array of puzzle assignments):
 *   [
 *     { "puzzleId": "beginner-three", "mode": "fast", ... },
 *     { "puzzleId": "huge", "mode": "quality", "timeoutMs": 60000, ... }
 *   ]
 *
 * Each array task index maps 1:1 to a manifest entry (0-indexed).
 * Output is written to <output-dir>/task-<SLURM_ARRAY_TASK_ID>.jsonl
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync, execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ManifestEntry {
  readonly puzzleId: string;
  readonly rows?: readonly string[];
  readonly mode?: "fast" | "quality" | "optimal";
  readonly proofAlgorithm?: "auto" | "astar" | "ida-star";
  readonly parallelism?: number;
  readonly deterministic?: boolean;
  readonly timeoutMs?: number;
  readonly memoryMib?: number;
  readonly checkpointFile?: string;
}

interface TaskMetadata {
  readonly slurmArrayTaskId: number;
  readonly slurmJobId: string;
  readonly hostname: string;
  readonly gitCommit: string;
  readonly nodeVersion: string;
  readonly startedAt: string;
  readonly manifestPath: string;
  readonly puzzleId: string;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface DispatcherArgs {
  readonly manifestPath: string;
  readonly outputDir: string;
  readonly checkpointDir?: string;
}

function parseDispatcherArgs(argv: readonly string[]): DispatcherArgs {
  let manifestPath: string | undefined;
  let outputDir: string | undefined;
  let checkpointDir: string | undefined;

  for (const arg of argv) {
    if (arg.startsWith("--manifest=")) {
      manifestPath = arg.slice("--manifest=".length);
    } else if (arg.startsWith("--output-dir=")) {
      outputDir = arg.slice("--output-dir=".length);
    } else if (arg.startsWith("--checkpoint-dir=")) {
      checkpointDir = arg.slice("--checkpoint-dir=".length);
    }
  }

  // Fall back to environment variables
  if (!manifestPath) {
    manifestPath = process.env["SOKOMIND_MANIFEST"];
  }
  if (!outputDir) {
    outputDir = process.env["SOKOMIND_OUTPUT_DIR"];
  }
  if (!checkpointDir) {
    checkpointDir = process.env["SOKOMIND_CHECKPOINT_DIR"];
  }

  if (!manifestPath) {
    process.stderr.write(
      "Error: --manifest=<path> or SOKOMIND_MANIFEST env var is required\n",
    );
    process.exit(1);
  }
  if (!outputDir) {
    process.stderr.write(
      "Error: --output-dir=<path> or SOKOMIND_OUTPUT_DIR env var is required\n",
    );
    process.exit(1);
  }

  return {
    manifestPath: resolve(manifestPath),
    outputDir: resolve(outputDir),
    checkpointDir: checkpointDir ? resolve(checkpointDir) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function detectGitCommit(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

function readManifest(path: string): readonly ManifestEntry[] {
  const raw = readFileSync(path, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Manifest must be a JSON array, got ${typeof parsed}`);
  }
  return parsed as ManifestEntry[];
}

function resolveCheckpointFile(
  checkpointDir: string | undefined,
  puzzleId: string,
  taskId: number,
): string | undefined {
  if (!checkpointDir) return undefined;
  const candidate = resolve(checkpointDir, `checkpoint-task-${taskId}-${puzzleId}.json`);
  if (existsSync(candidate)) {
    return candidate;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Child process invocation
// ---------------------------------------------------------------------------

function invokeSolver(
  entry: ManifestEntry,
  checkpointFile: string | undefined,
  timeoutMs: number,
): { readonly stdout: string; readonly exitCode: number | null; readonly signal: string | null } {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const solveScript = resolve(scriptDir, "..", "solve-sokomind.ts");

  const args: string[] = [
    "--experimental-strip-types",
    solveScript,
  ];

  if (entry.puzzleId) {
    args.push(`--puzzle=${entry.puzzleId}`);
  }
  if (entry.mode) {
    args.push(`--mode=${entry.mode}`);
  }
  if (entry.proofAlgorithm) {
    args.push(`--proof-algorithm=${entry.proofAlgorithm}`);
  }
  if (entry.parallelism !== undefined && entry.parallelism > 1) {
    args.push(`--parallelism=${entry.parallelism}`);
  }
  if (entry.deterministic) {
    args.push("--deterministic");
  }
  if (entry.timeoutMs !== undefined) {
    args.push(`--timeout-ms=${entry.timeoutMs}`);
  }
  if (entry.memoryMib !== undefined) {
    args.push(`--memory-mib=${entry.memoryMib}`);
  }
  if (checkpointFile) {
    args.push(`--checkpoint=${checkpointFile}`);
  }

  // If rows are provided (not in catalog), pass them via stdin as JSON
  let input: string | undefined;
  if (entry.rows && entry.rows.length > 0) {
    input = JSON.stringify({ puzzleId: entry.puzzleId, rows: entry.rows });
  }

  const child = spawnSync(process.execPath, args, {
    encoding: "utf8",
    input,
    timeout: timeoutMs,
    env: process.env,
    cwd: resolve(scriptDir, "..", ".."),
    windowsHide: true,
  });

  if (child.stderr) {
    process.stderr.write(child.stderr);
  }

  return {
    stdout: child.stdout ?? "",
    exitCode: child.status,
    signal: child.signal,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = parseDispatcherArgs(process.argv.slice(2));

  // Resolve SLURM array task ID (fall back to 0 for local testing)
  const taskIdRaw = process.env["SLURM_ARRAY_TASK_ID"];
  const taskId = taskIdRaw !== undefined ? parseInt(taskIdRaw, 10) : 0;
  if (!Number.isFinite(taskId) || taskId < 0) {
    process.stderr.write(`Invalid SLURM_ARRAY_TASK_ID: ${taskIdRaw}\n`);
    process.exit(1);
  }

  const slurmJobId = process.env["SLURM_JOB_ID"] ?? process.env["SLURM_ARRAY_JOB_ID"] ?? "local";
  const gitCommit = detectGitCommit();

  // Read manifest
  const manifest = readManifest(args.manifestPath);
  if (taskId >= manifest.length) {
    process.stderr.write(
      `SLURM_ARRAY_TASK_ID=${taskId} exceeds manifest length=${manifest.length}\n`,
    );
    process.exit(1);
  }

  const entry = manifest[taskId];
  const startedAt = new Date().toISOString();

  const metadata: TaskMetadata = {
    slurmArrayTaskId: taskId,
    slurmJobId,
    hostname: hostname(),
    gitCommit,
    nodeVersion: process.version,
    startedAt,
    manifestPath: args.manifestPath,
    puzzleId: entry.puzzleId,
  };

  process.stderr.write(
    `[run-array-task] task=${taskId} puzzle=${entry.puzzleId} ` +
    `mode=${entry.mode ?? "fast"} job=${slurmJobId} ` +
    `host=${metadata.hostname} start=${startedAt}\n`,
  );

  // Ensure output directory exists
  mkdirSync(args.outputDir, { recursive: true });

  const outputPath = resolve(args.outputDir, `task-${taskId}.jsonl`);

  // Check for checkpoint resume: prefer CLI/env checkpoint dir, then entry-level file
  const effectiveCheckpointDir = args.checkpointDir
    ?? (entry.checkpointFile ? dirname(entry.checkpointFile) : undefined);
  const checkpointFile = entry.checkpointFile && existsSync(entry.checkpointFile)
    ? entry.checkpointFile
    : resolveCheckpointFile(effectiveCheckpointDir, entry.puzzleId, taskId);
  if (checkpointFile) {
    process.stderr.write(`[run-array-task] resuming from checkpoint: ${checkpointFile}\n`);
  }

  // Compute child timeout: use entry timeout + 60s buffer, or 10 minutes default
  const childTimeoutMs = (entry.timeoutMs ?? 300_000) + 60_000;

  // Invoke the solver as a child process
  const childResult = invokeSolver(entry, checkpointFile, childTimeoutMs);
  const finishedAt = new Date().toISOString();

  // Extract the JSONL result line from stdout
  const resultLines = childResult.stdout
    .split("\n")
    .filter((line) => line.trim().length > 0);

  if (resultLines.length === 0) {
    // Solver produced no output — write an error record
    const errorRecord = {
      schemaVersion: 3,
      puzzleId: entry.puzzleId,
      rows: entry.rows ?? [],
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
      mode: entry.mode ?? "fast",
      parallelism: entry.parallelism ?? 1,
      deterministic: entry.deterministic ?? false,
      solverVersion: "unknown",
      gitCommit,
      tuningFingerprint: "unknown",
      error: childResult.signal
        ? `child terminated by signal ${childResult.signal}`
        : `child exited with code ${childResult.exitCode}`,
      _task: metadata,
      _finishedAt: finishedAt,
    };
    writeFileSync(outputPath, JSON.stringify(errorRecord) + "\n");
    process.stderr.write(
      `[run-array-task] task=${taskId} ERROR: no solver output ` +
      `(exit=${childResult.exitCode}, signal=${childResult.signal})\n`,
    );
    process.exit(1);
  }

  // Augment each result line with task metadata and write
  const outputLines: string[] = [];
  for (const line of resultLines) {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      record["_task"] = metadata;
      record["_finishedAt"] = finishedAt;
      outputLines.push(JSON.stringify(record));
    } catch {
      // Preserve non-JSON lines as-is (unlikely from solve-sokomind.ts)
      outputLines.push(line);
    }
  }

  writeFileSync(outputPath, outputLines.join("\n") + "\n");

  process.stderr.write(
    `[run-array-task] task=${taskId} puzzle=${entry.puzzleId} ` +
    `finished=${finishedAt} output=${outputPath}\n`,
  );

  // Propagate child exit code
  process.exit(childResult.exitCode ?? 0);
}

main();
