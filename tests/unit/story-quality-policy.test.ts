import assert from "node:assert/strict";
import test from "node:test";
import {
  assessStoryQuality, storyQualityViolations, checkStoryQualityForRelease,
  DEFAULT_STORY_QUALITY_POLICY, type StoryQualityMeasurements,
} from "../../src/features/generator/v2/story-quality-policy.ts";
import { analyzeCounterfactualStory } from "../../src/features/generator/v2/counterfactual-analysis.ts";
import { assessQuality } from "../../src/features/generator/v2/quality-gate.ts";
import { evaluatePuzzleWithSteps } from "../../src/features/generator/v2/puzzle-evaluator.ts";
import { SHARED_PACKING_STORY, ISOLATED_BOX_STORY } from "../fixtures/generator/story-quality-fixtures.ts";
import { syntheticStoryReport, typedStoryInput } from "../support/story-quality.ts";

test("quality policy accepts a replayed mixed packing story with all boxes participating", () => {
  const input = typedStoryInput(SHARED_PACKING_STORY);
  const report = assessStoryQuality(input);
  assert.equal(report.passed, true, JSON.stringify(report.violations));
  assert.ok(report.measurements.families.includes("shared-transport"));
  assert.ok(report.measurements.families.includes("multi-room-journey"));
  assert.equal(report.measurements.boxes.length, 3);
  assert.ok(report.measurements.boxes.every((box) => box.pushes >= 2 && box.interactionPartners.length > 0));
  assert.deepEqual(report, assessStoryQuality(input));
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  assert.deepEqual(checkStoryQualityForRelease(report, { ...report.measurements, mode: "plain" }), []);
});

test("a box with multiple pushes is still rejected when it is isolated from the puzzle", () => {
  const input = typedStoryInput(ISOLATED_BOX_STORY);
  const report = assessStoryQuality(input);
  assert.equal(report.passed, false);
  assert.ok(report.violations.some((violation) => violation.code === "story-isolated-boxes" && violation.boxIds?.includes(2)));
});

test("quality policy rejects missing, stale, unsolved, and unverified typing evidence", () => {
  const input = typedStoryInput(SHARED_PACKING_STORY);
  for (const altered of [
    { ...input, trace: null }, { ...input, passiveStory: null },
    { ...input, trace: { ...input.trace!, solved: false } },
    { ...input, passiveStory: { ...input.passiveStory!, boardHash: "stale" } },
  ]) {
    assert.ok(assessStoryQuality(altered).violations.some((v) => v.code === "story-evidence-invalid"));
  }
  assert.ok(assessStoryQuality({ ...input, typing: undefined }).violations.some((v) => v.code === "story-typing-unverified"));
});

test("inconclusive or disabled counterfactual probes never change quality acceptance", () => {
  const input = typedStoryInput(SHARED_PACKING_STORY);
  const baseline = assessStoryQuality(input);
  const counterfactualStory = analyzeCounterfactualStory(
    input.puzzle.rows.map((row) => [...row]), input.trace!, { maxElapsedMs: 0 },
  );
  assert.ok(counterfactualStory.unknownProbes > 0);
  const unknown = assessStoryQuality({ ...input, counterfactualStory });
  assert.equal(unknown.passed, baseline.passed);
  assert.deepEqual(unknown.violations, baseline.violations);
  assert.equal(unknown.counterfactual.unknown, counterfactualStory.unknownProbes);
  assert.equal(assessStoryQuality({ ...input, counterfactualStory: { ...counterfactualStory, boardHash: "stale" } })
    .counterfactual.available, false);
});

test("constructed story claims require final target-local evidence", () => {
  const input = typedStoryInput(SHARED_PACKING_STORY);
  assert.ok(assessStoryQuality({ ...input, constructionRequired: true }).violations
    .some((v) => v.code === "story-construction-unrealized"));
  const report = assessStoryQuality({
    ...input, construction: {
      seed: 42, tier: "beginner", boxCount: 3, minGenericBoxes: 1, minTypedBoxes: 1,
      crossTypeInteractionRequired: true, targets: [{
        id: "invented-reopening", mechanismIndex: 0, type: "gate-reopening",
        directive: "doorway-gate-reopen", roomIds: [], dependsOnTargetIds: [],
        requiredEvidence: ["gate-reopening", "cross-type-interaction"],
        goals: input.trace!.goals.map((goal, goalIndex) => ({
          goalIndex, goalId: goal.id, position: goal.position, roomId: 0, depthFromDoorway: 0, role: "gatekeeper",
        })),
      }],
    },
  });
  assert.equal(report.passed, false);
  assert.deepEqual(report.measurements.missingConstructionTargets, ["invented-reopening"]);
});

test("box count alone selects tier while higher tiers require a richer feature basket", () => {
  const input = typedStoryInput(SHARED_PACKING_STORY);
  assert.equal(assessStoryQuality({ ...input, puzzle: { ...input.puzzle, difficulty: "master" } }).tier, "beginner");
  for (const [count, tier] of [[3, "beginner"], [6, "beginner"], [7, "intermediate"],
    [9, "intermediate"], [10, "advanced"], [13, "advanced"], [14, "expert"], [17, "expert"], [18, "master"], [22, "master"]] as const) {
    const report = syntheticStoryReport("board", count, count < 7 ? 1 : 2);
    assert.equal(report.tier, tier);
    assert.deepEqual(storyQualityViolations(report.measurements), []);
    const sparse = { ...report.measurements, families: ["shared-transport" as const] };
    assert.equal(storyQualityViolations(sparse).some((v) => v.code === "story-feature-variety"), count >= 7);
  }
});

test("core quality rules cannot be disabled by tuning story-family floors", () => {
  const base = syntheticStoryReport("board", 20, 2).measurements;
  const policy = { minStoryFamilies: { ...DEFAULT_STORY_QUALITY_POLICY.minStoryFamilies, master: 0 } };
  const reject = (override: Partial<StoryQualityMeasurements>, code: string) =>
    assert.ok(storyQualityViolations({ ...base, ...override }, policy).some((v) => v.code === code));
  reject({ genericBoxCount: 1, typedBoxCount: 19 }, "story-mixed-typing");
  reject({ crossTypePairs: [] }, "story-cross-type-interaction");
  reject({ boxes: base.boxes.map((box, i) => i === 0 ? { ...box, pushes: 1 } : box) }, "story-box-participation");
  reject({ boxes: base.boxes.map((box, i) => i === 0 ? { ...box, pushes: 0 } : box) }, "story-box-participation");
  reject({ typingVerified: false }, "story-typing-unverified");
  reject({ constructionVerified: false }, "story-construction-unrealized");
  assert.throws(() => storyQualityViolations(base, {
    minStoryFamilies: { ...policy.minStoryFamilies, master: NaN },
  }), /Invalid story quality policy/);
});

test("release rechecks story measurements instead of trusting a passing flag", () => {
  const report = syntheticStoryReport("board", 20, 2);
  const expected = { boardHash: "board", boxCount: 20, genericBoxCount: 2, typedBoxCount: 18, mode: "plain" };
  assert.deepEqual(checkStoryQualityForRelease(report, expected), []);
  for (const altered of [undefined, null, {}, { ...report, policyVersion: "old" },
    { ...report, measurements: { ...report.measurements, boardHash: "stale" } },
    { ...report, measurements: { ...report.measurements, families: ["shared-transport"] } },
    { ...report, measurements: { ...report.measurements, families: Array(4).fill("shared-transport") } },
    { ...report, measurements: { ...report.measurements, boxes: [null] } },
    { ...report, measurements: { ...report.measurements, crossTypePairs: [[0, 1]] } },
    { ...report, measurements: { ...report.measurements, constructionRealized: NaN } },
    { ...report, passed: false },
  ]) assert.ok(checkStoryQualityForRelease(altered, expected).length > 0);
});

test("legacy quality cannot pass unsolved or nonfinite evaluation vectors", async () => {
  const evaluated = await evaluatePuzzleWithSteps(SHARED_PACKING_STORY.puzzle);
  assert.ok(evaluated.vector.solved);
  assert.equal(assessQuality({ ...evaluated.vector, solved: false }, "beginner").passed, false);
  assert.equal(assessQuality({ ...evaluated.vector, solutionFloorCoverage: NaN }, "beginner").passed, false);
});
