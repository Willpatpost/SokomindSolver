import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import {
  AppDataResetError,
  installCrossTabAppResetListener,
  resetAppData,
} from "../../src/shared/app-data-reset.ts";
import { recordCompletion, type ProgressData } from "../../src/shared/progress.ts";
import { getPuzzleById } from "../../src/catalog/puzzles.ts";
import { createSession } from "../../src/core/index.ts";
import { saveOptimalCache } from "../../src/shared/optimal-cache.ts";
import { saveSession } from "../../src/shared/session-persistence.ts";
import {
  loadProgressSyncSnapshot,
  persistProgressUpdate,
  writeProgressSyncSnapshot,
  type ProgressSyncSnapshot,
} from "../../src/shared/progress-sync.ts";
import {
  APP_STORAGE_KEYS,
  STORAGE_KEYS,
  parseAppResetMarker,
} from "../../src/shared/storage.ts";
import { IDB_RESET_GENERATION_KEY } from "../../src/shared/idb-storage.ts";
import {
  createMemoryIndexedDB,
  installIndexedDB,
} from "../support/memory-indexeddb.ts";

function createMockStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

function progress(): ProgressData {
  return {
    version: 1,
    completed: {
      old: {
        moves: 10,
        pushes: 3,
        completedAt: "2026-08-01T00:00:00.000Z",
      },
    },
  };
}

function createFailingStorage(options: {
  readonly removeKey?: string;
  readonly writeKey?: string;
}): Storage {
  const storage = createMockStorage();
  return {
    get length() {
      return storage.length;
    },
    clear: () => storage.clear(),
    getItem: (key) => storage.getItem(key),
    key: (index) => storage.key(index),
    removeItem: (key) => {
      if (key === options.removeKey) {
        throw new DOMException("remove blocked", "SecurityError");
      }
      storage.removeItem(key);
    },
    setItem: (key, value) => {
      if (key === options.writeKey) {
        throw new DOMException("write blocked", "SecurityError");
      }
      storage.setItem(key, value);
    },
  };
}

let localStorage: Storage;
let sessionStorage: Storage;
let restoreIndexedDB: (() => void) | undefined;

beforeEach(() => {
  localStorage = createMockStorage();
  sessionStorage = createMockStorage();
  (globalThis as Record<string, unknown>).window = {
    localStorage,
    sessionStorage,
  };
});

afterEach(() => {
  restoreIndexedDB?.();
  restoreIndexedDB = undefined;
  Reflect.deleteProperty(globalThis as Record<string, unknown>, "window");
});

function removeIndexedDB(): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Reflect.deleteProperty(globalThis, "indexedDB");
  restoreIndexedDB = () => {
    if (descriptor) Object.defineProperty(globalThis, "indexedDB", descriptor);
  };
}

test("app-data reset retains a generation tombstone and clears owned timers", async () => {
  removeIndexedDB();
  const staleSnapshot: ProgressSyncSnapshot = {
    generation: 3,
    revision: 8,
    writerId: "stale-tab",
    progress: progress(),
  };
  writeProgressSyncSnapshot(staleSnapshot);
  for (const key of APP_STORAGE_KEYS) {
    if (key !== STORAGE_KEYS.progress) localStorage.setItem(key, "owned");
  }
  localStorage.setItem("sokomind.future-key", "keep");
  sessionStorage.setItem("sokomind:timer", "1000");
  sessionStorage.setItem("sokomind:timer:ultra-tiny", "2000");
  sessionStorage.setItem("sokomind:timer-adjacent", "keep");

  const reset = await resetAppData();

  assert.equal(reset.result.ok, true);
  assert.equal(reset.snapshot.generation, 4);
  assert.deepEqual(reset.snapshot.progress.completed, {});
  for (const key of APP_STORAGE_KEYS) {
    if (key !== STORAGE_KEYS.progress && key !== STORAGE_KEYS.reset) {
      assert.equal(localStorage.getItem(key), null);
    }
  }
  assert.equal(
    parseAppResetMarker(localStorage.getItem(STORAGE_KEYS.reset))?.generation,
    1,
  );
  assert.equal(localStorage.getItem("sokomind.future-key"), "keep");
  assert.equal(sessionStorage.getItem("sokomind:timer"), null);
  assert.equal(sessionStorage.getItem("sokomind:timer:ultra-tiny"), null);
  assert.equal(sessionStorage.getItem("sokomind:timer-adjacent"), "keep");

  const staleUpdate = persistProgressUpdate(
    staleSnapshot,
    "stale-tab",
    (current) => recordCompletion(current, "fresh", 7, 2),
  );
  assert.equal(staleUpdate.snapshot.generation, 4);
  assert.deepEqual(Object.keys(staleUpdate.snapshot.progress.completed), ["fresh"]);
  assert.equal(loadProgressSyncSnapshot().progress.completed.old, undefined);
});

test("app-data reset clears the committed IndexedDB store", async () => {
  const memory = createMemoryIndexedDB([
    [STORAGE_KEYS.session, { stale: "session" }],
    [STORAGE_KEYS.optimal, { stale: "optimal" }],
  ]);
  restoreIndexedDB = installIndexedDB(memory.factory);

  const reset = await resetAppData();

  assert.equal(reset.result.ok, true);
  assert.deepEqual([...memory.values], [[IDB_RESET_GENERATION_KEY, 1]]);
  assert.equal(
    parseAppResetMarker(localStorage.getItem(STORAGE_KEYS.reset))?.generation,
    1,
  );
  assert.equal(memory.stats.clears, 1);
  assert.equal(memory.stats.opens, memory.stats.closes);
});

test("reset clears writes made while its IndexedDB transaction is pending", async () => {
  let releaseOpen!: () => void;
  const openGate = new Promise<void>((resolve) => {
    releaseOpen = resolve;
  });
  const memory = createMemoryIndexedDB([], {
    beforeOpenSuccess: (openNumber) => openNumber === 1 ? openGate : undefined,
  });
  restoreIndexedDB = installIndexedDB(memory.factory);

  const resetting = resetAppData();
  assert.equal(memory.stats.opens, 1);
  localStorage.setItem(STORAGE_KEYS.session, "written-during-idb-reset");
  localStorage.setItem(STORAGE_KEYS.optimal, "written-during-idb-reset");
  releaseOpen();
  await resetting;

  assert.equal(localStorage.getItem(STORAGE_KEYS.session), null);
  assert.equal(localStorage.getItem(STORAGE_KEYS.optimal), null);
});

test("the completed reset marker suppresses stale document mutations", async () => {
  const memory = createMemoryIndexedDB();
  restoreIndexedDB = installIndexedDB(memory.factory);
  await resetAppData();

  const puzzle = getPuzzleById("ultra-tiny");
  assert.ok(puzzle);
  saveSession(createSession(puzzle));
  saveOptimalCache({
    version: 3,
    records: { "ultra-tiny": { moves: 1, pushes: 1 } },
  });

  assert.equal(localStorage.getItem(STORAGE_KEYS.session), null);
  assert.equal(localStorage.getItem(STORAGE_KEYS.optimal), null);
  assert.deepEqual([...memory.values], [[IDB_RESET_GENERATION_KEY, 1]]);
});

test("app-data reset propagates real IndexedDB failures without broadcasting completion", async () => {
  const request = {
    error: new DOMException("open failed", "UnknownError"),
    onupgradeneeded: null,
    onsuccess: null,
    onerror: null as ((event: Event) => void) | null,
    onblocked: null,
  };
  restoreIndexedDB = installIndexedDB({
    open: () => {
      queueMicrotask(() => request.onerror?.(new Event("error")));
      return request as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory);
  localStorage.setItem(STORAGE_KEYS.session, "owned");

  await assert.rejects(resetAppData(), /failed to open/i);

  assert.equal(localStorage.getItem(STORAGE_KEYS.session), null);
  assert.ok(localStorage.getItem(STORAGE_KEYS.progress));
  assert.equal(localStorage.getItem(STORAGE_KEYS.reset), null);
});

test("app-data reset rejects when an owned localStorage key cannot be removed", async () => {
  removeIndexedDB();
  localStorage = createFailingStorage({ removeKey: STORAGE_KEYS.session });
  (globalThis as Record<string, unknown>).window = {
    localStorage,
    sessionStorage,
  };
  localStorage.setItem(STORAGE_KEYS.session, "owned");

  await assert.rejects(
    resetAppData(),
    (error: unknown) => {
      assert.ok(error instanceof AppDataResetError);
      assert.ok(error.storageFailures.some((failure) =>
        failure.key === STORAGE_KEYS.session && failure.operation === "remove"));
      return true;
    },
  );
  assert.equal(localStorage.getItem(STORAGE_KEYS.session), "owned");
  assert.equal(localStorage.getItem(STORAGE_KEYS.reset), null);
});

test("app-data reset rejects when the progress tombstone cannot be written", async () => {
  removeIndexedDB();
  localStorage = createFailingStorage({ writeKey: STORAGE_KEYS.progress });
  (globalThis as Record<string, unknown>).window = {
    localStorage,
    sessionStorage,
  };

  await assert.rejects(
    resetAppData(),
    (error: unknown) => {
      assert.ok(error instanceof AppDataResetError);
      assert.ok(error.storageFailures.some((failure) =>
        failure.key === STORAGE_KEYS.progress && failure.operation === "write"));
      return true;
    },
  );
  assert.equal(localStorage.getItem(STORAGE_KEYS.progress), null);
  assert.equal(localStorage.getItem(STORAGE_KEYS.reset), null);
});

test("app-data reset rejects when the cross-tab marker cannot be written", async () => {
  removeIndexedDB();
  localStorage = createFailingStorage({ writeKey: STORAGE_KEYS.reset });
  (globalThis as Record<string, unknown>).window = {
    localStorage,
    sessionStorage,
  };

  await assert.rejects(
    resetAppData(),
    (error: unknown) => {
      assert.ok(error instanceof AppDataResetError);
      assert.ok(error.storageFailures.some((failure) =>
        failure.key === STORAGE_KEYS.reset && failure.operation === "write"));
      return true;
    },
  );
  assert.ok(localStorage.getItem(STORAGE_KEYS.progress));
  assert.equal(localStorage.getItem(STORAGE_KEYS.reset), null);
});

test("cross-tab reset events clear private timers and reload the clean entry", () => {
  const listeners = new Map<string, Set<EventListener>>();
  const replacements: string[] = [];
  (globalThis as Record<string, unknown>).window = {
    localStorage,
    sessionStorage,
    location: {
      href: "https://example.test/Sokomind/?source=test#/play/ultra-tiny",
      replace: (href: string) => replacements.push(href),
    },
    addEventListener: (type: string, listener: EventListener) => {
      const registered = listeners.get(type) ?? new Set<EventListener>();
      registered.add(listener);
      listeners.set(type, registered);
    },
    removeEventListener: (type: string, listener: EventListener) => {
      listeners.get(type)?.delete(listener);
    },
  };
  sessionStorage.setItem("sokomind:timer:ultra-tiny", "1000");
  sessionStorage.setItem("timer:unrelated", "keep");
  const dispose = installCrossTabAppResetListener();
  const storageListener = [...(listeners.get("storage") ?? [])][0];
  assert.ok(storageListener);

  storageListener({ key: "unrelated", newValue: "value" } as StorageEvent);
  storageListener({ key: STORAGE_KEYS.reset, newValue: null } as StorageEvent);
  assert.deepEqual(replacements, []);

  storageListener({
    key: STORAGE_KEYS.reset,
    newValue: JSON.stringify({
      version: 1,
      generation: 1,
      writerId: "reset-tab",
      resetAt: "2026-08-03T00:00:00.000Z",
    }),
  } as StorageEvent);
  assert.equal(sessionStorage.getItem("sokomind:timer:ultra-tiny"), null);
  assert.equal(sessionStorage.getItem("timer:unrelated"), "keep");
  assert.equal(replacements.length, 1);
  const replacement = new URL(replacements[0]);
  assert.equal(replacement.hash, "");
  assert.ok(replacement.searchParams.has("_r"));
  assert.equal(listeners.get("beforeunload")?.size, 1);
  assert.equal(listeners.get("pagehide")?.size, 1);

  dispose();
  assert.equal(listeners.get("storage")?.size, 0);
});
