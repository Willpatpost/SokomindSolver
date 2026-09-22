import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProgressionProfile,
  selectForProgression,
  DEFAULT_TIER_QUOTAS,
  validateQuotaQualitySeparation,
  DEFAULT_FORGE_CONFIG,
  DEFAULT_FORGE_GATES,
} from "../../src/features/generator/v2/index.ts";
import type { Difficulty } from "../../src/core/model.ts";
import type { CurationObjectives } from "../../src/features/generator/v2/finalist-evaluator.ts";

function makeObjectives(): CurationObjectives {
  return { interaction: 1, dependency: 1, decisionQuality: 1, structuralRichness: 1, solverChallenge: 1, novelty: 1, tedium: 0.1 };
}

function makeTieredCandidate(tier: Difficulty, front: number = 0, novelty: number = 1) {
  return {
    item: { id: `test-${tier}` },
    objectives: makeObjectives(),
    front,
    noveltyScore: novelty,
    tier,
  };
}

// ---------------------------------------------------------------------------
// Item 19 tests
// ---------------------------------------------------------------------------

test("buildProgressionProfile identifies tier gaps", () => {
  const tierCounts = {
    tutorial: 0, beginner: 0, intermediate: 5,
    advanced: 3, expert: 2, master: 0,
  } as Record<Difficulty, number>;

  const profile = buildProgressionProfile(tierCounts);
  assert.ok(profile.gaps.includes("tutorial"), "tutorial should be a gap");
  assert.ok(profile.gaps.includes("beginner"), "beginner should be a gap");
  assert.ok(profile.gaps.includes("master"), "master should be a gap");
  assert.ok(!profile.gaps.includes("intermediate"), "intermediate has enough");
});

test("buildProgressionProfile identifies surplus tiers", () => {
  const tierCounts = {
    tutorial: 10, beginner: 2, intermediate: 3,
    advanced: 2, expert: 1, master: 1,
  } as Record<Difficulty, number>;

  const profile = buildProgressionProfile(tierCounts);
  assert.ok(profile.surplus.includes("tutorial"), `tutorial at 10 exceeds max 5, surplus: ${profile.surplus}`);
});

test("buildProgressionProfile balance score is 1 for perfect distribution", () => {
  const total = 100;
  const tierCounts = {} as Record<Difficulty, number>;
  for (const q of DEFAULT_TIER_QUOTAS) {
    tierCounts[q.tier] = Math.round(q.weight * total);
  }

  const profile = buildProgressionProfile(tierCounts);
  assert.ok(profile.balance > 0.9, `perfect distribution should have high balance, got ${profile.balance}`);
});

test("selectForProgression fills tier minimums first", () => {
  const candidates = [
    makeTieredCandidate("intermediate", 0, 5),
    makeTieredCandidate("intermediate", 0, 4),
    makeTieredCandidate("intermediate", 0, 3),
    makeTieredCandidate("intermediate", 0, 2),
    makeTieredCandidate("intermediate", 0, 1),
    makeTieredCandidate("beginner", 0, 3),
    makeTieredCandidate("beginner", 0, 2),
    makeTieredCandidate("tutorial", 0, 1),
    makeTieredCandidate("advanced", 0, 2),
    makeTieredCandidate("expert", 0, 1),
  ];

  const selected = selectForProgression(candidates, 6);
  const tiers = selected.map((c) => (c as unknown as { tier: Difficulty }).tier ?? "intermediate");

  const tierSet = new Set(tiers);
  assert.ok(tierSet.size >= 3, `should cover at least 3 tiers with 6 slots, got ${[...tierSet]}`);
});

test("selectForProgression respects tier maximums", () => {
  const candidates = Array.from({ length: 20 }, (_, i) =>
    makeTieredCandidate("intermediate", 0, 20 - i),
  );

  const quotas = [{ tier: "intermediate" as Difficulty, min: 1, max: 3, weight: 1.0 }];
  const selected = selectForProgression(candidates, 10, quotas);
  assert.ok(selected.length <= 3, `should respect max of 3, got ${selected.length}`);
});

// ---------------------------------------------------------------------------
// Item 20 tests
// ---------------------------------------------------------------------------

test("validateQuotaQualitySeparation passes with default gates", () => {
  const result = validateQuotaQualitySeparation(DEFAULT_FORGE_CONFIG);
  assert.ok(result.valid, `default config should pass, violations: ${result.violations}`);
});

test("validateQuotaQualitySeparation catches weakened push gate", () => {
  const weakConfig = {
    ...DEFAULT_FORGE_CONFIG,
    gates: { ...DEFAULT_FORGE_GATES, minSolutionPushes: 1 },
  };
  const result = validateQuotaQualitySeparation(weakConfig);
  assert.ok(!result.valid, "weakened gate should be caught");
  assert.ok(result.violations.some((v) => v.includes("minSolutionPushes")));
});

test("validateQuotaQualitySeparation catches relaxed walk ratio", () => {
  const weakConfig = {
    ...DEFAULT_FORGE_CONFIG,
    gates: { ...DEFAULT_FORGE_GATES, maxEmptyWalkRatio: 0.99 },
  };
  const result = validateQuotaQualitySeparation(weakConfig);
  assert.ok(!result.valid, "relaxed walk ratio should be caught");
  assert.ok(result.violations.some((v) => v.includes("maxEmptyWalkRatio")));
});

test("validateQuotaQualitySeparation accepts stricter gates", () => {
  const strictConfig = {
    ...DEFAULT_FORGE_CONFIG,
    gates: { ...DEFAULT_FORGE_GATES, minSolutionPushes: 8, maxEmptyWalkRatio: 0.5 },
  };
  const result = validateQuotaQualitySeparation(strictConfig);
  assert.ok(result.valid, `stricter gates should pass, violations: ${result.violations}`);
});
