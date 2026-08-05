import type { PuzzleDifficulty } from "@/src/catalog/puzzle-metadata";

export const PUZZLES_PER_PAGE = 50;

export const DIFFICULTY_LABELS: Record<PuzzleDifficulty, string> = {
  tutorial: "Tutorial",
  beginner: "Beginner",
  intermediate: "Intermediate",
  advanced: "Advanced",
  expert: "Expert",
  master: "Master",
};

export const DIFFICULTY_COLORS: Record<PuzzleDifficulty, string> = {
  tutorial: "var(--sage-500)",
  beginner: "var(--sage-600)",
  intermediate: "var(--blue-500)",
  advanced: "var(--amber-500)",
  expert: "var(--coral-500)",
  master: "var(--ink-700)",
};
