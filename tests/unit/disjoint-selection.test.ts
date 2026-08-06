import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { maximumDisjointSelection } from "../../src/solver/search/disjoint-selection.ts";
import type { HeuristicCandidate } from "../../src/solver/search/room-pattern-heuristic.ts";

function candidate(labels: string[], boost: number, kind: "room" | "pair" = "room"): HeuristicCandidate {
  return { labels: new Set(labels), boost, kind };
}

describe("maximum disjoint selection", () => {
  it("returns empty for no candidates", () => {
    assert.deepEqual(maximumDisjointSelection([]), []);
  });

  it("selects a single candidate", () => {
    const c = candidate(["A"], 5);
    const result = maximumDisjointSelection([c]);
    assert.equal(result.length, 1);
    assert.equal(result[0].boost, 5);
  });

  it("selects both non-conflicting candidates", () => {
    const c1 = candidate(["A"], 3);
    const c2 = candidate(["B"], 4);
    const result = maximumDisjointSelection([c1, c2]);
    assert.equal(result.length, 2);
    const totalBoost = result.reduce((s, c) => s + c.boost, 0);
    assert.equal(totalBoost, 7);
  });

  it("selects higher-boost candidate when conflicting", () => {
    const c1 = candidate(["A", "B"], 3);
    const c2 = candidate(["B", "C"], 5);
    const result = maximumDisjointSelection([c1, c2]);
    assert.equal(result.length, 1);
    assert.equal(result[0].boost, 5);
  });

  it("finds optimal subset with partial conflict (DP beats greedy)", () => {
    // Greedy would pick c2 (boost 6), blocking both c1 and c3.
    // DP finds c1 + c3 = 4 + 4 = 8 > 6.
    const c1 = candidate(["A"], 4);
    const c2 = candidate(["A", "B"], 6);
    const c3 = candidate(["B"], 4);
    const result = maximumDisjointSelection([c1, c2, c3]);
    const totalBoost = result.reduce((s, c) => s + c.boost, 0);
    assert.equal(totalBoost, 8, "DP should find optimal subset c1+c3=8 > c2=6");
    assert.equal(result.length, 2);
  });

  it("produces valid (non-conflicting) selection with greedy fallback", () => {
    // 21 distinct labels → triggers greedy path
    const candidates: HeuristicCandidate[] = [];
    const labels = Array.from({ length: 21 }, (_, i) => String.fromCharCode(65 + i));
    for (let i = 0; i < 20; i++) {
      candidates.push(candidate([labels[i]], i + 1));
    }
    candidates.push(candidate([labels[0], labels[20]], 100));

    const result = maximumDisjointSelection(candidates);
    const usedLabels = new Set<string>();
    for (const c of result) {
      for (const label of c.labels) {
        assert.ok(!usedLabels.has(label), `Label ${label} appears in multiple selected candidates`);
        usedLabels.add(label);
      }
    }
    assert.ok(result.length > 0, "Should select at least one candidate");
  });
});
