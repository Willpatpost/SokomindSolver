import assert from "node:assert/strict";
import test from "node:test";

import {
  isOptimal,
  loadOptimalCache,
  mergeOptimalCaches,
  normalizeOptimalCache,
  saveOptimalCache,
  setOptimalRecord,
  type OptimalCache,
  type OptimalRecord,
} from "../../src/shared/optimal-cache.ts";

const EMPTY_CACHE: OptimalCache = { version: 3, records: {} };

test("isOptimal compares only the proven move count", () => {
  assert.equal(isOptimal(EMPTY_CACHE, "missing", 10), false);

  const record: OptimalRecord = { moves: 15, pushes: 10 };
  const cache = setOptimalRecord(EMPTY_CACHE, "p1", record);
  assert.equal(isOptimal(cache, "p1", 15), true);
  assert.equal(isOptimal(cache, "p1", 14), true);
  assert.equal(isOptimal(cache, "p1", 16), false);
});

test("setOptimalRecord creates, overwrites, and preserves entries", () => {
  const first: OptimalRecord = { moves: 20, pushes: 10 };
  const replacement: OptimalRecord = { moves: 18, pushes: 9 };
  const other: OptimalRecord = { moves: 12, pushes: 4 };

  let cache = setOptimalRecord(EMPTY_CACHE, "p1", first);
  assert.deepEqual(cache.records["p1"], first);
  cache = setOptimalRecord(cache, "p1", replacement);
  cache = setOptimalRecord(cache, "p2", other);

  assert.deepEqual(cache.records["p1"], replacement);
  assert.deepEqual(cache.records["p2"], other);
  assert.equal(cache.version, 3);
});

test("invalidates optimal records from pre-proof cache schemas", () => {
  for (const version of [1, 2]) {
    assert.deepEqual(normalizeOptimalCache({
      version,
      records: {
        staleProof: { moves: 15, pushes: 8 },
      },
    }), EMPTY_CACHE);
  }
});

test("current cache parsing drops malformed records safely", () => {
  const normalized = normalizeOptimalCache({
    version: 3,
    records: {
      valid: { moves: 11, pushes: 4 },
      impossible: { moves: 2, pushes: 3 },
      fractional: { moves: 4.5, pushes: 2 },
      obsolete: { moves: 8, pushes: 3, objective: "pushes" },
    },
  });

  assert.deepEqual(normalized, {
    version: 3,
    records: {
      valid: { moves: 11, pushes: 4 },
    },
  });
  assert.deepEqual(normalizeOptimalCache({ version: 99, records: {} }), EMPTY_CACHE);
});

test("merges stale tab snapshots without losing either proof", () => {
  const first = setOptimalRecord(EMPTY_CACHE, "p1", { moves: 20, pushes: 8 });
  const second = setOptimalRecord(EMPTY_CACHE, "p2", { moves: 12, pushes: 5 });
  const merged = mergeOptimalCaches(first, second);

  assert.deepEqual(merged.records, {
    p1: { moves: 20, pushes: 8 },
    p2: { moves: 12, pushes: 5 },
  });
  assert.deepEqual(
    mergeOptimalCaches(merged, {
      version: 3,
      records: { p1: { moves: 18, pushes: 9 } },
    }).records.p1,
    { moves: 18, pushes: 9 },
  );
});

test("save re-reads storage before writing a stale tab snapshot", () => {
  const values = new Map<string, string>();
  const localStorage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  } satisfies Storage;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage },
  });

  try {
    const first = setOptimalRecord(EMPTY_CACHE, "p1", { moves: 20, pushes: 8 });
    saveOptimalCache(first);
    const staleSecond = setOptimalRecord(
      EMPTY_CACHE,
      "p2",
      { moves: 12, pushes: 5 },
    );
    const saved = saveOptimalCache(staleSecond).cache;

    assert.deepEqual(Object.keys(saved.records).sort(), ["p1", "p2"]);
    assert.deepEqual(Object.keys(loadOptimalCache().records).sort(), ["p1", "p2"]);
  } finally {
    Reflect.deleteProperty(globalThis, "window");
  }
});
