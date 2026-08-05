import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createExactStateCodec } from "../../src/solver/search/exact-state.ts";
import type { DenseBox } from "../../src/solver/search/model.ts";

describe("ExactStateCodec", () => {
  it("creates a codec with correct bit widths", () => {
    const codec = createExactStateCodec(12, ["X"]);
    assert.equal(codec.cellCount, 12);
    assert.equal(codec.labelCount, 1);
    // 1 label × 12 cells = 12 possible tokens → ceil(log2(12)) = 4 bits
    assert.equal(codec.tokenBits, 4);
    // 12 cells → ceil(log2(12)) = 4 bits
    assert.equal(codec.cellBits, 4);
  });

  it("produces distinct identities for distinct box configurations", () => {
    const codec = createExactStateCodec(8, ["X"]);
    const boxes1: DenseBox[] = [
      { id: "X:0", label: "X", cell: 2 },
      { id: "X:1", label: "X", cell: 5 },
    ];
    const boxes2: DenseBox[] = [
      { id: "X:0", label: "X", cell: 2 },
      { id: "X:1", label: "X", cell: 6 },
    ];
    const tokens1 = codec.tokensFromBoxes(boxes1);
    const tokens2 = codec.tokensFromBoxes(boxes2);
    const id1 = codec.packMoveState(0, tokens1);
    const id2 = codec.packMoveState(0, tokens2);
    assert.notEqual(id1, id2);
  });

  it("produces distinct identities for different robot positions", () => {
    const codec = createExactStateCodec(8, ["X"]);
    const boxes: DenseBox[] = [
      { id: "X:0", label: "X", cell: 3 },
    ];
    const tokens = codec.tokensFromBoxes(boxes);
    const id1 = codec.packMoveState(0, tokens);
    const id2 = codec.packMoveState(1, tokens);
    assert.notEqual(id1, id2);
  });

  it("treats same-label boxes as interchangeable", () => {
    const codec = createExactStateCodec(8, ["X"]);
    const boxes1: DenseBox[] = [
      { id: "X:0", label: "X", cell: 2 },
      { id: "X:1", label: "X", cell: 5 },
    ];
    const boxes2: DenseBox[] = [
      { id: "X:1", label: "X", cell: 5 },
      { id: "X:0", label: "X", cell: 2 },
    ];
    const tokens1 = codec.tokensFromBoxes(boxes1);
    const tokens2 = codec.tokensFromBoxes(boxes2);
    const id1 = codec.packMoveState(0, tokens1);
    const id2 = codec.packMoveState(0, tokens2);
    assert.equal(id1, id2);
  });

  it("distinguishes different labels at the same cells", () => {
    const codec = createExactStateCodec(8, ["A", "B"]);
    const boxes1: DenseBox[] = [
      { id: "A:0", label: "A", cell: 2 },
      { id: "B:0", label: "B", cell: 5 },
    ];
    const boxes2: DenseBox[] = [
      { id: "A:0", label: "A", cell: 5 },
      { id: "B:0", label: "B", cell: 2 },
    ];
    const tokens1 = codec.tokensFromBoxes(boxes1);
    const tokens2 = codec.tokensFromBoxes(boxes2);
    const id1 = codec.packMoveState(0, tokens1);
    const id2 = codec.packMoveState(0, tokens2);
    assert.notEqual(id1, id2);
  });

  it("handles repeated labels correctly", () => {
    const codec = createExactStateCodec(8, ["A"]);
    const boxes: DenseBox[] = [
      { id: "A:0", label: "A", cell: 1 },
      { id: "A:1", label: "A", cell: 3 },
      { id: "A:2", label: "A", cell: 5 },
    ];
    const tokens = codec.tokensFromBoxes(boxes);
    assert.equal(tokens.length, 3);
    assert.equal(tokens[0], 1);
    assert.equal(tokens[1], 3);
    assert.equal(tokens[2], 5);
  });

  it("round-trips through decodeTokensForTest", () => {
    const codec = createExactStateCodec(10, ["A", "X"]);
    const boxes: DenseBox[] = [
      { id: "A:0", label: "A", cell: 3 },
      { id: "X:0", label: "X", cell: 7 },
    ];
    const tokens = codec.tokensFromBoxes(boxes);
    const identity = codec.packMoveState(4, tokens);
    const decoded = codec.decodeTokensForTest(identity);
    assert.deepEqual([...decoded], [...tokens]);
  });

  it("round-trips with zero boxes", () => {
    const codec = createExactStateCodec(6, ["X"]);
    const tokens = new Uint32Array(0);
    const identity = codec.packMoveState(2, tokens);
    const decoded = codec.decodeTokensForTest(identity);
    assert.equal(decoded.length, 0);
  });

  it("handles a one-cell board", () => {
    const codec = createExactStateCodec(1, ["X"]);
    assert.equal(codec.cellBits, 1);
    assert.equal(codec.tokenBits, 1);
    const tokens = new Uint32Array([0]);
    const identity = codec.packMoveState(0, tokens);
    const decoded = codec.decodeTokensForTest(identity);
    assert.deepEqual([...decoded], [0]);
  });

  it("rejects out-of-range robot cells", () => {
    const codec = createExactStateCodec(8, ["X"]);
    assert.throws(
      () => codec.packMoveState(-1, new Uint32Array(0)),
      RangeError,
    );
    assert.throws(
      () => codec.packMoveState(8, new Uint32Array(0)),
      RangeError,
    );
  });

  it("rejects out-of-range box cells", () => {
    const codec = createExactStateCodec(8, ["X"]);
    const boxes: DenseBox[] = [{ id: "X:0", label: "X", cell: 10 }];
    assert.throws(() => codec.tokensFromBoxes(boxes), RangeError);
  });

  it("rejects unknown labels", () => {
    const codec = createExactStateCodec(8, ["X"]);
    const boxes: DenseBox[] = [{ id: "A:0", label: "A", cell: 0 }];
    assert.throws(() => codec.tokensFromBoxes(boxes), RangeError);
  });

  it("produces collision-free identities for all states on a tiny board", () => {
    // 6-cell board, 2 labels, 1 box each: 6×5×4 = 120 states
    const cellCount = 6;
    const codec = createExactStateCodec(cellCount, ["A", "B"]);
    const seen = new Set<bigint>();

    for (let cellA = 0; cellA < cellCount; cellA++) {
      for (let cellB = 0; cellB < cellCount; cellB++) {
        if (cellA === cellB) continue;
        for (let robot = 0; robot < cellCount; robot++) {
          if (robot === cellA || robot === cellB) continue;
          const boxes: DenseBox[] = [
            { id: "A:0", label: "A", cell: cellA },
            { id: "B:0", label: "B", cell: cellB },
          ];
          const tokens = codec.tokensFromBoxes(boxes);
          const identity = codec.packMoveState(robot, tokens);
          assert.ok(
            !seen.has(identity),
            `Collision at robot=${robot} A=${cellA} B=${cellB}: identity=${identity}`,
          );
          seen.add(identity);
        }
      }
    }

    assert.equal(seen.size, 120);
  });

  it("produces collision-free identities with repeated labels", () => {
    // 5-cell board, 2 X-boxes: C(5,2)×3 = 30 states
    const cellCount = 5;
    const codec = createExactStateCodec(cellCount, ["X"]);
    const seen = new Set<bigint>();

    for (let cell1 = 0; cell1 < cellCount; cell1++) {
      for (let cell2 = cell1 + 1; cell2 < cellCount; cell2++) {
        for (let robot = 0; robot < cellCount; robot++) {
          if (robot === cell1 || robot === cell2) continue;
          const boxes: DenseBox[] = [
            { id: "X:0", label: "X", cell: cell1 },
            { id: "X:1", label: "X", cell: cell2 },
          ];
          const tokens = codec.tokensFromBoxes(boxes);
          const identity = codec.packMoveState(robot, tokens);
          assert.ok(
            !seen.has(identity),
            `Collision at robot=${robot} cells=${cell1},${cell2}`,
          );
          seen.add(identity);
        }
      }
    }

    assert.equal(seen.size, 30);
  });

  it("handles mixed generic and typed labels", () => {
    const codec = createExactStateCodec(8, ["A", "X"]);
    const boxes: DenseBox[] = [
      { id: "X:0", label: "X", cell: 1 },
      { id: "A:0", label: "A", cell: 3 },
    ];
    const tokens = codec.tokensFromBoxes(boxes);
    // A has labelId 0, X has labelId 1 (sorted alphabetically)
    // A at cell 3: token = 0 * 8 + 3 = 3
    // X at cell 1: token = 1 * 8 + 1 = 9
    assert.equal(tokens[0], 3);
    assert.equal(tokens[1], 9);
  });

  it("supports up to 30 boxes", () => {
    const cellCount = 40;
    const codec = createExactStateCodec(cellCount, ["X"]);
    const boxes: DenseBox[] = [];
    for (let i = 0; i < 30; i++) {
      boxes.push({ id: `X:${i}`, label: "X", cell: i + 1 });
    }
    const tokens = codec.tokensFromBoxes(boxes);
    const identity = codec.packMoveState(0, tokens);
    const decoded = codec.decodeTokensForTest(identity);
    assert.equal(decoded.length, 30);
    assert.deepEqual([...decoded], [...tokens]);
  });

  it("rejects duplicate labels in constructor", () => {
    assert.throws(
      () => createExactStateCodec(8, ["X", "X"]),
      /Duplicate label/,
    );
  });

  it("rejects zero or negative cellCount", () => {
    assert.throws(() => createExactStateCodec(0, ["X"]), RangeError);
    assert.throws(() => createExactStateCodec(-1, ["X"]), RangeError);
  });

  it("rejects empty labels array", () => {
    assert.throws(() => createExactStateCodec(8, []), RangeError);
  });
});
