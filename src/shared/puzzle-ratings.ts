import { readStoredValue, writeStoredValue, STORAGE_KEYS } from "./storage";

export type DifficultyRating = "easy" | "right" | "hard";

export interface RatingsData {
  readonly [puzzleId: string]: DifficultyRating;
}

export function loadRatings(): RatingsData {
  const raw = readStoredValue(STORAGE_KEYS.ratings);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const result: Record<string, DifficultyRating> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value === "easy" || value === "right" || value === "hard") {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function saveRating(
  puzzleId: string,
  rating: DifficultyRating,
): RatingsData {
  const current = loadRatings();
  const next = { ...current, [puzzleId]: rating };
  writeStoredValue(STORAGE_KEYS.ratings, JSON.stringify(next));
  return next;
}
