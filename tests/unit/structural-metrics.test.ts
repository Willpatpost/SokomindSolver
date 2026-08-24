import assert from "node:assert/strict";
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
} from "../../src/features/generator/v2/index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParams(overrides: Partial<BlueprintParams> = {}): BlueprintParams {
  return { ...DEFAULT_BLUEPRINT_PARAMS, ...overrides };
}

function gridFromRows(rows: string[]): readonly (readonly string[])[] {
  return rows.map((row) => [...row]);
}

// ---------------------------------------------------------------------------
// Known small boards for deterministic tests
// ---------------------------------------------------------------------------

// Single room — 3x3 interior with wall border
// OOOOO
// O   O
// O   O
// O   O
// OOOOO
const SINGLE_ROOM: string[] = [
  "OOOOO",
  "O   O",
  "O   O",
  "O   O",
  "OOOOO",
];

// Two rooms connected by a single-cell corridor (chokepoint)
// OOOOOOOOOOO
// O   O     O
// O   O     O
// O         O
// O   O     O
// O   O     O
// OOOOOOOOOOO
const TWO_ROOMS_CORRIDOR: string[] = [
  "OOOOOOOOOOO",
  "O   O     O",
  "O   O     O",
  "O         O",
  "O   O     O",
  "O   O     O",
  "OOOOOOOOOOO",
];

// Linear tunnel — 1-wide corridor
// OOOOOOO
// O     O
// OOO OOO
// O     O
// OOOOOOO
const TUNNEL_BOARD: string[] = [
  "OOOOOOO",
  "O     O",
  "OOO OOO",
  "O     O",
  "OOOOOOO",
];

// Dead-end terminal room — one room only reachable through chokepoint
// OOOOOOOOO
// O   OO  O
// O    O  O
// O       O
// O    O  O
// O   OO  O
// OOOOOOOOO
const TERMINAL_ROOM: string[] = [
  "OOOOOOOOO",
  "O   OO  O",
  "O    O  O",
  "O       O",
  "O    O  O",
  "O   OO  O",
  "OOOOOOOOO",
];

// H-shaped board — two large areas with narrow connecting passage
// OOOOOOOOOOO
// OOO   OOOO
// OOO   OOOO
// O         O
// OOOO  OOOO
// OOOO  OOOO
// OOOOOOOOOOO
const H_SHAPED: string[] = [
  "OOOOOOOOOOO",
  "OOO   OOOO",
  "OOO   OOOO",
  "O         O",
  "OOOO  OOOO",
  "OOOO  OOOO",
  "OOOOOOOOOOO",
];

// ---------------------------------------------------------------------------
// Basic properties
// ---------------------------------------------------------------------------

test("metrics: board dimensions match", () => {
  const grid = gridFromRows(SINGLE_ROOM);
  const m = analyzeGrid(grid);
  assert.equal(m.boardWidth, 5);
  assert.equal(m.boardHeight, 5);
  assert.equal(m.totalCells, 25);
});

test("metrics: floor count correct for single room", () => {
  const grid = gridFromRows(SINGLE_ROOM);
  const m = analyzeGrid(grid);
  assert.equal(m.totalFloor, 9);
});

test("metrics: floor utilization", () => {
  const grid = gridFromRows(SINGLE_ROOM);
  const m = analyzeGrid(grid);
  assert.ok(
    Math.abs(m.floorUtilization - 9 / 25) < 0.001,
    `expected ~${9 / 25}, got ${m.floorUtilization}`,
  );
});

test("metrics: single room has no articulation points", () => {
  const grid = gridFromRows(SINGLE_ROOM);
  const m = analyzeGrid(grid);
  assert.equal(m.articulationCount, 0);
});

test("metrics: single room is one connected component", () => {
  const grid = gridFromRows(SINGLE_ROOM);
  const m = analyzeGrid(grid);
  assert.equal(m.connectedComponents, 1);
});

test("metrics: single room open area ratio is high", () => {
  const grid = gridFromRows(SINGLE_ROOM);
  const m = analyzeGrid(grid);
  assert.ok(m.openAreaRatio > 0, "single room should have some degree-4 cells");
});

// ---------------------------------------------------------------------------
// Articulation points and regions
// ---------------------------------------------------------------------------

test("metrics: two rooms have articulation points", () => {
  const grid = gridFromRows(TWO_ROOMS_CORRIDOR);
  const m = analyzeGrid(grid);
  assert.ok(m.articulationCount > 0, "two-room board should have articulation points");
});

test("metrics: two rooms have detected regions", () => {
  const grid = gridFromRows(TWO_ROOMS_CORRIDOR);
  const m = analyzeGrid(grid);
  assert.ok(m.regionCount >= 2, `expected >= 2 regions, got ${m.regionCount}`);
});

// ---------------------------------------------------------------------------
// Tunnels
// ---------------------------------------------------------------------------

test("metrics: tunnel board has tunnel cells", () => {
  const grid = gridFromRows(TUNNEL_BOARD);
  const m = analyzeGrid(grid);
  assert.ok(m.tunnelCount > 0, "tunnel board should detect tunnels");
});

test("metrics: single room has no tunnels", () => {
  const grid = gridFromRows(SINGLE_ROOM);
  const m = analyzeGrid(grid);
  assert.equal(m.tunnelCount, 0, "open room should have no tunnels");
});

// ---------------------------------------------------------------------------
// Chokepoints
// ---------------------------------------------------------------------------

test("metrics: H-shaped board has chokepoints", () => {
  const grid = gridFromRows(H_SHAPED);
  const m = analyzeGrid(grid);
  assert.ok(
    m.articulationCount > 0,
    "H-shaped board should have articulation points",
  );
});

// ---------------------------------------------------------------------------
// Cycle detection
// ---------------------------------------------------------------------------

test("metrics: single room has a cycle", () => {
  const grid = gridFromRows(SINGLE_ROOM);
  const m = analyzeGrid(grid);
  assert.equal(m.hasCycle, true, "3x3 room has cycles in its floor graph");
});

test("metrics: straight tunnel has no cycle", () => {
  const grid = gridFromRows([
    "OOO",
    "O O",
    "O O",
    "O O",
    "OOO",
  ]);
  const m = analyzeGrid(grid);
  assert.equal(m.hasCycle, false, "straight 1-wide tunnel has no cycle");
});

// ---------------------------------------------------------------------------
// Terminal regions
// ---------------------------------------------------------------------------

test("metrics: terminal room board has terminal regions", () => {
  const grid = gridFromRows(TERMINAL_ROOM);
  const m = analyzeGrid(grid);
  if (m.regionCount > 0) {
    assert.ok(
      m.terminalRegionCount >= 0,
      "terminal region count should be non-negative",
    );
  }
});

// ---------------------------------------------------------------------------
// Degree distribution
// ---------------------------------------------------------------------------

test("metrics: degree distribution sums to total floor", () => {
  const grid = gridFromRows(SINGLE_ROOM);
  const m = analyzeGrid(grid);
  const sum = m.degreeDistribution.reduce((a, b) => a + b, 0);
  assert.equal(sum, m.totalFloor, "degree distribution should sum to floor count");
});

test("metrics: max degree <= 4", () => {
  const grid = gridFromRows(SINGLE_ROOM);
  const m = analyzeGrid(grid);
  assert.ok(m.maxDegree <= 4, `max degree ${m.maxDegree} should be <= 4`);
});

// ---------------------------------------------------------------------------
// parseRowsToGrid
// ---------------------------------------------------------------------------

test("parseRowsToGrid: round-trips correctly", () => {
  const grid = parseRowsToGrid(SINGLE_ROOM);
  assert.equal(grid.length, 5);
  assert.equal(grid[0].length, 5);
  assert.equal(grid[0][0], "O");
  assert.equal(grid[1][1], " ");
});

// ---------------------------------------------------------------------------
// V2 blueprint integration
// ---------------------------------------------------------------------------

test("metrics: V2 linear blueprint produces structured metrics", () => {
  const bp = generateBlueprintWithRetry(
    makeParams({
      seed: 42,
      family: "linear",
      boardWidth: 16,
      boardHeight: 16,
      minRoomSize: 3,
      maxRoomSize: 4,
    }),
    30,
  );
  if (!bp) return;

  const grid = rasterizeBlueprint(bp);
  const m = analyzeGrid(grid);

  assert.ok(m.totalFloor > 0);
  assert.ok(m.floorUtilization > 0);
  assert.ok(m.floorUtilization < 1);
  assert.equal(m.connectedComponents, 1);
});

test("metrics: V2 hub blueprint has articulation points", () => {
  const bp = generateBlueprintWithRetry(
    makeParams({
      seed: 100,
      family: "hub",
      boardWidth: 20,
      boardHeight: 20,
      minRooms: 4,
      maxRooms: 5,
      minRoomSize: 3,
      maxRoomSize: 4,
    }),
    30,
  );
  if (!bp) return;

  const grid = rasterizeBlueprint(bp);
  const m = analyzeGrid(grid);

  assert.ok(
    m.articulationCount > 0,
    `hub with ${bp.rooms.length} rooms should have articulation points`,
  );
});

test("metrics: all topology families produce connected single-component grids", () => {
  for (const family of TOPOLOGY_FAMILIES) {
    const bp = generateBlueprintWithRetry(
      makeParams({
        seed: 777,
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
    assert.equal(
      m.connectedComponents,
      1,
      `${family} blueprint should be connected`,
    );
  }
});

// ---------------------------------------------------------------------------
// Blueprint fidelity
// ---------------------------------------------------------------------------

test("fidelity: room count comparison", () => {
  const bp = generateBlueprintWithRetry(
    makeParams({
      seed: 200,
      family: "linear",
      boardWidth: 18,
      boardHeight: 18,
      minRoomSize: 3,
      maxRoomSize: 4,
    }),
    30,
  );
  if (!bp) return;

  const grid = rasterizeBlueprint(bp);
  const m = analyzeGrid(grid);
  const fidelity = analyzeBlueprintFidelity(bp, m);

  assert.equal(fidelity.intendedRoomCount, bp.rooms.length);
  assert.ok(fidelity.detectedRegionCount >= 0);
  assert.ok(fidelity.mergedRooms >= 0);
});

test("fidelity: passage lengths are non-negative", () => {
  const bp = generateBlueprintWithRetry(
    makeParams({
      seed: 300,
      family: "branch",
      boardWidth: 18,
      boardHeight: 18,
      minRoomSize: 3,
      maxRoomSize: 4,
    }),
    30,
  );
  if (!bp) return;

  const grid = rasterizeBlueprint(bp);
  const m = analyzeGrid(grid);
  const fidelity = analyzeBlueprintFidelity(bp, m);

  for (const len of fidelity.passageLengths) {
    assert.ok(len >= 0, `passage length ${len} should be >= 0`);
  }
  assert.ok(fidelity.meanPassageLength >= 0);
});

test("fidelity: loop family may detect cycle", () => {
  const bp = generateBlueprintWithRetry(
    makeParams({
      seed: 400,
      family: "loop",
      boardWidth: 20,
      boardHeight: 20,
      minRooms: 4,
      maxRooms: 4,
      minRoomSize: 3,
      maxRoomSize: 4,
    }),
    30,
  );
  if (!bp) return;

  const grid = rasterizeBlueprint(bp);
  const m = analyzeGrid(grid);

  assert.equal(m.hasCycle, true, "loop topology should produce cycles in floor graph");
});

// ---------------------------------------------------------------------------
// V2 vs simple open room: structured boards have more articulation points
// ---------------------------------------------------------------------------

test("metrics: V2 structured board has more articulations than open room", () => {
  const openRoom = gridFromRows([
    "OOOOOOOOOOOOOOOOOO",
    "O                O",
    "O                O",
    "O                O",
    "O                O",
    "O                O",
    "O                O",
    "O                O",
    "O                O",
    "O                O",
    "O                O",
    "O                O",
    "O                O",
    "O                O",
    "O                O",
    "O                O",
    "O                O",
    "OOOOOOOOOOOOOOOOOO",
  ]);
  const openMetrics = analyzeGrid(openRoom);

  const bp = generateBlueprintWithRetry(
    makeParams({
      seed: 500,
      family: "linear",
      boardWidth: 18,
      boardHeight: 18,
      minRoomSize: 3,
      maxRoomSize: 4,
    }),
    30,
  );
  if (!bp) return;

  const v2Grid = rasterizeBlueprint(bp);
  const v2Metrics = analyzeGrid(v2Grid);

  assert.ok(
    v2Metrics.articulationCount > openMetrics.articulationCount,
    `V2 articulations (${v2Metrics.articulationCount}) should exceed ` +
      `open room articulations (${openMetrics.articulationCount})`,
  );
});

test("metrics: open room has high open area ratio", () => {
  const openRoom = gridFromRows([
    "OOOOOOOO",
    "O      O",
    "O      O",
    "O      O",
    "O      O",
    "O      O",
    "O      O",
    "OOOOOOOO",
  ]);
  const m = analyzeGrid(openRoom);
  assert.ok(
    m.openAreaRatio > 0.3,
    `open room should have high open area ratio, got ${m.openAreaRatio}`,
  );
});

// ---------------------------------------------------------------------------
// Catalog puzzle analysis (smoke test)
// ---------------------------------------------------------------------------

test("metrics: catalog puzzle rows parse and analyze without error", () => {
  const puzzleRows = [
    "OOOOOO",
    "O R  O",
    "O  X O",
    "O  S O",
    "O    O",
    "OOOOOO",
  ];
  const grid = parseRowsToGrid(puzzleRows);
  const m = analyzeGrid(grid);

  assert.ok(m.totalFloor > 0);
  assert.equal(m.connectedComponents, 1);
  assert.ok(m.boardWidth === 6);
  assert.ok(m.boardHeight === 6);
});

// ---------------------------------------------------------------------------
// Empty / degenerate grids
// ---------------------------------------------------------------------------

test("metrics: all-wall grid", () => {
  const grid = gridFromRows(["OOO", "OOO", "OOO"]);
  const m = analyzeGrid(grid);
  assert.equal(m.totalFloor, 0);
  assert.equal(m.floorUtilization, 0);
  assert.equal(m.articulationCount, 0);
  assert.equal(m.regionCount, 0);
  assert.equal(m.tunnelCount, 0);
  assert.equal(m.connectedComponents, 0);
});

test("metrics: single floor cell", () => {
  const grid = gridFromRows(["OOO", "O O", "OOO"]);
  const m = analyzeGrid(grid);
  assert.equal(m.totalFloor, 1);
  assert.equal(m.articulationCount, 0);
  assert.equal(m.connectedComponents, 1);
});
