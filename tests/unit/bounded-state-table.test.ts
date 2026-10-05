import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createBoundedStateTable } from "../../src/solver/search/bounded-state-table.ts";
import { createZobristTable } from "../../src/solver/search/zobrist-state.ts";

describe("BoundedStateTable", () => {
  const CELLS = 100;

  function table(maxEntries = 1_000, canGrow?: (bytes: number) => boolean) {
    return createBoundedStateTable({
      cellCount: CELLS,
      maxToken: 2 * CELLS - 1,
      boxCount: 2,
      maxEntries,
      canGrow,
    });
  }

  it("matches only the exact robot cell and tokens under one hash", () => {
    const t = table();
    const key = new Uint32Array([5, 40]);
    assert.equal(t.insert(9, 3, 7, key, 11), true);
    // Same hash: another robot cell, and the same cell under another label.
    assert.equal(t.find(9, 3, 8, key), -1);
    assert.equal(t.find(9, 3, 7, new Uint32Array([5, 140])), -1);
    assert.equal(t.insert(9, 3, 8, key, 12), true);
    assert.equal(t.value(t.find(9, 3, 7, key)), 11);
    assert.equal(t.value(t.find(9, 3, 8, key)), 12);

    const wide = createBoundedStateTable({
      cellCount: 70_000,
      maxToken: 69_999,
      boxCount: 1,
      maxEntries: 10,
    });
    assert.equal(wide.insert(1, 1, 69_998, [69_999], 4), true);
    assert.equal(wide.find(1, 1, 69_998, [69_999 - 65_536]), -1);
    assert.equal(wide.value(wide.find(1, 1, 69_998, [69_999])), 4);
  });

  it("finds every state by its full hash after growing", () => {
    const t = table(10_000);
    const zobrist = createZobristTable(CELLS, 2);
    const states = Array.from({ length: 2_000 }, (_, i) => ({
      robot: i % CELLS,
      tokens: new Uint32Array([Math.floor(i / CELLS), 50 + Math.floor(i / CELLS)]),
    }));
    for (const [i, { robot, tokens }] of states.entries()) {
      const lo = zobrist.hashLo(tokens, robot);
      const hi = zobrist.hashHi(tokens, robot);
      assert.equal(hi, zobrist.hashComponents(tokens, robot).hi);
      assert.equal(t.find(lo, hi, robot, tokens), -1);
      assert.equal(t.insert(lo, hi, robot, tokens, i), true);
    }
    assert.equal(t.size, states.length);
    for (const [i, { robot, tokens }] of states.entries()) {
      const slot = t.find(zobrist.hashLo(tokens, robot), zobrist.hashHi(tokens, robot), robot, tokens);
      assert.equal(t.value(slot), i);
    }
  });

  it("hides every entry after clear", () => {
    const t = table();
    const key = new Uint32Array([1, 2]);
    t.insert(4, 4, 0, key, 3);
    const bytes = t.byteLength;
    t.clear();
    assert.equal(t.size, 0);
    assert.equal(t.find(4, 4, 0, key), -1);
    assert.equal(t.insert(4, 4, 0, key, 6), true);
    assert.equal(t.value(t.find(4, 4, 0, key)), 6);
    assert.equal(t.byteLength, bytes);
  });

  it("replaces the home slot or skips the store once it cannot grow", () => {
    const capped = table(1);
    const a = new Uint32Array([1, 2]);
    const b = new Uint32Array([3, 4]);
    assert.equal(capped.insert(0, 0, 0, a, 1), true);
    assert.equal(capped.insert(0, 9, 0, b, 2), true);
    assert.equal(capped.find(0, 0, 0, a), -1);
    assert.equal(capped.value(capped.find(0, 9, 0, b)), 2);
    assert.equal(capped.insert(1, 0, 0, a, 3), true);
    assert.equal(capped.find(1, 0, 0, a), -1);
    assert.equal(capped.size, 1);

    let asked = 0;
    const budgeted = table(100_000, () => {
      asked += 1;
      return false;
    });
    const bytes = budgeted.byteLength;
    for (let i = 0; i < 400; i++) {
      assert.equal(budgeted.insert(i, i, 0, new Uint32Array([i % CELLS, CELLS + (i % CELLS)]), i), true);
    }
    assert.ok(asked > 0);
    assert.equal(budgeted.byteLength, bytes);
    assert.ok(budgeted.size < 400);
  });
});
