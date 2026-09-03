import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ForgeWorkerPool } from "../../src/features/generator/v2/forge-pool.ts";
import { runForge, generateBlueprintCandidate, generateRawCandidate, completeCandidateFromBlueprint,
  reverseAlternatives, type ForgeConfig, type CompletionResult } from "../../src/features/generator/v2/puzzle-forge.ts";
import { replayWitness } from "../../src/features/generator/v2/generation-evidence.ts";
import { DEFAULT_FORGE_CONFIG } from "../../src/features/generator/v2/puzzle-forge.ts";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/generator/generated-quality-samples.json", import.meta.url), "utf8"));
const config: ForgeConfig = { ...fixture.config, baseSeed: 310049, boxCounts: [3], reverseCandidatesPerBlueprint: 4 };
const identity = (r: Awaited<ReturnType<typeof runForge>>) => ({
  candidates: r.candidates.map((c) => ({ id: c.puzzle.id, rows: c.puzzle.rows, steps: c.solutionSteps,
    quality: c.qualityProfile, typing: c.storyAwareTypingVerification })), rejections: r.rejections,
});

test("real successful candidates and rejected archive states agree at one and four workers", async () => {
  const one = await runForge(config, { workers: 1 });
  const four = await runForge({ ...config, batchSize: 2 }, { workers: 4 });
  const control = await runForge({ ...config, batchSize: 2 }, { workers: 1 });
  assert.ok(one.candidates.length > 0, JSON.stringify(one.rejectionCounts));
  assert.ok(four.candidates.length > 0, JSON.stringify(four.rejectionCounts));
  assert.deepEqual(identity(four), identity(control));
  assert.ok(four.performance!.pool.peakActive > 1);
  assert.ok(four.performance!.reverseVariantsEvaluated > four.totalAttempted);
  assert.equal(new Set(four.candidates.map((c) => c.puzzle.id)).size, four.candidates.length);
  for (const c of four.candidates) assert.ok(replayWitness(c.puzzle, c.solutionSteps!));
});

test("parallel forced reverse payload produces the same result as local completion", async () => {
  const bp = generateBlueprintCandidate(config, 310049, "linear", 3, "plain", "beginner");
  assert.ok(bp.ok);
  const generated = await generateRawCandidate(bp.candidate, config);
  assert.ok(generated.ok);
  assert.ok(generated.raw.witness && replayWitness(generated.raw.puzzle, generated.raw.witness));
  const forced = reverseAlternatives(bp.candidate, generated, 4)[0];
  assert.ok(forced);
  const local = await completeCandidateFromBlueprint(bp.candidate, config, forced);
  const pool = new ForgeWorkerPool(undefined, undefined, 2);
  try {
    const remote = await pool.submit<CompletionResult>({ kind: "complete", config, blueprint: bp.candidate, forcedReverseState: forced });
    assert.equal(remote.ok, local.ok);
    if (local.ok && remote.ok) {
      assert.deepEqual(remote.candidate.puzzle.rows, local.candidate.puzzle.rows);
      assert.deepEqual(remote.candidate.solutionSteps, local.candidate.solutionSteps);
    } else if (!local.ok && !remote.ok) assert.equal(remote.reason, local.reason);
  } finally { await pool.close(); }
});

test("a failed primary still evaluates its independent archive candidates", async () => {
  const rejected = await runForge({ ...config, gates: { ...config.gates, minSolutionPushes: 100000 } }, { workers: 2 });
  assert.equal(rejected.totalRetained, 0);
  assert.ok(rejected.performance!.reverseVariantsEvaluated >= 2);
  assert.equal(rejected.rejections.length, rejected.performance!.reverseVariantsEvaluated);
});

test("bounded goal-placement repair rescues a fixed failed construction without changing geometry", () => {
  const base = { ...DEFAULT_FORGE_CONFIG, boardWidth: 16, boardHeight: 16, goalPlacementAttempts: 1 };
  const first = generateBlueprintCandidate(base, 320022, "linear", 7, "plain", "intermediate");
  assert.ok(!first.ok);
  assert.equal(first.reason, "goal-placement-failed");
  const repaired = generateBlueprintCandidate({ ...base, goalPlacementAttempts: 3 }, 320022, "linear", 7, "plain", "intermediate");
  assert.ok(repaired.ok);
  assert.equal(repaired.candidate.goalPlacementSeed, 529480);
  assert.equal(repaired.candidate.seed, 320022);
  assert.equal(repaired.candidate.solvedBlueprint!.goals.length, 7);
  assert.equal(repaired.candidate.blueprint.boardWidth, 16);
  assert.equal(repaired.candidate.blueprint.boardHeight, 16);
});
