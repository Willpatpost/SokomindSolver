/**
 * Seeded differential fuzz of the exact move engines (ACTION-ITEMS P8.8).
 *
 * The fixed-seed campaign runs 100 generated boards through exact A* and
 * IDA* and compares every result with an independent BFS oracle. The long
 * campaign is `npm run test:solver:fuzz`
 * (tests/performance/solver-exact-fuzz.test.ts).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parsePuzzleRows } from "../../src/core/index.ts";
import {
  TUNNEL_SOUNDNESS_BY_ID,
  TUNNEL_SOUNDNESS_FIXTURES,
} from "../fixtures/solver-v2/tunnel-soundness.ts";
import {
  FUZZ_ENGINES,
  FUZZ_FAILURE_KINDS,
  FUZZ_LABEL_MODES,
  FUZZ_LAYOUTS,
  FUZZ_PLACEMENTS,
  FUZZ_VARIANTS,
  MAX_FUZZ_FLOOR,
  classifyFuzzRun,
  formatFuzzFailure,
  fuzzOracle,
  generateFuzzBoard,
  minimizeFuzzBoard,
  runFuzzCampaign,
  runFuzzEngine,
  summarizeFuzzCampaign,
  type FuzzFailureKind,
  type FuzzRun,
  type FuzzRunPlan,
} from "../support/exact-fuzz.ts";

const ROTATED_VARIANTS = FUZZ_VARIANTS.slice(1);

/**
 * Two runs per board keep the campaign under a minute (the deadlock-table
 * build dominates each run): default features on one engine and one rotated
 * variant on the other. There are 11 rotated variants, an odd number, so each
 * variant switches engines from one turn to the next.
 */
function unitPlans(boardIndex: number): FuzzRunPlan[] {
  return [
    { engine: FUZZ_ENGINES[boardIndex % 2], variant: FUZZ_VARIANTS[0] },
    {
      engine: FUZZ_ENGINES[(boardIndex + 1) % 2],
      variant: ROTATED_VARIANTS[boardIndex % ROTATED_VARIANTS.length],
    },
  ];
}

function fuzzRun(overrides: Partial<FuzzRun>): FuzzRun {
  return {
    engine: "astar",
    variant: "default",
    features: {},
    status: "unsolved",
    reason: "limit-reached",
    expandedStates: 0,
    counters: {},
    ...overrides,
  };
}

function oracleMoves(rows: readonly string[]): number | null {
  const oracle = fuzzOracle(rows, 1_000_000);
  assert.equal(oracle.capped, false);
  return oracle.moves;
}

function boxSymbols(rows: readonly string[]): string[] {
  return [...rows.join("")].filter((symbol) => /^[A-Z]$/.test(symbol) && !"ORS".includes(symbol));
}

describe("exact fuzz oracle", () => {
  it("matches the independent move optimum of every tunnel-soundness board", () => {
    for (const fixture of TUNNEL_SOUNDNESS_FIXTURES) {
      assert.equal(oracleMoves(fixture.rows), fixture.moves, fixture.id);
    }
  });

  it("reports unsolvable boards and state caps", () => {
    // The X box starts in a corner and never moves, so the search visits the
    // 9 robot cells and stops.
    assert.deepEqual(
      fuzzOracle(["OOOOOOO", "OX   SO", "O  R  O", "OOOOOOO"], 1_000),
      { moves: null, capped: false, states: 9 },
    );
    // A 22-move optimum needs more than 10 states.
    const capped = fuzzOracle(TUNNEL_SOUNDNESS_BY_ID.es01d.rows, 10);
    assert.equal(capped.capped, true);
    assert.equal(capped.moves, null);
  });

  it("rejects symbols outside the board format", () => {
    assert.throws(() => fuzzOracle(["OOOOO", "ORX?O", "OOSOO"], 100), /unsupported symbol/);
  });
});

describe("exact fuzz classifier", () => {
  it("flags the pre-fix P0.1 results on ES-01, fz-corridor, fz-unsolvable and es01a", () => {
    // The `preFix` results of the tunnel-soundness fixtures, against this
    // harness's own oracle.
    const es01 = oracleMoves(TUNNEL_SOUNDNESS_BY_ID.es01.rows);
    assert.equal(es01, 9);
    assert.equal(classifyFuzzRun(fuzzRun({
      status: "solved",
      reason: undefined,
      moves: 12,
      optimality: "proven",
      proofKind: "optimal",
      lowerBound: 12,
      upperBound: 12,
    }), es01), "WRONG_PROVEN_OPTIMUM");
    assert.equal(classifyFuzzRun(fuzzRun({
      status: "solved",
      reason: undefined,
      moves: 12,
      optimality: "proven",
      proofKind: "optimal",
    }), oracleMoves(TUNNEL_SOUNDNESS_BY_ID["fz-corridor"].rows)), "WRONG_PROVEN_OPTIMUM");
    for (const id of ["fz-unsolvable", "es01a"] as const) {
      assert.equal(classifyFuzzRun(fuzzRun({
        variant: id === "es01a" ? "no-forcedPushMacros" : "default",
        reason: "exhausted",
        proofKind: "unsolvable",
      }), oracleMoves(TUNNEL_SOUNDNESS_BY_ID[id].rows)), "FALSE_UNSOLVABLE", id);
    }
  });

  it("names every failure kind", () => {
    const solved = { status: "solved", reason: undefined } as const;
    const cases: readonly [FuzzRun, number | null, FuzzFailureKind][] = [
      [fuzzRun({ status: "error", reason: undefined, error: "TypeError: boom" }), 9, "ENGINE_ERROR"],
      [fuzzRun({ status: "cancelled", reason: undefined }), 9, "ENGINE_ERROR"],
      [fuzzRun({ reason: "unsupported" }), null, "ENGINE_ERROR"],
      [fuzzRun({ ...solved, moves: 9, optimality: "proven", replayError: "replayActionLog: blocked" }), 9,
        "REPLAY_MISMATCH"],
      [fuzzRun({ ...solved, moves: 9, optimality: "unknown" }), null, "FALSE_SOLVABLE"],
      [fuzzRun({ ...solved, moves: 8, optimality: "unknown" }), 9, "BEATS_ORACLE"],
      [fuzzRun({ ...solved, moves: 10, optimality: "unknown", upperBound: 8 }), 9, "BEATS_ORACLE"],
      [fuzzRun({ ...solved, moves: 10, optimality: "proven", proofKind: "optimal" }), 9, "WRONG_PROVEN_OPTIMUM"],
      [fuzzRun({ ...solved, moves: 10, optimality: "unknown", proofKind: "optimal" }), 9, "WRONG_PROVEN_OPTIMUM"],
      [fuzzRun({ reason: "exhausted", proofKind: "unsolvable" }), 15, "FALSE_UNSOLVABLE"],
      [fuzzRun({ reason: "exhausted" }), 15, "FALSE_UNSOLVABLE"],
      [fuzzRun({ lowerBound: 10, proofKind: "bounded" }), 9, "LOWER_BOUND_ABOVE_OPTIMUM"],
      [fuzzRun({ ...solved, moves: 12, optimality: "unknown", lowerBound: 10, upperBound: 12 }), 9,
        "LOWER_BOUND_ABOVE_OPTIMUM"],
    ];
    for (const [run, oracle, kind] of cases) {
      assert.equal(classifyFuzzRun(run, oracle), kind, `${JSON.stringify(run)} oracle=${oracle}`);
    }
    assert.deepEqual([...new Set(cases.map(([, , kind]) => kind))].sort(), [...FUZZ_FAILURE_KINDS].sort());
  });

  it("treats bounds, limits and correct verdicts as passing", () => {
    const passing: readonly [FuzzRun, number | null][] = [
      [fuzzRun({}), 9],
      [fuzzRun({ lowerBound: 9, upperBound: Infinity, proofKind: "bounded" }), 9],
      [fuzzRun({}), null],
      [fuzzRun({ reason: "exhausted", proofKind: "unsolvable" }), null],
      [fuzzRun({ status: "solved", reason: undefined, moves: 12, optimality: "unknown", lowerBound: 7,
        upperBound: 12, proofKind: "bounded" }), 9],
      [fuzzRun({ status: "solved", reason: undefined, moves: 9, optimality: "proven", lowerBound: 9,
        upperBound: 9, proofKind: "optimal" }), 9],
    ];
    for (const [run, oracle] of passing) {
      assert.equal(classifyFuzzRun(run, oracle), null, `${JSON.stringify(run)} oracle=${oracle}`);
    }
  });
});

describe("exact fuzz engine runs", () => {
  it("replays and passes the current engines on ES-01 and fz-unsolvable", async () => {
    for (const id of ["es01", "fz-unsolvable"] as const) {
      const { rows, moves } = TUNNEL_SOUNDNESS_BY_ID[id];
      for (const engine of FUZZ_ENGINES) {
        for (const variant of FUZZ_VARIANTS.slice(0, 2)) {
          const run = await runFuzzEngine(engine, rows, variant, { maxExpandedStates: 200_000 });
          const label = `${id} ${engine} ${variant.name}`;
          assert.equal(classifyFuzzRun(run, moves), null, label);
          assert.equal(run.status, "solved", label);
          assert.equal(run.moves, moves, label);
          assert.equal(run.optimality, "proven", label);
          assert.equal(run.replayError, undefined, label);
        }
      }
    }
  });

  it("reports a throw inside the run as an error run", async () => {
    // The parser throws: one X box and no S goal.
    const run = await runFuzzEngine("astar", ["OOOO", "ORXO", "OOOO"], FUZZ_VARIANTS[0], {});
    assert.equal(run.status, "error");
    assert.match(run.error ?? "", /\S/);
    assert.equal(classifyFuzzRun(run, null), "ENGINE_ERROR");
  });
});

describe("exact fuzz generator", () => {
  it("is deterministic and builds legal, cropped boards", () => {
    const layouts = new Set<string>();
    const placements = new Set<string>();
    const labelModes = new Set<string>();
    const boxCounts = new Set<number>();
    let boards = 0;
    for (let seed = 1; seed <= 300; seed += 1) {
      const board = generateFuzzBoard(seed);
      assert.deepEqual(generateFuzzBoard(seed), board, `seed ${seed}`);
      if (!board) continue;
      boards += 1;
      layouts.add(board.layout);
      placements.add(board.placement);
      labelModes.add(board.labelMode);
      boxCounts.add(board.boxCount);
      const { rows } = board;
      const label = `seed ${seed} ${JSON.stringify(rows)}`;
      assert.equal(parsePuzzleRows([...rows]).initialBoxes.length, board.boxCount, label);
      assert.match(rows[0], /^O+$/, label);
      assert.match(rows[rows.length - 1], /^O+$/, label);
      assert.ok(rows.every((row) => row.length === rows[0].length && /^O.*O$/.test(row)), label);
      assert.ok([...rows.join("")].filter((symbol) => symbol !== "O").length <= MAX_FUZZ_FLOOR, label);
      const boxes = boxSymbols(rows);
      if (board.labelMode === "all-x") assert.ok(boxes.every((symbol) => symbol === "X"), label);
      if (board.labelMode === "typed") assert.equal(new Set(boxes).size, boxes.length, label);
      if (board.labelMode === "mixed") {
        assert.ok(boxes.includes("X") && boxes.some((symbol) => symbol !== "X"), label);
      }
      if (board.labelMode === "duplicate-typed") {
        assert.ok(boxes.filter((symbol) => symbol === "A").length >= 2, label);
      }
      if (board.placement === "reverse-pull") {
        const oracle = fuzzOracle(rows, 100_000);
        assert.ok(oracle.capped || oracle.moves !== null, `reverse-pull board is unsolvable: ${label}`);
      }
    }
    assert.ok(boards >= 100, `only ${boards} boards from 300 seeds`);
    assert.deepEqual([...layouts].sort(), [...FUZZ_LAYOUTS].sort());
    assert.deepEqual([...placements].sort(), [...FUZZ_PLACEMENTS].sort());
    assert.deepEqual([...labelModes].sort(), [...FUZZ_LABEL_MODES].sort());
    assert.deepEqual([...boxCounts].sort(), [1, 2, 3, 4]);
  });
});

describe("exact fuzz minimizer", () => {
  it("drops the boxes and floor a predicate does not need", async () => {
    const minimized = await minimizeFuzzBoard(
      ["OOOOOOO", "OR X SO", "O A  aO", "O B bOO", "OOOOOOO"],
      (rows) => rows.join("").includes("A"),
    );
    const symbols = [...minimized.join("")];
    assert.deepEqual(boxSymbols(minimized), ["A"]);
    assert.equal(symbols.filter((symbol) => symbol === "a").length, 1);
    assert.equal(symbols.filter((symbol) => symbol === "R").length, 1);
    assert.ok(!symbols.includes(" "), JSON.stringify(minimized));
    assert.doesNotThrow(() => parsePuzzleRows([...minimized]));
  });

  it("keeps an oracle verdict while shrinking", async () => {
    // X is stuck in a corner. Dropping A and a keeps the board unsolvable;
    // dropping X and S would leave A two pushes from a, so that is rejected.
    const rows = ["OOOOOOO", "OX  S O", "O  A aO", "O R   O", "OOOOOOO"];
    const unsolvable = async (candidate: readonly string[]) => fuzzOracle(candidate, 10_000).moves === null;
    assert.equal(await unsolvable(rows), true);
    const minimized = await minimizeFuzzBoard(rows, unsolvable);
    assert.equal(await unsolvable(minimized), true);
    assert.deepEqual(boxSymbols(minimized), ["X"]);
    assert.ok(!minimized.join("").includes(" "), JSON.stringify(minimized));
  });

  it("counts a throwing predicate as not failing", async () => {
    const rows = ["OOOOOO", "ORX SO", "OOOOOO"];
    const minimized = await minimizeFuzzBoard(rows, () => {
      throw new Error("predicate failed");
    });
    assert.deepEqual(minimized, rows);
  });
});

describe("exact fuzz fixed-seed campaign", () => {
  it("runs every variant on both engines over 100 boards", () => {
    const pairs = new Set<string>();
    for (let boardIndex = 0; boardIndex < 100; boardIndex += 1) {
      for (const { engine, variant } of unitPlans(boardIndex)) pairs.add(`${variant.name}/${engine}`);
    }
    assert.equal(pairs.size, FUZZ_VARIANTS.length * FUZZ_ENGINES.length);
  });

  it("finds no soundness failures on 100 seeded boards", async () => {
    const report = await runFuzzCampaign({
      firstSeed: 1,
      boards: 100,
      plansForBoard: unitPlans,
      // A state cap only, so every result is the same on every machine.
      limits: { maxExpandedStates: 20_000 },
      oracleMaxStates: 100_000,
      crossCheckMaxStates: 5_000,
      crossCheckLimit: 20,
    });
    const summary = summarizeFuzzCampaign(report);
    assert.deepEqual(report.failures.map(formatFuzzFailure), [], summary);
    assert.deepEqual(report.crossCheckMismatches, [], summary);
    assert.equal(report.reversePullUnsolvable, 0, summary);
    assert.equal(report.boards, 100, summary);
    assert.deepEqual(report.runsByEngine, { astar: 100, ida: 100 }, summary);

    // Non-vacuity: seed 1 gives 57 solvable and 43 unsolvable boards, and
    // every solvable run ends with a proven optimum.
    assert.ok(report.solvable >= 40, summary);
    assert.ok(report.unsolvable >= 25, summary);
    assert.ok(report.provenOptimal >= 80, summary);
    assert.ok(report.provenUnsolvable >= 50, summary);
    assert.ok(report.crossChecks >= 15, summary);
    for (const layout of FUZZ_LAYOUTS) assert.ok(report.byLayout[layout] > 0, `${layout}: ${summary}`);
    for (const placement of FUZZ_PLACEMENTS) assert.ok(report.byPlacement[placement] > 0, summary);
    for (const mode of FUZZ_LABEL_MODES) assert.ok(report.byLabelMode[mode] > 0, `${mode}: ${summary}`);
    for (const count of [1, 2, 3, 4]) assert.ok(report.byBoxCount[count] > 0, `${count} boxes: ${summary}`);

    // The default-on features fire on these boards.
    const defaults = report.countersByVariant.default;
    for (const counter of [
      "deadlockPrunes",
      "patternDeadlockPrunes",
      "piCorralPrunes",
      "commitmentSkips",
      "goalCommitments",
      "interactionBoostTotal",
      "infeasiblePrunes",
      "forcedPushMacroApplications",
      "incrementalAssignmentRepairs",
      "linearConflictTotal",
      "pdbEvaluations",
    ]) {
      assert.ok((defaults[counter] ?? 0) > 0, `default ${counter} = ${defaults[counter]}`);
    }
    assert.ok((report.countersByVariant.tunnelMacros.tunnelMacroApplications ?? 0) > 0);
  });
});
