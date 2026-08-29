/**
 * The only module that talks directly to Web Storage.
 *
 * GitHub project pages share an origin, so every key is application-namespaced.
 * Reads and writes deliberately fail closed: private browsing, storage quotas,
 * and hardened browser settings must never prevent the game from running.
 */
export const STORAGE_KEYS = Object.freeze({
  progress: "sokomind.progress.v1",
  experience: "sokomind.experience.v2",
  session: "sokomind.session.v1",
  optimal: "sokomind.optimal.v4",
  personalBestRoutes: "sokomind.personal-best-routes.v1",
  reset: "sokomind.reset.v1",
  ratings: "sokomind.ratings.v1",
  favorites: "sokomind.favorites.v1",
  guidedJourney: "sokomind.guided-journey.v1",
  editorDraft: "sokomind.editor-draft.v1",
  editorDraftRecovery: "sokomind.editor-draft-recovery.v1",
});

export const LEGACY_STORAGE_KEYS = Object.freeze({
  progress: "sokomind.progress.v1",
  experience: "sokomind.experience.v1",
  currentPuzzle: "sokomind.current-puzzle.v1",
  optimal: "sokomind.optimal.v1",
  optimalV2: "sokomind.optimal.v2",
  optimalV3: "sokomind.optimal.v3",
});

export const APP_STORAGE_KEYS: readonly string[] = Object.freeze([
  ...new Set([...Object.values(STORAGE_KEYS), ...Object.values(LEGACY_STORAGE_KEYS)]),
]);

export const APP_SESSION_STORAGE_KEYS: readonly string[] = Object.freeze([
  "sokomind:timer",
]);

export const APP_SESSION_STORAGE_PREFIXES: readonly string[] = Object.freeze([
  "sokomind:timer:",
]);

export type StorageMutationOperation = "write" | "remove";
export type StorageFailureReason =
  | "unavailable"
  | "quota-exceeded"
  | "security-error"
  | "unknown";

export interface StorageMutationSuccess {
  readonly ok: true;
  readonly key: string;
  readonly operation: StorageMutationOperation;
}

export interface StorageMutationFailure {
  readonly ok: false;
  readonly key: string;
  readonly operation: StorageMutationOperation;
  readonly reason: StorageFailureReason;
}

export type StorageMutationResult =
  | StorageMutationSuccess
  | StorageMutationFailure;

export interface AppResetMarker {
  readonly version: 1;
  readonly generation: number;
  readonly writerId: string;
  readonly resetAt: string;
}

function storageFailureReason(error: unknown): StorageFailureReason {
  const name = error && typeof error === "object" && "name" in error
    ? String(error.name)
    : "";
  if (name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED") {
    return "quota-exceeded";
  }
  if (name === "SecurityError") return "security-error";
  return "unknown";
}

function successfulMutation(
  key: string,
  operation: StorageMutationOperation,
): StorageMutationSuccess {
  return { ok: true, key, operation };
}

function failedMutation(
  key: string,
  operation: StorageMutationOperation,
  reason: StorageFailureReason,
): StorageMutationFailure {
  return { ok: false, key, operation, reason };
}

function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function browserSessionStorage(): Storage | null {
  if (typeof window === "undefined") return null;

  try {
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function readStoredValue(
  key: string,
  legacyKeys: readonly string[] = [],
): string | null {
  const storage = browserStorage();
  if (!storage) return null;

  try {
    const current = storage.getItem(key);
    if (current !== null) return current;

    for (const legacyKey of legacyKeys) {
      const legacy = storage.getItem(legacyKey);
      if (legacy === null) continue;

      try {
        storage.setItem(key, legacy);
      } catch {
        // The legacy value is still usable for this page load.
      }
      return legacy;
    }
  } catch {
    return null;
  }

  return null;
}

export function parseAppResetMarker(
  serialized: string | null,
): AppResetMarker | null {
  if (!serialized) return null;

  try {
    const value: unknown = JSON.parse(serialized);
    if (
      !value ||
      typeof value !== "object" ||
      !("writerId" in value) ||
      typeof value.writerId !== "string" ||
      value.writerId.length === 0 ||
      !("resetAt" in value) ||
      typeof value.resetAt !== "string" ||
      !Number.isFinite(Date.parse(value.resetAt))
    ) {
      return null;
    }

    // Builds before the durable IDB fence retained this two-field marker.
    // Treat it as the first reset generation so upgrading cannot hydrate the
    // IndexedDB records those builds failed to clear reliably.
    const legacyMarker = !("version" in value) && !("generation" in value);
    const generation = legacyMarker
      ? 1
      : "version" in value &&
          value.version === 1 &&
          "generation" in value &&
          typeof value.generation === "number" &&
          Number.isSafeInteger(value.generation) &&
          value.generation >= 0
        ? value.generation
        : null;
    if (generation === null) return null;

    return Object.freeze({
      version: 1,
      generation,
      writerId: value.writerId,
      resetAt: value.resetAt,
    });
  } catch {
    return null;
  }
}

export function loadAppResetGeneration(): number {
  return parseAppResetMarker(readStoredValue(STORAGE_KEYS.reset))?.generation ?? 0;
}

/**
 * A page keeps the generation it observed at startup. It must not adopt a
 * newer reset generation without reloading, because its mounted state may
 * still contain pre-reset sessions or solver results.
 */
export const DOCUMENT_APP_RESET_GENERATION = loadAppResetGeneration();

export function documentCanPersistAppData(): boolean {
  return loadAppResetGeneration() === DOCUMENT_APP_RESET_GENERATION;
}

export function writeStoredValue(
  key: string,
  value: string,
): StorageMutationResult {
  const storage = browserStorage();
  if (!storage) return failedMutation(key, "write", "unavailable");

  try {
    storage.setItem(key, value);
    return successfulMutation(key, "write");
  } catch (error) {
    return failedMutation(key, "write", storageFailureReason(error));
  }
}

export function removeStoredValue(key: string): StorageMutationResult {
  const storage = browserStorage();
  if (!storage) return failedMutation(key, "remove", "unavailable");

  try {
    storage.removeItem(key);
    return successfulMutation(key, "remove");
  } catch (error) {
    return failedMutation(key, "remove", storageFailureReason(error));
  }
}

export function clearAppStorage(): readonly StorageMutationResult[] {
  const results = APP_STORAGE_KEYS.map((key) => removeStoredValue(key));
  return [...results, ...clearAppSessionStorage()];
}

export function clearAppSessionStorage(): readonly StorageMutationResult[] {
  const session = browserSessionStorage();
  if (!session) {
    return APP_SESSION_STORAGE_KEYS.map((key) =>
      failedMutation(key, "remove", "unavailable"));
  }

  const results: StorageMutationResult[] = [];
  const ownedDynamicKeys: string[] = [];
  try {
    for (let index = 0; index < session.length; index += 1) {
      const key = session.key(index);
      if (
        key &&
        APP_SESSION_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix))
      ) {
        ownedDynamicKeys.push(key);
      }
    }
  } catch (error) {
    results.push(failedMutation(
      "sokomind:timer:*",
      "remove",
      storageFailureReason(error),
    ));
  }

  for (const key of [...APP_SESSION_STORAGE_KEYS, ...ownedDynamicKeys]) {
    try {
      session.removeItem(key);
      results.push(successfulMutation(key, "remove"));
    } catch (error) {
      results.push(failedMutation(
        key,
        "remove",
        storageFailureReason(error),
      ));
    }
  }
  return results;
}
