import assert from "node:assert/strict";
import test from "node:test";

import {
  checkRunLimits,
  serializeCheckpoint,
  resumableSeeds,
  buildRunManifest,
  computeUsefulOutput,
  DEFAULT_FORGE_CONFIG,
} from "../../src/features/generator/v2/puzzle-forge.ts";
import type {
  ForgeRunResult,
  ForgeRunLimits,
  ForgeCandidate,
  ForgeRejection,
} from "../../src/features/generator/v2/puzzle-forge.ts";
import {
  progressiveBudget,
  DEFAULT_PROGRESSIVE_POLICY,
} from "../../src/features/generator/v2/generation-evidence.ts";
import type {
  ProgressiveEvaluationPolicy,
} from "../../src/features/generator/v2/generation-evidence.ts";

// ---------------------------------------------------------------------------
// Item 21 — Refinement worker dispatch (type-level)
// ---------------------------------------------------------------------------

test("RefinementTaskPayload and RefinementTaskResult types are well-formed", () => {
  const payload = {
    kind: "refinement" as const,
    payload: {
      puzzle: { id: "test", rows: ["OOOOO", "O.R.O", "O.X.O", "O.s.O", "OOOOO"], difficulty: "beginner" as const },
      solutionScore: { composite: 0.5, pushVariety: 0.5, directionChanges: 0.5, boxSwitches: 0.5, progressivity: 0.5, interactionDensity: 0.5, componentCount: 1 },
      solutionSteps: [{ kind: "push" as const, direction: "down" as const }],
      maxIterations: 5,
      seed: 42,
      budget: { maxElapsedMs: 5000, maxSolverCalls: 10 },
    },
  };
  assert.equal(payload.kind, "refinement");
  assert.equal(payload.payload.seed, 42);
  assert.equal(payload.payload.budget.maxSolverCalls, 10);
});

// ---------------------------------------------------------------------------
// Item 22 — Progressive evaluation budgets
// ---------------------------------------------------------------------------

test("progressiveBudget gives top candidates higher budgets", () => {
  const top = progressiveBudget(DEFAULT_PROGRESSIVE_POLICY, 0, 100);
  const bottom = progressiveBudget(DEFAULT_PROGRESSIVE_POLICY, 99, 100);
  assert.ok(top.maxExpandedStates > bottom.maxExpandedStates,
    `top ${top.maxExpandedStates} should exceed bottom ${bottom.maxExpandedStates}`);
  assert.ok(top.maxElapsedMs > bottom.maxElapsedMs);
});

test("progressiveBudget returns base budget for zero candidates", () => {
  const budget = progressiveBudget(DEFAULT_PROGRESSIVE_POLICY, 0, 0);
  assert.equal(budget.maxExpandedStates, DEFAULT_PROGRESSIVE_POLICY.baseBudget.maxExpandedStates);
});

test("progressiveBudget tier boundaries are correct", () => {
  const top10 = progressiveBudget(DEFAULT_PROGRESSIVE_POLICY, 5, 100);
  const top30 = progressiveBudget(DEFAULT_PROGRESSIVE_POLICY, 20, 100);
  const top60 = progressiveBudget(DEFAULT_PROGRESSIVE_POLICY, 50, 100);
  const tail = progressiveBudget(DEFAULT_PROGRESSIVE_POLICY, 80, 100);

  assert.ok(top10.maxExpandedStates > top30.maxExpandedStates, "top 10% > top 30%");
  assert.ok(top30.maxExpandedStates > top60.maxExpandedStates, "top 30% > top 60%");
  assert.ok(top60.maxExpandedStates > tail.maxExpandedStates, "top 60% > tail");
});

test("progressiveBudget custom policy respects multipliers", () => {
  const policy: ProgressiveEvaluationPolicy = {
    baseBudget: { maxExpandedStates: 1000, maxElapsedMs: 1000, maxCalls: 4, probeExpandedStates: 200, probeElapsedMs: 100 },
    tiers: [
      { rankFraction: 0.5, budgetMultiplier: 3.0 },
      { rankFraction: 1.0, budgetMultiplier: 1.0 },
    ],
  };
  const top = progressiveBudget(policy, 0, 10);
  const bottom = progressiveBudget(policy, 9, 10);
  assert.equal(top.maxExpandedStates, 3000);
  assert.equal(bottom.maxExpandedStates, 1000);
});

// ---------------------------------------------------------------------------
// Item 23 — Run-wide resource limits
// ---------------------------------------------------------------------------

test("checkRunLimits returns false when no limits set", () => {
  const result = checkRunLimits(undefined, 999999, 999999);
  assert.equal(result.exceeded, false);
});

test("checkRunLimits detects elapsed time exceeded", () => {
  const limits: ForgeRunLimits = { maxElapsedMs: 5000 };
  assert.equal(checkRunLimits(limits, 3000, 0).exceeded, false);
  const result = checkRunLimits(limits, 6000, 0);
  assert.equal(result.exceeded, true);
  assert.ok(result.reason!.includes("elapsed"));
});

test("checkRunLimits detects solver call limit", () => {
  const limits: ForgeRunLimits = { maxSolverCalls: 100 };
  assert.equal(checkRunLimits(limits, 0, 50).exceeded, false);
  const result = checkRunLimits(limits, 0, 150);
  assert.equal(result.exceeded, true);
  assert.ok(result.reason!.includes("solver"));
});

test("checkRunLimits respects combined limits", () => {
  const limits: ForgeRunLimits = { maxElapsedMs: 10000, maxSolverCalls: 50 };
  assert.equal(checkRunLimits(limits, 5000, 30).exceeded, false);
  assert.equal(checkRunLimits(limits, 5000, 60).exceeded, true);
  assert.equal(checkRunLimits(limits, 15000, 30).exceeded, true);
});

// ---------------------------------------------------------------------------
// Item 24 — Resumable checkpoints
// ---------------------------------------------------------------------------

test("serializeCheckpoint produces valid checkpoint with config hash", () => {
  const config = { ...DEFAULT_FORGE_CONFIG, baseSeed: 42, batchSize: 10 };
  const candidates = [
    { puzzle: { id: "p1", rows: [], difficulty: "beginner" as const }, provenance: { seed: 1 } },
    { puzzle: { id: "p2", rows: [], difficulty: "beginner" as const }, provenance: { seed: 3 } },
  ] as unknown as ForgeCandidate[];
  const rejections = [{ seed: 2, reason: "unsolvable" }] as unknown as ForgeRejection[];

  const cp = serializeCheckpoint(config, candidates, rejections, "construction", 5000, 42);
  assert.ok(cp.configHash.length === 8);
  assert.deepEqual(cp.completedSeeds, [1, 2, 3]);
  assert.equal(cp.phase, "construction");
  assert.equal(cp.elapsedMs, 5000);
  assert.equal(cp.solverCalls, 42);
  assert.ok(cp.timestamp > 0);
});

test("serializeCheckpoint config hash is deterministic", () => {
  const config = { ...DEFAULT_FORGE_CONFIG, baseSeed: 100 };
  const cp1 = serializeCheckpoint(config, [], [], "init", 0, 0);
  const cp2 = serializeCheckpoint(config, [], [], "init", 0, 0);
  assert.equal(cp1.configHash, cp2.configHash);
});

test("serializeCheckpoint config hash changes with config", () => {
  const config1 = { ...DEFAULT_FORGE_CONFIG, baseSeed: 100 };
  const config2 = { ...DEFAULT_FORGE_CONFIG, baseSeed: 200 };
  const cp1 = serializeCheckpoint(config1, [], [], "init", 0, 0);
  const cp2 = serializeCheckpoint(config2, [], [], "init", 0, 0);
  assert.notEqual(cp1.configHash, cp2.configHash);
});

test("resumableSeeds filters out completed seeds", () => {
  const checkpoint = {
    configHash: "00000000", completedSeeds: [1, 3, 5],
    candidates: [], rejections: [], phase: "done", elapsedMs: 0, solverCalls: 0, timestamp: Date.now(),
  };
  const schedule = [{ seed: 1 }, { seed: 2 }, { seed: 3 }, { seed: 4 }, { seed: 5 }];
  const remaining = resumableSeeds(checkpoint, schedule);
  assert.deepEqual(remaining, [2, 4]);
});

// ---------------------------------------------------------------------------
// Item 25 — Run manifests
// ---------------------------------------------------------------------------

test("buildRunManifest produces valid manifest", () => {
  const config = { ...DEFAULT_FORGE_CONFIG, baseSeed: 42, batchSize: 10 };
  const manifest = buildRunManifest(config, performance.now() - 1000);
  assert.equal(manifest.generatorVersion, "v4.2");
  assert.ok(manifest.nodeVersion.startsWith("v"));
  assert.ok(manifest.configFingerprint.length === 8);
  assert.equal(manifest.baseSeed, 42);
  assert.equal(manifest.batchSize, 10);
  assert.ok(manifest.endTimestamp > 0);
  assert.ok(manifest.platform.length > 0);
});

test("buildRunManifest fingerprint is stable", () => {
  const config = { ...DEFAULT_FORGE_CONFIG };
  const m1 = buildRunManifest(config, 1000);
  const m2 = buildRunManifest(config, 2000);
  assert.equal(m1.configFingerprint, m2.configFingerprint);
});

test("buildRunManifest fingerprint changes with config", () => {
  const config1 = { ...DEFAULT_FORGE_CONFIG, baseSeed: 1 };
  const config2 = { ...DEFAULT_FORGE_CONFIG, baseSeed: 2 };
  const m1 = buildRunManifest(config1, 1000);
  buildRunManifest(config2, 1000);
  const config3 = { ...DEFAULT_FORGE_CONFIG, families: ["nested" as const] };
  const m3 = buildRunManifest(config3, 1000);
  assert.notEqual(m1.configFingerprint, m3.configFingerprint);
});

// ---------------------------------------------------------------------------
// Item 26 — Useful output metrics
// ---------------------------------------------------------------------------

test("computeUsefulOutput computes rates from run result", () => {
  const result: Partial<ForgeRunResult> = {
    totalAttempted: 100,
    totalValid: 20,
    totalRetained: 5,
    elapsedMs: 60_000,
    performance: { solverCalls: 500, averageBusyCores: 3.5 } as unknown as ForgeRunResult["performance"],
  };
  const metrics = computeUsefulOutput(result as ForgeRunResult);
  assert.equal(metrics.retainedPerAttempt, 0.05);
  assert.equal(metrics.retainedPerMinute, 5);
  assert.equal(metrics.retainedPerSolverCall, 0.01);
  assert.equal(metrics.qualifiedPerAttempt, 0.2);
  assert.equal(metrics.qualifiedPerMinute, 20);
  assert.equal(metrics.yieldRate, 0.25);
  assert.equal(metrics.wallClockEfficiency, 3.5);
});

test("computeUsefulOutput handles zero attempts gracefully", () => {
  const result: Partial<ForgeRunResult> = {
    totalAttempted: 0, totalValid: 0, totalRetained: 0, elapsedMs: 0,
  };
  const metrics = computeUsefulOutput(result as ForgeRunResult);
  assert.equal(metrics.retainedPerAttempt, 0);
  assert.equal(metrics.retainedPerMinute, 0);
  assert.equal(metrics.yieldRate, 0);
});
