/**
 * Minimal IndexedDB key-value wrapper for large data that exceeds
 * localStorage's ~5 MB quota. Zero external dependencies.
 *
 * Operations reject when IndexedDB is unavailable or a request/transaction
 * fails. Callers that can safely fall back must do so explicitly; destructive
 * workflows such as full-data reset can therefore distinguish "no secondary
 * store exists" from "secondary data may still exist."
 */

const DB_NAME = "sokomind";
const STORE_NAME = "kv";
const DB_VERSION = 1;
export const IDB_RESET_GENERATION_KEY = "sokomind.idb-reset-generation.v1";

export class IndexedDBUnavailableError extends Error {
  override readonly name = "IndexedDBUnavailableError";
}

function storageError(message: string, cause?: unknown): Error {
  const error = new Error(message);
  if (cause !== undefined) {
    Object.defineProperty(error, "cause", { value: cause });
  }
  return error;
}

function normalizeResetGeneration(value: unknown): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value < Number.MAX_SAFE_INTEGER
    ? value
    : 0;
}

function openDB(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new IndexedDBUnavailableError(
      "IndexedDB is unavailable.",
    ));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };

      request.onsuccess = () => {
        if (settled) {
          request.result.close();
          return;
        }
        settled = true;
        resolve(request.result);
      };
      request.onerror = () => {
        if (settled) return;
        settled = true;
        reject(storageError("IndexedDB failed to open.", request.error));
      };
      request.onblocked = () => {
        if (settled) return;
        settled = true;
        reject(storageError("IndexedDB opening was blocked."));
      };
    } catch (error) {
      reject(storageError("IndexedDB failed to open.", error));
    }
  });
}

function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDB().then((db) => {
    return new Promise<T>((resolve, reject) => {
      let result: T;
      let settled = false;
      const finish = (operation: () => void) => {
        if (settled) return;
        settled = true;
        db.close();
        operation();
      };
      try {
        const tx = db.transaction(STORE_NAME, mode);
        const store = tx.objectStore(STORE_NAME);
        const request = fn(store);
        request.onsuccess = () => {
          result = request.result as T;
        };
        request.onerror = () => {
          finish(() => reject(storageError(
            "IndexedDB request failed.",
            request.error,
          )));
        };
        tx.oncomplete = () => finish(() => resolve(result));
        tx.onerror = () => finish(() => reject(storageError(
          "IndexedDB transaction failed.",
          tx.error,
        )));
        tx.onabort = () => finish(() => reject(storageError(
          "IndexedDB transaction was aborted.",
          tx.error,
        )));
      } catch (error) {
        finish(() => reject(storageError(
          "IndexedDB transaction could not start.",
          error,
        )));
      }
    });
  });
}

export function idbGet<T>(key: string): Promise<T | undefined> {
  return withStore<T>("readonly", (store) => store.get(key) as IDBRequest<T>);
}

export function idbSet(key: string, value: unknown): Promise<void> {
  return withStore<IDBValidKey>("readwrite", (store) =>
    store.put(value, key),
  ).then(() => undefined);
}

/**
 * Atomically read, update, and write a value in one read/write transaction.
 * IndexedDB serializes overlapping transactions for this store, preventing
 * stale browser tabs from replacing records written by another tab.
 */
export function idbUpdate<T>(
  key: string,
  update: (current: unknown) => T,
): Promise<T> {
  return openDB().then((db) => new Promise<T>((resolve, reject) => {
    let next: T;
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      db.close();
      operation();
    };

    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const read = store.get(key);
      read.onsuccess = () => {
        try {
          next = update(read.result);
          store.put(next, key);
        } catch (error) {
          tx.abort();
          finish(() => reject(storageError(
            "IndexedDB update failed.",
            error,
          )));
        }
      };
      read.onerror = () => finish(() => reject(storageError(
        "IndexedDB update read failed.",
        read.error,
      )));
      tx.oncomplete = () => finish(() => resolve(next));
      tx.onerror = () => finish(() => reject(storageError(
        "IndexedDB update transaction failed.",
        tx.error,
      )));
      tx.onabort = () => finish(() => reject(storageError(
        "IndexedDB update transaction was aborted.",
        tx.error,
      )));
    } catch (error) {
      finish(() => reject(storageError(
        "IndexedDB update transaction could not start.",
        error,
      )));
    }
  }));
}

export interface IDBFencedUpdateResult<T> {
  readonly applied: boolean;
  readonly value?: T;
}

/**
 * Read only when this document and the durable store belong to the same reset
 * generation. If IndexedDB was unavailable during a reset, the local marker
 * can be newer; clear and rebase that older store before returning no data.
 */
export function idbFencedGet<T>(
  key: string,
  expectedGeneration: number,
): Promise<T | undefined> {
  return openDB().then((db) => new Promise<T | undefined>((resolve, reject) => {
    let value: T | undefined;
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      db.close();
      operation();
    };

    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const fenceRead = store.get(IDB_RESET_GENERATION_KEY);
      fenceRead.onsuccess = () => {
        const generation = normalizeResetGeneration(fenceRead.result);
        if (generation < expectedGeneration) {
          const clearRequest = store.clear();
          clearRequest.onsuccess = () => {
            store.put(expectedGeneration, IDB_RESET_GENERATION_KEY);
          };
          return;
        }
        if (generation > expectedGeneration) return;

        const valueRead = store.get(key) as IDBRequest<T>;
        valueRead.onsuccess = () => {
          value = valueRead.result;
        };
        valueRead.onerror = () => finish(() => reject(storageError(
          "IndexedDB fenced read failed.",
          valueRead.error,
        )));
      };
      fenceRead.onerror = () => finish(() => reject(storageError(
        "IndexedDB reset fence read failed.",
        fenceRead.error,
      )));
      tx.oncomplete = () => finish(() => resolve(value));
      tx.onerror = () => finish(() => reject(storageError(
        "IndexedDB fenced read transaction failed.",
        tx.error,
      )));
      tx.onabort = () => finish(() => reject(storageError(
        "IndexedDB fenced read transaction was aborted.",
        tx.error,
      )));
    } catch (error) {
      finish(() => reject(storageError(
        "IndexedDB fenced read transaction could not start.",
        error,
      )));
    }
  }));
}

/**
 * Update a value only when the document generation still matches the durable
 * reset fence. The fence read and value write share one transaction, so a
 * reset ordered before this transaction makes a stale delayed write a no-op.
 */
export function idbFencedUpdate<T>(
  key: string,
  expectedGeneration: number,
  update: (current: unknown) => T,
): Promise<IDBFencedUpdateResult<T>> {
  return openDB().then((db) => new Promise<IDBFencedUpdateResult<T>>(
    (resolve, reject) => {
      let result: IDBFencedUpdateResult<T> = { applied: false };
      let settled = false;
      const finish = (operation: () => void) => {
        if (settled) return;
        settled = true;
        db.close();
        operation();
      };

      try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const fenceRead = store.get(IDB_RESET_GENERATION_KEY);
        fenceRead.onsuccess = () => {
          const generation = normalizeResetGeneration(fenceRead.result);
          if (generation > expectedGeneration) {
            return;
          }

          const applyUpdate = (current: unknown) => {
            try {
              const value = update(current);
              result = { applied: true, value };
              store.put(value, key);
            } catch (error) {
              tx.abort();
              finish(() => reject(storageError(
                "IndexedDB fenced update failed.",
                error,
              )));
            }
          };

          if (generation < expectedGeneration) {
            const clearRequest = store.clear();
            clearRequest.onsuccess = () => {
              store.put(expectedGeneration, IDB_RESET_GENERATION_KEY);
              applyUpdate(undefined);
            };
            return;
          }

          const valueRead = store.get(key);
          valueRead.onsuccess = () => {
            applyUpdate(valueRead.result);
          };
          valueRead.onerror = () => finish(() => reject(storageError(
            "IndexedDB fenced update read failed.",
            valueRead.error,
          )));
        };
        fenceRead.onerror = () => finish(() => reject(storageError(
          "IndexedDB reset fence read failed.",
          fenceRead.error,
        )));
        tx.oncomplete = () => finish(() => resolve(result));
        tx.onerror = () => finish(() => reject(storageError(
          "IndexedDB fenced update transaction failed.",
          tx.error,
        )));
        tx.onabort = () => finish(() => reject(storageError(
          "IndexedDB fenced update transaction was aborted.",
          tx.error,
        )));
      } catch (error) {
        finish(() => reject(storageError(
          "IndexedDB fenced update transaction could not start.",
          error,
        )));
      }
    },
  ));
}

export function idbFencedRemove(
  key: string,
  expectedGeneration: number,
): Promise<boolean> {
  return openDB().then((db) => new Promise<boolean>((resolve, reject) => {
    let applied = false;
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      db.close();
      operation();
    };

    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const fenceRead = store.get(IDB_RESET_GENERATION_KEY);
      fenceRead.onsuccess = () => {
        const generation = normalizeResetGeneration(fenceRead.result);
        if (generation > expectedGeneration) return;
        if (generation < expectedGeneration) {
          const clearRequest = store.clear();
          clearRequest.onsuccess = () => {
            store.put(expectedGeneration, IDB_RESET_GENERATION_KEY);
            applied = true;
          };
          return;
        }
        applied = true;
        store.delete(key);
      };
      fenceRead.onerror = () => finish(() => reject(storageError(
        "IndexedDB reset fence read failed.",
        fenceRead.error,
      )));
      tx.oncomplete = () => finish(() => resolve(applied));
      tx.onerror = () => finish(() => reject(storageError(
        "IndexedDB fenced remove transaction failed.",
        tx.error,
      )));
      tx.onabort = () => finish(() => reject(storageError(
        "IndexedDB fenced remove transaction was aborted.",
        tx.error,
      )));
    } catch (error) {
      finish(() => reject(storageError(
        "IndexedDB fenced remove transaction could not start.",
        error,
      )));
    }
  }));
}

/**
 * Atomically clear all durable app values and advance the reset fence. Any
 * stale mutation transaction ordered afterward observes the new generation
 * and cannot recreate the cleared records.
 */
export function idbAdvanceResetGeneration(
  minimumGeneration = 0,
): Promise<number> {
  return openDB().then((db) => new Promise<number>((resolve, reject) => {
    let nextGeneration = 1;
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      db.close();
      operation();
    };

    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const fenceRead = store.get(IDB_RESET_GENERATION_KEY);
      fenceRead.onsuccess = () => {
        nextGeneration = Math.max(
          normalizeResetGeneration(fenceRead.result),
          normalizeResetGeneration(minimumGeneration),
        ) + 1;
        const clearRequest = store.clear();
        clearRequest.onsuccess = () => {
          store.put(nextGeneration, IDB_RESET_GENERATION_KEY);
        };
        clearRequest.onerror = () => finish(() => reject(storageError(
          "IndexedDB reset clear failed.",
          clearRequest.error,
        )));
      };
      fenceRead.onerror = () => finish(() => reject(storageError(
        "IndexedDB reset fence read failed.",
        fenceRead.error,
      )));
      tx.oncomplete = () => finish(() => resolve(nextGeneration));
      tx.onerror = () => finish(() => reject(storageError(
        "IndexedDB reset transaction failed.",
        tx.error,
      )));
      tx.onabort = () => finish(() => reject(storageError(
        "IndexedDB reset transaction was aborted.",
        tx.error,
      )));
    } catch (error) {
      finish(() => reject(storageError(
        "IndexedDB reset transaction could not start.",
        error,
      )));
    }
  }));
}

export function idbRemove(key: string): Promise<void> {
  return withStore<undefined>("readwrite", (store) =>
    store.delete(key) as IDBRequest<undefined>,
  ).then(() => undefined);
}

export function idbClear(): Promise<void> {
  return withStore<undefined>("readwrite", (store) =>
    store.clear() as IDBRequest<undefined>,
  ).then(() => undefined);
}
