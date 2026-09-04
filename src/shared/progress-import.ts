import {
  MAX_ACTIVITY_DAYS,
  MAX_ACTIVITY_ENTRIES,
  normalizeProgress,
  tryParseProgress,
  type ProgressData,
} from "./progress.ts";

export const MAX_PROGRESS_IMPORT_BYTES = 1_000_000;
const MAX_COMPLETION_RECORDS = 10_000;
export const MAX_PROGRESS_IMPORT_RECORDS =
  MAX_ACTIVITY_ENTRIES + MAX_ACTIVITY_DAYS + MAX_COMPLETION_RECORDS;

export type ProgressImportParseResult =
  | {
      readonly ok: true;
      readonly progress: ProgressData;
      readonly invalid: number;
      readonly rejected: number;
    }
  | {
      readonly ok: false;
      readonly message: string;
    };

function objectRecordCount(value: unknown): number | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).length
    : null;
}

function activityRecordCount(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  return Object.values(value as Record<string, unknown>).reduce<number>(
    (count, entries) => count + (Array.isArray(entries) ? entries.length : 1),
    0,
  );
}

export function parseProgressImport(
  text: string,
  knownPuzzleIds: Iterable<string>,
): ProgressImportParseResult {
  if (new TextEncoder().encode(text).byteLength > MAX_PROGRESS_IMPORT_BYTES) {
    return { ok: false, message: "That file is too large to be a Sokomind progress file." };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, message: "That file does not contain valid Sokomind progress." };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "That file does not contain valid Sokomind progress." };
  }
  const root = raw as Record<string, unknown>;
  const rawCompletedCount = objectRecordCount(root.completed);
  const rawDailyCount = objectRecordCount(root.daily) ?? 0;
  const hasActivity = root.activity !== undefined;
  const rawActivityCount = activityRecordCount(root.activity);
  if (rawCompletedCount === null) {
    return { ok: false, message: "That file does not contain valid Sokomind progress." };
  }
  if (
    rawCompletedCount + rawDailyCount + rawActivityCount >
      MAX_PROGRESS_IMPORT_RECORDS
  ) {
    return { ok: false, message: "That progress file contains too many records." };
  }

  const parsed = tryParseProgress(text);
  if (!parsed || (Object.keys(parsed.completed).length === 0 &&
    Object.keys(parsed.daily).length === 0 &&
    Object.keys(parsed.activity).length === 0)) {
    return { ok: false, message: "That file contains no valid progress records." };
  }

  const normalized = normalizeProgress(parsed, knownPuzzleIds);
  const validParsedCount = Object.keys(parsed.completed).length;
  const validDailyCount = Object.keys(parsed.daily).length;
  const validActivityCount = hasActivity
    ? Object.values(parsed.activity).reduce((count, ids) => count + ids.length, 0)
    : 0;
  const normalizedRecordCount =
    Object.keys(normalized.progress.completed).length +
    Object.keys(normalized.progress.daily).length +
    (hasActivity
      ? Object.values(normalized.progress.activity).reduce(
          (count, ids) => count + ids.length,
          0,
        )
      : 0);
  return {
    ok: true,
    progress: normalized.progress,
    invalid: Math.max(
      0,
      rawCompletedCount + rawDailyCount + rawActivityCount -
        validParsedCount - validDailyCount - validActivityCount,
    ),
    rejected: validParsedCount + validDailyCount + validActivityCount -
      normalizedRecordCount,
  };
}

export async function readProgressImportFile(
  file: Pick<File, "size" | "text">,
  knownPuzzleIds: Iterable<string>,
): Promise<ProgressImportParseResult> {
  if (file.size > MAX_PROGRESS_IMPORT_BYTES) {
    return { ok: false, message: "That file is too large to be a Sokomind progress file." };
  }
  try {
    return parseProgressImport(await file.text(), knownPuzzleIds);
  } catch {
    return { ok: false, message: "Could not read file." };
  }
}
