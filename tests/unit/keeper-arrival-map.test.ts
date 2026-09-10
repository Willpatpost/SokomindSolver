import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BoundedKeeperArrivalMap,
  selectKeeperArrivals,
} from "../../src/solver/search/keeper-arrival-map.ts";
import type { ArrivalRecord } from "../../src/solver/search/keeper-arrival-map.ts";

function makeRecord(
  overrides: Partial<ArrivalRecord> & { exactIdentity: string },
): ArrivalRecord {
  return {
    cost: 10,
    moves: 20,
    score: 0,
    approachDistance: 5,
    approachSide: "0,1",
    token: `${overrides.exactIdentity}|${overrides.cost ?? 10}|${overrides.moves ?? 20}`,
    ...overrides,
  };
}

describe("selectKeeperArrivals", () => {
  it("returns all records when under limit", () => {
    const records = [
      makeRecord({ exactIdentity: "a" }),
      makeRecord({ exactIdentity: "b" }),
    ];
    const result = selectKeeperArrivals(records, 5);
    assert.equal(result.length, 2);
  });

  it("prioritizes best cost first", () => {
    const records = [
      makeRecord({ exactIdentity: "a", cost: 10, moves: 20, approachDistance: 5 }),
      makeRecord({ exactIdentity: "b", cost: 5, moves: 30, approachDistance: 10 }),
      makeRecord({ exactIdentity: "c", cost: 8, moves: 15, approachDistance: 3 }),
    ];
    const result = selectKeeperArrivals(records, 1);
    assert.equal(result.length, 1);
    assert.equal(result[0].exactIdentity, "b");
  });

  it("second slot is best moves+approach", () => {
    const records = [
      makeRecord({ exactIdentity: "a", cost: 5, moves: 20, approachDistance: 10, approachSide: "0,1" }),
      makeRecord({ exactIdentity: "b", cost: 10, moves: 5, approachDistance: 3, approachSide: "0,1" }),
    ];
    const result = selectKeeperArrivals(records, 2);
    assert.equal(result.length, 2);
    assert.equal(result[0].exactIdentity, "a");
    assert.equal(result[1].exactIdentity, "b");
  });

  it("includes side diversity", () => {
    const records = [
      makeRecord({ exactIdentity: "a", cost: 5, moves: 10, approachDistance: 3, approachSide: "0,1" }),
      makeRecord({ exactIdentity: "b", cost: 5, moves: 10, approachDistance: 3, approachSide: "0,1" }),
      makeRecord({ exactIdentity: "c", cost: 6, moves: 12, approachDistance: 4, approachSide: "1,0" }),
    ];
    const result = selectKeeperArrivals(records, 3);
    assert.ok(result.some((r) => r.approachSide === "1,0"));
  });
});

describe("BoundedKeeperArrivalMap", () => {
  it("wouldRetain accepts a novel candidate", () => {
    const map = new BoundedKeeperArrivalMap(100);
    const candidate = {
      exactIdentity: "state-a",
      cost: 5,
      moves: 10,
      score: 0,
      approachDistance: 3,
      approachSide: "0,1",
    };
    assert.ok(map.wouldRetain("k", candidate));
  });

  it("wouldRetain rejects a dominated candidate", () => {
    const map = new BoundedKeeperArrivalMap(100);
    map.set("k", {
      exactIdentity: "state-a",
      cost: 3,
      moves: 5,
      score: 0,
      approachDistance: 2,
      approachSide: "0,1",
    });
    assert.ok(
      !map.wouldRetain("k", {
        exactIdentity: "state-a",
        cost: 4,
        moves: 6,
        score: 0,
        approachDistance: 3,
        approachSide: "0,1",
      }),
    );
  });

  it("set stores and deduplicates records", () => {
    const map = new BoundedKeeperArrivalMap(100);
    const candidate = {
      exactIdentity: "state-a",
      cost: 5,
      moves: 10,
      score: 0,
      approachDistance: 3,
      approachSide: "0,1",
    };
    map.set("k", candidate);
    map.set("k", candidate);
    assert.equal(map.size, 1);
    const records = map.values.get("k")!;
    assert.equal(records.length, 1);
  });

  it("evicts oldest key when at capacity", () => {
    const map = new BoundedKeeperArrivalMap(2);
    map.set("a", {
      exactIdentity: "s1", cost: 1, moves: 1, score: 0,
      approachDistance: 1, approachSide: "0,1",
    });
    map.set("b", {
      exactIdentity: "s2", cost: 2, moves: 2, score: 0,
      approachDistance: 2, approachSide: "1,0",
    });
    map.set("c", {
      exactIdentity: "s3", cost: 3, moves: 3, score: 0,
      approachDistance: 3, approachSide: "0,-1",
    });
    assert.equal(map.size, 2);
    assert.equal(map.evictions, 1);
    assert.ok(!map.values.has("a"));
  });

  it("LRU access refreshes key", () => {
    const map = new BoundedKeeperArrivalMap(2);
    map.set("a", {
      exactIdentity: "s1", cost: 1, moves: 1, score: 0,
      approachDistance: 1, approachSide: "0,1",
    });
    map.set("b", {
      exactIdentity: "s2", cost: 2, moves: 2, score: 0,
      approachDistance: 2, approachSide: "1,0",
    });
    map.wouldRetain("a", {
      exactIdentity: "s3", cost: 99, moves: 99, score: 0,
      approachDistance: 99, approachSide: "0,1",
    });
    map.set("c", {
      exactIdentity: "s4", cost: 3, moves: 3, score: 0,
      approachDistance: 3, approachSide: "0,-1",
    });
    assert.ok(map.values.has("a"));
    assert.ok(!map.values.has("b"));
  });

  it("removes dominated records for same exactIdentity on set", () => {
    const map = new BoundedKeeperArrivalMap(100);
    map.set("k", {
      exactIdentity: "state-a",
      cost: 10,
      moves: 20,
      score: 0,
      approachDistance: 5,
      approachSide: "0,1",
    });
    map.set("k", {
      exactIdentity: "state-a",
      cost: 5,
      moves: 10,
      score: 0,
      approachDistance: 3,
      approachSide: "0,1",
    });
    const records = map.values.get("k")!;
    assert.ok(!records.some((r) => r.cost === 10 && r.moves === 20));
    assert.ok(records.some((r) => r.cost === 5 && r.moves === 10));
  });

  it("separate keys are independent", () => {
    const map = new BoundedKeeperArrivalMap(100);
    map.set("a", {
      exactIdentity: "s1", cost: 3, moves: 5, score: 0,
      approachDistance: 2, approachSide: "0,1",
    });
    assert.ok(
      map.wouldRetain("b", {
        exactIdentity: "s1", cost: 4, moves: 6, score: 0,
        approachDistance: 3, approachSide: "0,1",
      }),
    );
  });
});
