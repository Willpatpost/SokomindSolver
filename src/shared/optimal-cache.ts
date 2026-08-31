import {
  DOCUMENT_APP_RESET_GENERATION,
  STORAGE_KEYS,
  documentCanPersistAppData,
  readStoredValue,
  writeStoredValue,
  type StorageMutationResult,
} from "./storage.ts";
import { trackPersistenceResult } from "./persistence-health.ts";
import { idbFencedGet, idbFencedUpdate } from "./idb-storage.ts";
import { isRecord } from "../core/type-guards.ts";
import { isPuzzleRevisionFingerprint } from "../core/puzzle-revision.ts";

export interface OptimalRecord {
  readonly moves: number;
  readonly pushes: number;
}

export interface OptimalCache {
  readonly version: 6;
  readonly records: Readonly<Record<string, OptimalRecord>>;
}

type OptimalCacheMutationResult = StorageMutationResult & {
  readonly cache: OptimalCache;
  readonly durable: Promise<boolean>;
};

const EMPTY_CACHE: OptimalCache = Object.freeze({
  version: 6,
  records: Object.freeze({}),
});

const IDB_KEY = STORAGE_KEYS.optimal;

function isValidCount(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0;
}

function normalizeRecord(value: unknown): OptimalRecord | undefined {
  if (!isRecord(value)) return undefined;
  const expectedKeys = new Set(["moves", "pushes"]);
  const keys = Object.keys(value);
  if (
    keys.length !== expectedKeys.size ||
    keys.some((key) => !expectedKeys.has(key))
  ) {
    return undefined;
  }
  if (!isValidCount(value.moves) || !isValidCount(value.pushes)) {
    return undefined;
  }
  if (value.pushes > value.moves) return undefined;
  return Object.freeze({ moves: value.moves, pushes: value.pushes });
}

function optimalRecordKey(puzzleId: string, puzzleFingerprint: string): string {
  return JSON.stringify([puzzleId, puzzleFingerprint]);
}

function isValidOptimalRecordKey(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      parsed[0].length > 0 &&
      isPuzzleRevisionFingerprint(parsed[1]);
  } catch {
    return false;
  }
}

/**
 * Accept only records created by the corrected proof pipeline. Versions 1-3
 * could contain false IDA* optimality certificates created by path-dependent
 * backed-f transposition pruning. Version 4 could contain false certificates
 * created by the unsound goal-depth macro prune. Version 5 keyed proofs only
 * by puzzle ID, so a changed board could inherit a stale certificate.
 */
export function normalizeOptimalCache(value: unknown): OptimalCache {
  if (!isRecord(value) || !isRecord(value.records)) return EMPTY_CACHE;
  if (value.version !== 6) return EMPTY_CACHE;

  const records: Record<string, OptimalRecord> = {};
  for (const [recordKey, candidate] of Object.entries(value.records)) {
    if (!isValidOptimalRecordKey(recordKey)) continue;
    const record = normalizeRecord(candidate);
    if (record) records[recordKey] = record;
  }
  return Object.freeze({
    version: 6,
    records: Object.freeze(records),
  });
}

function betterRecord(
  first: OptimalRecord | undefined,
  second: OptimalRecord,
): OptimalRecord {
  if (!first || second.moves < first.moves) return second;
  if (second.moves > first.moves) return first;
  return second.pushes < first.pushes ? second : first;
}

export function mergeOptimalCaches(
  first: OptimalCache,
  second: OptimalCache,
): OptimalCache {
  let changed = false;
  const records: Record<string, OptimalRecord> = { ...first.records };
  for (const [puzzleId, candidate] of Object.entries(second.records)) {
    const selected = betterRecord(records[puzzleId], candidate);
    if (selected === records[puzzleId]) continue;
    records[puzzleId] = selected;
    changed = true;
  }
  if (!changed) return first;
  return Object.freeze({
    version: 6,
    records: Object.freeze(records),
  });
}

export function parseOptimalCache(serialized: string | null): OptimalCache {
  if (!serialized) return EMPTY_CACHE;
  try {
    return normalizeOptimalCache(JSON.parse(serialized) as unknown);
  } catch {
    return EMPTY_CACHE;
  }
}

/**
 * Synchronously loads the optimal cache from localStorage (fast, for first
 * paint). Call `hydrateOptimalCacheFromIDB` afterward to upgrade with any
 * richer data stored in IndexedDB.
 */
export function loadOptimalCache(): OptimalCache {
  return parseOptimalCache(readStoredValue(STORAGE_KEYS.optimal));
}

/**
 * Asynchronously loads the optimal cache from IndexedDB. Returns the IDB
 * copy merged with the synchronous localStorage result. Conflicts retain the
 * lower proven move count, so neither storage tier can erase a stronger proof.
 */
export async function hydrateOptimalCacheFromIDB(
  current: OptimalCache,
): Promise<OptimalCache> {
  try {
    const stored = await idbFencedGet<OptimalCache>(
      IDB_KEY,
      DOCUMENT_APP_RESET_GENERATION,
    );
    if (!stored) return current;
    return mergeOptimalCaches(current, normalizeOptimalCache(stored));
  } catch {
    return current;
  }
}

/**
 * Persists the cache to localStorage (synchronous, tracked by
 * persistence-health) and to IndexedDB in the background for quota
 * resilience. If localStorage fails due to quota, IDB still succeeds.
 */
export function saveOptimalCache(cache: OptimalCache): OptimalCacheMutationResult {
  if (!documentCanPersistAppData()) {
    const result = trackPersistenceResult({
      ok: false,
      key: STORAGE_KEYS.optimal,
      operation: "write",
      reason: "unavailable",
    } as const);
    return {
      ...result,
      cache,
      durable: Promise.resolve(false),
    };
  }

  // Re-read localStorage at the write boundary. This closes the usual stale-tab
  // window; storage-event reconciliation below handles truly simultaneous
  // writes, while the IndexedDB update is atomic.
  const merged = mergeOptimalCaches(loadOptimalCache(), cache);
  const result = trackPersistenceResult(
    writeStoredValue(STORAGE_KEYS.optimal, JSON.stringify(merged)),
  );

  const idbWrite = idbFencedUpdate(
    IDB_KEY,
    DOCUMENT_APP_RESET_GENERATION,
    (stored) => mergeOptimalCaches(normalizeOptimalCache(stored), merged),
  ).then((outcome) => outcome.applied).catch(() => false);

  return {
    ...result,
    cache: merged,
    durable: result.ok ? Promise.resolve(true) : idbWrite,
  };
}

export function setOptimalRecord(
  cache: OptimalCache,
  puzzleId: string,
  puzzleFingerprint: string,
  record: OptimalRecord,
): OptimalCache {
  const key = optimalRecordKey(puzzleId, puzzleFingerprint);
  return {
    version: 6,
    records: { ...cache.records, [key]: record },
  };
}

export function isOptimal(
  cache: OptimalCache,
  puzzleId: string,
  puzzleFingerprint: string,
  playerMoves: number,
): boolean {
  const record = getOptimalRecord(cache, puzzleId, puzzleFingerprint);
  if (!record) return false;
  return playerMoves <= record.moves;
}

export function getOptimalRecord(
  cache: OptimalCache,
  puzzleId: string,
  puzzleFingerprint: string,
): OptimalRecord | undefined {
  return cache.records[optimalRecordKey(puzzleId, puzzleFingerprint)];
}
