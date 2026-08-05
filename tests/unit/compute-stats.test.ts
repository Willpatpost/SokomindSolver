import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PuzzleDefinition } from "../../src/core/model.ts";
import type { ProgressData } from "../../src/shared/progress.ts";
import { computeStats } from "../../src/features/progress/compute-stats.ts";

function puzzle(overrides: Partial<PuzzleDefinition> & Pick<PuzzleDefinition, "id" | "difficulty" | "boxes">): PuzzleDefinition {
  return {
    title: overrides.id,
    rows: [],
    ...overrides,
  };
}

function progress(completed: Record<string, { moves: number; pushes: number; completedAt?: string }>): ProgressData {
  const mapped: Record<string, { moves: number; pushes: number; completedAt: string }> = {};
  for (const [id, rec] of Object.entries(completed)) {
    mapped[id] = { ...rec, completedAt: rec.completedAt ?? "2024-01-01T00:00:00Z" };
  }
  return { version: 1, completed: mapped };
}

const EMPTY: ProgressData = { version: 1, completed: {} };

describe("computeStats", () => {
  describe("empty puzzle list", () => {
    it("returns zero totals and empty tiers", () => {
      const stats = computeStats(EMPTY, []);
      assert.equal(stats.totalSolved, 0);
      assert.equal(stats.totalPuzzles, 0);
      assert.equal(stats.completionPercentage, 0);
      assert.equal(stats.ignoredRecords, 0);
      assert.equal(stats.totalMoves, 0);
      assert.equal(stats.totalPushes, 0);
      assert.equal(stats.averagePushesPerPuzzle, 0);
      assert.equal(stats.bestEfficiency, null);
    });

    it("still includes all difficulty tiers", () => {
      const stats = computeStats(EMPTY, []);
      assert.equal(stats.byDifficulty.length, 6);
      for (const tier of stats.byDifficulty) {
        assert.equal(tier.solved, 0);
        assert.equal(tier.total, 0);
      }
    });
  });

  describe("none completed", () => {
    it("counts totals but zero solved", () => {
      const puzzles = [
        puzzle({ id: "a", difficulty: "tutorial", boxes: 1 }),
        puzzle({ id: "b", difficulty: "beginner", boxes: 2 }),
        puzzle({ id: "c", difficulty: "expert", boxes: 3 }),
      ];
      const stats = computeStats(EMPTY, puzzles);
      assert.equal(stats.totalPuzzles, 3);
      assert.equal(stats.totalSolved, 0);
      assert.equal(stats.totalMoves, 0);
      assert.equal(stats.totalPushes, 0);
      assert.equal(stats.averagePushesPerPuzzle, 0);
      assert.equal(stats.bestEfficiency, null);
    });

    it("counts per-difficulty totals correctly", () => {
      const puzzles = [
        puzzle({ id: "a", difficulty: "tutorial", boxes: 1 }),
        puzzle({ id: "b", difficulty: "tutorial", boxes: 1 }),
        puzzle({ id: "c", difficulty: "beginner", boxes: 2 }),
      ];
      const stats = computeStats(EMPTY, puzzles);
      const tutorial = stats.byDifficulty.find((t) => t.difficulty === "tutorial")!;
      const beginner = stats.byDifficulty.find((t) => t.difficulty === "beginner")!;
      assert.equal(tutorial.total, 2);
      assert.equal(tutorial.solved, 0);
      assert.equal(beginner.total, 1);
      assert.equal(beginner.solved, 0);
    });
  });

  describe("all completed", () => {
    it("reports all solved and accumulates moves/pushes", () => {
      const puzzles = [
        puzzle({ id: "x", difficulty: "intermediate", boxes: 2 }),
        puzzle({ id: "y", difficulty: "intermediate", boxes: 3 }),
      ];
      const prog = progress({
        x: { moves: 10, pushes: 4 },
        y: { moves: 20, pushes: 6 },
      });
      const stats = computeStats(prog, puzzles);
      assert.equal(stats.totalSolved, 2);
      assert.equal(stats.totalPuzzles, 2);
      assert.equal(stats.totalMoves, 30);
      assert.equal(stats.totalPushes, 10);
    });

    it("computes average pushes per puzzle", () => {
      const puzzles = [
        puzzle({ id: "a", difficulty: "beginner", boxes: 1 }),
        puzzle({ id: "b", difficulty: "beginner", boxes: 1 }),
      ];
      const prog = progress({
        a: { moves: 5, pushes: 3 },
        b: { moves: 7, pushes: 5 },
      });
      const stats = computeStats(prog, puzzles);
      assert.equal(stats.averagePushesPerPuzzle, 4);
    });
  });

  describe("partial completion", () => {
    it("only counts completed puzzles in solved totals", () => {
      const puzzles = [
        puzzle({ id: "done", difficulty: "advanced", boxes: 2 }),
        puzzle({ id: "pending", difficulty: "advanced", boxes: 3 }),
        puzzle({ id: "also-pending", difficulty: "expert", boxes: 1 }),
      ];
      const prog = progress({ done: { moves: 15, pushes: 8 } });
      const stats = computeStats(prog, puzzles);
      assert.equal(stats.totalSolved, 1);
      assert.equal(stats.totalPuzzles, 3);
      assert.equal(stats.totalMoves, 15);
      assert.equal(stats.totalPushes, 8);
    });

    it("tracks solved counts per difficulty tier", () => {
      const puzzles = [
        puzzle({ id: "a", difficulty: "advanced", boxes: 1 }),
        puzzle({ id: "b", difficulty: "advanced", boxes: 1 }),
        puzzle({ id: "c", difficulty: "expert", boxes: 1 }),
      ];
      const prog = progress({ a: { moves: 5, pushes: 2 } });
      const stats = computeStats(prog, puzzles);
      const advanced = stats.byDifficulty.find((t) => t.difficulty === "advanced")!;
      const expert = stats.byDifficulty.find((t) => t.difficulty === "expert")!;
      assert.equal(advanced.solved, 1);
      assert.equal(advanced.total, 2);
      assert.equal(expert.solved, 0);
      assert.equal(expert.total, 1);
    });
  });

  describe("difficulty tier labels", () => {
    it("maps each difficulty to its human-readable label", () => {
      const stats = computeStats(EMPTY, []);
      const labels = stats.byDifficulty.map((t) => t.label);
      assert.deepEqual(labels, [
        "Tutorial",
        "Beginner",
        "Intermediate",
        "Advanced",
        "Expert",
        "Master",
      ]);
    });

    it("preserves DIFFICULTY_ORDER ordering", () => {
      const stats = computeStats(EMPTY, []);
      const difficulties = stats.byDifficulty.map((t) => t.difficulty);
      assert.deepEqual(difficulties, [
        "tutorial",
        "beginner",
        "intermediate",
        "advanced",
        "expert",
        "master",
      ]);
    });
  });

  describe("bestEfficiency", () => {
    it("selects the puzzle with lowest pushes-per-box ratio", () => {
      const puzzles = [
        puzzle({ id: "big", difficulty: "master", boxes: 5 }),
        puzzle({ id: "small", difficulty: "beginner", boxes: 2 }),
      ];
      const prog = progress({
        big: { moves: 30, pushes: 10 },
        small: { moves: 8, pushes: 2 },
      });
      const stats = computeStats(prog, puzzles);
      assert.deepEqual(stats.bestEfficiency, {
        title: "small",
        pushes: 2,
        boxes: 2,
      });
    });

    it("returns null when no puzzles are solved", () => {
      const puzzles = [puzzle({ id: "a", difficulty: "tutorial", boxes: 1 })];
      const stats = computeStats(EMPTY, puzzles);
      assert.equal(stats.bestEfficiency, null);
    });

    it("skips puzzles with zero boxes", () => {
      const puzzles = [
        puzzle({ id: "no-boxes", difficulty: "tutorial", boxes: 0 }),
        puzzle({ id: "has-boxes", difficulty: "tutorial", boxes: 3 }),
      ];
      const prog = progress({
        "no-boxes": { moves: 5, pushes: 0 },
        "has-boxes": { moves: 10, pushes: 6 },
      });
      const stats = computeStats(prog, puzzles);
      assert.deepEqual(stats.bestEfficiency, {
        title: "has-boxes",
        pushes: 6,
        boxes: 3,
      });
    });

    it("returns null when only zero-box puzzles are solved", () => {
      const puzzles = [
        puzzle({ id: "z", difficulty: "tutorial", boxes: 0 }),
      ];
      const prog = progress({ z: { moves: 1, pushes: 0 } });
      const stats = computeStats(prog, puzzles);
      assert.equal(stats.bestEfficiency, null);
    });

    it("picks the first puzzle when ratios are tied", () => {
      const puzzles = [
        puzzle({ id: "first", difficulty: "beginner", boxes: 2 }),
        puzzle({ id: "second", difficulty: "beginner", boxes: 4 }),
      ];
      const prog = progress({
        first: { moves: 10, pushes: 4 },
        second: { moves: 20, pushes: 8 },
      });
      const stats = computeStats(prog, puzzles);
      assert.equal(stats.bestEfficiency!.title, "first");
    });
  });

  describe("progress records for unknown puzzles are ignored", () => {
    it("does not count progress for puzzles not in the list", () => {
      const puzzles = [puzzle({ id: "a", difficulty: "tutorial", boxes: 1 })];
      const prog = progress({
        a: { moves: 5, pushes: 2 },
        unknown: { moves: 100, pushes: 50 },
      });
      const stats = computeStats(prog, puzzles);
      assert.equal(stats.totalSolved, 1);
      assert.equal(stats.totalMoves, 5);
      assert.equal(stats.totalPushes, 2);
      assert.equal(stats.completionPercentage, 100);
      assert.equal(stats.ignoredRecords, 1);
    });
  });

  describe("averagePushesPerPuzzle edge cases", () => {
    it("returns 0 when nothing is solved", () => {
      const puzzles = [puzzle({ id: "a", difficulty: "tutorial", boxes: 1 })];
      const stats = computeStats(EMPTY, puzzles);
      assert.equal(stats.averagePushesPerPuzzle, 0);
    });

    it("returns exact average for single solved puzzle", () => {
      const puzzles = [puzzle({ id: "a", difficulty: "tutorial", boxes: 1 })];
      const prog = progress({ a: { moves: 10, pushes: 7 } });
      const stats = computeStats(prog, puzzles);
      assert.equal(stats.averagePushesPerPuzzle, 7);
    });
  });
});
