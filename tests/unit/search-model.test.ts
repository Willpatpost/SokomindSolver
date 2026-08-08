import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parsePuzzleRows } from "../../src/core/index.ts";
import { compileSearchBoard } from "../../src/solver/search/compiled-board.ts";
import {
  canonicalBoxSignature,
  toDenseBoxes,
  ZobristTable,
  type DenseBox,
} from "../../src/solver/search/model.ts";

function setup(rows: string[]) {
  const parsed = parsePuzzleRows(rows);
  const board = compileSearchBoard(parsed);
  const boxes = toDenseBoxes(board, parsed.initialBoxes);
  const robotCell = board.cellAt(
    parsed.initialRobot.row,
    parsed.initialRobot.column,
  );
  return { parsed, board, boxes, robotCell };
}

const SIMPLE = ["OOOOO", "ORXSO", "OOOOO"];

const TWO_BOX = [
  "OOOOOOO",
  "ORX XSS",
  "OOOOOOO",
];

describe("toDenseBoxes", () => {
  it("converts parsed boxes to dense boxes", () => {
    const { boxes } = setup(SIMPLE);
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].label, "X");
    assert.ok(boxes[0].cell >= 0);
    assert.ok(typeof boxes[0].id === "string");
  });

  it("preserves box ids", () => {
    const { boxes } = setup(TWO_BOX);
    assert.equal(boxes.length, 2);
    // Each box should have a distinct id.
    assert.notEqual(boxes[0].id, boxes[1].id);
  });

  it("throws RangeError when box is not on a floor cell (lines 23-26)", () => {
    const parsed = parsePuzzleRows(SIMPLE);
    const board = compileSearchBoard(parsed);
    // Create a box at a position that is a wall (row 0, col 0 = 'O').
    const wallBox = {
      id: "fake",
      label: "X",
      position: { row: 0, column: 0 },
    };
    assert.throws(
      () => toDenseBoxes(board, [wallBox]),
      { name: "RangeError", message: /not on a floor cell/ },
    );
  });

  it("throws RangeError for out-of-bounds position", () => {
    const parsed = parsePuzzleRows(SIMPLE);
    const board = compileSearchBoard(parsed);
    const oobBox = {
      id: "oob",
      label: "X",
      position: { row: 99, column: 99 },
    };
    assert.throws(
      () => toDenseBoxes(board, [oobBox]),
      { name: "RangeError" },
    );
  });

  it("returns frozen arrays", () => {
    const { boxes } = setup(SIMPLE);
    assert.ok(Object.isFrozen(boxes));
    assert.ok(Object.isFrozen(boxes[0]));
  });
});

describe("canonicalBoxSignature", () => {
  it("returns empty string for empty array", () => {
    assert.equal(canonicalBoxSignature([]), "");
  });

  it("produces a deterministic signature for a single box", () => {
    const boxes: DenseBox[] = [{ id: "b1", label: "X", cell: 5 }];
    const sig = canonicalBoxSignature(boxes);
    assert.equal(sig, "1:X:5");
  });

  it("groups boxes with the same label", () => {
    const boxes: DenseBox[] = [
      { id: "b1", label: "X", cell: 2 },
      { id: "b2", label: "X", cell: 7 },
    ];
    const sig = canonicalBoxSignature(boxes);
    assert.equal(sig, "1:X:2.7");
  });

  it("separates different labels with pipe", () => {
    const boxes: DenseBox[] = [
      { id: "b1", label: "A", cell: 3 },
      { id: "b2", label: "X", cell: 5 },
    ];
    const sig = canonicalBoxSignature(boxes);
    assert.equal(sig, "1:A:3|1:X:5");
  });

  it("handles multi-character labels", () => {
    const boxes: DenseBox[] = [
      { id: "b1", label: "AB", cell: 1 },
    ];
    const sig = canonicalBoxSignature(boxes);
    assert.equal(sig, "2:AB:1");
  });

  it("is stable across calls with same input", () => {
    const boxes: DenseBox[] = [
      { id: "b1", label: "A", cell: 3 },
      { id: "b2", label: "A", cell: 8 },
      { id: "b3", label: "X", cell: 1 },
    ];
    const sig1 = canonicalBoxSignature(boxes);
    const sig2 = canonicalBoxSignature(boxes);
    assert.equal(sig1, sig2);
  });
});

describe("ZobristTable", () => {
  it("constructs without error", () => {
    const table = new ZobristTable(10, ["X"]);
    assert.ok(table);
  });

  it("produces a string state key", () => {
    const table = new ZobristTable(10, ["X"]);
    const boxes: DenseBox[] = [{ id: "b1", label: "X", cell: 3 }];
    const key = table.stateKey(0, boxes);
    assert.equal(typeof key, "string");
    assert.ok(key.includes(":"), "key should contain colon separator");
  });

  it("same state produces same key", () => {
    const table = new ZobristTable(10, ["X"]);
    const boxes: DenseBox[] = [{ id: "b1", label: "X", cell: 3 }];
    const key1 = table.stateKey(0, boxes);
    const key2 = table.stateKey(0, boxes);
    assert.equal(key1, key2);
  });

  it("different robot cells produce different keys", () => {
    const table = new ZobristTable(10, ["X"]);
    const boxes: DenseBox[] = [{ id: "b1", label: "X", cell: 3 }];
    const key1 = table.stateKey(0, boxes);
    const key2 = table.stateKey(1, boxes);
    assert.notEqual(key1, key2);
  });

  it("different box cells produce different keys", () => {
    const table = new ZobristTable(10, ["X"]);
    const boxes1: DenseBox[] = [{ id: "b1", label: "X", cell: 3 }];
    const boxes2: DenseBox[] = [{ id: "b1", label: "X", cell: 4 }];
    const key1 = table.stateKey(0, boxes1);
    const key2 = table.stateKey(0, boxes2);
    assert.notEqual(key1, key2);
  });

  it("different labels produce different keys", () => {
    const table = new ZobristTable(10, ["A", "X"]);
    const boxesA: DenseBox[] = [{ id: "b1", label: "A", cell: 3 }];
    const boxesX: DenseBox[] = [{ id: "b1", label: "X", cell: 3 }];
    const keyA = table.stateKey(0, boxesA);
    const keyX = table.stateKey(0, boxesX);
    assert.notEqual(keyA, keyX);
  });

  it("handles multiple labels in constructor", () => {
    const table = new ZobristTable(5, ["A", "B", "X"]);
    const boxes: DenseBox[] = [
      { id: "b1", label: "A", cell: 0 },
      { id: "b2", label: "B", cell: 1 },
      { id: "b3", label: "X", cell: 2 },
    ];
    const key = table.stateKey(3, boxes);
    assert.equal(typeof key, "string");
  });

  it("handles empty boxes array", () => {
    const table = new ZobristTable(5, ["X"]);
    const key = table.stateKey(0, []);
    assert.equal(typeof key, "string");
    assert.ok(key.includes(":"));
  });

  it("XOR is order-independent for identical-label boxes", () => {
    // Zobrist hashing XORs box entries. Two boxes with same label
    // at different cells should combine via XOR regardless of order.
    const table = new ZobristTable(10, ["X"]);
    const boxesAB: DenseBox[] = [
      { id: "b1", label: "X", cell: 2 },
      { id: "b2", label: "X", cell: 5 },
    ];
    const boxesBA: DenseBox[] = [
      { id: "b2", label: "X", cell: 5 },
      { id: "b1", label: "X", cell: 2 },
    ];
    const keyAB = table.stateKey(0, boxesAB);
    const keyBA = table.stateKey(0, boxesBA);
    assert.equal(keyAB, keyBA, "XOR should be commutative");
  });

  it("works with the full toDenseBoxes pipeline", () => {
    const { board, boxes, robotCell } = setup(TWO_BOX);
    const labels = [...new Set(boxes.map((b) => b.label))].sort();
    const table = new ZobristTable(board.cellCount, labels);
    const key = table.stateKey(robotCell, boxes);
    assert.equal(typeof key, "string");
    assert.ok(key.length > 0);
  });

  it("deterministic across multiple constructions with same seed", () => {
    const table1 = new ZobristTable(10, ["X"]);
    const table2 = new ZobristTable(10, ["X"]);
    const boxes: DenseBox[] = [{ id: "b1", label: "X", cell: 3 }];
    assert.equal(
      table1.stateKey(0, boxes),
      table2.stateKey(0, boxes),
      "same seed should produce same table",
    );
  });
});
