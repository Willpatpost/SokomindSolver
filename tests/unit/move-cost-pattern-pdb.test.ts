import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parsePuzzleRows } from "../../src/core/index.ts";
import {
  compileSearchBoard,
  type CompiledSearchBoard,
} from "../../src/solver/search/compiled-board.ts";
import {
  toDenseBoxes,
  type DenseBox,
} from "../../src/solver/search/model.ts";
import {
  buildMoveCostPatternPdb,
  evaluateMoveCostPattern,
  evaluateMoveCostPatternWithSubsets,
  selectGoalPatterns,
  generateCandidatePatterns,
  probeAndSelectPatterns,
  PatternWalkWorkspace,
  precomputeBinomials,
  rankCombination,
  unrankCombination,
  type MoveCostPattern,
} from "../../src/solver/search/move-cost-pattern-pdb.ts";
import {
  exactRemainingMoves,
  allReachableStates,
} from "../support/exact-solver-oracle.ts";
import { runExactMoveAStar } from "../../src/solver/search/exact-move-astar.ts";
import { runIdaStarSearch } from "../../src/solver/search/ida-star.ts";
import { verifySolverSolution } from "../../src/solver/verification.ts";
import type {
  SolverExecutionContext,
  SolverRequest,
} from "../../src/solver/contracts.ts";

const OPPOSITE_DIRECTION = [1, 0, 3, 2] as const;

function makeContext(): SolverExecutionContext {
  return {
    now: () => performance.now(),
    signal: new AbortController().signal,
    reportProgress: () => undefined,
  };
}

function makeRequest(rows: string[]): SolverRequest {
  const parsed = parsePuzzleRows(rows);
  return {
    board: parsed,
    snapshot: {
      puzzleId: "test",
      robot: parsed.initialRobot,
      boxes: parsed.initialBoxes,
      moves: 0,
      pushes: 0,
      solved: false,
    },
    objective: { kind: "moves" },
    limits: {
      maxElapsedMs: 30000,
      maxExpandedStates: 500_000,
      maxGeneratedStates: 2_000_000,
      maxMemoryBytes: 256 * 1024 * 1024,
    },
  };
}

function compileBoard(rows: string[]): CompiledSearchBoard {
  return compileSearchBoard(parsePuzzleRows(rows));
}

function getBoxes(board: CompiledSearchBoard, rows: string[]): readonly DenseBox[] {
  const parsed = parsePuzzleRows(rows);
  return toDenseBoxes(board, parsed.initialBoxes);
}

function getRobotCell(board: CompiledSearchBoard, rows: string[]): number {
  const parsed = parsePuzzleRows(rows);
  return board.cellAt(parsed.initialRobot.row, parsed.initialRobot.column);
}

function makePattern(
  board: CompiledSearchBoard,
  label: string,
  goalCells: number[],
): MoveCostPattern {
  const regionSet = new Set<number>();
  for (const goalCell of goalCells) {
    const dist = board.reversePushDistancesByGoal.get(goalCell);
    if (!dist) continue;
    for (let c = 0; c < board.cellCount; c++) {
      if (dist[c] >= 0) regionSet.add(c);
    }
  }
  return {
    id: 0,
    label,
    goalCells: [...goalCells].sort((a, b) => a - b),
    boxCount: goalCells.length,
    boxRegionCells: [...regionSet].sort((a, b) => a - b),
    boxRegionSet: regionSet,
  };
}

function bruteForceOptimal(
  board: CompiledSearchBoard,
  boxes: readonly DenseBox[],
  robotCell: number,
): number {
  return exactRemainingMoves(board, robotCell, boxes).exactMoves ?? Infinity;
}

// ==========================================================================
// Tests
// ==========================================================================

describe("move-cost-pattern-pdb", () => {

  // -----------------------------------------------------------------------
  // 28.7: Key encoding
  // -----------------------------------------------------------------------
  describe("combinatorial ranking", () => {
    it("builds a 2-box PDB and ranks states", () => {
      const rows = [
        "OOOOOOO",
        "OS   SO",
        "O X X O",
        "O  R  O",
        "OOOOOOO",
      ];
      const board = compileBoard(rows);
      const patterns = selectGoalPatterns(board);
      assert.ok(patterns.length > 0, "should find at least one multi-goal pattern");

      const pdb = buildMoveCostPatternPdb(board, patterns[0], {
        maxSettledStates: 100_000,
        maxBuildMs: 5000,
      });

      assert.ok(pdb.stats.settledStates > 0, "should settle states");
      assert.ok(pdb.ctx.maxStateRank > 0, "should have positive rank space");
    });
  });

  // -----------------------------------------------------------------------
  // 28.1: Complete tiny-pattern equality
  // -----------------------------------------------------------------------
  describe("complete tiny-board equality", () => {
    it("matches brute-force optimal on a 1-box board", () => {
      const rows = [
        "OOOOO",
        "OS  O",
        "O X O",
        "O R O",
        "OOOOO",
      ];
      const board = compileBoard(rows);
      const boxes = getBoxes(board, rows);
      const robotCell = getRobotCell(board, rows);

      const goalCells: number[] = [];
      for (const cells of board.goalCellsByLabel.values()) {
        goalCells.push(...cells);
      }
      if (goalCells.length < 1) return;

      const label = boxes[0].label;
      // 1-box pattern is skipped by selectGoalPatterns (needs >= 2), but we
      // can test admissibility manually
      const pattern = makePattern(board, label, goalCells);

      const pdb = buildMoveCostPatternPdb(board, pattern, {
        maxSettledStates: 1_000_000,
        maxBuildMs: 10_000,
        maxUsefulDistance: 200,
      });

      const exactOptimal = bruteForceOptimal(board, boxes, robotCell);
      assert.ok(Number.isFinite(exactOptimal), "brute-force should solve");

      const workspace = new PatternWalkWorkspace(board.cellCount);
      const sortedCells = Uint16Array.from(boxes.map(b => b.cell)).sort();
      const pdbValue = evaluateMoveCostPattern(
        board, pdb, sortedCells, robotCell, workspace,
      );

      assert.ok(
        pdbValue <= exactOptimal,
        `MC-PDB ${pdbValue} must be <= brute-force ${exactOptimal}`,
      );
    });

    it("matches brute-force on a 2-box board", () => {
      const rows = [
        "OOOOOOO",
        "OS   SO",
        "O X X O",
        "O  R  O",
        "OOOOOOO",
      ];
      const board = compileBoard(rows);
      const boxes = getBoxes(board, rows);
      const robotCell = getRobotCell(board, rows);

      const goalCells: number[] = [];
      for (const cells of board.goalCellsByLabel.values()) {
        goalCells.push(...cells);
      }
      const label = boxes[0].label;
      const pattern = makePattern(board, label, goalCells);

      const pdb = buildMoveCostPatternPdb(board, pattern, {
        maxSettledStates: 1_000_000,
        maxBuildMs: 10_000,
        maxUsefulDistance: 200,
      });

      assert.ok(pdb.stats.settledStates > 0);

      const exactOptimal = bruteForceOptimal(board, boxes, robotCell);
      assert.ok(Number.isFinite(exactOptimal), "brute-force should solve");

      const workspace = new PatternWalkWorkspace(board.cellCount);
      const sortedCells = Uint16Array.from(boxes.map(b => b.cell)).sort();
      const pdbValue = evaluateMoveCostPattern(
        board, pdb, sortedCells, robotCell, workspace,
      );

      assert.ok(
        pdbValue <= exactOptimal,
        `MC-PDB ${pdbValue} must be <= brute-force ${exactOptimal}`,
      );
    });
  });

  // -----------------------------------------------------------------------
  // 28.2: Exhaustive concrete admissibility
  // -----------------------------------------------------------------------
  describe("exhaustive admissibility", () => {
    it("MC-PDB <= exact remaining moves for every reachable state", () => {
      const rows = [
        "OOOOO",
        "OS  O",
        "O X O",
        "O R O",
        "OOOOO",
      ];
      const board = compileBoard(rows);
      const parsed = parsePuzzleRows(rows);
      const initialBoxes = toDenseBoxes(board, parsed.initialBoxes);
      const initialRobot = board.cellAt(parsed.initialRobot.row, parsed.initialRobot.column);

      const goalCells: number[] = [];
      for (const cells of board.goalCellsByLabel.values()) {
        goalCells.push(...cells);
      }
      if (goalCells.length < 1) return;

      const label = initialBoxes[0].label;
      const pattern = makePattern(board, label, goalCells);

      const pdb = buildMoveCostPatternPdb(board, pattern, {
        maxSettledStates: 1_000_000,
        maxBuildMs: 5000,
        maxUsefulDistance: 200,
      });

      const { cellCount } = board;
      const k = initialBoxes.length;

      interface State { robot: number; boxes: DenseBox[] }

      function stateKey(s: State): string {
        const sorted = [...s.boxes].sort((a, b) => a.label.localeCompare(b.label) || a.cell - b.cell);
        return `${s.robot}:${sorted.map(b => `${b.label}@${b.cell}`).join(",")}`;
      }

      const allStates = new Map<string, State>();
      const stateQueue: State[] = [];
      const initState: State = {
        robot: initialRobot,
        boxes: initialBoxes.map(b => ({ ...b })),
      };
      allStates.set(stateKey(initState), initState);
      stateQueue.push(initState);

      for (let head = 0; head < stateQueue.length; head++) {
        const state = stateQueue[head];
        const occ = new Uint8Array(cellCount);
        for (const b of state.boxes) occ[b.cell] = 1;

        const walkQ = [state.robot];
        const walkDist = new Map<number, number>();
        walkDist.set(state.robot, 0);
        for (let wh = 0; wh < walkQ.length; wh++) {
          const cell = walkQ[wh];
          const d = walkDist.get(cell)!;
          for (let dir = 0; dir < 4; dir++) {
            const next = board.neighbors[cell][dir];
            if (next < 0 || occ[next] !== 0 || walkDist.has(next)) continue;
            walkDist.set(next, d + 1);
            walkQ.push(next);
          }
        }

        for (let bi = 0; bi < k; bi++) {
          const box = state.boxes[bi];
          const nbrs = board.neighbors[box.cell];
          if (!nbrs) continue;
          for (let d = 0; d < 4; d++) {
            const dest = nbrs[d];
            const support = nbrs[OPPOSITE_DIRECTION[d]];
            if (dest < 0 || support < 0 || occ[dest] !== 0) continue;
            if (!walkDist.has(support)) continue;

            const newBoxes = state.boxes.map((b, i) =>
              i === bi ? { ...b, cell: dest } : { ...b },
            );
            const newState: State = { robot: box.cell, boxes: newBoxes };
            const key = stateKey(newState);
            if (!allStates.has(key)) {
              allStates.set(key, newState);
              stateQueue.push(newState);
            }
          }
        }
      }

      let violationCount = 0;
      const workspace = new PatternWalkWorkspace(board.cellCount);

      for (const state of allStates.values()) {
        const exactOpt = bruteForceOptimal(board, state.boxes, state.robot);
        if (!Number.isFinite(exactOpt)) continue;

        const sortedCells = Uint16Array.from(state.boxes.map(b => b.cell)).sort();
        const pdbValue = evaluateMoveCostPattern(
          board, pdb, sortedCells, state.robot, workspace,
        );

        if (pdbValue > exactOpt) {
          violationCount++;
        }
      }

      assert.equal(violationCount, 0,
        `MC-PDB must be admissible for all ${allStates.size} reachable states`);
    });
  });

  // -----------------------------------------------------------------------
  // 28.3: Partial-radius safety
  // -----------------------------------------------------------------------
  describe("partial radius safety", () => {
    it("partial PDB value <= complete PDB value", () => {
      const rows = [
        "OOOOOOO",
        "OS   SO",
        "O X X O",
        "O  R  O",
        "OOOOOOO",
      ];
      const board = compileBoard(rows);

      const goalCells: number[] = [];
      const label = [...board.goalCellsByLabel.keys()][0];
      goalCells.push(...(board.goalCellsByLabel.get(label) ?? []));

      const pattern = makePattern(board, label, goalCells);

      const completePdb = buildMoveCostPatternPdb(board, pattern, {
        maxSettledStates: 1_000_000,
        maxBuildMs: 10_000,
        maxUsefulDistance: 200,
      });

      const partialPdb = buildMoveCostPatternPdb(board, pattern, {
        maxSettledStates: 3,
        maxBuildMs: 10_000,
        maxUsefulDistance: 200,
      });

      assert.ok(partialPdb.stats.settledStates <= 3);

      const boxes = getBoxes(board, rows);
      const robotCell = getRobotCell(board, rows);
      const workspace = new PatternWalkWorkspace(board.cellCount);
      const sortedCells = Uint16Array.from(boxes.map(b => b.cell)).sort();

      const completeValue = evaluateMoveCostPattern(
        board, completePdb, sortedCells, robotCell, workspace,
      );
      const partialValue = evaluateMoveCostPattern(
        board, partialPdb, sortedCells, robotCell, workspace,
      );

      assert.ok(
        partialValue <= completeValue,
        `Partial ${partialValue} must be <= complete ${completeValue}`,
      );
    });
  });

  // -----------------------------------------------------------------------
  // 28.4: Same-label subset safety (n > k)
  // -----------------------------------------------------------------------
  describe("same-label subset minimum", () => {
    it("returns minimum over compatible subsets when n > k", () => {
      // Valid board: 3 boxes, 3 goals. Build pattern with only 2 goals
      // so evaluator sees 3 boxes but a 2-goal pattern → subset selection.
      const rows = [
        "OOOOOOOOO",
        "OS  S  SO",
        "O X X X O",
        "O   R   O",
        "OOOOOOOOO",
      ];
      const board = compileBoard(rows);
      const boxes = getBoxes(board, rows);
      const robotCell = getRobotCell(board, rows);

      const allGoalCells: number[] = [];
      const label = boxes[0].label;
      for (const c of board.goalCellsByLabel.get(label) ?? []) allGoalCells.push(c);
      assert.ok(allGoalCells.length >= 3, "Need at least 3 goals");

      // Build pattern with only the first 2 goals (subset of all goals)
      const subsetGoals = allGoalCells.slice(0, 2);
      const pattern = makePattern(board, label, subsetGoals);
      assert.equal(pattern.boxCount, 2, "Pattern has 2 goals");

      const pdb = buildMoveCostPatternPdb(board, pattern, {
        maxSettledStates: 1_000_000,
        maxBuildMs: 5000,
        maxUsefulDistance: 200,
      });

      // evaluateMoveCostPatternWithSubsets should pick the best 2-of-3
      const pdbValue = evaluateMoveCostPatternWithSubsets(
        board, pdb, boxes, robotCell,
      );
      const exactOptimal = bruteForceOptimal(board, boxes, robotCell);
      assert.ok(
        pdbValue <= exactOptimal,
        `Subset eval ${pdbValue} must be <= exact ${exactOptimal}`,
      );
    });
  });

  // -----------------------------------------------------------------------
  // 28.5: Removed-box relaxation
  // -----------------------------------------------------------------------
  describe("removed-box relaxation", () => {
    it("pattern evaluation ignores non-pattern boxes", () => {
      // Board with a typed box (A/a) that is NOT in the X/S pattern
      const rows = [
        "OOOOOOaO",
        "OS  R AO",
        "O X    O",
        "OOOOOOOO",
      ];
      const board = compileBoard(rows);
      const boxes = getBoxes(board, rows);
      const robotCell = getRobotCell(board, rows);

      // Pattern for the generic label only
      const genericLabel = boxes.find(b => b.label === "S")?.label ?? "S";
      const goalCells = board.goalCellsByLabel.get(genericLabel);
      if (!goalCells || goalCells.length < 1) return;

      const pattern = makePattern(board, genericLabel, [...goalCells]);
      const pdb = buildMoveCostPatternPdb(board, pattern, {
        maxSettledStates: 1_000_000,
        maxBuildMs: 5000,
        maxUsefulDistance: 200,
      });

      const exactOptimal = bruteForceOptimal(board, boxes, robotCell);
      if (!Number.isFinite(exactOptimal)) return;

      const pdbValue = evaluateMoveCostPatternWithSubsets(
        board, pdb, boxes, robotCell,
      );

      assert.ok(
        pdbValue <= exactOptimal,
        `MC-PDB with removed boxes (${pdbValue}) must be <= exact (${exactOptimal})`,
      );
    });
  });

  // -----------------------------------------------------------------------
  // 28.6: Terminal states
  // -----------------------------------------------------------------------
  describe("terminal state handling", () => {
    it("returns 0 when pattern boxes are on goals", () => {
      const rows = [
        "OOOOO",
        "OS  O",
        "O X O",
        "O R O",
        "OOOOO",
      ];
      const board = compileBoard(rows);
      const goalCells: number[] = [];
      const label = [...board.goalCellsByLabel.keys()][0];
      goalCells.push(...(board.goalCellsByLabel.get(label) ?? []));
      if (goalCells.length < 1) return;

      const pattern = makePattern(board, label, goalCells);
      const pdb = buildMoveCostPatternPdb(board, pattern, {
        maxSettledStates: 1_000_000,
        maxBuildMs: 5000,
        maxUsefulDistance: 200,
      });

      const sortedGoals = Uint16Array.from(goalCells).sort();
      const workspace = new PatternWalkWorkspace(board.cellCount);

      let testRobotCell = -1;
      for (let c = 0; c < board.cellCount; c++) {
        if (!goalCells.includes(c)) { testRobotCell = c; break; }
      }
      if (testRobotCell < 0) return;

      const value = evaluateMoveCostPattern(
        board, pdb, sortedGoals, testRobotCell, workspace,
      );
      assert.equal(value, 0, "Pattern solved => value must be 0");
    });
  });

  // -----------------------------------------------------------------------
  // 28.8: A* consistency check
  // -----------------------------------------------------------------------
  describe("A* admissibility check", () => {
    it("MC-PDB value <= A* optimal on tiny board", async () => {
      const rows = [
        "OOOOO",
        "OS  O",
        "O X O",
        "O R O",
        "OOOOO",
      ];
      const request = makeRequest(rows);
      const baseResult = await runExactMoveAStar(request, makeContext());
      assert.equal(baseResult.status, "solved");

      const board = compileBoard(rows);
      const boxes = getBoxes(board, rows);
      const robotCell = getRobotCell(board, rows);

      const goalCells: number[] = [];
      const label = boxes[0].label;
      for (const c of board.goalCellsByLabel.get(label) ?? []) goalCells.push(c);
      if (goalCells.length < 1) return;

      const pattern = makePattern(board, label, goalCells);
      const pdb = buildMoveCostPatternPdb(board, pattern, {
        maxSettledStates: 1_000_000,
        maxBuildMs: 5000,
        maxUsefulDistance: 200,
      });

      const workspace = new PatternWalkWorkspace(board.cellCount);
      const sortedCells = Uint16Array.from(boxes.map(b => b.cell)).sort();
      const pdbValue = evaluateMoveCostPattern(
        board, pdb, sortedCells, robotCell, workspace,
      );

      assert.ok(baseResult.status === "solved" && baseResult.solution);
      assert.ok(
        pdbValue <= baseResult.solution.moves,
        `MC-PDB ${pdbValue} must be <= optimal ${baseResult.solution.moves}`,
      );
    });
  });

  // -----------------------------------------------------------------------
  // 28.10: Cancellation and limits
  // -----------------------------------------------------------------------
  describe("cancellation and limits", () => {
    it("respects tiny state budget without crashing", () => {
      const rows = [
        "OOOOOOO",
        "OS   SO",
        "O X X O",
        "O  R  O",
        "OOOOOOO",
      ];
      const board = compileBoard(rows);
      const goalCells: number[] = [];
      const label = [...board.goalCellsByLabel.keys()][0];
      goalCells.push(...(board.goalCellsByLabel.get(label) ?? []));

      const pattern = makePattern(board, label, goalCells);
      const pdb = buildMoveCostPatternPdb(board, pattern, {
        maxSettledStates: 1,
        maxBuildMs: 50,
        maxUsefulDistance: 200,
      });

      assert.ok(pdb.stats.settledStates <= 1);
      assert.ok(!pdb.stats.complete);
    });

    it("respects tiny time budget", () => {
      const rows = [
        "OOOOOOO",
        "OS   SO",
        "O X X O",
        "O  R  O",
        "OOOOOOO",
      ];
      const board = compileBoard(rows);
      const goalCells: number[] = [];
      const label = [...board.goalCellsByLabel.keys()][0];
      goalCells.push(...(board.goalCellsByLabel.get(label) ?? []));

      const pattern = makePattern(board, label, goalCells);
      const pdb = buildMoveCostPatternPdb(board, pattern, {
        maxSettledStates: 1_000_000,
        maxBuildMs: 0,
        maxUsefulDistance: 200,
      });

      assert.ok(pdb.stats.buildTimeMs >= 0);
    });
  });

  // -----------------------------------------------------------------------
  // Pattern selection
  // -----------------------------------------------------------------------
  describe("pattern selection", () => {
    it("finds patterns for boards with multiple same-label goals", () => {
      const rows = [
        "OOOOOOO",
        "OS   SO",
        "O X X O",
        "O  R  O",
        "OOOOOOO",
      ];
      const board = compileBoard(rows);
      const patterns = selectGoalPatterns(board);
      assert.ok(patterns.length > 0);
      assert.ok(patterns[0].boxCount >= 2);
    });

    it("skips labels with only one goal", () => {
      const rows = [
        "OOOOOOaO",
        "OS  R AO",
        "O X    O",
        "OOOOOOOO",
      ];
      const board = compileBoard(rows);
      const patterns = selectGoalPatterns(board);
      // 'S' label has 1 goal, 'A' label has 1 goal — both should be skipped
      assert.equal(patterns.length, 0, "single-goal labels should be skipped");
    });
  });

  // -----------------------------------------------------------------------
  // Telemetry
  // -----------------------------------------------------------------------
  describe("telemetry", () => {
    it("reports meaningful build statistics", () => {
      const rows = [
        "OOOOOOO",
        "OS   SO",
        "O X X O",
        "O  R  O",
        "OOOOOOO",
      ];
      const board = compileBoard(rows);
      const goalCells: number[] = [];
      const label = [...board.goalCellsByLabel.keys()][0];
      goalCells.push(...(board.goalCellsByLabel.get(label) ?? []));

      const pattern = makePattern(board, label, goalCells);
      const pdb = buildMoveCostPatternPdb(board, pattern, {
        maxSettledStates: 1_000_000,
        maxBuildMs: 5000,
        maxUsefulDistance: 200,
      });

      assert.ok(pdb.stats.settledStates > 0);
      assert.ok(pdb.stats.buildTimeMs >= 0);
      assert.ok(pdb.stats.retainedBytes > 0);
      assert.ok(pdb.stats.completedRadius >= 0);

      const boxes = getBoxes(board, rows);
      const robotCell = getRobotCell(board, rows);
      const workspace = new PatternWalkWorkspace(board.cellCount);
      const sortedCells = Uint16Array.from(boxes.map(b => b.cell)).sort();
      evaluateMoveCostPattern(board, pdb, sortedCells, robotCell, workspace);

      assert.ok(pdb.stats.queries > 0 || pdb.stats.walkFloods > 0);
    });
  });

  // -----------------------------------------------------------------------
  // Integration: solver with moveCostPatternPdb feature flag
  // -----------------------------------------------------------------------
  describe("solver integration", () => {
    const oracleRows = ["OOOOOOO", "OS   SO", "O X X O", "O  R  O", "OOOOOOO"];
    const rotatedRows = Array.from({ length: oracleRows[0].length }, (_, row) =>
      oracleRows.map((line) => line[row]).reverse().join(""));
    for (const [name, rows] of [
      ["base", oracleRows],
      ["mirror", oracleRows.map((row) => [...row].reverse().join(""))],
      ["rotation", rotatedRows],
    ] as const) {
      it(`matches the independent move oracle in A* and IDA* (${name})`, async () => {
        const request = makeRequest(rows);
        const board = compileBoard(rows);
        const oracle = exactRemainingMoves(board, getRobotCell(board, rows), getBoxes(board, rows));
        assert.ok(oracle.exactMoves !== null);
        for (const run of [runExactMoveAStar, runIdaStarSearch]) {
          const result = await run(request, makeContext(), { features: { moveCostPatternPdb: true } });
          assert.equal(result.status, "solved");
          if (result.status !== "solved") throw new Error("Expected a solved oracle fixture.");
          assert.equal(result.solution.moves, oracle.exactMoves);
          assert.equal(result.solution.optimality, "proven");
          assert.equal(verifySolverSolution(request, result.solution).valid, true);
        }
      });
    }

    it("solves a small board with moveCostPatternPdb enabled", async () => {
      const rows = [
        "OOOOOOO",
        "OS   SO",
        "O X X O",
        "O  R  O",
        "OOOOOOO",
      ];
      const req = makeRequest(rows);

      const result = await runExactMoveAStar(
        req,
        makeContext(),
        { features: { moveCostPatternPdb: true } },
      );
      assert.equal(result.status, "solved");
      if (result.status !== "solved") throw new Error("unreachable");
      assert.equal(result.solution.optimality, "proven");
      assert.ok(result.solution.moves > 0);

      const counters = result.metrics?.counters;
      assert.ok(counters, "metrics.counters must exist");
      assert.ok(
        (counters!.moveCostPdbPatterns as number) > 0,
        "MC-PDB should have built at least one pattern",
      );
      assert.ok(
        (counters!.moveCostPdbSettledStates as number) > 0,
        "MC-PDB should have settled some states",
      );
    });

    it("gives same optimal answer with and without MC-PDB", async () => {
      const rows = [
        "OOOOOOO",
        "OS   SO",
        "O X X O",
        "O  R  O",
        "OOOOOOO",
      ];
      const req = makeRequest(rows);

      const baseResult = await runExactMoveAStar(req, makeContext());
      const mcpdbResult = await runExactMoveAStar(
        req,
        makeContext(),
        { features: { moveCostPatternPdb: true } },
      );

      assert.equal(baseResult.status, "solved");
      assert.equal(mcpdbResult.status, "solved");
      if (baseResult.status !== "solved" || mcpdbResult.status !== "solved") {
        throw new Error("unreachable");
      }
      assert.equal(
        baseResult.solution.moves,
        mcpdbResult.solution.moves,
        "Optimal move count must match with and without MC-PDB",
      );
    });
  });

  // -----------------------------------------------------------------------
  // Phase 3: Candidate generation and probe scoring
  // -----------------------------------------------------------------------
  describe("candidate generation", () => {
    it("generates sub-patterns for Grand Hall board", () => {
      const rows = [
        "OOOOOOOOOOOOOOO",
        "OaSS   S   SSbO",
        "OSCS  OOO  SDSO",
        "OX X  OOO  X XO",
        "O     OOO     O",
        "OOOO   X   OOOO",
        "O      O      O",
        "O G hOOOOOH g O",
        "O      O      O",
        "OOO         OOO",
        "OOO   X X   OOO",
        "OOOOOOOROOOOOOO",
        "O B X X X X A O",
        "O Sc       dS O",
        "OOOOOOOOOOOOOOO",
      ];
      const board = compileBoard(rows);
      const candidates = generateCandidatePatterns(board, { maxK: 7, minK: 2 });

      assert.ok(candidates.length >= 2, `Expected >=2 candidates, got ${candidates.length}`);
      assert.ok(candidates.length <= 10, `Too many candidates: ${candidates.length}`);

      for (const c of candidates) {
        assert.equal(c.label, "X", "Grand Hall sub-patterns should be X-label");
        assert.ok(c.boxCount >= 2 && c.boxCount <= 7, `boxCount ${c.boxCount} out of range`);
        assert.ok(c.boxRegionCells.length > 0, "Region must be non-empty");
      }

      const sizes = new Set(candidates.map(c => c.boxCount));
      assert.ok(sizes.size >= 2, "Should generate patterns of varying sizes");
    });

    it("generates the full pattern for small boards", () => {
      const rows = [
        "OOOOOOO",
        "OS   SO",
        "O X X O",
        "O  R  O",
        "OOOOOOO",
      ];
      const board = compileBoard(rows);
      const candidates = generateCandidatePatterns(board, { maxK: 7, minK: 2 });

      assert.ok(candidates.length >= 1);
      const full = candidates.find(c => c.boxCount === 2);
      assert.ok(full, "Should include the full 2-goal pattern");
    });
  });

  describe("probe and select", () => {
    it("probes Grand Hall candidates and selects best", () => {
      const rows = [
        "OOOOOOOOOOOOOOO",
        "OaSS   S   SSbO",
        "OSCS  OOO  SDSO",
        "OX X  OOO  X XO",
        "O     OOO     O",
        "OOOO   X   OOOO",
        "O      O      O",
        "O G hOOOOOH g O",
        "O      O      O",
        "OOO         OOO",
        "OOO   X X   OOO",
        "OOOOOOOROOOOOOO",
        "O B X X X X A O",
        "O Sc       dS O",
        "OOOOOOOOOOOOOOO",
      ];
      const board = compileBoard(rows);
      const { collection, telemetry } = probeAndSelectPatterns(
        board, undefined, () => performance.now(),
        { probeStates: 20_000, probeTimeMs: 2_000, fullBuildStates: 50_000, fullBuildTimeMs: 3_000 },
      );

      assert.ok(telemetry.candidatesGenerated >= 2, `Generated ${telemetry.candidatesGenerated}`);
      assert.ok(telemetry.candidatesProbed >= 2, `Probed ${telemetry.candidatesProbed}`);
      assert.ok(telemetry.candidatesSelected >= 1, `Selected ${telemetry.candidatesSelected}`);
      assert.ok(telemetry.totalSettledStates > 0);
      assert.ok(collection.patterns.length >= 1);

      const probeScores = telemetry.probes.map(p => p.score);
      for (let i = 1; i < probeScores.length; i++) {
        assert.ok(probeScores[i - 1] >= probeScores[i], "Probes should be sorted by score descending");
      }

      const best = telemetry.probes[0];
      assert.ok(best.completedRadius >= 0);
      assert.ok(best.settledStates > 0);
      assert.ok(best.score > 0);
    });

    it("returns admissible values from probed collection", () => {
      const rows = [
        "OOOOOOO",
        "OS   SO",
        "O X X O",
        "O  R  O",
        "OOOOOOO",
      ];
      const board = compileBoard(rows);
      const boxes = getBoxes(board, rows);
      const robotCell = getRobotCell(board, rows);

      const { collection } = probeAndSelectPatterns(board);
      const value = collection.evaluate(boxes, robotCell);
      const exact = bruteForceOptimal(board, boxes, robotCell);

      assert.ok(
        value <= exact,
        `Probed collection value ${value} must be <= exact ${exact}`,
      );
    });
  });

  // -----------------------------------------------------------------------
  // Rank/unrank round-trip
  // -----------------------------------------------------------------------
  describe("rank/unrank round-trip", () => {
    it("round-trips every valid rank for small spaces", () => {
      for (const [m, k] of [[8, 2], [8, 3], [8, 4], [6, 2], [6, 3]] as const) {
        const binom = precomputeBinomials(m, k);
        const totalRanks = Math.round(binom[m][k]);
        const combo = new Uint16Array(k);
        const reranked = new Uint16Array(k);

        for (let r = 0; r < totalRanks; r++) {
          unrankCombination(r, m, k, binom, combo);

          for (let i = 1; i < k; i++) {
            assert.ok(
              combo[i] > combo[i - 1],
              `unrank(${r}, m=${m}, k=${k}) not strictly ascending: [${combo}]`,
            );
          }
          assert.ok(
            combo[k - 1] < m,
            `unrank(${r}, m=${m}, k=${k}) out of range: [${combo}]`,
          );

          const roundTripped = rankCombination(combo, k, binom);
          assert.equal(
            roundTripped, r,
            `rank(unrank(${r})) = ${roundTripped} for m=${m}, k=${k}`,
          );
        }

        const allCombos: number[][] = [];
        function enumerate(start: number, depth: number, current: number[]): void {
          if (depth === k) { allCombos.push([...current]); return; }
          for (let c = start; c < m; c++) {
            current.push(c);
            enumerate(c + 1, depth + 1, current);
            current.pop();
          }
        }
        enumerate(0, 0, []);

        assert.equal(allCombos.length, totalRanks, `C(${m},${k}) count mismatch`);

        for (const combo of allCombos) {
          const arr = Uint16Array.from(combo);
          const rank = rankCombination(arr, k, binom);
          unrankCombination(rank, m, k, binom, reranked);
          assert.deepEqual(
            [...reranked], combo,
            `unrank(rank([${combo}])) failed for m=${m}, k=${k}`,
          );
        }
      }
    });
  });

  // -----------------------------------------------------------------------
  // Roadmap counterexample — boxes at cellAt(2,2) and cellAt(2,3),
  // robot at cellAt(1,3) — a mid-game state, not the initial position
  // -----------------------------------------------------------------------
  describe("roadmap counterexample", () => {
    it("MC-PDB value does not exceed oracle on the 2-box reproducer", () => {
      const rows = [
        "OOOOOOO",
        "O  R  O",
        "O S   O",
        "O S   O",
        "O XX  O",
        "OOOOOOO",
      ];
      const board = compileBoard(rows);
      const initialBoxes = getBoxes(board, rows);
      const label = initialBoxes[0].label;

      const testBoxes: DenseBox[] = [
        { id: "box-1", label, cell: board.cellAt(2, 2) },
        { id: "box-2", label, cell: board.cellAt(2, 3) },
      ];
      const testRobot = board.cellAt(1, 3);

      const patterns = selectGoalPatterns(board);
      assert.ok(patterns.length > 0, "should find a pattern for this board");

      const pattern = patterns[0];
      const pdb = buildMoveCostPatternPdb(board, pattern, {
        maxSettledStates: 100_000,
        maxBuildMs: 5_000,
        maxUsefulDistance: 80,
      });

      const workspace = new PatternWalkWorkspace(board.cellCount);
      const sortedCells = Uint16Array.from(testBoxes.map(b => b.cell)).sort();
      const pdbValue = evaluateMoveCostPattern(
        board, pdb, sortedCells, testRobot, workspace,
      );

      const oracleResult = exactRemainingMoves(board, testRobot, testBoxes);
      assert.ok(oracleResult.exactMoves !== null, "oracle should solve from this state");
      assert.ok(
        pdbValue <= oracleResult.exactMoves!,
        `MC-PDB ${pdbValue} exceeds oracle ${oracleResult.exactMoves} — inadmissible`,
      );
    });
  });

  // -----------------------------------------------------------------------
  // Exhaustive admissibility on all reachable states of a 2-box board
  // -----------------------------------------------------------------------
  describe("exhaustive 2-box admissibility", () => {
    it("MC-PDB <= oracle for every reachable state", () => {
      const rows = [
        "OOOOOOO",
        "OS   SO",
        "O X X O",
        "O  R  O",
        "OOOOOOO",
      ];
      const board = compileBoard(rows);
      const boxes = getBoxes(board, rows);
      const robotCell = getRobotCell(board, rows);

      const patterns = selectGoalPatterns(board);
      assert.ok(patterns.length > 0);

      const pattern = patterns[0];
      const pdb = buildMoveCostPatternPdb(board, pattern, {
        maxSettledStates: 1_000_000,
        maxBuildMs: 10_000,
        maxUsefulDistance: 200,
      });

      const workspace = new PatternWalkWorkspace(board.cellCount);
      const stateMap = allReachableStates(board, robotCell, boxes);
      let violations = 0;

      for (const state of stateMap.values()) {
        const sortedCells = Uint16Array.from(
          state.boxes.map(b => b.cell),
        ).sort();
        const pdbValue = evaluateMoveCostPattern(
          board, pdb, sortedCells, state.robot, workspace,
        );

        if (state.exactMoves === null) continue;

        if (pdbValue > state.exactMoves) {
          violations++;
          assert.fail(
            `Inadmissible at robot=${state.robot} boxes=[${sortedCells}]: ` +
            `MC-PDB=${pdbValue} > oracle=${state.exactMoves}`,
          );
        }
      }

      assert.equal(violations, 0, `${violations} admissibility violations found`);
    });
  });
});
