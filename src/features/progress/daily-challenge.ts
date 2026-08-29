import type { PuzzleMetadata } from "../../catalog/puzzle-metadata.ts";
import type { ProgressData } from "../../shared/progress.ts";
import { toLocalDateKey } from "../../shared/progress.ts";
import { computeDailyStreak, getDailyPuzzleId } from "./compute-stats.ts";

export type DailyHistoryOutcome = "completed" | "missed" | "today";

export interface DailyHistoryDay {
  readonly dateKey: string;
  readonly shortLabel: string;
  readonly puzzleId?: string;
  readonly puzzleTitle?: string;
  readonly outcome: DailyHistoryOutcome;
}

export interface DailyChallengeView {
  readonly state: "ready" | "completed" | "recovery" | "unavailable";
  readonly dateLabel: string;
  readonly puzzle?: PuzzleMetadata;
  readonly streak: number;
  readonly framing: string;
  readonly history: readonly DailyHistoryDay[];
}

function shiftLocalDays(date: Date, amount: number): Date {
  const shifted = new Date(date);
  shifted.setHours(12, 0, 0, 0);
  shifted.setDate(shifted.getDate() + amount);
  return shifted;
}

function shortDayLabel(date: Date, isToday: boolean): string {
  return isToday
    ? "Today"
    : new Intl.DateTimeFormat("en", { weekday: "short" }).format(date);
}

export function buildDailyChallengeView(
  puzzles: readonly PuzzleMetadata[],
  progress: ProgressData,
  now: Date = new Date(),
  requestedHistoryDays = 7,
): DailyChallengeView {
  const historyDays = Math.min(14, Math.max(1, Math.floor(requestedHistoryDays)));
  const metadataById = new Map(puzzles.map((puzzle) => [puzzle.id, puzzle] as const));
  const dateLabel = new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
  }).format(now);

  if (puzzles.length === 0) {
    return Object.freeze({
      state: "unavailable",
      dateLabel,
      streak: 0,
      framing: "The catalog is still loading. Browse puzzles now and the daily room will return when it is ready.",
      history: Object.freeze([]),
    });
  }

  const history = Array.from({ length: historyDays }, (_, index) => {
    const daysBack = historyDays - index - 1;
    const date = shiftLocalDays(now, -daysBack);
    const dateKey = toLocalDateKey(date);
    const puzzleId = getDailyPuzzleId(puzzles, date);
    const puzzle = puzzleId ? metadataById.get(puzzleId) : undefined;
    const completed = puzzleId !== undefined && progress.daily[dateKey]?.puzzleId === puzzleId;
    return Object.freeze({
      dateKey,
      shortLabel: shortDayLabel(date, daysBack === 0),
      puzzleId,
      puzzleTitle: puzzle?.title,
      outcome: completed ? "completed" : daysBack === 0 ? "today" : "missed",
    } satisfies DailyHistoryDay);
  });

  const today = history[history.length - 1];
  const puzzle = today.puzzleId ? metadataById.get(today.puzzleId) : undefined;
  if (!puzzle) {
    return Object.freeze({
      state: "unavailable",
      dateLabel,
      streak: 0,
      framing: "Today’s room could not be found. The open catalog is still available while the daily challenge recovers.",
      history: Object.freeze(history),
    });
  }

  const streak = computeDailyStreak(progress, puzzles, now);
  const completedToday = today.outcome === "completed";
  const priorCompletions = history.slice(0, -1).filter(({ outcome }) => outcome === "completed");
  const missedYesterday = history.length > 1 && history[history.length - 2].outcome === "missed";
  const state = completedToday
    ? "completed"
    : priorCompletions.length > 0 && missedYesterday
      ? "recovery"
      : "ready";
  const framing = completedToday
    ? `Today is recorded. Replay ${puzzle.title} to refine your route, or return tomorrow for a new room.`
    : state === "recovery"
      ? `A missed day does not close the path. ${puzzle.title} starts a fresh run today.`
      : `One shared room for ${dateLabel}. Solve it before local midnight to add today to your history.`;

  return Object.freeze({
    state,
    dateLabel,
    puzzle,
    streak,
    framing,
    history: Object.freeze(history),
  });
}
