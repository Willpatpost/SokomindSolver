import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createCompactNodeArena } from "../../src/solver/search/compact-node-arena.ts";
import { createExactStateTable } from "../../src/solver/search/exact-state-table.ts";
import { createZobristTable } from "../../src/solver/search/zobrist-state.ts";

describe("ExactStateTable", () => {
  const CELLS = 4096;

  function setup() {
    const arena = createCompactNodeArena(2, CELLS - 1);
    const table = createExactStateTable(arena);
    const add = (robot: number, tokens: Uint32Array, g: number) => {
      const node = arena.allocate();
      arena.setRobotCell(node, robot);
      arena.setGMoves(node, g);
      arena.writeBoxTokens(node, tokens);
      return node;
    };
    return { table, add };
  }

  it("keeps states with one hash apart and supersedes a replaced node", () => {
    const { table, add } = setup();
    const a = new Uint32Array([1, 5]);
    const b = new Uint32Array([1, 6]);
    const nodeA = add(0, a, 10);
    assert.equal(table.store(7, nodeA, -1), true);
    assert.equal(table.find(7, 0, b), -1);
    assert.equal(table.find(7, 3, a), -1);
    const nodeB = add(0, b, 4);
    assert.equal(table.store(7, nodeB, -1), true);
    assert.equal(table.find(7, 0, a), nodeA);
    assert.equal(table.find(7, 0, b), nodeB);

    const shorterA = add(0, a, 8);
    assert.equal(table.store(7, shorterA, nodeA), true);
    assert.equal(table.find(7, 0, a), shorterA);
    assert.equal(table.isSuperseded(nodeA), true);
    assert.equal(table.isSuperseded(shorterA), false);
    assert.equal(table.isSuperseded(nodeB), false);
    assert.equal(table.size, 2);
  });

  it("finds every state by its incremental hash after growing", () => {
    const { table, add } = setup();
    const zobrist = createZobristTable(CELLS, 1);
    const robot = (i: number) => 4001 + (i & 1);
    const tokens = (i: number) => new Uint32Array([i, 4000]);
    const count = 3000;
    const nodes: number[] = [];
    const initialBytes = table.byteLength;
    for (let i = 0; i < count; i++) {
      const node = add(robot(i), tokens(i), i);
      assert.equal(table.store(zobrist.hashLo(tokens(i), robot(i)), node, -1), true);
      nodes.push(node);
    }
    assert.equal(table.size, count);
    assert.ok(table.byteLength > initialBytes);
    for (let i = 0; i + 1 < count; i++) {
      const hash = zobrist.updateLo(
        zobrist.hashLo(tokens(i), robot(i)), i, i + 1, robot(i), robot(i + 1),
      );
      assert.equal(hash, zobrist.hashLo(tokens(i + 1), robot(i + 1)));
      assert.equal(table.find(hash, robot(i + 1), tokens(i + 1)), nodes[i + 1]);
      assert.equal(table.isSuperseded(nodes[i]), false);
    }
  });
});
