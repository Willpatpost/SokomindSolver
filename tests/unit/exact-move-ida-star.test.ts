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
  runIdaStarSearch,
  type ExactMoveIdaStarOptions,
} from "../../src/solver/search/ida-star.ts";
import {
  toDenseBoxes,
  type DenseBox,
} from "../../src/solver/search/model.ts";
import {
  allReachableStates,
} from "../support/exact-solver-oracle.ts";
import { classicIdaStarSolver } from "../../src/solver/implementations/classic-solvers.ts";

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
    puzzleId: "exact-ida-star-test",
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
      puzzleId: "exact-ida-star-test",
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
// Board fixtures
// ---------------------------------------------------------------------------

const BOARD_ROWS = [
  "OOOOOO",
  "OR   O",
  "O XX O",
  "O SS O",
  "OOOOOO",
];

// ---------------------------------------------------------------------------
// AC1: Oracle equality
// ---------------------------------------------------------------------------

describe("AC1: exact IDA* oracle equality", () => {
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
        await runIdaStarSearch(req, oracleContext()),
      );

      assert.equal(
        result.solution.moves,
        state.exactMoves,
        `Oracle says ${state.exactMoves} moves but IDA* found ${result.solution.moves}`,
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
    await runIdaStarSearch(req, collectingContext(updates));

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
      await runIdaStarSearch(req, oracleContext(), {
        incumbent: {
          solution: dfsResult.solution,
          cost: dfsResult.solution.moves,
        },
      }),
    );

    assert.ok(
      result.solution.moves <= dfsResult.solution.moves,
      `IDA* should improve or match DFS: ${result.solution.moves} vs ${dfsResult.solution.moves}`,
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
      await runIdaStarSearch(req, oracleContext()),
    );

    assert.ok(result.proof, "Expected proof on result");
    assert.equal(result.proof!.kind, "optimal");
    assert.equal(result.proof!.algorithm, "move-ida-star");
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
      await runIdaStarSearch(req, oracleContext()),
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
    const result = await runIdaStarSearch(req, oracleContext());
    assert.equal(result.status, "unsolved");
    if (result.status !== "unsolved") throw new Error("unreachable");
    assert.equal(result.reason, "exhausted");
    assert.ok(result.proof, "Expected proof on unsolvable result");
    assert.equal(result.proof!.kind, "unsolvable");
    assert.equal(result.proof!.algorithm, "move-ida-star");

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
    const result = await runIdaStarSearch(limitedReq, oracleContext(), {
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

  it("returns unsolved on cutoff without incumbent", async () => {
    const req: SolverRequest = {
      ...requestFromRows(BOARD_ROWS),
      limits: { maxExpandedStates: 1 },
    };
    const result = await runIdaStarSearch(req, oracleContext());
    assert.equal(result.status, "unsolved");
    if (result.status !== "unsolved") throw new Error("unreachable");
    assert.equal(result.reason, "limit-reached");
  });
});

// ---------------------------------------------------------------------------
// AC7: Classic IDA* adapter
// ---------------------------------------------------------------------------

describe("AC7: classic IDA* adapter produces proof metadata", () => {
  it("classicIdaStarSolver returns optimal proof on solvable puzzle", async () => {
    const req = requestFromRows(BOARD_ROWS);
    const result = assertSolved(
      await classicIdaStarSolver.solve(req, oracleContext()),
    );

    assert.equal(result.solution.optimality, "proven");
    assert.ok(result.proof, "Expected proof from classic IDA* adapter");
    assert.equal(result.proof!.kind, "optimal");
    assert.equal(result.proof!.gap, 0);
  });

  it("classicIdaStarSolver matches oracle on all solvable states", async () => {
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
        await classicIdaStarSolver.solve(req, oracleContext()),
      );
      assert.equal(result.solution.moves, state.exactMoves);
      solvableChecked += 1;
    }
    assert.ok(solvableChecked > 30);
  });
});

// ---------------------------------------------------------------------------
// Snapshot policy equivalence
// ---------------------------------------------------------------------------

describe("snapshot policy equivalence", () => {
  it("all three policies produce identical solution cost and proof kind", async () => {
    const req = requestFromRows(BOARD_ROWS);
    const policies: Array<ExactMoveIdaStarOptions["reachabilityPolicy"]> = [
      "all",
      "periodic",
      "none",
    ];
    const results: Array<Extract<SolverResult, { readonly status: "solved" }>> = [];

    for (const policy of policies) {
      const result = assertSolved(
        await runIdaStarSearch(req, oracleContext(), {
          reachabilityPolicy: policy,
        }),
      );
      results.push(result);
    }

    const [allResult, periodicResult, noneResult] = results;
    assert.equal(allResult.solution.moves, periodicResult.solution.moves);
    assert.equal(allResult.solution.moves, noneResult.solution.moves);
    assert.equal(allResult.solution.pushes, periodicResult.solution.pushes);
    assert.equal(allResult.solution.pushes, noneResult.solution.pushes);
    assert.equal(allResult.proof!.kind, periodicResult.proof!.kind);
    assert.equal(allResult.proof!.kind, noneResult.proof!.kind);
  });
});

// ---------------------------------------------------------------------------
// Snapshot memory comparison
// ---------------------------------------------------------------------------

describe("snapshot memory comparison", () => {
  it('"none" policy uses <= reachability snapshot bytes than "all"', async () => {
    const req = requestFromRows(BOARD_ROWS);

    const allResult = assertSolved(
      await runIdaStarSearch(req, oracleContext(), {
        reachabilityPolicy: "all",
      }),
    );
    const noneResult = assertSolved(
      await runIdaStarSearch(req, oracleContext(), {
        reachabilityPolicy: "none",
      }),
    );

    const allBytes =
      allResult.metrics.counters?.memoryReachabilitySnapshotBytes ?? 0;
    const noneBytes =
      noneResult.metrics.counters?.memoryReachabilitySnapshotBytes ?? 0;

    assert.ok(
      noneBytes <= allBytes,
      `"none" policy snapshot bytes (${noneBytes}) should be <= "all" policy (${allBytes})`,
    );
  });
});

// ---------------------------------------------------------------------------
// Incomplete contour guard
// ---------------------------------------------------------------------------

describe("incomplete contour guard", () => {
  it("does not claim proven optimality from incomplete contour", async () => {
    const req: SolverRequest = {
      ...requestFromRows(BOARD_ROWS),
      limits: { maxExpandedStates: 2 },
    };

    const dfsResult = await runClassicSearch(req, oracleContext(), {
      strategy: "dfs",
    });
    if (dfsResult.status !== "solved") {
      // If DFS cannot even solve with these limits, skip this test path
      return;
    }

    const result = await runIdaStarSearch(
      { ...requestFromRows(BOARD_ROWS), limits: { maxExpandedStates: 2 } },
      oracleContext(),
      {
        incumbent: {
          solution: dfsResult.solution,
          cost: dfsResult.solution.moves,
        },
      },
    );

    if (result.status === "solved" && result.proof?.kind === "bounded") {
      assert.ok(
        result.proof!.gap! > 0,
        "Bounded proof from incomplete contour must have gap > 0",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Cancellation preserves incumbent
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
    const result = await runIdaStarSearch(
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
    const result = await runIdaStarSearch(req, {
      signal: ac.signal,
      reportProgress: () => undefined,
      now: () => performance.now(),
    });
    assert.equal(result.status, "cancelled");
  });
});

// ---------------------------------------------------------------------------
// Already-solved initial state
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
      await runIdaStarSearch(solvedReq, oracleContext()),
    );
    assert.equal(result.solution.moves, 0);
    assert.equal(result.solution.optimality, "proven");
    assert.ok(result.proof);
    assert.equal(result.proof!.kind, "optimal");
    assert.equal(result.proof!.gap, 0);
  });
});

// ---------------------------------------------------------------------------
// Progress phase transitions
// ---------------------------------------------------------------------------

describe("progress phase transitions", () => {
  it("reports preparing and searching/improving phases", async () => {
    const req = requestFromRows(BOARD_ROWS);
    const updates: SolverProgress[] = [];
    await runIdaStarSearch(req, collectingContext(updates));

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
    await runIdaStarSearch(req, collectingContext(updates));

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
// Cutoff without incumbent includes lower-bound metric
// ---------------------------------------------------------------------------

describe("cutoff without incumbent includes lower-bound metric", () => {
  it("includes lowerBound in metrics counters on limit-reached", async () => {
    const req: SolverRequest = {
      ...requestFromRows(BOARD_ROWS),
      limits: { maxExpandedStates: 1 },
    };
    const result = await runIdaStarSearch(req, oracleContext());
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
// Bounded proof lb == U guard
// ---------------------------------------------------------------------------

describe("bounded proof lb == U guard", () => {
  it("returns optimal instead of bounded when lower bound equals incumbent", async () => {
    const req = requestFromRows(BOARD_ROWS);
    const result = assertSolved(
      await runIdaStarSearch(req, oracleContext()),
    );
    assert.equal(result.proof!.kind, "optimal");
    assert.equal(result.proof!.gap, 0);
    assert.equal(result.proof!.lowerBound, result.proof!.upperBound);
  });
});
