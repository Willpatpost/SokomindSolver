import { STORAGE_KEYS, readStoredValue, writeStoredValue } from "./storage";

export type FavoriteSet = ReadonlySet<string>;

export function loadFavorites(): FavoriteSet {
  const raw = readStoredValue(STORAGE_KEYS.favorites);
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    return new Set();
  }
}

export function saveFavorite(puzzleId: string): FavoriteSet {
  const current = loadFavorites();
  const next = new Set(current);
  next.add(puzzleId);
  writeStoredValue(STORAGE_KEYS.favorites, JSON.stringify([...next]));
  return next;
}

export function removeFavorite(puzzleId: string): FavoriteSet {
  const current = loadFavorites();
  const next = new Set(current);
  next.delete(puzzleId);
  writeStoredValue(STORAGE_KEYS.favorites, JSON.stringify([...next]));
  return next;
}

export function toggleFavorite(puzzleId: string): {
  favorites: FavoriteSet;
  isFavorite: boolean;
} {
  const current = loadFavorites();
  if (current.has(puzzleId)) {
    const next = removeFavorite(puzzleId);
    return { favorites: next, isFavorite: false };
  }
  const next = saveFavorite(puzzleId);
  return { favorites: next, isFavorite: true };
}
