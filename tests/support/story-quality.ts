import assert from "node:assert/strict";
import { createRng } from "../../src/features/generator/board-template.ts";
import { applyStoryAwareTyping } from "../../src/features/generator/v2/story-aware-typing.ts";
import { analyzePassiveSolutionStory } from "../../src/features/generator/v2/passive-story-analysis.ts";
import { buildCanonicalSolutionTrace } from "../../src/features/generator/v2/solution-trace.ts";
import {
  DEFAULT_STORY_QUALITY_POLICY, STORY_QUALITY_FAMILIES, STORY_QUALITY_POLICY_VERSION,
  type StoryQualityInput, type StoryQualityMeasurements, type StoryQualityReport,
} from "../../src/features/generator/v2/story-quality-policy.ts";
import { classifyDifficultyByBoxCount } from "../../src/features/generator/v2/difficulty-model.ts";
import type { CounterfactualFixture } from "../fixtures/generator/counterfactual-stories.ts";
import { fixtureTrace } from "./counterfactual-replay.ts";

export function typedStoryInput(fixture: CounterfactualFixture): StoryQualityInput {
  const { trace } = fixtureTrace(fixture);
  const steps = trace.steps.map(({ kind, direction }) => ({ kind, direction }));
  const typed = applyStoryAwareTyping(fixture.puzzle, {
    steps, moves: steps.length, pushes: trace.pushes.length,
    objective: { kind: "moves" }, objectiveScore: steps.length, optimality: "unknown",
  }, createRng(42), 0.4);
  assert.ok(typed, "fixture needs a feasible mixed story assignment");
  const grid = typed.puzzle.rows.map((row) => [...row]);
  const result = buildCanonicalSolutionTrace(grid, steps, { requireSolved: true });
  assert.ok(result.ok);
  return {
    puzzle: typed.puzzle, typing: typed.plan, trace: result.trace,
    passiveStory: analyzePassiveSolutionStory(grid, result.trace),
  };
}

/** Synthetic reports for release-serialization tests, not puzzle calibration. */
export function syntheticStoryReport(
  boardHash: string, boxCount: number, genericBoxCount: number,
  overrides: Partial<StoryQualityMeasurements> = {},
): StoryQualityReport {
  const tier = classifyDifficultyByBoxCount(boxCount);
  const measurements: StoryQualityMeasurements = {
    boardHash, evidenceValid: true, boxCount, genericBoxCount, typedBoxCount: boxCount - genericBoxCount,
    boxes: Array.from({ length: boxCount }, (_, boxId) => ({
      boxId, kind: boxId < genericBoxCount ? "generic" : "typed", pushes: 3, distinctCells: 4,
      interactionPartners: Array.from({ length: boxCount }, (_, id) => id).filter((id) => id !== boxId),
    })),
    crossTypePairs: [[0, genericBoxCount]], families: [...STORY_QUALITY_FAMILIES],
    constructionRequired: false, constructionVerified: true, constructionTargets: 0, constructionRealized: 0,
    missingConstructionTargets: [], typingVerified: true, ...overrides,
  };
  return {
    policyVersion: STORY_QUALITY_POLICY_VERSION, tier,
    requiredStoryFamilies: DEFAULT_STORY_QUALITY_POLICY.minStoryFamilies[tier], measurements,
    passed: true, violations: [], familyQualityScore: 1,
    counterfactual: { available: false, necessary: 0, optional: 0, recoverable: 0,
      delayedFalseStarts: 0, unknown: 0, omitted: 0 },
  };
}
