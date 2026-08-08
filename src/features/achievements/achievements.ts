import type { AggregateStats } from "@/src/features/progress/compute-stats";
import type { ProgressData } from "@/src/shared/progress";

export interface AchievementDef {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly icon: string;
  readonly check: (stats: AggregateStats, progress: ProgressData) => boolean;
}

export const ACHIEVEMENTS: readonly AchievementDef[] = [
  {
    id: "first-solve",
    title: "First Steps",
    description: "Solve your first puzzle",
    icon: "1",
    check: (s) => s.totalSolved >= 1,
  },
  {
    id: "ten-solved",
    title: "Getting Started",
    description: "Solve 10 puzzles",
    icon: "10",
    check: (s) => s.totalSolved >= 10,
  },
  {
    id: "fifty-solved",
    title: "Puzzle Enthusiast",
    description: "Solve 50 puzzles",
    icon: "50",
    check: (s) => s.totalSolved >= 50,
  },
  {
    id: "hundred-solved",
    title: "Century Club",
    description: "Solve 100 puzzles",
    icon: "C",
    check: (s) => s.totalSolved >= 100,
  },
  {
    id: "two-fifty-solved",
    title: "Dedicated Mover",
    description: "Solve 250 puzzles",
    icon: "D",
    check: (s) => s.totalSolved >= 250,
  },
  {
    id: "five-hundred-solved",
    title: "Half Way There",
    description: "Solve 500 puzzles",
    icon: "H",
    check: (s) => s.totalSolved >= 500,
  },
  {
    id: "all-solved",
    title: "Completionist",
    description: "Solve every puzzle in the catalog",
    icon: "A",
    check: (s) => s.totalSolved === s.totalPuzzles && s.totalPuzzles > 0,
  },
  {
    id: "streak-3",
    title: "Three-Peat",
    description: "Maintain a 3-day streak",
    icon: "3",
    check: (s) => s.streak.longest >= 3,
  },
  {
    id: "streak-7",
    title: "Full Week",
    description: "Maintain a 7-day streak",
    icon: "7",
    check: (s) => s.streak.longest >= 7,
  },
  {
    id: "streak-30",
    title: "Monthly Devotion",
    description: "Maintain a 30-day streak",
    icon: "30",
    check: (s) => s.streak.longest >= 30,
  },
  {
    id: "tutorial-complete",
    title: "Graduate",
    description: "Complete all tutorial puzzles",
    icon: "G",
    check: (s) => {
      const tier = s.byDifficulty.find((d) => d.difficulty === "tutorial");
      return tier !== undefined && tier.total > 0 && tier.solved === tier.total;
    },
  },
  {
    id: "beginner-complete",
    title: "Beyond Beginner",
    description: "Complete all beginner puzzles",
    icon: "B",
    check: (s) => {
      const tier = s.byDifficulty.find((d) => d.difficulty === "beginner");
      return tier !== undefined && tier.total > 0 && tier.solved === tier.total;
    },
  },
  {
    id: "intermediate-complete",
    title: "Intermediate Master",
    description: "Complete all intermediate puzzles",
    icon: "I",
    check: (s) => {
      const tier = s.byDifficulty.find((d) => d.difficulty === "intermediate");
      return tier !== undefined && tier.total > 0 && tier.solved === tier.total;
    },
  },
  {
    id: "efficient-mover",
    title: "Efficient Mover",
    description: "Achieve an average of under 5 pushes per puzzle",
    icon: "E",
    check: (s) => s.totalSolved >= 10 && s.averagePushesPerPuzzle < 5,
  },
  {
    id: "thousand-moves",
    title: "Well-Traveled",
    description: "Make 1,000 total moves",
    icon: "W",
    check: (s) => s.totalMoves >= 1000,
  },
  {
    id: "ten-thousand-moves",
    title: "Marathon Runner",
    description: "Make 10,000 total moves",
    icon: "M",
    check: (s) => s.totalMoves >= 10000,
  },
];

export function getUnlockedAchievements(
  stats: AggregateStats,
  progress: ProgressData,
): readonly AchievementDef[] {
  return ACHIEVEMENTS.filter((a) => a.check(stats, progress));
}
