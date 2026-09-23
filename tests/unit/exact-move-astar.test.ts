import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parsePuzzleRows,
  type ParsedBoard,
  type Box,
  type GameSnapshot,
} from "../../src/core/index.ts";
import type {
  SolverExecutionContext,
  SolverProgress,
  SolverRequest,
  SolverResult,
  SolverSolution,
} from "../../src/solver/contracts.ts";
import {
  collectProofIssues,
} from "../../src/solver/proof.ts";
import {
  compileSearchBoard,
  type CompiledSearchBoard,
} from "../../src/solver/search/compiled-board.ts";
import {
  runClassicSearch,
} from "../../src/solver/search/engine.ts";
import {
  runExactMoveAStar,
} from "../../src/solver/search/exact-move-astar.ts";
import {
  toDenseBoxes,
  type DenseBox,
} from "../../src/solver/search/model.ts";
import {
  allReachableStates,
  exactRemainingMoves,
} from "../support/exact-solver-oracle.ts";
import { classicAStarSolver } from "../../src/solver/implementations/classic-solvers.ts";
import { verifySolverSolution } from "../../src/solver/verification.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function oracleContext(): SolverExecutionContext {
  return {
    signal: new AbortController().signal,
    reportProgress: () => undefined,
    now: () => performance.now(),
  };
}

function collectingContext(
  updates: SolverProgress[],
  signal?: AbortSignal,
): SolverExecutionContext {
  return {
    signal: signal ?? new AbortController().signal,
    reportProgress: (p) => updates.push(p),
    now: () => performance.now(),
  };
}

function requestForState(
  parsed: ParsedBoard,
  board: CompiledSearchBoard,
  robot: number,
  boxes: readonly DenseBox[],
): SolverRequest {
  const robotPos = board.positions[robot];
  const snapshotBoxes: Box[] = boxes.map((box) => {
    const pos = board.positions[box.cell];
    return {
      id: box.id,
      label: box.label,
      position: { row: pos.row, column: pos.column },
    };
  });
  const isSolved = boxes.every(
    (box) => board.goalLabelByCell[box.cell] === box.label,
  );
  const snapshot: GameSnapshot = {
    puzzleId: "exact-astar-test",
    robot: { row: robotPos.row, column: robotPos.column },
    boxes: snapshotBoxes,
    moves: 0,
    pushes: 0,
    solved: isSolved,
  };
  return { board: parsed, snapshot, objective: { kind: "moves" } };
}

function requestFromRows(rows: string[]): SolverRequest {
  const parsed = parsePuzzleRows(rows);
  return {
    board: parsed,
    snapshot: {
      puzzleId: "exact-astar-test",
      robot: parsed.initialRobot,
      boxes: parsed.initialBoxes,
      moves: 0,
      pushes: 0,
      solved: false,
    },
    objective: { kind: "moves" },
  };
}

function assertSolved(
  result: SolverResult,
): Extract<SolverResult, { readonly status: "solved" }> {
  assert.equal(result.status, "solved", `Expected solved, got ${result.status}`);
  if (result.status !== "solved") throw new Error("unreachable");
  return result;
}

// ---------------------------------------------------------------------------
// AC1: Oracle equality
// ---------------------------------------------------------------------------

const BOARD_ROWS = [
  "OOOOOO",
  "OR   O",
  "O XX O",
  "O SS O",
  "OOOOOO",
];

describe("AC1: exact A* oracle equality", () => {
  it("matches oracle on all reachable solvable states", async () => {
    const parsed = parsePuzzleRows(BOARD_ROWS);
    const board = compileSearchBoard(parsed);
    const initialBoxes = toDenseBoxes(board, parsed.initialBoxes);
    const initialRobot = board.cellAt(
      parsed.initialRobot.row,
      parsed.initialRobot.column,
    );

    const oracleStates = allReachableStates(board, initialRobot, initialBoxes);
    let solvableChecked = 0;

    for (const [, state] of oracleStates) {
      if (state.exactMoves === null) continue;

      const req = requestForState(parsed, board, state.robot, state.boxes);
      const result = assertSolved(
        await runExactMoveAStar(req, oracleContext()),
      );

      assert.equal(
        result.solution.moves,
        state.exactMoves,
        `Oracle says ${state.exactMoves} moves but exact A* found ${result.solution.moves}`,
      );
      assert.equal(result.solution.optimality, "proven");
      solvableChecked += 1;
    }
    assert.ok(solvableChecked > 30, `Only ${solvableChecked} solvable states checked`);
  });
});

// ---------------------------------------------------------------------------
// AC2: Lower-bound monotonicity
// ---------------------------------------------------------------------------

describe("AC2: lower-bound monotonicity", () => {
  it("lowerBound never decreases across progress reports", async () => {
    const req = requestFromRows([
      "OOOOOOO",
      "O     O",
      "O X   O",
      "ORS   O",
      "O     O",
      "OOOOOOO",
    ]);
    const updates: SolverProgress[] = [];
    await runExactMoveAStar(req, collectingContext(updates));

    let prevLB = -1;
    let prevUB = Infinity;
    let prevGap = Infinity;
    for (const u of updates) {
      if (u.lowerBound !== undefined) {
        assert.ok(u.lowerBound >= prevLB, `lowerBound decreased: ${prevLB} -> ${u.lowerBound}`);
        prevLB = u.lowerBound;
      }
      if (u.upperBound !== undefined) {
        assert.ok(u.upperBound <= prevUB, `upperBound increased: ${prevUB} -> ${u.upperBound}`);
        prevUB = u.upperBound;
      }
      if (u.gap !== undefined) {
        assert.ok(u.gap <= prevGap, `gap increased: ${prevGap} -> ${u.gap}`);
        prevGap = u.gap;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// AC3: Incumbent improvements
// ---------------------------------------------------------------------------

describe("AC3: incumbent improvements", () => {
  it("improves on a suboptimal initial incumbent", async () => {
    const req = requestFromRows(BOARD_ROWS);

    const dfsResult = await runClassicSearch(req, oracleContext(), {
      strategy: "dfs",
    });
    assert.equal(dfsResult.status, "solved");
    if (dfsResult.status !== "solved") throw new Error("unreachable");

    const result = assertSolved(
      await runExactMoveAStar(req, oracleContext(), {
        incumbent: {
          solution: dfsResult.solution,
          cost: dfsResult.solution.moves,
        },
      }),
    );

    assert.ok(
      result.solution.moves <= dfsResult.solution.moves,
      `Exact A* should improve or match DFS: ${result.solution.moves} vs ${dfsResult.solution.moves}`,
    );
    assert.equal(result.solution.optimality, "proven");
  });
});

// ---------------------------------------------------------------------------
// AC4: Optimal proof structure
// ---------------------------------------------------------------------------

describe("AC4: optimal proof structure", () => {
  it("produces valid optimal proof on solvable puzzle", async () => {
    const req = requestFromRows(BOARD_ROWS);
    const result = assertSolved(
      await runExactMoveAStar(req, oracleContext()),
    );

    assert.ok(result.proof, "Expected proof on result");
    assert.equal(result.proof!.kind, "optimal");
    assert.equal(result.proof!.algorithm, "move-astar");
    assert.equal(result.proof!.gap, 0);
    assert.equal(result.proof!.lowerBound, result.solution.moves);
    assert.equal(result.proof!.upperBound, result.solution.moves);
    assert.equal(result.solution.optimality, "proven");

    const issues = collectProofIssues(result.proof, result.solution);
    assert.deepStrictEqual(issues, [], `Proof validation issues: ${issues.join("; ")}`);
  });

  it("produces valid proof with objective.kind = moves", async () => {
    const req = requestFromRows(BOARD_ROWS);
    const result = assertSolved(
      await runExactMoveAStar(req, oracleContext()),
    );
    assert.deepStrictEqual(result.proof!.objective, { kind: "moves" });
  });
});

// ---------------------------------------------------------------------------
// AC5: Unsolvable proof
// ---------------------------------------------------------------------------

describe("AC5: unsolvable proof", () => {
  it("proves unsolvable when no solution exists", async () => {
    const req = requestFromRows([
      "OOOOO",
      "OX  O",
      "O  SO",
      "O R O",
      "OOOOO",
    ]);
    const result = await runExactMoveAStar(req, oracleContext());
    assert.equal(result.status, "unsolved");
    if (result.status !== "unsolved") throw new Error("unreachable");
    assert.equal(result.reason, "exhausted");
    assert.ok(result.proof, "Expected proof on unsolvable result");
    assert.equal(result.proof!.kind, "unsolvable");
    assert.equal(result.proof!.algorithm, "move-astar");

    const issues = collectProofIssues(result.proof, null);
    assert.deepStrictEqual(issues, [], `Proof validation issues: ${issues.join("; ")}`);
  });
});

// ---------------------------------------------------------------------------
// AC6: Cutoff returns incumbent + gap
// ---------------------------------------------------------------------------

describe("AC6: cutoff with incumbent returns bounded proof", () => {
  it("returns bounded proof on expanded-state limit with incumbent", async () => {
    const req = requestFromRows(BOARD_ROWS);

    const dfsResult = await runClassicSearch(req, oracleContext(), {
      strategy: "dfs",
    });
    assert.equal(dfsResult.status, "solved");
    if (dfsResult.status !== "solved") throw new Error("unreachable");

    const limitedReq: SolverRequest = {
      ...req,
      limits: { maxExpandedStates: 1 },
    };
    const result = await runExactMoveAStar(limitedReq, oracleContext(), {
      incumbent: {
        solution: dfsResult.solution,
        cost: dfsResult.solution.moves,
      },
    });

    assert.equal(result.status, "solved");
    if (result.status !== "solved") throw new Error("unreachable");
    assert.equal(result.solution.optimality, "unknown");
    assert.ok(result.proof, "Expected proof on cutoff result");
    assert.equal(result.proof!.kind, "bounded");
    assert.ok(result.proof!.gap! > 0, "Expected non-zero gap on cutoff");
    assert.equal(
      result.proof!.gap,
      result.proof!.upperBound! - result.proof!.lowerBound!,
    );
    assert.equal(result.proof!.upperBound, result.solution.moves);

    const issues = collectProofIssues(result.proof, result.solution);
    assert.deepStrictEqual(issues, [], `Proof validation issues: ${issues.join("; ")}`);
  });

  it("cancel after a tight root bound returns a valid result", async () => {
    const req = requestFromRows(["OOOOOOO", "OR X SO", "OOOOOOO"]);
    const incumbent: SolverSolution = {
      steps: [
        { direction: "right", kind: "walk" },
        { direction: "right", kind: "push" },
        { direction: "right", kind: "push" },
      ],
      moves: 3,
      pushes: 2,
      objective: { kind: "moves" },
      objectiveScore: 3,
      optimality: "unknown",
    };
    const ac = new AbortController();
    const context: SolverExecutionContext = {
      signal: ac.signal,
      reportProgress: (progress) => {
        if (progress.detail === "Preparing exact A* search") ac.abort();
      },
      now: () => performance.now(),
    };

    const result = await runExactMoveAStar(req, context, {
      incumbent: { solution: incumbent, cost: 3 },
    });

    assert.equal(ac.signal.aborted, true);
    assert.equal(result.status, "solved");
    if (result.status !== "solved") throw new Error("unreachable");
    const issues = collectProofIssues(result.proof, result.solution);
    assert.deepStrictEqual(issues, [], `Proof validation issues: ${issues.join("; ")}`);
  });

  it("never lets a cutoff heap peek overstate the active-node oracle bound", async () => {
    const req = requestFromRows(BOARD_ROWS);
    const optimum = assertSolved(await runExactMoveAStar(req, oracleContext()));
    const incumbent = await runClassicSearch(req, oracleContext(), { strategy: "dfs" });
    assert.equal(incumbent.status, "solved");
    if (incumbent.status !== "solved") return;
    const result = await runExactMoveAStar(
      { ...req, limits: { maxGeneratedStates: 1 } },
      oracleContext(),
      {
        incumbent: {
          solution: incumbent.solution,
          cost: incumbent.solution.moves,
        },
      },
    );
    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;
    assert.equal(result.proof?.kind, "bounded");
    assert.ok(
      (result.proof?.lowerBound ?? Infinity) <= optimum.solution.moves,
      "a cutoff lower bound must include the dequeued active node",
    );
  });

  it("returns unsolved on cutoff without incumbent", async () => {
    const req: SolverRequest = {
      ...requestFromRows(BOARD_ROWS),
      limits: { maxExpandedStates: 1 },
    };
    const result = await runExactMoveAStar(req, oracleContext());
    assert.equal(result.status, "unsolved");
    if (result.status !== "unsolved") throw new Error("unreachable");
    assert.equal(result.reason, "limit-reached");
  });

  it("treats a numeric upper bound as a cap, never as a solution", async () => {
    const req = requestFromRows(BOARD_ROWS);
    const optimum = assertSolved(await runExactMoveAStar(req, oracleContext()));
    const result = await runExactMoveAStar(req, oracleContext(), {
      upperBound: optimum.solution.moves,
    });
    assert.equal(result.status, "unsolved");
    if (result.status !== "unsolved") return;
    assert.equal(result.reason, "exhausted");
    assert.equal(result.proof, undefined);
    assert.equal(result.metrics.counters?.lowerBound, optimum.solution.moves);
  });
});

describe("exact preprocessing resource budgets", () => {
  it("enforces the elapsed deadline while preprocessing", async () => {
    let clock = 0;
    const result = await runExactMoveAStar(
      { ...requestFromRows(BOARD_ROWS), limits: { maxElapsedMs: 3 } },
      {
        signal: new AbortController().signal,
        reportProgress: () => undefined,
        now: () => ++clock,
      },
    );
    assert.equal(result.status, "unsolved");
    if (result.status !== "unsolved") return;
    assert.equal(result.reason, "limit-reached");
    assert.match(result.detail ?? "", /preprocessing/i);
    assert.equal(result.metrics.expandedStates, 0);
  });

  it("enforces and reports the memory budget before retained tables allocate", async () => {
    const result = await runExactMoveAStar(
      { ...requestFromRows(BOARD_ROWS), limits: { maxMemoryBytes: 1 } },
      oracleContext(),
    );
    assert.equal(result.status, "unsolved");
    if (result.status !== "unsolved") return;
    assert.equal(result.reason, "limit-reached");
    assert.ok((result.metrics.counters?.estimatedMemoryBytes ?? 0) > 1);
  });

  it("counts retained PDB and deadlock-table structures", async () => {
    const result = assertSolved(
      await runExactMoveAStar(requestFromRows(BOARD_ROWS), oracleContext()),
    );
    assert.ok((result.metrics.counters?.pdbRetainedBytes ?? 0) > 0);
    assert.ok((result.metrics.counters?.deadlockTableRetainedBytes ?? 0) > 0);
    assert.equal(
      result.metrics.counters?.preprocessingRetainedBytes,
      (result.metrics.counters?.pdbRetainedBytes ?? 0) +
        (result.metrics.counters?.deadlockTableRetainedBytes ?? 0) +
        (result.metrics.counters?.interactionBoostRetainedBytes ?? 0),
    );
  });
});

// ---------------------------------------------------------------------------
// AC7: Classic A* regression
// ---------------------------------------------------------------------------

describe("AC7: classic A* adapter produces proof metadata", () => {
  it("classicAStarSolver returns optimal proof on solvable puzzle", async () => {
    const req = requestFromRows(BOARD_ROWS);
    const result = assertSolved(
      await classicAStarSolver.solve(req, oracleContext()),
    );

    assert.equal(result.solution.optimality, "proven");
    assert.ok(result.proof, "Expected proof from classic A* adapter");
    assert.equal(result.proof!.kind, "optimal");
    assert.equal(result.proof!.gap, 0);
  });

  it("classicAStarSolver matches oracle on all solvable states", async () => {
    const parsed = parsePuzzleRows(BOARD_ROWS);
    const board = compileSearchBoard(parsed);
    const initialBoxes = toDenseBoxes(board, parsed.initialBoxes);
    const initialRobot = board.cellAt(
      parsed.initialRobot.row,
      parsed.initialRobot.column,
    );

    const oracleStates = allReachableStates(board, initialRobot, initialBoxes);
    let solvableChecked = 0;

    for (const [, state] of oracleStates) {
      if (state.exactMoves === null) continue;
      const req = requestForState(parsed, board, state.robot, state.boxes);
      const result = assertSolved(
        await classicAStarSolver.solve(req, oracleContext()),
      );
      assert.equal(result.solution.moves, state.exactMoves);
      solvableChecked += 1;
    }
    assert.ok(solvableChecked > 30);
  });
});

// ---------------------------------------------------------------------------
// Additional: already-solved initial state
// ---------------------------------------------------------------------------

describe("already-solved initial state", () => {
  it("returns cost 0 with optimal proof", async () => {
    const req = requestFromRows([
      "OOOOO",
      "O R O",
      "O XSO",
      "OOOOO",
    ]);
    const solvedReq: SolverRequest = {
      ...req,
      snapshot: {
        ...req.snapshot,
        boxes: req.snapshot.boxes.map((b) => ({
          ...b,
          position: { row: 2, column: 3 },
        })),
        solved: true,
      },
    };
    const result = assertSolved(
      await runExactMoveAStar(solvedReq, oracleContext()),
    );
    assert.equal(result.solution.moves, 0);
    assert.equal(result.solution.optimality, "proven");
    assert.ok(result.proof);
    assert.equal(result.proof!.kind, "optimal");
    assert.equal(result.proof!.gap, 0);
  });
});

// ---------------------------------------------------------------------------
// Additional: progress phase transitions
// ---------------------------------------------------------------------------

describe("progress phase transitions", () => {
  it("reports preparing and searching/improving phases", async () => {
    const req = requestFromRows(BOARD_ROWS);
    const updates: SolverProgress[] = [];
    await runExactMoveAStar(req, collectingContext(updates));

    const phases = updates.map((u) => u.phase);
    assert.ok(phases.includes("preparing"), "Expected preparing phase");
    assert.ok(
      phases.includes("searching") || phases.includes("proving"),
      "Expected searching or proving phase",
    );
  });

  it("includes incumbent info in progress after finding goal", async () => {
    const req = requestFromRows(BOARD_ROWS);
    const updates: SolverProgress[] = [];
    await runExactMoveAStar(req, collectingContext(updates));

    const withIncumbent = updates.filter((u) => u.incumbent !== undefined);
    if (withIncumbent.length > 0) {
      const inc = withIncumbent[0].incumbent!;
      assert.ok(typeof inc.moves === "number");
      assert.ok(typeof inc.pushes === "number");
      assert.ok(typeof inc.objectiveScore === "number");
    }
  });
});

// ---------------------------------------------------------------------------
// Audit fix: cancellation preserves incumbent (§8.7)
// ---------------------------------------------------------------------------

describe("cancellation preserves incumbent", () => {
  it("returns solved with bounded proof when cancelled after finding incumbent", async () => {
    const req = requestFromRows(BOARD_ROWS);

    const dfsResult = await runClassicSearch(req, oracleContext(), {
      strategy: "dfs",
    });
    assert.equal(dfsResult.status, "solved");
    if (dfsResult.status !== "solved") throw new Error("unreachable");

    const ac = new AbortController();
    const updates: SolverProgress[] = [];
    const result = await runExactMoveAStar(
      req,
      collectingContext(updates, ac.signal),
      {
        incumbent: {
          solution: dfsResult.solution,
          cost: dfsResult.solution.moves,
        },
      },
    );

    assert.equal(result.status, "solved");
    if (result.status !== "solved") throw new Error("unreachable");
    assert.ok(result.proof, "Expected proof when incumbent preserved");
  });

  it("returns cancelled with no proof when no incumbent exists", async () => {
    const ac = new AbortController();
    ac.abort("cancel immediately");
    const req = requestFromRows(BOARD_ROWS);
    const result = await runExactMoveAStar(req, {
      signal: ac.signal,
      reportProgress: () => undefined,
      now: () => performance.now(),
    });
    assert.equal(result.status, "cancelled");
  });
});

// ---------------------------------------------------------------------------
// Audit fix: cutoff without incumbent includes lower-bound metric (§8.7)
// ---------------------------------------------------------------------------

describe("cutoff without incumbent includes lower-bound metric", () => {
  it("includes lowerBound in metrics counters on limit-reached", async () => {
    const req: SolverRequest = {
      ...requestFromRows(BOARD_ROWS),
      limits: { maxExpandedStates: 1 },
    };
    const result = await runExactMoveAStar(req, oracleContext());
    assert.equal(result.status, "unsolved");
    if (result.status !== "unsolved") throw new Error("unreachable");
    assert.equal(result.reason, "limit-reached");
    assert.ok(
      result.metrics.counters?.lowerBound !== undefined,
      "Expected lowerBound in metrics counters",
    );
    assert.ok(
      (result.metrics.counters?.lowerBound ?? -1) >= 0,
      "lowerBound must be non-negative",
    );
  });
});

// ---------------------------------------------------------------------------
// Audit fix: bounded proof guard against lb == U (§6.2)
// ---------------------------------------------------------------------------

describe("bounded proof lb == U guard", () => {
  it("returns optimal instead of bounded when lower bound equals incumbent", async () => {
    const req = requestFromRows(BOARD_ROWS);
    const result = assertSolved(
      await runExactMoveAStar(req, oracleContext()),
    );
    assert.equal(result.proof!.kind, "optimal");
    assert.equal(result.proof!.gap, 0);
    assert.equal(result.proof!.lowerBound, result.proof!.upperBound);
  });
});

// ---------------------------------------------------------------------------
// Sprint 1: Forced-push macros in exact A*
// ---------------------------------------------------------------------------

describe("exact A* forced-push macros", () => {
  const competingFrontierRows = [
    "OOOOOOO",
    "OO    O",
    "O    RO",
    "O  XSXO",
    "O   OSO",
    "OOOOOOO",
  ];
  const elevenMoveIncumbent: SolverSolution = {
    steps: [
      { direction: "left", kind: "walk" },
      { direction: "right", kind: "walk" },
      { direction: "left", kind: "walk" },
      { direction: "left", kind: "walk" },
      { direction: "left", kind: "walk" },
      { direction: "down", kind: "walk" },
      { direction: "right", kind: "push" },
      { direction: "up", kind: "walk" },
      { direction: "right", kind: "walk" },
      { direction: "right", kind: "walk" },
      { direction: "down", kind: "push" },
    ],
    moves: 11,
    pushes: 2,
    objective: { kind: "moves" },
    objectiveScore: 11,
    optimality: "unknown",
  };

  for (const [name, rows] of [
    ["base", competingFrontierRows],
    ["mirror", competingFrontierRows.map((row) => [...row].reverse().join(""))],
    ["rotation", [...competingFrontierRows].reverse().map((row) => [...row].reverse().join(""))],
  ] as const) {
    it(`keeps a forced goal behind cheaper frontier states (${name})`, async () => {
      const request = requestFromRows(rows);
      const board = compileSearchBoard(request.board);
      const oracle = exactRemainingMoves(
        board,
        board.cellAt(request.snapshot.robot.row, request.snapshot.robot.column),
        toDenseBoxes(board, request.snapshot.boxes),
      );
      assert.equal(oracle.exactMoves, 7);
      const result = assertSolved(await classicAStarSolver.solve(request, oracleContext()));
      assert.equal(result.solution.moves, oracle.exactMoves);
      assert.equal(result.solution.pushes, 2);
      assert.equal(result.solution.optimality, "proven");
      assert.equal(result.proof?.lowerBound, oracle.exactMoves);
      assert.equal(result.proof?.upperBound, oracle.exactMoves);
      assert.equal(verifySolverSolution(request, result.solution).valid, true);
      assert.deepEqual(collectProofIssues(result.proof, result.solution), []);
      assert.ok((result.metrics.counters?.forcedPushMacroApplications ?? 0) > 0);
    });
  }

  it("improves an incumbent without certifying the first forced goal", async () => {
    const request = requestFromRows(competingFrontierRows);
    assert.equal(verifySolverSolution(request, elevenMoveIncumbent).valid, true);
    const result = assertSolved(await runExactMoveAStar(request, oracleContext(), {
      incumbent: { solution: elevenMoveIncumbent, cost: 11 },
    }));
    assert.equal(result.solution.moves, 7);
    assert.equal(result.proof?.lowerBound, 7);
    assert.equal(result.proof?.upperBound, 7);
    assert.equal(verifySolverSolution(request, result.solution).valid, true);
  });

  it("retains the global bound on cutoff after generating a forced successor", async () => {
    const request = {
      ...requestFromRows(competingFrontierRows),
      limits: { maxExpandedStates: 4 },
    };
    const result = assertSolved(await runExactMoveAStar(request, oracleContext(), {
      incumbent: { solution: elevenMoveIncumbent, cost: 11 },
    }));
    assert.equal(result.metrics.expandedStates, 4);
    assert.ok((result.metrics.counters?.forcedPushMacroApplications ?? 0) > 0);
    assert.equal(result.solution.moves, 11);
    assert.equal(result.solution.optimality, "unknown");
    assert.equal(result.proof?.kind, "bounded");
    assert.ok((result.proof?.lowerBound ?? Infinity) <= 7);
    assert.equal(result.proof?.upperBound, 11);
    assert.deepEqual(collectProofIssues(result.proof, result.solution), []);
    assert.equal(verifySolverSolution(request, result.solution).valid, true);
  });

  it("produces same optimal solution on corridor puzzle", async () => {
    const req = requestFromRows([
      "OOOOOOO",
      "O  S  O",
      "O  X  O",
      "O  R  O",
      "OOOOOOO",
    ]);
    const result = assertSolved(
      await runExactMoveAStar(req, oracleContext()),
    );
    assert.equal(result.solution.optimality, "proven");
    assert.equal(result.solution.pushes, 1);
  });

  it("produces same oracle-matched result on standard board with macros", async () => {
    const req = requestFromRows(BOARD_ROWS);
    const result = assertSolved(
      await runExactMoveAStar(req, oracleContext()),
    );
    assert.equal(result.solution.optimality, "proven");
    assert.ok(result.solution.moves > 0);
  });

  it("reports forced-push macro applications in metrics", async () => {
    const req = requestFromRows(BOARD_ROWS);
    const result = assertSolved(
      await runExactMoveAStar(req, oracleContext()),
    );
    const applications = result.metrics.counters?.forcedPushMacroApplications;
    assert.ok(
      applications !== undefined,
      "Expected forcedPushMacroApplications counter in metrics",
    );
  });
});

// ---------------------------------------------------------------------------
// Sprint 1: Linear conflict in exact A*
// ---------------------------------------------------------------------------

describe("exact A* with linear conflict", () => {
  it("produces optimal verified solution on standard board", async () => {
    const req = requestFromRows(BOARD_ROWS);
    const result = assertSolved(
      await runExactMoveAStar(req, oracleContext()),
    );
    assert.equal(result.solution.optimality, "proven");
  });

  it("produces optimal verified solution on corridor puzzle", async () => {
    const req = requestFromRows([
      "OOOOOOO",
      "O  S  O",
      "O  X  O",
      "O  R  O",
      "OOOOOOO",
    ]);
    const result = assertSolved(
      await runExactMoveAStar(req, oracleContext()),
    );
    assert.equal(result.solution.optimality, "proven");
    assert.equal(result.solution.pushes, 1);
    assert.equal(result.solution.moves, 1);
  });
});
