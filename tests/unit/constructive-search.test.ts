import assert from "node:assert/strict";
import { test } from "node:test";
import { participationProgress, serializableStart, reverseDepthForSeed, type PullRecord } from "../../src/features/generator/v2/reverse-beam-search.ts";
import type { SolvedTemplate } from "../../src/features/generator/generator-types.ts";
import { TIER_CONFIGS } from "../../scripts/lib/generator-tier-config.ts";
import { generateBlueprintCandidate } from "../../src/features/generator/v2/puzzle-forge.ts";
import { placeGoalsWithMotif } from "../../src/features/generator/v2/motifs.ts";

test("participation guidance saturates at two pulls per box", () => {
  const pull = (boxIndex: number): PullRecord => ({ boxIndex, from: {row: 1, column: 1}, to: {row: 1, column: 2},
    robotFrom: {row: 1, column: 2}, robotTo: {row: 1, column: 3} });
  assert.equal(participationProgress(Array.from({ length: 100 }, () => pull(0)), 3), 2);
  assert.equal(participationProgress([pull(0), pull(1), pull(2)], 3), 3);
  assert.equal(participationProgress([pull(9)], 3), 0);
});

test("the depth portfolio is deterministic, bounded, and preserves fixed-depth legacy profiles", () => {
  const profile = TIER_CONFIGS.find(t => t.difficulty === "master")!.config.reverseSearchProfile!;
  const depths = Array.from({ length: 100 }, (_, seed) => reverseDepthForSeed(profile, seed));
  assert.deepEqual([...new Set(depths)].sort((a, b) => a - b), [90, 130, 200]);
  assert.deepEqual(depths, Array.from({ length: 100 }, (_, seed) => reverseDepthForSeed(profile, seed)));
  assert.equal(reverseDepthForSeed({ ...profile, depthFractions: undefined }, 42), 200);
  assert.throws(() => reverseDepthForSeed({ ...profile, depthFractions: [] }, 42), /fractions/);
  assert.throws(() => reverseDepthForSeed({ ...profile, depthFractions: [1.1] }, 42), /fractions/);
});

test("row-format start selection rejects hidden goals without changing game rules", () => {
  const template: SolvedTemplate = { width: 6, height: 3, grid: [Array.from("OOOOOO"), Array.from("O    O"), Array.from("OOOOOO")],
    goalPositions: [{row:1, column:1}], robotPosition: {row:1,column:3} };
  assert.equal(serializableStart(template, {boxPositions:[{row:1,column:1}],robotPosition:{row:1,column:3}}), false);
  assert.equal(serializableStart(template, {boxPositions:[{row:1,column:2}],robotPosition:{row:1,column:1}}), false);
  assert.equal(serializableStart(template, {boxPositions:[{row:1,column:2}],robotPosition:{row:1,column:3}}), true);
});

test("a scalable motif preserves its real anchors and allocates all eighteen distinct goals", () => {
  const config = { ...TIER_CONFIGS.find(t => t.difficulty === "master")!.config, goalPlacementAttempts: 3 };
  const bp = generateBlueprintCandidate(config, 350057, "branch", 18, "plain", "master");
  assert.ok(bp.ok);
  const params = { seed: 350057, boxCount: 18, motif: "doorway-traffic" as const };
  assert.equal(placeGoalsWithMotif(bp.candidate.blueprint, params), null);
  const expanded = placeGoalsWithMotif(bp.candidate.blueprint, { ...params, scalable: true });
  assert.ok(expanded);
  assert.equal(expanded.solved.goals.length, 18);
  assert.equal(new Set(expanded.solved.goals.map(g => `${g.row},${g.column}`)).size, 18);
  assert.ok(expanded.hints.length > 0);
  assert.ok(expanded.solved.goals.every(g => Number.isInteger(g.roomId)));
});
