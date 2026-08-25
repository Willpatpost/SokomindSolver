import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalizeRows,
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
