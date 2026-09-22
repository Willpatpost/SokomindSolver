import assert from "node:assert/strict";
import test from "node:test";

import {
  mechanismCombinationKey,
  buildMechanismCoverage,
  enumerateFeasiblePairs,
  coverageGap,
  selectMechanismsWithCoverage,
  mechanismCompatibility,
} from "../../src/features/generator/v2/index.ts";
import type { MechanismType, FunctionalBlueprint } from "../../src/features/generator/v2/index.ts";

function makeMinimalBlueprint(): FunctionalBlueprint {
  return {
    rooms: [
      { id: 0, x: 0, y: 0, width: 4, height: 3, isTerminal: true, label: "A" },
      { id: 1, x: 5, y: 0, width: 4, height: 3, isTerminal: false, label: "B" },
    ],
    passages: [{ from: 0, to: 1, width: 1, cells: [{ row: 1, col: 4 }] }],
    width: 10,
    height: 5,
  } as unknown as FunctionalBlueprint;
}

// ---------------------------------------------------------------------------
// 1. mechanismCombinationKey is order-independent
// ---------------------------------------------------------------------------

test("mechanismCombinationKey is order-independent", () => {
  const k1 = mechanismCombinationKey(["gatekeeper", "packing-chain"]);
  const k2 = mechanismCombinationKey(["packing-chain", "gatekeeper"]);
  assert.equal(k1, k2);
});

// ---------------------------------------------------------------------------
// 2. buildMechanismCoverage tallies attempts and successes
// ---------------------------------------------------------------------------

test("buildMechanismCoverage tallies attempts and successes", () => {
  const entries = [
    { mechanisms: ["gatekeeper" as MechanismType], succeeded: true },
    { mechanisms: ["gatekeeper" as MechanismType], succeeded: false },
    { mechanisms: ["packing-chain" as MechanismType], succeeded: true },
    { mechanisms: ["gatekeeper" as MechanismType, "packing-chain" as MechanismType], succeeded: false },
  ];

  const coverage = buildMechanismCoverage(entries);
  const gk = coverage.get(mechanismCombinationKey(["gatekeeper"]))!;
  assert.equal(gk.attempts, 2);
  assert.equal(gk.successes, 1);

  const pc = coverage.get(mechanismCombinationKey(["packing-chain"]))!;
  assert.equal(pc.attempts, 1);
  assert.equal(pc.successes, 1);

  const pair = coverage.get(mechanismCombinationKey(["gatekeeper", "packing-chain"]))!;
  assert.equal(pair.attempts, 1);
  assert.equal(pair.successes, 0);
});

// ---------------------------------------------------------------------------
// 3. enumerateFeasiblePairs produces correct pair count
// ---------------------------------------------------------------------------

test("enumerateFeasiblePairs produces correct pair count", () => {
  const types: MechanismType[] = ["gatekeeper", "packing-chain", "staging-dependency"];
  const pairs = enumerateFeasiblePairs(types);
  assert.equal(pairs.length, 3);
  const keys = new Set(pairs.map(([a, b]) => mechanismCombinationKey([a, b])));
  assert.equal(keys.size, 3);
});

// ---------------------------------------------------------------------------
// 4. coverageGap surfaces untried combinations first
// ---------------------------------------------------------------------------

test("coverageGap surfaces untried combinations first", () => {
  const types: MechanismType[] = ["gatekeeper", "packing-chain", "staging-dependency"];
  const coverage = buildMechanismCoverage([
    { mechanisms: ["gatekeeper"], succeeded: true },
    { mechanisms: ["gatekeeper"], succeeded: true },
    { mechanisms: ["gatekeeper"], succeeded: false },
    { mechanisms: ["packing-chain"], succeeded: true },
  ]);

  const gaps = coverageGap(types, coverage);
  assert.ok(gaps[0].attempts === 0, "untried combinations should sort first");
  assert.ok(gaps[gaps.length - 1].attempts > 0, "tried combinations should sort last");
});

// ---------------------------------------------------------------------------
// 5. selectMechanismsWithCoverage prefers unexplored mechanisms
// ---------------------------------------------------------------------------

test("selectMechanismsWithCoverage prefers unexplored mechanisms", () => {
  const feasible: MechanismType[] = ["gatekeeper", "packing-chain", "staging-dependency"];

  const heavilyCovered = buildMechanismCoverage(
    Array.from({ length: 50 }, () => ({ mechanisms: ["gatekeeper" as MechanismType], succeeded: true })),
  );

  const seed = 100;
  const counts: Record<string, number> = {};
  for (let i = 0; i < 100; i++) {
    const rng = mulberry32(seed + i);
    const selected = selectMechanismsWithCoverage(feasible, 1, makeMinimalBlueprint(), rng, heavilyCovered);
    for (const m of selected) counts[m] = (counts[m] ?? 0) + 1;
  }

  assert.ok(
    (counts["packing-chain"] ?? 0) + (counts["staging-dependency"] ?? 0) > (counts["gatekeeper"] ?? 0),
    `unexplored mechanisms should be chosen more often than heavily-covered ones; got ${JSON.stringify(counts)}`,
  );
});

// ---------------------------------------------------------------------------
// 6. selectMechanismsWithCoverage still respects compatibility
// ---------------------------------------------------------------------------

test("selectMechanismsWithCoverage still respects compatibility", () => {
  const feasible: MechanismType[] = ["gatekeeper", "packing-chain", "gate-reopening"];
  const emptyCoverage = new Map();

  const seed = 42;
  const pairCounts: Record<string, number> = {};
  for (let i = 0; i < 100; i++) {
    const rng = mulberry32(seed + i);
    const selected = selectMechanismsWithCoverage(feasible, 2, makeMinimalBlueprint(), rng, emptyCoverage);
    if (selected.length === 2) {
      const key = mechanismCombinationKey(selected);
      pairCounts[key] = (pairCounts[key] ?? 0) + 1;
    }
  }

  const gkGrCompat = mechanismCompatibility("gatekeeper", "gate-reopening");
  const gkPcCompat = mechanismCompatibility("gatekeeper", "packing-chain");
  assert.ok(gkGrCompat < gkPcCompat, "test setup: gk+gr should be less compatible than gk+pc");
  assert.ok(Object.keys(pairCounts).length >= 2, `should produce at least 2 distinct pair types, got ${JSON.stringify(pairCounts)}`);
});

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
