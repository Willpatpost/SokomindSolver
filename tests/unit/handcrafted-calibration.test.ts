import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { getPuzzleById } from "../../src/catalog/puzzles.ts";
import {
  evaluatePuzzleWithSteps,
  buildCalibrationReport,
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

const TIER_INDEX: Record<Difficulty, number> = {
  tutorial: 0,
  beginner: 1,
  intermediate: 2,
  advanced: 3,
  expert: 4,
  master: 5,
};

const fixtureRaw = readFileSync(
  join(import.meta.dirname!, "../../tests/fixtures/generator/handcrafted-benchmark.json"),
  "utf-8",
);
const benchmarkEntries: BenchmarkEntry[] = JSON.parse(fixtureRaw);

test("handcrafted calibration report", { timeout: 180_000 }, async () => {
  const calibrationData: { puzzleId: string; expectedTier: Difficulty; vector: import("../../src/features/generator/v2/index.ts").PuzzleEvaluationVector }[] = [];

  for (const entry of benchmarkEntries) {
    const puzzle = getPuzzleById(entry.id);
    if (!puzzle) continue;

    const result = await evaluatePuzzleWithSteps(puzzle);
    if (!result.vector) continue;

    calibrationData.push({
      puzzleId: entry.id,
      expectedTier: entry.difficulty,
      vector: result.vector,
    });
  }

  assert.ok(calibrationData.length >= 20, `expected >= 20 evaluated puzzles, got ${calibrationData.length}`);

  const report: CalibrationReport = buildCalibrationReport(calibrationData);

  console.log(formatCalibrationReport(report));

  assert.equal(report.totalPuzzles, calibrationData.length);
  assert.ok(report.exactMatchAccuracy >= 0 && report.exactMatchAccuracy <= 1, "exactMatchAccuracy in [0,1]");
  assert.ok(report.withinOneTierAccuracy >= report.exactMatchAccuracy, "withinOneTier >= exactMatch");

  for (const entry of report.entries) {
    if (entry.expectedTier === "tutorial") {
      assert.notEqual(entry.predictedTier, "master", `tutorial puzzle ${entry.puzzleId} classified as master`);
    }
  }

  if (report.worstOverclassification) {
    const delta = TIER_INDEX[report.worstOverclassification.predictedTier] - TIER_INDEX[report.worstOverclassification.expectedTier];
    assert.ok(delta <= 3, `worst overclassification delta ${delta} exceeds limit 3 (puzzle ${report.worstOverclassification.puzzleId})`);
  }
});
