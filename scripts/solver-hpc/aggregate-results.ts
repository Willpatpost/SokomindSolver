/**
 * Aggregate JSONL solver results from HPC runs into a summary report.
 *
 * Usage:
 *   node --experimental-strip-types scripts/solver-hpc/aggregate-results.ts <results-dir> [--manifest=manifest.json] [--output=report.json]
 *
 * Reads every .jsonl file under <results-dir>, validates each record against
 * the schema-v3 output format (see solve-sokomind.ts / spec S19.3), and
 * produces an aggregate statistics report.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Mirrors OutputRecord from solve-sokomind.ts (schema v3). */
interface ResultRecord {
  schemaVersion: number;
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

interface AggregateReport {
  generatedAt: string;
  resultsDir: string;
  filesRead: number;
  recordsParsed: number;
  parseErrors: number;

  totals: {
    attempted: number;
    solved: number;
    unsolved: number;
    cancelled: number;
    errored: number;
  };

  solvedMetrics: {
    moves: { min: number; max: number; mean: number; median: number } | null;
    pushes: { min: number; max: number; mean: number; median: number } | null;
    expandedStates: { min: number; max: number; mean: number; median: number } | null;
    runtimeMs: { min: number; max: number; mean: number; median: number } | null;
  };

  proof: {
    optimal: number;
    bounded: number;
    none: number;
  };

  memory: {
    peakRssBytes: number | null;
  };

  verification: {
    verified: number;
    failed: number;
  };

  manifest: {
    provided: boolean;
    totalExpected: number;
    missing: string[];
    extra: string[];
  } | null;

  failedTasks: { puzzleId: string; reason: string }[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REQUIRED_FIELDS: (keyof ResultRecord)[] = [
  "puzzleId",
  "solution",
  "elapsedMs",
  "mode",
  "solverVersion",
];

function validateRecord(obj: Record<string, unknown>): obj is ResultRecord {
  for (const field of REQUIRED_FIELDS) {
    if (!(field in obj)) return false;
  }
  if (typeof obj.puzzleId !== "string") return false;
  if (typeof obj.elapsedMs !== "number") return false;
  return true;
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stats(values: number[]): { min: number; max: number; mean: number; median: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: Math.round((sum / sorted.length) * 100) / 100,
    median: Math.round(median(sorted) * 100) / 100,
  };
}

function collectJsonlFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      files.push(...collectJsonlFiles(full));
    } else if (entry.endsWith(".jsonl")) {
      files.push(full);
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const argv = process.argv.slice(2);
  let resultsDir: string | undefined;
  let manifestPath: string | undefined;
  let outputPath: string | undefined;

  for (const arg of argv) {
    if (arg.startsWith("--manifest=")) {
      manifestPath = arg.slice("--manifest=".length);
    } else if (arg.startsWith("--output=")) {
      outputPath = arg.slice("--output=".length);
    } else if (!arg.startsWith("-")) {
      resultsDir = arg;
    }
  }

  if (!resultsDir) {
    process.stderr.write("Usage: aggregate-results.ts <results-dir> [--manifest=...] [--output=...]\n");
    process.exit(1);
  }

  resultsDir = resolve(resultsDir);

  // Collect and parse all JSONL files
  const jsonlFiles = collectJsonlFiles(resultsDir);
  const records: ResultRecord[] = [];
  let parseErrors = 0;
  const failedTasks: { puzzleId: string; reason: string }[] = [];

  for (const file of jsonlFiles) {
    const lines = readFileSync(file, "utf-8").split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (validateRecord(obj)) {
          records.push(obj as unknown as ResultRecord);
        } else {
          parseErrors++;
          process.stderr.write(`Invalid record in ${file}: missing required fields\n`);
        }
      } catch {
        parseErrors++;
        process.stderr.write(`JSON parse error in ${file}\n`);
      }
    }
  }

  // Classify records
  const solved = records.filter((r) => r.solution !== null);
  const unsolved = records.filter((r) => r.solution === null && r.proofStatus !== "error" && r.proofStatus !== "cancelled");
  const cancelled = records.filter((r) => r.proofStatus === "cancelled");
  const errored = records.filter((r) => r.proofStatus === "error");

  // Track verification failures
  const verifiedCount = solved.filter((r) => r.verified).length;
  const verificationFailed = solved.filter((r) => !r.verified);
  for (const r of verificationFailed) {
    failedTasks.push({ puzzleId: r.puzzleId, reason: `verification failed: ${r.verificationDetail ?? "unknown"}` });
  }
  for (const r of unsolved) {
    failedTasks.push({ puzzleId: r.puzzleId, reason: "unsolved" });
  }
  for (const r of errored) {
    failedTasks.push({ puzzleId: r.puzzleId, reason: "error" });
  }

  // Solved metrics
  const moveValues = solved.map((r) => r.solution!.moves);
  const pushValues = solved.map((r) => r.solution!.pushes);
  const expandedValues = solved
    .filter((r) => r.expandedStates !== null)
    .map((r) => r.expandedStates!);
  const runtimeValues = solved.map((r) => r.elapsedMs);

  // Proof statistics
  const proofOptimal = records.filter((r) => r.proofStatus === "optimal" || r.proofStatus === "exact").length;
  const proofBounded = records.filter((r) => r.proofStatus === "bounded").length;
  const proofNone = records.filter((r) => r.proofStatus === null || (r.proofStatus !== "optimal" && r.proofStatus !== "exact" && r.proofStatus !== "bounded")).length;

  // Memory statistics
  const memoryValues = records
    .filter((r) => r.memory !== null)
    .map((r) => r.memory!);
  const peakRss = memoryValues.length > 0 ? Math.max(...memoryValues) : null;

  // Manifest check
  let manifestReport: AggregateReport["manifest"] = null;
  if (manifestPath) {
    const manifestData = JSON.parse(readFileSync(manifestPath, "utf-8")) as { puzzleIds?: string[] };
    const expectedIds = new Set(manifestData.puzzleIds ?? []);
    const foundIds = new Set(records.map((r) => r.puzzleId));
    const missing = [...expectedIds].filter((id) => !foundIds.has(id));
    const extra = [...foundIds].filter((id) => !expectedIds.has(id));
    manifestReport = {
      provided: true,
      totalExpected: expectedIds.size,
      missing,
      extra,
    };
  }

  // Build report
  const report: AggregateReport = {
    generatedAt: new Date().toISOString(),
    resultsDir,
    filesRead: jsonlFiles.length,
    recordsParsed: records.length,
    parseErrors,
    totals: {
      attempted: records.length,
      solved: solved.length,
      unsolved: unsolved.length,
      cancelled: cancelled.length,
      errored: errored.length,
    },
    solvedMetrics: {
      moves: moveValues.length > 0 ? stats(moveValues) : null,
      pushes: pushValues.length > 0 ? stats(pushValues) : null,
      expandedStates: expandedValues.length > 0 ? stats(expandedValues) : null,
      runtimeMs: runtimeValues.length > 0 ? stats(runtimeValues) : null,
    },
    proof: {
      optimal: proofOptimal,
      bounded: proofBounded,
      none: proofNone,
    },
    memory: {
      peakRssBytes: peakRss,
    },
    verification: {
      verified: verifiedCount,
      failed: verificationFailed.length,
    },
    manifest: manifestReport,
    failedTasks,
  };

  const output = JSON.stringify(report, null, 2) + "\n";

  if (outputPath) {
    writeFileSync(outputPath, output);
    process.stderr.write(`Report written to ${outputPath}\n`);
  } else {
    process.stdout.write(output);
  }

  // Exit with non-zero if there are failures
  if (failedTasks.length > 0 || parseErrors > 0) {
    process.stderr.write(`Warning: ${failedTasks.length} failed tasks, ${parseErrors} parse errors\n`);
  }
}

main();
