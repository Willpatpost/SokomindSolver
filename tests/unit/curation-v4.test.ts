import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildNormalizationContext,
  computeNoveltyScores,
  nonDominatedSort,
  selectWithDiversityQuotas,
  type CuratedCandidate,
  type DiversityQuotas,
  type NormalizationContext,
} from "../../src/features/generator/v2/curation.ts";
import type { CurationObjectives } from "../../src/features/generator/v2/finalist-evaluator.ts";

function makeObjectives(overrides: Partial<CurationObjectives> = {}): CurationObjectives {
  return {
    interaction: 1,
    dependency: 0.5,
    decisionQuality: 2,
    structuralRichness: 1.5,
    solverChallenge: 3,
    novelty: 0,
    tedium: 0.3,
    ...overrides,
  };
}

describe("curation-v4", () => {
  describe("buildNormalizationContext", () => {
    it("computes min and range for each objective", () => {
      const objectives = [
        makeObjectives({ interaction: 1, solverChallenge: 10 }),
        makeObjectives({ interaction: 5, solverChallenge: 20 }),
        makeObjectives({ interaction: 3, solverChallenge: 15 }),
      ];
      const ctx = buildNormalizationContext(objectives);
      assert.equal(ctx.ranges.interaction.min, 1);
      assert.equal(ctx.ranges.interaction.range, 4);
      assert.equal(ctx.ranges.solverChallenge.min, 10);
      assert.equal(ctx.ranges.solverChallenge.range, 10);
    });

    it("handles single-value range (no division by zero)", () => {
      const objectives = [
        makeObjectives({ interaction: 5 }),
        makeObjectives({ interaction: 5 }),
      ];
      const ctx = buildNormalizationContext(objectives);
      assert.equal(ctx.ranges.interaction.range, 1);
    });

    it("handles empty input", () => {
      const ctx = buildNormalizationContext([]);
      assert.equal(ctx.ranges.interaction.min, 0);
      assert.equal(ctx.ranges.interaction.range, 1);
    });
  });

  describe("computeNoveltyScores with normalization", () => {
    it("produces higher novelty for outliers", () => {
      const items = [
        { item: "a", objectives: makeObjectives({ interaction: 1, solverChallenge: 1 }) },
        { item: "b", objectives: makeObjectives({ interaction: 1.1, solverChallenge: 1.1 }) },
        { item: "c", objectives: makeObjectives({ interaction: 10, solverChallenge: 10 }) },
      ];
      const sorted = nonDominatedSort(items);
      const ctx = buildNormalizationContext(items.map((i) => i.objectives));
      const scored = computeNoveltyScores(sorted, 2, ctx);

      const outlier = scored.find((s) => s.item === "c")!;
      const cluster = scored.find((s) => s.item === "a")!;
      assert.ok(
        outlier.noveltyScore > cluster.noveltyScore,
        "outlier should have higher novelty than cluster member",
      );
    });

    it("structural fingerprint bonus increases novelty for different fingerprints", () => {
      const items = [
        { item: { structuralFingerprint: "hub|plain|none|none" }, objectives: makeObjectives({ interaction: 1 }) },
        { item: { structuralFingerprint: "hub|plain|none|none" }, objectives: makeObjectives({ interaction: 1.05 }) },
        { item: { structuralFingerprint: "loop|motif|chain|gatekeeper" }, objectives: makeObjectives({ interaction: 1.1 }) },
      ];
      const sorted = nonDominatedSort(items).map((c) => ({
        ...c,
        structuralFingerprint: c.item.structuralFingerprint,
      }));
      const scored = computeNoveltyScores(sorted, 2);

      const different = scored.find((s) => s.item.structuralFingerprint === "loop|motif|chain|gatekeeper")!;
      const same = scored.find((s) =>
        s.item.structuralFingerprint === "hub|plain|none|none" && s.objectives.interaction === 1,
      )!;
      assert.ok(
        different.noveltyScore > same.noveltyScore,
        "different structural fingerprint should boost novelty",
      );
    });
  });

  describe("selectWithDiversityQuotas", () => {
    function makeCandidates(
      fps: string[],
    ): CuratedCandidate<{ structuralFingerprint: string }>[] {
      return fps.map((fp, i) => ({
        item: { structuralFingerprint: fp },
        objectives: makeObjectives({ interaction: i }),
        front: 0,
        noveltyScore: fps.length - i,
        structuralFingerprint: fp,
      }));
    }

    it("respects maxPerTopology quota", () => {
      const candidates = makeCandidates([
        "hub|plain|none|none",
        "hub|motif|chain|none",
        "hub|composed|none|none",
        "loop|plain|none|none",
        "loop|motif|chain|none",
      ]);
      const quotas: DiversityQuotas = { maxPerTopology: 2 };
      const selected = selectWithDiversityQuotas(candidates, 4, quotas);

      const hubCount = selected.filter((s) =>
        s.structuralFingerprint?.startsWith("hub|"),
      ).length;
      assert.ok(hubCount <= 2, `hub count ${hubCount} should be <= 2`);
      assert.equal(selected.length, 4);
    });

    it("respects maxPerMode quota", () => {
      const candidates = makeCandidates([
        "hub|plain|none|none",
        "loop|plain|none|none",
        "branch|plain|none|none",
        "hub|motif|chain|none",
        "loop|composed|none|none",
      ]);
      const quotas: DiversityQuotas = { maxPerMode: 2 };
      const selected = selectWithDiversityQuotas(candidates, 4, quotas);

      const plainCount = selected.filter((s) =>
        s.structuralFingerprint?.includes("|plain|"),
      ).length;
      assert.ok(plainCount <= 2, `plain count ${plainCount} should be <= 2`);
    });

    it("falls back to fill quota when quotas are too restrictive", () => {
      const candidates = makeCandidates([
        "hub|plain|none|none",
        "hub|plain|none|none",
        "hub|plain|none|none",
      ]);
      const quotas: DiversityQuotas = { maxPerTopology: 1 };
      const selected = selectWithDiversityQuotas(candidates, 3, quotas);
      assert.equal(selected.length, 3, "should still fill quota via fallback");
    });

    it("without quotas behaves like selectByParetoNovelty", () => {
      const candidates = makeCandidates([
        "hub|plain|none|none",
        "loop|motif|chain|none",
      ]);
      const selected = selectWithDiversityQuotas(candidates, 2);
      assert.equal(selected.length, 2);
    });

    it("respects maxPerMotif quota", () => {
      const candidates = makeCandidates([
        "hub|motif|chain|none",
        "loop|motif|chain|none",
        "branch|motif|chain|none",
        "hub|motif|packing|none",
        "loop|plain|none|none",
      ]);
      const quotas: DiversityQuotas = { maxPerMotif: 2 };
      const selected = selectWithDiversityQuotas(candidates, 4, quotas);

      const chainCount = selected.filter((s) =>
        s.structuralFingerprint?.includes("|chain|"),
      ).length;
      assert.ok(chainCount <= 2, `chain motif count ${chainCount} should be <= 2`);
    });
  });
});
