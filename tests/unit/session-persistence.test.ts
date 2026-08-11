import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { PUZZLES, getPuzzleById } from "../../src/catalog/puzzles.ts";
import { createSession, move } from "../../src/core/index.ts";
import {
  clearSession,
  hydrateSessionFromIDB,
  loadSession,
  loadSessionPuzzleId,
  loadSessionPuzzleIdFromIDB,
  MAX_SAVED_SESSION_FUTURE_SKEW_MS,
  parseSavedSession,
  restoreSession,
  saveSession,
  type SavedSession,
} from "../../src/shared/session-persistence.ts";
import {
  LEGACY_STORAGE_KEYS,
  STORAGE_KEYS,
} from "../../src/shared/storage.ts";
import {
  createMemoryIndexedDB,
  flushIndexedDB,
  installIndexedDB,
} from "../support/memory-indexeddb.ts";

function createMockStorage(
  initial: Iterable<readonly [string, string]> = [],
): Storage {
  const values = new Map<string, string>(initial);
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

let restoreIndexedDB: (() => void) | undefined;

afterEach(() => {
  restoreIndexedDB?.();
  restoreIndexedDB = undefined;
  Reflect.deleteProperty(globalThis as Record<string, unknown>, "window");
});

function installEnvironment(
  indexedDB: IDBFactory,
  localStorage = createMockStorage(),
): Storage {
  restoreIndexedDB = installIndexedDB(indexedDB);
  (globalThis as Record<string, unknown>).window = { localStorage };
  return localStorage;
}

test("parses only versioned and bounded canonical saved sessions", () => {
  const parsed = parseSavedSession(
    JSON.stringify({
      version: 1,
      puzzleId: "first-steps",
      actionLog: "RRD",
      updatedAt: "2026-07-26T12:00:00.000Z",
    }),
  );

  assert.equal(parsed?.actionLog, "RRD");
  assert.equal(parseSavedSession("{"), null);
  assert.equal(parseSavedSession(JSON.stringify({
    version: 1,
    puzzleId: "first-steps",
    actionLog: "",
    updatedAt: "2026-08-03",
  })), null);
  assert.equal(parseSavedSession(JSON.stringify({
    version: 1,
    puzzleId: "first-steps",
    actionLog: "",
    updatedAt: "not-a-date",
  })), null);
  assert.equal(
    parseSavedSession(
      JSON.stringify({
        version: 1,
        puzzleId: "first-steps",
        actionLog: "RX",
        updatedAt: "",
      }),
    ),
    null,
  );
});

test("restores attempts by replaying every move through the game engine", () => {
  const puzzle = PUZZLES[0];
  assert.ok(puzzle);
  const live = move(move(move(
    // The first room's opening route is discovered from legal transitions
    // rather than trusting hand-authored snapshot data.
    restoreSession({
      version: 1,
      puzzleId: puzzle.id,
      actionLog: "",
      updatedAt: "",
    }, getPuzzleById)!,
    "right",
  ), "right"), "down");

  const saved: SavedSession = {
    version: 1,
    puzzleId: puzzle.id,
    actionLog: live.actionLog,
    updatedAt: new Date(0).toISOString(),
  };
  const restored = restoreSession(saved, getPuzzleById);

  assert.deepEqual(restored?.snapshot, live.snapshot);
  assert.equal(restored?.history.length, live.history.length);
});

test("rejects unknown puzzles and blocked stored actions", () => {
  assert.equal(
    restoreSession({
      version: 1,
      puzzleId: "missing",
      actionLog: "",
      updatedAt: "",
    }, getPuzzleById),
    null,
  );

  const puzzle = PUZZLES[0];
  assert.ok(puzzle);
  assert.equal(
    restoreSession({
      version: 1,
      puzzleId: puzzle.id,
      actionLog: "U",
      updatedAt: "",
    }, getPuzzleById),
    null,
  );
});

test("reads a known saved puzzle pointer without loading board data", () => {
  const values = new Map<string, string>([
    [STORAGE_KEYS.session, JSON.stringify({
      version: 1,
      puzzleId: "ultra-tiny",
      actionLog: "",
      updatedAt: "2026-08-02T00:00:00.000Z",
    })],
  ]);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
  } as Storage;
  (globalThis as Record<string, unknown>).window = { localStorage: storage };

  try {
    assert.equal(
      loadSessionPuzzleId((puzzleId) => puzzleId === "ultra-tiny"),
      "ultra-tiny",
    );
    assert.equal(loadSessionPuzzleId(() => false), null);
  } finally {
    Reflect.deleteProperty(globalThis as Record<string, unknown>, "window");
  }
});

test("hydrates a valid session stored only in IndexedDB", async () => {
  const memory = createMemoryIndexedDB([[
    STORAGE_KEYS.session,
    {
      version: 1,
      puzzleId: "ultra-tiny",
      actionLog: "D",
      updatedAt: "2026-08-03T12:00:00.000Z",
    },
  ]]);
  installEnvironment(memory.factory);

  const hydrated = await hydrateSessionFromIDB(getPuzzleById, null);

  assert.equal(hydrated?.session.puzzle.id, "ultra-tiny");
  assert.equal(hydrated?.session.actionLog, "D");
  assert.equal(hydrated?.session.moves, 1);
  assert.equal(hydrated?.resumed, true);
});

test("session hydration keeps newer local data and adopts newer IDB data", async () => {
  const now = Date.now();
  const idbRecord: SavedSession = {
    version: 1,
    puzzleId: "ultra-tiny",
    actionLog: "D",
    updatedAt: new Date(now).toISOString(),
  };
  const memory = createMemoryIndexedDB([[STORAGE_KEYS.session, idbRecord]]);
  const localStorage = installEnvironment(memory.factory);

  localStorage.setItem(STORAGE_KEYS.session, JSON.stringify({
    ...idbRecord,
    actionLog: "",
    updatedAt: new Date(now + 1_000).toISOString(),
  }));
  const newerLocal = loadSession(getPuzzleById);
  assert.ok(newerLocal);
  assert.equal(
    await hydrateSessionFromIDB(getPuzzleById, newerLocal),
    newerLocal,
  );

  localStorage.setItem(STORAGE_KEYS.session, JSON.stringify({
    ...idbRecord,
    actionLog: "",
    updatedAt: new Date(now - 1_000).toISOString(),
  }));
  const olderLocal = loadSession(getPuzzleById);
  assert.ok(olderLocal);
  const newerIDB = await hydrateSessionFromIDB(getPuzzleById, olderLocal);
  assert.equal(newerIDB?.session.actionLog, "D");
  assert.equal(newerIDB?.resumed, true);
});

test("session hydration fails closed for unavailable, malformed, and unknown data", async () => {
  const current = {
    session: createSession(getPuzzleById("ultra-tiny")!),
    resumed: false,
  };
  const memory = createMemoryIndexedDB([[STORAGE_KEYS.session, { version: 99 }]]);
  installEnvironment(memory.factory);

  assert.equal(await hydrateSessionFromIDB(getPuzzleById, current), current);
  memory.values.set(STORAGE_KEYS.session, {
    version: 1,
    puzzleId: "unknown",
    actionLog: "",
    updatedAt: "2026-08-03T12:00:00.000Z",
  });
  assert.equal(await hydrateSessionFromIDB(getPuzzleById, current), current);

  restoreIndexedDB?.();
  restoreIndexedDB = undefined;
  Reflect.deleteProperty(globalThis, "indexedDB");
  assert.equal(await hydrateSessionFromIDB(getPuzzleById, current), current);
});

test("late session saves cannot overwrite a plausibly newer IndexedDB record", async () => {
  const newer: SavedSession = {
    version: 1,
    puzzleId: "ultra-tiny",
    actionLog: "",
    updatedAt: new Date(Date.now() + 1_000).toISOString(),
  };
  const memory = createMemoryIndexedDB([[STORAGE_KEYS.session, newer]]);
  installEnvironment(memory.factory);
  const puzzle = getPuzzleById("ultra-tiny");
  assert.ok(puzzle);
  const moved = move(createSession(puzzle), "down");

  saveSession(moved);
  await flushIndexedDB();
  assert.deepEqual(memory.values.get(STORAGE_KEYS.session), newer);

  memory.values.set(STORAGE_KEYS.session, {
    ...newer,
    updatedAt: "1970-01-01T00:00:00.000Z",
  });
  saveSession(moved);
  await flushIndexedDB();
  assert.equal(
    (memory.values.get(STORAGE_KEYS.session) as SavedSession).actionLog,
    "D",
  );
});

test("same-millisecond saves retain invocation order when IDB opens out of order", async () => {
  let releaseFirstOpen!: () => void;
  const firstOpenGate = new Promise<void>((resolve) => {
    releaseFirstOpen = resolve;
  });
  const memory = createMemoryIndexedDB([], {
    beforeOpenSuccess: (openNumber) =>
      openNumber === 1 ? firstOpenGate : undefined,
  });
  installEnvironment(memory.factory);
  const puzzle = getPuzzleById("ultra-tiny");
  assert.ok(puzzle);
  const initial = createSession(puzzle);
  const moved = move(initial, "down");
  const originalNow = Date.now;
  const fixedNow = originalNow();
  Date.now = () => fixedNow;

  try {
    saveSession(initial);
    saveSession(moved);
    await flushIndexedDB();
    assert.equal(
      (memory.values.get(STORAGE_KEYS.session) as SavedSession).actionLog,
      "D",
    );

    releaseFirstOpen();
    await flushIndexedDB();
    assert.equal(
      (memory.values.get(STORAGE_KEYS.session) as SavedSession).actionLog,
      "D",
    );
  } finally {
    Date.now = originalNow;
    releaseFirstOpen();
  }
});

test("ignores and replaces an implausibly future IndexedDB session", async () => {
  const future: SavedSession = {
    version: 1,
    puzzleId: "ultra-tiny",
    actionLog: "D",
    updatedAt: new Date(
      Date.now() + MAX_SAVED_SESSION_FUTURE_SKEW_MS + 60_000,
    ).toISOString(),
  };
  const memory = createMemoryIndexedDB([[STORAGE_KEYS.session, future]]);
  const localStorage = installEnvironment(memory.factory);
  localStorage.setItem(STORAGE_KEYS.session, JSON.stringify(future));

  assert.equal(loadSession(getPuzzleById), null);
  assert.equal(loadSessionPuzzleId(() => true), null);

  assert.equal(await hydrateSessionFromIDB(getPuzzleById, null), null);

  const puzzle = getPuzzleById("ultra-tiny");
  assert.ok(puzzle);
  saveSession(createSession(puzzle));
  await flushIndexedDB();
  const stored = memory.values.get(STORAGE_KEYS.session) as SavedSession;
  assert.equal(stored.actionLog, "");
  assert.ok(Date.parse(stored.updatedAt) < Date.parse(future.updatedAt));
});

test("discovers an IndexedDB-only resume pointer and prefers the newest tier", async () => {
  const now = Date.now();
  const indexed: SavedSession = {
    version: 1,
    puzzleId: "ultra-tiny",
    actionLog: "D",
    updatedAt: new Date(now).toISOString(),
  };
  const memory = createMemoryIndexedDB([[STORAGE_KEYS.session, indexed]]);
  const localStorage = installEnvironment(memory.factory);

  assert.equal(loadSessionPuzzleId(() => true), null);
  assert.equal(await loadSessionPuzzleIdFromIDB(() => true), "ultra-tiny");

  localStorage.setItem(STORAGE_KEYS.session, JSON.stringify({
    ...indexed,
    puzzleId: "tiny",
    updatedAt: new Date(now - 1_000).toISOString(),
  }));
  assert.equal(await loadSessionPuzzleIdFromIDB(() => true), "ultra-tiny");

  localStorage.setItem(STORAGE_KEYS.session, JSON.stringify({
    ...indexed,
    puzzleId: "tiny",
    updatedAt: new Date(now + 1_000).toISOString(),
  }));
  assert.equal(await loadSessionPuzzleIdFromIDB(() => true), "tiny");
});

test("clearing a session removes both persistence copies", async () => {
  const saved = JSON.stringify({
    version: 1,
    puzzleId: "ultra-tiny",
    actionLog: "D",
    updatedAt: "2026-08-03T12:00:00.000Z",
  });
  const memory = createMemoryIndexedDB([[
    STORAGE_KEYS.session,
    JSON.parse(saved) as unknown,
  ]]);
  const localStorage = installEnvironment(
    memory.factory,
    createMockStorage([[STORAGE_KEYS.session, saved]]),
  );

  assert.equal(clearSession().ok, true);
  await flushIndexedDB();
  assert.equal(localStorage.getItem(STORAGE_KEYS.session), null);
  assert.equal(memory.values.has(STORAGE_KEYS.session), false);
});

test("loads canonical and legacy sessions through their intended paths", () => {
  const localStorage = createMockStorage();
  (globalThis as Record<string, unknown>).window = { localStorage };
  localStorage.setItem(STORAGE_KEYS.session, JSON.stringify({
    version: 1,
    puzzleId: "ultra-tiny",
    actionLog: "D",
    updatedAt: "2026-08-03T12:00:00.000Z",
  }));
  assert.equal(loadSession(getPuzzleById)?.session.actionLog, "D");

  localStorage.setItem(STORAGE_KEYS.session, "invalid");
  localStorage.setItem(LEGACY_STORAGE_KEYS.currentPuzzle, "ultra-tiny");
  const legacy = loadSession(getPuzzleById);
  assert.equal(legacy?.session.puzzle.id, "ultra-tiny");
  assert.equal(legacy?.session.actionLog, "");
  assert.equal(legacy?.resumed, false);
});
