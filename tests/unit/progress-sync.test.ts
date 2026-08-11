import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import {
  EMPTY_PROGRESS,
  mergeProgress,
  recordCompletion,
  type ProgressData,
} from "../../src/shared/progress.ts";
import {
  loadProgressSyncSnapshot,
  mergeConcurrentProgress,
  parseProgressSyncSnapshot,
  persistProgressImport,
  persistProgressReset,
  persistProgressUpdate,
  reconcileProgressSnapshots,
  writeProgressSyncSnapshot,
  type ProgressSyncSnapshot,
} from "../../src/shared/progress-sync.ts";
import { STORAGE_KEYS } from "../../src/shared/storage.ts";

function createMockStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
}

function progress(
  records: Readonly<Record<string, { moves: number; pushes: number; completedAt?: string }>>,
): ProgressData {
  return {
    version: 2,
    completed: Object.fromEntries(
      Object.entries(records).map(([puzzleId, record]) => [
        puzzleId,
        {
          ...record,
          completedAt: record.completedAt ?? "2026-08-01T00:00:00.000Z",
        },
      ]),
    ),
    daily: {},
  };
}

function snapshot(
  writerId: string,
  value: ProgressData,
  generation = 0,
  revision = 1,
): ProgressSyncSnapshot {
  return { generation, revision, writerId, progress: value };
}

let storage: Storage;

beforeEach(() => {
  storage = createMockStorage();
  (globalThis as Record<string, unknown>).window = { localStorage: storage };
});

afterEach(() => {
  Reflect.deleteProperty(globalThis as Record<string, unknown>, "window");
});

test("parses legacy progress and validates revision envelopes", () => {
  const legacyProgress = progress({ room: { moves: 10, pushes: 3 } });
  const legacy = parseProgressSyncSnapshot(JSON.stringify({
    version: 1,
    completed: legacyProgress.completed,
  }));
  assert.equal(legacy?.generation, 0);
  assert.equal(legacy?.revision, 0);
  assert.equal(legacy?.progress.completed.room?.moves, 10);

  assert.equal(parseProgressSyncSnapshot(JSON.stringify({
    version: 2,
    generation: -1,
    revision: 0,
    writerId: "tab-a",
    completed: {},
  })), null);
  for (const field of ["generation", "revision"] as const) {
    assert.equal(parseProgressSyncSnapshot(JSON.stringify({
      version: 2,
      generation: 0,
      revision: 0,
      writerId: "tab-a",
      completed: {},
      [field]: Number.MAX_SAFE_INTEGER + 1,
    })), null);
  }
});

test("read-merge-write updates preserve independent tab completions", () => {
  const tabA = loadProgressSyncSnapshot();
  const tabB = loadProgressSyncSnapshot();

  const first = persistProgressUpdate(tabA, "tab-a", (current) =>
    recordCompletion(current, "room-a", 10, 3));
  const second = persistProgressUpdate(tabB, "tab-b", (current) =>
    recordCompletion(current, "room-b", 12, 4));

  assert.equal(first.result.ok, true);
  assert.equal(second.result.ok, true);
  assert.deepEqual(Object.keys(second.snapshot.progress.completed).sort(), [
    "room-a",
    "room-b",
  ]);
  assert.deepEqual(
    loadProgressSyncSnapshot().progress,
    second.snapshot.progress,
  );
});

test("same-generation races converge deterministically on the better record", () => {
  const tabA = snapshot("tab-a", progress({
    shared: {
      moves: 20,
      pushes: 5,
      completedAt: "2026-08-01T00:00:01.000Z",
    },
    onlyA: { moves: 8, pushes: 2 },
  }));
  const tabB = snapshot("tab-b", progress({
    shared: {
      moves: 18,
      pushes: 6,
      completedAt: "2026-08-01T00:00:02.000Z",
    },
    onlyB: { moves: 9, pushes: 3 },
  }));

  const fromA = reconcileProgressSnapshots(tabA, tabB, "tab-a");
  const fromB = reconcileProgressSnapshots(tabB, tabA, "tab-b");
  assert.equal(fromA.shouldPersist, true);
  assert.equal(fromB.shouldPersist, true);
  assert.equal(fromA.snapshot.progress.completed.shared?.moves, 18);
  assert.deepEqual(
    fromA.snapshot.progress.completed,
    fromB.snapshot.progress.completed,
  );
});

test("concurrent tie-breaking does not change import current-record-wins rules", () => {
  const current = progress({
    room: {
      moves: 10,
      pushes: 5,
      completedAt: "2026-08-02T00:00:00.000Z",
    },
  });
  const sameMoves = progress({
    room: {
      moves: 10,
      pushes: 3,
      completedAt: "2026-08-01T00:00:00.000Z",
    },
  });
  const importedWithNewRecord = progress({
    ...sameMoves.completed,
    importedOnly: { moves: 7, pushes: 2 },
  });

  assert.equal(mergeProgress(current, sameMoves), current);
  assert.equal(
    mergeConcurrentProgress(current, sameMoves).completed.room?.pushes,
    3,
  );

  writeProgressSyncSnapshot(snapshot("tab-a", current));
  const imported = persistProgressImport(
    loadProgressSyncSnapshot(),
    "tab-a",
    importedWithNewRecord,
  );
  assert.equal(imported.changed, true);
  assert.equal(imported.snapshot.progress.completed.room?.pushes, 5);
  assert.equal(imported.snapshot.progress.completed.importedOnly?.moves, 7);
});

test("a higher reset generation prevents stale records from resurrecting", () => {
  const oldProgress = progress({
    oldA: { moves: 10, pushes: 3 },
    oldB: { moves: 12, pushes: 4 },
  });
  const staleTab = snapshot("tab-b", oldProgress, 0, 4);
  writeProgressSyncSnapshot(staleTab);

  const reset = persistProgressReset(staleTab, "tab-a");
  assert.equal(reset.snapshot.generation, 1);
  assert.deepEqual(reset.snapshot.progress, EMPTY_PROGRESS);

  const reconciled = reconcileProgressSnapshots(
    staleTab,
    reset.snapshot,
    "tab-b",
  );
  assert.equal(reconciled.shouldPersist, false);
  assert.deepEqual(reconciled.snapshot.progress, EMPTY_PROGRESS);

  const fresh = persistProgressUpdate(staleTab, "tab-b", (current) =>
    recordCompletion(current, "fresh", 7, 2));
  assert.equal(fresh.snapshot.generation, 1);
  assert.deepEqual(Object.keys(fresh.snapshot.progress.completed), ["fresh"]);
  assert.equal(
    parseProgressSyncSnapshot(storage.getItem(STORAGE_KEYS.progress))
      ?.progress.completed.oldA,
    undefined,
  );
});
