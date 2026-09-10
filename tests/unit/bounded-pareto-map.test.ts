import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BoundedParetoMap,
  boundedParetoRecords,
} from "../../src/solver/search/bounded-pareto-map.ts";

describe("boundedParetoRecords", () => {
  it("returns all records when under limit", () => {
    const records = [
      { pushes: 3, moves: 10 },
      { pushes: 5, moves: 6 },
    ];
    const result = boundedParetoRecords(records, 5);
    assert.equal(result.length, 2);
  });

  it("keeps best-push and best-move when limit is 2", () => {
    const records = [
      { pushes: 3, moves: 10 },
      { pushes: 5, moves: 6 },
      { pushes: 4, moves: 8 },
    ];
    const result = boundedParetoRecords(records, 2);
    assert.equal(result.length, 2);
    assert.ok(result.some((r) => r.pushes === 3 && r.moves === 10));
    assert.ok(result.some((r) => r.pushes === 5 && r.moves === 6));
  });

  it("limit 1 returns best push record", () => {
    const records = [
      { pushes: 5, moves: 2 },
      { pushes: 3, moves: 10 },
    ];
    const result = boundedParetoRecords(records, 1);
    assert.equal(result.length, 1);
    assert.equal(result[0].pushes, 3);
  });
});

describe("BoundedParetoMap", () => {
  it("accepts a non-dominated pair", () => {
    const map = new BoundedParetoMap(100);
    assert.ok(map.set("k", 3, 10));
    assert.equal(map.size, 1);
  });

  it("rejects a dominated pair", () => {
    const map = new BoundedParetoMap(100);
    map.set("k", 3, 5);
    assert.ok(!map.set("k", 3, 6));
    assert.ok(!map.set("k", 4, 5));
    assert.ok(!map.set("k", 4, 6));
  });

  it("reports dominance correctly", () => {
    const map = new BoundedParetoMap(100);
    map.set("k", 3, 5);
    assert.ok(map.isDominated("k", 3, 6));
    assert.ok(map.isDominated("k", 4, 5));
    assert.ok(!map.isDominated("k", 2, 6));
    assert.ok(!map.isDominated("k", 4, 4));
  });

  it("(3,5) does not dominate (4,4)", () => {
    const map = new BoundedParetoMap(100);
    map.set("k", 3, 5);
    assert.ok(!map.isDominated("k", 4, 4));
  });

  it("removes dominated records when a better pair arrives", () => {
    const map = new BoundedParetoMap(100);
    map.set("k", 5, 10);
    map.set("k", 4, 8);
    assert.ok(!map.hasPair("k", 5, 10));
    assert.ok(map.hasPair("k", 4, 8));
  });

  it("maintains Pareto front with incomparable pairs", () => {
    const map = new BoundedParetoMap(100);
    map.set("k", 3, 10);
    map.set("k", 5, 6);
    assert.ok(map.hasPair("k", 3, 10));
    assert.ok(map.hasPair("k", 5, 6));
  });

  it("evicts oldest key when at capacity", () => {
    const map = new BoundedParetoMap(3);
    map.set("a", 1, 1);
    map.set("b", 2, 2);
    map.set("c", 3, 3);
    assert.equal(map.size, 3);
    assert.equal(map.evictions, 0);
    map.set("d", 4, 4);
    assert.equal(map.size, 3);
    assert.equal(map.evictions, 1);
    assert.ok(!map.hasPair("a", 1, 1));
    assert.ok(map.hasPair("d", 4, 4));
  });

  it("LRU access refreshes key", () => {
    const map = new BoundedParetoMap(3);
    map.set("a", 1, 1);
    map.set("b", 2, 2);
    map.set("c", 3, 3);
    map.isDominated("a", 99, 99);
    map.set("d", 4, 4);
    assert.ok(map.hasPair("a", 1, 1));
    assert.ok(!map.hasPair("b", 2, 2));
  });

  it("per-key limit bounds records via boundedParetoRecords", () => {
    const map = new BoundedParetoMap(100, 2);
    map.set("k", 1, 10);
    map.set("k", 10, 1);
    map.set("k", 5, 5);
    const count = [
      map.hasPair("k", 1, 10),
      map.hasPair("k", 10, 1),
      map.hasPair("k", 5, 5),
    ].filter(Boolean).length;
    assert.ok(count <= 2);
  });

  it("separate keys are independent", () => {
    const map = new BoundedParetoMap(100);
    map.set("a", 3, 5);
    map.set("b", 4, 4);
    assert.ok(!map.isDominated("a", 4, 4));
    assert.ok(!map.isDominated("b", 3, 5));
  });
});
