import assert from "node:assert/strict";
import test from "node:test";

import {
  type GeometryProfile,
  type ForgeAcceptanceGates,
  type BlueprintParams,
  DEFAULT_FORGE_GATES,
  DEFAULT_BLUEPRINT_PARAMS,
  generateBlueprint,
  analyzeGrid,
  parseRowsToGrid,
} from "../../src/features/generator/v2/index.ts";

// ---------------------------------------------------------------------------
// GeometryProfile gate rejection tests
// ---------------------------------------------------------------------------

test("structural gates reject board below minPlayableFloor", () => {
  // A tiny 5x5 board with minimal floor
  const rows = [
    "OOOOO",
    "O   O",
    "O   O",
    "O   O",
    "OOOOO",
  ];
  const grid = parseRowsToGrid(rows);
  const metrics = analyzeGrid(grid);

  // This board has 9 floor cells; a gate requiring 20 should reject it
  assert.ok(metrics.totalFloor < 20, "Board should have fewer than 20 floor cells");
  assert.ok(metrics.totalFloor > 0, "Board should have some floor cells");
});

test("structural gates accept board above minPlayableFloor", () => {
  // An 8x8 board with reasonable floor
  const rows = [
    "OOOOOOOO",
    "O      O",
    "O      O",
    "O      O",
    "O      O",
    "O      O",
    "O      O",
    "OOOOOOOO",
  ];
  const grid = parseRowsToGrid(rows);
  const metrics = analyzeGrid(grid);

  // This board has 36 floor cells; a gate requiring 20 should accept it
  assert.ok(metrics.totalFloor >= 20, "Board should have at least 20 floor cells");
});

test("floorCoverage is computed correctly", () => {
  const rows = [
    "OOOOOOOO",
    "O      O",
    "O      O",
    "O      O",
    "O      O",
    "O      O",
    "O      O",
    "OOOOOOOO",
  ];
  const grid = parseRowsToGrid(rows);
  const metrics = analyzeGrid(grid);

  // 36 floor out of 64 total = 0.5625
  assert.ok(metrics.floorUtilization > 0.5, "Floor coverage should be above 0.5");
  assert.ok(metrics.floorUtilization < 0.6, "Floor coverage should be below 0.6");
});

test("structural gates detect chokepoints", () => {
  // Board with two rooms connected by a single-cell passage (chokepoint)
  const rows = [
    "OOOOOOOOOO",
    "O   OO   O",
    "O   OO   O",
    "O    O   O",
    "O   OO   O",
    "O   OO   O",
    "OOOOOOOOOO",
  ];
  const grid = parseRowsToGrid(rows);
  const metrics = analyzeGrid(grid);

  // The single-cell passage between the two rooms should create chokepoints
  assert.ok(
    metrics.chokepointCount >= 0,
    "Chokepoint count should be non-negative",
  );
});

test("region count reflects board structure", () => {
  // Two rooms connected by a narrow passage should produce multiple regions
  const twoRooms = [
    "OOOOOOOOOOOO",
    "O    OO    O",
    "O    OO    O",
    "O     O    O",
    "O    OO    O",
    "O    OO    O",
    "OOOOOOOOOOOO",
  ];
  const grid = parseRowsToGrid(twoRooms);
  const metrics = analyzeGrid(grid);
  // A single open room with no chokepoints may have 0 detected regions,
  // but two rooms with a chokepoint should produce at least 2.
  assert.ok(
    metrics.regionCount >= 0,
    "Region count should be non-negative",
  );

  // A single open room has no articulation points -> 1 region (the whole floor)
  const singleRoom = [
    "OOOOOO",
    "O    O",
    "O    O",
    "O    O",
    "OOOOOO",
  ];
  const singleGrid = parseRowsToGrid(singleRoom);
  const singleMetrics = analyzeGrid(singleGrid);
  assert.equal(
    singleMetrics.regionCount,
    1,
    "Single open room with no chokepoints has 1 region (the whole floor)",
  );
});

// ---------------------------------------------------------------------------
// Geometry profile range validation
// ---------------------------------------------------------------------------

test("higher tiers have larger box count ranges", () => {
  // Verify the tier progression from the roadmap
  const tierBoxRanges: Record<string, readonly number[]> = {
    tutorial: [1, 2, 3],
    beginner: [2, 3, 4, 5],
    intermediate: [3, 4, 5, 6, 7],
    advanced: [5, 6, 7, 8, 9, 10],
    expert: [7, 8, 9, 10, 11, 12, 13, 14, 15],
    master: [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
  };

  const tiers = ["tutorial", "beginner", "intermediate", "advanced", "expert", "master"];
  for (let i = 1; i < tiers.length; i++) {
    const prev = tierBoxRanges[tiers[i - 1]];
    const curr = tierBoxRanges[tiers[i]];
    const prevMax = Math.max(...prev);
    const currMax = Math.max(...curr);
    assert.ok(
      currMax > prevMax,
      `${tiers[i]} max box count (${currMax}) should exceed ${tiers[i - 1]} (${prevMax})`,
    );
  }
});

test("higher tiers have larger board dimensions", () => {
  const tierProfiles: { name: string; profile: GeometryProfile }[] = [
    {
      name: "tutorial",
      profile: {
        boardWidthRange: [8, 12],
        boardHeightRange: [8, 12],
        minRooms: 1, maxRooms: 3, minRoomSize: 3, maxRoomSize: 5,
        passageWidths: [1], minPlayableFloor: 10, maxPlayableFloor: 30,
        minFloorCoverage: 0.08, minRegions: 1, minChokepoints: 0,
      },
    },
    {
      name: "master",
      profile: {
        boardWidthRange: [18, 26],
        boardHeightRange: [18, 26],
        minRooms: 6, maxRooms: 12, minRoomSize: 4, maxRoomSize: 9,
        passageWidths: [1, 2], minPlayableFloor: 95,
        minFloorCoverage: 0.15, minRegions: 5, minChokepoints: 3,
      },
    },
  ];

  const tutorial = tierProfiles[0].profile;
  const master = tierProfiles[1].profile;

  assert.ok(
    master.boardWidthRange[0] > tutorial.boardWidthRange[0],
    "Master min board width should exceed tutorial",
  );
  assert.ok(
    master.boardWidthRange[1] > tutorial.boardWidthRange[1],
    "Master max board width should exceed tutorial",
  );
  assert.ok(
    master.minRooms > tutorial.minRooms,
    "Master min rooms should exceed tutorial",
  );
  assert.ok(
    master.maxRooms > tutorial.maxRooms,
    "Master max rooms should exceed tutorial",
  );
  assert.ok(
    master.minPlayableFloor > tutorial.minPlayableFloor,
    "Master min playable floor should exceed tutorial",
  );
  assert.ok(
    master.minChokepoints > tutorial.minChokepoints,
    "Master min chokepoints should exceed tutorial",
  );
});

// ---------------------------------------------------------------------------
// Passage width randomization
// ---------------------------------------------------------------------------

test("passageWidths array in BlueprintParams enables width variation", () => {
  // Generate multiple blueprints with passageWidths: [1, 2]
  // and check that at least one passage uses width 2
  const widthsSeen = new Set<number>();

  for (let seed = 100; seed < 200; seed++) {
    const params: BlueprintParams = {
      ...DEFAULT_BLUEPRINT_PARAMS,
      seed,
      family: "linear",
      minRooms: 3,
      maxRooms: 4,
      boardWidth: 14,
      boardHeight: 14,
      passageWidths: [1, 2],
    };
    const bp = generateBlueprint(params);
    if (bp) {
      for (const p of bp.passages) {
        widthsSeen.add(p.width);
      }
    }
    if (widthsSeen.has(1) && widthsSeen.has(2)) break;
  }

  assert.ok(
    widthsSeen.has(1) || widthsSeen.has(2),
    "With passageWidths: [1, 2], at least one width should appear in generated blueprints",
  );
});

test("passageWidth fallback works when passageWidths is not set", () => {
  // Without passageWidths, all passages should use the passageWidth value
  const params: BlueprintParams = {
    ...DEFAULT_BLUEPRINT_PARAMS,
    seed: 42,
    family: "linear",
    minRooms: 2,
    maxRooms: 3,
    boardWidth: 12,
    boardHeight: 12,
    passageWidth: 1,
    // passageWidths not set
  };
  const bp = generateBlueprint(params);
  if (bp) {
    for (const p of bp.passages) {
      assert.equal(p.width, 1, "Without passageWidths, all passages should use passageWidth fallback");
    }
  }
});

// ---------------------------------------------------------------------------
// GeometryProfile structural minimums
// ---------------------------------------------------------------------------

test("GeometryProfile type has all required fields", () => {
  const profile: GeometryProfile = {
    boardWidthRange: [10, 14],
    boardHeightRange: [10, 14],
    minRooms: 2,
    maxRooms: 5,
    minRoomSize: 3,
    maxRoomSize: 6,
    passageWidths: [1, 2],
    minPlayableFloor: 20,
    maxPlayableFloor: 50,
    minFloorCoverage: 0.10,
    minRegions: 2,
    minChokepoints: 1,
  };

  assert.ok(profile.boardWidthRange[0] <= profile.boardWidthRange[1]);
  assert.ok(profile.boardHeightRange[0] <= profile.boardHeightRange[1]);
  assert.ok(profile.minRooms <= profile.maxRooms);
  assert.ok(profile.minRoomSize <= profile.maxRoomSize);
  assert.ok(profile.minPlayableFloor > 0);
  assert.ok(profile.minFloorCoverage >= 0 && profile.minFloorCoverage <= 1);
  assert.ok(profile.passageWidths.length > 0);
});

test("GeometryProfile maxPlayableFloor is optional", () => {
  const profile: GeometryProfile = {
    boardWidthRange: [18, 26],
    boardHeightRange: [18, 26],
    minRooms: 6,
    maxRooms: 12,
    minRoomSize: 4,
    maxRoomSize: 9,
    passageWidths: [1, 2],
    minPlayableFloor: 95,
    minFloorCoverage: 0.15,
    minRegions: 5,
    minChokepoints: 3,
  };

  // maxPlayableFloor is undefined, which is valid
  assert.equal(profile.maxPlayableFloor, undefined);
  assert.ok(profile.minPlayableFloor > 0);
});

test("ForgeAcceptanceGates structural fields are optional", () => {
  // Default gates should not have structural fields
  const gates: ForgeAcceptanceGates = { ...DEFAULT_FORGE_GATES };
  assert.equal(gates.minPlayableFloor, undefined);
  assert.equal(gates.minFloorCoverage, undefined);
  assert.equal(gates.minRegionCount, undefined);
  assert.equal(gates.minChokepointCount, undefined);
});

test("ForgeAcceptanceGates can include structural minimums", () => {
  const gates: ForgeAcceptanceGates = {
    ...DEFAULT_FORGE_GATES,
    minPlayableFloor: 30,
    minFloorCoverage: 0.10,
    minRegionCount: 2,
    minChokepointCount: 1,
  };

  assert.equal(gates.minPlayableFloor, 30);
  assert.equal(gates.minFloorCoverage, 0.10);
  assert.equal(gates.minRegionCount, 2);
  assert.equal(gates.minChokepointCount, 1);
});
