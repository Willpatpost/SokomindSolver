/**
 * Shared types and constants used by both the full puzzle catalog (`puzzles.ts`)
 * and the lightweight metadata catalog (`puzzle-metadata.ts`).
 *
 * Centralising these definitions removes the duplication that previously existed
 * between the two modules.
 */

import { DIFFICULTIES, type Difficulty } from "../core/model.ts";

/** Re-export so catalog consumers do not need a core import for difficulty. */
export type PuzzleDifficulty = Difficulty;

/** Canonical ordering of difficulty tiers, from easiest to hardest. */
export const DIFFICULTY_ORDER = DIFFICULTIES;

/** Sentinel collection name for puzzles that ship with the game. */
export const SOKOMIND_ORIGINALS = "Sokomind Originals";

/** Summary of a named puzzle collection within a difficulty tier. */
export interface CollectionInfo {
  readonly name: string;
  readonly count: number;
}
