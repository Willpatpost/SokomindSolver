import assert from "node:assert/strict";
import test from "node:test";

import {
  enumerateForgeCombinations,
  createForgeSchedule,
  createAdaptiveForgeSchedule,
  combinationKey,
  computeSamplingWeights,
  buildRejectionHistory,
  mergeRejectionHistories,
} from "../../src/features/generator/v2/index.ts";
import type { RejectionHistory } from "../../src/features/generator/v2/index.ts";

const BASE_COMBOS = enumerateForgeCombinations({
  families: ["linear", "hub", "loop"],
  boxCounts: [3, 5],
  modes: ["plain", "motif"],
  difficulties: ["intermediate"],
});

// ---------------------------------------------------------------------------
// 1. combinationKey produces a stable canonical key
// ---------------------------------------------------------------------------

test("combinationKey produces stable canonical key", () => {
  const c = { family: "linear" as const, boxCount: 3, mode: "plain" as const, difficulty: "intermediate" as const };
  assert.equal(combinationKey(c), "linear:3:plain");
  assert.equal(combinationKey(c), combinationKey({ ...c }));
});

// ---------------------------------------------------------------------------
// 2. computeSamplingWeights returns 1.0 for unknown combinations
// ---------------------------------------------------------------------------

test("computeSamplingWeights returns 1.0 for combinations with no history", () => {
  const history = new Map();
  const weights = computeSamplingWeights(BASE_COMBOS, history);
  assert.equal(weights.length, BASE_COMBOS.length);
  for (const w of weights) assert.equal(w, 1.0);
});

// ---------------------------------------------------------------------------
// 3. computeSamplingWeights reduces weight for high-rejection combinations
// ---------------------------------------------------------------------------

test("computeSamplingWeights reduces weight for high-rejection combinations", () => {
  const history: RejectionHistory = new Map([
    ["linear:3:plain", { attempts: 10, rejections: 10, reasons: { unsolvable: 10 } }],
    ["hub:5:motif", { attempts: 10, rejections: 0, reasons: {} as Record<string, number> }],
  ]);
  const weights = computeSamplingWeights(BASE_COMBOS, history);

  const linearPlain3Idx = BASE_COMBOS.findIndex(
    (c) => c.family === "linear" && c.boxCount === 3 && c.mode === "plain",
  );
  const hubMotif5Idx = BASE_COMBOS.findIndex(
    (c) => c.family === "hub" && c.boxCount === 5 && c.mode === "motif",
  );

  assert.ok(weights[linearPlain3Idx] < 0.3, `100% rejection should yield low weight, got ${weights[linearPlain3Idx]}`);
  assert.equal(weights[hubMotif5Idx], 1.0, "0% rejection should yield full weight");
  assert.ok(weights[linearPlain3Idx] >= 0.1, "weight should not go below minimum");
});

// ---------------------------------------------------------------------------
// 4. buildRejectionHistory tallies per-combination rejections
// ---------------------------------------------------------------------------

test("buildRejectionHistory tallies per-combination rejections", () => {
  const combos = enumerateForgeCombinations({
    families: ["linear", "hub"],
    boxCounts: [3],
    modes: ["plain"],
    difficulties: ["beginner"],
  });
  const schedule = createForgeSchedule(combos, 6, 100);
  const rejections = [
    { seed: schedule[0].seed, reason: "unsolvable" },
    { seed: schedule[1].seed, reason: "blueprint-failed" },
    { seed: schedule[2].seed, reason: "unsolvable" },
  ];

  const history = buildRejectionHistory(schedule, rejections);
  let totalAttempts = 0;
  let totalRejections = 0;
  for (const [, record] of history) {
    totalAttempts += record.attempts;
    totalRejections += record.rejections;
  }
  assert.equal(totalAttempts, 6);
  assert.equal(totalRejections, 3);
});

// ---------------------------------------------------------------------------
// 5. mergeRejectionHistories combines multiple runs
// ---------------------------------------------------------------------------

test("mergeRejectionHistories combines multiple runs", () => {
  const h1: RejectionHistory = new Map([
    ["linear:3:plain", { attempts: 5, rejections: 3, reasons: { unsolvable: 3 } }],
  ]);
  const h2: RejectionHistory = new Map([
    ["linear:3:plain", { attempts: 5, rejections: 2, reasons: { unsolvable: 1, "blueprint-failed": 1 } }],
    ["hub:5:motif", { attempts: 3, rejections: 0, reasons: {} as Record<string, number> }],
  ]);
  const merged = mergeRejectionHistories(h1, h2);

  const linearRec = merged.get("linear:3:plain")!;
  assert.equal(linearRec.attempts, 10);
  assert.equal(linearRec.rejections, 5);
  assert.equal(linearRec.reasons["unsolvable"], 4);
  assert.equal(linearRec.reasons["blueprint-failed"], 1);

  const hubRec = merged.get("hub:5:motif")!;
  assert.equal(hubRec.attempts, 3);
  assert.equal(hubRec.rejections, 0);
});

// ---------------------------------------------------------------------------
// 6. createAdaptiveForgeSchedule biases toward successful combinations
// ---------------------------------------------------------------------------

test("createAdaptiveForgeSchedule biases toward successful combinations", () => {
  const combos = enumerateForgeCombinations({
    families: ["linear", "hub"],
    boxCounts: [3],
    modes: ["plain"],
    difficulties: ["beginner"],
  });

  const history: RejectionHistory = new Map([
    ["linear:3:plain", { attempts: 100, rejections: 100, reasons: { unsolvable: 100 } }],
    ["hub:3:plain", { attempts: 100, rejections: 0, reasons: {} as Record<string, number> }],
  ]);

  const schedule = createAdaptiveForgeSchedule(combos, 200, 42, history);
  assert.equal(schedule.length, 200);

  let hubCount = 0;
  for (const e of schedule) {
    if (e.combination.family === "hub") hubCount++;
  }

  assert.ok(hubCount > 100, `hub (0% rejection) should dominate, got ${hubCount}/200`);
  assert.ok(hubCount < 200, "linear should still appear at minimum weight");
});

// ---------------------------------------------------------------------------
// 7. createAdaptiveForgeSchedule is deterministic
// ---------------------------------------------------------------------------

test("createAdaptiveForgeSchedule is deterministic", () => {
  const history = new Map([
    ["linear:3:plain", { attempts: 10, rejections: 8, reasons: { unsolvable: 8 } }],
  ]);

  const s1 = createAdaptiveForgeSchedule(BASE_COMBOS, 50, 42, history);
  const s2 = createAdaptiveForgeSchedule(BASE_COMBOS, 50, 42, history);
  assert.deepEqual(s1, s2);
});

// ---------------------------------------------------------------------------
// 8. createAdaptiveForgeSchedule falls back to uniform with empty history
// ---------------------------------------------------------------------------

test("createAdaptiveForgeSchedule with empty history matches uniform distribution", () => {
  const combos = enumerateForgeCombinations({
    families: ["linear", "hub"],
    boxCounts: [3],
    modes: ["plain"],
    difficulties: ["beginner"],
  });
  const emptyHistory = new Map();

  const adaptive = createAdaptiveForgeSchedule(combos, 100, 42, emptyHistory);
  assert.equal(adaptive.length, 100);

  let linearCount = 0;
  for (const e of adaptive) {
    if (e.combination.family === "linear") linearCount++;
  }
  assert.ok(linearCount > 30 && linearCount < 70, `should be roughly uniform, got linear=${linearCount}/100`);
});
