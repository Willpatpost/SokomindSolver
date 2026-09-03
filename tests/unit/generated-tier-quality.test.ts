import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Direction, PuzzleDefinition } from "../../src/core/model.ts";
import type { PuzzleEvaluationVector } from "../../src/features/generator/v2/puzzle-evaluator.ts";
import type { StoryAwareTypingPlan } from "../../src/features/generator/v2/story-aware-typing.ts";
import type { MechanismConstructionPlan } from "../../src/features/generator/v2/mechanism-construction.ts";
import { buildCanonicalSolutionTrace } from "../../src/features/generator/v2/solution-trace.ts";
import { analyzePassiveSolutionStory } from "../../src/features/generator/v2/passive-story-analysis.ts";
import { assessCandidateQuality } from "../../src/features/generator/v2/story-quality-policy.ts";
import { classifyDifficultyByBoxCount } from "../../src/features/generator/v2/difficulty-model.ts";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/generator/generated-tier-samples.json", import.meta.url), "utf8")) as {
  samples: { puzzle: PuzzleDefinition; seed: number; witness: string; mode: string; evaluation: PuzzleEvaluationVector;
    typing: StoryAwareTypingPlan; construction?: MechanismConstructionPlan; expectedFamilies: string[] }[];
};
const directions: Record<string, Direction> = { u: "up", d: "down", l: "left", r: "right" };
test("generated calibration evidence covers every supported catalog tier", () => {
  assert.deepEqual(fixture.samples.map(s => s.puzzle.difficulty), ["beginner", "intermediate", "advanced", "expert", "master"]);
});
for (const sample of fixture.samples) test(`fresh replay and quality evidence: ${sample.puzzle.difficulty} seed ${sample.seed}`, () => {
  const steps = [...sample.witness].map(letter => ({ kind: letter === letter.toUpperCase() ? "push" as const : "walk" as const,
    direction: directions[letter.toLowerCase()] }));
  const grid = sample.puzzle.rows.map(row => [...row]);
  const replay = buildCanonicalSolutionTrace(grid, steps, { requireSolved: true });
  assert.ok(replay.ok);
  const story = analyzePassiveSolutionStory(grid, replay.trace);
  const quality = assessCandidateQuality({ puzzle: sample.puzzle, evaluation: sample.evaluation, trace: replay.trace,
    passiveStory: story, typing: sample.typing, construction: sample.construction, constructionRequired: sample.mode === "mechanism" });
  assert.equal(quality.passed, true, quality.reasons.join("; "));
  assert.equal(classifyDifficultyByBoxCount(sample.puzzle.boxes), sample.puzzle.difficulty);
  assert.equal(replay.trace.steps.length, sample.evaluation.solutionMoves);
  assert.equal(replay.trace.pushes.length, sample.evaluation.solutionPushes);
  assert.deepEqual(quality.story!.measurements.families, sample.expectedFamilies);
  assert.ok(quality.story!.measurements.boxes.every(b => b.pushes >= 2 && b.interactionPartners.length > 0));
  assert.ok(quality.story!.measurements.crossTypePairs.length > 0);
  const tampered = buildCanonicalSolutionTrace(grid, steps.slice(0, -1), { requireSolved: true });
  assert.equal(tampered.ok, false);
});
