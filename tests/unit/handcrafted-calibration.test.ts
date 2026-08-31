import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { getPuzzleById } from "../../src/catalog/puzzles.ts";
import {
  evaluatePuzzleWithSteps,
  buildCalibrationReport,
  classifyDifficultyByBoxCount,
  formatCalibrationReport,
} from "../../src/features/generator/v2/index.ts";
import type { CalibrationReport } from "../../src/features/generator/v2/index.ts";
import type { Difficulty } from "../../src/core/model.ts";

interface BenchmarkEntry {
  id: string;
  difficulty: Difficulty;
  boxes: number;
  width: number;
  height: number;
  totalFloor: number;
}

const fixtureRaw = readFileSync(
  join(import.meta.dirname!, "../../tests/fixtures/generator/handcrafted-benchmark.json"),
  "utf-8",
);
const benchmarkEntries: BenchmarkEntry[] = JSON.parse(fixtureRaw);

test("handcrafted calibration report", { timeout: 180_000 }, async () => {
  const calibrationData: { puzzleId: string; expectedTier: Difficulty; vector: import("../../src/features/generator/v2/index.ts").PuzzleEvaluationVector }[] = [];
  const unresolved: string[] = [];

  for (const entry of benchmarkEntries) {
    const puzzle = getPuzzleById(entry.id);
    if (!puzzle) continue;

    const result = await evaluatePuzzleWithSteps(puzzle);
    if (!result.vector.solved) {
      unresolved.push(entry.id);
      continue;
    }

    calibrationData.push({
      puzzleId: entry.id,
      expectedTier: classifyDifficultyByBoxCount(entry.boxes),
      vector: result.vector,
    });
    assert.equal(result.vector.boxCount, entry.boxes, `${entry.id} box count drifted`);
  }

  assert.ok(calibrationData.length >= 15, `expected >= 15 evaluated puzzles, got ${calibrationData.length}`);
  assert.ok(
    unresolved.length <= 1,
    `too many calibration fixtures were unresolved: ${unresolved.join(", ")}`,
  );

  const report: CalibrationReport = buildCalibrationReport(calibrationData);

  console.log(formatCalibrationReport(report));

  assert.equal(report.totalPuzzles, calibrationData.length);
  assert.ok(
    report.exactMatchAccuracy === 1,
    `box-count tier accuracy ${(report.exactMatchAccuracy * 100).toFixed(1)}% is not exact`,
  );
  assert.ok(
    report.withinOneTierAccuracy === 1,
    `box-count within-one accuracy ${(report.withinOneTierAccuracy * 100).toFixed(1)}% is not exact`,
  );

  for (const entry of report.entries) {
    if (entry.expectedTier === "tutorial") {
      assert.notEqual(entry.predictedTier, "master", `tutorial puzzle ${entry.puzzleId} classified as master`);
    }
  }
});
