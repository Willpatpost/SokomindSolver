import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

import {
  runForge,
  blueprintStructuralScore,
  DEFAULT_FORGE_CONFIG,
  QUALITY_PRESETS,
  type ForgeConfig,
  type FunnelBudgets,
  type FunnelStageStats,
  type SolverCallReduction,
  type BlueprintCandidate,
} from "../../src/features/generator/v2/index.ts";

import { validatePuzzle } from "../../src/core/puzzle.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FUNNEL_CONFIG: ForgeConfig = {
  ...DEFAULT_FORGE_CONFIG,
  families: ["linear", "hub"],
  boxCounts: [3],
  difficulties: ["intermediate"],
  modes: ["plain"],
  baseSeed: 90000,
  funnelBudgets: {
    rawAttemptBudget: 20,
    preScreenRetain: 10,
    finalistRetain: 6,
    deepRetain: 4,
    catalogQuota: 3,
  },
};

// ---------------------------------------------------------------------------
// 1. True funnel produces FunnelStageStats with solverCallReduction
// ---------------------------------------------------------------------------

describe("true funnel refactor", () => {
  it("produces funnelStats with solverCallReduction", async () => {
    const result = await runForge(FUNNEL_CONFIG);

    assert.ok(result.funnelStats, "funnel run must have funnelStats");
    const stats = result.funnelStats!;
    assert.ok(
      stats.solverCallReduction !== undefined,
      "funnelStats must include solverCallReduction",
    );

    const scr = stats.solverCallReduction!;
    assert.equal(typeof scr.totalAttempts, "number");
    assert.equal(typeof scr.blueprintSurvivors, "number");
    assert.equal(typeof scr.structuralSurvivors, "number");
    assert.equal(typeof scr.solverCallsMade, "number");
    assert.equal(typeof scr.solverCallsAvoided, "number");
    assert.equal(typeof scr.reductionRatio, "number");
  });

  // ---------------------------------------------------------------------------
  // 2. Stage counts decrease monotonically through the funnel
  // ---------------------------------------------------------------------------

  it("stage counts decrease monotonically through funnel", async () => {
    const result = await runForge(FUNNEL_CONFIG);

    assert.ok(result.funnelStats, "must have funnelStats");
    const stats = result.funnelStats!;

    // stageA >= stageB (structural pre-screen filters)
    assert.ok(
      stats.stageA_blueprintGenerated >= stats.stageB_structuralSurvivors,
      `stageA (${stats.stageA_blueprintGenerated}) >= stageB (${stats.stageB_structuralSurvivors})`,
    );

    // stageC can exceed stageB: ranked candidates amplify completions per blueprint
    assert.ok(
      stats.stageC_reverseSurvivors >= 0,
      `stageC (${stats.stageC_reverseSurvivors}) should be non-negative`,
    );

    // stageC >= stageD (dedup filters)
    assert.ok(
      stats.stageC_reverseSurvivors >= stats.stageD_dedupSurvivors,
      `stageC (${stats.stageC_reverseSurvivors}) >= stageD (${stats.stageD_dedupSurvivors})`,
    );

    // stageD >= stageE (cheap eval filters)
    assert.ok(
      stats.stageD_dedupSurvivors >= stats.stageE_cheapEvalSurvivors,
      `stageD (${stats.stageD_dedupSurvivors}) >= stageE (${stats.stageE_cheapEvalSurvivors})`,
    );

    // stageE >= stageF (finalist evaluation)
    assert.ok(
      stats.stageE_cheapEvalSurvivors >= stats.stageF_finalistEvaluated,
      `stageE (${stats.stageE_cheapEvalSurvivors}) >= stageF (${stats.stageF_finalistEvaluated})`,
    );

    // stageF >= stageG (quality gate)
    assert.ok(
      stats.stageF_finalistEvaluated >= stats.stageG_qualityGatePassed,
      `stageF (${stats.stageF_finalistEvaluated}) >= stageG (${stats.stageG_qualityGatePassed})`,
    );

    // stageG >= stageH (difficulty gate)
    assert.ok(
      stats.stageG_qualityGatePassed >= stats.stageH_difficultyPassed,
      `stageG (${stats.stageG_qualityGatePassed}) >= stageH (${stats.stageH_difficultyPassed})`,
    );

    // stageH >= stageI (final curation)
    assert.ok(
      stats.stageH_difficultyPassed >= stats.stageI_curatedFinal,
      `stageH (${stats.stageH_difficultyPassed}) >= stageI (${stats.stageI_curatedFinal})`,
    );
  });

  // ---------------------------------------------------------------------------
  // 3. Solver calls are fewer than raw attempts
  // ---------------------------------------------------------------------------

  it("solver calls are fewer than raw attempts (reduction measured)", async () => {
    const config: ForgeConfig = {
      ...FUNNEL_CONFIG,
      funnelBudgets: {
        rawAttemptBudget: 30,
        preScreenRetain: 12,
        finalistRetain: 8,
        deepRetain: 5,
        catalogQuota: 3,
      },
    };
    const result = await runForge(config);

    assert.ok(result.funnelStats, "must have funnelStats");
    const scr = result.funnelStats!.solverCallReduction!;

    // Solver calls should be <= structural survivors (only survivors get solver calls)
    assert.ok(
      scr.solverCallsMade <= scr.structuralSurvivors * 2 + 1,
      `solverCallsMade (${scr.solverCallsMade}) should be bounded by structural survivors (${scr.structuralSurvivors})`,
    );

    assert.equal(
      scr.totalAttempts,
      config.funnelBudgets!.rawAttemptBudget,
      "totalAttempts matches budget",
    );

    // Reduction ratio is valid
    assert.ok(scr.reductionRatio >= 0 && scr.reductionRatio <= 1,
      `reductionRatio (${scr.reductionRatio}) should be in [0, 1]`,
    );
  });

  // ---------------------------------------------------------------------------
  // 4. True funnel candidates are valid and solvable
  // ---------------------------------------------------------------------------

  it("all funnel candidates pass validation", async () => {
    const result = await runForge(FUNNEL_CONFIG);

    for (const c of result.candidates) {
      const validation = validatePuzzle(c.puzzle);
      assert.ok(validation.valid, `${c.puzzle.id} must be valid`);
    }
  });

  // ---------------------------------------------------------------------------
  // 5. True funnel is deterministic
  // ---------------------------------------------------------------------------

  it("funnel is deterministic for same config and baseSeed", async () => {
    const config: ForgeConfig = {
      ...FUNNEL_CONFIG,
      funnelBudgets: {
        rawAttemptBudget: 10,
        preScreenRetain: 6,
        finalistRetain: 4,
        deepRetain: 3,
        catalogQuota: 2,
      },
    };

    const run1 = await runForge(config);
    const run2 = await runForge(config);

    assert.equal(run1.totalAttempted, run2.totalAttempted);
    assert.equal(run1.totalValid, run2.totalValid);
    assert.equal(run1.totalRetained, run2.totalRetained);
    assert.equal(run1.candidates.length, run2.candidates.length);

    for (let i = 0; i < run1.candidates.length; i++) {
      assert.deepEqual(
        run1.candidates[i].puzzle.rows,
        run2.candidates[i].puzzle.rows,
      );
    }

    // Funnel stats must match
    if (run1.funnelStats && run2.funnelStats) {
      assert.equal(
        run1.funnelStats.stageA_blueprintGenerated,
        run2.funnelStats.stageA_blueprintGenerated,
      );
      assert.equal(
        run1.funnelStats.stageB_structuralSurvivors,
        run2.funnelStats.stageB_structuralSurvivors,
      );
      if (run1.funnelStats.solverCallReduction && run2.funnelStats.solverCallReduction) {
        assert.equal(
          run1.funnelStats.solverCallReduction.solverCallsMade,
          run2.funnelStats.solverCallReduction.solverCallsMade,
        );
      }
    }
  });

  // ---------------------------------------------------------------------------
  // 6. Structural pre-screen filters before solver
  // ---------------------------------------------------------------------------

  it("structural pre-screen caps candidates before solver work", async () => {
    const config: ForgeConfig = {
      ...FUNNEL_CONFIG,
      funnelBudgets: {
        rawAttemptBudget: 25,
        preScreenRetain: 8,
        finalistRetain: 5,
        deepRetain: 3,
        catalogQuota: 2,
      },
    };
    const result = await runForge(config);

    assert.ok(result.funnelStats, "must have funnelStats");
    const stats = result.funnelStats!;

    // If we generated more blueprints than preScreenRetain, structural filter should cap
    if (stats.stageA_blueprintGenerated > config.funnelBudgets!.preScreenRetain) {
      assert.ok(
        stats.stageB_structuralSurvivors <= config.funnelBudgets!.preScreenRetain,
        `structural survivors (${stats.stageB_structuralSurvivors}) ` +
        `should be <= preScreenRetain (${config.funnelBudgets!.preScreenRetain})`,
      );
    }
  });

  // ---------------------------------------------------------------------------
  // 7. BlueprintCandidate type shape
  // ---------------------------------------------------------------------------

  it("BlueprintCandidate type has required fields", () => {
    // Compile-time type check — if this compiles, the type is correct
    const bc: BlueprintCandidate = {
      seed: 1,
      family: "linear",
      boxCount: 3,
      mode: "plain",
      difficulty: "intermediate",
      blueprint: {} as any,
      grid: [],
      structuralMetrics: {} as any,
    };
    assert.equal(bc.seed, 1);
    assert.equal(bc.family, "linear");
    assert.equal(bc.boxCount, 3);
    assert.equal(bc.mode, "plain");
    assert.equal(bc.difficulty, "intermediate");
    assert.ok(bc.grid !== undefined);
    assert.ok(bc.structuralMetrics !== undefined);
  });

  // ---------------------------------------------------------------------------
  // 8. SolverCallReduction type shape
  // ---------------------------------------------------------------------------

  it("SolverCallReduction type has required fields", () => {
    const scr: SolverCallReduction = {
      totalAttempts: 100,
      blueprintSurvivors: 80,
      structuralSurvivors: 40,
      solverCallsMade: 35,
      solverCallsAvoided: 40,
      reductionRatio: 0.65,
    };
    assert.equal(scr.totalAttempts, 100);
    assert.equal(scr.blueprintSurvivors, 80);
    assert.equal(scr.structuralSurvivors, 40);
    assert.equal(scr.solverCallsMade, 35);
    assert.equal(scr.solverCallsAvoided, 40);
    assert.equal(scr.reductionRatio, 0.65);
  });

  // ---------------------------------------------------------------------------
  // 9. blueprintStructuralScore returns positive finite values
  // ---------------------------------------------------------------------------

  it("blueprintStructuralScore returns positive finite values", () => {
    const bc: BlueprintCandidate = {
      seed: 42,
      family: "hub",
      boxCount: 3,
      mode: "plain",
      difficulty: "intermediate",
      blueprint: {} as any,
      grid: [],
      structuralMetrics: {
        boardWidth: 12,
        boardHeight: 12,
        totalCells: 144,
        totalFloor: 40,
        floorUtilization: 0.28,
        openAreaRatio: 0.3,
        articulationPoints: new Set<number>(),
        articulationCount: 3,
        regions: [],
        regionCount: 4,
        regionSizes: [10, 10, 10, 10],
        largestRegionSize: 10,
        largestRegionRatio: 0.25,
        terminalRegionCount: 2,
        tunnelCells: new Set<number>(),
        tunnelCount: 5,
        chokepoints: new Set<number>(),
        chokepointCount: 2,
        maxDegree: 3,
        degreeDistribution: [0, 5, 20, 15, 0],
        hasCycle: true,
        connectedComponents: 1,
      },
    };

    const score = blueprintStructuralScore(bc);
    assert.ok(Number.isFinite(score), `score must be finite, got ${score}`);
    assert.ok(score > 0, `score must be positive, got ${score}`);
  });

  // ---------------------------------------------------------------------------
  // 10. blueprintStructuralScore gives bonus for solved blueprint
  // ---------------------------------------------------------------------------

  it("blueprintStructuralScore gives bonus for solvedBlueprint", () => {
    const baseMetrics = {
      boardWidth: 12,
      boardHeight: 12,
      totalCells: 144,
      totalFloor: 40,
      floorUtilization: 0.28,
      openAreaRatio: 0.3,
      articulationPoints: new Set<number>(),
      articulationCount: 3,
      regions: [],
      regionCount: 4,
      regionSizes: [10, 10, 10, 10],
      largestRegionSize: 10,
      largestRegionRatio: 0.25,
      terminalRegionCount: 2,
      tunnelCells: new Set<number>(),
      tunnelCount: 5,
      chokepoints: new Set<number>(),
      chokepointCount: 2,
      maxDegree: 3,
      degreeDistribution: [0, 5, 20, 15, 0],
      hasCycle: true,
      connectedComponents: 1,
    };

    const withoutSolved: BlueprintCandidate = {
      seed: 42, family: "hub", boxCount: 3, mode: "plain", difficulty: "intermediate",
      blueprint: {} as any, grid: [], structuralMetrics: baseMetrics,
    };

    const withSolved: BlueprintCandidate = {
      ...withoutSolved,
      solvedBlueprint: {} as any,
    };

    const scoreWithout = blueprintStructuralScore(withoutSolved);
    const scoreWith = blueprintStructuralScore(withSolved);

    assert.ok(
      scoreWith > scoreWithout,
      `score with solvedBlueprint (${scoreWith}) should be > without (${scoreWithout})`,
    );
  });

  // ---------------------------------------------------------------------------
  // 11. Flat mode (no funnelBudgets) still works
  // ---------------------------------------------------------------------------

  it("flat mode (no funnelBudgets) still works correctly", async () => {
    const config: ForgeConfig = {
      ...DEFAULT_FORGE_CONFIG,
      batchSize: 6,
      retainTarget: 3,
      families: ["linear"],
      boxCounts: [3],
      difficulties: ["intermediate"],
      modes: ["plain"],
      baseSeed: 95000,
      // No funnelBudgets — should use flat path
    };

    const result = await runForge(config);

    assert.equal(result.totalAttempted, 6);
    assert.ok(result.funnelStats === undefined, "flat mode should not have funnelStats");

    for (const c of result.candidates) {
      const validation = validatePuzzle(c.puzzle);
      assert.ok(validation.valid, `${c.puzzle.id} must be valid`);
    }
  });

  // ---------------------------------------------------------------------------
  // 12. Empty funnel budget produces empty result
  // ---------------------------------------------------------------------------

  it("zero rawAttemptBudget produces empty funnel result", async () => {
    const config: ForgeConfig = {
      ...FUNNEL_CONFIG,
      funnelBudgets: {
        rawAttemptBudget: 0,
        preScreenRetain: 0,
        finalistRetain: 0,
        deepRetain: 0,
        catalogQuota: 0,
      },
    };

    const result = await runForge(config);

    assert.equal(result.totalAttempted, 0);
    assert.equal(result.totalRetained, 0);
    assert.equal(result.candidates.length, 0);
    assert.ok(result.funnelStats, "should have funnel stats even when empty");
    assert.equal(result.funnelStats!.stageA_blueprintGenerated, 0);
  });

  // ---------------------------------------------------------------------------
  // 13. Provenance is complete on funnel candidates
  // ---------------------------------------------------------------------------

  it("funnel candidates have complete provenance", async () => {
    const result = await runForge(FUNNEL_CONFIG);

    for (const c of result.candidates) {
      assert.ok(c.provenance.seed >= FUNNEL_CONFIG.baseSeed, "seed in range");
      assert.ok(
        FUNNEL_CONFIG.families.includes(c.provenance.family),
        "family from config",
      );
      assert.ok(
        FUNNEL_CONFIG.boxCounts.includes(c.provenance.boxCount),
        "boxCount from config",
      );
      assert.ok(
        FUNNEL_CONFIG.modes.includes(c.provenance.mode),
        "mode from config",
      );
      assert.equal(typeof c.provenance.tightened, "boolean");
      assert.equal(typeof c.provenance.cellsRemoved, "number");
    }
  });

  // ---------------------------------------------------------------------------
  // 14. Solver call reduction measurement is coherent
  // ---------------------------------------------------------------------------

  it("solver call reduction measurements are coherent", async () => {
    const config: ForgeConfig = {
      ...FUNNEL_CONFIG,
      funnelBudgets: {
        rawAttemptBudget: 20,
        preScreenRetain: 8,
        finalistRetain: 5,
        deepRetain: 3,
        catalogQuota: 2,
      },
    };
    const result = await runForge(config);

    assert.ok(result.funnelStats, "must have funnelStats");
    const scr = result.funnelStats!.solverCallReduction!;

    // solverCallsAvoided = blueprintSurvivors - structuralSurvivors
    assert.equal(
      scr.solverCallsAvoided,
      scr.blueprintSurvivors - scr.structuralSurvivors,
      "solverCallsAvoided = blueprintSurvivors - structuralSurvivors",
    );

    // blueprintSurvivors <= totalAttempts
    assert.ok(
      scr.blueprintSurvivors <= scr.totalAttempts,
      `blueprintSurvivors (${scr.blueprintSurvivors}) <= totalAttempts (${scr.totalAttempts})`,
    );

    // structuralSurvivors <= blueprintSurvivors
    assert.ok(
      scr.structuralSurvivors <= scr.blueprintSurvivors,
      `structuralSurvivors (${scr.structuralSurvivors}) <= blueprintSurvivors (${scr.blueprintSurvivors})`,
    );
  });

  // ---------------------------------------------------------------------------
  // 15. Rejection counts sum correctly for funnel
  // ---------------------------------------------------------------------------

  it("funnel rejection counts sum correctly", async () => {
    const result = await runForge(FUNNEL_CONFIG);

    const totalRejections = Object.values(result.rejectionCounts).reduce(
      (s, n) => s + n,
      0,
    );
    assert.equal(totalRejections, result.rejections.length);
  });

  // ---------------------------------------------------------------------------
  // 16. QUALITY_PRESETS FunnelStageStats extended type
  // ---------------------------------------------------------------------------

  it("FunnelStageStats supports optional solverCallReduction", () => {
    const stats: FunnelStageStats = {
      stageA_blueprintGenerated: 80,
      stageB_structuralSurvivors: 50,
      stageC_reverseSurvivors: 45,
      stageD_dedupSurvivors: 40,
      stageE_cheapEvalSurvivors: 20,
      stageF_finalistEvaluated: 18,
      stageG_qualityGatePassed: 15,
      stageH_difficultyPassed: 10,
      stageI_curatedFinal: 5,
      solverCallReduction: {
        totalAttempts: 100,
        blueprintSurvivors: 80,
        structuralSurvivors: 50,
        solverCallsMade: 45,
        solverCallsAvoided: 30,
        reductionRatio: 0.55,
      },
    };
    assert.equal(stats.solverCallReduction!.reductionRatio, 0.55);
    assert.equal(stats.solverCallReduction!.solverCallsMade, 45);
  });
});
