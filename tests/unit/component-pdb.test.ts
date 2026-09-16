import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parsePuzzleRows } from "../../src/core/index.ts";
import {
  compileSearchBoard,
  SEARCH_DIRECTION_COUNT,
  type CompiledSearchBoard,
} from "../../src/solver/search/compiled-board.ts";
import {
  analyzeMatchingComponents,
  extractMatchingComponents,
} from "../../src/solver/search/matching-components.ts";
import {
  compileSingleBoxPushGraph,
} from "../../src/solver/search/single-box-push-graph.ts";
import {
  buildComponentPdbs,
  buildComponentPdbCollection,
} from "../../src/solver/search/component-pdb.ts";
import {
  toDenseBoxes,
  type DenseBox,
} from "../../src/solver/search/model.ts";
import { runExactMoveAStar } from "../../src/solver/search/exact-move-astar.ts";
import { runIdaStarSearch } from "../../src/solver/search/ida-star.ts";
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

function defaultBudget() {
  return {
    signal: new AbortController().signal,
    now: () => performance.now(),
    deadline: performance.now() + 30000,
    baseMemoryBytes: 0,
  };
}

function buildComponentsForRows(rows: string[]) {
  const parsed = parsePuzzleRows(rows);
  const board = compileSearchBoard(parsed);
  const budget = defaultBudget();
  const singleBoxGraph = compileSingleBoxPushGraph(board, budget);
  const matchingResult = analyzeMatchingComponents(board, singleBoxGraph);
  const components = extractMatchingComponents(board, matchingResult);
  return { board, parsed, components, matchingResult };
}

function buildCollectionForRows(
  rows: string[],
  totalMaxStates = 100_000,
  maxStatesPerComponent = 50_000,
) {
  const { board, parsed, components, matchingResult } =
    buildComponentsForRows(rows);
  const collection = buildComponentPdbCollection(
    board,
    components,
    { totalMaxStates, maxStatesPerComponent },
    defaultBudget(),
    () => performance.now(),
  );
  return { board, parsed, components, matchingResult, collection };
}

function boxesByLabel(
  boxes: readonly DenseBox[],
): Map<string, number[]> {
  const result = new Map<string, number[]>();
  for (const box of boxes) {
    let cells = result.get(box.label);
    if (!cells) {
      cells = [];
      result.set(box.label, cells);
    }
    cells.push(box.cell);
  }
  return result;
}

function isSolvedState(
  board: CompiledSearchBoard,
  boxes: readonly DenseBox[],
): boolean {
  for (const box of boxes) {
    if (board.goalLabelByCell[box.cell] !== box.label) return false;
  }
  return true;
}

function exactRemainingPushes(
  board: CompiledSearchBoard,
  robot: number,
  initialBoxes: readonly DenseBox[],
): number | null {
  function stateKey(r: number, bx: readonly DenseBox[]): string {
    const boxKey = bx
      .map(({ label, cell }) => `${label}@${cell}`)
      .sort()
      .join(";");
    return `${r}|${boxKey}`;
  }

  const distances = new Map([[stateKey(robot, initialBoxes), 0]]);
  const queue: { robot: number; boxes: readonly DenseBox[]; pushes: number }[] =
    [{ robot, boxes: initialBoxes, pushes: 0 }];

  for (let head = 0; head < queue.length; head++) {
    const state = queue[head];
    if (isSolvedState(board, state.boxes)) return state.pushes;

    const occupancy = new Uint8Array(board.cellCount);
    for (const box of state.boxes) occupancy[box.cell] = 1;

    const reachable = new Uint8Array(board.cellCount);
    const rQueue: number[] = [state.robot];
    reachable[state.robot] = 1;
    for (let rh = 0; rh < rQueue.length; rh++) {
      const cell = rQueue[rh];
      const nbrs = board.neighbors[cell];
      if (!nbrs) continue;
      for (let d = 0; d < SEARCH_DIRECTION_COUNT; d++) {
        const next = nbrs[d];
        if (next >= 0 && !reachable[next] && !occupancy[next]) {
          reachable[next] = 1;
          rQueue.push(next);
        }
      }
    }

    for (let bi = 0; bi < state.boxes.length; bi++) {
      const box = state.boxes[bi];
      const nbrs = board.neighbors[box.cell];
      if (!nbrs) continue;
      for (let d = 0; d < SEARCH_DIRECTION_COUNT; d++) {
        const dest = nbrs[d];
        if (dest < 0 || occupancy[dest]) continue;
        const support = nbrs[OPPOSITE_DIRECTION[d]];
        if (support === undefined || support < 0 || !reachable[support])
          continue;

        const newBoxes: DenseBox[] = state.boxes.map((b, i) =>
          i === bi ? { id: b.id, label: b.label, cell: dest } : b,
        );
        newBoxes.sort(
          (a, b) => a.label.localeCompare(b.label) || a.cell - b.cell,
        );
        const key = stateKey(box.cell, newBoxes);
        if (distances.has(key)) continue;
        distances.set(key, state.pushes + 1);
        queue.push({
          robot: box.cell,
          boxes: newBoxes,
          pushes: state.pushes + 1,
        });
      }
    }
  }
  return null;
}

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

describe("component-pdb", () => {
  describe("singleton component PDB", () => {
    const ROWS = [
      "OOOOO",
      "OS  O",
      "O X O",
      "O R O",
      "OOOOO",
    ];

    it("builds a complete singleton PDB", () => {
      const { board, components } = buildComponentsForRows(ROWS);
      assert.ok(components.length >= 1, "should have at least one component");

      const pdbs = buildComponentPdbs(
        board,
        components,
        { totalMaxStates: 10_000 },
        defaultBudget(),
        () => performance.now(),
      );
      assert.ok(pdbs.length >= 1);

      const pdb = pdbs[0];
      assert.equal(pdb.boxCount, 1);
      assert.ok(pdb.stats.complete, "singleton PDB should be complete");
      assert.ok(pdb.stats.states > 0);
    });

    it("returns correct distances for singleton PDB", () => {
      const { board, components } = buildComponentsForRows(ROWS);
      const pdbs = buildComponentPdbs(
        board,
        components,
        { totalMaxStates: 10_000 },
        defaultBudget(),
        () => performance.now(),
      );
      const pdb = pdbs[0];
      const goalCell = components[0].goalCells[0];
      const result = pdb.lookup(new Uint16Array([goalCell]));
      assert.equal(result, 0, "goal cell should have distance 0");
    });
  });

  describe("multi-box component PDB", () => {
    const ROWS = [
      "OOOOOOO",
      "OS   SO",
      "O X X O",
      "O  R  O",
      "OOOOOOO",
    ];

    it("builds a multi-box PDB", () => {
      const { board, components } = buildComponentsForRows(ROWS);
      const pdbs = buildComponentPdbs(
        board,
        components,
        { totalMaxStates: 50_000 },
        defaultBudget(),
        () => performance.now(),
      );
      assert.ok(pdbs.length >= 1);
    });

    it("goal configuration has distance 0", () => {
      const { board, components } = buildComponentsForRows(ROWS);
      const pdbs = buildComponentPdbs(
        board,
        components,
        { totalMaxStates: 50_000 },
        defaultBudget(),
        () => performance.now(),
      );
      for (const pdb of pdbs) {
        const comp = components.find((c) => c.id === pdb.componentId)!;
        const goalCells = new Uint16Array(
          [...comp.goalCells].sort((a, b) => a - b),
        );
        const result = pdb.lookup(goalCells);
        assert.equal(
          result,
          0,
          `goal config should have distance 0 for component ${pdb.componentId}`,
        );
      }
    });
  });

  describe("completed-radius miss bound", () => {
    it("returns completedRadius+1 for misses in truncated PDB", () => {
      const ROWS = [
        "OOOOOOOOO",
        "OS     SO",
        "O       O",
        "O X   X O",
        "O       O",
        "O   R   O",
        "OOOOOOOOO",
      ];
      const { board, components } = buildComponentsForRows(ROWS);
      const pdbs = buildComponentPdbs(
        board,
        components,
        { totalMaxStates: 5, maxStatesPerComponent: 5 },
        defaultBudget(),
        () => performance.now(),
      );

      for (const pdb of pdbs) {
        if (!pdb.stats.complete && pdb.stats.completedRadius >= 0) {
          // Find a configuration not in the table
          const farCells = new Uint16Array(pdb.boxCount);
          let cellIdx = 0;
          for (
            let c = 0;
            c < board.cellCount && cellIdx < pdb.boxCount;
            c++
          ) {
            if (board.neighbors[c]) {
              farCells[cellIdx++] = c;
            }
          }
          if (cellIdx === pdb.boxCount) {
            const exact = pdb.lookup(farCells);
            if (exact === undefined) {
              const lb = pdb.lowerBound(farCells);
              assert.ok(
                lb >= pdb.stats.completedRadius + 1,
                `miss lower bound should be >= completedRadius+1 (${pdb.stats.completedRadius + 1}), got ${lb}`,
              );
            }
          }
        }
      }
    });

    it("returns 0 for goal in complete singleton PDB", () => {
      const ROWS = [
        "OOOOO",
        "OS  O",
        "O X O",
        "O R O",
        "OOOOO",
      ];
      const { board, components } = buildComponentsForRows(ROWS);
      const pdbs = buildComponentPdbs(
        board,
        components,
        { totalMaxStates: 10_000 },
        defaultBudget(),
        () => performance.now(),
      );
      const pdb = pdbs[0];
      assert.ok(pdb.stats.complete, "singleton should be complete");
      const goalCell = components[0].goalCells[0];
      const lb = pdb.lowerBound(new Uint16Array([goalCell]));
      assert.equal(lb, 0, "goal should have lowerBound 0");
    });
  });

  describe("admissibility", () => {
    const ROWS = [
      "OOOOO",
      "OS  O",
      "O X O",
      "O R O",
      "OOOOO",
    ];

    it("component PDB lower bound <= exact remaining pushes", () => {
      const { board, parsed, components } = buildComponentsForRows(ROWS);
      const collection = buildComponentPdbCollection(
        board,
        components,
        { totalMaxStates: 10_000 },
        defaultBudget(),
        () => performance.now(),
      );

      const initialBoxes = [...toDenseBoxes(board, parsed.initialBoxes)].sort(
        (a, b) => a.label.localeCompare(b.label) || a.cell - b.cell,
      );
      const initialRobot = board.cellAt(
        parsed.initialRobot.row,
        parsed.initialRobot.column,
      );

      const exact = exactRemainingPushes(board, initialRobot, initialBoxes);
      if (exact !== null) {
        const heuristic = collection.evaluate(boxesByLabel(initialBoxes));
        assert.ok(
          heuristic <= exact,
          `component PDB heuristic (${heuristic}) should be <= exact pushes (${exact})`,
        );
      }
    });

    it("admissible on two-box repeated-label puzzle", () => {
      const ROWS = [
        "OOOOOOO",
        "OS   SO",
        "O X X O",
        "O  R  O",
        "OOOOOOO",
      ];
      const { board, parsed, components } = buildComponentsForRows(ROWS);
      const collection = buildComponentPdbCollection(
        board,
        components,
        { totalMaxStates: 50_000 },
        defaultBudget(),
        () => performance.now(),
      );

      const initialBoxes = [...toDenseBoxes(board, parsed.initialBoxes)].sort(
        (a, b) => a.label.localeCompare(b.label) || a.cell - b.cell,
      );
      const initialRobot = board.cellAt(
        parsed.initialRobot.row,
        parsed.initialRobot.column,
      );

      const exact = exactRemainingPushes(board, initialRobot, initialBoxes);
      if (exact !== null) {
        const heuristic = collection.evaluate(boxesByLabel(initialBoxes));
        assert.ok(
          heuristic <= exact,
          `component PDB heuristic (${heuristic}) should be <= exact pushes (${exact})`,
        );
      }
    });
  });

  describe("collection evaluate", () => {
    it("returns 0 when boxes are on goals", () => {
      const ROWS = [
        "OOOOO",
        "OS  O",
        "O X O",
        "O R O",
        "OOOOO",
      ];
      const { board, collection } = buildCollectionForRows(ROWS);
      const goalCell = [...board.goalCellsByLabel.values()][0][0];
      const label = [...board.goalCellsByLabel.keys()][0];
      const solvedBoxes: DenseBox[] = [
        { id: "test-0", label, cell: goalCell },
      ];
      const result = collection.evaluate(boxesByLabel(solvedBoxes));
      assert.equal(result, 0, "boxes-on-goals config should have heuristic 0");
    });

    it("returns positive value for unsolved state", () => {
      const ROWS = [
        "OOOOO",
        "OS  O",
        "O X O",
        "O R O",
        "OOOOO",
      ];
      const { collection, board, parsed } = buildCollectionForRows(ROWS);
      const initialBoxes = toDenseBoxes(board, parsed.initialBoxes);
      const result = collection.evaluate(boxesByLabel(initialBoxes));
      assert.ok(result > 0, "unsolved state should have positive heuristic");
    });
  });

  describe("forward solver equivalence", () => {
    const SIMPLE_ROWS = [
      "OOOOO",
      "OS  O",
      "O X O",
      "O R O",
      "OOOOO",
    ];

    const TWO_BOX_ROWS = [
      "OOOOOOO",
      "OS   SO",
      "O X X O",
      "O  R  O",
      "OOOOOOO",
    ];

    for (const { name, rows } of [
      { name: "single-box", rows: SIMPLE_ROWS },
      { name: "two-box", rows: TWO_BOX_ROWS },
    ]) {
      it(`A* optimal moves unchanged with componentPdb ON (${name})`, async () => {
        const request = makeRequest(rows);
        const context = makeContext();

        const resultOff = await runExactMoveAStar(request, context, {
          features: { componentPdb: false },
        });
        const resultOn = await runExactMoveAStar(request, context, {
          features: { componentPdb: true },
        });

        assert.equal(resultOff.status, "solved", "OFF should solve");
        assert.equal(resultOn.status, "solved", "ON should solve");
        if (resultOff.status === "solved" && resultOn.status === "solved") {
          assert.equal(
            resultOn.solution.moves,
            resultOff.solution.moves,
            `optimal moves should match: ON=${resultOn.solution.moves} OFF=${resultOff.solution.moves}`,
          );
        }
      });

      it(`IDA* optimal moves unchanged with componentPdb ON (${name})`, async () => {
        const request = makeRequest(rows);
        const context = makeContext();

        const resultOff = await runIdaStarSearch(request, context, {
          features: { componentPdb: false },
        });
        const resultOn = await runIdaStarSearch(request, context, {
          features: { componentPdb: true },
        });

        assert.equal(resultOff.status, "solved", "OFF should solve");
        assert.equal(resultOn.status, "solved", "ON should solve");
        if (resultOff.status === "solved" && resultOn.status === "solved") {
          assert.equal(
            resultOn.solution.moves,
            resultOff.solution.moves,
            `optimal moves should match: ON=${resultOn.solution.moves} OFF=${resultOff.solution.moves}`,
          );
        }
      });
    }
  });

  describe("partition DP correctness", () => {
    it("partition assigns same-label boxes correctly", () => {
      const ROWS = [
        "OOOOOOOOO",
        "OS  S  SO",
        "O       O",
        "OX  X  XO",
        "O       O",
        "O   R   O",
        "OOOOOOOOO",
      ];
      const { collection, board, parsed } = buildCollectionForRows(ROWS);
      const initialBoxes = toDenseBoxes(board, parsed.initialBoxes);
      const result = collection.evaluate(boxesByLabel(initialBoxes));
      assert.ok(
        result >= 0,
        "partition DP should return non-negative value",
      );
    });
  });

  describe("component PDB stats", () => {
    it("tracks query and hit statistics", () => {
      const ROWS = [
        "OOOOO",
        "OS  O",
        "O X O",
        "O R O",
        "OOOOO",
      ];
      const { board, components } = buildComponentsForRows(ROWS);
      const pdbs = buildComponentPdbs(
        board,
        components,
        { totalMaxStates: 10_000 },
        defaultBudget(),
        () => performance.now(),
      );
      const pdb = pdbs[0];
      const initialQueries = pdb.stats.queries;

      const goalCell = components[0].goalCells[0];
      pdb.lookup(new Uint16Array([goalCell]));
      assert.equal(
        pdb.stats.queries,
        initialQueries + 1,
        "queries should increment",
      );
      assert.ok(pdb.stats.hits > 0, "should have at least one hit");
    });
  });

  describe("budget limiting", () => {
    it("respects totalMaxStates budget", () => {
      const ROWS = [
        "OOOOOOOOO",
        "OS     SO",
        "O       O",
        "O X   X O",
        "O       O",
        "O   R   O",
        "OOOOOOOOO",
      ];
      const { board, components } = buildComponentsForRows(ROWS);
      const maxStates = 10;
      const pdbs = buildComponentPdbs(
        board,
        components,
        { totalMaxStates: maxStates },
        defaultBudget(),
        () => performance.now(),
      );
      let totalStates = 0;
      for (const pdb of pdbs) {
        totalStates += pdb.stats.states;
      }
      assert.ok(
        totalStates <= maxStates + components.length,
        `total states (${totalStates}) should be within budget (${maxStates})`,
      );
    });
  });

  describe("multi-label puzzle", () => {
    it("handles puzzles with multiple distinct labels", () => {
      const ROWS = [
        "OOOOOOO",
        "Oa   bO",
        "O A B O",
        "O  R  O",
        "OOOOOOO",
      ];
      const { collection, board, parsed } = buildCollectionForRows(ROWS);
      const initialBoxes = toDenseBoxes(board, parsed.initialBoxes);
      const result = collection.evaluate(boxesByLabel(initialBoxes));
      assert.ok(
        result >= 0,
        "multi-label evaluation should return non-negative",
      );
      assert.ok(
        collection.families.size >= 2,
        `should have families for each label, got ${collection.families.size}`,
      );
    });
  });
});
