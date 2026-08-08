import type { PuzzleDifficulty } from "../catalog/puzzles";

export type { PuzzleDifficulty };

export type Route =
  | { readonly page: "home" }
  | { readonly page: "puzzles" }
  | {
      readonly page: "puzzles-difficulty";
      readonly difficulty: PuzzleDifficulty;
      readonly pageNumber?: number;
    }
  | {
      readonly page: "puzzles-collection";
      readonly difficulty: PuzzleDifficulty;
      readonly collection: string;
      readonly pageNumber?: number;
    }
  | { readonly page: "play"; readonly puzzleId: string; readonly actionLog?: string }
  | { readonly page: "editor"; readonly customData?: string }
  | { readonly page: "stats" };

export type PageName = Route["page"];
