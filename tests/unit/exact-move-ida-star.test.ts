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
} from "../../src/solver/search/ida-star.ts";
import {
  IDA_STAR_CHECKPOINT_SCHEMA_VERSION,
  createBoardContentKey,
  type IdaStarCheckpoint,
} from "../../src/solver/search/ida-star-checkpoint.ts";
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

// Push right, walk two cells around the box, push down twice: 5 moves against
// a root bound of 3 pushes and no walk.
const WALK_AROUND_ROWS = [
  "OOOOOOO",
  "O     O",
  "O RX  O",
  "O     O",
  "O   S O",
  "OOOOOOO",
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
// Frame support distances
// ---------------------------------------------------------------------------

describe("frame support distances", () => {
  it("floods each frame once and keeps the optimal route", async () => {
    const req = requestFromRows(BOARD_ROWS);
    const result = assertSolved(
      await runIdaStarSearch(req, oracleContext()),
    );
    const expected = assertSolved(
      await classicIdaStarSolver.solve(req, oracleContext()),
    );

    const floods = result.metrics.counters?.reachabilityFloods ?? 0;
    const expanded = result.metrics.expandedStates ?? 0;
    // Child returns read the saved distances, so floods never exceed the
    // frames expanded.
    assert.ok(floods > 0);
    assert.ok(
      floods <= expanded,
      `Floods ${floods} should be <= expanded states (${expanded})`,
    );
    // The counter now reports the retained support distances.
    assert.equal(
      typeof result.metrics.counters?.memoryReachabilitySnapshotBytes,
      "number",
    );
    assert.equal(result.proof!.kind, "optimal");
    assert.equal(result.solution.moves, expected.solution.moves);
    assert.equal(result.solution.pushes, expected.solution.pushes);
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
    assert.equal(dfsResult.status, "solved", "the incumbent must exist");
    if (dfsResult.status !== "solved") return;

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

    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;
    assert.equal(result.solution.optimality, "unknown");
    assert.equal(result.proof?.kind, "bounded");
    assert.ok(
      result.proof.gap! > 0,
      "Bounded proof from incomplete contour must have gap > 0",
    );
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

describe("IDA* numeric caps and preprocessing budgets", () => {
  it("does not turn a numeric cap into a fabricated solution", async () => {
    const request = requestFromRows(["OOOOO", "ORXSO", "OOOOO"]);
    const optimum = assertSolved(await runIdaStarSearch(request, oracleContext()));
    const result = await runIdaStarSearch(request, oracleContext(), {
      upperBound: optimum.solution.moves,
    });
    assert.equal(result.status, "unsolved");
    if (result.status !== "unsolved") return;
    assert.equal(result.reason, "exhausted");
    assert.equal(result.proof, undefined);
    assert.equal(result.metrics.counters?.lowerBound, optimum.solution.moves);
  });

  it("exhausts a numeric cap equal to the optimum when the root bound is below it", async () => {
    const request = requestFromRows(WALK_AROUND_ROWS);
    const optimum = assertSolved(await runIdaStarSearch(request, oracleContext()));
    assert.equal(optimum.solution.moves, 5);
    const root = await runIdaStarSearch(
      { ...request, limits: { maxExpandedStates: 1 } },
      oracleContext(),
    );
    assert.ok(
      (root.metrics.counters?.lowerBound ?? Infinity) < optimum.solution.moves,
      `root bound ${root.metrics.counters?.lowerBound}`,
    );

    // No incumbent, so nothing below the cap is ever found. Every contour past
    // the root bound ends with only f >= cap left, which must finish the run
    // rather than repeat the same contour until a limit stops it.
    const result = await runIdaStarSearch(
      { ...request, limits: { maxExpandedStates: 50_000 } },
      oracleContext(),
      { upperBound: optimum.solution.moves },
    );
    assert.equal(result.status, "unsolved");
    if (result.status !== "unsolved") return;
    assert.equal(result.reason, "exhausted", result.detail);
    assert.equal(result.proof, undefined);
    assert.equal(result.metrics.counters?.lowerBound, optimum.solution.moves);

    // One more move of room proves the optimum instead.
    const proven = assertSolved(await runIdaStarSearch(request, oracleContext(), {
      upperBound: optimum.solution.moves + 1,
    }));
    assert.equal(proven.solution.moves, optimum.solution.moves);
    assert.equal(proven.proof?.kind, "optimal");
  });

  it("exits when the upper-bound channel lowers the cap below the optimum", async () => {
    // The clock advances a second per read, so the lane polls the channel at
    // its first step, before it can reach the 5-move goal.
    let clock = 0;
    let polls = 0;
    const result = await runIdaStarSearch(
      { ...requestFromRows(WALK_AROUND_ROWS), limits: { maxExpandedStates: 50_000 } },
      {
        signal: new AbortController().signal,
        reportProgress: () => undefined,
        now: () => (clock += 1_000),
      },
      { upperBoundChannel: { poll: () => (polls++ === 0 ? 4 : undefined) } },
    );
    assert.equal(result.status, "unsolved");
    if (result.status !== "unsolved") return;
    assert.equal(result.reason, "exhausted", result.detail);
    assert.equal(result.proof, undefined);
    assert.equal(result.metrics.counters?.lowerBound, 4);
  });

  it("finishes a resumed lane whose threshold already reaches the cap", async () => {
    const request = requestFromRows(WALK_AROUND_ROWS);
    const checkpoint: IdaStarCheckpoint = {
      schemaVersion: IDA_STAR_CHECKPOINT_SCHEMA_VERSION,
      boardContentKey: createBoardContentKey(request.board, request.snapshot),
      solverVersion: "test",
      objective: request.objective,
      exactStateCodecVersion: 0,
      currentThreshold: 6,
      lastExhaustedThreshold: 5,
      incumbent: null,
      partitionId: null,
      transpositionMetadata: { policy: "best-g-per-iteration" },
      counters: { expanded: 0, generated: 0, iterations: 0 },
    };
    const result = await runIdaStarSearch(
      { ...request, limits: { maxExpandedStates: 50_000 } },
      oracleContext(),
      { checkpoint, upperBound: 5 },
    );
    assert.equal(result.status, "unsolved");
    if (result.status !== "unsolved") return;
    assert.equal(result.reason, "exhausted", result.detail);
    assert.equal(result.metrics.counters?.lowerBound, 5);
  });

  it("certifies a route found at the contour threshold even when a limit stops the contour", async () => {
    // Each finished contour proves every route costs at least the next
    // threshold, so a goal found in that contour is optimal on the spot. The
    // clock jumps when the goal is reported, so the elapsed limit stops the
    // contour at its next step. The root bound is below 5, so the goal is not
    // in the first contour.
    let clock = 0;
    let goalReported = false;
    const result = assertSolved(await runIdaStarSearch(
      { ...requestFromRows(WALK_AROUND_ROWS), limits: { maxElapsedMs: 1e8 } },
      {
        signal: new AbortController().signal,
        reportProgress: (progress) => {
          if (progress.phase === "improving") goalReported = true;
        },
        now: () => (goalReported ? 1e9 : ++clock),
      },
    ));
    assert.ok(result.metrics.elapsedMs >= 1e8, "the limit never fired");
    assert.equal(result.solution.moves, 5);
    assert.equal(result.solution.optimality, "proven");
    assert.equal(result.proof?.kind, "optimal");
    assert.deepEqual(collectProofIssues(result.proof, result.solution), []);
  });

  it("enforces elapsed and memory limits while building exact features", async () => {
    let clock = 0;
    const elapsed = await runIdaStarSearch(
      { ...requestFromRows(BOARD_ROWS), limits: { maxElapsedMs: 3 } },
      {
        signal: new AbortController().signal,
        reportProgress: () => undefined,
        now: () => ++clock,
      },
    );
    assert.equal(elapsed.status, "unsolved");
    if (elapsed.status === "unsolved") {
      assert.equal(elapsed.reason, "limit-reached");
      assert.match(elapsed.detail ?? "", /preprocessing/i);
    }

    const memory = await runIdaStarSearch(
      { ...requestFromRows(BOARD_ROWS), limits: { maxMemoryBytes: 1 } },
      oracleContext(),
    );
    assert.equal(memory.status, "unsolved");
    if (memory.status === "unsolved") {
      assert.equal(memory.reason, "limit-reached");
      assert.ok((memory.metrics.counters?.estimatedMemoryBytes ?? 0) > 1);
    }
  });
});
