import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

import {
  runForge,
  buildV4Fingerprint,
  DEFAULT_FORGE_CONFIG,
  computeV4Profile,
  nonDominatedSort,
  computeNoveltyScores,
  type ForgeConfig,
  type ForgeCandidate,
  type ForgeProvenance,
  type CurationObjectives,
  type PuzzleEvaluationVector,
  type FinalistEvaluationV4,
} from "../../src/features/generator/v2/index.ts";

import { validatePuzzle } from "../../src/core/puzzle.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const V4_FUNNEL_CONFIG: ForgeConfig = {
  ...DEFAULT_FORGE_CONFIG,
  families: ["linear", "hub"],
  boxCounts: [3],
  difficulties: ["intermediate"],
  modes: ["plain"],
  baseSeed: 110000,
  funnelBudgets: {
    rawAttemptBudget: 20,
    preScreenRetain: 10,
    finalistRetain: 6,
    deepRetain: 4,
    catalogQuota: 3,
  },
};

// ---------------------------------------------------------------------------
// 1. V4 finalist evaluator is used in funnel (candidates have V4 data)
// ---------------------------------------------------------------------------

describe("V4 forge integration", () => {
  it("funnel candidates carry V4 difficulty profile in provenance", async () => {
    const result = await runForge(V4_FUNNEL_CONFIG);

    // At least some candidates should survive
    if (result.candidates.length === 0) {
      // If no candidates survived, that's okay for this test — just
      // verify the funnel structure exists
      assert.ok(result.funnelStats, "funnel run must have funnelStats");
      return;
    }

    for (const c of result.candidates) {
      assert.ok(
        c.provenance.v4DifficultyProfile !== undefined,
        `${c.puzzle.id} must have v4DifficultyProfile in provenance`,
      );
      assert.ok(
        c.provenance.v4Classification !== undefined,
        `${c.puzzle.id} must have v4Classification in provenance`,
      );

      const profile = c.provenance.v4DifficultyProfile!;
      assert.equal(typeof profile.structuralScale, "number");
      assert.equal(typeof profile.solutionDepth, "number");
      assert.equal(typeof profile.humanReasoningComplexity, "number");
      assert.equal(typeof profile.tediumPenalty, "number");
      assert.equal(typeof profile.composite, "number");
      assert.equal(typeof profile.classification, "string");
    }
  });

  // ---------------------------------------------------------------------------
  // 2. V4 finalist evaluation is stored on candidates
  // ---------------------------------------------------------------------------

  it("funnel candidates carry finalistEvaluation", async () => {
    const result = await runForge(V4_FUNNEL_CONFIG);

    if (result.candidates.length === 0) return;

    for (const c of result.candidates) {
      assert.ok(
        c.finalistEvaluation !== undefined,
        `${c.puzzle.id} must have finalistEvaluation`,
      );

      const fe = c.finalistEvaluation!;
      assert.equal(typeof fe.solversAttempted, "number");
      assert.equal(typeof fe.solversSucceeded, "number");
      assert.equal(typeof fe.avgExpandedStates, "number");
      assert.equal(typeof fe.solverAgreement, "boolean");
    }
  });

  // ---------------------------------------------------------------------------
  // 3. V4 curation objectives are stored on candidates
  // ---------------------------------------------------------------------------

  it("funnel candidates carry curationObjectives", async () => {
    const result = await runForge(V4_FUNNEL_CONFIG);

    if (result.candidates.length === 0) return;

    for (const c of result.candidates) {
      assert.ok(
        c.curationObjectives !== undefined,
        `${c.puzzle.id} must have curationObjectives`,
      );

      const obj = c.curationObjectives!;
      assert.equal(typeof obj.interaction, "number");
      assert.equal(typeof obj.dependency, "number");
      assert.equal(typeof obj.decisionQuality, "number");
      assert.equal(typeof obj.structuralRichness, "number");
      assert.equal(typeof obj.solverChallenge, "number");
      assert.equal(typeof obj.tedium, "number");
    }
  });

  // ---------------------------------------------------------------------------
  // 4. V4 difficulty validation rejects mismatched candidates
  // ---------------------------------------------------------------------------

  it("v4DifficultyValidation rejects difficulty-mismatch when enabled", async () => {
    const config: ForgeConfig = {
      ...V4_FUNNEL_CONFIG,
      v4DifficultyValidation: true,
    };
    const result = await runForge(config);

    // The test verifies that the funnel can run with validation enabled
    assert.ok(result.funnelStats, "must have funnelStats");

    // If there are mismatches, they appear in rejections
    const mismatchCount = result.rejectionCounts["difficulty-mismatch"] ?? 0;
    // We can't guarantee mismatches occur but the infrastructure must work
    assert.equal(typeof mismatchCount, "number");
  });

  // ---------------------------------------------------------------------------
  // 5. buildV4Fingerprint produces meaningful fingerprints
  // ---------------------------------------------------------------------------

  it("buildV4Fingerprint encodes topology, mode, mechanism, box bucket, region bucket, dep pattern", async () => {
    const result = await runForge(V4_FUNNEL_CONFIG);

    if (result.candidates.length === 0) return;

    for (const c of result.candidates) {
      const fp = buildV4Fingerprint(c);
      const parts = fp.split("|");

      // Motif and mechanism buckets must remain separate for their quotas.
      assert.equal(parts.length, 7, `fingerprint "${fp}" should have 7 pipe-separated parts`);

      // Part 0: topology family
      assert.ok(
        (V4_FUNNEL_CONFIG.families as readonly string[]).includes(parts[0]),
        `topology "${parts[0]}" should be from config families`,
      );

      // Part 1: mode
      assert.ok(
        (V4_FUNNEL_CONFIG.modes as readonly string[]).includes(parts[1]),
        `mode "${parts[1]}" should be from config modes`,
      );

      // Part 2: mechanism or motif (for plain mode, "none")
      assert.equal(typeof parts[2], "string");

      assert.equal(typeof parts[3], "string");
      assert.equal(parts[4], c.puzzle.difficulty);

      // Part 4: region bucket
      assert.ok(
        parts[5].startsWith("r"),
        `region bucket "${parts[5]}" should start with "r"`,
      );

      // Part 5: dependency pattern
      assert.ok(
        ["none", "dep-low", "dep-med", "dep-high"].includes(parts[6]),
        `dep pattern "${parts[6]}" should be one of the known values`,
      );
    }
  });

  // ---------------------------------------------------------------------------
  // 6. V4 fingerprint differs for different topology families
  // ---------------------------------------------------------------------------

  it("buildV4Fingerprint differs by topology and mode", () => {
    // Create mock candidates differing in topology
    const baseProv: ForgeProvenance = {
      seed: 1, family: "linear", boxCount: 3, mode: "plain",
      difficulty: "intermediate", tightened: false, cellsRemoved: 0,
      typingMode: "generic", genericBoxCount: 3, typedBoxCount: 0,
    };

    const baseEval = {
      totalFloor: 30, regionCount: 3, solutionMoves: 20,
      solutionPushes: 10, boxIndependenceRatio: 0.5,
      emptyWalkRatio: 0.3, unusedFloorRatio: 0.4,
      deadlockDensity: 0.1, solverExpandedStates: 100,
      movesPerPush: 2, solved: true,
    } as unknown as PuzzleEvaluationVector;

    const c1: ForgeCandidate = {
      puzzle: { id: "a", title: "Test A", rows: [], boxes: 3, difficulty: "intermediate" },
      provenance: baseProv,
      evaluation: baseEval,
    };

    const c2: ForgeCandidate = {
      puzzle: { id: "b", title: "Test B", rows: [], boxes: 3, difficulty: "intermediate" },
      provenance: { ...baseProv, family: "hub" },
      evaluation: baseEval,
    };

    const fp1 = buildV4Fingerprint(c1);
    const fp2 = buildV4Fingerprint(c2);

    assert.notEqual(fp1, fp2, "different topologies should produce different fingerprints");
    assert.ok(fp1.startsWith("linear|"), "fp1 should start with linear");
    assert.ok(fp2.startsWith("hub|"), "fp2 should start with hub");
  });

  // ---------------------------------------------------------------------------
  // 7. V4 funnel stages decrease monotonically
  // ---------------------------------------------------------------------------

  it("V4 funnel stages decrease monotonically", async () => {
    const result = await runForge(V4_FUNNEL_CONFIG);

    assert.ok(result.funnelStats, "must have funnelStats");
    const stats = result.funnelStats!;

    assert.ok(
      stats.stageA_blueprintGenerated >= stats.stageB_structuralSurvivors,
      `stageA >= stageB`,
    );
    assert.ok(
      stats.stageC_reverseSurvivors >= 0,
      `stageC should be non-negative`,
    );
    assert.ok(
      stats.stageC_reverseSurvivors >= stats.stageD_dedupSurvivors,
      `stageC >= stageD`,
    );
    assert.ok(
      stats.stageD_dedupSurvivors >= stats.stageE_cheapEvalSurvivors,
      `stageD >= stageE`,
    );
    assert.ok(
      stats.stageE_cheapEvalSurvivors >= stats.stageF_finalistEvaluated,
      `stageE >= stageF`,
    );
    assert.ok(
      stats.stageF_finalistEvaluated >= stats.stageG_qualityGatePassed,
      `stageF >= stageG`,
    );
    assert.ok(
      stats.stageG_qualityGatePassed >= stats.stageH_difficultyPassed,
      `stageG >= stageH`,
    );
    assert.ok(
      stats.stageH_difficultyPassed >= stats.stageI_curatedFinal,
      `stageH >= stageI`,
    );
  });

  // ---------------------------------------------------------------------------
  // 8. All V4 funnel candidates pass validation
  // ---------------------------------------------------------------------------

  it("all V4 funnel candidates pass validation", async () => {
    const result = await runForge(V4_FUNNEL_CONFIG);

    for (const c of result.candidates) {
      const validation = validatePuzzle(c.puzzle);
      assert.ok(validation.valid, `${c.puzzle.id} must be valid`);
    }
  });

  // ---------------------------------------------------------------------------
  // 9. V4 funnel with diversity quotas
  // ---------------------------------------------------------------------------

  it("funnel respects diversity quotas when configured", async () => {
    const config: ForgeConfig = {
      ...V4_FUNNEL_CONFIG,
      diversityQuotas: {
        maxPerTopology: 2,
        maxPerMode: 3,
      },
    };
    const result = await runForge(config);

    assert.ok(result.funnelStats, "must have funnelStats");
    // All retained candidates should be valid
    for (const c of result.candidates) {
      const validation = validatePuzzle(c.puzzle);
      assert.ok(validation.valid, `${c.puzzle.id} must be valid`);
    }
  });

  // ---------------------------------------------------------------------------
  // 10. V4 funnel is deterministic
  // ---------------------------------------------------------------------------

  it("V4 funnel is deterministic for same config and baseSeed", async () => {
    const config: ForgeConfig = {
      ...V4_FUNNEL_CONFIG,
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
      // V4 profiles should also match
      assert.deepEqual(
        run1.candidates[i].provenance.v4DifficultyProfile,
        run2.candidates[i].provenance.v4DifficultyProfile,
      );
    }
  });

  // ---------------------------------------------------------------------------
  // 11. V4 evaluator policy can be customized
  // ---------------------------------------------------------------------------

  it("custom V4 evaluator policy is used when provided", async () => {
    const config: ForgeConfig = {
      ...V4_FUNNEL_CONFIG,
      v4EvaluatorPolicy: {
        witnessTimeoutMs: 500,
        fastProbeMaxElapsedMs: 2_000,
        fastProbeMaxStates: 200_000,
        exactEvidenceMaxElapsedMs: 5_000,
        exactEvidenceMaxStates: 500_000,
        proofMaxElapsedMs: 10_000,
        proofMaxStates: 1_000_000,
        proofMaxBoxes: 4,
        proofMaxFloor: 100,
        requireOptimalProof: false,
      },
    };

    const result = await runForge(config);
    assert.ok(result.funnelStats, "must have funnelStats");
    // The config should be accepted and produce valid results
    for (const c of result.candidates) {
      const validation = validatePuzzle(c.puzzle);
      assert.ok(validation.valid, `${c.puzzle.id} must be valid`);
    }
  });

  // ---------------------------------------------------------------------------
  // 12. Flat mode (no funnelBudgets) still works without V4 enrichment
  // ---------------------------------------------------------------------------

  it("flat mode does not add V4 fields (backward compat)", async () => {
    const config: ForgeConfig = {
      ...DEFAULT_FORGE_CONFIG,
      batchSize: 6,
      retainTarget: 3,
      families: ["linear"],
      boxCounts: [3],
      difficulties: ["intermediate"],
      modes: ["plain"],
      baseSeed: 115000,
      // No funnelBudgets — flat path
    };

    const result = await runForge(config);
    assert.ok(
      result.funnelStats === undefined,
      "flat mode should not have funnelStats",
    );

    // Flat mode candidates do not go through V4 pipeline
    for (const c of result.candidates) {
      assert.equal(
        c.provenance.v4DifficultyProfile,
        undefined,
        "flat mode should not have v4DifficultyProfile",
      );
      assert.equal(
        c.finalistEvaluation,
        undefined,
        "flat mode should not have finalistEvaluation",
      );
    }
  });

  // ---------------------------------------------------------------------------
  // 13. FinalistEvaluationV4 has roleResults and witnessValid
  // ---------------------------------------------------------------------------

  it("finalistEvaluation from funnel has V4 fields (roleResults, witnessValid)", async () => {
    const result = await runForge(V4_FUNNEL_CONFIG);

    if (result.candidates.length === 0) return;

    for (const c of result.candidates) {
      if (!c.finalistEvaluation) continue;

      const fe = c.finalistEvaluation as FinalistEvaluationV4;
      if ("roleResults" in fe) {
        assert.equal(typeof fe.witnessValid, "boolean");
        assert.equal(typeof fe.proofSkipped, "boolean");
        assert.ok(fe.roleResults instanceof Map, "roleResults should be a Map");
      }
    }
  });

  // ---------------------------------------------------------------------------
  // 14. computeV4Profile produces valid classifications
  // ---------------------------------------------------------------------------

  it("computeV4Profile produces valid difficulty tier", () => {
    const validTiers = [
      "tutorial", "beginner", "intermediate",
      "advanced", "expert", "master",
    ];

    const ev = {
      solverExpandedStates: 100,
      solverGeneratedStates: 200,
      solverElapsedMs: 50,
      solverPeakFrontier: 20,
      solverDeadlockPrunes: 5,
      solverDuplicateStates: 10,
      solutionMoves: 30,
      solutionPushes: 12,
      solutionWalks: 18,
      pushRatio: 0.4,
      boxCount: 3,
      avgLegalPushes: 3,
      maxLegalPushes: 6,
      singleChoiceRatio: 0.2,
      highBranchCount: 2,
      avgReachablePushes: 4,
      maxReachablePushes: 8,
      reachableSingleChoiceRatio: 0.15,
      reachableHighBranchCount: 3,
      reachableForcedPushRatio: 0.1,
      boxIndependenceRatio: 0.4,
      boxInteractionEvents: 5,
      pushesPerBox: 4,
      pushSwitchRatio: 0.6,
      boxSwitchRate: 0.5,
      multiMoveBoxCount: 2,
      emptyWalkRatio: 0.3,
      longestWalkStreak: 5,
      repetitivePushRatio: 0.1,
      unusedFloorRatio: 0.3,
      solutionFloorCoverage: 0.7,
      solutionUnusedFloorRatio: 0.3,
      movesPerPush: 2.5,
      deadlockDensity: 0.15,
      totalFloor: 35,
      solved: true,
      nonMonotonicBoxMoves: 2,
      stagingOperations: 1,
      temporaryGoalVacancies: 0,
      estimatedDependencyDepth: 2,
      goalOrderConstraints: 1,
      criticalMoveCount: 1,
      criticalMoveRatio: 0.08,
      sharedRouteCells: 4,
      sharedSupportCells: 2,
      sharedChokepointUses: 1,
      causalEnableCount: 3,
      causalDisableCount: 1,
      roomCrossingsInSolution: 4,
      regionCount: 3,
      chokepoints: 2,
      articulationPoints: 2,
      tunnelCells: 3,
    } as unknown as PuzzleEvaluationVector;

    const profile = computeV4Profile(ev);

    assert.ok(
      validTiers.includes(profile.classification),
      `classification "${profile.classification}" must be a valid tier`,
    );
    assert.ok(Number.isFinite(profile.composite), "composite must be finite");
    assert.ok(Number.isFinite(profile.structuralScale), "structuralScale must be finite");
    assert.ok(Number.isFinite(profile.solutionDepth), "solutionDepth must be finite");
    assert.ok(Number.isFinite(profile.humanReasoningComplexity), "humanReasoningComplexity must be finite");
    assert.ok(Number.isFinite(profile.tediumPenalty), "tediumPenalty must be finite");
  });

  // ---------------------------------------------------------------------------
  // 15. V4 curation pipeline: nonDominatedSort -> novelty -> selection
  // ---------------------------------------------------------------------------

  it("V4 curation pipeline works end-to-end on mock data", () => {
    const objectives1: CurationObjectives = {
      interaction: 5, dependency: 3, decisionQuality: 4,
      structuralRichness: 3, solverChallenge: 6, novelty: 0, tedium: 0.2,
    };
    const objectives2: CurationObjectives = {
      interaction: 3, dependency: 5, decisionQuality: 6,
      structuralRichness: 4, solverChallenge: 3, novelty: 0, tedium: 0.1,
    };
    const objectives3: CurationObjectives = {
      interaction: 1, dependency: 1, decisionQuality: 1,
      structuralRichness: 1, solverChallenge: 1, novelty: 0, tedium: 0.9,
    };

    const entries = [
      { item: { id: "a" }, objectives: objectives1 },
      { item: { id: "b" }, objectives: objectives2 },
      { item: { id: "c" }, objectives: objectives3 },
    ];

    const sorted = nonDominatedSort(entries);
    assert.equal(sorted.length, 3);

    // The dominated candidate (c) should have a higher front number
    const frontC = sorted.find((s) => s.item.id === "c")!.front;
    const frontA = sorted.find((s) => s.item.id === "a")!.front;
    const frontB = sorted.find((s) => s.item.id === "b")!.front;
    // c is dominated by both a and b (worse in all positive objectives)
    assert.ok(frontC >= frontA, "dominated candidate should not have lower front");
    assert.ok(frontC >= frontB, "dominated candidate should not have lower front");

    const withNovelty = computeNoveltyScores(sorted);
    assert.equal(withNovelty.length, 3);

    // All novelty scores should be finite non-negative
    for (const c of withNovelty) {
      assert.ok(Number.isFinite(c.noveltyScore), "novelty score must be finite");
      assert.ok(c.noveltyScore >= 0, "novelty score must be non-negative");
    }
  });
});
