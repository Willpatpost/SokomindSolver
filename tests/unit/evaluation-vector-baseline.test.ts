import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { PUZZLE_BY_ID } from "../../src/catalog/puzzles.ts";
import { evaluatePuzzleWithSteps } from "../../src/features/generator/v2/puzzle-evaluator.ts";

interface BaselineFixture {
  readonly schemaVersion: number;
  readonly cases: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

test("canonical trace refactors preserve the complete deterministic Generator 4.2 vector", async () => {
  const fixture = JSON.parse(readFileSync(join(
    import.meta.dirname!,
    "../fixtures/generator/evaluation-vector-baseline.json",
  ), "utf-8")) as BaselineFixture;
  assert.equal(fixture.schemaVersion, 1);

  for (const [id, expected] of Object.entries(fixture.cases)) {
    const puzzle = PUZZLE_BY_ID[id];
    assert.ok(puzzle, `missing evaluator fixture ${id}`);
    const result = await evaluatePuzzleWithSteps(puzzle);
    const stableVector = Object.fromEntries(
      Object.entries(result.vector).filter(([key]) => key !== "solverElapsedMs"),
    );
    assert.deepEqual(stableVector, expected, `${id} evaluator vector drifted`);
    assert.ok(result.trace?.solved, `${id} must retain a replay-valid trace`);
  }
});
