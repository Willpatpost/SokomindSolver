import {
  createProgressWriterId,
  loadProgressSyncSnapshot,
  persistProgressReset,
  type PersistedProgressUpdate,
} from "./progress-sync.ts";
import { persistenceHealth } from "./persistence-health.ts";
import {
  idbAdvanceResetGeneration,
  IndexedDBUnavailableError,
} from "./idb-storage.ts";
import {
  DOCUMENT_APP_RESET_GENERATION,
  STORAGE_KEYS,
  clearAppSessionStorage,
  clearAppStorage,
  loadAppResetGeneration,
  parseAppResetMarker,
  writeStoredValue,
  type StorageMutationFailure,
} from "./storage.ts";

export class AppDataResetError extends Error {
  override readonly name = "AppDataResetError";
  readonly storageFailures: readonly StorageMutationFailure[];
  readonly indexedDBFailure?: unknown;

  constructor(
    storageFailures: readonly StorageMutationFailure[],
    indexedDBFailure?: unknown,
  ) {
    const details = storageFailures.map((failure) =>
      `${failure.operation} ${failure.key}: ${failure.reason}`);
    if (indexedDBFailure instanceof Error) details.push(indexedDBFailure.message);
    super(`Sokomind could not clear all saved data: ${details.join("; ")}`);
    this.storageFailures = storageFailures;
    this.indexedDBFailure = indexedDBFailure;
  }
}

/**
 * Clear every owned preference/session/cache key while retaining a higher-
 * generation empty progress tombstone. Active tabs can therefore observe the
 * reset and cannot merge their stale pre-reset records back into storage.
 */
export async function resetAppData(): Promise<PersistedProgressUpdate> {
  const progressBeforeReset = loadProgressSyncSnapshot();
  const previousResetGeneration = loadAppResetGeneration();
  const writerId = createProgressWriterId();
  // Advance the durable fence and clear the quota-resilient copies in the
  // same transaction. A pending pre-reset write is then either cleared before
  // this commits or observes the new generation and becomes a no-op.
  let indexedDBFailure: unknown;
  let resetGeneration = previousResetGeneration + 1;
  try {
    resetGeneration = await idbAdvanceResetGeneration(previousResetGeneration);
  } catch (error) {
    // Browsers without IndexedDB have no secondary data to clear. A real
    // transaction failure is different: surface it so the recovery UI cannot
    // claim a complete reset while durable records may remain.
    if (!(error instanceof IndexedDBUnavailableError)) indexedDBFailure = error;
  }

  // Do the local clear only after the asynchronous IDB phase. These operations
  // and the completion marker now run in one synchronous turn, leaving no
  // await window in which an active tab can repopulate a cleared local key.
  const clearResults = clearAppStorage();
  for (const result of clearResults) persistenceHealth.report(result);
  const reset = persistProgressReset(
    progressBeforeReset,
    writerId,
  );

  const storageFailures = [...clearResults, reset.result].filter(
    (result): result is StorageMutationFailure => !result.ok,
  );

  // Broadcast only after both storage tiers are known to be clear. Otherwise
  // another tab could treat an incomplete reset as successful and reload into
  // data that the recovery action claimed to remove.
  if (storageFailures.length === 0 && indexedDBFailure === undefined) {
    const markerResult = writeStoredValue(
      STORAGE_KEYS.reset,
      JSON.stringify({
        version: 1,
        generation: resetGeneration,
        writerId,
        resetAt: new Date().toISOString(),
      }),
    );
    persistenceHealth.report(markerResult);
    if (!markerResult.ok) storageFailures.push(markerResult);
  }

  if (storageFailures.length > 0 || indexedDBFailure !== undefined) {
    throw new AppDataResetError(storageFailures, indexedDBFailure);
  }
  return reset;
}

/**
 * Other same-origin tabs receive the retained reset marker after all owned
 * local data and the progress tombstone have been written. Clear their private
 * timers and reload at the hash-free app entry so mounted sessions cannot save
 * pre-reset state again.
 */
export function installCrossTabAppResetListener(): () => void {
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEYS.reset) return;
    const marker = parseAppResetMarker(event.newValue);
    if (!marker || marker.generation <= DOCUMENT_APP_RESET_GENERATION) return;
    clearAppSessionStorage();
    const entry = new URL(window.location.href);
    entry.hash = "";
    entry.searchParams.set("_r", Date.now().toString(36));
    window.addEventListener("beforeunload", clearAppSessionStorage, {
      once: true,
    });
    window.addEventListener("pagehide", clearAppSessionStorage, { once: true });
    window.location.replace(entry.href);
  };
  window.addEventListener("storage", handleStorage);
  return () => window.removeEventListener("storage", handleStorage);
}
