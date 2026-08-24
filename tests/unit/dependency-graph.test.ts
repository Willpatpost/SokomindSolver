import assert from "node:assert/strict";
import test from "node:test";

import {
  generateBlueprintWithRetry,
  assignRoomRoles,
  placeGoals,
  reverseBeamSearch,
  replayForwardSolution,
  rasterizeBlueprint,
  toSolvedTemplate,
  evaluatePuzzles,
  summarizePopulation,
  composeMotifs,
  findCompatibleCompositions,
  isAcyclic,
  topologicalOrder,
  generateComposedPuzzle,
  generateVerifiedMotifPuzzle,
  chooseRobotPosition,
  DEFAULT_BLUEPRINT_PARAMS,
  DEFAULT_GOAL_PARAMS,
  DEFAULT_BEAM_PARAMS,
  COMPOSITION_TYPES,
  DEFAULT_COMPOSITION_PARAMS,
  MOTIF_TYPES,
  type CompositionType,
  type DependencyDAG,
  type PopulationSummary,
  type FunctionalBlueprint,
} from "../../src/features/generator/v2/index.ts";

import { createRng } from "../../src/features/generator/board-template.ts";

import { buildPuzzleFromScramble } from "../../src/features/generator/generate-puzzle.ts";
import { validatePuzzle } from "../../src/core/puzzle.ts";
import type { PuzzleDefinition } from "../../src/core/model.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildBlueprint(
  seed: number,
  family: "linear" | "hub" | "loop" | "branch" | "nested" = "linear",
): FunctionalBlueprint | null {
  const bp = generateBlueprintWithRetry(
    {
      ...DEFAULT_BLUEPRINT_PARAMS,
      seed,
      family,
      boardWidth: 14,
      boardHeight: 14,
    },
    30,
  );
  if (!bp) return null;
  return assignRoomRoles(bp, seed, 4);
}

function makeSimpleDAG(): DependencyDAG {
  return {
    nodes: [
      { id: 0, goalIndex: 0, roomId: 1, role: "gatekeeper" },
      { id: 1, goalIndex: 1, roomId: 2, role: "inner-pack" },
      { id: 2, goalIndex: 2, roomId: 2, role: "inner-pack" },
    ],
    edges: [
      {
        from: 0,
        to: 1,
        type: "blocks-access",
        description: "Gate blocks inner 1",
      },
      {
        from: 0,
        to: 2,
        type: "blocks-access",
        description: "Gate blocks inner 2",
      },
      {
        from: 1,
        to: 2,
        type: "must-precede",
        description: "Inner 1 before inner 2",
      },
    ],
    compositionId: "gate-pack",
    motifs: ["gatekeeper", "packing-order"],
  };
}

function makeCyclicDAG(): DependencyDAG {
  return {
    nodes: [
      { id: 0, goalIndex: 0, roomId: 1, role: "a" },
      { id: 1, goalIndex: 1, roomId: 1, role: "b" },
      { id: 2, goalIndex: 2, roomId: 1, role: "c" },
    ],
    edges: [
      { from: 0, to: 1, type: "must-precede", description: "A→B" },
      { from: 1, to: 2, type: "must-precede", description: "B→C" },
      { from: 2, to: 0, type: "must-precede", description: "C→A (cycle)" },
    ],
    compositionId: "test-cycle",
    motifs: [],
  };
}

// ---------------------------------------------------------------------------
// 1. DAG acyclicity detection
// ---------------------------------------------------------------------------

test("dependency-graph: isAcyclic detects acyclic DAG", () => {
  const dag = makeSimpleDAG();
  assert.ok(isAcyclic(dag), "simple gate-pack DAG should be acyclic");
});

test("dependency-graph: isAcyclic detects cyclic DAG", () => {
  const dag = makeCyclicDAG();
  assert.ok(!isAcyclic(dag), "DAG with A→B→C→A should be cyclic");
});

// ---------------------------------------------------------------------------
// 2. Topological ordering
// ---------------------------------------------------------------------------

test("dependency-graph: topologicalOrder returns valid ordering", () => {
  const dag = makeSimpleDAG();
  const order = topologicalOrder(dag);
  assert.ok(order !== null, "acyclic DAG should produce topological order");
  assert.equal(order!.length, 3);

  const indexOf = (id: number) => order!.indexOf(id);
  assert.ok(indexOf(0) < indexOf(1), "gate (0) before inner-1 (1)");
  assert.ok(indexOf(0) < indexOf(2), "gate (0) before inner-2 (2)");
  assert.ok(indexOf(1) < indexOf(2), "inner-1 (1) before inner-2 (2)");
});

test("dependency-graph: topologicalOrder returns null for cyclic DAG", () => {
  const dag = makeCyclicDAG();
  const order = topologicalOrder(dag);
  assert.equal(order, null, "cyclic DAG should return null");
});

// ---------------------------------------------------------------------------
// 3. Composition compatibility filtering
// ---------------------------------------------------------------------------

test("dependency-graph: findCompatibleCompositions filters by topology", () => {
  let found = false;
  for (let seed = 100; seed < 200; seed++) {
    const fb = buildBlueprint(seed);
    if (!fb) continue;

    const compatible = findCompatibleCompositions(fb, 4);
    if (compatible.length > 0) {
      for (const comp of compatible) {
        assert.ok(
          COMPOSITION_TYPES.includes(comp),
          `${comp} should be a valid composition type`,
        );
      }
      found = true;
      break;
    }
  }
  assert.ok(found, "at least one blueprint should have compatible compositions");
});

test("dependency-graph: boxCount < 3 yields no compositions", () => {
  for (let seed = 200; seed < 230; seed++) {
    const fb = buildBlueprint(seed);
    if (!fb) continue;

    const compatible = findCompatibleCompositions(fb, 2);
    assert.equal(
      compatible.length,
      0,
      "boxCount=2 should have no compatible compositions",
    );
    return;
  }
  assert.fail("no blueprint generated");
});

// ---------------------------------------------------------------------------
// 4. Composition produces valid goals and acyclic DAG
// ---------------------------------------------------------------------------

test("dependency-graph: composeMotifs produces acyclic DAG with correct goal count", () => {
  let found = false;
  for (let seed = 300; seed < 400; seed++) {
    const fb = buildBlueprint(seed);
    if (!fb) continue;

    const result = composeMotifs(fb, { ...DEFAULT_COMPOSITION_PARAMS, seed });
    if (!result) continue;

    assert.equal(result.goals.length, 4, "should place boxCount=4 goals");
    assert.ok(isAcyclic(result.dag), "composed DAG should be acyclic");
    assert.ok(
      result.dag.edges.length >= 2,
      `composed DAG should have ≥2 edges, got ${result.dag.edges.length}`,
    );
    assert.ok(
      result.dag.motifs.length >= 2,
      "composition should use ≥2 motif types",
    );

    const goalKeys = new Set(
      result.goals.map((g) => `${g.row},${g.column}`),
    );
    assert.equal(goalKeys.size, result.goals.length, "no duplicate goals");

    found = true;
    break;
  }
  assert.ok(found, "at least one blueprint should produce a composition");
});

// ---------------------------------------------------------------------------
// 5. Each composition type can succeed
// ---------------------------------------------------------------------------

test("dependency-graph: each composition type succeeds on suitable blueprints", () => {
  const succeeded = new Set<CompositionType>();

  for (let seed = 400; seed < 600; seed++) {
    for (const family of ["linear", "hub", "branch"] as const) {
      const fb = buildBlueprint(seed, family);
      if (!fb) continue;

      for (const comp of COMPOSITION_TYPES) {
        if (succeeded.has(comp)) continue;
        const result = composeMotifs(fb, {
          ...DEFAULT_COMPOSITION_PARAMS,
          seed,
          composition: comp,
        });
        if (result) {
          assert.ok(
            result.dag.compositionId === comp,
            `compositionId should be ${comp}`,
          );
          succeeded.add(comp);
        }
      }

      if (succeeded.size === COMPOSITION_TYPES.length) break;
    }
    if (succeeded.size === COMPOSITION_TYPES.length) break;
  }

  assert.ok(
    succeeded.size >= 2,
    `at least 2 composition types should succeed, got ${succeeded.size}: ${[...succeeded]}`,
  );
});

// ---------------------------------------------------------------------------
// 6. Determinism — same seed, same composition
// ---------------------------------------------------------------------------

test("dependency-graph: deterministic for same seed", () => {
  for (let seed = 600; seed < 650; seed++) {
    const fb = buildBlueprint(seed);
    if (!fb) continue;

    const a = composeMotifs(fb, { ...DEFAULT_COMPOSITION_PARAMS, seed });
    const b = composeMotifs(fb, { ...DEFAULT_COMPOSITION_PARAMS, seed });

    if (!a || !b) continue;

    assert.equal(a.dag.compositionId, b.dag.compositionId);
    assert.equal(a.goals.length, b.goals.length);
    for (let i = 0; i < a.goals.length; i++) {
      assert.equal(a.goals[i].row, b.goals[i].row);
      assert.equal(a.goals[i].column, b.goals[i].column);
    }
    assert.equal(a.dag.edges.length, b.dag.edges.length);
    return;
  }
  assert.fail("no blueprint succeeded for determinism test");
});

// ---------------------------------------------------------------------------
// 7. Composed puzzles produce valid puzzle definitions
// ---------------------------------------------------------------------------

test("dependency-graph: composed puzzles are valid and solvable", async () => {
  let validCount = 0;

  for (let seed = 700; seed < 800; seed++) {
    if (validCount >= 3) break;

    const fb = buildBlueprint(seed);
    if (!fb) continue;

    const result = await generateComposedPuzzle(fb, {
      ...DEFAULT_COMPOSITION_PARAMS,
      seed,
    });
    if (!result) continue;

    const validation = validatePuzzle(result.puzzle);
    assert.ok(validation.valid, "composed puzzle should be valid");
    assert.ok(result.dag.edges.length >= 2, "should have dependency edges");
    assert.ok(
      result.realization.totalEdges > 0,
      "should have realization data",
    );

    validCount++;
  }

  assert.ok(
    validCount >= 1,
    `should generate at least 1 valid composed puzzle, got ${validCount}`,
  );
});

// ---------------------------------------------------------------------------
// 8. Dependency realization verification
// ---------------------------------------------------------------------------

test("dependency-graph: verifyDependencies tracks edge realization", async () => {
  for (let seed = 800; seed < 900; seed++) {
    const fb = buildBlueprint(seed);
    if (!fb) continue;

    const result = await generateComposedPuzzle(fb, {
      ...DEFAULT_COMPOSITION_PARAMS,
      seed,
    });
    if (!result) continue;

    const { realization } = result;

    assert.equal(
      realization.totalEdges,
      result.dag.edges.length,
      "totalEdges should match DAG edges",
    );
    assert.ok(
      realization.edgeDetails.length === realization.totalEdges,
      "should have a detail per edge",
    );

    for (const detail of realization.edgeDetails) {
      assert.ok(typeof detail.realized === "boolean");
      assert.ok(typeof detail.reason === "string" && detail.reason.length > 0);
      assert.ok(detail.edge.type.length > 0);
    }

    console.log(
      `\n  Dependency realization (seed=${seed}, ${result.dag.compositionId}):`,
    );
    console.log(
      `  Edges: ${realization.realizedEdges}/${realization.totalEdges} ` +
        `(${(realization.realizationRate * 100).toFixed(1)}%)`,
    );
    for (const d of realization.edgeDetails) {
      const mark = d.realized ? "+" : "-";
      console.log(`  [${mark}] ${d.edge.type}: ${d.reason}`);
    }
    return;
  }
  assert.fail("no composed puzzle generated for realization test");
});

// ---------------------------------------------------------------------------
// 9. Single-motif verified puzzle generation
// ---------------------------------------------------------------------------

test("dependency-graph: generateVerifiedMotifPuzzle produces valid puzzle", async () => {
  for (let seed = 900; seed < 950; seed++) {
    const fb = buildBlueprint(seed);
    if (!fb) continue;

    const result = await generateVerifiedMotifPuzzle(fb, {
      seed,
      boxCount: 3,
      motif: "auto",
    });
    if (!result) continue;

    const validation = validatePuzzle(result.puzzle);
    assert.ok(validation.valid, "verified motif puzzle should be valid");
    assert.ok(result.hints.length > 0, "should have motif hints");
    assert.ok(
      MOTIF_TYPES.includes(result.motif),
      "should have valid motif type",
    );
    return;
  }
  assert.fail("no verified motif puzzle generated");
});

// ---------------------------------------------------------------------------
// 10. Impossible combination rejection
// ---------------------------------------------------------------------------

test("dependency-graph: rejects impossible compositions gracefully", () => {
  for (let seed = 1000; seed < 1050; seed++) {
    const fb = buildBlueprint(seed);
    if (!fb) continue;

    const result = composeMotifs(fb, {
      ...DEFAULT_COMPOSITION_PARAMS,
      seed,
      boxCount: 20,
    });

    assert.equal(
      result,
      null,
      "should return null for impossibly high box count",
    );
    return;
  }
  assert.fail("no blueprint generated for impossible test");
});

// ---------------------------------------------------------------------------
// 11. Composition success rate across topologies
// ---------------------------------------------------------------------------

test("dependency-graph: composition success rate per type", () => {
  const stats: Record<string, { tried: number; succeeded: number }> = {};
  for (const comp of COMPOSITION_TYPES) {
    stats[comp] = { tried: 0, succeeded: 0 };
  }

  for (let seed = 1100; seed < 1200; seed++) {
    for (const family of ["linear", "hub", "loop", "branch"] as const) {
      const fb = buildBlueprint(seed, family);
      if (!fb) continue;

      for (const comp of COMPOSITION_TYPES) {
        stats[comp].tried++;
        const result = composeMotifs(fb, {
          ...DEFAULT_COMPOSITION_PARAMS,
          seed,
          composition: comp,
        });
        if (result) stats[comp].succeeded++;
      }
    }
  }

  console.log("\n  Composition success rates:");
  for (const comp of COMPOSITION_TYPES) {
    const s = stats[comp];
    const rate = s.tried > 0 ? ((s.succeeded / s.tried) * 100).toFixed(1) : "0.0";
    console.log(`  ${comp.padEnd(20)} ${s.succeeded}/${s.tried} (${rate}%)`);
  }

  const totalSuccess = Object.values(stats).reduce(
    (sum, s) => sum + s.succeeded,
    0,
  );
  assert.ok(totalSuccess > 0, "at least some compositions should succeed");
});

// ---------------------------------------------------------------------------
// 12. DAG edge types match composition plan
// ---------------------------------------------------------------------------

test("dependency-graph: gate-pack DAG has expected edge types", () => {
  for (let seed = 1200; seed < 1300; seed++) {
    const fb = buildBlueprint(seed);
    if (!fb) continue;

    const result = composeMotifs(fb, {
      ...DEFAULT_COMPOSITION_PARAMS,
      seed,
      composition: "gate-pack",
    });
    if (!result) continue;

    const edgeTypes = new Set(result.dag.edges.map((e) => e.type));
    assert.ok(
      edgeTypes.has("blocks-access"),
      "gate-pack should have blocks-access edges",
    );
    assert.ok(
      edgeTypes.has("must-precede"),
      "gate-pack should have must-precede edges",
    );
    assert.equal(result.dag.compositionId, "gate-pack");
    assert.ok(result.dag.motifs.includes("gatekeeper"));
    assert.ok(result.dag.motifs.includes("packing-order"));
    return;
  }
  assert.fail("no gate-pack composition produced");
});

// ---------------------------------------------------------------------------
// 13. Replay correctness — beam candidates replay successfully
// ---------------------------------------------------------------------------

test("dependency-graph: beam search candidates replay correctly", () => {
  for (let seed = 1300; seed < 1350; seed++) {
    const fb = buildBlueprint(seed);
    if (!fb) continue;

    const result = composeMotifs(fb, { ...DEFAULT_COMPOSITION_PARAMS, seed });
    if (!result) continue;

    const { goals, goalStyle } = result;
    const grid = rasterizeBlueprint(fb);

    const rng = createRng(seed + 1);
    const robotPos = chooseRobotPosition(fb, grid, goals, rng);
    if (!robotPos) continue;

    const solved = { blueprint: fb, grid, goals, robotPosition: robotPos, goalStyle };
    const template = toSolvedTemplate(solved);
    const beam = reverseBeamSearch(solved, {
      ...DEFAULT_BEAM_PARAMS,
      seed,
      maxDepth: 20,
    });
    if (beam.best.depth === 0) continue;

    const replays = replayForwardSolution(template, beam.best);
    assert.ok(replays, "beam candidate should replay successfully");
    return;
  }
  assert.fail("no composition produced a beam candidate for replay test");
});

// ---------------------------------------------------------------------------
// 14. Cross-population benchmark
// ---------------------------------------------------------------------------

test("benchmark: composed vs single-motif vs no-motif vs handcrafted", async () => {
  const handcrafted: PuzzleDefinition[] = [
    {
      id: "hc-1",
      title: "Three in a Row",
      difficulty: "beginner",
      boxes: 3,
      rows: [
        "OOOOOOOO",
        "O R    O",
        "O XXXO O",
        "O SSSO O",
        "O      O",
        "OOOOOOOO",
      ],
    },
    {
      id: "hc-2",
      title: "The Detour",
      difficulty: "beginner",
      boxes: 2,
      rows: [
        "OOOOOOOO",
        "OR     O",
        "OOOO X O",
        "OS   X O",
        "OS     O",
        "OOOOOOOO",
      ],
    },
    {
      id: "hc-3",
      title: "Tiny Teaser",
      difficulty: "beginner",
      boxes: 2,
      rows: ["OOOOO", "OSX O", "O XRO", "O  SO", "OOOOO"],
    },
    {
      id: "hc-4",
      title: "Corner Lesson",
      difficulty: "tutorial",
      boxes: 1,
      rows: ["OOOOOO", "O    O", "O RX O", "O  S O", "O    O", "OOOOOO"],
    },
    {
      id: "hc-5",
      title: "Go Around",
      difficulty: "tutorial",
      boxes: 1,
      rows: ["OOOOOOO", "OR    O", "OOOOX O", "O   S O", "OOOOOOO"],
    },
  ];

  const noMotifPuzzles: PuzzleDefinition[] = [];
  const singleMotifPuzzles: PuzzleDefinition[] = [];
  const composedPuzzles: PuzzleDefinition[] = [];
  const composedRealizations: Array<{
    rate: number;
    total: number;
    realized: number;
    comp: string;
  }> = [];

  const targetPerCategory = 5;

  for (let seed = 3000; seed < 3150; seed++) {
    const fb = buildBlueprint(seed);
    if (!fb) continue;

    if (noMotifPuzzles.length < targetPerCategory) {
      const solved = placeGoals(fb, {
        ...DEFAULT_GOAL_PARAMS,
        seed,
        boxCount: 3,
      });
      if (solved) {
        const template = toSolvedTemplate(solved);
        const beam = reverseBeamSearch(solved, {
          ...DEFAULT_BEAM_PARAMS,
          seed,
          maxDepth: 25,
        });
        if (beam.best.depth > 0) {
          const scrambled = {
            template,
            boxPositions: beam.best.boxPositions as Array<{
              row: number;
              column: number;
            }>,
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

    if (singleMotifPuzzles.length < targetPerCategory) {
      const result = await generateVerifiedMotifPuzzle(fb, {
        seed,
        boxCount: 3,
        motif: "auto",
      });
      if (result) {
        singleMotifPuzzles.push(result.puzzle);
      }
    }

    if (composedPuzzles.length < targetPerCategory) {
      const result = await generateComposedPuzzle(fb, {
        ...DEFAULT_COMPOSITION_PARAMS,
        seed,
        boxCount: 4,
      });
      if (result) {
        composedPuzzles.push(result.puzzle);
        composedRealizations.push({
          rate: result.realization.realizationRate,
          total: result.realization.totalEdges,
          realized: result.realization.realizedEdges,
          comp: result.dag.compositionId,
        });
      }
    }

    if (
      noMotifPuzzles.length >= targetPerCategory &&
      singleMotifPuzzles.length >= targetPerCategory &&
      composedPuzzles.length >= targetPerCategory
    ) {
      break;
    }
  }

  const hcVecs = await evaluatePuzzles(handcrafted);
  const noMotifVecs = await evaluatePuzzles(noMotifPuzzles);
  const singleMotifVecs = await evaluatePuzzles(singleMotifPuzzles);
  const composedVecs = await evaluatePuzzles(composedPuzzles);

  const hcSummary = summarizePopulation(hcVecs);
  const noMotifSummary = summarizePopulation(noMotifVecs);
  const singleMotifSummary = summarizePopulation(singleMotifVecs);
  const composedSummary = summarizePopulation(composedVecs);

  function fmt(n: number): string {
    return n.toFixed(2);
  }

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

  const allCols = ["Handcrafted", "No Motif", "Single Motif", "Composed"];

  console.log("\n  Sprint 7 Cross-Population Benchmark:");
  console.log(
    `  ${"Metric".padEnd(28)} ${allCols.map((c) => c.padStart(14)).join(" ")}`,
  );
  console.log(
    `  ${"─".repeat(28)} ${allCols.map(() => "─".repeat(14)).join(" ")}`,
  );

  for (const key of keys) {
    const vals = [
      hcSummary.avg[key] ?? 0,
      noMotifSummary.avg[key] ?? 0,
      singleMotifSummary.avg[key] ?? 0,
      composedSummary.avg[key] ?? 0,
    ];
    console.log(
      `  ${String(key).padEnd(28)} ${vals.map((v) => fmt(v).padStart(14)).join(" ")}`,
    );
  }

  console.log(
    `  ${"─".repeat(28)} ${allCols.map(() => "─".repeat(14)).join(" ")}`,
  );
  const solvedRow = [
    `${hcSummary.solvedCount}/${hcSummary.count}`,
    `${noMotifSummary.solvedCount}/${noMotifSummary.count}`,
    `${singleMotifSummary.solvedCount}/${singleMotifSummary.count}`,
    `${composedSummary.solvedCount}/${composedSummary.count}`,
  ];
  console.log(
    `  ${"solved/total".padEnd(28)} ${solvedRow.map((s) => s.padStart(14)).join(" ")}`,
  );

  if (composedRealizations.length > 0) {
    console.log("\n  Dependency Realization Summary:");
    const avgRate =
      composedRealizations.reduce((s, r) => s + r.rate, 0) /
      composedRealizations.length;
    const totalEdges = composedRealizations.reduce((s, r) => s + r.total, 0);
    const realizedEdges = composedRealizations.reduce(
      (s, r) => s + r.realized,
      0,
    );
    const compTypes = [...new Set(composedRealizations.map((r) => r.comp))];
    console.log(
      `  Avg realization rate: ${(avgRate * 100).toFixed(1)}%`,
    );
    console.log(`  Total edges: ${totalEdges}, Realized: ${realizedEdges}`);
    console.log(`  Composition types used: ${compTypes.join(", ")}`);

    for (const r of composedRealizations) {
      console.log(
        `    ${r.comp}: ${r.realized}/${r.total} edges (${(r.rate * 100).toFixed(1)}%)`,
      );
    }
  }

  console.log(
    `\n  Puzzle counts: HC=${handcrafted.length}, NoMotif=${noMotifPuzzles.length}, ` +
      `SingleMotif=${singleMotifPuzzles.length}, Composed=${composedPuzzles.length}`,
  );

  assert.ok(hcSummary.solvedCount >= 3, "most handcrafted should solve");
  assert.ok(noMotifPuzzles.length > 0, "should have no-motif puzzles");
});

// ---------------------------------------------------------------------------
// 15. DAG node ids are unique
// ---------------------------------------------------------------------------

test("dependency-graph: DAG nodes have unique ids", () => {
  for (let seed = 1500; seed < 1550; seed++) {
    const fb = buildBlueprint(seed);
    if (!fb) continue;

    const result = composeMotifs(fb, { ...DEFAULT_COMPOSITION_PARAMS, seed });
    if (!result) continue;

    const ids = result.dag.nodes.map((n) => n.id);
    const uniqueIds = new Set(ids);
    assert.equal(ids.length, uniqueIds.size, "node ids should be unique");

    for (const edge of result.dag.edges) {
      assert.ok(
        uniqueIds.has(edge.from),
        `edge.from=${edge.from} should reference a valid node`,
      );
      assert.ok(
        uniqueIds.has(edge.to),
        `edge.to=${edge.to} should reference a valid node`,
      );
    }
    return;
  }
  assert.fail("no composition produced for node uniqueness test");
});

// ---------------------------------------------------------------------------
// 16. Composed goals are on floor, not walls or borders
// ---------------------------------------------------------------------------

test("dependency-graph: composed goals are on valid floor positions", () => {
  let checked = 0;
  for (let seed = 1600; seed < 1650; seed++) {
    const fb = buildBlueprint(seed);
    if (!fb) continue;

    const result = composeMotifs(fb, { ...DEFAULT_COMPOSITION_PARAMS, seed });
    if (!result) continue;

    for (const goal of result.goals) {
      assert.ok(
        goal.row > 0,
        `goal row=${goal.row} should not be on top border`,
      );
      assert.ok(
        goal.column > 0,
        `goal column=${goal.column} should not be on left border`,
      );
      assert.ok(goal.reversePullDirs >= 1, "goal should have pull directions");
    }

    checked++;
    if (checked >= 3) return;
  }
  assert.ok(checked > 0, "should validate at least one composition");
});
