import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import type { PuzzleDefinition } from "../../src/core/model.ts";
import {
  MAX_PERSONAL_BEST_ROUTES_PER_PUZZLE,
  PERSONAL_BEST_ROUTES_VERSION,
  clearPersonalBestRoutes,
  loadPersonalBestRouteIndex,
  loadPersonalBestRoutes,
  loadPersonalBestRouteStorageStats,
  normalizePersonalBestRouteRepository,
  promoteVerifiedPersonalBestRoute,
  puzzleRevisionFingerprint,
  verifyPersonalBestRoute,
} from "../../src/shared/personal-best-routes.ts";
import { STORAGE_KEYS } from "../../src/shared/storage.ts";
import {
  createMemoryIndexedDB,
  installIndexedDB,
} from "../support/memory-indexeddb.ts";

const PUZZLE: PuzzleDefinition = Object.freeze({
  id: "route-test",
  title: "Route Test",
  difficulty: "tutorial",
  boxes: 1,
  rows: [
    "OOOOOOO",
    "O     O",
    "OR X SO",
    "O     O",
    "OOOOOOO",
  ],
});

let restoreIndexedDB: (() => void) | undefined;
let restoreWindow: (() => void) | undefined;

afterEach(() => {
  restoreIndexedDB?.();
  restoreIndexedDB = undefined;
  restoreWindow?.();
  restoreWindow = undefined;
});

function useMemoryIndexedDB(initial: Iterable<readonly [IDBValidKey, unknown]> = []) {
  const memory = createMemoryIndexedDB(initial);
  restoreIndexedDB = installIndexedDB(memory.factory);
  return memory;
}

function useMemoryLocalStorage(): Map<string, string> {
  const values = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
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
  restoreWindow = () => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  };
  return values;
}

function verified(
  actionLog: string,
  completedAt: string,
) {
  const route = verifyPersonalBestRoute(PUZZLE, {
    actionLog,
    moves: actionLog.length,
    pushes: 2,
    elapsedMs: 1_234.4,
    completedAt,
  });
  assert.ok(route);
  return route;
}

test("puzzle fingerprints are stable and change with canonical board content", () => {
  const first = puzzleRevisionFingerprint(PUZZLE);
  assert.match(first, /^puzzle-v1:[0-9a-f]{8}$/u);
  assert.equal(puzzleRevisionFingerprint({ ...PUZZLE, title: "Renamed" }), first);
  assert.notEqual(
    puzzleRevisionFingerprint({
      ...PUZZLE,
      rows: [...PUZZLE.rows.slice(0, 2), "OR X  O", ...PUZZLE.rows.slice(3)],
    }),
    first,
  );
});

test("candidate verification replays solved state and exact counters", () => {
  const route = verified("RRR", "2026-08-28T12:00:00.000Z");
  assert.equal(route.moves, 3);
  assert.equal(route.pushes, 2);
  assert.equal(route.validation, "replay-verified");
  assert.equal(route.elapsedMs, 1_234);

  assert.equal(verifyPersonalBestRoute(PUZZLE, {
    actionLog: "RRR",
    moves: 4,
    pushes: 2,
    completedAt: "2026-08-28T12:00:00.000Z",
  }), null);
  assert.equal(verifyPersonalBestRoute(PUZZLE, {
    actionLog: "U",
    moves: 1,
    pushes: 0,
    completedAt: "2026-08-28T12:00:00.000Z",
  }), null);
});

test("the asynchronous repository promotes only stronger replay-verified routes", async () => {
  useMemoryIndexedDB();
  const slow = verified("URDRR", "2026-08-28T12:00:00.000Z");
  const fast = verified("RRR", "2026-08-28T12:01:00.000Z");

  assert.equal((await promoteVerifiedPersonalBestRoute(PUZZLE, slow)).status, "saved");
  assert.equal((await promoteVerifiedPersonalBestRoute(PUZZLE, fast)).status, "saved");
  assert.equal((await promoteVerifiedPersonalBestRoute(PUZZLE, slow)).status, "not-better");

  const loaded = await loadPersonalBestRoutes(PUZZLE);
  assert.equal(loaded.status, "ready");
  assert.deepEqual(loaded.routes.map((route) => route.moves), [3, 5]);

  const stats = await loadPersonalBestRouteStorageStats();
  assert.equal(stats.status, "ready");
  assert.equal(stats.puzzleCount, 1);
  assert.equal(stats.routeCount, 2);
  assert.equal(stats.actionCount, 8);
  assert.ok(stats.approximateBytes > 0);
  assert.deepEqual(await loadPersonalBestRouteIndex(), {
    status: "ready",
    puzzleIds: [PUZZLE.id],
  });
});

test("stale puzzle revisions are rejected without deleting summary progress", async () => {
  useMemoryIndexedDB();
  await promoteVerifiedPersonalBestRoute(PUZZLE,
    verified("RRR", "2026-08-28T12:00:00.000Z"),
  );
  const changedPuzzle = {
    ...PUZZLE,
    rows: [...PUZZLE.rows.slice(0, 2), "OR X  O", ...PUZZLE.rows.slice(3)],
  };
  const loaded = await loadPersonalBestRoutes(changedPuzzle);
  assert.equal(loaded.status, "stale");
  assert.deepEqual(loaded.routes, []);
});

test("plausible forged routes are replay-rejected and cannot block a real best", async () => {
  const real = verified("URDRR", "2026-08-28T12:00:00.000Z");
  const forged = {
    ...real,
    routeId: "forged-one-move-route",
    actionLog: "R",
    moves: 1,
    pushes: 0,
  };
  useMemoryIndexedDB([[
    STORAGE_KEYS.personalBestRoutes,
    {
      version: 1,
      puzzles: {
        [PUZZLE.id]: {
          puzzleId: PUZZLE.id,
          puzzleFingerprint: real.puzzleFingerprint,
          routes: [forged],
        },
      },
    },
  ]]);
  assert.equal((await loadPersonalBestRoutes(PUZZLE)).status, "corrupt");
  assert.equal(
    (await promoteVerifiedPersonalBestRoute(PUZZLE, real)).status,
    "saved",
  );
  const loaded = await loadPersonalBestRoutes(PUZZLE);
  assert.equal(loaded.status, "ready");
  assert.deepEqual(loaded.routes.map((route) => route.moves), [5]);
});

test("corrupt repositories fail closed and a later verified save replaces them", async () => {
  const memory = useMemoryIndexedDB([[
    STORAGE_KEYS.personalBestRoutes,
    { version: 99, puzzles: { forged: { routes: ["RRR"] } } },
  ]]);
  assert.equal((await loadPersonalBestRouteStorageStats()).status, "corrupt");
  assert.equal((await loadPersonalBestRoutes(PUZZLE)).status, "corrupt");

  const outcome = await promoteVerifiedPersonalBestRoute(PUZZLE,
    verified("RRR", "2026-08-28T12:00:00.000Z"),
  );
  assert.equal(outcome.status, "saved");
  assert.equal(
    (memory.values.get(STORAGE_KEYS.personalBestRoutes) as { version?: number }).version,
    1,
  );
});

test("normalization rejects malformed entries and bounds per-puzzle history", () => {
  const fingerprint = puzzleRevisionFingerprint(PUZZLE);
  const routes = Array.from(
    { length: MAX_PERSONAL_BEST_ROUTES_PER_PUZZLE + 3 },
    (_, index) => ({
      schemaVersion: 1,
      routeId: `route-${index}`,
      puzzleId: PUZZLE.id,
      puzzleFingerprint: fingerprint,
      actionLog: "R".repeat(index + 1),
      moves: index + 1,
      pushes: 0,
      completedAt: new Date(Date.UTC(2026, 7, 28, 12, index)).toISOString(),
      validation: "replay-verified",
    }),
  );
  routes.push({
    ...routes[0]!,
    routeId: "forged",
    actionLog: "X",
  });

  const normalized = normalizePersonalBestRouteRepository({
    version: 1,
    puzzles: {
      [PUZZLE.id]: {
        puzzleId: PUZZLE.id,
        puzzleFingerprint: fingerprint,
        routes,
      },
    },
  });
  const retained = normalized.puzzles[PUZZLE.id]?.routes ?? [];
  assert.equal(retained.length, MAX_PERSONAL_BEST_ROUTES_PER_PUZZLE);
  assert.deepEqual(retained.map((route) => route.moves), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("missing IndexedDB and explicit clearing remain safe", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Reflect.deleteProperty(globalThis, "indexedDB");
  restoreIndexedDB = () => {
    if (descriptor) Object.defineProperty(globalThis, "indexedDB", descriptor);
  };

  const route = verified("RRR", "2026-08-28T12:00:00.000Z");
  assert.equal((await promoteVerifiedPersonalBestRoute(PUZZLE, route)).status, "unavailable");
  assert.equal((await loadPersonalBestRoutes(PUZZLE)).status, "unavailable");
  assert.equal((await loadPersonalBestRouteStorageStats()).status, "unavailable");
  assert.equal((await loadPersonalBestRouteIndex()).status, "unavailable");
  assert.equal(await clearPersonalBestRoutes(), false);
});

test("quota errors from IndexedDB are non-blocking repository outcomes", async () => {
  restoreIndexedDB = installIndexedDB({
    open() {
      throw new DOMException("Storage quota exceeded", "QuotaExceededError");
    },
  } as unknown as IDBFactory);
  const route = verified("RRR", "2026-08-28T12:00:00.000Z");
  assert.equal(
    (await promoteVerifiedPersonalBestRoute(PUZZLE, route)).status,
    "unavailable",
  );
});

test("clearing removes route history without touching other IndexedDB values", async () => {
  useMemoryLocalStorage();
  const memory = useMemoryIndexedDB([["unrelated", { keep: true }]]);
  await promoteVerifiedPersonalBestRoute(PUZZLE,
    verified("RRR", "2026-08-28T12:00:00.000Z"),
  );
  assert.equal(await clearPersonalBestRoutes(), true);
  assert.deepEqual(memory.values.get(STORAGE_KEYS.personalBestRoutes), {
    version: PERSONAL_BEST_ROUTES_VERSION,
    resetGeneration: 1,
    puzzles: {},
  });
  assert.deepEqual(memory.values.get("unrelated"), { keep: true });
});

test("a delayed pre-reset route write cannot resurrect cleared history", async () => {
  useMemoryLocalStorage();
  let releaseFirstOpen!: () => void;
  const firstOpenGate = new Promise<void>((resolve) => {
    releaseFirstOpen = resolve;
  });
  const memory = createMemoryIndexedDB([], {
    beforeOpenSuccess: (openNumber) =>
      openNumber === 1 ? firstOpenGate : undefined,
  });
  restoreIndexedDB = installIndexedDB(memory.factory);

  const pendingPromotion = promoteVerifiedPersonalBestRoute(
    PUZZLE,
    verified("RRR", "2026-08-28T12:00:00.000Z"),
  );
  assert.equal(memory.stats.opens, 1);
  assert.equal(await clearPersonalBestRoutes(), true);

  releaseFirstOpen();
  assert.equal((await pendingPromotion).status, "rejected");
  assert.deepEqual(memory.values.get(STORAGE_KEYS.personalBestRoutes), {
    version: PERSONAL_BEST_ROUTES_VERSION,
    resetGeneration: 1,
    puzzles: {},
  });
  assert.equal((await loadPersonalBestRoutes(PUZZLE)).status, "missing");
});
