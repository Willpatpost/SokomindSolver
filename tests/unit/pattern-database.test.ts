import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parsePuzzleRows } from "../../src/core/index.ts";
import type { SolverRequest } from "../../src/solver/contracts.ts";
import { compileSearchBoard } from "../../src/solver/search/compiled-board.ts";
import { runExactMoveAStar } from "../../src/solver/search/exact-move-astar.ts";
import { runIdaStarSearch } from "../../src/solver/search/ida-star.ts";
import { toDenseBoxes } from "../../src/solver/search/model.ts";
import {
  buildPatternDatabase,
  buildPatternDatabaseAsync,
  buildGoalRegion,
  buildBinomials,
  combinadicEncode,
  combinadicDecode,
  MAX_PDB_TABLE_ENTRIES,
  UNSOLVED,
} from "../../src/solver/search/pattern-database.ts";
import { PdbHeuristicEvaluator } from "../../src/solver/search/pdb-heuristic.ts";

describe("combinadic encoding", () => {
  it("encodes and decodes a roundtrip for k=1", () => {
    const binom = buildBinomials(10, 6);
    for (let p = 0; p < 10; p++) {
      const encoded = combinadicEncode([p], binom);
      const decoded = combinadicDecode(encoded, 1, 10, binom);
      assert.deepEqual(decoded, [p]);
    }
  });

  it("encodes and decodes a roundtrip for k=2", () => {
    const binom = buildBinomials(10, 6);
    const seen = new Set<number>();
    for (let p0 = 0; p0 < 10; p0++) {
      for (let p1 = p0 + 1; p1 < 10; p1++) {
        const encoded = combinadicEncode([p0, p1], binom);
        seen.add(encoded);
        const decoded = combinadicDecode(encoded, 2, 10, binom);
        assert.deepEqual(decoded, [p0, p1]);
      }
    }
    assert.equal(seen.size, 45);
  });

  it("encodes and decodes a roundtrip for k=3", () => {
    const binom = buildBinomials(8, 6);
    for (let p0 = 0; p0 < 6; p0++) {
      for (let p1 = p0 + 1; p1 < 7; p1++) {
        for (let p2 = p1 + 1; p2 < 8; p2++) {
          const positions = [p0, p1, p2];
          const encoded = combinadicEncode(positions, binom);
          const decoded = combinadicDecode(encoded, 3, 8, binom);
          assert.deepEqual(decoded, positions);
        }
      }
    }
  });

  it("produces contiguous indices", () => {
    const binom = buildBinomials(6, 6);
    const indices = new Set<number>();
    for (let p0 = 0; p0 < 4; p0++) {
      for (let p1 = p0 + 1; p1 < 5; p1++) {
        for (let p2 = p1 + 1; p2 < 6; p2++) {
          indices.add(combinadicEncode([p0, p1, p2], binom));
        }
      }
    }
    assert.equal(indices.size, 20);
    for (let i = 0; i < 20; i++) {
      assert.ok(indices.has(i), `missing index ${i}`);
    }
  });

  it("preserves exact combination counts beyond 32-bit integer range", () => {
    const binom = buildBinomials(255, 5);
    assert.equal(binom[255][5], 8_637_487_551);

    const positions = [250, 251, 252, 253, 254];
    const encoded = combinadicEncode(positions, binom);
    assert.ok(encoded < binom[255][5]);
    assert.deepEqual(combinadicDecode(encoded, 5, 255, binom), positions);
  });
});

describe("buildGoalRegion", () => {
  it("returns all floor cells within maxDistance BFS hops", () => {
    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOOOO",
      "OR    O",
      "O  X  O",
      "O  S  O",
      "O     O",
      "OOOOOOO",
    ]));
    const goalCell = board.goalCellsByLabel.get("X")![0];
    const region = buildGoalRegion(board, [goalCell], 1);
    assert.ok(region.includes(goalCell));
    assert.ok(region.length >= 3);
    assert.ok(region.length <= 5);
  });

  it("caps region size via maxDistance", () => {
    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOOOOOOOO",
      "OR        O",
      "O    X    O",
      "O    S    O",
      "O         O",
      "O         O",
      "O         O",
      "OOOOOOOOOOO",
    ]));
    const goalCell = board.goalCellsByLabel.get("X")![0];
    const small = buildGoalRegion(board, [goalCell], 2);
    const large = buildGoalRegion(board, [goalCell], 8);
    assert.ok(small.length < large.length);
  });

  it("returns sorted cell indices", () => {
    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOOOO",
      "OR  X O",
      "O   S O",
      "OOOOOOO",
    ]));
    const goalCell = board.goalCellsByLabel.get("X")![0];
    const region = buildGoalRegion(board, [goalCell], 4);
    for (let i = 1; i < region.length; i++) {
      assert.ok(region[i] > region[i - 1]);
    }
  });
});

describe("buildPatternDatabase", () => {
  function largeCustomBoard(): ReturnType<typeof compileSearchBoard> {
    const rows: string[][] = Array.from({ length: 20 }, (_, row) =>
      Array.from({ length: 20 }, (_, column) =>
        row === 0 || row === 19 || column === 0 || column === 19 ? "O" : " "));
    rows[1][1] = "R";
    for (const [row, column] of [[11, 10], [15, 12], [1, 4], [3, 6], [15, 10]]) {
      rows[row][column] = "S";
    }
    for (const [row, column] of [[2, 2], [2, 17], [10, 2], [10, 17], [17, 17]]) {
      rows[row][column] = "X";
    }
    return compileSearchBoard(parsePuzzleRows(rows.map((row) => row.join(""))));
  }

  it("disables an oversized custom-board PDB instead of wrapping its size", async () => {
    const board = largeCustomBoard();
    const goalCells = [...(board.goalCellsByLabel.get("X") ?? [])];
    const regionCells = buildGoalRegion(board, goalCells, 8);
    const binom = buildBinomials(regionCells.length, goalCells.length);
    const exactTableSize = binom[regionCells.length][goalCells.length];

    assert.equal(regionCells.length, 255);
    assert.equal(exactTableSize, 8_637_487_551);
    assert.ok(exactTableSize > MAX_PDB_TABLE_ENTRIES);

    const config = { goalCells, labelIds: goalCells.map(() => "X"), regionCells };
    const syncPdb = buildPatternDatabase(board, config);
    const asyncPdb = await buildPatternDatabaseAsync(
      board,
      config,
      new AbortController().signal,
    );

    for (const pdb of [syncPdb, asyncPdb]) {
      assert.equal(pdb.tableSize, 0);
      assert.equal(pdb.estimatedRetainedBytes, 0);
      assert.equal(pdb.lookup(goalCells), UNSOLVED);
    }
  });

  it("returns 0 pushes at the goal for a 1-box PDB", () => {
    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOOOO",
      "OR    O",
      "O  X  O",
      "O  S  O",
      "O     O",
      "OOOOOOO",
    ]));
    const goalCell = board.goalCellsByLabel.get("X")![0];
    const regionCells = buildGoalRegion(board, [goalCell], 8);
    const pdb = buildPatternDatabase(board, {
      goalCells: [goalCell],
      labelIds: ["X"],
      regionCells,
    });
    assert.equal(pdb.k, 1);
    assert.equal(pdb.lookup([goalCell]), 0);
  });

  it("returns correct push distance one cell away from goal", () => {
    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOOOO",
      "OR    O",
      "O  X  O",
      "O  S  O",
      "O     O",
      "OOOOOOO",
    ]));
    const goalCell = board.goalCellsByLabel.get("X")![0];
    const regionCells = buildGoalRegion(board, [goalCell], 8);
    const pdb = buildPatternDatabase(board, {
      goalCells: [goalCell],
      labelIds: ["X"],
      regionCells,
    });
    const oneAbove = board.neighbors[goalCell][0];
    if (oneAbove >= 0) {
      const dist = pdb.lookup([oneAbove]);
      assert.equal(dist, 1, "one push away from goal should be 1");
    }
  });

  it("answers cells outside the region with the full-board push distance", () => {
    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOOOOOOOO",
      "OR        O",
      "O         O",
      "O    X    O",
      "O    S    O",
      "O         O",
      "O         O",
      "O         O",
      "OOOOOOOOOOO",
    ]));
    const goalCell = board.goalCellsByLabel.get("X")![0];
    const regionCells = buildGoalRegion(board, [goalCell], 2);
    const pdb = buildPatternDatabase(board, {
      goalCells: [goalCell],
      labelIds: ["X"],
      regionCells,
    });
    const pushDistances = board.reversePushDistancesByGoal.get(goalCell)!;
    let reachableOutside = 0;
    for (let cell = 0; cell < board.cellCount; cell++) {
      if (regionCells.includes(cell)) continue;
      if (pushDistances[cell] >= 0) reachableOutside++;
      assert.equal(pdb.lookup([cell]), pushDistances[cell] < 0 ? UNSOLVED : pushDistances[cell]);
    }
    assert.ok(reachableOutside > 0);
    // A corner box can never reach the goal; (2, 2) takes 5 pushes.
    assert.equal(pdb.lookup([board.cellAt(1, 1)]), UNSOLVED);
    assert.equal(pdb.lookup([board.cellAt(2, 2)]), 5);
    // Unreachable boxes are answered UNSOLVED before the region check.
    assert.equal(pdb.lookupStats.outsideRegionLookups, reachableOutside + 1);
  });

  it("builds a 2-box PDB with correct solved distance", () => {
    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOOOO",
      "OR XX O",
      "O  SS O",
      "O     O",
      "OOOOOOO",
    ]));
    const goalCells = [...(board.goalCellsByLabel.get("X") ?? [])];
    assert.equal(goalCells.length, 2);
    const regionCells = buildGoalRegion(board, goalCells, 8);
    const pdb = buildPatternDatabase(board, {
      goalCells,
      labelIds: ["X", "X"],
      regionCells,
    });
    assert.equal(pdb.k, 2);
    assert.equal(pdb.lookup(goalCells), 0);
  });

  it("2-box PDB returns positive distance for initial box positions", () => {
    const parsed = parsePuzzleRows([
      "OOOOOOOO",
      "OR     O",
      "O  XX  O",
      "O      O",
      "O  SS  O",
      "O      O",
      "OOOOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const goalCells = [...(board.goalCellsByLabel.get("X") ?? [])];
    assert.equal(goalCells.length, 2);
    const boxes = toDenseBoxes(board, parsed.initialBoxes);
    const boxCells = boxes.map((b) => b.cell);
    const regionCells = buildGoalRegion(board, goalCells, 8);
    const pdb = buildPatternDatabase(board, {
      goalCells,
      labelIds: ["X", "X"],
      regionCells,
    });
    const dist = pdb.lookup(boxCells);
    assert.ok(dist > 0, `expected positive distance, got ${dist}`);
    assert.ok(dist !== UNSOLVED, "should not be UNSOLVED within region");
  });

  it("handles k=0 gracefully", () => {
    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOO",
      "ORX O",
      "O  SO",
      "OOOOO",
    ]));
    const pdb = buildPatternDatabase(board, {
      goalCells: [],
      labelIds: [],
      regionCells: [],
    });
    assert.equal(pdb.k, 0);
    assert.equal(pdb.lookup([]), 0);
  });

  it("PDB values are admissible (never exceed exact push distance)", () => {
    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOOOO",
      "OR    O",
      "O  X  O",
      "O  S  O",
      "O     O",
      "OOOOOOO",
    ]));
    const goalCell = board.goalCellsByLabel.get("X")![0];
    const regionCells = buildGoalRegion(board, goalCell !== undefined ? [goalCell] : [], 8);
    const pdb = buildPatternDatabase(board, {
      goalCells: [goalCell],
      labelIds: ["X"],
      regionCells,
    });
    for (const cell of regionCells) {
      const pdbDist = pdb.lookup([cell]);
      if (pdbDist === UNSOLVED) continue;
      const reversePush = board.reversePushDistancesByGoal.get(goalCell)?.[cell] ?? -1;
      if (reversePush >= 0) {
        assert.ok(
          pdbDist <= reversePush,
          `PDB(${cell})=${pdbDist} > reversePush=${reversePush}`,
        );
      }
    }
  });
});

// A box on the bottom row leaves it only through the gaps at columns 1-2 and
// 12-13. The east route from (5, 10) to the goal at (1, 6) takes 12 pushes but
// passes cells outside the radius-8 goal region, so the table's in-region
// route through the west gap takes 16.
const EXIT_ROUTE_ROWS = [
  "OOOOOOOOOOOOOOO",
  "O     S       O",
  "O             O",
  "O             O",
  "O             O",
  "O        RX   O",
  "O  OOOOOOOOO  O",
  "OOOOOOOOOOOOOOO",
];

describe("pattern database exit bound", () => {
  type Board = ReturnType<typeof compileSearchBoard>;

  function exitRouteBoard(): Board {
    const board = compileSearchBoard(parsePuzzleRows(EXIT_ROUTE_ROWS));
    assert.equal(board.cellCount, 69);
    return board;
  }

  function singleGoalPdb(board: Board) {
    const goalCells = [board.cellAt(1, 6)];
    const regionCells = buildGoalRegion(board, goalCells, 8);
    const config = { goalCells, labelIds: ["X"], regionCells };
    return { goalCells, regionCells, config, pdb: buildPatternDatabase(board, config) };
  }

  function forEachCombination(n: number, k: number, visit: (cells: readonly number[]) => void): void {
    const cells: number[] = [];
    const extend = (start: number): void => {
      if (cells.length === k) {
        visit(cells);
        return;
      }
      for (let cell = start; cell <= n - (k - cells.length); cell++) {
        cells.push(cell);
        extend(cell + 1);
        cells.pop();
      }
    };
    extend(0);
  }

  function describeCells(board: Board, cells: readonly number[]): string {
    return cells.map((cell) => `(${board.positions[cell].row},${board.positions[cell].column})`).join(" ");
  }

  it("gives every single box its full-board push distance", async () => {
    const board = exitRouteBoard();
    const { goalCells, regionCells, config, pdb } = singleGoalPdb(board);
    assert.ok(regionCells.length < board.cellCount);
    const asyncPdb = await buildPatternDatabaseAsync(board, config, new AbortController().signal);
    const pushDistances = board.reversePushDistancesByGoal.get(goalCells[0])!;
    for (const database of [pdb, asyncPdb]) {
      for (let cell = 0; cell < board.cellCount; cell++) {
        assert.equal(
          database.lookup([cell]),
          pushDistances[cell] < 0 ? UNSOLVED : pushDistances[cell],
          describeCells(board, [cell]),
        );
      }
      assert.ok(database.lookupStats.exitCapTrims > 0);
    }
  });

  it("trims the in-region table value to the exit bound", () => {
    const board = exitRouteBoard();
    const { regionCells, pdb } = singleGoalPdb(board);
    const east = board.cellAt(5, 10);
    assert.ok(regionCells.includes(east));
    assert.equal(pdb.lookup([east]), 12);
    // The trim recovers the table's west-gap value, 16.
    assert.deepEqual(pdb.lookupStats, {
      lookups: 1, exitCapTrims: 1, exitCapTrimTotal: 4, outsideRegionLookups: 0,
    });
    assert.equal(pdb.lookup([board.cellAt(5, 9)]), 13);
    assert.equal(pdb.lookupStats.exitCapTrimTotal, 4 + 2);
  });

  for (const goalPositions of [[[1, 6], [1, 7]], [[1, 6], [1, 7], [2, 6]]]) {
    it(`never exceeds the full-board table with ${goalPositions.length} boxes`, () => {
      const board = exitRouteBoard();
      const goalCells = goalPositions.map(([row, column]) => board.cellAt(row, column));
      const labelIds = goalCells.map(() => "X");
      const regionCells = buildGoalRegion(board, goalCells, 8);
      assert.ok(regionCells.length < board.cellCount);
      const capped = buildPatternDatabase(board, { goalCells, labelIds, regionCells });
      const exact = buildPatternDatabase(board, {
        goalCells, labelIds, regionCells: Array.from({ length: board.cellCount }, (_, cell) => cell),
      });
      let subsets = 0;
      let tableOverestimates = 0;
      forEachCombination(board.cellCount, goalCells.length, (cells) => {
        subsets++;
        const bound = exact.lookup(cells);
        if (bound === UNSOLVED) return;
        const trimmedBefore = capped.lookupStats.exitCapTrimTotal;
        const value = capped.lookup(cells);
        assert.ok(value <= bound, `${describeCells(board, cells)}: ${value} > ${bound}`);
        // The untrimmed table value is what the lookup returned before the fix.
        if (value + capped.lookupStats.exitCapTrimTotal - trimmedBefore > bound) tableOverestimates++;
      });
      assert.equal(subsets, buildBinomials(board.cellCount, goalCells.length)[board.cellCount][goalCells.length]);
      assert.ok(tableOverestimates > 0);
      assert.ok(capped.lookupStats.outsideRegionLookups > 0);
    });
  }

  it("keeps a subset minimum sound when the cheaper box is outside the region", () => {
    const board = exitRouteBoard();
    const { goalCells, regionCells, pdb } = singleGoalPdb(board);
    const evaluator = new PdbHeuristicEvaluator([{ goalCells, labels: ["X"], regionCells }], [pdb]);
    const inside = board.cellAt(5, 10);
    const outside = board.cellAt(4, 12);
    assert.ok(regionCells.includes(inside));
    assert.ok(!regionCells.includes(outside));
    // Either box may take the goal: (4, 12) needs 9 pushes and (5, 10) 12.
    // Skipping the outside subset used to leave the minimum at the table's 16.
    assert.equal(evaluator.evaluate([
      { id: "X:0", label: "X", cell: inside },
      { id: "X:1", label: "X", cell: outside },
    ]), 9);
    assert.deepEqual(evaluator.lookupStats, {
      lookups: 2, exitCapTrims: 1, exitCapTrimTotal: 4, outsideRegionLookups: 1,
    });
  });

  for (const [name, run] of [["A*", runExactMoveAStar], ["IDA*", runIdaStarSearch]] as const) {
    it(`${name} reports exit-bound trims and proves the 20-move optimum`, async () => {
      const board = parsePuzzleRows(EXIT_ROUTE_ROWS);
      const request: SolverRequest = {
        board,
        snapshot: {
          puzzleId: "pdb-exit-route", robot: board.initialRobot, boxes: board.initialBoxes,
          moves: 0, pushes: 0, solved: false,
        },
        objective: { kind: "moves" },
      };
      const result = await run(request, {
        signal: new AbortController().signal, now: () => performance.now(), reportProgress() {},
      });
      assert.equal(result.status, "solved");
      if (result.status !== "solved") return;
      assert.equal(result.solution.moves, 20);
      assert.equal(result.solution.optimality, "proven");
      const counters = result.metrics.counters!;
      assert.ok(counters.pdbLookups > 0);
      assert.ok(counters.pdbExitCapTrims > 0);
    });
  }
});
