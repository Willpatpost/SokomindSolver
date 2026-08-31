import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { PUZZLE_BY_ID } from "../../src/catalog/puzzles.ts";

const REQUIRED_FEATURES = new Set([
  "generic-goal-misdirection",
  "temporary-progress-reversal",
  "multi-room-journey",
  "goal-room-packing",
  "gate-key-box",
  "interleaved-box-classes",
  "distinct-solution-phases",
  "controlled-false-start",
  "recovery-optionality",
  "visual-identity",
]);

interface CalibrationFeature {
  readonly id: string;
  readonly positivePuzzleIds: readonly string[];
  readonly nearMissPuzzleIds: readonly string[];
}

interface CalibrationFixture {
  readonly schemaVersion: number;
  readonly features: readonly CalibrationFeature[];
}

test("solution-story calibration covers every planned feature with retained puzzles", () => {
  const path = join(
    import.meta.dirname!,
    "../fixtures/generator/solution-story-calibration.json",
  );
  const fixture = JSON.parse(readFileSync(path, "utf-8")) as CalibrationFixture;

  assert.equal(fixture.schemaVersion, 1);
  assert.deepEqual(new Set(fixture.features.map(({ id }) => id)), REQUIRED_FEATURES);

  for (const feature of fixture.features) {
    assert.ok(feature.positivePuzzleIds.length > 0, `${feature.id} needs positive calibration`);
    assert.ok(feature.nearMissPuzzleIds.length > 0, `${feature.id} needs near-miss calibration`);
    const positiveIds = new Set(feature.positivePuzzleIds);
    for (const id of [...feature.positivePuzzleIds, ...feature.nearMissPuzzleIds]) {
      assert.ok(PUZZLE_BY_ID[id], `${feature.id} references removed puzzle ${id}`);
      assert.ok(!id.startsWith("gen-"), `${feature.id} must use a retained original`);
    }
    for (const id of feature.nearMissPuzzleIds) {
      assert.ok(!positiveIds.has(id), `${feature.id} uses ${id} as both positive and near-miss`);
    }
  }

  const misdirection = fixture.features.find(({ id }) => id === "generic-goal-misdirection");
  assert.deepEqual(misdirection?.positivePuzzleIds, ["huge"]);
});
