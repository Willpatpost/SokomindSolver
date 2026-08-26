import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateFinalist,
  computeCurationObjectives,
  nonDominatedSort,
  computeNoveltyScores,
  selectByParetoNovelty,
  diagnosePopulation,
  evaluatePuzzle,
  type CurationObjectives,
} from "../../src/features/generator/v2/index.ts";

import { PUZZLE_BY_ID } from "../../src/catalog/puzzles.ts";

// ---------------------------------------------------------------------------
// Finalist evaluator tests
// ---------------------------------------------------------------------------

test("evaluateFinalist returns evidence from multiple solvers", async () => {
  const puzzle = PUZZLE_BY_ID["ultra-tiny"];
  assert.ok(puzzle);

  const result = await evaluateFinalist(puzzle);

  assert.ok(result.solversAttempted >= 2, "should attempt >= 2 solvers");
  assert.ok(result.solversSucceeded >= 1, "at least one solver should succeed");
  assert.ok(result.solverEvidence.length >= 2, "should have evidence from each solver");

  for (const ev of result.solverEvidence) {
    assert.equal(typeof ev.solverId, "string");
    assert.equal(typeof ev.status, "string");
    if (ev.status === "solved") {
      assert.equal(typeof ev.moves, "number");
      assert.equal(typeof ev.pushes, "number");
      assert.ok(ev.moves! > 0);
      assert.ok(ev.pushes! > 0);
    }
  }
});

test("evaluateFinalist returns agreement when solvers find same solution length", async () => {
  const puzzle = PUZZLE_BY_ID["ultra-tiny"];
  assert.ok(puzzle);

  const result = await evaluateFinalist(puzzle);

  if (result.solversSucceeded >= 2) {
    assert.equal(typeof result.solverAgreement, "boolean");
  }
  assert.ok(result.minMoves > 0);
  assert.ok(result.maxMoves >= result.minMoves);
  assert.ok(result.minPushes > 0);
  assert.ok(result.maxPushes >= result.minPushes);
});

test("evaluateFinalist respects config limits", async () => {
  const puzzle = PUZZLE_BY_ID["ultra-tiny"];
  assert.ok(puzzle);

  const result = await evaluateFinalist(puzzle, {
    maxElapsedMs: 1_000,
    maxExpandedStates: 100_000,
  });

  assert.ok(result.solverEvidence.length >= 2);
});

// ---------------------------------------------------------------------------
// Curation objectives tests
// ---------------------------------------------------------------------------

test("computeCurationObjectives produces bounded values", async () => {
  const puzzle = PUZZLE_BY_ID["ultra-tiny"];
  assert.ok(puzzle);

  const ev = await evaluatePuzzle(puzzle);
  const finalist = await evaluateFinalist(puzzle);
  const objectives = computeCurationObjectives(ev, finalist);

  assert.equal(typeof objectives.interaction, "number");
  assert.equal(typeof objectives.dependency, "number");
  assert.equal(typeof objectives.decisionQuality, "number");
  assert.equal(typeof objectives.structuralRichness, "number");
  assert.equal(typeof objectives.solverChallenge, "number");
  assert.equal(typeof objectives.tedium, "number");
  assert.equal(typeof objectives.novelty, "number");

  assert.ok(Number.isFinite(objectives.interaction));
  assert.ok(Number.isFinite(objectives.dependency));
  assert.ok(Number.isFinite(objectives.decisionQuality));
  assert.ok(Number.isFinite(objectives.structuralRichness));
  assert.ok(Number.isFinite(objectives.solverChallenge));
  assert.ok(Number.isFinite(objectives.tedium));
});

// ---------------------------------------------------------------------------
// Non-dominated sorting tests
// ---------------------------------------------------------------------------

test("nonDominatedSort assigns front 0 to non-dominated candidates", () => {
  const items = [
    {
      item: "A",
      objectives: { interaction: 1, dependency: 1, decisionQuality: 1, structuralRichness: 1, solverChallenge: 1, novelty: 0, tedium: 0 } as CurationObjectives,
    },
    {
      item: "B",
      objectives: { interaction: 0.5, dependency: 0.5, decisionQuality: 0.5, structuralRichness: 0.5, solverChallenge: 0.5, novelty: 0, tedium: 0.5 } as CurationObjectives,
    },
    {
      item: "C",
      objectives: { interaction: 0, dependency: 0, decisionQuality: 0, structuralRichness: 0, solverChallenge: 0, novelty: 0, tedium: 1 } as CurationObjectives,
    },
  ];

  const sorted = nonDominatedSort(items);

  assert.equal(sorted.length, 3);
  const frontA = sorted.find((c) => c.item === "A")!.front;
  const frontB = sorted.find((c) => c.item === "B")!.front;
  const frontC = sorted.find((c) => c.item === "C")!.front;

  assert.equal(frontA, 0, "A dominates all, should be front 0");
  assert.ok(frontB > frontA, "B is dominated by A");
  assert.ok(frontC >= frontB, "C is dominated by A and B");
});

test("nonDominatedSort puts mutually non-dominated items on same front", () => {
  const items = [
    {
      item: "X",
      objectives: { interaction: 1, dependency: 0, decisionQuality: 0.5, structuralRichness: 0.5, solverChallenge: 0.5, novelty: 0, tedium: 0.5 } as CurationObjectives,
    },
    {
      item: "Y",
      objectives: { interaction: 0, dependency: 1, decisionQuality: 0.5, structuralRichness: 0.5, solverChallenge: 0.5, novelty: 0, tedium: 0.5 } as CurationObjectives,
    },
  ];

  const sorted = nonDominatedSort(items);
  const frontX = sorted.find((c) => c.item === "X")!.front;
  const frontY = sorted.find((c) => c.item === "Y")!.front;

  assert.equal(frontX, frontY, "mutually non-dominated items share a front");
  assert.equal(frontX, 0);
});

test("nonDominatedSort handles empty input", () => {
  const sorted = nonDominatedSort([]);
  assert.equal(sorted.length, 0);
});

test("nonDominatedSort handles single item", () => {
  const items = [
    {
      item: "only",
      objectives: { interaction: 0.5, dependency: 0.5, decisionQuality: 0.5, structuralRichness: 0.5, solverChallenge: 0.5, novelty: 0, tedium: 0.5 } as CurationObjectives,
    },
  ];

  const sorted = nonDominatedSort(items);
  assert.equal(sorted.length, 1);
  assert.equal(sorted[0].front, 0);
});

// ---------------------------------------------------------------------------
// Novelty scoring tests
// ---------------------------------------------------------------------------

test("computeNoveltyScores assigns higher novelty to distant candidates", () => {
  const items = [
    {
      item: "close1",
      objectives: { interaction: 0.5, dependency: 0.5, decisionQuality: 0.5, structuralRichness: 0.5, solverChallenge: 0.5, novelty: 0, tedium: 0.5 } as CurationObjectives,
      front: 0,
      noveltyScore: 0,
    },
    {
      item: "close2",
      objectives: { interaction: 0.51, dependency: 0.51, decisionQuality: 0.51, structuralRichness: 0.51, solverChallenge: 0.51, novelty: 0, tedium: 0.49 } as CurationObjectives,
      front: 0,
      noveltyScore: 0,
    },
    {
      item: "far",
      objectives: { interaction: 5, dependency: 5, decisionQuality: 5, structuralRichness: 5, solverChallenge: 5, novelty: 0, tedium: 0 } as CurationObjectives,
      front: 0,
      noveltyScore: 0,
    },
  ];

  const scored = computeNoveltyScores(items);
  const farScore = scored.find((c) => c.item === "far")!.noveltyScore;
  const close1Score = scored.find((c) => c.item === "close1")!.noveltyScore;

  assert.ok(farScore > close1Score, "distant candidate should have higher novelty");
});

test("computeNoveltyScores handles single candidate", () => {
  const items = [
    {
      item: "solo",
      objectives: { interaction: 1, dependency: 1, decisionQuality: 1, structuralRichness: 1, solverChallenge: 1, novelty: 0, tedium: 0 } as CurationObjectives,
      front: 0,
      noveltyScore: 0,
    },
  ];

  const scored = computeNoveltyScores(items);
  assert.equal(scored.length, 1);
  assert.equal(scored[0].noveltyScore, 0);
});

// ---------------------------------------------------------------------------
// Selection tests
// ---------------------------------------------------------------------------

test("selectByParetoNovelty respects quota", () => {
  const items = Array.from({ length: 10 }, (_, i) => ({
    item: `item-${i}`,
    objectives: {
      interaction: i / 10,
      dependency: i / 10,
      decisionQuality: i / 10,
      structuralRichness: i / 10,
      solverChallenge: i / 10,
      novelty: 0,
      tedium: (10 - i) / 10,
    } as CurationObjectives,
    front: 0,
    noveltyScore: i * 0.1,
  }));

  const selected = selectByParetoNovelty(items, 5);
  assert.equal(selected.length, 5);
});

test("selectByParetoNovelty returns all when quota exceeds candidates", () => {
  const items = [
    {
      item: "only",
      objectives: { interaction: 1, dependency: 1, decisionQuality: 1, structuralRichness: 1, solverChallenge: 1, novelty: 0, tedium: 0 } as CurationObjectives,
      front: 0,
      noveltyScore: 1,
    },
  ];

  const selected = selectByParetoNovelty(items, 10);
  assert.equal(selected.length, 1);
});

test("selectByParetoNovelty prefers front 0 over front 1", () => {
  const items = [
    {
      item: "front0",
      objectives: { interaction: 1, dependency: 1, decisionQuality: 1, structuralRichness: 1, solverChallenge: 1, novelty: 0, tedium: 0 } as CurationObjectives,
      front: 0,
      noveltyScore: 0.5,
    },
    {
      item: "front1",
      objectives: { interaction: 0.5, dependency: 0.5, decisionQuality: 0.5, structuralRichness: 0.5, solverChallenge: 0.5, novelty: 0, tedium: 0.5 } as CurationObjectives,
      front: 1,
      noveltyScore: 1.0,
    },
  ];

  const selected = selectByParetoNovelty(items, 1);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].item, "front0");
});

// ---------------------------------------------------------------------------
// Population diagnostics tests
// ---------------------------------------------------------------------------

test("diagnosePopulation reports correct statistics", () => {
  const items = nonDominatedSort([
    {
      item: "A",
      objectives: { interaction: 1, dependency: 1, decisionQuality: 1, structuralRichness: 1, solverChallenge: 1, novelty: 0, tedium: 0 } as CurationObjectives,
    },
    {
      item: "B",
      objectives: { interaction: 0, dependency: 0, decisionQuality: 0, structuralRichness: 0, solverChallenge: 0, novelty: 0, tedium: 1 } as CurationObjectives,
    },
  ]);

  const diag = diagnosePopulation(items);
  assert.equal(diag.totalCandidates, 2);
  assert.ok(diag.frontCount >= 1);
  assert.ok(diag.frontSizes.length >= 1);
  assert.equal(
    diag.frontSizes.reduce((s, n) => s + n, 0),
    2,
    "front sizes should sum to total",
  );

  assert.ok(diag.objectiveRanges.interaction.max >= diag.objectiveRanges.interaction.min);
  assert.ok(diag.objectiveRanges.tedium.max >= diag.objectiveRanges.tedium.min);
});

test("diagnosePopulation handles empty population", () => {
  const diag = diagnosePopulation([]);
  assert.equal(diag.totalCandidates, 0);
  assert.equal(diag.frontCount, 0);
  assert.equal(diag.frontSizes.length, 0);
});
