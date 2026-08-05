import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  IDB_RESET_GENERATION_KEY,
  idbAdvanceResetGeneration,
  idbClear,
  idbFencedGet,
  idbFencedRemove,
  idbFencedUpdate,
  idbGet,
  idbRemove,
  idbSet,
  idbUpdate,
  IndexedDBUnavailableError,
} from "../../src/shared/idb-storage.ts";
import {
  createMemoryIndexedDB,
  installIndexedDB,
} from "../support/memory-indexeddb.ts";

let restoreIndexedDB: (() => void) | undefined;

afterEach(() => {
  restoreIndexedDB?.();
  restoreIndexedDB = undefined;
});

function useIndexedDB(factory: IDBFactory): void {
  restoreIndexedDB?.();
  restoreIndexedDB = installIndexedDB(factory);
}

function removeIndexedDB(): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Reflect.deleteProperty(globalThis, "indexedDB");
  restoreIndexedDB = () => {
    if (descriptor) Object.defineProperty(globalThis, "indexedDB", descriptor);
  };
}

function createDatabaseFactory(
  createTransaction: () => IDBTransaction,
  onClose: () => void = () => {},
): IDBFactory {
  return {
    open: () => {
      const database = {
        close: onClose,
        transaction: createTransaction,
        objectStoreNames: { contains: () => true },
      };
      const request = {
        result: database as unknown as IDBDatabase,
        error: null as DOMException | null,
        onupgradeneeded: null as ((event: IDBVersionChangeEvent) => void) | null,
        onsuccess: null as ((event: Event) => void) | null,
        onerror: null as ((event: Event) => void) | null,
        onblocked: null as ((event: IDBVersionChangeEvent) => void) | null,
      };
      queueMicrotask(() => request.onsuccess?.(new Event("success")));
      return request as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
}

function createWriteTransaction(
  outcome: "complete" | "error" | "abort",
): IDBTransaction {
  const request = {
    result: "key" as IDBValidKey,
    error: null as DOMException | null,
    onsuccess: null as ((event: Event) => void) | null,
    onerror: null as ((event: Event) => void) | null,
  };
  const transaction = {
    error: null as DOMException | null,
    oncomplete: null as ((event: Event) => void) | null,
    onerror: null as ((event: Event) => void) | null,
    onabort: null as ((event: Event) => void) | null,
    objectStore: () => ({
      put: () => {
        queueMicrotask(() => {
          request.onsuccess?.(new Event("success"));
          queueMicrotask(() => {
            if (outcome === "complete") {
              transaction.oncomplete?.(new Event("complete"));
            } else {
              transaction.error = new DOMException(
                "commit failed",
                "UnknownError",
              );
              const handler = outcome === "error"
                ? transaction.onerror
                : transaction.onabort;
              handler?.(new Event(outcome));
            }
          });
        });
        return request as unknown as IDBRequest<IDBValidKey>;
      },
    }),
  };
  return transaction as unknown as IDBTransaction;
}

function createFenceReadFailureTransaction(): IDBTransaction {
  const request = {
    result: undefined,
    error: new DOMException("fence read failed", "UnknownError"),
    onsuccess: null,
    onerror: null as ((event: Event) => void) | null,
  };
  return {
    error: null,
    oncomplete: null,
    onerror: null,
    onabort: null,
    objectStore: () => ({
      get: () => {
        queueMicrotask(() => request.onerror?.(new Event("error")));
        return request;
      },
    }),
  } as unknown as IDBTransaction;
}

test("reports IndexedDB API absence distinctly", async () => {
  removeIndexedDB();

  await assert.rejects(
    idbGet("missing"),
    (error: unknown) => error instanceof IndexedDBUnavailableError,
  );
});

test("reports thrown, failed, and blocked database opens", async (t) => {
  await t.test("open throws synchronously", async () => {
    useIndexedDB({
      open: () => {
        throw new DOMException("denied", "SecurityError");
      },
    } as unknown as IDBFactory);
    await assert.rejects(idbGet("key"), /failed to open/i);
  });

  await t.test("open request fails", async () => {
    useIndexedDB({
      open: () => {
        const request = {
          error: new DOMException("open failed", "UnknownError"),
          onupgradeneeded: null,
          onsuccess: null,
          onerror: null as ((event: Event) => void) | null,
          onblocked: null,
        };
        queueMicrotask(() => request.onerror?.(new Event("error")));
        return request as unknown as IDBOpenDBRequest;
      },
    } as unknown as IDBFactory);
    await assert.rejects(idbGet("key"), /failed to open/i);
  });

  await t.test("blocked open ignores later terminal events", async () => {
    let closes = 0;
    useIndexedDB({
      open: () => {
        const request = {
          result: { close: () => { closes += 1; } } as IDBDatabase,
          error: null,
          onupgradeneeded: null,
          onsuccess: null as ((event: Event) => void) | null,
          onerror: null as ((event: Event) => void) | null,
          onblocked: null as ((event: IDBVersionChangeEvent) => void) | null,
        };
        queueMicrotask(() => {
          request.onblocked?.(new Event("blocked") as IDBVersionChangeEvent);
          request.onsuccess?.(new Event("success"));
          request.onerror?.(new Event("error"));
          request.onblocked?.(new Event("blocked") as IDBVersionChangeEvent);
        });
        return request as unknown as IDBOpenDBRequest;
      },
    } as unknown as IDBFactory);
    await assert.rejects(idbGet("key"), /opening was blocked/i);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.equal(closes, 1);
  });
});

test("performs get, set, atomic update, remove, and clear after commit", async () => {
  const memory = createMemoryIndexedDB([["existing", { count: 1 }]]);
  useIndexedDB(memory.factory);

  assert.deepEqual(await idbGet("existing"), { count: 1 });
  await idbSet("added", { enabled: true });
  assert.deepEqual(memory.values.get("added"), { enabled: true });

  const updated = await idbUpdate<{ count: number }>("existing", (current) => ({
    count: (current as { count: number }).count + 1,
  }));
  assert.deepEqual(updated, { count: 2 });
  assert.deepEqual(memory.values.get("existing"), { count: 2 });

  await idbRemove("added");
  assert.equal(memory.values.has("added"), false);
  await idbClear();
  assert.equal(memory.values.size, 0);
  assert.equal(memory.stats.upgrades, 1);
  assert.equal(memory.stats.opens, memory.stats.closes);
  assert.equal(memory.stats.clears, 1);
});

test("reset generation atomically clears earlier writes and rejects stale later writes", async () => {
  const memory = createMemoryIndexedDB();
  useIndexedDB(memory.factory);

  const beforeReset = await idbFencedUpdate("session", 0, () => "before");
  assert.deepEqual(beforeReset, { applied: true, value: "before" });

  const generation = await idbAdvanceResetGeneration();
  assert.equal(generation, 1);
  assert.deepEqual([...memory.values], [[IDB_RESET_GENERATION_KEY, 1]]);

  const staleWrite = await idbFencedUpdate("session", 0, () => "stale");
  const staleRemove = await idbFencedRemove("session", 0);
  assert.deepEqual(staleWrite, { applied: false });
  assert.equal(staleRemove, false);
  assert.equal(memory.values.has("session"), false);

  const currentWrite = await idbFencedUpdate("session", 1, () => "current");
  assert.deepEqual(currentWrite, { applied: true, value: "current" });
  assert.equal(memory.values.get("session"), "current");
  assert.equal(await idbFencedRemove("session", 1), true);
  assert.equal(memory.values.has("session"), false);
});

test("a queued pre-reset write cannot start after reset and resurrect data", async () => {
  let releaseFirstOpen!: () => void;
  const firstOpenGate = new Promise<void>((resolve) => {
    releaseFirstOpen = resolve;
  });
  const memory = createMemoryIndexedDB(
    [["session", "old"]],
    {
      beforeOpenSuccess: (openNumber) =>
        openNumber === 1 ? firstOpenGate : undefined,
    },
  );
  useIndexedDB(memory.factory);

  // The write is invoked first, but its database connection is deliberately
  // held until the reset transaction on the second connection has committed.
  const pendingStaleWrite = idbFencedUpdate("session", 0, () => "resurrected");
  assert.equal(memory.stats.opens, 1);
  assert.equal(await idbAdvanceResetGeneration(), 1);
  assert.deepEqual([...memory.values], [[IDB_RESET_GENERATION_KEY, 1]]);

  releaseFirstOpen();
  assert.deepEqual(await pendingStaleWrite, { applied: false });
  assert.equal(memory.values.has("session"), false);
});

test("a fresh document can initialize an empty post-reset IndexedDB store", async () => {
  const memory = createMemoryIndexedDB([
    ["session", "stale attempt"],
    ["optimal", "stale proof"],
  ]);
  useIndexedDB(memory.factory);

  assert.equal(await idbFencedGet("session", 4), undefined);
  assert.deepEqual([...memory.values], [[IDB_RESET_GENERATION_KEY, 4]]);

  const result = await idbFencedUpdate("optimal", 4, () => "proof");

  assert.deepEqual(result, { applied: true, value: "proof" });
  assert.equal(memory.values.get(IDB_RESET_GENERATION_KEY), 4);
  assert.equal(memory.values.get("optimal"), "proof");
});

test("fenced reads discard older stores but never expose newer stores to stale documents", async () => {
  const memory = createMemoryIndexedDB([
    [IDB_RESET_GENERATION_KEY, 2],
    ["session", "generation two"],
  ]);
  useIndexedDB(memory.factory);

  assert.equal(await idbFencedGet("session", 1), undefined);
  assert.equal(memory.values.get("session"), "generation two");
  assert.equal(memory.values.get(IDB_RESET_GENERATION_KEY), 2);

  assert.equal(await idbFencedGet("session", 3), undefined);
  assert.deepEqual([...memory.values], [[IDB_RESET_GENERATION_KEY, 3]]);
});

test("reset advancement never regresses behind a newer local marker", async () => {
  const memory = createMemoryIndexedDB([
    [IDB_RESET_GENERATION_KEY, 2],
    ["session", "stale"],
  ]);
  useIndexedDB(memory.factory);

  assert.equal(await idbAdvanceResetGeneration(7), 8);
  assert.deepEqual([...memory.values], [[IDB_RESET_GENERATION_KEY, 8]]);
});

test("fenced operations reject reset-fence read failures and close connections", async (t) => {
  const operations: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
    ["read", () => idbFencedGet("session", 1)],
    ["update", () => idbFencedUpdate("session", 1, () => "next")],
    ["remove", () => idbFencedRemove("session", 1)],
    ["reset", () => idbAdvanceResetGeneration(1)],
  ];

  for (const [name, operation] of operations) {
    await t.test(name, async () => {
      let closes = 0;
      useIndexedDB(createDatabaseFactory(
        createFenceReadFailureTransaction,
        () => { closes += 1; },
      ));

      await assert.rejects(operation(), /reset fence read failed/i);
      assert.equal(closes, 1);
    });
  }
});

test("a fenced update callback failure aborts without replacing the stored value", async () => {
  const memory = createMemoryIndexedDB([
    [IDB_RESET_GENERATION_KEY, 2],
    ["session", "preserved"],
  ]);
  useIndexedDB(memory.factory);

  await assert.rejects(
    idbFencedUpdate("session", 2, () => {
      throw new TypeError("bad merge");
    }),
    /fenced update failed/i,
  );
  assert.equal(memory.values.get("session"), "preserved");
  assert.equal(memory.stats.opens, memory.stats.closes);
});

test("a fenced remove clears and initializes an older durable generation", async () => {
  const memory = createMemoryIndexedDB([
    [IDB_RESET_GENERATION_KEY, 1],
    ["session", "stale"],
    ["optimal", "stale"],
  ]);
  useIndexedDB(memory.factory);

  assert.equal(await idbFencedRemove("session", 3), true);
  assert.deepEqual([...memory.values], [[IDB_RESET_GENERATION_KEY, 3]]);
});

test("request failures reject and close the database", async () => {
  let closes = 0;
  const request = {
    result: undefined,
    error: new DOMException("read failed", "UnknownError"),
    onsuccess: null,
    onerror: null as ((event: Event) => void) | null,
  };
  const transaction = {
    error: null,
    oncomplete: null,
    onerror: null,
    onabort: null,
    objectStore: () => ({
      get: () => {
        queueMicrotask(() => request.onerror?.(new Event("error")));
        return request;
      },
    }),
  };
  useIndexedDB(createDatabaseFactory(
    () => transaction as unknown as IDBTransaction,
    () => { closes += 1; },
  ));

  await assert.rejects(idbGet("key"), /request failed/i);
  assert.equal(closes, 1);
});

test("write promises reject on transaction errors and aborts after request success", async (t) => {
  for (const outcome of ["error", "abort"] as const) {
    await t.test(outcome, async () => {
      useIndexedDB(createDatabaseFactory(() => createWriteTransaction(outcome)));
      await assert.rejects(
        idbSet("key", { value: true }),
        new RegExp(`transaction (failed|was ${outcome === "abort" ? "aborted" : "failed"})`, "i"),
      );
    });
  }
});

test("transaction setup exceptions reject and close the database", async () => {
  let closes = 0;
  useIndexedDB(createDatabaseFactory(
    () => {
      throw new DOMException("store unavailable", "NotFoundError");
    },
    () => { closes += 1; },
  ));

  await assert.rejects(idbClear(), /transaction could not start/i);
  assert.equal(closes, 1);
});

test("atomic updates reject callback and read failures without changing data", async (t) => {
  await t.test("callback throws", async () => {
    const memory = createMemoryIndexedDB([["key", { count: 1 }]]);
    useIndexedDB(memory.factory);
    await assert.rejects(
      idbUpdate("key", () => {
        throw new TypeError("bad merge");
      }),
      /update failed/i,
    );
    assert.deepEqual(memory.values.get("key"), { count: 1 });
  });

  await t.test("read request fails", async () => {
    const read = {
      result: undefined,
      error: new DOMException("read failed", "UnknownError"),
      onsuccess: null,
      onerror: null as ((event: Event) => void) | null,
    };
    const transaction = {
      error: null,
      oncomplete: null,
      onerror: null,
      onabort: null,
      abort: () => {},
      objectStore: () => ({
        get: () => {
          queueMicrotask(() => read.onerror?.(new Event("error")));
          return read;
        },
      }),
    };
    useIndexedDB(createDatabaseFactory(
      () => transaction as unknown as IDBTransaction,
    ));
    await assert.rejects(idbUpdate("key", () => "next"), /update read failed/i);
  });
});

test("atomic updates surface transaction and setup failures", async (t) => {
  for (const outcome of ["error", "abort"] as const) {
    await t.test(outcome, async () => {
      const read = {
        result: "old",
        error: null,
        onsuccess: null as ((event: Event) => void) | null,
        onerror: null,
      };
      const transaction = {
        error: null as DOMException | null,
        oncomplete: null,
        onerror: null as ((event: Event) => void) | null,
        onabort: null as ((event: Event) => void) | null,
        abort: () => {},
        objectStore: () => ({
          get: () => {
            queueMicrotask(() => read.onsuccess?.(new Event("success")));
            return read;
          },
          put: () => {
            queueMicrotask(() => {
              transaction.error = new DOMException("commit failed", "UnknownError");
              const handler = outcome === "error"
                ? transaction.onerror
                : transaction.onabort;
              handler?.(new Event(outcome));
            });
          },
        }),
      };
      useIndexedDB(createDatabaseFactory(
        () => transaction as unknown as IDBTransaction,
      ));
      await assert.rejects(
        idbUpdate("key", () => "next"),
        /update transaction (failed|was aborted)/i,
      );
    });
  }

  await t.test("transaction setup throws", async () => {
    useIndexedDB(createDatabaseFactory(() => {
      throw new DOMException("store unavailable", "NotFoundError");
    }));
    await assert.rejects(
      idbUpdate("key", () => "next"),
      /update transaction could not start/i,
    );
  });
});
