import assert from "node:assert/strict";
import test from "node:test";

import {
  layoutHash,
  layoutSymmetryHash,
  structuralSimilarity,
  findNearDuplicates,
  boardHash,
} from "../../src/features/generator/v2/index.ts";

const PUZZLE_A = [
  "OOOOO",
  "OR  O",
  "O X O",
  "O  SO",
  "OOOOO",
];

const PUZZLE_B_SAME_LAYOUT = [
  "OOOOO",
  "O  RO",
  "O X O",
  "OS  O",
  "OOOOO",
];

const PUZZLE_C_DIFFERENT_LAYOUT = [
  "OOOOOOO",
  "OR    O",
  "O X  SO",
  "OOOOOOO",
];

const PUZZLE_D_WALL_SHIFT = [
  "OOOOO",
  "OR OO",
  "O X O",
  "O  SO",
  "OOOOO",
];

// ---------------------------------------------------------------------------
// 1. layoutHash ignores box/goal/robot placement
// ---------------------------------------------------------------------------

test("layoutHash ignores box/goal/robot placement", () => {
  const hashA = layoutHash(PUZZLE_A);
  const hashB = layoutHash(PUZZLE_B_SAME_LAYOUT);
  assert.equal(hashA, hashB, "same floor layout should produce same layout hash");
});

// ---------------------------------------------------------------------------
// 2. layoutHash differs for different floor layouts
// ---------------------------------------------------------------------------

test("layoutHash differs for different floor layouts", () => {
  const hashA = layoutHash(PUZZLE_A);
  const hashC = layoutHash(PUZZLE_C_DIFFERENT_LAYOUT);
  assert.notEqual(hashA, hashC, "different layouts should produce different hashes");
});

// ---------------------------------------------------------------------------
// 3. layoutSymmetryHash detects mirrored layouts
// ---------------------------------------------------------------------------

test("layoutSymmetryHash detects mirrored layouts", () => {
  const mirror = [
    "OOOOO",
    "O  RO",
    "O X O",
    "OS  O",
    "OOOOO",
  ];
  const hashOrig = layoutSymmetryHash(PUZZLE_A);
  const hashMirror = layoutSymmetryHash(mirror);
  assert.equal(hashOrig, hashMirror, "horizontally mirrored layout should match");
});

// ---------------------------------------------------------------------------
// 4. structuralSimilarity: identical layout = 1.0
// ---------------------------------------------------------------------------

test("structuralSimilarity: same layout different objects = 1.0", () => {
  const result = structuralSimilarity(PUZZLE_A, PUZZLE_B_SAME_LAYOUT);
  assert.equal(result.similarity, 1.0);
  assert.equal(result.layoutMatch, true);
  assert.equal(result.dimensionMatch, true);
});

// ---------------------------------------------------------------------------
// 5. structuralSimilarity: completely different = low score
// ---------------------------------------------------------------------------

test("structuralSimilarity: different dimensions = 0", () => {
  const result = structuralSimilarity(PUZZLE_A, PUZZLE_C_DIFFERENT_LAYOUT);
  assert.equal(result.similarity, 0);
  assert.equal(result.dimensionMatch, false);
});

// ---------------------------------------------------------------------------
// 6. structuralSimilarity: wall shift produces high but not perfect overlap
// ---------------------------------------------------------------------------

test("structuralSimilarity: minor wall shift gives high overlap", () => {
  const result = structuralSimilarity(PUZZLE_A, PUZZLE_D_WALL_SHIFT);
  assert.ok(result.cellOverlap > 0.8, `minor wall shift should have high overlap, got ${result.cellOverlap}`);
  assert.equal(result.layoutMatch, false, "wall shift changes layout hash");
  assert.ok(result.similarity < 1.0);
});

// ---------------------------------------------------------------------------
// 7. findNearDuplicates returns matches above threshold
// ---------------------------------------------------------------------------

test("findNearDuplicates returns matches above threshold", () => {
  const catalog = [
    { id: "same-layout", rows: PUZZLE_B_SAME_LAYOUT },
    { id: "different", rows: PUZZLE_C_DIFFERENT_LAYOUT },
    { id: "wall-shift", rows: PUZZLE_D_WALL_SHIFT },
  ];

  const matches = findNearDuplicates(PUZZLE_A, catalog, 0.85);
  const ids = matches.map((m) => m.id);
  assert.ok(ids.includes("same-layout"), "identical layout should be found");
  assert.ok(ids.includes("wall-shift"), "wall shift should be above 0.85 threshold");
  assert.ok(!ids.includes("different"), "different dimensions should not match");
});

// ---------------------------------------------------------------------------
// 8. boardHash vs layoutHash: boardHash changes with object placement
// ---------------------------------------------------------------------------

test("boardHash changes with object placement but layoutHash does not", () => {
  const bHashA = boardHash(PUZZLE_A);
  const bHashB = boardHash(PUZZLE_B_SAME_LAYOUT);
  assert.notEqual(bHashA, bHashB, "boardHash should differ when objects move");

  const lHashA = layoutHash(PUZZLE_A);
  const lHashB = layoutHash(PUZZLE_B_SAME_LAYOUT);
  assert.equal(lHashA, lHashB, "layoutHash should be the same");
});
