import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createZobristTable } from "../../src/solver/search/zobrist-state.ts";

describe("ZobristTable", () => {
  const cellCount = 20;
  const labelCount = 3;

  it("same state always produces the same hash", () => {
    const table = createZobristTable(cellCount, labelCount);
    const tokens = new Uint32Array([5, 12, 38]);
    const robotCell = 7;

    const hash1 = table.hashFromTokens(tokens, robotCell);
    const hash2 = table.hashFromTokens(tokens, robotCell);
    assert.equal(hash1, hash2);
  });

  it("different states produce different hashes", () => {
    const bigCellCount = 50;
    const bigLabelCount = 2;
    const maxToken = bigCellCount * bigLabelCount;
    const table = createZobristTable(bigCellCount, bigLabelCount);
    const seen = new Map<number, string>();
    let collisions = 0;
    const trials = 1000;

    for (let i = 0; i < trials; i++) {
      const t0 = i % maxToken;
      let t1 = ((i * 13 + 7) % (maxToken - 1));
      if (t1 >= t0) t1 += 1;
      const tokens = t0 < t1
        ? new Uint32Array([t0, t1])
        : new Uint32Array([t1, t0]);
      const robotCell = (i * 3 + 1) % bigCellCount;
      const stateId = `${tokens[0]},${tokens[1]},${robotCell}`;
      const hash = table.hashFromTokens(tokens, robotCell);
      const existing = seen.get(hash);
      if (existing !== undefined && existing !== stateId) collisions++;
      seen.set(hash, stateId);
    }

    assert.ok(
      collisions / trials < 0.01,
      `Collision rate ${collisions / trials} exceeds 1%`,
    );
  });

  it("incremental token update matches full recomputation", () => {
    const table = createZobristTable(cellCount, labelCount);
    const tokens = new Uint32Array([5, 12, 38]);
    const robotCell = 7;

    const { hi: origHi, lo: origLo } = table.hashComponents(tokens, robotCell);

    const oldToken = 12;
    const newToken = 15;
    const { hi: incHi, lo: incLo } = table.updateToken(origHi, origLo, oldToken, newToken);

    const updatedTokens = new Uint32Array([5, 15, 38]);
    const { hi: fullHi, lo: fullLo } = table.hashComponents(updatedTokens, robotCell);

    assert.equal(incHi, fullHi);
    assert.equal(incLo, fullLo);
  });

  it("incremental robot update matches full recomputation", () => {
    const table = createZobristTable(cellCount, labelCount);
    const tokens = new Uint32Array([5, 12, 38]);
    const oldRobot = 7;
    const newRobot = 9;

    const { hi: origHi, lo: origLo } = table.hashComponents(tokens, oldRobot);
    const { hi: incHi, lo: incLo } = table.updateRobot(origHi, origLo, oldRobot, newRobot);

    const { hi: fullHi, lo: fullLo } = table.hashComponents(tokens, newRobot);

    assert.equal(incHi, fullHi);
    assert.equal(incLo, fullLo);
  });

  it("toSafeKey returns a 53-bit safe integer", () => {
    const table = createZobristTable(cellCount, labelCount);
    const tokens = new Uint32Array([5, 12]);
    const robotCell = 3;

    const key = table.hashFromTokens(tokens, robotCell);
    assert.ok(Number.isSafeInteger(key), `Key ${key} is not a safe integer`);
    assert.ok(key >= 0, `Key ${key} is negative`);
  });

  it("push-only hash excludes robot position", () => {
    const table = createZobristTable(cellCount, labelCount);
    const tokens = new Uint32Array([5, 12]);

    const hashNoRobot = table.hashFromTokensNoRobot(tokens);
    const hashWithRobot3 = table.hashFromTokens(tokens, 3);
    const hashWithRobot7 = table.hashFromTokens(tokens, 7);

    assert.notEqual(hashWithRobot3, hashWithRobot7);
    assert.notEqual(hashNoRobot, hashWithRobot3);
    assert.notEqual(hashNoRobot, hashWithRobot7);
  });

  it("deterministic across same seed", () => {
    const table1 = createZobristTable(cellCount, labelCount, 42);
    const table2 = createZobristTable(cellCount, labelCount, 42);
    const tokens = new Uint32Array([5, 12]);
    const robotCell = 3;

    assert.equal(
      table1.hashFromTokens(tokens, robotCell),
      table2.hashFromTokens(tokens, robotCell),
    );
  });

  it("different seeds produce different hashes", () => {
    const table1 = createZobristTable(cellCount, labelCount, 42);
    const table2 = createZobristTable(cellCount, labelCount, 99);
    const tokens = new Uint32Array([5, 12]);
    const robotCell = 3;

    assert.notEqual(
      table1.hashFromTokens(tokens, robotCell),
      table2.hashFromTokens(tokens, robotCell),
    );
  });

  it("empty token array is valid", () => {
    const table = createZobristTable(cellCount, labelCount);
    const tokens = new Uint32Array(0);
    const hash = table.hashFromTokens(tokens, 0);
    assert.ok(Number.isSafeInteger(hash));
  });
});
