import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runForge, type ForgeConfig } from "../../src/features/generator/v2/puzzle-forge.ts";
import { buildCanonicalSolutionTrace } from "../../src/features/generator/v2/solution-trace.ts";
import { analyzePassiveSolutionStory } from "../../src/features/generator/v2/passive-story-analysis.ts";
import { assessStoryQuality } from "../../src/features/generator/v2/story-quality-policy.ts";
import type { Direction } from "../../src/core/model.ts";

interface SampleFixture {
  schemaVersion: number;
  config: ForgeConfig;
  samples: { seed: number; boxCount: number; rows: string[]; witness: string;
    expected: { genericBoxes: number; typedBoxes: number; moves: number; pushes: number;
      pushesPerBox: number[]; families: string[] } }[];
}
const fixture = JSON.parse(readFileSync(new URL("../fixtures/generator/generated-quality-samples.json", import.meta.url), "utf8")) as SampleFixture;
assert.equal(fixture.schemaVersion, 1);
const letters: Record<Direction, string> = { up: "u", down: "d", left: "l", right: "r" };

for (const sample of fixture.samples) test(`quality sample ${sample.seed}: regenerates ${sample.boxCount} mixed, participating boxes`, async () => {
  // One attempt per run. No batch search, catalog quota relaxation, or promotion.
  const config = { ...fixture.config, baseSeed: sample.seed, boxCounts: [sample.boxCount] };
  for (let repeat = 0; repeat < 2; repeat++) {
    const result = await runForge(config);
    assert.equal(result.totalAttempted, 1);
    assert.equal(result.candidates.length, 1, JSON.stringify(result.rejectionCounts));
    const candidate = result.candidates[0];
    assert.equal(candidate.qualityProfile?.passed, true);
    assert.equal(candidate.storyAwareTypingVerification?.passed, true);
    assert.deepEqual(candidate.puzzle.rows, sample.rows);
    assert.ok(candidate.solutionSteps);
    const witness = candidate.solutionSteps.map((step) => step.kind === "push"
      ? letters[step.direction].toUpperCase() : letters[step.direction]).join("");
    assert.equal(witness, sample.witness);
    const grid = candidate.puzzle.rows.map((row) => [...row]);
    const replay = buildCanonicalSolutionTrace(grid, candidate.solutionSteps, { requireSolved: true });
    assert.ok(replay.ok);
    const story = analyzePassiveSolutionStory(grid, replay.trace);
    const quality = assessStoryQuality({ puzzle: candidate.puzzle, trace: replay.trace,
      passiveStory: story, typing: candidate.storyAwareTyping, construction: candidate.mechanismConstruction,
      constructionRequired: candidate.provenance.mode === "mechanism" });
    assert.equal(quality.passed, true, JSON.stringify(quality.violations));
    const measured = quality.measurements;
    assert.equal(measured.genericBoxCount, sample.expected.genericBoxes);
    assert.equal(measured.typedBoxCount, sample.expected.typedBoxes);
    assert.equal(replay.trace.steps.length, sample.expected.moves);
    assert.equal(replay.trace.pushes.length, sample.expected.pushes);
    assert.deepEqual(measured.boxes.map((box) => box.pushes), sample.expected.pushesPerBox);
    assert.ok(measured.boxes.every((box) => box.interactionPartners.length > 0 && box.pushes >= 2));
    assert.deepEqual(measured.families, sample.expected.families);
    assert.ok(measured.crossTypePairs.length > 0);
    if (sample.seed === 310049) assert.ok(story.genericGoalMisdirection.misdirectedBoxCount > 0);
    if (sample.seed === 310005) assert.ok(story.progressReversals.reversalCount > 0);
  }
});
