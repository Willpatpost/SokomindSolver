import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Direction } from "../../src/core/model.ts";
import {
  positionKey,
  numericPositionKey,
  samePosition,
  directionDelta,
  translate,
  freezePosition,
  freezeBox,
} from "../../src/core/position.ts";

describe("positionKey", () => {
  it("returns 'row,column' for a typical position", () => {
    assert.equal(positionKey({ row: 3, column: 5 }), "3,5");
  });

  it("handles zero values", () => {
    assert.equal(positionKey({ row: 0, column: 0 }), "0,0");
  });

  it("handles negative values", () => {
    assert.equal(positionKey({ row: -1, column: -7 }), "-1,-7");
  });

  it("handles large values", () => {
    assert.equal(positionKey({ row: 99999, column: 100000 }), "99999,100000");
  });

  it("produces unique keys for different positions", () => {
    const keys = new Set([
      positionKey({ row: 1, column: 2 }),
      positionKey({ row: 2, column: 1 }),
      positionKey({ row: 12, column: 0 }),
      positionKey({ row: 0, column: 12 }),
      positionKey({ row: 1, column: 21 }),
      positionKey({ row: 12, column: 1 }),
    ]);
    assert.equal(keys.size, 6);
  });
});

describe("numericPositionKey", () => {
  it("computes row-major index for origin", () => {
    assert.equal(numericPositionKey(0, 0, 10), 0);
  });

  it("computes row-major index for first row", () => {
    assert.equal(numericPositionKey(0, 3, 10), 3);
  });

  it("computes row-major index for second row", () => {
    assert.equal(numericPositionKey(1, 0, 10), 10);
  });

  it("computes row-major index for arbitrary position", () => {
    assert.equal(numericPositionKey(2, 4, 5), 14);
  });

  it("produces unique indices within grid bounds", () => {
    const width = 8;
    const height = 6;
    const indices = new Set<number>();
    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) {
        indices.add(numericPositionKey(r, c, width));
      }
    }
    assert.equal(indices.size, width * height);
  });

  it("handles width of 1 (single-column grid)", () => {
    assert.equal(numericPositionKey(5, 0, 1), 5);
  });

  it("handles large grid dimensions", () => {
    assert.equal(numericPositionKey(1000, 999, 1000), 1000999);
  });
});

describe("samePosition", () => {
  it("returns true for identical positions", () => {
    assert.equal(samePosition({ row: 3, column: 7 }, { row: 3, column: 7 }), true);
  });

  it("returns false when rows differ", () => {
    assert.equal(samePosition({ row: 3, column: 7 }, { row: 4, column: 7 }), false);
  });

  it("returns false when columns differ", () => {
    assert.equal(samePosition({ row: 3, column: 7 }, { row: 3, column: 8 }), false);
  });

  it("returns false when both differ", () => {
    assert.equal(samePosition({ row: 0, column: 0 }, { row: 1, column: 1 }), false);
  });

  it("works with zero coordinates", () => {
    assert.equal(samePosition({ row: 0, column: 0 }, { row: 0, column: 0 }), true);
  });
});

describe("directionDelta", () => {
  it("returns {row: -1, column: 0} for up", () => {
    const delta = directionDelta("up");
    assert.equal(delta.row, -1);
    assert.equal(delta.column, 0);
  });

  it("returns {row: 1, column: 0} for down", () => {
    const delta = directionDelta("down");
    assert.equal(delta.row, 1);
    assert.equal(delta.column, 0);
  });

  it("returns {row: 0, column: -1} for left", () => {
    const delta = directionDelta("left");
    assert.equal(delta.row, 0);
    assert.equal(delta.column, -1);
  });

  it("returns {row: 0, column: 1} for right", () => {
    const delta = directionDelta("right");
    assert.equal(delta.row, 0);
    assert.equal(delta.column, 1);
  });

  it("throws RangeError for unknown direction", () => {
    assert.throws(
      () => directionDelta("diagonal" as unknown as Direction),
      { name: "RangeError" },
    );
  });
});

describe("translate", () => {
  it("moves position by delta", () => {
    const result = translate({ row: 3, column: 5 }, { row: -1, column: 0 });
    assert.deepEqual(result, { row: 2, column: 5 });
  });

  it("moves position right", () => {
    const result = translate({ row: 0, column: 0 }, { row: 0, column: 1 });
    assert.deepEqual(result, { row: 0, column: 1 });
  });

  it("handles negative results", () => {
    const result = translate({ row: 0, column: 0 }, { row: -1, column: -1 });
    assert.deepEqual(result, { row: -1, column: -1 });
  });

  it("produces new object (does not mutate input)", () => {
    const pos = { row: 1, column: 2 };
    const delta = { row: 1, column: 1 };
    const result = translate(pos, delta);
    assert.notEqual(result, pos);
    assert.equal(pos.row, 1);
    assert.equal(pos.column, 2);
  });

  it("composes correctly with directionDelta", () => {
    const pos = { row: 5, column: 5 };
    const moved = translate(pos, directionDelta("up"));
    assert.deepEqual(moved, { row: 4, column: 5 });
  });
});

describe("freezePosition", () => {
  it("returns a frozen copy", () => {
    const pos = { row: 2, column: 3 };
    const frozen = freezePosition(pos);
    assert.equal(frozen.row, 2);
    assert.equal(frozen.column, 3);
    assert.ok(Object.isFrozen(frozen));
  });

  it("does not share identity with the input", () => {
    const pos = { row: 1, column: 1 };
    const frozen = freezePosition(pos);
    assert.notEqual(frozen, pos);
  });
});

describe("freezeBox", () => {
  it("returns a frozen box with a frozen position", () => {
    const box = { id: "b1", label: "A", position: { row: 4, column: 6 } };
    const frozen = freezeBox(box);
    assert.equal(frozen.id, "b1");
    assert.equal(frozen.label, "A");
    assert.equal(frozen.position.row, 4);
    assert.equal(frozen.position.column, 6);
    assert.ok(Object.isFrozen(frozen));
    assert.ok(Object.isFrozen(frozen.position));
  });

  it("does not share identity with the input", () => {
    const box = { id: "b2", label: "X", position: { row: 0, column: 0 } };
    const frozen = freezeBox(box);
    assert.notEqual(frozen, box);
    assert.notEqual(frozen.position, box.position);
  });
});
