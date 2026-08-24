import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  analyzeGrid,
  analyzeBlueprintFidelity,
  parseRowsToGrid,
  generateBlueprintWithRetry,
  rasterizeBlueprint,
  DEFAULT_BLUEPRINT_PARAMS,
  TOPOLOGY_FAMILIES,
  type BlueprintParams,
  type StructuralMetrics,
} from "../../src/features/generator/v2/index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParams(overrides: Partial<BlueprintParams> = {}): BlueprintParams {
  return { ...DEFAULT_BLUEPRINT_PARAMS, ...overrides };
}

interface PuzzleDef {
  id: string;
  rows: string[];
  difficulty: string;
  boxes: number;
}

function loadCatalog(): PuzzleDef[] {
  const dir = join(
    import.meta.dirname!,
    "../../src/catalog/puzzle-shards",
  );
  const files = readdirSync(dir).filter((f: string) => f.endsWith(".json"));
  const puzzles: PuzzleDef[] = [];
  for (const f of files) {
    const data = JSON.parse(readFileSync(join(dir, f), "utf-8"));
    for (const p of data) {
      puzzles.push(p);
    }
  }
  return puzzles;
}

interface MetricsSummary {
  count: number;
  avgFloorUtilization: number;
  avgOpenAreaRatio: number;
  avgArticulations: number;
  avgRegions: number;
  avgTunnels: number;
  avgChokepoints: number;
  avgTerminalRegions: number;
  cycleRate: number;
  avgLargestRegionRatio: number;
}

function summarize(metrics: StructuralMetrics[]): MetricsSummary {
  const n = metrics.length;
  if (n === 0) {
    return {
      count: 0,
      avgFloorUtilization: 0,
      avgOpenAreaRatio: 0,
      avgArticulations: 0,
      avgRegions: 0,
      avgTunnels: 0,
      avgChokepoints: 0,
      avgTerminalRegions: 0,
      cycleRate: 0,
      avgLargestRegionRatio: 0,
    };
  }
  return {
    count: n,
    avgFloorUtilization: metrics.reduce((s, m) => s + m.floorUtilization, 0) / n,
    avgOpenAreaRatio: metrics.reduce((s, m) => s + m.openAreaRatio, 0) / n,
    avgArticulations: metrics.reduce((s, m) => s + m.articulationCount, 0) / n,
    avgRegions: metrics.reduce((s, m) => s + m.regionCount, 0) / n,
    avgTunnels: metrics.reduce((s, m) => s + m.tunnelCount, 0) / n,
    avgChokepoints: metrics.reduce((s, m) => s + m.chokepointCount, 0) / n,
    avgTerminalRegions: metrics.reduce((s, m) => s + m.terminalRegionCount, 0) / n,
    cycleRate: metrics.filter((m) => m.hasCycle).length / n,
    avgLargestRegionRatio: metrics.reduce((s, m) => s + m.largestRegionRatio, 0) / n,
  };
}

function fmt(n: number): string {
  return n.toFixed(3);
}

function printSummary(label: string, s: MetricsSummary): void {
  console.log(`\n  ${label} (n=${s.count}):`);
  console.log(`    Floor utilization:   ${fmt(s.avgFloorUtilization)}`);
  console.log(`    Open area ratio:     ${fmt(s.avgOpenAreaRatio)}`);
  console.log(`    Articulation pts:    ${fmt(s.avgArticulations)}`);
  console.log(`    Detected regions:    ${fmt(s.avgRegions)}`);
  console.log(`    Tunnel cells:        ${fmt(s.avgTunnels)}`);
  console.log(`    Chokepoints:         ${fmt(s.avgChokepoints)}`);
  console.log(`    Terminal regions:    ${fmt(s.avgTerminalRegions)}`);
  console.log(`    Cycle rate:          ${fmt(s.cycleRate)}`);
  console.log(`    Largest region ratio:${fmt(s.avgLargestRegionRatio)}`);
}

// ---------------------------------------------------------------------------
// Benchmark test
// ---------------------------------------------------------------------------

test("benchmark: structural metrics across V1, V2, and handcrafted puzzles", () => {
  const catalog = loadCatalog();
  const handcrafted = catalog.filter((p) => !p.id.startsWith("gen-"));
  const v1Generated = catalog.filter((p) => p.id.startsWith("gen-"));

  // Analyze handcrafted puzzles (all 32)
  const handMetrics: StructuralMetrics[] = [];
  for (const p of handcrafted) {
    const grid = parseRowsToGrid(p.rows);
    handMetrics.push(analyzeGrid(grid));
  }

  // Analyze V1 generated puzzles (sample up to 100)
  const v1Sample = v1Generated.slice(0, 100);
  const v1Metrics: StructuralMetrics[] = [];
  for (const p of v1Sample) {
    const grid = parseRowsToGrid(p.rows);
    v1Metrics.push(analyzeGrid(grid));
  }

  // Generate V2 blueprints across all families (20 boards)
  const v2Metrics: StructuralMetrics[] = [];
  for (const family of TOPOLOGY_FAMILIES) {
    for (let seed = 0; seed < 4; seed++) {
      const bp = generateBlueprintWithRetry(
        makeParams({
          seed: seed * 7919 + 17,
          family,
          boardWidth: 16,
          boardHeight: 16,
          minRoomSize: 3,
          maxRoomSize: 4,
        }),
        30,
      );
      if (!bp) continue;
      const grid = rasterizeBlueprint(bp);
      v2Metrics.push(analyzeGrid(grid));
    }
  }

  const handSummary = summarize(handMetrics);
  const v1Summary = summarize(v1Metrics);
  const v2Summary = summarize(v2Metrics);

  console.log("\n=== Structural Metrics Benchmark ===");
  printSummary("Handcrafted", handSummary);
  printSummary("V1 Generated (cellular automata)", v1Summary);
  printSummary("V2 Blueprint (structure-first)", v2Summary);

  // V2 boards should have more articulation points than a big open room
  assert.ok(v2Summary.avgArticulations > 0, "V2 should have articulation points");

  // V2 boards should have detected regions
  assert.ok(v2Summary.avgRegions > 0, "V2 should have detected regions");

  // V2 should be single-component
  for (const m of v2Metrics) {
    assert.equal(m.connectedComponents, 1, "V2 boards should be connected");
  }

  // All boards should have valid metrics
  for (const m of [...handMetrics, ...v1Metrics, ...v2Metrics]) {
    assert.ok(m.floorUtilization >= 0 && m.floorUtilization <= 1);
    assert.ok(m.openAreaRatio >= 0 && m.openAreaRatio <= 1);
    assert.ok(m.articulationCount >= 0);
  }
});

// ---------------------------------------------------------------------------
// Per-family V2 breakdown
// ---------------------------------------------------------------------------

test("benchmark: per-family V2 structural profiles", () => {
  console.log("\n=== Per-Family V2 Profiles ===");

  for (const family of TOPOLOGY_FAMILIES) {
    const familyMetrics: StructuralMetrics[] = [];
    for (let seed = 0; seed < 8; seed++) {
      const bp = generateBlueprintWithRetry(
        makeParams({
          seed: seed * 3571 + 13,
          family,
          boardWidth: 18,
          boardHeight: 18,
          minRoomSize: 3,
          maxRoomSize: 4,
        }),
        30,
      );
      if (!bp) continue;
      const grid = rasterizeBlueprint(bp);
      familyMetrics.push(analyzeGrid(grid));
    }
    printSummary(`V2 ${family}`, summarize(familyMetrics));
  }
});

// ---------------------------------------------------------------------------
// Blueprint fidelity across V2 families
// ---------------------------------------------------------------------------

test("benchmark: V2 blueprint fidelity", () => {
  console.log("\n=== V2 Blueprint Fidelity ===");

  let totalIntended = 0;
  let totalDetected = 0;
  let totalMerged = 0;
  let totalShortcuts = 0;
  const passageLengths: number[] = [];
  let count = 0;

  for (const family of TOPOLOGY_FAMILIES) {
    for (let seed = 0; seed < 6; seed++) {
      const bp = generateBlueprintWithRetry(
        makeParams({
          seed: seed * 4999 + 7,
          family,
          boardWidth: 18,
          boardHeight: 18,
          minRoomSize: 3,
          maxRoomSize: 4,
        }),
        30,
      );
      if (!bp) continue;

      const grid = rasterizeBlueprint(bp);
      const m = analyzeGrid(grid);
      const f = analyzeBlueprintFidelity(bp, m);

      totalIntended += f.intendedRoomCount;
      totalDetected += f.detectedRegionCount;
      totalMerged += f.mergedRooms;
      totalShortcuts += f.unintendedShortcuts;
      passageLengths.push(...f.passageLengths);
      count++;
    }
  }

  const avgPassageLength =
    passageLengths.length > 0
      ? passageLengths.reduce((a, b) => a + b, 0) / passageLengths.length
      : 0;

  console.log(`\n  Fidelity across ${count} V2 boards:`);
  console.log(`    Total intended rooms:    ${totalIntended}`);
  console.log(`    Total detected regions:  ${totalDetected}`);
  console.log(`    Total merged rooms:      ${totalMerged}`);
  console.log(`    Unintended shortcuts:    ${totalShortcuts}`);
  console.log(`    Avg passage length:      ${fmt(avgPassageLength)}`);
  console.log(
    `    Passage length range:    ${Math.min(...passageLengths)}–${Math.max(...passageLengths)}`,
  );
});
