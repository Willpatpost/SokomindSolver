import type { AggregateStats, StatsPuzzle } from "../progress/compute-stats.ts";
import type { ProgressData } from "../../shared/progress.ts";

export type AchievementCollectionId = "exploration" | "momentum" | "curriculum" | "craft";

export interface AchievementCollection {
  readonly id: AchievementCollectionId;
  readonly title: string;
  readonly description: string;
}

export interface AchievementProgress {
  readonly current: number;
  readonly target: number;
  readonly label: string;
  readonly complete: boolean;
}

export interface AchievementDef {
  readonly id: string;
  readonly collectionId: AchievementCollectionId;
  readonly title: string;
  readonly description: string;
  readonly icon: string;
  readonly progress: (stats: AggregateStats, progress: ProgressData) => AchievementProgress;
  readonly check: (stats: AggregateStats, progress: ProgressData) => boolean;
}

export interface AchievementMilestone {
  readonly achievementId: string;
  readonly title: string;
  readonly description: string;
  readonly collectionTitle: string;
  readonly earnedAt: string;
}

export const ACHIEVEMENT_COLLECTIONS: readonly AchievementCollection[] = Object.freeze([
  Object.freeze({ id: "exploration", title: "Room by room", description: "Explore more of the open catalog at your own pace." }),
  Object.freeze({ id: "momentum", title: "Steady practice", description: "Build a routine across consecutive local calendar days." }),
  Object.freeze({ id: "curriculum", title: "Catalog mastery", description: "Clear complete difficulty tiers from tutorial through master." }),
  Object.freeze({ id: "craft", title: "Route craft", description: "Develop efficient routes and accumulate deliberate movement." }),
]);

function boundedProgress(current: number, target: number, label: string, complete = current >= target): AchievementProgress {
  return Object.freeze({ current: Math.max(0, Math.min(current, target)), target, label, complete });
}

function countAchievement(id: string, title: string, target: number, icon: string): AchievementDef {
  return {
    id,
    collectionId: "exploration",
    title,
    description: `Solve ${target} ${target === 1 ? "puzzle" : "puzzles"}`,
    icon,
    progress: (stats) => boundedProgress(stats.totalSolved, target, `${Math.min(stats.totalSolved, target)} of ${target} puzzles`),
    check: (stats) => stats.totalSolved >= target,
  };
}

function streakAchievement(id: string, title: string, target: number, icon: string): AchievementDef {
  return {
    id,
    collectionId: "momentum",
    title,
    description: `Maintain a ${target}-day streak`,
    icon,
    progress: (stats) => boundedProgress(stats.streak.longest, target, `${Math.min(stats.streak.longest, target)} of ${target} consecutive days`),
    check: (stats) => stats.streak.longest >= target,
  };
}

function tierAchievement(id: string, title: string, difficulty: string, icon: string): AchievementDef {
  return {
    id,
    collectionId: "curriculum",
    title,
    description: `Complete all ${difficulty} puzzles`,
    icon,
    progress: (stats) => {
      const tier = stats.byDifficulty.find((entry) => entry.difficulty === difficulty);
      const solved = tier?.solved ?? 0;
      const total = tier?.total ?? 0;
      return boundedProgress(solved, Math.max(total, 1), total > 0 ? `${solved} of ${total} ${difficulty} puzzles` : `No ${difficulty} puzzles available`, total > 0 && solved === total);
    },
    check: (stats) => {
      const tier = stats.byDifficulty.find((entry) => entry.difficulty === difficulty);
      return tier !== undefined && tier.total > 0 && tier.solved === tier.total;
    },
  };
}

function moveAchievement(id: string, title: string, target: number, icon: string): AchievementDef {
  return {
    id,
    collectionId: "craft",
    title,
    description: `Record ${target.toLocaleString("en-US")} total moves in personal bests`,
    icon,
    progress: (stats) => boundedProgress(stats.totalMoves, target, `${Math.min(stats.totalMoves, target).toLocaleString("en-US")} of ${target.toLocaleString("en-US")} saved moves`),
    check: (stats) => stats.totalMoves >= target,
  };
}

export const ACHIEVEMENTS: readonly AchievementDef[] = Object.freeze([
  countAchievement("first-solve", "First Steps", 1, "1"),
  countAchievement("ten-solved", "Getting Started", 10, "10"),
  countAchievement("fifty-solved", "Puzzle Enthusiast", 50, "50"),
  countAchievement("hundred-solved", "Century Club", 100, "C"),
  {
    id: "all-solved", collectionId: "exploration", title: "Completionist", description: "Solve every puzzle in the catalog", icon: "A",
    progress: (stats) => boundedProgress(stats.totalSolved, Math.max(stats.totalPuzzles, 1), `${stats.totalSolved} of ${stats.totalPuzzles} catalog puzzles`, stats.totalPuzzles > 0 && stats.totalSolved === stats.totalPuzzles),
    check: (stats) => stats.totalPuzzles > 0 && stats.totalSolved === stats.totalPuzzles,
  },
  streakAchievement("streak-3", "Three-Peat", 3, "3"),
  streakAchievement("streak-7", "Full Week", 7, "7"),
  streakAchievement("streak-30", "Monthly Devotion", 30, "30"),
  tierAchievement("tutorial-complete", "Graduate", "tutorial", "T"),
  tierAchievement("beginner-complete", "Beyond Beginner", "beginner", "B"),
  tierAchievement("intermediate-complete", "Intermediate Master", "intermediate", "I"),
  tierAchievement("advanced-complete", "Advanced Studies", "advanced", "A"),
  tierAchievement("expert-complete", "Expert Eye", "expert", "E"),
  tierAchievement("master-complete", "Master of Rooms", "master", "M"),
  {
    id: "efficient-mover", collectionId: "craft", title: "Efficient Mover", description: "Solve at least 10 puzzles while averaging under 5 pushes", icon: "E",
    progress: (stats) => {
      const enoughSolves = stats.totalSolved >= 10;
      const efficient = stats.averagePushesPerPuzzle < 5;
      const current = enoughSolves && efficient ? 10 : Math.min(stats.totalSolved, efficient ? 10 : 9);
      const average = stats.totalSolved > 0 ? stats.averagePushesPerPuzzle.toFixed(1) : "—";
      return boundedProgress(current, 10, `${Math.min(stats.totalSolved, 10)} of 10 puzzles · ${average} pushes average (under 5 needed)`, enoughSolves && efficient);
    },
    check: (stats) => stats.totalSolved >= 10 && stats.averagePushesPerPuzzle < 5,
  },
  moveAchievement("thousand-moves", "Well-Traveled", 1_000, "1K"),
  moveAchievement("ten-thousand-moves", "Marathon Runner", 10_000, "10K"),
]);

export function getAchievementProgress(achievement: AchievementDef, stats: AggregateStats, progress: ProgressData): AchievementProgress {
  return achievement.progress(stats, progress);
}

export function getUnlockedAchievements(stats: AggregateStats, progress: ProgressData): readonly AchievementDef[] {
  return ACHIEVEMENTS.filter((achievement) => achievement.check(stats, progress));
}

export function getNewlyUnlockedAchievements(previousStats: AggregateStats, previousProgress: ProgressData, nextStats: AggregateStats, nextProgress: ProgressData): readonly AchievementDef[] {
  const previousIds = new Set(getUnlockedAchievements(previousStats, previousProgress).map(({ id }) => id));
  return getUnlockedAchievements(nextStats, nextProgress).filter(({ id }) => !previousIds.has(id));
}

function orderedKnownCompletions(progress: ProgressData, puzzles: readonly StatsPuzzle[]): readonly { readonly puzzle: StatsPuzzle; readonly completedAt: string }[] {
  const metadataById = new Map(puzzles.map((puzzle) => [puzzle.id, puzzle] as const));
  return Object.entries(progress.completed)
    .flatMap(([puzzleId, record]) => {
      const puzzle = metadataById.get(puzzleId);
      return puzzle ? [{ puzzle, completedAt: record.completedAt }] : [];
    })
    .sort((left, right) => left.completedAt.localeCompare(right.completedAt));
}

function completionMilestoneDate(achievement: AchievementDef, progress: ProgressData, puzzles: readonly StatsPuzzle[]): string | null {
  const completions = orderedKnownCompletions(progress, puzzles);
  const countTargets: Readonly<Record<string, number>> = { "first-solve": 1, "ten-solved": 10, "fifty-solved": 50, "hundred-solved": 100 };
  const countTarget = countTargets[achievement.id];
  if (countTarget !== undefined) return completions[countTarget - 1]?.completedAt ?? null;
  if (achievement.id === "all-solved") return completions.length === puzzles.length ? completions.at(-1)?.completedAt ?? null : null;
  if (achievement.collectionId !== "curriculum") return null;
  const difficulty = achievement.id.replace("-complete", "");
  const tierPuzzles = puzzles.filter((puzzle) => puzzle.difficulty === difficulty);
  if (tierPuzzles.length === 0) return null;
  const tierIds = new Set(tierPuzzles.map(({ id }) => id));
  const tierCompletions = completions.filter(({ puzzle }) => tierIds.has(puzzle.id));
  return tierCompletions.length === tierPuzzles.length ? tierCompletions.at(-1)?.completedAt ?? null : null;
}

function streakMilestoneDate(achievementId: string, progress: ProgressData): string | null {
  const target = achievementId === "streak-3" ? 3 : achievementId === "streak-7" ? 7 : achievementId === "streak-30" ? 30 : 0;
  if (target === 0) return null;
  const days = Object.entries(progress.activity).filter(([, puzzleIds]) => puzzleIds.length > 0).map(([dateKey]) => dateKey).sort();
  let run = 0;
  let previousOrdinal: number | null = null;
  for (const dateKey of days) {
    const [year, month, day] = dateKey.split("-").map(Number);
    const ordinal = Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
    run = previousOrdinal !== null && ordinal - previousOrdinal === 1 ? run + 1 : 1;
    previousOrdinal = ordinal;
    if (run >= target) return `${dateKey}T12:00:00.000Z`;
  }
  return null;
}

export function getRecentAchievementMilestones(stats: AggregateStats, progress: ProgressData, puzzles: readonly StatsPuzzle[], requestedLimit = 6): readonly AchievementMilestone[] {
  const collectionById = new Map(ACHIEVEMENT_COLLECTIONS.map((collection) => [collection.id, collection] as const));
  const limit = Math.min(12, Math.max(0, Math.floor(requestedLimit)));
  return getUnlockedAchievements(stats, progress)
    .flatMap((achievement) => {
      const earnedAt = completionMilestoneDate(achievement, progress, puzzles) ?? streakMilestoneDate(achievement.id, progress);
      return earnedAt ? [Object.freeze({ achievementId: achievement.id, title: achievement.title, description: achievement.description, collectionTitle: collectionById.get(achievement.collectionId)?.title ?? "Achievement", earnedAt })] : [];
    })
    .sort((left, right) => right.earnedAt.localeCompare(left.earnedAt))
    .slice(0, limit);
}
