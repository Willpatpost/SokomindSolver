import assert from "node:assert/strict";
import test from "node:test";

import {
  generateBlueprintWithRetry,
  rasterizeBlueprint,
  computeDiagnostics,
  blueprintToAscii,
  DEFAULT_BLUEPRINT_PARAMS,
  TOPOLOGY_FAMILIES,
  type BlueprintParams,
  type StructuralBlueprint,
  type TopologyFamily,
} from "../../src/features/generator/v2/index.ts";
import { floodFill } from "../../src/features/generator/board-template.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParams(overrides: Partial<BlueprintParams> = {}): BlueprintParams {
  return { ...DEFAULT_BLUEPRINT_PARAMS, ...overrides };
}

function requireBlueprint(params: BlueprintParams): StructuralBlueprint {
  const bp = generateBlueprintWithRetry(params, 50);
  assert.ok(bp !== null, `Failed to generate blueprint with seed ${params.seed}`);
  return bp!;
}

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test("blueprint: same seed produces identical blueprint", () => {
  const params = makeParams({ seed: 42, family: "linear" });
  const a = requireBlueprint(params);
  const b = requireBlueprint(params);
  assert.deepStrictEqual(a, b);
});

test("blueprint: same seed produces identical grid", () => {
  const params = makeParams({ seed: 42, family: "linear" });
  const a = requireBlueprint(params);
  const b = requireBlueprint(params);
  const gridA = rasterizeBlueprint(a);
  const gridB = rasterizeBlueprint(b);
  assert.deepStrictEqual(gridA, gridB);
});

test("blueprint: different seeds produce different blueprints", () => {
  const a = requireBlueprint(makeParams({ seed: 100, family: "linear" }));
  const b = requireBlueprint(makeParams({ seed: 200, family: "linear" }));
  const asciiA = blueprintToAscii(a);
  const asciiB = blueprintToAscii(b);
  assert.notEqual(asciiA, asciiB);
});

// ---------------------------------------------------------------------------
// Floor connectivity
// ---------------------------------------------------------------------------

test("blueprint: all floor cells are connected", () => {
  for (const family of TOPOLOGY_FAMILIES) {
    for (let seed = 0; seed < 10; seed++) {
      const params = makeParams({
        seed: seed * 1000 + 1,
        family,
        boardWidth: 16,
        boardHeight: 16,
      });
      const bp = generateBlueprintWithRetry(params, 30);
      if (!bp) continue;

      const grid = rasterizeBlueprint(bp);
      let firstFloor: { row: number; column: number } | undefined;
      let totalFloor = 0;

      for (let r = 0; r < grid.length; r++) {
        for (let c = 0; c < grid[r].length; c++) {
          if (grid[r][c] === " ") {
            totalFloor++;
            if (!firstFloor) firstFloor = { row: r, column: c };
          }
        }
      }

      assert.ok(firstFloor, `no floor cells for ${family} seed ${seed}`);
      const component = floodFill(grid, firstFloor!);
      assert.equal(
        component.size,
        totalFloor,
        `disconnected floor for ${family} seed=${params.seed}: ` +
          `component=${component.size} total=${totalFloor}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Border containment
// ---------------------------------------------------------------------------

test("blueprint: border cells are all walls", () => {
  const bp = requireBlueprint(
    makeParams({ seed: 77, family: "hub", boardWidth: 14, boardHeight: 14 }),
  );
  const grid = rasterizeBlueprint(bp);
  const w = grid[0].length;
  const h = grid.length;

  for (let c = 0; c < w; c++) {
    assert.equal(grid[0][c], "O", `top border [0,${c}]`);
    assert.equal(grid[h - 1][c], "O", `bottom border [${h - 1},${c}]`);
  }
  for (let r = 0; r < h; r++) {
    assert.equal(grid[r][0], "O", `left border [${r},0]`);
    assert.equal(grid[r][w - 1], "O", `right border [${r},${w - 1}]`);
  }
});

// ---------------------------------------------------------------------------
// Board dimensions
// ---------------------------------------------------------------------------

test("blueprint: grid matches requested dimensions", () => {
  const bp = requireBlueprint(
    makeParams({ seed: 55, family: "linear", boardWidth: 10, boardHeight: 12 }),
  );
  const grid = rasterizeBlueprint(bp);
  assert.equal(grid.length, 12);
  assert.equal(grid[0].length, 10);
});

// ---------------------------------------------------------------------------
// Room count
// ---------------------------------------------------------------------------

test("blueprint: room count matches graph", () => {
  for (const family of TOPOLOGY_FAMILIES) {
    const bp = requireBlueprint(
      makeParams({
        seed: 333,
        family,
        boardWidth: 18,
        boardHeight: 18,
        minRoomSize: 3,
        maxRoomSize: 4,
      }),
    );
    assert.ok(
      bp.rooms.length >= 2,
      `${family}: expected >= 2 rooms, got ${bp.rooms.length}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Topology families produce distinct structures
// ---------------------------------------------------------------------------

test("blueprint: topology families produce structurally distinct outputs", () => {
  const diagnosticsMap = new Map<TopologyFamily, string>();
  for (const family of TOPOLOGY_FAMILIES) {
    const bp = generateBlueprintWithRetry(
      makeParams({
        seed: 500,
        family,
        boardWidth: 18,
        boardHeight: 18,
        minRoomSize: 3,
        maxRoomSize: 4,
      }),
      30,
    );
    if (!bp) continue;
    const d = computeDiagnostics(bp);
    const sig = `r${d.roomCount}p${d.passageCount}d${[...d.connectivityDegrees].sort().join(",")}`;
    diagnosticsMap.set(family, sig);
  }

  const uniqueSigs = new Set(diagnosticsMap.values());
  assert.ok(
    uniqueSigs.size >= 3,
    `Expected at least 3 distinct topology signatures, got ${uniqueSigs.size}: ` +
      JSON.stringify([...diagnosticsMap.entries()]),
  );
});

// ---------------------------------------------------------------------------
// Passage existence
// ---------------------------------------------------------------------------

test("blueprint: passages connect rooms", () => {
  const bp = requireBlueprint(
    makeParams({
      seed: 888,
      family: "linear",
      boardWidth: 16,
      boardHeight: 16,
      minRoomSize: 3,
      maxRoomSize: 4,
    }),
  );
  assert.ok(bp.passages.length >= 1, "linear blueprint should have passages");
  for (const passage of bp.passages) {
    const fromRoom = bp.rooms.find((r) => r.id === passage.from);
    const toRoom = bp.rooms.find((r) => r.id === passage.to);
    assert.ok(fromRoom, `passage from room ${passage.from} not found`);
    assert.ok(toRoom, `passage to room ${passage.to} not found`);
  }
});

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

test("diagnostics: room count matches blueprint", () => {
  const bp = requireBlueprint(
    makeParams({ seed: 111, family: "hub", boardWidth: 18, boardHeight: 18 }),
  );
  const d = computeDiagnostics(bp);
  assert.equal(d.roomCount, bp.rooms.length);
  assert.equal(d.passageCount, bp.passages.length);
  assert.equal(d.family, bp.family);
  assert.equal(d.seed, bp.seed);
});

test("diagnostics: total floor > 0", () => {
  const bp = requireBlueprint(
    makeParams({ seed: 222, family: "linear", boardWidth: 14, boardHeight: 14 }),
  );
  const d = computeDiagnostics(bp);
  assert.ok(d.totalFloor > 0, "should have floor cells");
});

test("diagnostics: largest room ratio <= 1", () => {
  const bp = requireBlueprint(
    makeParams({ seed: 444, family: "branch", boardWidth: 16, boardHeight: 16 }),
  );
  const d = computeDiagnostics(bp);
  assert.ok(d.largestRoomRatio > 0, "should have positive room ratio");
  assert.ok(d.largestRoomRatio <= 1, "room ratio should not exceed 1");
});

test("diagnostics: connectivity degrees sum to 2 * passage count", () => {
  const bp = requireBlueprint(
    makeParams({ seed: 555, family: "loop", boardWidth: 18, boardHeight: 18 }),
  );
  const d = computeDiagnostics(bp);
  const degreeSum = d.connectivityDegrees.reduce((a, b) => a + b, 0);
  assert.equal(
    degreeSum,
    2 * d.passageCount,
    `degree sum ${degreeSum} !== 2 * ${d.passageCount}`,
  );
});

// ---------------------------------------------------------------------------
// blueprintToAscii
// ---------------------------------------------------------------------------

test("blueprintToAscii: output has correct line count", () => {
  const bp = requireBlueprint(
    makeParams({
      seed: 666,
      family: "linear",
      boardWidth: 14,
      boardHeight: 12,
      minRooms: 2,
      maxRooms: 2,
      minRoomSize: 3,
      maxRoomSize: 3,
    }),
  );
  const ascii = blueprintToAscii(bp);
  const lines = ascii.split("\n");
  assert.equal(lines.length, 12);
  assert.equal(lines[0].length, 14);
});

// ---------------------------------------------------------------------------
// generateBlueprintWithRetry
// ---------------------------------------------------------------------------

test("generateBlueprintWithRetry: returns null when impossible", () => {
  const result = generateBlueprintWithRetry(
    makeParams({
      seed: 999,
      family: "hub",
      boardWidth: 6,
      boardHeight: 6,
      minRooms: 5,
      maxRooms: 5,
      minRoomSize: 4,
      maxRoomSize: 4,
    }),
    5,
  );
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// Linear family
// ---------------------------------------------------------------------------

test("linear: has N-1 passages for N rooms", () => {
  const bp = requireBlueprint(
    makeParams({
      seed: 1001,
      family: "linear",
      boardWidth: 20,
      boardHeight: 14,
      minRoomSize: 3,
      maxRoomSize: 4,
    }),
  );
  assert.equal(bp.passages.length, bp.rooms.length - 1);
});

// ---------------------------------------------------------------------------
// Hub family
// ---------------------------------------------------------------------------

test("hub: one room has degree >= 3", () => {
  const bp = requireBlueprint(
    makeParams({
      seed: 2001,
      family: "hub",
      boardWidth: 20,
      boardHeight: 20,
      minRooms: 4,
      maxRooms: 5,
      minRoomSize: 3,
      maxRoomSize: 4,
    }),
  );
  const d = computeDiagnostics(bp);
  const maxDegree = Math.max(...d.connectivityDegrees);
  assert.ok(maxDegree >= 3, `hub should have a room with degree >= 3, got ${maxDegree}`);
});

// ---------------------------------------------------------------------------
// Loop family
// ---------------------------------------------------------------------------

test("loop: passage count equals room count", () => {
  const bp = requireBlueprint(
    makeParams({
      seed: 3001,
      family: "loop",
      boardWidth: 20,
      boardHeight: 20,
      minRooms: 4,
      maxRooms: 4,
      minRoomSize: 3,
      maxRoomSize: 4,
    }),
  );
  assert.equal(
    bp.passages.length,
    bp.rooms.length,
    `loop should have exactly ${bp.rooms.length} passages`,
  );
});

// ---------------------------------------------------------------------------
// rasterizeBlueprint is idempotent
// ---------------------------------------------------------------------------

test("rasterizeBlueprint: idempotent", () => {
  const bp = requireBlueprint(
    makeParams({ seed: 7777, family: "branch", boardWidth: 14, boardHeight: 14 }),
  );
  const gridA = rasterizeBlueprint(bp);
  const gridB = rasterizeBlueprint(bp);
  assert.deepStrictEqual(gridA, gridB);
});

// ---------------------------------------------------------------------------
// Seeded property: multiple seeds across families
// ---------------------------------------------------------------------------

test("blueprint: 20 seeds across families all produce valid connected grids", () => {
  let successes = 0;
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
      let firstFloor: { row: number; column: number } | undefined;
      let totalFloor = 0;

      for (let r = 0; r < grid.length; r++) {
        for (let c = 0; c < grid[r].length; c++) {
          if (grid[r][c] === " ") {
            totalFloor++;
            if (!firstFloor) firstFloor = { row: r, column: c };
          }
        }
      }

      if (!firstFloor) continue;
      const component = floodFill(grid, firstFloor!);
      assert.equal(
        component.size,
        totalFloor,
        `disconnected: ${family} seed=${seed}`,
      );
      successes++;
    }
  }
  assert.ok(successes >= 15, `Expected >= 15 valid blueprints, got ${successes}`);
});
