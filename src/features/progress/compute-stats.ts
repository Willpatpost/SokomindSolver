import { DIFFICULTIES, type Difficulty } from "../../core/model.ts";
import type { ProgressData } from "../../shared/progress.ts";

const DIFFICULTY_ORDER = DIFFICULTIES;

const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  tutorial: "Tutorial",
  beginner: "Beginner",
  intermediate: "Intermediate",
  advanced: "Advanced",
  expert: "Expert",
  master: "Master",
};

export interface DifficultyTierStats {
  readonly difficulty: Difficulty;
  readonly label: string;
  readonly solved: number;
  readonly total: number;
}

export interface BestEfficiency {
  readonly title: string;
  readonly pushes: number;
  readonly boxes: number;
}

export interface AggregateStats {
  readonly totalSolved: number;
  readonly totalPuzzles: number;
  readonly completionPercentage: number;
  readonly ignoredRecords: number;
  readonly totalMoves: number;
  readonly totalPushes: number;
  readonly averagePushesPerPuzzle: number;
  readonly byDifficulty: readonly DifficultyTierStats[];
  readonly bestEfficiency: BestEfficiency | null;
}

export interface StatsPuzzle {
  readonly id: string;
  readonly title: string;
  readonly difficulty: Difficulty;
  readonly boxes: number;
}

export function computeStats(
  progress: ProgressData,
  puzzles: readonly StatsPuzzle[],
): AggregateStats {
  const knownPuzzleIds = new Set(puzzles.map((puzzle) => puzzle.id));
  const tierCounts = new Map<Difficulty, { solved: number; total: number }>();
  for (const difficulty of DIFFICULTY_ORDER) {
    tierCounts.set(difficulty, { solved: 0, total: 0 });
  }

  let totalMoves = 0;
  let totalPushes = 0;
  let totalSolved = 0;
  let bestEfficiency: BestEfficiency | null = null;
  let bestRatio = Infinity;

  for (const puzzle of puzzles) {
    const tier = tierCounts.get(puzzle.difficulty);
    if (tier) tier.total += 1;

    const record = progress.completed[puzzle.id];
    if (!record) continue;

    totalSolved += 1;
    totalMoves += record.moves;
    totalPushes += record.pushes;
    if (tier) tier.solved += 1;

    if (puzzle.boxes > 0) {
      const ratio = record.pushes / puzzle.boxes;
      if (ratio < bestRatio) {
        bestRatio = ratio;
        bestEfficiency = {
          title: puzzle.title,
          pushes: record.pushes,
          boxes: puzzle.boxes,
        };
      }
    }
  }

  return {
    totalSolved,
    totalPuzzles: puzzles.length,
    completionPercentage: puzzles.length > 0
      ? Math.min(100, (totalSolved / puzzles.length) * 100)
      : 0,
    ignoredRecords: Object.keys(progress.completed).filter(
      (puzzleId) => !knownPuzzleIds.has(puzzleId),
    ).length,
    totalMoves,
    totalPushes,
    averagePushesPerPuzzle: totalSolved > 0 ? totalPushes / totalSolved : 0,
    byDifficulty: DIFFICULTY_ORDER.map((difficulty) => {
      const tier = tierCounts.get(difficulty)!;
      return {
        difficulty,
        label: DIFFICULTY_LABELS[difficulty],
        solved: tier.solved,
        total: tier.total,
      };
    }),
    bestEfficiency,
  };
}
