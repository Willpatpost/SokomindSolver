import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PuzzleMetadata } from "../../src/catalog/puzzle-metadata.ts";
import { buildDailyChallengeView } from "../../src/features/progress/daily-challenge.ts";
import { getDailyPuzzleId } from "../../src/features/progress/compute-stats.ts";
import { toLocalDateKey, type ProgressData } from "../../src/shared/progress.ts";

const PUZZLES: readonly PuzzleMetadata[] = ["a", "b", "c"].map((id) => ({
  id,
  title: `Room ${id.toUpperCase()}`,
  difficulty: "beginner",
  boxes: 1,
  width: 4,
  height: 4,
  collection: "Test",
  shard: "puzzle-shard-000",
}));
const EMPTY: ProgressData = { version: 2, completed: {}, daily: {}, activity: {} };

function shiftLocalDays(date: Date, amount: number): Date {
  const shifted = new Date(date);
  shifted.setDate(shifted.getDate() + amount);
  return shifted;
}

function withDailyCompletions(now: Date, daysBack: readonly number[]): ProgressData {
  const daily: Record<string, { puzzleId: string; completedAt: string }> = {};
  for (const offset of daysBack) {
    const date = shiftLocalDays(now, -offset);
    const puzzleId = getDailyPuzzleId(PUZZLES, date);
    if (puzzleId) {
      daily[toLocalDateKey(date)] = { puzzleId, completedAt: date.toISOString() };
    }
  }
  return { ...EMPTY, daily };
}

describe("daily challenge view", () => {
  const now = new Date(2026, 7, 28, 12, 0, 0);

  it("builds a deterministic seven-day calendar ending today", () => {
    const first = buildDailyChallengeView(PUZZLES, EMPTY, now);
    const second = buildDailyChallengeView(PUZZLES, EMPTY, new Date(now));

    assert.equal(first.history.length, 7);
    assert.equal(first.history.at(-1)?.dateKey, "2026-08-28");
    assert.equal(first.history.at(-1)?.shortLabel, "Today");
    assert.equal(first.puzzle?.id, second.puzzle?.id);
    assert.equal(first.state, "ready");
  });

  it("frames a completed day and exposes its active streak", () => {
    const view = buildDailyChallengeView(PUZZLES, withDailyCompletions(now, [0, 1, 2]), now);

    assert.equal(view.state, "completed");
    assert.equal(view.streak, 3);
    assert.match(view.framing, /recorded/i);
    assert.deepEqual(view.history.slice(-3).map(({ outcome }) => outcome), [
      "completed",
      "completed",
      "completed",
    ]);
  });

  it("offers a fresh-start recovery after a missed yesterday", () => {
    const view = buildDailyChallengeView(PUZZLES, withDailyCompletions(now, [2]), now);

    assert.equal(view.state, "recovery");
    assert.equal(view.streak, 0);
    assert.match(view.framing, /missed day does not close the path/i);
  });

  it("returns an explicit recovery surface when no catalog is available", () => {
    const view = buildDailyChallengeView([], EMPTY, now);

    assert.equal(view.state, "unavailable");
    assert.equal(view.puzzle, undefined);
    assert.deepEqual(view.history, []);
    assert.match(view.framing, /catalog/i);
  });
});
