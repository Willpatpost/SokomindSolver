interface RequestStub<T> {
  result: T;
  error: DOMException | null;
  onsuccess: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
}

interface TransactionStub {
  error: DOMException | null;
  oncomplete: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  onabort: ((event: Event) => void) | null;
  objectStore: () => IDBObjectStore;
  abort: () => void;
}

export interface MemoryIndexedDB {
  readonly factory: IDBFactory;
  readonly values: Map<IDBValidKey, unknown>;
  readonly stats: {
    opens: number;
    closes: number;
    upgrades: number;
    clears: number;
  };
}

export interface MemoryIndexedDBOptions {
  readonly beforeOpenSuccess?: (openNumber: number) => Promise<void> | void;
}

function requestStub<T>(result: T): RequestStub<T> {
  return {
    result,
    error: null,
    onsuccess: null,
    onerror: null,
  };
}

/**
 * A deliberately small, event-ordered IndexedDB implementation for unit
 * tests. It models one key/value store and resolves transactions only after
 * their requests have succeeded.
 */
export function createMemoryIndexedDB(
  initial: Iterable<readonly [IDBValidKey, unknown]> = [],
  options: MemoryIndexedDBOptions = {},
): MemoryIndexedDB {
  const values = new Map<IDBValidKey, unknown>(initial);
  const stats = { opens: 0, closes: 0, upgrades: 0, clears: 0 };
  let storeExists = false;

  const factory = {
    open: () => {
      stats.opens += 1;
      const openNumber = stats.opens;
      let closed = false;
      const database = {
        objectStoreNames: {
          contains: (name: string) => name === "kv" && storeExists,
        },
        createObjectStore: (name: string) => {
          if (name === "kv") storeExists = true;
          return {} as IDBObjectStore;
        },
        close: () => {
          if (closed) return;
          closed = true;
          stats.closes += 1;
        },
        transaction: () => {
          let finished = false;
          let aborted = false;
          let pendingRequests = 0;
          const complete = () => queueMicrotask(() => {
            if (finished || aborted || pendingRequests > 0) return;
            finished = true;
            transaction.oncomplete?.(new Event("complete"));
          });
          const beginRequest = () => {
            pendingRequests += 1;
          };
          const finishRequest = () => {
            pendingRequests -= 1;
            if (pendingRequests === 0) complete();
          };
          const transaction: TransactionStub = {
            error: null,
            oncomplete: null,
            onerror: null,
            onabort: null,
            abort: () => {
              if (finished || aborted) return;
              aborted = true;
              queueMicrotask(() => {
                transaction.onabort?.(new Event("abort"));
              });
            },
            objectStore: () => ({
              get: (key: IDBValidKey) => {
                beginRequest();
                const request = requestStub(values.get(key));
                queueMicrotask(() => {
                  if (aborted) return;
                  request.onsuccess?.(new Event("success"));
                  finishRequest();
                });
                return request as unknown as IDBRequest;
              },
              put: (value: unknown, key?: IDBValidKey) => {
                beginRequest();
                const request = requestStub(key as IDBValidKey);
                queueMicrotask(() => {
                  if (aborted) return;
                  values.set(key as IDBValidKey, value);
                  request.onsuccess?.(new Event("success"));
                  finishRequest();
                });
                return request as unknown as IDBRequest;
              },
              delete: (key: IDBValidKey) => {
                beginRequest();
                const request = requestStub(undefined);
                queueMicrotask(() => {
                  if (aborted) return;
                  values.delete(key);
                  request.onsuccess?.(new Event("success"));
                  finishRequest();
                });
                return request as unknown as IDBRequest;
              },
              clear: () => {
                beginRequest();
                const request = requestStub(undefined);
                queueMicrotask(() => {
                  if (aborted) return;
                  values.clear();
                  stats.clears += 1;
                  request.onsuccess?.(new Event("success"));
                  finishRequest();
                });
                return request as unknown as IDBRequest;
              },
            } as IDBObjectStore),
          };
          return transaction as unknown as IDBTransaction;
        },
      };
      const request = {
        result: database as unknown as IDBDatabase,
        error: null as DOMException | null,
        onupgradeneeded: null as ((event: IDBVersionChangeEvent) => void) | null,
        onsuccess: null as ((event: Event) => void) | null,
        onerror: null as ((event: Event) => void) | null,
        onblocked: null as ((event: IDBVersionChangeEvent) => void) | null,
      };
      const finishOpen = () => {
        if (!storeExists) {
          stats.upgrades += 1;
          request.onupgradeneeded?.(new Event("upgradeneeded") as IDBVersionChangeEvent);
        }
        request.onsuccess?.(new Event("success"));
      };
      queueMicrotask(() => {
        Promise.resolve(options.beforeOpenSuccess?.(openNumber)).then(finishOpen);
      });
      return request as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;

  return { factory, values, stats };
}

export function installIndexedDB(factory: IDBFactory): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: factory,
  });
  return () => {
    if (descriptor) {
      Object.defineProperty(globalThis, "indexedDB", descriptor);
    } else {
      Reflect.deleteProperty(globalThis, "indexedDB");
    }
  };
}

export async function flushIndexedDB(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
