import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SolverSolution, SolutionStep } from "../../src/solver/contracts.ts";
import {
  computeDiversitySignature,
  isDiverse,
  computeHarvestMs,
  isSolutionBetter,
  selectForRewrite,
  selectBest,
  IncumbentCollector,
} from "../../src/solver/implementations/sokomind-incumbents.ts";

function makeSolution(
  steps: readonly SolutionStep[],
  overrides?: Partial<SolverSolution>,
): SolverSolution {
  const moves = steps.length;
  const pushes = steps.filter((s) => s.kind === "push").length;
  return {
    steps,
    moves,
    pushes,
    objective: { kind: "moves" },
    objectiveScore: moves,
    optimality: "unknown",
    ...overrides,
  };
}

function pushStep(dir: "up" | "down" | "left" | "right"): SolutionStep {
  return { direction: dir, kind: "push" };
}

function walkStep(dir: "up" | "down" | "left" | "right"): SolutionStep {
  return { direction: dir, kind: "walk" };
}

describe("diversity signature", () => {
  it("same solution produces same signature", () => {
    const sol = makeSolution([pushStep("up"), walkStep("left"), pushStep("down")]);
    const sig1 = computeDiversitySignature(sol);
    const sig2 = computeDiversitySignature(sol);
    assert.equal(sig1.pushChainHash, sig2.pushChainHash);
    assert.equal(sig1.boxGoalHash, sig2.boxGoalHash);
  });

  it("different push sequences produce different pushChainHash", () => {
    const sol1 = makeSolution([pushStep("up"), pushStep("down")]);
    const sol2 = makeSolution([pushStep("down"), pushStep("up")]);
    const sig1 = computeDiversitySignature(sol1);
    const sig2 = computeDiversitySignature(sol2);
    assert.notEqual(sig1.pushChainHash, sig2.pushChainHash);
  });

  it("same pushes with different walk paths produce same pushChainHash", () => {
    const sol1 = makeSolution([walkStep("left"), pushStep("up"), pushStep("right")]);
    const sol2 = makeSolution([walkStep("right"), pushStep("up"), pushStep("right")]);
    const sig1 = computeDiversitySignature(sol1);
    const sig2 = computeDiversitySignature(sol2);
    assert.equal(sig1.pushChainHash, sig2.pushChainHash);
  });

  it("different walk paths between pushes produce different boxGoalHash", () => {
    const sol1 = makeSolution([
      walkStep("left"), walkStep("up"), pushStep("right"),
      walkStep("down"), pushStep("left"),
    ]);
    const sol2 = makeSolution([
      walkStep("right"), walkStep("down"), pushStep("right"),
      walkStep("up"), pushStep("left"),
    ]);
    const sig1 = computeDiversitySignature(sol1);
    const sig2 = computeDiversitySignature(sol2);
    assert.notEqual(sig1.boxGoalHash, sig2.boxGoalHash);
  });

  it("isDiverse returns true for structurally different solutions", () => {
    const sig1 = computeDiversitySignature(
      makeSolution([pushStep("up"), pushStep("down")]),
    );
    const sig2 = computeDiversitySignature(
      makeSolution([pushStep("left"), pushStep("right")]),
    );
    assert.ok(isDiverse(sig2, [sig1]));
  });

  it("isDiverse returns false for identical signatures", () => {
    const sol = makeSolution([pushStep("up"), pushStep("down")]);
    const sig = computeDiversitySignature(sol);
    assert.ok(!isDiverse(sig, [sig]));
  });

  it("isDiverse ignores move/push count differences", () => {
    const sol1 = makeSolution([pushStep("up"), pushStep("down")]);
    const sol2 = makeSolution([pushStep("up"), pushStep("down")], {
      moves: 99,
      pushes: 99,
      objectiveScore: 99,
    });
    const sig1 = computeDiversitySignature(sol1);
    const sig2 = computeDiversitySignature(sol2);
    assert.ok(!isDiverse(sig2, [sig1]), "Same structure with different counts should not be diverse");
  });

  it("empty solutions produce identical signatures", () => {
    const sol1 = makeSolution([]);
    const sol2 = makeSolution([]);
    const sig1 = computeDiversitySignature(sol1);
    const sig2 = computeDiversitySignature(sol2);
    assert.equal(sig1.pushChainHash, sig2.pushChainHash);
    assert.equal(sig1.boxGoalHash, sig2.boxGoalHash);
    assert.ok(!isDiverse(sig2, [sig1]));
  });

  it("walk-only solutions produce identical structural hashes", () => {
    const sol1 = makeSolution([walkStep("up"), walkStep("left")]);
    const sol2 = makeSolution([walkStep("down"), walkStep("right")]);
    const sig1 = computeDiversitySignature(sol1);
    const sig2 = computeDiversitySignature(sol2);
    assert.equal(sig1.pushChainHash, sig2.pushChainHash);
    assert.ok(!isDiverse(sig2, [sig1]), "Walk-only solutions are structurally identical");
  });

  it("uses replay-derived box identities instead of cosmetic walk paths", () => {
    const solution = makeSolution([walkStep("left"), pushStep("down")]);
    const first = computeDiversitySignature(solution, {
      pushChain: "A@2,2#0:2,2>3,2",
      boxGoals: "A@2,2#0>3,2",
    });
    const second = computeDiversitySignature(solution, {
      pushChain: "B@2,2#0:2,2>3,2",
      boxGoals: "B@2,2#0>3,2",
    });

    assert.notEqual(first.pushChainKey, second.pushChainKey);
    assert.ok(isDiverse(second, [first]));
  });
});

describe("IncumbentCollector", () => {
  it("starts empty", () => {
    const collector = new IncumbentCollector(4);
    assert.equal(collector.incumbents.length, 0);
    assert.equal(collector.best, undefined);
  });

  it("accepts a single solution", () => {
    const collector = new IncumbentCollector(4);
    const sol = makeSolution([pushStep("up")]);
    assert.ok(collector.offer(sol));
    assert.equal(collector.incumbents.length, 1);
    assert.equal(collector.best?.solution, sol);
  });

  it("rejects duplicate solutions", () => {
    const collector = new IncumbentCollector(4);
    const sol = makeSolution([pushStep("up"), pushStep("down")]);
    collector.offer(sol);
    assert.ok(!collector.offer(sol));
    assert.equal(collector.stats.duplicatesRejected, 1);
    assert.equal(collector.incumbents.length, 1);
  });

  it("replaces a duplicate semantic basin when its keeper route is shorter", () => {
    const collector = new IncumbentCollector(4);
    const semanticTrace = {
      pushChain: "A@2,2#0:2,2>3,2",
      boxGoals: "A@2,2#0>3,2",
    };
    const longer = makeSolution([
      walkStep("left"),
      walkStep("right"),
      pushStep("down"),
    ]);
    const shorter = makeSolution([pushStep("down")]);

    assert.equal(collector.offer(longer, semanticTrace), true);
    assert.equal(collector.offer(shorter, semanticTrace), true);
    assert.equal(collector.incumbents.length, 1);
    assert.equal(collector.best?.solution, shorter);
    assert.equal(collector.best?.discoveryOrder, 0);
    assert.equal(collector.stats.duplicatesRejected, 0);
  });

  it("accepts diverse solutions up to limit", () => {
    const collector = new IncumbentCollector(3);
    collector.offer(makeSolution([pushStep("up")]));
    collector.offer(makeSolution([pushStep("down")]));
    collector.offer(makeSolution([pushStep("left")]));
    assert.equal(collector.incumbents.length, 3);
    assert.equal(collector.stats.accepted, 3);
  });

  it("evicts worst when at capacity with better solution", () => {
    const collector = new IncumbentCollector(2);
    const long = makeSolution([
      pushStep("up"), walkStep("down"), walkStep("left"), pushStep("right"),
    ]);
    const short1 = makeSolution([pushStep("down")]);
    collector.offer(long);
    collector.offer(short1);
    assert.equal(collector.incumbents.length, 2);

    const short2 = makeSolution([pushStep("left")]);
    assert.ok(collector.offer(short2));
    assert.equal(collector.incumbents.length, 2);
    assert.ok(
      collector.incumbents.every((i) => i.solution.moves <= long.moves),
      "Worst (longest) should have been evicted",
    );
  });

  it("rejects worse solution when at capacity", () => {
    const collector = new IncumbentCollector(2);
    collector.offer(makeSolution([pushStep("up")]));
    collector.offer(makeSolution([pushStep("down")]));
    const worse = makeSolution([
      pushStep("left"), walkStep("right"), walkStep("up"), pushStep("down"),
    ]);
    assert.ok(!collector.offer(worse));
    assert.equal(collector.incumbents.length, 2);
  });

  it("sorts by moves, then pushes, then discoveryOrder", () => {
    const collector = new IncumbentCollector(4);
    const sol3 = makeSolution([pushStep("up"), walkStep("down"), pushStep("left")]);
    const sol1 = makeSolution([pushStep("right")]);
    const sol2 = makeSolution([pushStep("down"), pushStep("up")]);
    collector.offer(sol3);
    collector.offer(sol1);
    collector.offer(sol2);
    const moves = collector.incumbents.map((i) => i.solution.moves);
    assert.deepEqual(moves, [1, 2, 3]);
  });

  it("works with limit=1", () => {
    const collector = new IncumbentCollector(1);
    const long = makeSolution([pushStep("up"), walkStep("down"), pushStep("left")]);
    const short = makeSolution([pushStep("right")]);
    collector.offer(long);
    assert.equal(collector.incumbents.length, 1);
    assert.ok(collector.offer(short));
    assert.equal(collector.incumbents.length, 1);
    assert.equal(collector.best?.solution.moves, 1);
  });

  it("sorts by pushes when moves are equal", () => {
    const collector = new IncumbentCollector(4);
    const morePushes = makeSolution([pushStep("up"), pushStep("down")]);
    const fewerPushes = makeSolution([pushStep("left"), walkStep("right")]);
    collector.offer(morePushes);
    collector.offer(fewerPushes);
    const pushCounts = collector.incumbents.map((i) => i.solution.pushes);
    assert.deepEqual(pushCounts, [1, 2]);
  });

  it("uses discoveryOrder to break ties on equal moves and pushes", () => {
    const collector = new IncumbentCollector(4);
    const sol1 = makeSolution([pushStep("up")]);
    const sol2 = makeSolution([pushStep("down")]);
    collector.offer(sol1);
    collector.offer(sol2);
    assert.equal(collector.incumbents[0].discoveryOrder, 0);
    assert.equal(collector.incumbents[1].discoveryOrder, 1);
  });
});

describe("harvest budget computation", () => {
  it("uses min of configured and 10% of request time", () => {
    assert.equal(computeHarvestMs(5000, 20000), 2000);
  });

  it("enforces minimum 500ms", () => {
    assert.equal(computeHarvestMs(100, 1000), 500);
  });

  it("uses configured when no request time", () => {
    assert.equal(computeHarvestMs(5000, undefined), 5000);
  });

  it("uses configured when request time is infinite", () => {
    assert.equal(computeHarvestMs(3000, Infinity), 3000);
  });

  it("clamps zero configured to 500ms minimum", () => {
    assert.equal(computeHarvestMs(0, 100000), 500);
  });

  it("uses configured when it is already below 10% of request time", () => {
    assert.equal(computeHarvestMs(1000, 50000), 1000);
  });
});

describe("rewrite selection", () => {
  it("selects at most 3 incumbents for rewrite", () => {
    const collector = new IncumbentCollector(8);
    for (let i = 0; i < 5; i++) {
      const dirs = ["up", "down", "left", "right", "up"] as const;
      collector.offer(makeSolution([pushStep(dirs[i])]));
    }
    const selected = selectForRewrite(collector.incumbents);
    assert.ok(selected.length <= 3);
  });

  it("selectBest picks lowest moves then pushes then order", () => {
    const candidates = [
      { solution: makeSolution([pushStep("up"), walkStep("down"), pushStep("left")]), discoveryOrder: 0 },
      { solution: makeSolution([pushStep("right")]), discoveryOrder: 1 },
      { solution: makeSolution([pushStep("down"), pushStep("up")]), discoveryOrder: 2 },
    ];
    const best = selectBest(candidates);
    assert.equal(best.moves, 1);
  });

  it("selectBest breaks ties on pushes", () => {
    const fewerPushes = makeSolution([pushStep("up"), walkStep("down")]);
    const morePushes = makeSolution([pushStep("left"), pushStep("right")]);
    const candidates = [
      { solution: morePushes, discoveryOrder: 0 },
      { solution: fewerPushes, discoveryOrder: 1 },
    ];
    const best = selectBest(candidates);
    assert.equal(best.pushes, 1);
  });

  it("selectBest breaks ties on discoveryOrder", () => {
    const candidates = [
      { solution: makeSolution([pushStep("up")]), discoveryOrder: 5 },
      { solution: makeSolution([pushStep("down")]), discoveryOrder: 2 },
    ];
    const best = selectBest(candidates);
    assert.equal(best.steps[0].direction, "down");
  });

  it("prioritizes a different box-goal basin over a nearby route", () => {
    const collector = new IncumbentCollector(4);
    const best = makeSolution([pushStep("up")]);
    const nearby = makeSolution([pushStep("down"), walkStep("up")]);
    const differentBasin = makeSolution([
      pushStep("left"),
      walkStep("right"),
      walkStep("up"),
    ]);
    collector.offer(best, { pushChain: "p1", boxGoals: "g1" });
    collector.offer(nearby, { pushChain: "p2", boxGoals: "g1" });
    collector.offer(differentBasin, { pushChain: "p3", boxGoals: "g2" });

    const selected = selectForRewrite(collector.incumbents);

    assert.equal(selected[0]?.solution, best);
    assert.equal(selected[1]?.solution, differentBasin);
  });

  it("uses pushes as the secondary improvement objective", () => {
    const morePushes = makeSolution([pushStep("up"), pushStep("down")]);
    const fewerPushes = makeSolution(
      [pushStep("left"), walkStep("right")],
      { pushes: 1 },
    );
    assert.equal(isSolutionBetter(fewerPushes, morePushes), true);
    assert.equal(isSolutionBetter(morePushes, fewerPushes), false);
  });
});
