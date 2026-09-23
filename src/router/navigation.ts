import type { PuzzleDifficulty } from "../catalog/puzzles";
import type { Route } from "./routes";

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

export function statsHash(): string {
  return "#/stats";
}

export function solverLabHash(
  puzzleId = "ultra-tiny",
  actionLog?: string,
): string {
  const base = `#/solver-lab/${encodeURIComponent(puzzleId)}`;
  return actionLog
    ? `${base}?play=${encodeURIComponent(actionLog)}`
    : base;
}

/**
 * The page one level up from `route`, used by back() when there is no earlier
 * app page in the tab's history to return to.
 */
export function parentHash(route: Route, puzzlesReturnHash: string): string {
  switch (route.page) {
    case "play":
      return puzzlesReturnHash;
    case "puzzles-collection":
      return puzzleDifficultyHash(route.difficulty);
    case "puzzles-difficulty":
      return puzzlesHash();
    default:
      return homeHash();
  }
}

export function createShareUrl(
  location: { origin: string; pathname: string },
  puzzleId: string,
  actionLog?: string,
): string {
  return `${location.origin}${location.pathname}${playHash(puzzleId, actionLog)}`;
}
