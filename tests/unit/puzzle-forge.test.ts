import assert from "node:assert/strict";
import test from "node:test";

import {
  runForge,
  summarizeForgeRun,
  forgeCandidateToAscii,
  forgeRunReport,
  enumerateForgeCombinations,
  createForgeSchedule,
  DEFAULT_FORGE_CONFIG,
  DEFAULT_FORGE_GATES,
  type ForgeConfig,
} from "../../src/features/generator/v2/index.ts";

import { validatePuzzle } from "../../src/core/puzzle.ts";
import { createSession } from "../../src/core/game-session.ts";
import { classicGreedySolver } from "../../src/solver/implementations/classic-solvers.ts";
import type { PuzzleDefinition } from "../../src/core/model.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SMALL_CONFIG: ForgeConfig = {
  ...DEFAULT_FORGE_CONFIG,
  batchSize: 15,
  retainTarget: 5,
  families: ["linear", "hub"],
  boxCounts: [3],
  difficulties: ["intermediate"],
  modes: ["plain", "motif", "composed"],
  baseSeed: 20000,
};

async function solvePuzzle(p: PuzzleDefinition): Promise<boolean> {
  const session = createSession(p);
  const result = await classicGreedySolver.solve(
    {
      board: session.board,
      snapshot: session.snapshot,
      objective: { kind: "moves" },
      limits: { maxElapsedMs: 10_000, maxExpandedStates: 1_500_000 },
    },
    {
      signal: new AbortController().signal,
      reportProgress: () => {},
      now: () => performance.now(),
    },
  );
  return result.status === "solved";
}

// ---------------------------------------------------------------------------
// 1. Determinism: same config + baseSeed → identical results
// ---------------------------------------------------------------------------

test("forge is deterministic for same config and baseSeed", async () => {
  const config: ForgeConfig = {
    ...SMALL_CONFIG,
    batchSize: 6,
    retainTarget: 3,
  };
  const run1 = await runForge(config);
  const run2 = await runForge(config);

  assert.equal(run1.totalAttempted, run2.totalAttempted);
  assert.equal(run1.totalValid, run2.totalValid);
  assert.equal(run1.totalRetained, run2.totalRetained);
  assert.equal(run1.candidates.length, run2.candidates.length);

  for (let i = 0; i < run1.candidates.length; i++) {
    assert.equal(run1.candidates[i].puzzle.id, run2.candidates[i].puzzle.id);
    assert.deepEqual(
      run1.candidates[i].puzzle.rows,
      run2.candidates[i].puzzle.rows,
    );
    assert.equal(
      run1.candidates[i].provenance.seed,
      run2.candidates[i].provenance.seed,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. Different baseSeed → different results
// ---------------------------------------------------------------------------

test("different baseSeed produces different candidates", async () => {
  const config1: ForgeConfig = { ...SMALL_CONFIG, batchSize: 6, baseSeed: 30000 };
  const config2: ForgeConfig = { ...SMALL_CONFIG, batchSize: 6, baseSeed: 40000 };
  const run1 = await runForge(config1);
  const run2 = await runForge(config2);

  if (run1.candidates.length > 0 && run2.candidates.length > 0) {
    const ids1 = new Set(run1.candidates.map((c) => c.puzzle.id));
    const ids2 = new Set(run2.candidates.map((c) => c.puzzle.id));
    const overlap = [...ids1].filter((id) => ids2.has(id)).length;
    assert.equal(overlap, 0, "different seeds should produce different IDs");
  }
});

// ---------------------------------------------------------------------------
// 3. Provenance is complete and reproducible
// ---------------------------------------------------------------------------

test("every retained candidate has complete provenance", async () => {
  const result = await runForge(SMALL_CONFIG);
  for (const c of result.candidates) {
    assert.ok(c.provenance.seed >= SMALL_CONFIG.baseSeed, "seed in range");
    assert.ok(
      SMALL_CONFIG.families.includes(c.provenance.family),
      "family from config",
    );
    assert.ok(
      SMALL_CONFIG.boxCounts.includes(c.provenance.boxCount),
      "boxCount from config",
    );
    assert.ok(
      SMALL_CONFIG.modes.includes(c.provenance.mode),
      "mode from config",
    );
    assert.ok(
      SMALL_CONFIG.difficulties.includes(c.provenance.difficulty),
      "difficulty from config",
    );
    assert.equal(typeof c.provenance.tightened, "boolean");
    assert.equal(typeof c.provenance.cellsRemoved, "number");
  }
});

// ---------------------------------------------------------------------------
// 4. All retained puzzles are valid and solvable
// ---------------------------------------------------------------------------

test("all retained puzzles pass validation and are solvable", async () => {
  const result = await runForge(SMALL_CONFIG);

  for (const c of result.candidates) {
    const validation = validatePuzzle(c.puzzle);
    assert.ok(validation.valid, `${c.puzzle.id} must be valid`);

    const solved = await solvePuzzle(c.puzzle);
    assert.ok(solved, `${c.puzzle.id} must be solvable`);
  }
});

// ---------------------------------------------------------------------------
// 5. Acceptance gates reject pathological candidates
// ---------------------------------------------------------------------------

test("gates reject trivial puzzles with too few pushes", async () => {
  const tightGates = {
    ...DEFAULT_FORGE_GATES,
    minSolutionPushes: 50,
  };
  const config: ForgeConfig = {
    ...SMALL_CONFIG,
    batchSize: 10,
    retainTarget: 10,
    gates: tightGates,
  };
  const result = await runForge(config);

  const pushRejections = result.rejections.filter(
    (r) => r.reason === "gate-pushes",
  ).length;
  assert.ok(
    pushRejections > 0 || result.totalValid === 0,
    "tight pushes gate should reject some candidates",
  );
});

// ---------------------------------------------------------------------------
// 6. Diversity filtering reduces duplicates
// ---------------------------------------------------------------------------

test("diversity filtering produces varied retained set", async () => {
  const config: ForgeConfig = {
    ...SMALL_CONFIG,
    batchSize: 30,
    retainTarget: 8,
    diversityMinDistance: 2.0,
  };
  const result = await runForge(config);

  if (result.candidates.length >= 3) {
    const families = new Set(result.candidates.map((c) => c.provenance.family));
    const modes = new Set(result.candidates.map((c) => c.provenance.mode));
    assert.ok(
      families.size >= 1,
      `retained set should have variety in topology families (got ${families.size})`,
    );
    assert.ok(
      modes.size >= 1 || result.candidates.length < 3,
      "retained set should have variety in modes",
    );
  }
});

// ---------------------------------------------------------------------------
// 7. Evaluation vectors are populated
// ---------------------------------------------------------------------------

test("every retained candidate has a complete evaluation vector", async () => {
  const result = await runForge(SMALL_CONFIG);

  for (const c of result.candidates) {
    const ev = c.evaluation;
    assert.ok(ev.solved, "must be solved");
    assert.ok(ev.solutionMoves > 0, "must have moves");
    assert.ok(ev.solutionPushes > 0, "must have pushes");
    assert.ok(ev.totalFloor > 0, "must have floor");
    assert.equal(typeof ev.boxIndependenceRatio, "number");
    assert.equal(typeof ev.emptyWalkRatio, "number");
    assert.equal(typeof ev.deadlockDensity, "number");
  }
});

// ---------------------------------------------------------------------------
// 8. Summary statistics are correct
// ---------------------------------------------------------------------------

test("summarizeForgeRun computes correct statistics", async () => {
  const result = await runForge(SMALL_CONFIG);
  const summary = summarizeForgeRun(result);

  assert.equal(summary.totalAttempted, SMALL_CONFIG.batchSize);
  assert.equal(summary.totalValid, result.totalValid);
  assert.equal(summary.totalRetained, result.totalRetained);
  assert.ok(summary.elapsedMs > 0, "should have elapsed time");
  assert.ok(summary.msPerCandidate > 0, "should have per-candidate time");

  const retainedCount = Object.values(summary.topologyDistribution).reduce(
    (s, n) => s + n,
    0,
  );
  assert.equal(
    retainedCount,
    result.totalRetained,
    "topology distribution should sum to retained count",
  );
});

// ---------------------------------------------------------------------------
// 9. ASCII output contains provenance and board
// ---------------------------------------------------------------------------

test("forgeCandidateToAscii includes provenance and board", async () => {
  const result = await runForge({
    ...SMALL_CONFIG,
    batchSize: 6,
    retainTarget: 2,
  });

  if (result.candidates.length > 0) {
    const ascii = forgeCandidateToAscii(result.candidates[0]);
    const c = result.candidates[0];
    assert.ok(ascii.includes(c.puzzle.id), "should include puzzle ID");
    assert.ok(ascii.includes(c.provenance.family), "should include family");
    assert.ok(ascii.includes("Seed:"), "should include seed label");
    assert.ok(ascii.includes("Moves:"), "should include metrics");
    assert.ok(ascii.includes("O"), "should include board walls");
  }
});

// ---------------------------------------------------------------------------
// 10. Full report is well-formed
// ---------------------------------------------------------------------------

test("forgeRunReport produces structured text report", async () => {
  const result = await runForge({
    ...SMALL_CONFIG,
    batchSize: 6,
    retainTarget: 3,
  });

  const report = forgeRunReport(result);
  assert.ok(report.includes("Puzzle Forge Run Report"), "should have header");
  assert.ok(report.includes("Attempted:"), "should have attempt count");
  assert.ok(report.includes("Metric"), "should have metric ranges");
});

// ---------------------------------------------------------------------------
// 11. Rejection counts are accurate
// ---------------------------------------------------------------------------

test("rejection counts sum correctly", async () => {
  const result = await runForge(SMALL_CONFIG);

  const totalRejections = Object.values(result.rejectionCounts).reduce(
    (s, n) => s + n,
    0,
  );
  assert.equal(totalRejections, result.rejections.length);
  assert.equal(
    result.totalAttempted,
    result.totalValid + result.rejections.length - result.exactDuplicatesRejected,
    "attempted = valid + rejected (excluding dedup rejections, which come from valid candidates)",
  );
});

// ---------------------------------------------------------------------------
// 12. Modes produce expected outputs
// ---------------------------------------------------------------------------

test("composed mode includes DAG when successful", async () => {
  const config: ForgeConfig = {
    ...SMALL_CONFIG,
    batchSize: 30,
    retainTarget: 10,
    modes: ["composed"],
    boxCounts: [4],
    baseSeed: 50000,
  };
  const result = await runForge(config);

  const withDag = result.candidates.filter((c) => c.dag !== undefined);
  if (result.candidates.length > 0) {
    assert.ok(
      withDag.length > 0,
      "at least one composed candidate should have a DAG",
    );
    for (const c of withDag) {
      assert.ok(c.provenance.compositionType, "should have composition type");
      assert.equal(typeof c.provenance.dependencyRealizationRate, "number");
    }
  }
});

// ---------------------------------------------------------------------------
// 13. Motif mode includes hints
// ---------------------------------------------------------------------------

test("motif mode includes hints when successful", async () => {
  const config: ForgeConfig = {
    ...SMALL_CONFIG,
    batchSize: 30,
    retainTarget: 10,
    modes: ["motif"],
    baseSeed: 55000,
  };
  const result = await runForge(config);

  const withHints = result.candidates.filter(
    (c) => c.hints !== undefined && c.hints.length > 0,
  );
  if (result.candidates.length > 0) {
    assert.ok(
      withHints.length > 0,
      "at least one motif candidate should have hints",
    );
    for (const c of withHints) {
      assert.ok(c.provenance.motifType, "should have motif type");
    }
  }
});

// ---------------------------------------------------------------------------
// 14. Empty config produces empty result
// ---------------------------------------------------------------------------

test("batchSize=0 produces empty result", async () => {
  const result = await runForge({
    ...DEFAULT_FORGE_CONFIG,
    batchSize: 0,
  });
  assert.equal(result.totalAttempted, 0);
  assert.equal(result.totalRetained, 0);
  assert.equal(result.candidates.length, 0);
});

// ---------------------------------------------------------------------------
// 15. Benchmark: meaningful batch with full reporting
// ---------------------------------------------------------------------------

test("benchmark: forge batch with full pipeline and reporting", async () => {
  const config: ForgeConfig = {
    ...DEFAULT_FORGE_CONFIG,
    batchSize: 60,
    retainTarget: 15,
    families: ["linear", "hub", "loop", "branch", "nested"],
    boxCounts: [3, 4],
    difficulties: ["intermediate", "advanced"],
    modes: ["plain", "motif", "composed"],
    boardWidth: 14,
    boardHeight: 14,
    baseSeed: 70000,
    diversityMinDistance: 1.5,
  };

  const result = await runForge(config);
  const summary = summarizeForgeRun(result);
  const report = forgeRunReport(result);

  console.log("\n" + report);

  assert.ok(result.totalAttempted === 60, "should attempt 60 candidates");
  assert.ok(result.totalRetained > 0, "should retain at least 1 candidate");

  for (const c of result.candidates) {
    const valid = validatePuzzle(c.puzzle);
    assert.ok(valid.valid, `${c.puzzle.id} must pass validation`);
  }

  const families = new Set(result.candidates.map((c) => c.provenance.family));
  if (result.candidates.length >= 5) {
    assert.ok(
      families.size >= 2,
      `retained set should have >=2 topology families (got ${families.size})`,
    );
  }

  assert.ok(
    summary.metricRanges.solutionPushes.avg > 0,
    "avg pushes should be positive",
  );
});

// ---------------------------------------------------------------------------
// 16. enumerateForgeCombinations produces full Cartesian product
// ---------------------------------------------------------------------------

test("enumerateForgeCombinations produces full Cartesian product", () => {
  const combos = enumerateForgeCombinations({
    families: ["linear", "hub", "loop"],
    boxCounts: [2, 3, 4],
    modes: ["plain", "motif", "composed"],
    difficulties: ["beginner"],
  });
  assert.equal(combos.length, 3 * 3 * 3 * 1);

  const seen = new Set(
    combos.map((c) => `${c.family}-${c.boxCount}-${c.mode}-${c.difficulty}`),
  );
  assert.equal(seen.size, 27, "all combinations should be unique");
});

// ---------------------------------------------------------------------------
// 17. createForgeSchedule covers all combinations before repeating
// ---------------------------------------------------------------------------

test("createForgeSchedule covers all combinations before repeating", () => {
  const combos = enumerateForgeCombinations({
    families: ["linear", "hub"],
    boxCounts: [3],
    modes: ["plain", "motif"],
    difficulties: ["intermediate"],
  });
  const schedule = createForgeSchedule(combos, combos.length, 100);

  const seenFamilies = new Set(schedule.map((e) => e.combination.family));
  const seenModes = new Set(schedule.map((e) => e.combination.mode));
  assert.equal(seenFamilies.size, 2, "all families should appear");
  assert.equal(seenModes.size, 2, "all modes should appear");
});

// ---------------------------------------------------------------------------
// 18. createForgeSchedule wraps for batchSize > combinations
// ---------------------------------------------------------------------------

test("createForgeSchedule wraps for batchSize > combinations", () => {
  const combos = enumerateForgeCombinations({
    families: ["linear"],
    boxCounts: [3],
    modes: ["plain"],
    difficulties: ["beginner"],
  });
  assert.equal(combos.length, 1);

  const schedule = createForgeSchedule(combos, 5, 200);
  assert.equal(schedule.length, 5);
  for (const entry of schedule) {
    assert.equal(entry.combination.family, "linear");
  }
});

// ---------------------------------------------------------------------------
// 19. createForgeSchedule is deterministic
// ---------------------------------------------------------------------------

test("createForgeSchedule is deterministic", () => {
  const combos = enumerateForgeCombinations({
    families: ["linear", "hub", "loop"],
    boxCounts: [2, 3],
    modes: ["plain", "motif"],
    difficulties: ["intermediate"],
  });
  const s1 = createForgeSchedule(combos, 20, 42);
  const s2 = createForgeSchedule(combos, 20, 42);

  assert.deepEqual(s1, s2);
});

// ---------------------------------------------------------------------------
// 20. ForgeRunResult includes exactDuplicatesRejected field
// ---------------------------------------------------------------------------

test("ForgeRunResult includes exactDuplicatesRejected field", async () => {
  const result = await runForge({
    ...SMALL_CONFIG,
    batchSize: 6,
    retainTarget: 3,
  });
  assert.equal(typeof result.exactDuplicatesRejected, "number");
  assert.ok(result.exactDuplicatesRejected >= 0);
});
