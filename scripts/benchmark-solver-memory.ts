/**
 * Solver memory benchmark.
 *
 * Measures process RSS before and after solving each fixture in an isolated
 * child process, reporting peak RSS and heap usage.
 *
 * Usage:
 *   npm run benchmark:solver:memory
 *   npm run benchmark:solver:memory -- --fixture=v2-3box-typed
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  BENCHMARK_CORPUS,
  BENCHMARK_FIXTURE_BY_ID,
  type BenchmarkFixture,
} from "../tests/fixtures/solver-v2/benchmark-corpus.ts";
import { createSession, type PuzzleDefinition } from "../src/core/index.ts";
import type {
  SolverExecutionContext,
  SolverRequest,
  SolverResult,
} from "../src/solver/contracts.ts";
import {
  classicAStarSolver,
} from "../src/solver/implementations/classic-solvers.ts";

interface MemoryBenchmarkResult {
  fixtureId: string;
  boxCount: number;
  floorCount: number;
  status: "solved" | "unsolved" | "cancelled" | "error";
  moves?: number;
  elapsedMs: number;
  heapUsedBefore: number;
  heapUsedAfter: number;
  heapTotalAfter: number;
  rssAfter: number;
  externalAfter: number;
  arrayBuffersAfter: number;
}

function requestFromFixture(fixture: BenchmarkFixture): SolverRequest {
  const puzzle: PuzzleDefinition = {
    id: fixture.fixtureId,
    title: fixture.fixtureId,
    difficulty: "beginner",
    boxes: fixture.boxes,
    rows: fixture.rows as string[],
  };
  const session = createSession(puzzle);
  return {
    board: session.board,
    snapshot: session.snapshot,
    objective: { kind: "moves" },
    limits: {
      maxElapsedMs: 30_000,
      maxExpandedStates: 200_000,
    },
  };
}

async function measureFixture(
  fixture: BenchmarkFixture,
): Promise<MemoryBenchmarkResult> {
  const request = requestFromFixture(fixture);
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 30_000);

  const ctx: SolverExecutionContext = {
    signal: ac.signal,
    reportProgress: () => undefined,
    now: () => performance.now(),
  };

  global.gc?.();
  const memBefore = process.memoryUsage();

  const startedAt = performance.now();
  let result: SolverResult | undefined;
  let error: string | undefined;
  try {
    result = await classicAStarSolver.solve(request, ctx);
  } catch (e) {
    error = String(e);
  }
  clearTimeout(timeout);
  const elapsedMs = Math.round(performance.now() - startedAt);

  const memAfter = process.memoryUsage();

  const base: MemoryBenchmarkResult = {
    fixtureId: fixture.fixtureId,
    boxCount: fixture.boxes,
    floorCount: fixture.floorCount,
    status: error ? "error" : result?.status ?? "error",
    elapsedMs,
    heapUsedBefore: memBefore.heapUsed,
    heapUsedAfter: memAfter.heapUsed,
    heapTotalAfter: memAfter.heapTotal,
    rssAfter: memAfter.rss,
    externalAfter: memAfter.external,
    arrayBuffersAfter: memAfter.arrayBuffers,
  };

  if (result?.status === "solved") {
    base.moves = result.solution.moves;
  }

  return base;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function main(): Promise<void> {
  const fixtureFilter = process.argv
    .filter((a) => a.startsWith("--fixture="))
    .map((a) => a.slice("--fixture=".length))
    .filter(Boolean);

  const childMode = process.argv.includes("--child");
  const childFixtureArg = process.argv.find((a) => a.startsWith("--child-fixture="));

  if (childMode && childFixtureArg) {
    const fid = childFixtureArg.slice("--child-fixture=".length);
    const fixture = BENCHMARK_FIXTURE_BY_ID[fid];
    if (!fixture) {
      process.stderr.write(`Unknown fixture: ${fid}\n`);
      process.exit(1);
    }
    const result = await measureFixture(fixture);
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }

  const fixtures = fixtureFilter.length > 0
    ? fixtureFilter.map((id) => {
        const f = BENCHMARK_FIXTURE_BY_ID[id];
        if (!f) throw new Error(`Unknown fixture: ${id}`);
        return f;
      })
    : BENCHMARK_CORPUS.flatMap((g) => g.fixtures).filter((f) => f.boxes <= 6);

  console.log(`Memory benchmark: ${fixtures.length} fixtures\n`);
  console.log(
    "Fixture".padEnd(40) +
    "Boxes".padStart(6) +
    "Floor".padStart(6) +
    "Status".padStart(10) +
    "RSS".padStart(12) +
    "Heap".padStart(12) +
    "Time".padStart(10),
  );
  console.log("-".repeat(96));

  const scriptPath = fileURLToPath(import.meta.url);
  const results: MemoryBenchmarkResult[] = [];

  for (const fixture of fixtures) {
    const child = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--expose-gc",
        scriptPath,
        "--child",
        `--child-fixture=${fixture.fixtureId}`,
      ],
      { timeout: 60_000, encoding: "utf-8" },
    );

    if (child.status !== 0 || !child.stdout.trim()) {
      console.log(
        fixture.fixtureId.padEnd(40) +
        String(fixture.boxes).padStart(6) +
        String(fixture.floorCount).padStart(6) +
        "error".padStart(10) +
        "—".padStart(12) +
        "—".padStart(12) +
        "—".padStart(10),
      );
      continue;
    }

    const result: MemoryBenchmarkResult = JSON.parse(child.stdout.trim());
    results.push(result);

    console.log(
      fixture.fixtureId.padEnd(40) +
      String(result.boxCount).padStart(6) +
      String(result.floorCount).padStart(6) +
      result.status.padStart(10) +
      formatBytes(result.rssAfter).padStart(12) +
      formatBytes(result.heapUsedAfter).padStart(12) +
      `${result.elapsedMs}ms`.padStart(10),
    );
  }

  console.log("\n" + JSON.stringify({ results }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
