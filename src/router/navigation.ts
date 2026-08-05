import type { PuzzleDifficulty } from "../catalog/puzzles";

export function homeHash(): string {
  return "#/";
}

export function puzzlesHash(): string {
  return "#/puzzles";
}

export function puzzleDifficultyHash(difficulty: PuzzleDifficulty): string {
  return `#/puzzles/${difficulty}`;
}

function withPageNumber(hash: string, pageNumber?: number): string {
  return pageNumber && Number.isSafeInteger(pageNumber) && pageNumber > 1
    ? `${hash}?page=${pageNumber}`
    : hash;
}

export function puzzleDifficultyPageHash(
  difficulty: PuzzleDifficulty,
  pageNumber?: number,
): string {
  return withPageNumber(puzzleDifficultyHash(difficulty), pageNumber);
}

export function puzzleCollectionHash(
  difficulty: PuzzleDifficulty,
  collection: string,
): string {
  return `#/puzzles/${difficulty}/${encodeURIComponent(collection)}`;
}

export function puzzleCollectionPageHash(
  difficulty: PuzzleDifficulty,
  collection: string,
  pageNumber?: number,
): string {
  return withPageNumber(
    puzzleCollectionHash(difficulty, collection),
    pageNumber,
  );
}

export function playHash(puzzleId: string, actionLog?: string): string {
  const base = `#/play/${encodeURIComponent(puzzleId)}`;
  if (!actionLog) return base;
  return `${base}?play=${encodeURIComponent(actionLog)}`;
}

export function editorHash(customData?: string): string {
  if (!customData) return "#/editor";
  return `#/editor?custom=${encodeURIComponent(customData)}`;
}

export function createShareUrl(
  location: { origin: string; pathname: string },
  puzzleId: string,
  actionLog?: string,
): string {
  return `${location.origin}${location.pathname}${playHash(puzzleId, actionLog)}`;
}
