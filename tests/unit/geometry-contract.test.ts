import assert from "node:assert/strict";
import test from "node:test";

import type { GeometryProfile } from "../../src/features/generator/v2/blueprint-types.ts";
import {
  validateBlueprintGeometry,
  validateFinalGeometry,
} from "../../src/features/generator/v2/puzzle-forge.ts";
import {
  generateBlueprintWithRetry,
  tightenPuzzle,
  DEFAULT_BLUEPRINT_PARAMS,
  type BlueprintParams,
} from "../../src/features/generator/v2/index.ts";
import { rasterizeBlueprint } from "../../src/features/generator/v2/blueprint-graph.ts";
import type { PuzzleDefinition } from "../../src/core/model.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProfile(overrides: Partial<GeometryProfile> = {}): GeometryProfile {
  return {
    boardWidthRange: [4, 30],
    boardHeightRange: [4, 30],
    minRooms: 1,
    maxRooms: 20,
    minRoomSize: 3,
    maxRoomSize: 6,
    passageWidths: [1],
    minPlayableFloor: 1,
    minFloorCoverage: 0.01,
    minRegions: 0,
    minChokepoints: 0,
    ...overrides,
  };
}

function makeSmallBoard(): readonly string[] {
  return [
    "OOOOOOOO",
    "O......O",
    "O......O",
    "O......O",
    "O......O",
    "O......O",
    "O......O",
    "OOOOOOOO",
  ];
}

function makeTinyBoard(): readonly string[] {
  return [
    "OOOOO",
    "O...O",
    "O...O",
    "OOOOO",
  ];
}

// ---------------------------------------------------------------------------
// Test A: minPlayableFloor enforced
// ---------------------------------------------------------------------------

test("geometry contract: minPlayableFloor rejects boards with too little floor", () => {
  const profile = makeProfile({ minPlayableFloor: 50 });
  const result = validateFinalGeometry(makeTinyBoard(), profile);
  assert.equal(result, "geometry-floor-min");
});

test("geometry contract: minPlayableFloor passes boards with enough floor", () => {
  const profile = makeProfile({ minPlayableFloor: 5 });
  const result = validateFinalGeometry(makeTinyBoard(), profile);
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// Test B: maxPlayableFloor enforced
// ---------------------------------------------------------------------------

test("geometry contract: maxPlayableFloor rejects boards with too much floor", () => {
  const profile = makeProfile({ maxPlayableFloor: 5 });
  const result = validateFinalGeometry(makeSmallBoard(), profile);
  assert.equal(result, "geometry-floor-max");
});

test("geometry contract: maxPlayableFloor passes when within limit", () => {
  const profile = makeProfile({ maxPlayableFloor: 100 });
  const result = validateFinalGeometry(makeSmallBoard(), profile);
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// Test C: minFloorCoverage enforced
// ---------------------------------------------------------------------------

test("geometry contract: minFloorCoverage rejects sparse boards", () => {
  const profile = makeProfile({ minFloorCoverage: 0.99 });
  const result = validateFinalGeometry(makeSmallBoard(), profile);
  assert.equal(result, "geometry-coverage");
});

// ---------------------------------------------------------------------------
// Test D: minRegions enforced
// ---------------------------------------------------------------------------

test("geometry contract: minRegions rejects boards with too few regions", () => {
  const profile = makeProfile({ minRegions: 10 });
  const result = validateFinalGeometry(makeSmallBoard(), profile);
  assert.equal(result, "geometry-regions");
});

// ---------------------------------------------------------------------------
// Test E: minChokepoints enforced
// ---------------------------------------------------------------------------

test("geometry contract: minChokepoints rejects boards without chokepoints", () => {
  const profile = makeProfile({ minChokepoints: 5, minRegions: 0 });
  const result = validateFinalGeometry(makeSmallBoard(), profile);
  assert.equal(result, "geometry-chokepoints");
});

// ---------------------------------------------------------------------------
// Test F: blueprint room count validated against profile
// ---------------------------------------------------------------------------

test("geometry contract: blueprint with too few rooms rejected", () => {
  const params: BlueprintParams = {
    ...DEFAULT_BLUEPRINT_PARAMS,
    seed: 8001,
    family: "linear",
    boardWidth: 14,
    boardHeight: 14,
    minRooms: 2,
    maxRooms: 3,
  };
  const bp = generateBlueprintWithRetry(params, 30);
  assert.ok(bp, "blueprint should generate");

  const grid = rasterizeBlueprint(bp);
  const profile = makeProfile({ minRooms: 6, maxRooms: 12 });
  const result = validateBlueprintGeometry(bp, grid, profile);
  assert.equal(result, "geometry-room-count");
});

// ---------------------------------------------------------------------------
// Test G: blueprint with too many rooms rejected
// ---------------------------------------------------------------------------

test("geometry contract: blueprint with too many rooms rejected", () => {
  const params: BlueprintParams = {
    ...DEFAULT_BLUEPRINT_PARAMS,
    seed: 8010,
    family: "linear",
    boardWidth: 20,
    boardHeight: 20,
    minRooms: 5,
    maxRooms: 8,
  };
  const bp = generateBlueprintWithRetry(params, 30);
  assert.ok(bp, "blueprint should generate");

  const grid = rasterizeBlueprint(bp);
  const profile = makeProfile({ minRooms: 1, maxRooms: 2 });
  const result = validateBlueprintGeometry(bp, grid, profile);
  assert.equal(result, "geometry-room-count");
});

// ---------------------------------------------------------------------------
// Test H: nested family generates rooms matching tier minRooms
// ---------------------------------------------------------------------------

test("geometry contract: nested family respects high minRooms", () => {
  let generatedHighRoomCount = false;

  for (let seed = 8100; seed < 8150; seed++) {
    const params: BlueprintParams = {
      ...DEFAULT_BLUEPRINT_PARAMS,
      seed,
      family: "nested",
      boardWidth: 22,
      boardHeight: 22,
      minRooms: 5,
      maxRooms: 8,
    };
    const bp = generateBlueprintWithRetry(params, 30);
    if (!bp) continue;

    assert.ok(
      bp.rooms.length >= 5,
      `nested blueprint has ${bp.rooms.length} rooms, expected >= 5 (seed=${seed})`,
    );
    if (bp.rooms.length >= 5) generatedHighRoomCount = true;
  }

  assert.ok(
    generatedHighRoomCount,
    "nested family should be able to produce >= 5 rooms when minRooms=5",
  );
});

// ---------------------------------------------------------------------------
// Test I: specific rejection reasons are returned (not generic gate-geometry)
// ---------------------------------------------------------------------------

test("geometry contract: specific rejection reasons returned", () => {
  const floorResult = validateFinalGeometry(makeTinyBoard(), makeProfile({ minPlayableFloor: 100 }));
  assert.ok(floorResult !== "gate-geometry", "should not return generic gate-geometry");
  assert.equal(floorResult, "geometry-floor-min");

  const maxFloorResult = validateFinalGeometry(makeSmallBoard(), makeProfile({ maxPlayableFloor: 2 }));
  assert.equal(maxFloorResult, "geometry-floor-max");

  const coverResult = validateFinalGeometry(makeSmallBoard(), makeProfile({ minFloorCoverage: 0.99 }));
  assert.equal(coverResult, "geometry-coverage");

  const regionResult = validateFinalGeometry(makeSmallBoard(), makeProfile({ minRegions: 50 }));
  assert.equal(regionResult, "geometry-regions");

  const chokeResult = validateFinalGeometry(makeSmallBoard(), makeProfile({ minChokepoints: 50, minRegions: 0 }));
  assert.equal(chokeResult, "geometry-chokepoints");
});

// ---------------------------------------------------------------------------
// Test J: valid board passes all checks
// ---------------------------------------------------------------------------

test("geometry contract: valid board passes all geometry checks", () => {
  const profile = makeProfile({
    minPlayableFloor: 5,
    maxPlayableFloor: 100,
    minFloorCoverage: 0.05,
    minRegions: 0,
    minChokepoints: 0,
  });
  const result = validateFinalGeometry(makeSmallBoard(), profile);
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// Test L4: Post-tightening geometry profile re-check
// ---------------------------------------------------------------------------

test("geometry contract: tightened puzzle still passes geometry validation", async () => {
  const p: PuzzleDefinition = {
    id: "geo-recheck",
    title: "Geometry re-check",
    difficulty: "tutorial",
    boxes: 1,
    rows: [
      "OOOOOO",
      "O R  O",
      "O X  O",
      "O  S O",
      "O    O",
      "OOOOOO",
    ],
  };

  // Generous profile: tightening should not violate any of these bounds
  const profile = makeProfile({
    minPlayableFloor: 4,
    maxPlayableFloor: 50,
    minFloorCoverage: 0.1,
    minRegions: 0,
    minChokepoints: 0,
  });

  // Step 1: original puzzle passes geometry validation
  const beforeResult = validateFinalGeometry(p.rows, profile);
  assert.equal(
    beforeResult,
    null,
    `original puzzle should pass geometry validation, got: ${beforeResult}`,
  );

  // Step 2: tighten the puzzle
  const tightened = await tightenPuzzle(p);
  assert.ok(tightened, "tightenPuzzle should return a result (puzzle is solvable)");

  // Step 3: tightened puzzle still passes the same geometry profile
  const afterResult = validateFinalGeometry(tightened.tightened.rows, profile);
  assert.equal(
    afterResult,
    null,
    `tightened puzzle should still pass geometry validation, got: ${afterResult}`,
  );
});
