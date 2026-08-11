import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getNewlyUnlockedAchievements,
} from "../../src/features/achievements/achievements.ts";
import { computeStats } from "../../src/features/progress/compute-stats.ts";
import {
  EMPTY_PROGRESS,
  recordCompletion,
} from "../../src/shared/progress.ts";

const puzzles = [{
  id: "first",
  title: "First",
  difficulty: "beginner" as const,
  boxes: 1,
}];

test("achievement delta includes the solve that crosses a threshold exactly once", () => {
  const next = recordCompletion(EMPTY_PROGRESS, "first", 4, 1);
  const unlocked = getNewlyUnlockedAchievements(
    computeStats(EMPTY_PROGRESS, puzzles),
    EMPTY_PROGRESS,
    computeStats(next, puzzles),
    next,
  );
  assert.deepEqual(
    unlocked.filter(({ id }) => id === "first-solve").map(({ id }) => id),
    ["first-solve"],
  );
  assert.deepEqual(
    getNewlyUnlockedAchievements(
      computeStats(next, puzzles),
      next,
      computeStats(next, puzzles),
      next,
    ),
    [],
  );
});
