import {
  EMPTY_PROGRESS,
  mergeProgress,
  tryParseProgress,
  type ProgressData,
  type PuzzleRecord,
} from "./progress.ts";
import { persistenceHealth } from "./persistence-health.ts";
import {
  STORAGE_KEYS,
  readStoredValue,
  writeStoredValue,
  type StorageMutationResult,
} from "./storage.ts";

export const STORED_PROGRESS_VERSION = 2 as const;

export interface ProgressSyncSnapshot {
  readonly generation: number;
  readonly revision: number;
  readonly writerId: string;
  readonly progress: ProgressData;
}

export interface PersistedProgressUpdate {
  readonly previous: ProgressData;
  readonly snapshot: ProgressSyncSnapshot;
  readonly changed: boolean;
  readonly result: StorageMutationResult;
}

export interface ProgressReconciliation {
  readonly snapshot: ProgressSyncSnapshot;
  readonly shouldPersist: boolean;
}

function emptySnapshot(): ProgressSyncSnapshot {
  return {
    generation: 0,
    revision: 0,
    writerId: "",
    progress: EMPTY_PROGRESS,
  };
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseProgressSyncSnapshot(
  serialized: string | null,
): ProgressSyncSnapshot | null {
  if (!serialized) return null;

  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!isRecord(parsed)) return null;

    const progress = tryParseProgress(serialized);
    if (!progress) return null;

    if (parsed.version === 1) {
      return {
        generation: 0,
        revision: 0,
        writerId: "legacy",
        progress,
      };
    }

    if (
      parsed.version !== STORED_PROGRESS_VERSION ||
      !isNonNegativeInteger(parsed.generation) ||
      !isNonNegativeInteger(parsed.revision) ||
      typeof parsed.writerId !== "string" ||
      parsed.writerId.length === 0 ||
      parsed.writerId.length > 100
    ) {
      return null;
    }

    return {
      generation: parsed.generation,
      revision: parsed.revision,
      writerId: parsed.writerId,
      progress,
    };
  } catch {
    return null;
  }
}

export function loadProgressSyncSnapshot(): ProgressSyncSnapshot {
  return parseProgressSyncSnapshot(readStoredValue(STORAGE_KEYS.progress))
    ?? emptySnapshot();
}

export function createProgressWriterId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function canonicalRecord(
  first: PuzzleRecord | undefined,
  second: PuzzleRecord,
): PuzzleRecord {
  if (!first || second.moves < first.moves) return second;
  if (second.moves > first.moves) return first;

  const completedComparison = second.completedAt.localeCompare(first.completedAt);
  if (completedComparison < 0) return second;
  if (completedComparison > 0) return first;
  return second.pushes < first.pushes ? second : first;
}

/**
 * Same-generation clients converge on the fewest-move record. Equal-move
 * records use stable metadata tie-breakers so reconciliation cannot ping-pong.
 * User imports continue to use mergeProgress's current-record-wins rule.
 */
export function mergeConcurrentProgress(
  first: ProgressData,
  second: ProgressData,
): ProgressData {
  let changed = false;
  const completed: Record<string, PuzzleRecord> = { ...first.completed };

  for (const [puzzleId, candidate] of Object.entries(second.completed)) {
    const selected = canonicalRecord(completed[puzzleId], candidate);
    if (selected === completed[puzzleId]) continue;
    completed[puzzleId] = selected;
    changed = true;
  }

  return changed ? { version: 1, completed } : first;
}

function sameProgress(first: ProgressData, second: ProgressData): boolean {
  const firstEntries = Object.entries(first.completed);
  const secondEntries = Object.entries(second.completed);
  if (firstEntries.length !== secondEntries.length) return false;

  for (const [puzzleId, firstRecord] of firstEntries) {
    const secondRecord = second.completed[puzzleId];
    if (
      !secondRecord ||
      firstRecord.moves !== secondRecord.moves ||
      firstRecord.pushes !== secondRecord.pushes ||
      firstRecord.completedAt !== secondRecord.completedAt
    ) {
      return false;
    }
  }
  return true;
}

function serializeSnapshot(snapshot: ProgressSyncSnapshot): string {
  return JSON.stringify({
    version: STORED_PROGRESS_VERSION,
    generation: snapshot.generation,
    revision: snapshot.revision,
    writerId: snapshot.writerId,
    completed: snapshot.progress.completed,
  });
}

export function writeProgressSyncSnapshot(
  snapshot: ProgressSyncSnapshot,
): StorageMutationResult {
  const result = writeStoredValue(
    STORAGE_KEYS.progress,
    serializeSnapshot(snapshot),
  );
  persistenceHealth.report(result);
  return result;
}

function currentGenerationBase(
  local: ProgressSyncSnapshot,
  stored: ProgressSyncSnapshot,
): ProgressSyncSnapshot {
  if (stored.generation > local.generation) return stored;
  if (local.generation > stored.generation) return local;

  const progress = mergeConcurrentProgress(local.progress, stored.progress);
  return {
    generation: local.generation,
    revision: Math.max(local.revision, stored.revision),
    writerId: stored.revision >= local.revision
      ? stored.writerId
      : local.writerId,
    progress,
  };
}

export function persistProgressUpdate(
  local: ProgressSyncSnapshot,
  writerId: string,
  update: (progress: ProgressData) => ProgressData,
): PersistedProgressUpdate {
  const stored = loadProgressSyncSnapshot();
  const base = currentGenerationBase(local, stored);
  const progress = update(base.progress);
  const snapshot: ProgressSyncSnapshot = {
    generation: base.generation,
    revision: base.revision + 1,
    writerId,
    progress,
  };

  return {
    previous: base.progress,
    snapshot,
    changed: progress !== base.progress,
    result: writeProgressSyncSnapshot(snapshot),
  };
}

export function persistProgressImport(
  local: ProgressSyncSnapshot,
  writerId: string,
  imported: ProgressData,
): PersistedProgressUpdate {
  return persistProgressUpdate(
    local,
    writerId,
    (current) => mergeProgress(current, imported),
  );
}

export function persistProgressReset(
  local: ProgressSyncSnapshot,
  writerId: string,
): PersistedProgressUpdate {
  const stored = loadProgressSyncSnapshot();
  const generation = Math.max(local.generation, stored.generation) + 1;
  const snapshot: ProgressSyncSnapshot = {
    generation,
    revision: 0,
    writerId,
    progress: EMPTY_PROGRESS,
  };

  return {
    previous: currentGenerationBase(local, stored).progress,
    snapshot,
    changed: true,
    result: writeProgressSyncSnapshot(snapshot),
  };
}

export function reconcileProgressSnapshots(
  current: ProgressSyncSnapshot,
  incoming: ProgressSyncSnapshot,
  writerId: string,
): ProgressReconciliation {
  if (incoming.generation > current.generation) {
    return { snapshot: incoming, shouldPersist: false };
  }

  if (incoming.generation < current.generation) {
    return {
      snapshot: {
        ...current,
        revision: current.revision + 1,
        writerId,
      },
      shouldPersist: true,
    };
  }

  const progress = mergeConcurrentProgress(current.progress, incoming.progress);
  const maxRevision = Math.max(current.revision, incoming.revision);
  if (sameProgress(progress, incoming.progress)) {
    return {
      snapshot: {
        generation: current.generation,
        revision: maxRevision,
        writerId: incoming.revision >= current.revision
          ? incoming.writerId
          : current.writerId,
        progress,
      },
      shouldPersist: false,
    };
  }

  return {
    snapshot: {
      generation: current.generation,
      revision: maxRevision + 1,
      writerId,
      progress,
    },
    shouldPersist: true,
  };
}
