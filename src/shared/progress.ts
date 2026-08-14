import {
  LEGACY_STORAGE_KEYS,
  STORAGE_KEYS,
  readStoredValue,
} from "./storage.ts";

export interface PuzzleRecord {
  readonly moves: number;
  readonly pushes: number;
  readonly completedAt: string;
  readonly elapsedMs?: number;
}

export interface ProgressData {
  readonly version: 2;
  readonly completed: Readonly<Record<string, PuzzleRecord>>;
  /** Daily participation is intentionally separate from lifetime bests. */
  readonly daily: Readonly<Record<string, DailyCompletion>>;
  /** Distinct puzzles completed on each local date, retained for one year. */
  readonly activity: CompletionActivity;
}

export type CompletionActivity = Readonly<Record<string, readonly string[]>>;

export interface DailyCompletion {
  readonly puzzleId: string;
  readonly completedAt: string;
}

export interface NormalizedProgress {
  readonly progress: ProgressData;
  readonly ignoredPuzzleIds: readonly string[];
}

export interface ProgressMergeSummary {
  readonly added: number;
  readonly improved: number;
  readonly unchanged: number;
  readonly rejected: number;
}

export const EMPTY_PROGRESS: ProgressData = Object.freeze({
  version: 2,
  completed: Object.freeze({}),
  daily: Object.freeze({}),
  activity: Object.freeze({}),
});

const LOCAL_DATE_KEY_FORMAT = /^\d{4}-\d{2}-\d{2}$/u;
export const MAX_ACTIVITY_DAYS = 366;
export const MAX_ACTIVITY_ENTRIES = 10_000;

export function toLocalDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function isLocalDateKey(value: string): boolean {
  if (!LOCAL_DATE_KEY_FORMAT.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isValidPuzzleId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 100;
}

function normalizedActivity(value: unknown): CompletionActivity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const result: Record<string, readonly string[]> = {};
  let retainedEntries = 0;
  const dates = Object.entries(value as Record<string, unknown>)
    .filter(([dateKey, entries]) => isLocalDateKey(dateKey) && Array.isArray(entries))
    .sort(([first], [second]) => second.localeCompare(first))
    .slice(0, MAX_ACTIVITY_DAYS);

  for (const [dateKey, entries] of dates) {
    const puzzleIds = [...new Set(
      (entries as unknown[]).filter(isValidPuzzleId),
    )].sort();
    const remaining = MAX_ACTIVITY_ENTRIES - retainedEntries;
    if (remaining <= 0) break;
    const retained = puzzleIds.slice(0, remaining);
    if (retained.length === 0) continue;
    result[dateKey] = Object.freeze(retained);
    retainedEntries += retained.length;
  }
  return result;
}

function deriveActivityFromCompleted(
  completed: Readonly<Record<string, PuzzleRecord>>,
): CompletionActivity {
  const activity: Record<string, string[]> = {};
  for (const [puzzleId, record] of Object.entries(completed)) {
    const dateKey = toLocalDateKey(new Date(record.completedAt));
    (activity[dateKey] ??= []).push(puzzleId);
  }
  return normalizedActivity(activity);
}

export function sameCompletionActivity(
  first: CompletionActivity,
  second: CompletionActivity,
): boolean {
  const firstDates = Object.keys(first);
  const secondDates = Object.keys(second);
  if (firstDates.length !== secondDates.length) return false;
  return firstDates.every((dateKey) => {
    const firstIds = first[dateKey] ?? [];
    const secondIds = second[dateKey];
    return secondIds !== undefined &&
      firstIds.length === secondIds.length &&
      firstIds.every((puzzleId, index) => puzzleId === secondIds[index]);
  });
}

export function mergeCompletionActivity(
  first: CompletionActivity,
  second: CompletionActivity,
): CompletionActivity {
  const combined: Record<string, readonly string[]> = { ...first };
  for (const [dateKey, puzzleIds] of Object.entries(second)) {
    combined[dateKey] = [...(combined[dateKey] ?? []), ...puzzleIds];
  }
  const merged = normalizedActivity(combined);
  return sameCompletionActivity(first, merged) ? first : merged;
}

function recordCompletionActivity(
  activity: CompletionActivity,
  puzzleId: string,
  completedAt: Date,
): CompletionActivity {
  const dateKey = toLocalDateKey(completedAt);
  if (activity[dateKey]?.includes(puzzleId)) return activity;
  return normalizedActivity({
    ...activity,
    [dateKey]: [...(activity[dateKey] ?? []), puzzleId],
  });
}

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
    new Date(completedAt).toISOString() === record.completedAt &&
    (record.elapsedMs === undefined ||
      (typeof record.elapsedMs === "number" && Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0))
  );
}

function isDailyCompletion(value: unknown): value is DailyCompletion {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<DailyCompletion>;
  const completedAt = typeof record.completedAt === "string"
    ? Date.parse(record.completedAt)
    : Number.NaN;
  return (
    typeof record.puzzleId === "string" &&
    record.puzzleId.length > 0 &&
    record.puzzleId.length <= 100 &&
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
      daily?: unknown;
      activity?: unknown;
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
    const daily = parsed.version === 2 && parsed.daily && typeof parsed.daily === "object"
      ? Object.fromEntries(
          Object.entries(parsed.daily).filter(
            (entry): entry is [string, DailyCompletion] =>
              isLocalDateKey(entry[0]) && isDailyCompletion(entry[1]),
          ),
        )
      : {};
    const activity = parsed.version === 2 && parsed.activity !== undefined
      ? normalizedActivity(parsed.activity)
      : deriveActivityFromCompleted(completed);
    return { version: 2, completed, daily, activity };
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

  const daily = Object.fromEntries(
    Object.entries(progress.daily).filter(([, record]) => {
      if (knownIds.has(record.puzzleId)) return true;
      if (!ignoredPuzzleIds.includes(record.puzzleId)) {
        ignoredPuzzleIds.push(record.puzzleId);
      }
      return false;
    }),
  );
  const activity = Object.fromEntries(
    Object.entries(progress.activity).flatMap(([dateKey, puzzleIds]) => {
      const retained = puzzleIds.filter((puzzleId) => {
        if (knownIds.has(puzzleId)) return true;
        if (!ignoredPuzzleIds.includes(puzzleId)) ignoredPuzzleIds.push(puzzleId);
        return false;
      });
      return retained.length > 0 ? [[dateKey, retained] as const] : [];
    }),
  );
  const changed = Object.keys(completed).length !== Object.keys(progress.completed).length ||
    Object.keys(daily).length !== Object.keys(progress.daily).length ||
    !sameCompletionActivity(activity, progress.activity);

  return {
    progress: changed
      ? {
          version: 2,
          completed,
          daily,
          activity,
        }
      : progress,
    ignoredPuzzleIds: Object.freeze(ignoredPuzzleIds),
  };
}

export function recordCompletion(
  progress: ProgressData,
  puzzleId: string,
  moves: number,
  pushes: number,
  elapsedMs?: number,
  completedAt: Date = new Date(),
): ProgressData {
  const current = progress.completed[puzzleId];
  const activity = recordCompletionActivity(
    progress.activity,
    puzzleId,
    completedAt,
  );
  const candidate: PuzzleRecord = {
    moves,
    pushes,
    completedAt: completedAt.toISOString(),
    ...(elapsedMs !== undefined && elapsedMs > 0 ? { elapsedMs: Math.round(elapsedMs) } : {}),
  };

  if (!isBetterRecord(candidate, current)) {
    return activity === progress.activity ? progress : { ...progress, activity };
  }

  return {
    version: 2,
    completed: {
      ...progress.completed,
      [puzzleId]: candidate,
    },
    daily: progress.daily,
    activity,
  };
}

/**
 * Records participation for an explicitly selected local calendar day. The
 * caller is responsible for confirming that `puzzleId` was assigned on that
 * date; keeping that catalog policy outside shared persistence avoids a layer
 * dependency. A wall-clock solve is accepted only for its own local date.
 */
export function recordDailyCompletion(
  progress: ProgressData,
  puzzleId: string,
  completedAt: Date = new Date(),
  dateKey = toLocalDateKey(completedAt),
): ProgressData {
  if (dateKey !== toLocalDateKey(completedAt) || !isLocalDateKey(dateKey)) {
    return progress;
  }
  const existing = progress.daily[dateKey];
  if (existing?.puzzleId === puzzleId) return progress;

  return {
    version: 2,
    completed: progress.completed,
    daily: {
      ...progress.daily,
      [dateKey]: {
        puzzleId,
        completedAt: completedAt.toISOString(),
      },
    },
    activity: progress.activity,
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
  const daily: Record<string, DailyCompletion> = { ...current.daily };
  const activity = mergeCompletionActivity(current.activity, imported.activity);

  for (const [puzzleId, record] of Object.entries(imported.completed)) {
    if (!isBetterRecord(record, completed[puzzleId])) continue;
    completed[puzzleId] = record;
    changed = true;
  }

  for (const [dateKey, record] of Object.entries(imported.daily)) {
    if (daily[dateKey]) continue;
    daily[dateKey] = record;
    changed = true;
  }

  if (activity !== current.activity) changed = true;
  return changed ? { version: 2, completed, daily, activity } : current;
}

export function summarizeProgressMerge(
  current: ProgressData,
  imported: ProgressData,
): ProgressMergeSummary {
  let added = 0;
  let improved = 0;
  let unchanged = 0;
  let rejected = 0;
  for (const [puzzleId, candidate] of Object.entries(imported.completed)) {
    const existing = current.completed[puzzleId];
    if (!existing) {
      added++;
    } else if (candidate.moves < existing.moves) {
      improved++;
    } else if (
      candidate.moves === existing.moves &&
      candidate.pushes === existing.pushes &&
      candidate.completedAt === existing.completedAt &&
      candidate.elapsedMs === existing.elapsedMs
    ) {
      unchanged++;
    } else {
      rejected++;
    }
  }
  for (const [dateKey, candidate] of Object.entries(imported.daily)) {
    const existing = current.daily[dateKey];
    if (!existing) {
      added++;
    } else if (
      existing.puzzleId === candidate.puzzleId &&
      existing.completedAt === candidate.completedAt
    ) {
      unchanged++;
    } else {
      rejected++;
    }
  }
  return Object.freeze({ added, improved, unchanged, rejected });
}
