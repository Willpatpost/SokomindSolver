import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parsePuzzleRows } from "../../src/core/index.ts";
import { compileSearchBoard } from "../../src/solver/search/compiled-board.ts";
import {
  buildPatternDatabase,
  buildPatternDatabaseAsync,
  buildGoalRegion,
} from "../../src/solver/search/pattern-database.ts";
import {
  buildDeadlockTables,
  buildDeadlockTablesAsync,
} from "../../src/solver/search/deadlock-tables.ts";
import { toDenseBoxes } from "../../src/solver/search/model.ts";
import { SolverCancelledError } from "../../src/solver/cancellation.ts";

function neverAbortedSignal(): AbortSignal {
  return new AbortController().signal;
}

function preAbortedSignal(): AbortSignal {
  const ctrl = new AbortController();
  ctrl.abort("test cancellation");
  return ctrl.signal;
}

const SMALL_BOARD_ROWS = [
  "OOOOOOO",
  "OR    O",
  "O  X  O",
  "O  S  O",
  "O     O",
  "OOOOOOO",
];

const TWO_BOX_BOARD_ROWS = [
  "OOOOOOO",
  "OR XX O",
  "O  SS O",
  "O     O",
  "OOOOOOO",
];

const MEDIUM_BOARD_ROWS = [
  "OOOOOOOOOOOOO",
  "OR          O",
  "O           O",
  "O   XXXX    O",
  "O   SSSS    O",
  "O           O",
  "O           O",
  "OOOOOOOOOOOOO",
];

describe("buildPatternDatabaseAsync", () => {
  it("produces identical results to sync version (1-box)", async () => {
    const board = compileSearchBoard(parsePuzzleRows(SMALL_BOARD_ROWS));
    const goalCell = board.goalCellsByLabel.get("X")![0];
    const regionCells = buildGoalRegion(board, [goalCell], 8);
    const config = { goalCells: [goalCell], labelIds: ["X"], regionCells };

    const syncPdb = buildPatternDatabase(board, config);
    const asyncPdb = await buildPatternDatabaseAsync(board, config, neverAbortedSignal());

    assert.equal(asyncPdb.k, syncPdb.k);
    assert.equal(asyncPdb.tableSize, syncPdb.tableSize);

    for (const cell of regionCells) {
      assert.equal(
        asyncPdb.lookup([cell]),
        syncPdb.lookup([cell]),
        `mismatch at region cell ${cell}`,
      );
    }
  });

  it("produces identical results to sync version (2-box)", async () => {
    const board = compileSearchBoard(parsePuzzleRows(TWO_BOX_BOARD_ROWS));
    const goalCells = [...(board.goalCellsByLabel.get("X") ?? [])];
    const regionCells = buildGoalRegion(board, goalCells, 8);
    const config = { goalCells, labelIds: ["X", "X"], regionCells };

    const syncPdb = buildPatternDatabase(board, config);
    const asyncPdb = await buildPatternDatabaseAsync(board, config, neverAbortedSignal());

    assert.equal(asyncPdb.k, syncPdb.k);
    assert.equal(asyncPdb.tableSize, syncPdb.tableSize);
    assert.equal(asyncPdb.lookup(goalCells), syncPdb.lookup(goalCells));
  });

  it("throws immediately on pre-aborted signal", async () => {
    const board = compileSearchBoard(parsePuzzleRows(SMALL_BOARD_ROWS));
    const goalCell = board.goalCellsByLabel.get("X")![0];
    const regionCells = buildGoalRegion(board, [goalCell], 8);
    const config = { goalCells: [goalCell], labelIds: ["X"], regionCells };

    await assert.rejects(
      () => buildPatternDatabaseAsync(board, config, preAbortedSignal()),
      (error: unknown) => error instanceof SolverCancelledError,
    );
  });

  it("throws on mid-build cancellation", async () => {
    const board = compileSearchBoard(parsePuzzleRows(MEDIUM_BOARD_ROWS));
    const goalCells = [...(board.goalCellsByLabel.get("X") ?? [])];
    const regionCells = buildGoalRegion(board, goalCells, 8);
    const config = { goalCells, labelIds: goalCells.map(() => "X"), regionCells };

    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort("mid-build cancel"), 5);

    await assert.rejects(
      () => buildPatternDatabaseAsync(board, config, ctrl.signal),
      (error: unknown) => error instanceof SolverCancelledError,
    );
  });
});

describe("buildDeadlockTablesAsync", () => {
  it("produces identical results to sync version", async () => {
    const board = compileSearchBoard(parsePuzzleRows(TWO_BOX_BOARD_ROWS));
    const syncLookup = buildDeadlockTables(board);
    const asyncLookup = await buildDeadlockTablesAsync(board, neverAbortedSignal());

    assert.equal(asyncLookup.stats.regionCount, syncLookup.stats.regionCount);
    assert.equal(asyncLookup.stats.patternCount, syncLookup.stats.patternCount);

    const boxes = toDenseBoxes(
      board,
      parsePuzzleRows(TWO_BOX_BOARD_ROWS).initialBoxes,
    );
    for (let cell = 0; cell < board.cellCount; cell++) {
      assert.equal(
        asyncLookup.check(boxes, cell),
        syncLookup.check(boxes, cell),
        `mismatch at cell ${cell}`,
      );
    }
  });

  it("completes on a larger board with matching region count", async () => {
    const board = compileSearchBoard(parsePuzzleRows(MEDIUM_BOARD_ROWS));
    const syncLookup = buildDeadlockTables(board);
    const asyncLookup = await buildDeadlockTablesAsync(board, neverAbortedSignal());

    assert.equal(asyncLookup.stats.regionCount, syncLookup.stats.regionCount);
    assert.ok(asyncLookup.stats.patternCount >= 0);
  });

  it("throws immediately on pre-aborted signal", async () => {
    const board = compileSearchBoard(parsePuzzleRows(TWO_BOX_BOARD_ROWS));

    await assert.rejects(
      () => buildDeadlockTablesAsync(board, preAbortedSignal()),
      (error: unknown) => error instanceof SolverCancelledError,
    );
  });

  it("throws on mid-build cancellation", async () => {
    const board = compileSearchBoard(parsePuzzleRows(MEDIUM_BOARD_ROWS));

    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort("mid-build cancel"), 5);

    await assert.rejects(
      () => buildDeadlockTablesAsync(board, ctrl.signal),
      (error: unknown) => error instanceof SolverCancelledError,
    );
  });
});
