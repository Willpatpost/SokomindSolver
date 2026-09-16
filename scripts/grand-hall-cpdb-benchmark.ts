#!/usr/bin/env npx tsx
/**
 * Grand Hall component PDB benchmark.
 *
 * Runs the exact A* and IDA* solver on Grand Hall with componentPdb ON vs OFF,
 * and reports structural diagnostics and heuristic telemetry.
 *
 * Usage: npx tsx scripts/grand-hall-cpdb-benchmark.ts
 */

import { parsePuzzleRows } from "../src/core/index.ts";
import { compileSearchBoard } from "../src/solver/search/compiled-board.ts";
import {
  analyzeMatchingComponents,
  extractMatchingComponents,
} from "../src/solver/search/matching-components.ts";
import { compileSingleBoxPushGraph } from "../src/solver/search/single-box-push-graph.ts";
import {
  buildComponentPdbCollection,
} from "../src/solver/search/component-pdb.ts";
import { runExactMoveAStar } from "../src/solver/search/exact-move-astar.ts";
import { runIdaStarSearch } from "../src/solver/search/ida-star.ts";
import type {
  SolverExecutionContext,
  SolverRequest,
  SolverResult,
} from "../src/solver/contracts.ts";
import { HUGE } from "../tests/fixtures/solver-v2/benchmark-corpus.ts";

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function makeContext(timeoutMs = 120_000): {
  context: SolverExecutionContext;
  abort: AbortController;
} {
  const abort = new AbortController();
  const start = performance.now();
  setTimeout(() => abort.abort(), timeoutMs);
  return {
    context: {
      now: () => performance.now(),
      signal: abort.signal,
      reportProgress: () => undefined,
    },
    abort,
  };
}

function makeRequest(rows: readonly string[], timeoutMs = 120_000): SolverRequest {
  const parsed = parsePuzzleRows(rows);
  return {
    board: parsed,
    snapshot: {
      puzzleId: "grand-hall",
      robot: parsed.initialRobot,
      boxes: parsed.initialBoxes,
      moves: 0,
      pushes: 0,
      solved: false,
    },
    objective: { kind: "moves" },
    limits: {
      maxElapsedMs: timeoutMs,
      maxExpandedStates: 2_000_000,
      maxGeneratedStates: 10_000_000,
      maxMemoryBytes: 4 * 1024 * 1024 * 1024,
    },
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function printResult(label: string, result: SolverResult): void {
  console.log(`\n--- ${label} ---`);
  console.log(`  status: ${result.status}`);
  if (result.status === "solved") {
    console.log(`  moves: ${result.solution.moves}`);
    console.log(`  pushes: ${result.solution.pushes}`);
    console.log(`  optimality: ${result.solution.optimality}`);
    if (result.proof) {
      console.log(`  proof: ${result.proof.kind}`);
    }
  }
  if (result.status === "unsolved") {
    console.log(`  reason: ${(result as any).reason}`);
    console.log(`  detail: ${(result as any).detail}`);
  }
  const m = result.metrics;
  console.log(`  elapsedMs: ${m.elapsedMs.toFixed(0)}`);
  console.log(`  expandedStates: ${m.expandedStates}`);
  console.log(`  generatedStates: ${m.generatedStates}`);
  console.log(`  peakFrontierSize: ${m.peakFrontierSize}`);
  if (m.counters) {
    const c = m.counters as Record<string, number>;
    console.log(`  peakMemory: ${formatBytes(c.peakEstimatedMemoryBytes ?? 0)}`);
    console.log(`  componentPdbBuildTimeMs: ${c.componentPdbBuildTimeMs ?? 0}`);
    console.log(`  componentPdbRetainedBytes: ${formatBytes(c.componentPdbRetainedBytes ?? 0)}`);
    console.log(`  componentPdbComponents: ${c.componentPdbComponents ?? 0}`);
    console.log(`  componentPdbImprovements: ${c.componentPdbImprovements ?? 0}`);
    console.log(`  componentPdbTotalImprovement: ${c.componentPdbTotalImprovement ?? 0}`);
    console.log(`  componentPdbMaxImprovement: ${c.componentPdbMaxImprovement ?? 0}`);
    console.log(`  componentPdbPartitionQueries: ${c.componentPdbPartitionQueries ?? 0}`);
    console.log(`  componentPdbPartitionCacheHits: ${c.componentPdbPartitionCacheHits ?? 0}`);
    console.log(`  matchingComponents: ${c.matchingComponents ?? 0}`);
    console.log(`  matchingEliminatedEdges: ${c.matchingEliminatedEdges ?? 0}`);
    console.log(`  heuristicCalls: ${c.heuristicCalls ?? 0}`);
    console.log(`  maxDepth: ${c.maxDepth ?? 0}`);
    if (c.lowerBound !== undefined) {
      console.log(`  lowerBound: ${c.lowerBound}`);
    }
  }
}

// -----------------------------------------------------------------------
// Structural diagnostic (Plan Section 25)
// -----------------------------------------------------------------------

async function runStructuralDiagnostic(): Promise<void> {
  console.log("=== Grand Hall Structural Diagnostic ===\n");

  const parsed = parsePuzzleRows(HUGE.rows);
  const board = compileSearchBoard(parsed);
  const budget = {
    signal: new AbortController().signal,
    now: () => performance.now(),
    deadline: performance.now() + 30000,
    baseMemoryBytes: 0,
  };

  const singleBoxGraph = compileSingleBoxPushGraph(board, budget);
  const matchingResult = analyzeMatchingComponents(board, singleBoxGraph);
  const components = extractMatchingComponents(board, matchingResult);

  console.log(`Total matching components: ${matchingResult.totalComponents}`);
  console.log(`Finite edges: ${matchingResult.finiteEdges}`);
  console.log(`Allowed edges: ${matchingResult.allowedEdges}`);
  console.log(`Eliminated edges: ${matchingResult.eliminatedEdges}`);
  console.log();

  const componentsByLabel = new Map<string, typeof components[number][]>();
  for (const comp of components) {
    let list = componentsByLabel.get(comp.label);
    if (!list) {
      list = [];
      componentsByLabel.set(comp.label, list);
    }
    list.push(comp);
  }

  for (const [label, comps] of componentsByLabel) {
    console.log(`Label "${label}" → ${comps.length} component(s):`);
    const sizes = comps.map((c) => c.goalCells.length).sort((a, b) => b - a);
    console.log(`  Component sizes: [${sizes.join(", ")}]`);
    for (const comp of comps) {
      console.log(`  Component ${comp.id}:`);
      console.log(`    goals: ${comp.goalCells.length}, initials: ${comp.initialCells.length}`);
      console.log(`    goal cells: [${comp.goalCells.join(", ")}]`);
      console.log(`    initial cells: [${comp.initialCells.join(", ")}]`);
      console.log(`    corridor viable cells: ${comp.corridor.viableCells.size}`);
      console.log(`    corridor viable edges: ${comp.corridor.viableDirectedEdges.size}`);
    }
  }

  // Build component PDBs and report stats
  console.log("\n=== Component PDB Build Stats ===\n");
  const collection = buildComponentPdbCollection(
    board,
    components,
    { totalMaxStates: 500_000, maxStatesPerComponent: 200_000 },
    budget,
    () => performance.now(),
  );

  console.log(`Build time: ${collection.stats.componentPdbBuildTimeMs.toFixed(0)} ms`);
  console.log(`Peak build bytes: ${formatBytes(collection.stats.componentPdbPeakBuildBytes)}`);
  console.log(`Retained bytes: ${formatBytes(collection.stats.componentPdbRetainedBytes)}`);
  console.log(`Families: ${collection.families.size}`);

  for (const [label, family] of collection.families) {
    console.log(`\n  Family "${label}" (${family.totalBoxCount} boxes, ${family.components.length} component(s)):`);
    for (const comp of family.components) {
      const s = comp.stats;
      console.log(`    Component ${comp.componentId} (${comp.boxCount} boxes):`);
      console.log(`      states: ${s.states}, complete: ${s.complete}`);
      console.log(`      completedRadius: ${s.completedRadius}, maxDepthSeen: ${s.maxDepthSeen}`);
      console.log(`      buildTime: ${s.buildTimeMs.toFixed(1)} ms`);
      console.log(`      retained: ${formatBytes(s.retainedBytes)}`);
    }
  }
}

// -----------------------------------------------------------------------
// A* benchmark (Plan Section 26)
// -----------------------------------------------------------------------

async function runAStarBenchmark(): Promise<void> {
  const timeoutMs = 120_000;

  // Disable interaction boost to isolate component PDB's effect
  const baseFeatures = {
    backwardPerimeter: false,
    interactionBoost: false,
  };

  console.log("\n\n=== A* Benchmark: componentPdb OFF (no interaction boost) ===");
  {
    const request = makeRequest(HUGE.rows, timeoutMs);
    const { context } = makeContext(timeoutMs + 5000);
    const result = await runExactMoveAStar(request, context, {
      features: { ...baseFeatures, componentPdb: false },
    });
    printResult("A* baseline (componentPdb OFF)", result);
  }

  console.log("\n\n=== A* Benchmark: componentPdb ON (no interaction boost) ===");
  {
    const request = makeRequest(HUGE.rows, timeoutMs);
    const { context } = makeContext(timeoutMs + 5000);
    const result = await runExactMoveAStar(request, context, {
      features: { ...baseFeatures, componentPdb: true },
    });
    printResult("A* with componentPdb ON", result);
  }
}

// -----------------------------------------------------------------------
// IDA* benchmark
// -----------------------------------------------------------------------

async function runIdaBenchmark(): Promise<void> {
  const timeoutMs = 120_000;
  const baseFeatures = {
    backwardPerimeter: false,
    interactionBoost: false,
  };

  console.log("\n\n=== IDA* Benchmark: componentPdb OFF (no interaction boost) ===");
  {
    const request = makeRequest(HUGE.rows, timeoutMs);
    const { context } = makeContext(timeoutMs + 5000);
    const result = await runIdaStarSearch(request, context, {
      features: { ...baseFeatures, componentPdb: false },
    });
    printResult("IDA* baseline (componentPdb OFF)", result);
  }

  console.log("\n\n=== IDA* Benchmark: componentPdb ON (no interaction boost) ===");
  {
    const request = makeRequest(HUGE.rows, timeoutMs);
    const { context } = makeContext(timeoutMs + 5000);
    const result = await runIdaStarSearch(request, context, {
      features: { ...baseFeatures, componentPdb: true },
    });
    printResult("IDA* with componentPdb ON", result);
  }
}

// -----------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------

async function main(): Promise<void> {
  await runStructuralDiagnostic();
  await runAStarBenchmark();
  await runIdaBenchmark();
  console.log("\n\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
