import type {
  StorageMutationFailure,
  StorageMutationResult,
} from "./storage.ts";

export interface PersistenceHealthSnapshot {
  readonly failures: readonly StorageMutationFailure[];
}

export interface PersistenceHealthStore {
  readonly getSnapshot: () => PersistenceHealthSnapshot;
  readonly report: (result: StorageMutationResult) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

const HEALTHY_SNAPSHOT: PersistenceHealthSnapshot = Object.freeze({
  failures: Object.freeze([]),
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
  let snapshot = HEALTHY_SNAPSHOT;

  const publish = () => {
    snapshot = failures.size === 0
      ? HEALTHY_SNAPSHOT
      : Object.freeze({
          failures: Object.freeze([...failures.values()]),
        });
    for (const listener of listeners) listener();
  };

  return Object.freeze({
    getSnapshot: () => snapshot,
    report: (result: StorageMutationResult) => {
      if (result.ok) {
        if (!failures.delete(result.key)) return;
        publish();
        return;
      }

      if (sameFailure(failures.get(result.key), result)) return;
      failures.set(result.key, result);
      publish();
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
): T {
  persistenceHealth.report(result);
  return result;
}
