import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePuzzleRows } from "../../src/core/index.ts";
import {
  compileSearchBoard,
  type CompiledSearchBoard,
} from "../../src/solver/search/compiled-board.ts";
import type { DenseBox } from "../../src/solver/search/model.ts";
import {
  evaluateStagingQuality,
  computeStagingMap,
  findBestStagingCells,
  hasStagingInterference,
} from "../../src/solver/search/safe-staging.ts";

function compile(rows: readonly string[]): CompiledSearchBoard {
  return compileSearchBoard(parsePuzzleRows(rows));
}

function boxAt(
  board: CompiledSearchBoard,
  row: number,
  column: number,
  label: string,
  id?: string,
): DenseBox {
  const cell = board.cellAt(row, column);
  if (cell < 0) {
    throw new Error(`No floor cell at (${row}, ${column}).`);
  }
  return { id: id ?? `${label}:0`, label, cell };
}

describe("evaluateStagingQuality", () => {
  it("returns -Infinity score for a static dead cell", () => {
    const board = compile([
      "OOOOO",
      "OX  O",
      "O   O",
      "O  SO",
      "OR  O",
      "OOOOO",
    ]);
    const cornerCell = board.cellAt(1, 1);
    const quality = evaluateStagingQuality(board, cornerCell, "X");
    assert.equal(quality.isDeadCell, true);
    assert.equal(quality.score, -Infinity);
  });

  it("gives higher score to open cells than constrained ones", () => {
    const board = compile([
      "OOOOOOO",
      "O     O",
      "O X   O",
      "O     O",
      "O  S  O",
      "OR    O",
      "OOOOOOO",
    ]);
    const openCell = board.cellAt(3, 3);
    const wallAdjCell = board.cellAt(1, 1);
    const openQ = evaluateStagingQuality(board, openCell, "X");
    const wallQ = evaluateStagingQuality(board, wallAdjCell, "X");
    assert.ok(
      openQ.score > wallQ.score,
      `Open cell score (${openQ.score}) should exceed wall-adjacent score (${wallQ.score})`,
    );
  });

  it("flags articulation points correctly", () => {
    const board = compile([
      "OOOOOOO",
      "OSX   O",
      "OOO OOO",
      "O  SX O",
      "OR    O",
      "OOOOOOO",
    ]);
    const gatewayCell = board.cellAt(2, 3);
    const quality = evaluateStagingQuality(board, gatewayCell, "X");
    assert.equal(quality.isArticulation, true);
    assert.ok(quality.score < 0, "Articulation point should have negative staging score");
  });

  it("detects isOnGoal vs isOnOtherGoal", () => {
    const board = compile([
      "OOOOO",
      "O   O",
      "OA Ba",
      "O  bO",
      "OR  O",
      "OOOOO",
    ]);
    const goalACell = board.cellAt(2, 4);
    const qualityA = evaluateStagingQuality(board, goalACell, "A");
    const qualityB = evaluateStagingQuality(board, goalACell, "B");
    assert.equal(qualityA.isOnGoal, true);
    assert.equal(qualityA.isOnOtherGoal, false);
    assert.equal(qualityB.isOnGoal, false);
    assert.equal(qualityB.isOnOtherGoal, true);
  });

  it("reports push flexibility and support access", () => {
    const board = compile([
      "OOOOO",
      "O   O",
      "O X O",
      "O  SO",
      "OR  O",
      "OOOOO",
    ]);
    const centerCell = board.cellAt(2, 2);
    const quality = evaluateStagingQuality(board, centerCell, "X");
    assert.equal(quality.pushFlexibility, 4);
    assert.equal(quality.supportAccess, 4);
  });
});

describe("computeStagingMap", () => {
  it("returns one entry per floor cell", () => {
    const board = compile([
      "OOOOO",
      "O   O",
      "O X O",
      "O  SO",
      "OR  O",
      "OOOOO",
    ]);
    const map = computeStagingMap(board, "X");
    assert.equal(map.length, board.cellCount);
    for (const entry of map) {
      assert.equal(typeof entry.score, "number");
    }
  });
});

describe("findBestStagingCells", () => {
  it("excludes dead cells and current position", () => {
    const board = compile([
      "OOOOO",
      "O   O",
      "O X O",
      "O  SO",
      "OR  O",
      "OOOOO",
    ]);
    const boxCell = board.cellAt(2, 2);
    const candidates = findBestStagingCells(board, boxCell, "X");
    assert.ok(candidates.length > 0, "Should find at least one staging candidate");
    for (const c of candidates) {
      assert.notEqual(c.cell, boxCell, "Should not include current cell");
      assert.notEqual(c.quality.score, -Infinity, "Should not include dead cells");
    }
  });

  it("sorts by score descending then distance ascending", () => {
    const board = compile([
      "OOOOOOO",
      "O     O",
      "O X   O",
      "O     O",
      "O  S  O",
      "OR    O",
      "OOOOOOO",
    ]);
    const boxCell = board.cellAt(2, 2);
    const candidates = findBestStagingCells(board, boxCell, "X");
    for (let i = 1; i < candidates.length; i++) {
      const prev = candidates[i - 1];
      const curr = candidates[i];
      if (prev.quality.score === curr.quality.score) {
        assert.ok(
          prev.reversePushDistance <= curr.reversePushDistance,
          "Equal scores should be sorted by distance ascending",
        );
      } else {
        assert.ok(
          prev.quality.score > curr.quality.score,
          "Should be sorted by score descending",
        );
      }
    }
  });

  it("respects maxCandidates", () => {
    const board = compile([
      "OOOOOOO",
      "O     O",
      "O X   O",
      "O     O",
      "O  S  O",
      "OR    O",
      "OOOOOOO",
    ]);
    const boxCell = board.cellAt(2, 2);
    const candidates = findBestStagingCells(board, boxCell, "X", 3);
    assert.ok(candidates.length <= 3);
  });
});

describe("hasStagingInterference", () => {
  it("returns true for articulation points", () => {
    const board = compile([
      "OOOOOOO",
      "OSX   O",
      "OOO OOO",
      "O  SX O",
      "OR    O",
      "OOOOOOO",
    ]);
    const gatewayCell = board.cellAt(2, 3);
    const boxes = [boxAt(board, 3, 4, "X")];
    assert.equal(
      hasStagingInterference(board, gatewayCell, boxes),
      true,
      "Articulation point should cause interference",
    );
  });

  it("returns true when staging on another box's goal", () => {
    const board = compile([
      "OOOOO",
      "O   O",
      "OA Ba",
      "O  bO",
      "OR  O",
      "OOOOO",
    ]);
    const goalACell = board.cellAt(2, 4);
    const otherBoxes = [boxAt(board, 2, 1, "A", "A:0")];
    assert.equal(
      hasStagingInterference(board, goalACell, otherBoxes),
      true,
      "Staging on another box's goal should cause interference",
    );
  });

  it("returns false for open cells with no conflicts", () => {
    const board = compile([
      "OOOOOOO",
      "O     O",
      "O X   O",
      "O     O",
      "O  S  O",
      "OR    O",
      "OOOOOOO",
    ]);
    const openCell = board.cellAt(3, 3);
    const otherBoxes = [boxAt(board, 2, 2, "X")];
    const result = hasStagingInterference(board, openCell, otherBoxes);
    assert.equal(result, false, "Open non-goal cell should not cause interference");
  });
});
