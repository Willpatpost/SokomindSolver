/**
 * Backward perimeter benchmark: feature-off vs feature-on.
 * Run: npx tsx tests/scripts/perimeter-benchmark.ts
 */
import { parsePuzzleRows } from "../../src/core/index.ts";
import { runExactMoveAStar } from "../../src/solver/search/exact-move-astar.ts";
import type { SolverExecutionContext } from "../../src/solver/contracts.ts";
import {
  HUGE,
  BENCHMARK_CORPUS,
} from "../fixtures/solver-v2/benchmark-corpus.ts";

function makeContext(timeoutMs = 30_000): SolverExecutionContext & { _cleanup: () => void } {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  return {
    now: () => performance.now(),
    signal: ac.signal,
    reportProgress: () => undefined,
    _cleanup: () => clearTimeout(timer),
  };
}

interface RunResult {
  status: string;
  moves: number | undefined;
  pushes: number | undefined;
  expanded: number;
  elapsedMs: number;
  perimeterBuildMs: number;
  perimeterProjected: number;
  perimeterColoredStates: number;
  perimeterLookups: number;
  perimeterHits: number;
  perimeterImprovements: number;
  perimeterTotalImprovement: number;
  perimeterMaxImprovement: number;
  perimeterMaxDepth: number;
  perimeterConstrainedSkipped: number;
  perimeterRetainedBytes: number;
  matchingComponents: number;
  corridorViableCells: number;
  corridorViableEdges: number;
}

function c(counters: Readonly<Record<string, number>> | undefined, key: string): number {
  return (counters as Record<string, number> | undefined)?.[key] ?? 0;
}

async function runOnce(
  rows: readonly string[],
  perimeterOn: boolean,
  timeoutMs = 30_000,
  featureOverrides?: Record<string, boolean>,
): Promise<RunResult> {
  const parsed = parsePuzzleRows(rows as string[]);
  const ctx = makeContext(timeoutMs);
  try {
    const result = await runExactMoveAStar(
      {
        board: parsed,
        snapshot: {
          puzzleId: "bench",
          robot: parsed.initialRobot,
          boxes: parsed.initialBoxes,
          moves: 0,
          pushes: 0,
          solved: false,
        },
        objective: { kind: "moves" },
        limits: {
          maxElapsedMs: timeoutMs,
          maxExpandedStates: 500_000,
          maxGeneratedStates: 2_000_000,
          maxMemoryBytes: 512 * 1024 * 1024,
        },
      },
      ctx,
      { features: { backwardPerimeter: perimeterOn, ...featureOverrides } },
    );
    const cs = result.metrics?.counters;
    const sol = result.status === "solved" ? result.solution : undefined;
    return {
      status: result.status,
      moves: sol?.moves,
      pushes: sol?.pushes,
      expanded: result.metrics?.expandedStates ?? 0,
      elapsedMs: result.metrics?.elapsedMs ?? 0,
      perimeterBuildMs: c(cs, "backwardPerimeterBuildTimeMs"),
      perimeterProjected: c(cs, "backwardPerimeterProjectedStates"),
      perimeterColoredStates: c(cs, "backwardPerimeterColoredStates"),
      perimeterLookups: c(cs, "backwardPerimeterLookups"),
      perimeterHits: c(cs, "backwardPerimeterHits"),
      perimeterImprovements: c(cs, "backwardPerimeterImprovements"),
      perimeterTotalImprovement: c(cs, "backwardPerimeterTotalImprovement"),
      perimeterMaxImprovement: c(cs, "backwardPerimeterMaxImprovement"),
      perimeterMaxDepth: c(cs, "backwardPerimeterMaxDepth"),
      perimeterConstrainedSkipped: c(cs, "backwardPerimeterConstrainedSkipped"),
      perimeterRetainedBytes: c(cs, "backwardPerimeterRetainedBytes"),
      matchingComponents: c(cs, "matchingComponents"),
      corridorViableCells: c(cs, "corridorViableCells"),
      corridorViableEdges: c(cs, "corridorViableEdges"),
    };
  } finally {
    ctx._cleanup();
  }
}

async function main() {
  const selected = BENCHMARK_CORPUS.filter(f =>
    ["ultra-tiny", "tiny", "tutorial-push", "beginner-three",
     "beginner-detour", "garden-1", "box-5x5-a", "medium",
     "inter-rooms", "corridor-2",
    ].includes(f.fixtureId) ||
    f === HUGE
  );

  console.log("=== Backward Perimeter Benchmark ===\n");
  console.log("Puzzle".padEnd(25) +
    "Status".padEnd(10) +
    "Moves".padEnd(8) +
    "Expanded-OFF".padEnd(15) +
    "Expanded-ON".padEnd(15) +
    "Ratio".padEnd(8) +
    "Ms-OFF".padEnd(10) +
    "Ms-ON".padEnd(10) +
    "Perim-Build".padEnd(13) +
    "Projected".padEnd(12) +
    "Lookups".padEnd(10) +
    "Hits".padEnd(8) +
    "Improve".padEnd(10) +
    "TotImpr".padEnd(10) +
    "MaxImpr".padEnd(10) +
    "Skipped".padEnd(10) +
    "Comps".padEnd(8));
  console.log("-".repeat(190));

  for (const fixture of selected) {
    const name = fixture.fixtureId;
    process.stdout.write(`  ${name}...`);

    try {
      const off = await runOnce(fixture.rows, false, 30_000);
      const on = await runOnce(fixture.rows, true, 30_000);

      const ratio = off.expanded > 0
        ? (on.expanded / off.expanded).toFixed(3)
        : "N/A";

      console.log(`\r${name.padEnd(25)}` +
        `${on.status.padEnd(10)}` +
        `${String(on.moves ?? "-").padEnd(8)}` +
        `${String(off.expanded).padEnd(15)}` +
        `${String(on.expanded).padEnd(15)}` +
        `${ratio.padEnd(8)}` +
        `${off.elapsedMs.toFixed(0).padEnd(10)}` +
        `${on.elapsedMs.toFixed(0).padEnd(10)}` +
        `${on.perimeterBuildMs.toFixed(1).padEnd(13)}` +
        `${String(on.perimeterProjected).padEnd(12)}` +
        `${String(on.perimeterLookups).padEnd(10)}` +
        `${String(on.perimeterHits).padEnd(8)}` +
        `${String(on.perimeterImprovements).padEnd(10)}` +
        `${String(on.perimeterTotalImprovement).padEnd(10)}` +
        `${String(on.perimeterMaxImprovement).padEnd(10)}` +
        `${String(on.perimeterConstrainedSkipped).padEnd(10)}` +
        `${String(on.matchingComponents).padEnd(8)}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message.slice(0, 80) : String(err);
      console.log(`\r${name.padEnd(25)} ERROR: ${msg}`);
    }
  }

  console.log("\n=== Grand Hall Detail (heavy features off to isolate perimeter) ===\n");
  const lightFeatures = {
    patternDatabase: false,
    interactionBoost: false,
    deadlockTablePruning: false,
  };
  try {
    const on = await runOnce(HUGE.rows, true, 60_000, lightFeatures);
    console.log(`  Status:            ${on.status}`);
    console.log(`  Moves:             ${on.moves ?? "-"}`);
    console.log(`  Expanded:          ${on.expanded}`);
    console.log(`  Elapsed:           ${on.elapsedMs.toFixed(0)} ms`);
    console.log(`  Perim Build:       ${on.perimeterBuildMs.toFixed(1)} ms`);
    console.log(`  Colored States:    ${on.perimeterColoredStates}`);
    console.log(`  Projected States:  ${on.perimeterProjected}`);
    console.log(`  Retained Bytes:    ${on.perimeterRetainedBytes}`);
    console.log(`  Lookups:           ${on.perimeterLookups}`);
    console.log(`  Hits:              ${on.perimeterHits}`);
    console.log(`  Improvements:      ${on.perimeterImprovements}`);
    console.log(`  Total Improvement: ${on.perimeterTotalImprovement}`);
    console.log(`  Max Improvement:   ${on.perimeterMaxImprovement}`);
    console.log(`  Max Depth:         ${on.perimeterMaxDepth}`);
    console.log(`  Constrained Skip:  ${on.perimeterConstrainedSkipped}`);
    console.log(`  Matching Comps:    ${on.matchingComponents}`);
    console.log(`  Corridor Cells:    ${on.corridorViableCells}`);
    console.log(`  Corridor Edges:    ${on.corridorViableEdges}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message.slice(0, 120) : String(err);
    console.log(`  Grand Hall error: ${msg}`);
  }

  console.log("\n=== Grand Hall Comparison (light features, perim on vs off) ===\n");
  try {
    const off = await runOnce(HUGE.rows, false, 60_000, lightFeatures);
    const on = await runOnce(HUGE.rows, true, 60_000, lightFeatures);
    console.log(`  OFF: status=${off.status} expanded=${off.expanded} elapsed=${off.elapsedMs.toFixed(0)}ms`);
    console.log(`  ON:  status=${on.status} expanded=${on.expanded} elapsed=${on.elapsedMs.toFixed(0)}ms`);
    console.log(`  ON perimeter: built=${on.perimeterBuildMs.toFixed(1)}ms projected=${on.perimeterProjected} lookups=${on.perimeterLookups} hits=${on.perimeterHits} improvements=${on.perimeterImprovements} totalImpr=${on.perimeterTotalImprovement} maxImpr=${on.perimeterMaxImprovement}`);
    if (off.expanded > 0) {
      console.log(`  Ratio: ${(on.expanded / off.expanded).toFixed(4)}`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message.slice(0, 120) : String(err);
    console.log(`  Grand Hall comparison error: ${msg}`);
  }

  console.log("\nDone.");
}

main().catch(console.error);
