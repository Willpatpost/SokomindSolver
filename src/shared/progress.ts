import {
  LEGACY_STORAGE_KEYS,
  STORAGE_KEYS,
  readStoredValue,
} from "./storage.ts";

export interface PuzzleRecord {
  readonly moves: number;
  readonly pushes: number;
  readonly completedAt: string;
}

export interface ProgressData {
  readonly version: 1;
  readonly completed: Readonly<Record<string, PuzzleRecord>>;
}

export interface NormalizedProgress {
  readonly progress: ProgressData;
  readonly ignoredPuzzleIds: readonly string[];
}

export const EMPTY_PROGRESS: ProgressData = Object.freeze({
  version: 1,
  completed: Object.freeze({}),
});

function isBetterRecord(
  candidate: Pick<PuzzleRecord, "moves" | "pushes">,
  current: Pick<PuzzleRecord, "moves" | "pushes"> | undefined,
): boolean {
  return !current || candidate.moves < current.moves;
}

function isPuzzleRecord(value: unknown): value is PuzzleRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<PuzzleRecord>;
  const completedAt = typeof record.completedAt === "string"
    ? Date.parse(record.completedAt)
    : Number.NaN;
  return (
    Number.isSafeInteger(record.moves) &&
    Number(record.moves) >= 0 &&
    Number.isSafeInteger(record.pushes) &&
    Number(record.pushes) >= 0 &&
    Number(record.pushes) <= Number(record.moves) &&
    Number.isFinite(completedAt) &&
    new Date(completedAt).toISOString() === record.completedAt
  );
}

export function tryParseProgress(value: string | null): ProgressData | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value) as {
      version?: unknown;
      completed?: unknown;
    };
    if (
      (parsed.version !== 1 && parsed.version !== 2) ||
      !parsed.completed ||
      typeof parsed.completed !== "object"
    ) {
      return null;
    }

    const completed = Object.fromEntries(
      Object.entries(parsed.completed).filter((entry): entry is [string, PuzzleRecord] =>
        isPuzzleRecord(entry[1]),
      ),
    );
    return { version: 1, completed };
  } catch {
    return null;
  }
}

export function parseProgress(value: string | null): ProgressData {
  return tryParseProgress(value) ?? EMPTY_PROGRESS;
}

export function loadProgress(): ProgressData {
  return parseProgress(
    readStoredValue(STORAGE_KEYS.progress, [LEGACY_STORAGE_KEYS.progress]),
  );
}

/**
 * Keep only records belonging to the active catalog while reporting every
 * stale id to the import surface that can explain what was ignored.
 */
export function normalizeProgress(
  progress: ProgressData,
  knownPuzzleIds: Iterable<string>,
): NormalizedProgress {
  const knownIds = new Set(knownPuzzleIds);
  const completed: Record<string, PuzzleRecord> = {};
  const ignoredPuzzleIds: string[] = [];

  for (const [puzzleId, record] of Object.entries(progress.completed)) {
    if (knownIds.has(puzzleId)) {
      completed[puzzleId] = record;
    } else {
      ignoredPuzzleIds.push(puzzleId);
    }
  }

  return {
    progress: ignoredPuzzleIds.length > 0
      ? { version: 1, completed }
      : progress,
    ignoredPuzzleIds: Object.freeze(ignoredPuzzleIds),
  };
}

export function recordCompletion(
  progress: ProgressData,
  puzzleId: string,
  moves: number,
  pushes: number,
): ProgressData {
  const current = progress.completed[puzzleId];
  const candidate: PuzzleRecord = {
    moves,
    pushes,
    completedAt: new Date().toISOString(),
  };

  if (!isBetterRecord(candidate, current)) return progress;

  return {
    version: 1,
    completed: {
      ...progress.completed,
      [puzzleId]: candidate,
    },
  };
}

export function mergeProgress(
  current: ProgressData,
  imported: ProgressData,
): ProgressData {
  let changed = false;
  const completed: Record<string, PuzzleRecord> = {
    ...current.completed,
  };

  for (const [puzzleId, record] of Object.entries(imported.completed)) {
    if (!isBetterRecord(record, completed[puzzleId])) continue;
    completed[puzzleId] = record;
    changed = true;
  }

  return changed ? { version: 1, completed } : current;
}
