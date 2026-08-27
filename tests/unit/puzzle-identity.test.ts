import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalizeRows,
  framePuzzleRows,
  boardHash,
  symmetryHash,
  createGeneratedPuzzleId,
} from "../../src/features/generator/v2/puzzle-identity.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SMALL_BOARD = [
  "OOOO",
  "OR O",
  "OX O",
  "OSOO",
  "OOOO",
];

const SMALL_BOARD_PADDED = [
  "OOOOOO",
  "OOOOOO",
  "OOR OO",
  "OOX OO",
  "OOSOOO",
  "OOOOOO",
];

const ASYMMETRIC_BOARD = [
  "OOOOO",
  "OR  O",
  "O X O",
  "O  SO",
  "OOOOO",
];

// ---------------------------------------------------------------------------
// canonicalizeRows
// ---------------------------------------------------------------------------

test("canonicalizeRows trims all-wall borders", () => {
  const padded = [
    "OOOOOOOO",
    "OOOOOOOO",
    "OOO  OOO",
    "OOOR OOO",
    "OOOOOOOO",
    "OOOOOOOO",
  ];
  const result = canonicalizeRows(padded);
  assert.deepEqual(result, [
    "  ",
    "R ",
  ]);
});

test("canonicalizeRows is idempotent", () => {
  const first = canonicalizeRows(SMALL_BOARD);
  const second = canonicalizeRows(first);
  assert.deepEqual(first, second);
});

test("canonicalizeRows preserves content when no trimming needed", () => {
  const board = [
    " O",
    "R ",
    "X ",
    "SO",
  ];
  const result = canonicalizeRows(board);
  assert.deepEqual(result, board);
});

test("canonicalizeRows pads ragged rows to equal width", () => {
  const ragged = [
    "OOO",
    "OR",
    "OXO",
  ];
  const result = canonicalizeRows(ragged);
  for (const row of result) {
    assert.equal(row.length, result[0].length);
  }
});

test("canonicalizeRows returns [O] for all-wall input", () => {
  const result = canonicalizeRows(["OOO", "OOO"]);
  assert.deepEqual(result, ["O"]);
});

test("canonicalizeRows returns [] for empty input", () => {
  const result = canonicalizeRows([]);
  assert.deepEqual(result, []);
});

// ---------------------------------------------------------------------------
// boardHash
// ---------------------------------------------------------------------------

test("boardHash is deterministic", () => {
  const h1 = boardHash(SMALL_BOARD);
  const h2 = boardHash(SMALL_BOARD);
  assert.equal(h1, h2);
});

test("boardHash changes with one cell difference", () => {
  const altered = [...SMALL_BOARD];
  altered[2] = "O  O";
  assert.notEqual(boardHash(SMALL_BOARD), boardHash(altered));
});

test("boardHash matches hex format", () => {
  assert.match(boardHash(SMALL_BOARD), /^[0-9a-f]{8}$/);
});

test("padding-shifted board produces same hash after canonicalization", () => {
  assert.equal(boardHash(SMALL_BOARD), boardHash(SMALL_BOARD_PADDED));
});

test("boardHash differs for different boards", () => {
  const other = [
    "OOOOO",
    "O R O",
    "O XSO",
    "OOOOO",
  ];
  assert.notEqual(boardHash(SMALL_BOARD), boardHash(other));
});

// ---------------------------------------------------------------------------
// symmetryHash
// ---------------------------------------------------------------------------

test("symmetryHash collapses horizontal mirror", () => {
  const mirrored = ASYMMETRIC_BOARD.map((r) => [...r].reverse().join(""));
  assert.equal(symmetryHash(ASYMMETRIC_BOARD), symmetryHash(mirrored));
});

test("symmetryHash collapses vertical mirror", () => {
  const mirrored = [...ASYMMETRIC_BOARD].reverse();
  assert.equal(symmetryHash(ASYMMETRIC_BOARD), symmetryHash(mirrored));
});

test("symmetryHash collapses 180-degree rotation", () => {
  const rotated = [...ASYMMETRIC_BOARD].reverse().map(
    (r) => [...r].reverse().join(""),
  );
  assert.equal(symmetryHash(ASYMMETRIC_BOARD), symmetryHash(rotated));
});

test("asymmetric board exact hash differs from symmetry hash", () => {
  assert.notEqual(boardHash(ASYMMETRIC_BOARD), symmetryHash(ASYMMETRIC_BOARD));
});

test("symmetric board exact hash equals symmetry hash", () => {
  const symmetric = [
    "OOOOO",
    "O   O",
    "O R O",
    "O   O",
    "OOOOO",
  ];
  assert.equal(boardHash(symmetric), symmetryHash(symmetric));
});

// ---------------------------------------------------------------------------
// createGeneratedPuzzleId
// ---------------------------------------------------------------------------

test("createGeneratedPuzzleId has gen-v2- prefix", () => {
  const id = createGeneratedPuzzleId(12345, SMALL_BOARD);
  assert.ok(id.startsWith("gen-v2-"));
});

test("same rows and seed produce same ID", () => {
  const id1 = createGeneratedPuzzleId(42, SMALL_BOARD);
  const id2 = createGeneratedPuzzleId(42, SMALL_BOARD);
  assert.equal(id1, id2);
});

test("different rows produce different ID", () => {
  const other = [
    "OOOOO",
    "O R O",
    "O XSO",
    "OOOOO",
  ];
  assert.notEqual(
    createGeneratedPuzzleId(42, SMALL_BOARD),
    createGeneratedPuzzleId(42, other),
  );
});

test("different seed produces different ID", () => {
  assert.notEqual(
    createGeneratedPuzzleId(1, SMALL_BOARD),
    createGeneratedPuzzleId(2, SMALL_BOARD),
  );
});

test("V2 ID never matches legacy ordinal format", () => {
  const id = createGeneratedPuzzleId(100, SMALL_BOARD);
  assert.doesNotMatch(id, /^gen-(tutorial|beginner|intermediate|advanced|expert|master)-\d{3}$/);
});

// ---------------------------------------------------------------------------
// framePuzzleRows
// ---------------------------------------------------------------------------

test("framePuzzleRows produces all-wall first and last rows", () => {
  const board = [
    "OR O",
    "OX O",
    "OSOO",
  ];
  const framed = framePuzzleRows(board);
  for (const ch of framed[0]) {
    assert.equal(ch, "O");
  }
  for (const ch of framed[framed.length - 1]) {
    assert.equal(ch, "O");
  }
});

test("framePuzzleRows produces all-wall first and last columns", () => {
  const board = [
    "OR O",
    "OX O",
    "OSOO",
  ];
  const framed = framePuzzleRows(board);
  for (const row of framed) {
    assert.equal(row[0], "O");
    assert.equal(row[row.length - 1], "O");
  }
});

test("framePuzzleRows preserves interior cells", () => {
  const board = [
    "OOOO",
    "OR O",
    "OX O",
    "OSOO",
    "OOOO",
  ];
  const framed = framePuzzleRows(board);
  // Interior should contain R, X, S, spaces
  const interior = framed.slice(1, -1).map((r) => r.slice(1, -1));
  const flat = interior.join("");
  assert.ok(flat.includes("R"), "interior must contain R");
  assert.ok(flat.includes("X"), "interior must contain X");
  assert.ok(flat.includes("S"), "interior must contain S");
});

test("framePuzzleRows is roughly idempotent on already-framed boards", () => {
  const board = [
    "OOOO",
    "OR O",
    "OX O",
    "OSOO",
    "OOOO",
  ];
  const framed1 = framePuzzleRows(board);
  const framed2 = framePuzzleRows(framed1);
  assert.deepEqual(framed1, framed2);
});

test("framePuzzleRows handles entities at input edge (no wall border)", () => {
  // Robot and goal at edges — need synthesized wall perimeter
  const board = [
    "R  ",
    " X ",
    "  S",
  ];
  const framed = framePuzzleRows(board);
  // Must have wall perimeter
  for (const ch of framed[0]) {
    assert.equal(ch, "O");
  }
  for (const ch of framed[framed.length - 1]) {
    assert.equal(ch, "O");
  }
  for (const row of framed) {
    assert.equal(row[0], "O");
    assert.equal(row[row.length - 1], "O");
  }
  // Interior should still contain R, X, S
  const flat = framed.join("");
  assert.ok(flat.includes("R"), "must contain R");
  assert.ok(flat.includes("X"), "must contain X");
  assert.ok(flat.includes("S"), "must contain S");
});

test("framePuzzleRows works with small 3x3 boards", () => {
  const board = [
    "OOO",
    "ORO",
    "OOO",
  ];
  const framed = framePuzzleRows(board);
  // R is the only non-wall, bounding box is (1,1)-(1,1), expand to (0,0)-(2,2)
  assert.deepEqual(framed, [
    "OOO",
    "ORO",
    "OOO",
  ]);
});

test("framePuzzleRows returns [O] for all-wall input", () => {
  const result = framePuzzleRows(["OOO", "OOO"]);
  assert.deepEqual(result, ["O"]);
});

test("framePuzzleRows returns [] for empty input", () => {
  const result = framePuzzleRows([]);
  assert.deepEqual(result, []);
});

test("framePuzzleRows handles ragged rows", () => {
  const board = [
    "OOO",
    "OR",
    "OXO",
  ];
  const framed = framePuzzleRows(board);
  // All rows must have equal width
  const widths = framed.map((r) => r.length);
  assert.ok(widths.every((w) => w === widths[0]), "all rows same width");
  // Must have wall perimeter
  for (const ch of framed[0]) assert.equal(ch, "O");
  for (const ch of framed[framed.length - 1]) assert.equal(ch, "O");
});

test("framePuzzleRows handles typed boxes and goals", () => {
  const board = [
    "OOOOO",
    "OA aO",
    "OB bO",
    "OOOOO",
  ];
  const framed = framePuzzleRows(board);
  const flat = framed.join("");
  assert.ok(flat.includes("A"), "must contain typed box A");
  assert.ok(flat.includes("a"), "must contain typed goal a");
  assert.ok(flat.includes("B"), "must contain typed box B");
  assert.ok(flat.includes("b"), "must contain typed goal b");
  // Already framed — should be idempotent
  assert.deepEqual(framed, framePuzzleRows(framed));
});

test("framePuzzleRows synthesizes wall when entities touch corner", () => {
  // Single entity — minimum board
  const board = ["R"];
  const framed = framePuzzleRows(board);
  // Should be 3x3 with R in center
  assert.equal(framed.length, 3);
  assert.equal(framed[0].length, 3);
  assert.deepEqual(framed, [
    "OOO",
    "ORO",
    "OOO",
  ]);
});
