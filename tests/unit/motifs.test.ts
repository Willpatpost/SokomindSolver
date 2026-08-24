import assert from "node:assert/strict";
import test from "node:test";

import {
  generateBlueprintWithRetry,
  assignRoomRoles,
  placeGoals,
  placeGoalsWithMotif,
  reverseBeamSearch,
  toSolvedTemplate,
  evaluatePuzzles,
  summarizePopulation,
  DEFAULT_BLUEPRINT_PARAMS,
  DEFAULT_GOAL_PARAMS,
  DEFAULT_BEAM_PARAMS,
  MOTIF_TYPES,
  type MotifType,
  type MotifPlacementResult,
  type PopulationSummary,
} from "../../src/features/generator/v2/index.ts";

import { buildPuzzleFromScramble } from "../../src/features/generator/generate-puzzle.ts";
import { validatePuzzle } from "../../src/core/puzzle.ts";
import type { PuzzleDefinition } from "../../src/core/model.ts";

// ---------------------------------------------------------------------------
// Helper: generate a blueprint suitable for motif testing
// ---------------------------------------------------------------------------

function buildBlueprint(seed: number, family: "linear" | "hub" | "loop" | "branch" | "nested" = "linear") {
  const bp = generateBlueprintWithRetry(
    { ...DEFAULT_BLUEPRINT_PARAMS, seed, family, boardWidth: 14, boardHeight: 14 },
    30,
  );
  if (!bp) return null;
  return assignRoomRoles(bp, seed, 3);
}

function buildMotifPuzzle(
  result: MotifPlacementResult,
  seed: number,
  maxDepth: number = 25,
): PuzzleDefinition | null {
  const template = toSolvedTemplate(result.solved);
  const beam = reverseBeamSearch(result.solved, { ...DEFAULT_BEAM_PARAMS, seed, maxDepth });
  if (beam.best.depth === 0) return null;

  const scrambled = {
    template,
    boxPositions: beam.best.boxPositions as Array<{ row: number; column: number }>,
    robotPosition: beam.best.robotPosition,
    reversePulls: beam.best.depth,
  };
  const puzzle = buildPuzzleFromScramble(scrambled, "intermediate");
  const valid = validatePuzzle(puzzle);
  if (!valid.valid) return null;
  return { ...puzzle, id: `motif-${result.motif}-${seed}` };
}

// ---------------------------------------------------------------------------
// 1. Motif system returns results for each motif type
// ---------------------------------------------------------------------------

test("motifs: each motif type produces a result on suitable blueprints", () => {
  let successes = 0;
  for (const motif of MOTIF_TYPES) {
    for (let seed = 100; seed < 150; seed++) {
      const fb = buildBlueprint(seed);
      if (!fb) continue;

      const result = placeGoalsWithMotif(fb, { seed, boxCount: 3, motif });
      if (result) {
        assert.equal(result.motif, motif);
        assert.ok(result.solved.goals.length === 3);
        assert.ok(result.hints.length > 0, `${motif} should produce hints`);
        successes++;
        break;
      }
    }
  }
  assert.ok(successes >= 2, `at least 2 motif types should succeed, got ${successes}`);
});

// ---------------------------------------------------------------------------
// 2. Determinism — same seed, same result
// ---------------------------------------------------------------------------

test("motifs: deterministic for same seed", () => {
  for (let seed = 200; seed < 230; seed++) {
    const fb = buildBlueprint(seed);
    if (!fb) continue;

    const a = placeGoalsWithMotif(fb, { seed, boxCount: 3, motif: "auto" });
    const b = placeGoalsWithMotif(fb, { seed, boxCount: 3, motif: "auto" });

    if (!a || !b) continue;

    assert.equal(a.motif, b.motif);
    assert.equal(a.solved.goals.length, b.solved.goals.length);
    for (let i = 0; i < a.solved.goals.length; i++) {
      assert.equal(a.solved.goals[i].row, b.solved.goals[i].row);
      assert.equal(a.solved.goals[i].column, b.solved.goals[i].column);
    }
    assert.equal(a.solved.robotPosition.row, b.solved.robotPosition.row);
    assert.equal(a.solved.robotPosition.column, b.solved.robotPosition.column);
    return;
  }
  assert.fail("no blueprint succeeded for determinism test");
});

// ---------------------------------------------------------------------------
// 3. Different seeds produce different motif selections
// ---------------------------------------------------------------------------

test("motifs: different seeds can produce different motif types", () => {
  const motifSet = new Set<MotifType>();
  for (let seed = 300; seed < 400; seed++) {
    const fb = buildBlueprint(seed, seed % 2 === 0 ? "linear" : "hub");
    if (!fb) continue;

    const result = placeGoalsWithMotif(fb, { seed, boxCount: 3, motif: "auto" });
    if (result) motifSet.add(result.motif);
    if (motifSet.size >= 2) break;
  }
  assert.ok(motifSet.size >= 2, `should get ≥2 distinct motif types, got ${motifSet.size}: ${[...motifSet]}`);
});

// ---------------------------------------------------------------------------
// 4. Packing order: goals have depth gradient
// ---------------------------------------------------------------------------

test("motifs: packing-order creates depth gradient", () => {
  for (let seed = 400; seed < 450; seed++) {
    const fb = buildBlueprint(seed);
    if (!fb) continue;

    const result = placeGoalsWithMotif(fb, { seed, boxCount: 3, motif: "packing-order" });
    if (!result) continue;

    const depths = result.solved.goals.map((g) => g.depthFromDoorway);
    const maxDepth = Math.max(...depths);
    const minDepth = Math.min(...depths);

    assert.ok(maxDepth - minDepth >= 1,
      `packing-order should have depth gradient ≥1, got ${maxDepth}-${minDepth}=${maxDepth - minDepth}`);
    assert.ok(result.hints.some((h) => h.type === "ordering"));
    return;
  }
  assert.fail("no blueprint produced a packing-order result");
});

// ---------------------------------------------------------------------------
// 5. Doorway traffic: goals in multiple rooms
// ---------------------------------------------------------------------------

test("motifs: doorway-traffic places goals in multiple rooms", () => {
  for (let seed = 500; seed < 600; seed++) {
    const fb = buildBlueprint(seed, seed % 3 === 0 ? "hub" : "linear");
    if (!fb) continue;

    const result = placeGoalsWithMotif(fb, { seed, boxCount: 3, motif: "doorway-traffic" });
    if (!result) continue;

    const roomIds = new Set(result.solved.goals.map((g) => g.roomId));
    assert.ok(roomIds.size >= 2,
      `doorway-traffic should span ≥2 rooms, got ${roomIds.size}`);
    assert.ok(result.hints.some((h) => h.type === "traffic"));
    return;
  }
  assert.fail("no blueprint produced a doorway-traffic result");
});

// ---------------------------------------------------------------------------
// 6. Staging dep: hints describe path interference
// ---------------------------------------------------------------------------

test("motifs: staging-dep creates path interference", () => {
  for (let seed = 600; seed < 700; seed++) {
    const fb = buildBlueprint(seed);
    if (!fb) continue;

    const result = placeGoalsWithMotif(fb, { seed, boxCount: 3, motif: "staging-dep" });
    if (!result) continue;

    assert.ok(result.hints.some((h) => h.type === "staging"));
    assert.ok(result.solved.goals.length === 3);

    const depths = result.solved.goals.map((g) => g.depthFromDoorway);
    assert.ok(Math.max(...depths) >= 2, "staging-dep needs depth ≥ 2 for the deep goal");
    return;
  }
  assert.fail("no blueprint produced a staging-dep result");
});

// ---------------------------------------------------------------------------
// 7. Gatekeeper: one goal near passage, rest in far room
// ---------------------------------------------------------------------------

test("motifs: gatekeeper places gate goal near passage", () => {
  for (let seed = 700; seed < 800; seed++) {
    const fb = buildBlueprint(seed, "linear");
    if (!fb) continue;

    const result = placeGoalsWithMotif(fb, { seed, boxCount: 3, motif: "gatekeeper" });
    if (!result) continue;

    assert.ok(result.hints.some((h) => h.type === "gatekeeper"));
    const roomIds = new Set(result.solved.goals.map((g) => g.roomId));
    assert.ok(roomIds.size >= 2, "gatekeeper should place goals in ≥2 rooms");
    return;
  }
  assert.fail("no blueprint produced a gatekeeper result");
});

// ---------------------------------------------------------------------------
// 8. All motif results produce valid puzzles via beam search
// ---------------------------------------------------------------------------

test("motifs: motif placements produce solvable puzzles", () => {
  let validCount = 0;
  for (const motif of MOTIF_TYPES) {
    for (let seed = 800; seed < 850; seed++) {
      const fb = buildBlueprint(seed);
      if (!fb) continue;

      const result = placeGoalsWithMotif(fb, { seed, boxCount: 3, motif });
      if (!result) continue;

      const puzzle = buildMotifPuzzle(result, seed);
      if (!puzzle) continue;

      const validation = validatePuzzle(puzzle);
      assert.ok(validation.valid, `${motif} puzzle should be valid`);
      validCount++;
      break;
    }
  }
  assert.ok(validCount >= 2, `at least 2 motif types should produce valid puzzles, got ${validCount}`);
});

// ---------------------------------------------------------------------------
// 9. Auto selection picks appropriate motif
// ---------------------------------------------------------------------------

test("motifs: auto selection picks a motif", () => {
  for (let seed = 900; seed < 930; seed++) {
    const fb = buildBlueprint(seed);
    if (!fb) continue;

    const result = placeGoalsWithMotif(fb, { seed, boxCount: 3, motif: "auto" });
    if (!result) continue;

    assert.ok(MOTIF_TYPES.includes(result.motif), `auto should pick a valid motif type, got ${result.motif}`);
    return;
  }
  assert.fail("auto selection failed on all seeds");
});

// ---------------------------------------------------------------------------
// 10. Goal count matches boxCount
// ---------------------------------------------------------------------------

test("motifs: goal count matches boxCount for various counts", () => {
  for (const boxCount of [2, 3, 4]) {
    for (let seed = 1000; seed < 1050; seed++) {
      const fb = buildBlueprint(seed);
      if (!fb) continue;

      const result = placeGoalsWithMotif(fb, { seed, boxCount, motif: "packing-order" });
      if (!result) continue;

      assert.equal(result.solved.goals.length, boxCount,
        `motif should place exactly ${boxCount} goals`);
      break;
    }
  }
});

// ---------------------------------------------------------------------------
// 11. Robot position is not on a goal
// ---------------------------------------------------------------------------

test("motifs: robot not on any goal", () => {
  for (let seed = 1100; seed < 1130; seed++) {
    const fb = buildBlueprint(seed);
    if (!fb) continue;

    const result = placeGoalsWithMotif(fb, { seed, boxCount: 3, motif: "auto" });
    if (!result) continue;

    const goalKeys = new Set(result.solved.goals.map((g) => `${g.row},${g.column}`));
    const robotKey = `${result.solved.robotPosition.row},${result.solved.robotPosition.column}`;
    assert.ok(!goalKeys.has(robotKey), "robot should not be placed on a goal");
    return;
  }
  assert.fail("no seed produced a motif result");
});

// ---------------------------------------------------------------------------
// 12. ASCII visualization of motif placement
// ---------------------------------------------------------------------------

test("motifs: ASCII demo of packing-order", async () => {
  const { solvedBlueprintToAscii } = await import("../../src/features/generator/v2/index.ts");

  for (let seed = 1200; seed < 1250; seed++) {
    const fb = buildBlueprint(seed);
    if (!fb) continue;

    const result = placeGoalsWithMotif(fb, { seed, boxCount: 3, motif: "packing-order" });
    if (!result) continue;

    const ascii = solvedBlueprintToAscii(result.solved);
    assert.ok(ascii.includes("*"), "ASCII should show goals");
    assert.ok(ascii.includes("R"), "ASCII should show robot");
    assert.ok(ascii.includes("O"), "ASCII should show walls");

    const depths = result.solved.goals.map((g) => g.depthFromDoorway);
    console.log(`\n  Packing-order motif (seed=${seed}):`);
    console.log(`  Goal depths: ${depths.join(", ")}`);
    console.log(`  Hints: ${result.hints.map((h) => h.description).join("; ")}`);
    console.log(`  ${ascii.split("\n").join("\n  ")}`);
    return;
  }
});

// ---------------------------------------------------------------------------
// 13. Motif success rate across seeds
// ---------------------------------------------------------------------------

test("motifs: success rate per motif type", () => {
  const stats: Record<string, { tried: number; succeeded: number }> = {};
  for (const motif of MOTIF_TYPES) {
    stats[motif] = { tried: 0, succeeded: 0 };
  }

  for (let seed = 1300; seed < 1400; seed++) {
    for (const family of ["linear", "hub", "loop", "branch"] as const) {
      const fb = buildBlueprint(seed, family);
      if (!fb) continue;

      for (const motif of MOTIF_TYPES) {
        stats[motif].tried++;
        const result = placeGoalsWithMotif(fb, { seed, boxCount: 3, motif });
        if (result) stats[motif].succeeded++;
      }
    }
  }

  console.log("\n  Motif success rates:");
  for (const motif of MOTIF_TYPES) {
    const s = stats[motif];
    const rate = s.tried > 0 ? (s.succeeded / s.tried * 100).toFixed(1) : "0.0";
    console.log(`  ${motif.padEnd(20)} ${s.succeeded}/${s.tried} (${rate}%)`);
  }

  const totalSuccess = Object.values(stats).reduce((sum, s) => sum + s.succeeded, 0);
  assert.ok(totalSuccess > 0, "at least some motifs should succeed");
});

// ---------------------------------------------------------------------------
// 14. Cross-population benchmark
// ---------------------------------------------------------------------------

test("benchmark: motif vs no-motif vs handcrafted", async () => {
  const handcrafted: PuzzleDefinition[] = [
    {
      id: "hc-1", title: "Three in a Row", difficulty: "beginner", boxes: 3,
      rows: ["OOOOOOOO", "O R    O", "O XXXO O", "O SSSO O", "O      O", "OOOOOOOO"],
    },
    {
      id: "hc-2", title: "The Detour", difficulty: "beginner", boxes: 2,
      rows: ["OOOOOOOO", "OR     O", "OOOO X O", "OS   X O", "OS     O", "OOOOOOOO"],
    },
    {
      id: "hc-3", title: "Tiny Teaser", difficulty: "beginner", boxes: 2,
      rows: ["OOOOO", "OSX O", "O XRO", "O  SO", "OOOOO"],
    },
    {
      id: "hc-4", title: "Corner Lesson", difficulty: "tutorial", boxes: 1,
      rows: ["OOOOOO", "O    O", "O RX O", "O  S O", "O    O", "OOOOOO"],
    },
    {
      id: "hc-5", title: "Go Around", difficulty: "tutorial", boxes: 1,
      rows: ["OOOOOOO", "OR    O", "OOOOX O", "O   S O", "OOOOOOO"],
    },
  ];

  const noMotifPuzzles: PuzzleDefinition[] = [];
  const motifPuzzles: Record<MotifType, PuzzleDefinition[]> = {
    "packing-order": [],
    "doorway-traffic": [],
    "staging-dep": [],
    "gatekeeper": [],
  };
  const mixedMotifPuzzles: PuzzleDefinition[] = [];

  const targetPerCategory = 5;

  for (let seed = 2000; seed < 2100; seed++) {
    const bpParams = { ...DEFAULT_BLUEPRINT_PARAMS, seed, family: "linear" as const, boardWidth: 14, boardHeight: 14 };
    const bp = generateBlueprintWithRetry(bpParams, 30);
    if (!bp) continue;
    const fb = assignRoomRoles(bp, seed, 3);

    // No-motif (standard placeGoals)
    if (noMotifPuzzles.length < targetPerCategory) {
      const solved = placeGoals(fb, { ...DEFAULT_GOAL_PARAMS, seed, boxCount: 3 });
      if (solved) {
        const template = toSolvedTemplate(solved);
        const beam = reverseBeamSearch(solved, { ...DEFAULT_BEAM_PARAMS, seed, maxDepth: 25 });
        if (beam.best.depth > 0) {
          const scrambled = {
            template,
            boxPositions: beam.best.boxPositions as Array<{ row: number; column: number }>,
            robotPosition: beam.best.robotPosition,
            reversePulls: beam.best.depth,
          };
          const puzzle = buildPuzzleFromScramble(scrambled, "intermediate");
          const valid = validatePuzzle(puzzle);
          if (valid.valid) {
            noMotifPuzzles.push({ ...puzzle, id: `no-motif-${seed}` });
          }
        }
      }
    }

    // Per-motif
    for (const motif of MOTIF_TYPES) {
      if (motifPuzzles[motif].length >= targetPerCategory) continue;
      const result = placeGoalsWithMotif(fb, { seed, boxCount: 3, motif });
      if (!result) continue;
      const puzzle = buildMotifPuzzle(result, seed);
      if (puzzle) {
        motifPuzzles[motif].push({ ...puzzle, id: `${motif}-${seed}` });
      }
    }

    // Mixed motif (auto)
    if (mixedMotifPuzzles.length < targetPerCategory) {
      const result = placeGoalsWithMotif(fb, { seed, boxCount: 3, motif: "auto" });
      if (result) {
        const puzzle = buildMotifPuzzle(result, seed);
        if (puzzle) {
          mixedMotifPuzzles.push({ ...puzzle, id: `mixed-${seed}` });
        }
      }
    }
  }

  // Evaluate all populations
  const hcVecs = await evaluatePuzzles(handcrafted);
  const noMotifVecs = await evaluatePuzzles(noMotifPuzzles);
  const mixedVecs = await evaluatePuzzles(mixedMotifPuzzles);

  const perMotifVecs: Record<string, Awaited<ReturnType<typeof evaluatePuzzles>>> = {};
  for (const motif of MOTIF_TYPES) {
    if (motifPuzzles[motif].length > 0) {
      perMotifVecs[motif] = await evaluatePuzzles(motifPuzzles[motif]);
    }
  }

  const hcSummary = summarizePopulation(hcVecs);
  const noMotifSummary = summarizePopulation(noMotifVecs);
  const mixedSummary = summarizePopulation(mixedVecs);

  const perMotifSummary: Record<string, PopulationSummary> = {};
  for (const motif of MOTIF_TYPES) {
    if (perMotifVecs[motif]?.length) {
      perMotifSummary[motif] = summarizePopulation(perMotifVecs[motif]);
    }
  }

  function fmt(n: number): string { return n.toFixed(2); }

  const keys: (keyof PopulationSummary["avg"])[] = [
    "boxIndependenceRatio",
    "boxInteractionEvents",
    "pushesPerBox",
    "solutionMoves",
    "solutionPushes",
    "solverExpandedStates",
    "avgLegalPushes",
    "singleChoiceRatio",
    "roomCrossingsInSolution",
    "emptyWalkRatio",
    "longestWalkStreak",
    "forcedPushRatio",
    "repetitivePushRatio",
    "unusedFloorRatio",
    "movesPerPush",
    "deadlockDensity",
    "totalFloor",
  ];

  // Build column headers
  const motifCols = MOTIF_TYPES.filter((m) => perMotifSummary[m]);
  const allCols = ["Handcrafted", "No Motif", ...motifCols.map((m) => m.slice(0, 12)), "Mixed"];

  console.log("\n  Sprint 6 Cross-Population Benchmark:");
  console.log(`  ${"Metric".padEnd(28)} ${allCols.map((c) => c.padStart(12)).join(" ")}`);
  console.log(`  ${"─".repeat(28)} ${allCols.map(() => "─".repeat(12)).join(" ")}`);

  for (const key of keys) {
    const vals = [
      hcSummary.avg[key] ?? 0,
      noMotifSummary.avg[key] ?? 0,
      ...motifCols.map((m) => perMotifSummary[m]?.avg[key] ?? 0),
      mixedSummary.avg[key] ?? 0,
    ];
    console.log(`  ${String(key).padEnd(28)} ${vals.map((v) => fmt(v).padStart(12)).join(" ")}`);
  }

  console.log(`  ${"─".repeat(28)} ${allCols.map(() => "─".repeat(12)).join(" ")}`);
  const solvedRow = [
    `${hcSummary.solvedCount}/${hcSummary.count}`,
    `${noMotifSummary.solvedCount}/${noMotifSummary.count}`,
    ...motifCols.map((m) => `${perMotifSummary[m]?.solvedCount ?? 0}/${perMotifSummary[m]?.count ?? 0}`),
    `${mixedSummary.solvedCount}/${mixedSummary.count}`,
  ];
  console.log(`  ${"solved/total".padEnd(28)} ${solvedRow.map((s) => s.padStart(12)).join(" ")}`);

  // Assertions
  assert.ok(hcSummary.solvedCount >= 3, "most handcrafted should solve");
  assert.ok(noMotifPuzzles.length > 0, "should have no-motif puzzles");
  console.log(`\n  Puzzle counts: HC=${handcrafted.length}, NoMotif=${noMotifPuzzles.length}, ` +
    `${MOTIF_TYPES.map((m) => `${m}=${motifPuzzles[m].length}`).join(", ")}, Mixed=${mixedMotifPuzzles.length}`);
});

// ---------------------------------------------------------------------------
// 15. Motif hints are well-formed
// ---------------------------------------------------------------------------

test("motifs: hints have valid structure", () => {
  for (let seed = 1500; seed < 1530; seed++) {
    const fb = buildBlueprint(seed);
    if (!fb) continue;

    const result = placeGoalsWithMotif(fb, { seed, boxCount: 3, motif: "auto" });
    if (!result) continue;

    for (const hint of result.hints) {
      assert.ok(typeof hint.type === "string" && hint.type.length > 0);
      assert.ok(typeof hint.description === "string" && hint.description.length > 0);
      assert.ok(Array.isArray(hint.involvedGoalIndices));
      for (const idx of hint.involvedGoalIndices) {
        assert.ok(idx >= 0 && idx < result.solved.goals.length,
          `goal index ${idx} out of range [0, ${result.solved.goals.length})`);
      }
    }
    return;
  }
  assert.fail("no seed produced a motif result for hint validation");
});

// ---------------------------------------------------------------------------
// 16. Motif placements pass puzzle validation
// ---------------------------------------------------------------------------

test("motifs: solved blueprints have valid goal positions", () => {
  let checked = 0;
  for (let seed = 1600; seed < 1650; seed++) {
    const fb = buildBlueprint(seed);
    if (!fb) continue;

    const result = placeGoalsWithMotif(fb, { seed, boxCount: 3, motif: "auto" });
    if (!result) continue;

    const { solved } = result;

    for (const goal of solved.goals) {
      assert.ok(goal.row > 0 && goal.row < solved.grid.length - 1, "goal not on border");
      assert.ok(goal.column > 0 && goal.column < solved.grid[0].length - 1, "goal not on border");
      assert.notEqual(solved.grid[goal.row][goal.column], "O", "goal not on wall");
    }

    const goalKeys = new Set(solved.goals.map((g) => `${g.row},${g.column}`));
    assert.equal(goalKeys.size, solved.goals.length, "no duplicate goal positions");

    checked++;
    if (checked >= 5) return;
  }
  assert.ok(checked > 0, "should validate at least one motif placement");
});
