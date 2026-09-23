import assert from "node:assert/strict";
import test from "node:test";

import {
  CURRENT_OPTIMAL_PROOF_REVISION,
  getOptimalRecord,
  hydrateOptimalCacheFromIDB,
  isOptimal,
  loadOptimalCache,
  mergeOptimalCaches,
  normalizeOptimalCache,
  saveOptimalCache,
  setOptimalRecord,
  type OptimalCache,
  type OptimalRecord,
} from "../../src/shared/optimal-cache.ts";
import { APP_STORAGE_KEYS, LEGACY_STORAGE_KEYS, STORAGE_KEYS } from "../../src/shared/storage.ts";
import {
  createMemoryIndexedDB,
  installIndexedDB,
} from "../support/memory-indexeddb.ts";

const EMPTY_CACHE: OptimalCache = { version: 7, proofRevision: CURRENT_OPTIMAL_PROOF_REVISION, records: {} };
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
  assert.equal(cache.version, 7);
});

test("invalidates optimal records from every prior cache schema", () => {
  for (const version of [1, 2, 3, 4, 5, 6]) {
    assert.deepEqual(normalizeOptimalCache({
      version,
      records: {
        staleProof: { moves: 15, pushes: 8 },
      },
    }), EMPTY_CACHE);
  }
});

test("invalidates schema-7 certificates from before the A* frontier correction", async () => {
  const stale = {
    version: 7,
    proofRevision: "exact-moves-post-pi-corral-v1",
    records: { [recordKey("forced-frontier", FIRST_FINGERPRINT)]: { moves: 9, pushes: 2 } },
  };
  const staleCache = stale as unknown as OptimalCache;
  const current = setOptimalRecord(EMPTY_CACHE, "other", SECOND_FINGERPRINT, { moves: 2, pushes: 1 });
  assert.deepEqual(normalizeOptimalCache(stale), EMPTY_CACHE);
  assert.deepEqual(mergeOptimalCaches(current, staleCache), current);
  assert.deepEqual(mergeOptimalCaches(staleCache, current), current);
  assert.equal(getOptimalRecord(staleCache, "forced-frontier", FIRST_FINGERPRINT), undefined);
  assert.equal(isOptimal(staleCache, "forced-frontier", FIRST_FINGERPRINT, 9), false);
  const corrected = setOptimalRecord(staleCache, "other", SECOND_FINGERPRINT, { moves: 2, pushes: 1 });
  assert.deepEqual(corrected, current);

  const memory = createMemoryIndexedDB();
  memory.values.set(STORAGE_KEYS.optimal, stale);
  const restore = installIndexedDB(memory.factory);
  try {
    assert.deepEqual(await hydrateOptimalCacheFromIDB(current), current);
    const saved = saveOptimalCache(current);
    assert.equal(await saved.durable, true);
    assert.deepEqual(normalizeOptimalCache(memory.values.get(STORAGE_KEYS.optimal)), current);
  } finally {
    restore();
  }
});

test("invalidates schema-7 certificates from before the tunnel-macro soundness fix", async () => {
  const staleRevision = "exact-moves-astar-frontier-v2";
  assert.notEqual(CURRENT_OPTIMAL_PROOF_REVISION, staleRevision);
  const stale = {
    version: 7,
    proofRevision: staleRevision,
    records: { [recordKey("tunnel-prune", FIRST_FINGERPRINT)]: { moves: 22, pushes: 5 } },
  };
  const staleCache = stale as unknown as OptimalCache;
  const current = setOptimalRecord(EMPTY_CACHE, "other", SECOND_FINGERPRINT, { moves: 2, pushes: 1 });
  // The same record is valid under the current revision, so only the revision rejects it.
  assert.deepEqual(
    normalizeOptimalCache({ ...stale, proofRevision: CURRENT_OPTIMAL_PROOF_REVISION }).records,
    stale.records,
  );
  assert.deepEqual(normalizeOptimalCache(stale), EMPTY_CACHE);
  assert.deepEqual(mergeOptimalCaches(current, staleCache), current);
  assert.deepEqual(mergeOptimalCaches(staleCache, current), current);
  assert.equal(getOptimalRecord(staleCache, "tunnel-prune", FIRST_FINGERPRINT), undefined);
  assert.equal(isOptimal(staleCache, "tunnel-prune", FIRST_FINGERPRINT, 22), false);
  const corrected = setOptimalRecord(staleCache, "other", SECOND_FINGERPRINT, { moves: 2, pushes: 1 });
  assert.deepEqual(corrected, current);

  const memory = createMemoryIndexedDB();
  memory.values.set(STORAGE_KEYS.optimal, stale);
  const restore = installIndexedDB(memory.factory);
  try {
    assert.deepEqual(await hydrateOptimalCacheFromIDB(current), current);
    const saved = saveOptimalCache(current);
    assert.equal(await saved.durable, true);
    assert.deepEqual(normalizeOptimalCache(memory.values.get(STORAGE_KEYS.optimal)), current);
  } finally {
    restore();
  }
});

test("invalidates certificates from before the pattern-deadlock key fix", () => {
  const staleRevision = "exact-moves-tunnel-sound-v1";
  assert.notEqual(CURRENT_OPTIMAL_PROOF_REVISION, staleRevision);
  const stale = {
    version: 7,
    proofRevision: staleRevision,
    records: { [recordKey("pattern-key", FIRST_FINGERPRINT)]: { moves: 73, pushes: 20 } },
  };
  assert.deepEqual(
    normalizeOptimalCache({ ...stale, proofRevision: CURRENT_OPTIMAL_PROOF_REVISION }).records,
    stale.records,
  );
  assert.deepEqual(normalizeOptimalCache(stale), EMPTY_CACHE);
  assert.equal(isOptimal(stale as unknown as OptimalCache, "pattern-key", FIRST_FINGERPRINT, 73), false);
});

test("invalidates certificates proven with the goal-cut heuristic on by default", () => {
  const staleRevision = "exact-moves-pattern-key-v1";
  assert.notEqual(CURRENT_OPTIMAL_PROOF_REVISION, staleRevision);
  const stale = {
    version: 7,
    proofRevision: staleRevision,
    records: { [recordKey("goal-cut", FIRST_FINGERPRINT)]: { moves: 20, pushes: 7 } },
  };
  assert.deepEqual(
    normalizeOptimalCache({ ...stale, proofRevision: CURRENT_OPTIMAL_PROOF_REVISION }).records,
    stale.records,
  );
  assert.deepEqual(normalizeOptimalCache(stale), EMPTY_CACHE);
  assert.equal(isOptimal(stale as unknown as OptimalCache, "goal-cut", FIRST_FINGERPRINT, 20), false);
});

test("old tabs cannot overwrite corrected proof storage or affect progress and routes", () => {
  const oldKey = "sokomind.optimal.v7";
  assert.equal(LEGACY_STORAGE_KEYS.optimalV7, oldKey);
  assert.ok(APP_STORAGE_KEYS.includes(oldKey), "reset still clears the obsolete key");
  assert.ok(APP_STORAGE_KEYS.includes(LEGACY_STORAGE_KEYS.optimalV6));
  assert.notEqual(STORAGE_KEYS.optimal, oldKey);
  const stale = JSON.stringify({ version: 7, proofRevision: "exact-moves-pattern-key-v1",
    records: { [recordKey("forced-frontier", FIRST_FINGERPRINT)]: { moves: 9, pushes: 2 } } });
  const values = new Map<string, string>([
    [oldKey, stale],
    [STORAGE_KEYS.optimal, stale],
    [STORAGE_KEYS.progress, "preserve-progress"],
    [STORAGE_KEYS.personalBestRoutes, "preserve-routes"],
  ]);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } } });
  try {
    assert.deepEqual(loadOptimalCache(), EMPTY_CACHE);
    const current = setOptimalRecord(EMPTY_CACHE, "forced-frontier", FIRST_FINGERPRINT, { moves: 7, pushes: 2 });
    assert.equal(saveOptimalCache(current).ok, true);
    values.set(oldKey, stale); // Simulate an already-open, uncorrected tab writing again.
    assert.deepEqual(loadOptimalCache(), current);
    assert.equal(values.get(STORAGE_KEYS.progress), "preserve-progress");
    assert.equal(values.get(STORAGE_KEYS.personalBestRoutes), "preserve-routes");
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("current cache parsing drops malformed records safely", () => {
  const normalized = normalizeOptimalCache({
    version: 7, proofRevision: CURRENT_OPTIMAL_PROOF_REVISION,
    records: {
      [recordKey("valid", FIRST_FINGERPRINT)]: { moves: 11, pushes: 4 },
      malformedKey: { moves: 9, pushes: 3 },
      impossible: { moves: 2, pushes: 3 },
      fractional: { moves: 4.5, pushes: 2 },
      obsolete: { moves: 8, pushes: 3, objective: "pushes" },
    },
  });

  assert.deepEqual(normalized, {
    version: 7, proofRevision: CURRENT_OPTIMAL_PROOF_REVISION,
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
      version: 7, proofRevision: CURRENT_OPTIMAL_PROOF_REVISION,
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
