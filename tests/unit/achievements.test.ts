import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ACHIEVEMENTS,
  ACHIEVEMENT_COLLECTIONS,
  getAchievementProgress,
  getNewlyUnlockedAchievements,
  getRecentAchievementMilestones,
  getUnlockedAchievements,
} from "../../src/features/achievements/achievements.ts";
import {
  DEFAULT_COSMETIC_PREFERENCE,
  getCosmeticStates,
  parseCosmeticPreference,
  saveCosmeticPreference,
  resolveActiveBoardFrame,
} from "../../src/features/achievements/cosmetics.ts";
import { STORAGE_KEYS } from "../../src/shared/storage.ts";
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

describe("achievement collections and visible progress", () => {
  test("every achievement belongs to one understandable collection", () => {
    const collectionIds = new Set(ACHIEVEMENT_COLLECTIONS.map(({ id }) => id));
    assert.equal(ACHIEVEMENT_COLLECTIONS.length, 4);
    assert.equal(ACHIEVEMENTS.every(({ collectionId }) => collectionIds.has(collectionId)), true);
    assert.equal(new Set(ACHIEVEMENTS.map(({ id }) => id)).size, ACHIEVEMENTS.length);
  });

  test("every non-secret requirement exposes deterministic progress", () => {
    const stats = computeStats(EMPTY_PROGRESS, puzzles);
    for (const achievement of ACHIEVEMENTS) {
      const first = getAchievementProgress(achievement, stats, EMPTY_PROGRESS);
      const second = getAchievementProgress(achievement, stats, EMPTY_PROGRESS);
      assert.deepEqual(first, second);
      assert.ok(first.target > 0);
      assert.ok(first.current >= 0 && first.current <= first.target);
      assert.ok(first.label.length > 0);
      assert.equal(first.complete, achievement.check(stats, EMPTY_PROGRESS));
    }
  });

  test("catalog mastery shows exact solved and total counts", () => {
    const tutorialPuzzles = [
      { id: "t1", title: "T1", difficulty: "tutorial" as const, boxes: 1 },
      { id: "t2", title: "T2", difficulty: "tutorial" as const, boxes: 1 },
    ];
    const oneSolved = recordCompletion(EMPTY_PROGRESS, "t1", 2, 1);
    const achievement = ACHIEVEMENTS.find(({ id }) => id === "tutorial-complete")!;
    const progress = getAchievementProgress(
      achievement,
      computeStats(oneSolved, tutorialPuzzles),
      oneSolved,
    );
    assert.deepEqual(progress, {
      current: 1,
      target: 2,
      label: "1 of 2 tutorial puzzles",
      complete: false,
    });
  });
});

describe("recent achievement milestones", () => {
  test("sorts inferable unlocks by their saved completion date", () => {
    const catalog = Array.from({ length: 10 }, (_, index) => ({
      id: `p${index + 1}`,
      title: `Puzzle ${index + 1}`,
      difficulty: "beginner" as const,
      boxes: 1,
    }));
    let progress = EMPTY_PROGRESS;
    for (let index = 0; index < catalog.length; index++) {
      progress = recordCompletion(
        progress,
        catalog[index].id,
        4,
        1,
        undefined,
        new Date(`2026-08-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`),
      );
    }
    const milestones = getRecentAchievementMilestones(
      computeStats(progress, catalog),
      progress,
      catalog,
    );
    assert.deepEqual(milestones.map(({ achievementId }) => achievementId), [
      "ten-solved",
      "all-solved",
      "beginner-complete",
      "streak-7",
      "streak-3",
      "first-solve",
    ]);
    assert.equal(milestones[0].earnedAt, "2026-08-10T12:00:00.000Z");
  });

  test("derives streak milestone dates from explicit visible activity", () => {
    const progress = {
      ...EMPTY_PROGRESS,
      activity: {
        "2026-08-01": ["first"],
        "2026-08-02": ["first"],
        "2026-08-03": ["first"],
      },
    };
    const stats = {
      ...computeStats(progress, puzzles),
      streak: { current: 3, longest: 3, activeTodayOrYesterday: true },
    };
    const milestones = getRecentAchievementMilestones(stats, progress, puzzles);
    assert.equal(milestones.find(({ achievementId }) => achievementId === "streak-3")?.earnedAt, "2026-08-03T12:00:00.000Z");
  });
});

describe("board-frame cosmetics", () => {
  test("reports an unavailable durable cosmetic write", () => {
    assert.deepEqual(
      saveCosmeticPreference({ version: 1, boardFrame: "classic" }),
      {
        ok: false,
        key: STORAGE_KEYS.cosmetics,
        operation: "write",
        reason: "unavailable",
      },
    );
  });

  test("malformed preferences fail closed", () => {
    assert.equal(parseCosmeticPreference(null), DEFAULT_COSMETIC_PREFERENCE);
    assert.equal(parseCosmeticPreference("not-json"), DEFAULT_COSMETIC_PREFERENCE);
    assert.equal(
      parseCosmeticPreference('{"version":1,"boardFrame":"unknown"}'),
      DEFAULT_COSMETIC_PREFERENCE,
    );
  });

  test("locked or theme-incompatible selections resolve to the classic frame", () => {
    const stats = computeStats(EMPTY_PROGRESS, puzzles);
    assert.equal(
      resolveActiveBoardFrame(
        { version: 1, boardFrame: "sage-thread" },
        "cozy-study",
        stats,
        EMPTY_PROGRESS,
      ),
      "classic",
    );
    const tenSolved = {
      ...stats,
      totalSolved: 10,
    };
    assert.equal(
      resolveActiveBoardFrame(
        { version: 1, boardFrame: "sage-thread" },
        "minimal-ink",
        tenSolved,
        EMPTY_PROGRESS,
      ),
      "sage-thread",
    );
    assert.equal(
      resolveActiveBoardFrame(
        { version: 1, boardFrame: "neon-orbit" },
        "cozy-study",
        { ...stats, totalSolved: 50 },
        EMPTY_PROGRESS,
      ),
      "classic",
    );
  });

  test("cosmetic state explains unlock, compatibility, selection, and active state", () => {
    const states = getCosmeticStates(
      { version: 1, boardFrame: "brass-edge" },
      "midnight-neon",
      computeStats(EMPTY_PROGRESS, puzzles),
      EMPTY_PROGRESS,
    );
    const brass = states.find(({ id }) => id === "brass-edge")!;
    assert.equal(brass.unlocked, false);
    assert.equal(brass.compatible, false);
    assert.equal(brass.selected, true);
    assert.equal(brass.active, false);
    assert.equal(states.find(({ id }) => id === "classic")?.active, true);
  });

  test("unlocked evaluation stays stable across repeated calls", () => {
    const stats = computeStats(EMPTY_PROGRESS, puzzles);
    assert.deepEqual(
      getUnlockedAchievements(stats, EMPTY_PROGRESS),
      getUnlockedAchievements(stats, EMPTY_PROGRESS),
    );
  });
});
