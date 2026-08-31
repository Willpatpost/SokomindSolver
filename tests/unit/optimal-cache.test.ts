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
import { STORAGE_KEYS } from "../../src/shared/storage.ts";
import {
  createMemoryIndexedDB,
  installIndexedDB,
} from "../support/memory-indexeddb.ts";

const EMPTY_CACHE: OptimalCache = { version: 6, records: {} };
const FIRST_FINGERPRINT = "puzzle-v1:11111111";
const SECOND_FINGERPRINT = "puzzle-v1:22222222";
const recordKey = (puzzleId: string, fingerprint: string) =>
  JSON.stringify([puzzleId, fingerprint]);

test("isOptimal compares only the proven move count", () => {
  assert.equal(isOptimal(EMPTY_CACHE, "missing", FIRST_FINGERPRINT, 10), false);

  const record: OptimalRecord = { moves: 15, pushes: 10 };
  const cache = setOptimalRecord(EMPTY_CACHE, "p1", FIRST_FINGERPRINT, record);
  assert.equal(isOptimal(cache, "p1", FIRST_FINGERPRINT, 15), true);
  assert.equal(isOptimal(cache, "p1", FIRST_FINGERPRINT, 14), true);
  assert.equal(isOptimal(cache, "p1", FIRST_FINGERPRINT, 16), false);
  assert.equal(isOptimal(cache, "p1", SECOND_FINGERPRINT, 15), false);
});

test("setOptimalRecord creates, overwrites, and preserves entries", () => {
  const first: OptimalRecord = { moves: 20, pushes: 10 };
  const replacement: OptimalRecord = { moves: 18, pushes: 9 };
  const other: OptimalRecord = { moves: 12, pushes: 4 };

  let cache = setOptimalRecord(EMPTY_CACHE, "p1", FIRST_FINGERPRINT, first);
  assert.deepEqual(cache.records[recordKey("p1", FIRST_FINGERPRINT)], first);
  cache = setOptimalRecord(cache, "p1", FIRST_FINGERPRINT, replacement);
  cache = setOptimalRecord(cache, "p2", SECOND_FINGERPRINT, other);

  assert.deepEqual(cache.records[recordKey("p1", FIRST_FINGERPRINT)], replacement);
  assert.deepEqual(cache.records[recordKey("p2", SECOND_FINGERPRINT)], other);
  assert.equal(cache.version, 6);
});

test("invalidates optimal records from every prior cache schema", () => {
  for (const version of [1, 2, 3, 4, 5]) {
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
    version: 6,
    records: {
      [recordKey("valid", FIRST_FINGERPRINT)]: { moves: 11, pushes: 4 },
      malformedKey: { moves: 9, pushes: 3 },
      impossible: { moves: 2, pushes: 3 },
      fractional: { moves: 4.5, pushes: 2 },
      obsolete: { moves: 8, pushes: 3, objective: "pushes" },
    },
  });

  assert.deepEqual(normalized, {
    version: 6,
    records: {
      [recordKey("valid", FIRST_FINGERPRINT)]: { moves: 11, pushes: 4 },
    },
  });
  assert.deepEqual(normalizeOptimalCache({ version: 99, records: {} }), EMPTY_CACHE);
});

test("merges stale tab snapshots without losing either proof", () => {
  const first = setOptimalRecord(
    EMPTY_CACHE,
    "p1",
    FIRST_FINGERPRINT,
    { moves: 20, pushes: 8 },
  );
  const second = setOptimalRecord(
    EMPTY_CACHE,
    "p2",
    SECOND_FINGERPRINT,
    { moves: 12, pushes: 5 },
  );
  const merged = mergeOptimalCaches(first, second);

  assert.deepEqual(merged.records, {
    [recordKey("p1", FIRST_FINGERPRINT)]: { moves: 20, pushes: 8 },
    [recordKey("p2", SECOND_FINGERPRINT)]: { moves: 12, pushes: 5 },
  });
  assert.deepEqual(
    mergeOptimalCaches(merged, {
      version: 6,
      records: {
        [recordKey("p1", FIRST_FINGERPRINT)]: { moves: 18, pushes: 9 },
      },
    }).records[recordKey("p1", FIRST_FINGERPRINT)],
    { moves: 18, pushes: 9 },
  );
});

test("keeps different revisions independent when tabs merge", () => {
  const oldRevision = setOptimalRecord(
    EMPTY_CACHE,
    "p1",
    FIRST_FINGERPRINT,
    { moves: 30, pushes: 8 },
  );
  const currentRevision = setOptimalRecord(
    EMPTY_CACHE,
    "p1",
    SECOND_FINGERPRINT,
    { moves: 20, pushes: 7 },
  );
  const merged = mergeOptimalCaches(oldRevision, currentRevision);

  assert.equal(isOptimal(merged, "p1", FIRST_FINGERPRINT, 25), true);
  assert.equal(isOptimal(merged, "p1", SECOND_FINGERPRINT, 25), false);
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
    const first = setOptimalRecord(
      EMPTY_CACHE,
      "p1",
      FIRST_FINGERPRINT,
      { moves: 20, pushes: 8 },
    );
    saveOptimalCache(first);
    const staleSecond = setOptimalRecord(
      EMPTY_CACHE,
      "p2",
      SECOND_FINGERPRINT,
      { moves: 12, pushes: 5 },
    );
    const saved = saveOptimalCache(staleSecond).cache;

    const expectedKeys = [
      recordKey("p1", FIRST_FINGERPRINT),
      recordKey("p2", SECOND_FINGERPRINT),
    ].sort();
    assert.deepEqual(Object.keys(saved.records).sort(), expectedKeys);
    assert.deepEqual(Object.keys(loadOptimalCache().records).sort(), expectedKeys);
  } finally {
    Reflect.deleteProperty(globalThis, "window");
  }
});

test("reports durable success when IndexedDB saves after localStorage fails", async () => {
  const memory = createMemoryIndexedDB();
  const restoreIndexedDB = installIndexedDB(memory.factory);
  try {
    const cache = setOptimalRecord(
      EMPTY_CACHE,
      "p1",
      FIRST_FINGERPRINT,
      { moves: 20, pushes: 8 },
    );
    const saved = saveOptimalCache(cache);

    assert.equal(saved.ok, false);
    assert.equal(await saved.durable, true);
    assert.deepEqual(
      normalizeOptimalCache(memory.values.get(STORAGE_KEYS.optimal)).records,
      cache.records,
    );
  } finally {
    restoreIndexedDB();
  }
});

test("reports failure when neither optimal-cache storage tier is available", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Reflect.deleteProperty(globalThis, "indexedDB");
  try {
    const cache = setOptimalRecord(
      EMPTY_CACHE,
      "p1",
      FIRST_FINGERPRINT,
      { moves: 20, pushes: 8 },
    );
    const saved = saveOptimalCache(cache);

    assert.equal(saved.ok, false);
    assert.equal(await saved.durable, false);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "indexedDB", descriptor);
  }
});
