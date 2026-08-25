import type {
  StorageMutationFailure,
  StorageMutationResult,
} from "./storage.ts";

export interface PersistenceHealthSnapshot {
  readonly failures: readonly StorageMutationFailure[];
  readonly canRetry: boolean;
}

interface PersistenceHealthStore {
  readonly getSnapshot: () => PersistenceHealthSnapshot;
  readonly report: (result: StorageMutationResult, retry?: () => void) => void;
  readonly retryFailures: () => void;
  readonly subscribe: (listener: () => void) => () => void;
}

const HEALTHY_SNAPSHOT: PersistenceHealthSnapshot = Object.freeze({
  failures: Object.freeze([]),
  canRetry: false,
});

function sameFailure(
  first: StorageMutationFailure | undefined,
  second: StorageMutationFailure,
): boolean {
  return Boolean(
    first &&
    first.operation === second.operation &&
    first.reason === second.reason,
  );
}

export function createPersistenceHealthStore(): PersistenceHealthStore {
  const failures = new Map<string, StorageMutationFailure>();
  const listeners = new Set<() => void>();
  const retries = new Map<string, () => void>();
  let snapshot = HEALTHY_SNAPSHOT;

  const publish = () => {
    snapshot = failures.size === 0
      ? HEALTHY_SNAPSHOT
      : Object.freeze({
          failures: Object.freeze([...failures.values()]),
          canRetry: retries.size > 0,
        });
    for (const listener of listeners) listener();
  };

  return Object.freeze({
    getSnapshot: () => snapshot,
    report: (result: StorageMutationResult, retry?: () => void) => {
      if (result.ok) {
        retries.delete(result.key);
        if (!failures.delete(result.key)) return;
        publish();
        return;
      }

      if (retry) retries.set(result.key, retry);
      if (sameFailure(failures.get(result.key), result)) {
        if (retry) publish();
        return;
      }
      failures.set(result.key, result);
      publish();
    },
    retryFailures: () => {
      for (const retry of [...retries.values()]) retry();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}

export const persistenceHealth = createPersistenceHealthStore();

export function trackPersistenceResult<T extends StorageMutationResult>(
  result: T,
  retry?: () => void,
): T {
  persistenceHealth.report(result, retry);
  return result;
}
