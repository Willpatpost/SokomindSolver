import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  QUALITY_PRESETS,
  type FunnelBudgets,
  type QualityPreset,
  type FunnelStageStats,
} from "../../src/features/generator/v2/puzzle-forge.ts";

describe("candidate-funnel", () => {
  describe("QUALITY_PRESETS", () => {
    it("has all four preset levels", () => {
      const presets: QualityPreset[] = ["smoke", "standard", "high", "exhaustive"];
      for (const p of presets) {
        assert.ok(QUALITY_PRESETS[p], `missing preset: ${p}`);
      }
    });

    it("each preset has increasing rawAttemptBudget", () => {
      const order: QualityPreset[] = ["smoke", "standard", "high", "exhaustive"];
      for (let i = 1; i < order.length; i++) {
        assert.ok(
          QUALITY_PRESETS[order[i]].rawAttemptBudget > QUALITY_PRESETS[order[i - 1]].rawAttemptBudget,
          `${order[i]} should have larger budget than ${order[i - 1]}`,
        );
      }
    });

    it("each preset has decreasing retention ratio through stages", () => {
      for (const [name, budgets] of Object.entries(QUALITY_PRESETS)) {
        assert.ok(
          budgets.rawAttemptBudget >= budgets.preScreenRetain,
          `${name}: preScreenRetain should be <= rawAttemptBudget`,
        );
        assert.ok(
          budgets.preScreenRetain >= budgets.finalistRetain,
          `${name}: finalistRetain should be <= preScreenRetain`,
        );
        assert.ok(
          budgets.finalistRetain >= budgets.deepRetain,
          `${name}: deepRetain should be <= finalistRetain`,
        );
        assert.ok(
          budgets.deepRetain >= budgets.catalogQuota,
          `${name}: catalogQuota should be <= deepRetain`,
        );
      }
    });

    it("smoke preset has smallest budgets", () => {
      const smoke = QUALITY_PRESETS.smoke;
      assert.ok(smoke.rawAttemptBudget <= 50);
      assert.ok(smoke.catalogQuota <= 10);
    });

    it("exhaustive preset has largest budgets", () => {
      const exhaust = QUALITY_PRESETS.exhaustive;
      assert.ok(exhaust.rawAttemptBudget >= 10000);
      assert.ok(exhaust.catalogQuota >= 20);
    });
  });

  describe("FunnelBudgets type", () => {
    it("has all required fields", () => {
      const budgets: FunnelBudgets = {
        rawAttemptBudget: 100,
        preScreenRetain: 50,
        finalistRetain: 20,
        deepRetain: 10,
        catalogQuota: 5,
      };
      assert.equal(budgets.rawAttemptBudget, 100);
      assert.equal(budgets.preScreenRetain, 50);
      assert.equal(budgets.finalistRetain, 20);
      assert.equal(budgets.deepRetain, 10);
      assert.equal(budgets.catalogQuota, 5);
    });
  });

  describe("FunnelStageStats type", () => {
    it("has all stage count fields", () => {
      const stats: FunnelStageStats = {
        stageA_rawGenerated: 80,
        stageB_structuralSurvivors: 50,
        stageC_cheapEvalSurvivors: 20,
        stageD_deepEvalSurvivors: 10,
        stageE_curatedFinal: 5,
      };
      assert.equal(stats.stageA_rawGenerated, 80);
      assert.equal(stats.stageB_structuralSurvivors, 50);
      assert.equal(stats.stageC_cheapEvalSurvivors, 20);
      assert.equal(stats.stageD_deepEvalSurvivors, 10);
      assert.equal(stats.stageE_curatedFinal, 5);
    });
  });
});
