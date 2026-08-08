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

export interface StreakInfo {
  readonly current: number;
  readonly longest: number;
  readonly activeTodayOrYesterday: boolean;
}

export interface AggregateStats {
  readonly totalSolved: number;
  readonly totalPuzzles: number;
  readonly completionPercentage: number;
  readonly ignoredRecords: number;
  readonly totalMoves: number;
  readonly totalPushes: number;
  readonly totalElapsedMs: number;
  readonly averagePushesPerPuzzle: number;
  readonly byDifficulty: readonly DifficultyTierStats[];
  readonly bestEfficiency: BestEfficiency | null;
  readonly streak: StreakInfo;
}

export interface StatsPuzzle {
  readonly id: string;
  readonly title: string;
  readonly difficulty: Difficulty;
  readonly boxes: number;
}

function toDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function computeStreak(progress: ProgressData): StreakInfo {
  const completionDays = new Set<string>();
  for (const record of Object.values(progress.completed)) {
    const date = new Date(record.completedAt);
    if (!Number.isFinite(date.getTime())) continue;
    completionDays.add(toDateKey(date));
  }

  if (completionDays.size === 0) {
    return { current: 0, longest: 0, activeTodayOrYesterday: false };
  }

  const sortedDays = [...completionDays].sort();
  const today = toDateKey(new Date());
  const yesterday = toDateKey(new Date(Date.now() - 86_400_000));

  let longest = 1;
  let currentRun = 1;
  for (let i = 1; i < sortedDays.length; i++) {
    const prev = new Date(sortedDays[i - 1] + "T00:00:00");
    const curr = new Date(sortedDays[i] + "T00:00:00");
    const diffDays = Math.round(
      (curr.getTime() - prev.getTime()) / 86_400_000,
    );
    if (diffDays === 1) {
      currentRun++;
    } else {
      currentRun = 1;
    }
    if (currentRun > longest) longest = currentRun;
  }

  const lastDay = sortedDays[sortedDays.length - 1];
  const activeTodayOrYesterday = lastDay === today || lastDay === yesterday;

  let current = 0;
  if (activeTodayOrYesterday) {
    current = 1;
    let checkDate = new Date(lastDay + "T00:00:00");
    for (;;) {
      checkDate = new Date(checkDate.getTime() - 86_400_000);
      if (completionDays.has(toDateKey(checkDate))) {
        current++;
      } else {
        break;
      }
    }
  }

  return { current, longest, activeTodayOrYesterday };
}

export function getDailyPuzzleId(
  puzzles: readonly StatsPuzzle[],
  date: Date = new Date(),
): string | undefined {
  if (puzzles.length === 0) return undefined;
  const daysSinceEpoch = Math.floor(date.getTime() / 86_400_000);
  const index = ((daysSinceEpoch * 2654435761) >>> 0) % puzzles.length;
  return puzzles[index].id;
}

export function computeDailyStreak(
  progress: ProgressData,
  puzzles: readonly StatsPuzzle[],
): number {
  if (puzzles.length === 0) return 0;
  const today = new Date();
  let streak = 0;

  for (let daysBack = 0; daysBack <= 365; daysBack++) {
    const date = new Date(today.getTime() - daysBack * 86_400_000);
    const dailyId = getDailyPuzzleId(puzzles, date);
    if (!dailyId || !progress.completed[dailyId]) break;
    streak++;
  }
  return streak;
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
  let totalElapsedMs = 0;
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
    if (record.elapsedMs) totalElapsedMs += record.elapsedMs;
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
    totalElapsedMs,
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
    streak: computeStreak(progress),
  };
}
