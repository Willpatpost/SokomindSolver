import {
  createSession,
  isActionLog,
  replayActionLog,
  type GameSession,
  type PuzzleDefinition,
} from "../core/index.ts";
import {
  DOCUMENT_APP_RESET_GENERATION,
  LEGACY_STORAGE_KEYS,
  STORAGE_KEYS,
  documentCanPersistAppData,
  readStoredValue,
  removeStoredValue,
  writeStoredValue,
  type StorageMutationResult,
} from "./storage.ts";
import { trackPersistenceResult } from "./persistence-health.ts";
import {
  idbFencedRemove,
  idbFencedGet,
  idbFencedUpdate,
} from "./idb-storage.ts";
import { isRecord } from "../core/type-guards.ts";

export const SAVED_SESSION_VERSION = 1 as const;
export const MAX_SAVED_ACTIONS = 100_000;
export const MAX_SAVED_SESSION_FUTURE_SKEW_MS = 5 * 60 * 1_000;

export interface SavedSession {
  readonly version: typeof SAVED_SESSION_VERSION;
  readonly puzzleId: string;
  readonly actionLog: string;
  readonly updatedAt: string;
}

export interface RestoredSession {
  readonly session: GameSession;
  readonly resumed: boolean;
}

export type PuzzleResolver = (
  puzzleId: string,
) => PuzzleDefinition | undefined;

export type PuzzleIdPredicate = (puzzleId: string) => boolean;

const IDB_KEY = STORAGE_KEYS.session;
let lastSavedAtMs = 0;

function nextSavedSessionTimestamp(): string {
  lastSavedAtMs = Math.max(Date.now(), lastSavedAtMs + 1);
  return new Date(lastSavedAtMs).toISOString();
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function savedAt(saved: SavedSession): number {
  return Date.parse(saved.updatedAt);
}

function isImplausiblyFuture(
  saved: SavedSession,
  referenceTime = Date.now(),
): boolean {
  return savedAt(saved) > referenceTime + MAX_SAVED_SESSION_FUTURE_SKEW_MS;
}

export function parseSavedSession(serialized: string | null): SavedSession | null {
  if (!serialized) return null;

  try {
    const value: unknown = JSON.parse(serialized);
    if (
      !isRecord(value) ||
      value.version !== SAVED_SESSION_VERSION ||
      typeof value.puzzleId !== "string" ||
      value.puzzleId.length === 0 ||
      value.puzzleId.length > 100 ||
      !isActionLog(value.actionLog) ||
      value.actionLog.length > MAX_SAVED_ACTIONS ||
      !isCanonicalTimestamp(value.updatedAt)
    ) {
      return null;
    }

    return Object.freeze({
      version: SAVED_SESSION_VERSION,
      puzzleId: value.puzzleId,
      actionLog: value.actionLog,
      updatedAt: value.updatedAt,
    });
  } catch {
    return null;
  }
}

function parseSavedSessionFromUnknown(value: unknown): SavedSession | null {
  if (!isRecord(value)) return null;
  if (
    value.version !== SAVED_SESSION_VERSION ||
    typeof value.puzzleId !== "string" ||
    value.puzzleId.length === 0 ||
    value.puzzleId.length > 100 ||
    !isActionLog(value.actionLog) ||
    value.actionLog.length > MAX_SAVED_ACTIONS ||
    !isCanonicalTimestamp(value.updatedAt)
  ) {
    return null;
  }
  return Object.freeze({
    version: SAVED_SESSION_VERSION,
    puzzleId: value.puzzleId,
    actionLog: value.actionLog,
    updatedAt: value.updatedAt,
  });
}

export function restoreSession(
  saved: SavedSession,
  resolvePuzzle: PuzzleResolver,
): GameSession | null {
  const puzzle = resolvePuzzle(saved.puzzleId);
  if (!puzzle) return null;

  try {
    return replayActionLog(puzzle, saved.actionLog);
  } catch {
    // Stored moves are untrusted. Invalid or newly-incompatible attempts are
    // ignored instead of constructing a state the game engine cannot reach.
    return null;
  }
}

/**
 * Synchronously loads the session from localStorage for instant restore on
 * page load. Call `hydrateSessionFromIDB` afterward to pick up any session
 * that was saved only to IndexedDB (e.g. when localStorage quota was full).
 */
export function loadSession(
  resolvePuzzle: PuzzleResolver,
): RestoredSession | null {
  const stored = parseSavedSession(readStoredValue(STORAGE_KEYS.session));
  if (stored && !isImplausiblyFuture(stored)) {
    const session = restoreSession(stored, resolvePuzzle);
    if (session) {
      return Object.freeze({
        session,
        resumed: session.actionLog.length > 0,
      });
    }
  }

  // One-time compatibility with the earlier Sokomind prototype, which saved
  // only the current puzzle id under the unnamespaced key.
  const legacyPuzzleId = readStoredValue(LEGACY_STORAGE_KEYS.currentPuzzle);
  const legacyPuzzle = legacyPuzzleId
    ? resolvePuzzle(legacyPuzzleId)
    : undefined;
  if (!legacyPuzzle) return null;

  return Object.freeze({
    session: createSession(legacyPuzzle),
    resumed: false,
  });
}

/**
 * Asynchronously attempts to load a session from IndexedDB. Returns a
 * `RestoredSession` only when IDB contains a newer session than `current`
 * (or when `current` is null and IDB has data). This lets callers upgrade
 * the synchronous localStorage result after IDB becomes available.
 */
export async function hydrateSessionFromIDB(
  resolvePuzzle: PuzzleResolver,
  current: RestoredSession | null,
): Promise<RestoredSession | null> {
  try {
    const idbData = await idbFencedGet<unknown>(
      IDB_KEY,
      DOCUMENT_APP_RESET_GENERATION,
    );
    if (!idbData) return current;

    const idbSaved = parseSavedSessionFromUnknown(idbData);
    if (!idbSaved) return current;
    if (isImplausiblyFuture(idbSaved)) return current;

    // If we already have a localStorage session, prefer whichever is newer.
    if (current) {
      const lsStored = parseSavedSession(readStoredValue(STORAGE_KEYS.session));
      if (
        lsStored &&
        !isImplausiblyFuture(lsStored) &&
        savedAt(lsStored) >= savedAt(idbSaved)
      ) {
        return current;
      }
    }

    const session = restoreSession(idbSaved, resolvePuzzle);
    if (!session) return current;

    return Object.freeze({
      session,
      resumed: session.actionLog.length > 0,
    });
  } catch {
    return current;
  }
}

/**
 * Resolve only the saved catalog pointer for lightweight entry screens. The
 * Play route performs the full board replay before it resumes an attempt.
 */
export function loadSessionPuzzleId(
  isKnownPuzzleId: PuzzleIdPredicate,
): string | null {
  const stored = parseSavedSession(readStoredValue(STORAGE_KEYS.session));
  if (
    stored &&
    !isImplausiblyFuture(stored) &&
    isKnownPuzzleId(stored.puzzleId)
  ) {
    return stored.puzzleId;
  }

  const legacyPuzzleId = readStoredValue(LEGACY_STORAGE_KEYS.currentPuzzle);
  return legacyPuzzleId && isKnownPuzzleId(legacyPuzzleId)
    ? legacyPuzzleId
    : null;
}

/**
 * Resolves the newest lightweight resume pointer across localStorage and the
 * generation-fenced IndexedDB mirror. This is intentionally board-free so an
 * entry screen can discover an IDB-only session before choosing a Play route.
 */
export async function loadSessionPuzzleIdFromIDB(
  isKnownPuzzleId: PuzzleIdPredicate,
): Promise<string | null> {
  const local = parseSavedSession(readStoredValue(STORAGE_KEYS.session));
  let selected = local &&
    !isImplausiblyFuture(local) &&
    isKnownPuzzleId(local.puzzleId)
    ? local
    : null;

  try {
    const raw = await idbFencedGet<unknown>(
      IDB_KEY,
      DOCUMENT_APP_RESET_GENERATION,
    );
    const indexed = parseSavedSessionFromUnknown(raw);
    if (
      indexed &&
      !isImplausiblyFuture(indexed) &&
      isKnownPuzzleId(indexed.puzzleId) &&
      (!selected || savedAt(indexed) > savedAt(selected))
    ) {
      selected = indexed;
    }
  } catch {
    // IndexedDB is an optional resilience layer; keep the synchronous result.
  }

  return selected?.puzzleId ?? loadSessionPuzzleId(isKnownPuzzleId);
}

/**
 * Saves the session to both localStorage (for instant sync restore on
 * reload) and IndexedDB (for quota resilience with large action logs).
 */
export function saveSession(session: GameSession): StorageMutationResult {
  if (!documentCanPersistAppData()) {
    return { ok: true, key: STORAGE_KEYS.session, operation: "write" };
  }

  const saved: SavedSession = {
    version: SAVED_SESSION_VERSION,
    puzzleId: session.puzzle.id,
    actionLog: session.actionLog,
    updatedAt: nextSavedSessionTimestamp(),
  };

  const result = trackPersistenceResult(
    writeStoredValue(STORAGE_KEYS.session, JSON.stringify(saved)),
  );

  // Keep the newest completed write when rapid moves schedule overlapping IDB
  // transactions on different browser connections.
  void idbFencedUpdate(IDB_KEY, DOCUMENT_APP_RESET_GENERATION, (current) => {
    const stored = parseSavedSessionFromUnknown(current);
    return stored &&
      !isImplausiblyFuture(stored, savedAt(saved)) &&
      savedAt(stored) > savedAt(saved)
      ? stored
      : saved;
  }).catch(() => {});

  return result;
}

export function clearSession(): StorageMutationResult {
  if (!documentCanPersistAppData()) {
    return { ok: true, key: STORAGE_KEYS.session, operation: "remove" };
  }

  // Background-clear from IndexedDB; fire-and-forget.
  void idbFencedRemove(IDB_KEY, DOCUMENT_APP_RESET_GENERATION).catch(() => {});

  return trackPersistenceResult(removeStoredValue(STORAGE_KEYS.session));
}
