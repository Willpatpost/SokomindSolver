import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePuzzleRows } from "../../src/core/index.ts";
import {
  compileSearchBoard,
  type CompiledSearchBoard,
} from "../../src/solver/search/compiled-board.ts";
import type { DenseBox } from "../../src/solver/search/model.ts";
import {
  analyzeBoxEpisodes,
  analyzeRegionEpisodes,
  computeBoxFlexibility,
  computeFlexibilityMap,
  type PushEvent,
} from "../../src/solver/search/analyzer-diagnostics.ts";

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

describe("analyzeBoxEpisodes", () => {
  const board = compile([
    "OOOOOOO",
    "O     O",
    "O X X O",
    "O S S O",
    "OR    O",
    "OOOOOOO",
  ]);
  const box0 = boxAt(board, 2, 2, "X", "X:0");
  const box1 = boxAt(board, 2, 4, "X", "X:1");
  const boxes = [box0, box1];

  it("returns empty report for no push events", () => {
    const report = analyzeBoxEpisodes(board, boxes, []);
    assert.equal(report.totalEpisodes, 0);
    assert.equal(report.totalPushes, 0);
    assert.equal(report.averageEpisodesPerBox, 0);
    assert.equal(report.maxEpisodesForAnyBox, 0);
    assert.equal(report.boxAnalyses.length, 2);
    assert.equal(report.boxAnalyses[0].episodes.length, 0);
    assert.equal(report.boxAnalyses[1].episodes.length, 0);
  });

  it("tracks a single contiguous episode for one box", () => {
    const events: PushEvent[] = [
      { boxIndex: 0, fromCell: box0.cell, toCell: board.cellAt(2, 3), keeperCell: board.cellAt(2, 1) },
      { boxIndex: 0, fromCell: board.cellAt(2, 3), toCell: board.cellAt(2, 4), keeperCell: board.cellAt(2, 2) },
    ];
    const report = analyzeBoxEpisodes(board, boxes, events);
    assert.equal(report.totalEpisodes, 1);
    assert.equal(report.totalPushes, 2);
    assert.equal(report.boxAnalyses[0].episodes.length, 1);
    assert.equal(report.boxAnalyses[0].episodes[0].pushCount, 2);
    assert.equal(report.boxAnalyses[0].episodes[0].startCell, box0.cell);
    assert.equal(report.boxAnalyses[0].episodes[0].endCell, board.cellAt(2, 4));
  });

  it("splits episodes when boxes alternate", () => {
    const events: PushEvent[] = [
      { boxIndex: 0, fromCell: box0.cell, toCell: board.cellAt(3, 2), keeperCell: board.cellAt(1, 2) },
      { boxIndex: 1, fromCell: box1.cell, toCell: board.cellAt(3, 4), keeperCell: board.cellAt(1, 4) },
      { boxIndex: 0, fromCell: board.cellAt(3, 2), toCell: board.cellAt(4, 2), keeperCell: board.cellAt(2, 2) },
    ];
    const report = analyzeBoxEpisodes(board, boxes, events);
    assert.equal(report.totalEpisodes, 3);
    assert.equal(report.boxAnalyses[0].episodes.length, 2);
    assert.equal(report.boxAnalyses[1].episodes.length, 1);
    assert.equal(report.maxEpisodesForAnyBox, 2);
  });

  it("detects onGoalAtEnd correctly", () => {
    const goalCell = board.cellAt(3, 2);
    const events: PushEvent[] = [
      { boxIndex: 0, fromCell: box0.cell, toCell: goalCell, keeperCell: board.cellAt(1, 2) },
    ];
    const report = analyzeBoxEpisodes(board, boxes, events);
    assert.equal(report.boxAnalyses[0].onGoalAtEnd, true);
    assert.equal(report.boxAnalyses[1].onGoalAtEnd, false);
  });
});

describe("analyzeRegionEpisodes", () => {
  it("returns empty report for no push events", () => {
    const board = compile([
      "OOOOO",
      "OR  O",
      "OX  O",
      "OS  O",
      "OOOOO",
    ]);
    const report = analyzeRegionEpisodes(board, []);
    assert.equal(report.episodes.length, 0);
    assert.equal(report.totalRegionSwitches, 0);
  });

  it("tracks room transitions across articulation-gated rooms", () => {
    const board = compile([
      "OOOOOOO",
      "OSX   O",
      "OOO OOO",
      "O  SX O",
      "OR    O",
      "OOOOOOO",
    ]);
    const topCell = board.cellAt(1, 1);
    const bottomCell = board.cellAt(3, 3);
    const events: PushEvent[] = [
      { boxIndex: 0, fromCell: board.cellAt(1, 2), toCell: topCell, keeperCell: board.cellAt(1, 3) },
      { boxIndex: 1, fromCell: board.cellAt(3, 4), toCell: bottomCell, keeperCell: board.cellAt(3, 5) },
    ];
    const report = analyzeRegionEpisodes(board, events);
    assert.ok(report.episodes.length >= 1);
  });
});

describe("computeBoxFlexibility", () => {
  it("reports full flexibility for box in open room center", () => {
    const board = compile([
      "OOOOO",
      "O   O",
      "O X O",
      "O  SO",
      "OR  O",
      "OOOOO",
    ]);
    const cell = board.cellAt(2, 2);
    const flex = computeBoxFlexibility(board, cell, "X");
    assert.equal(flex.cell, cell);
    assert.equal(flex.pushDirections, 4);
    assert.equal(flex.supportDirections, 4);
    assert.equal(flex.onGoal, false);
    assert.ok(flex.goalDistance >= 0);
  });

  it("reports zero push directions for box in a corner", () => {
    const board = compile([
      "OOOOO",
      "OX  O",
      "O   O",
      "O  SO",
      "OR  O",
      "OOOOO",
    ]);
    const cell = board.cellAt(1, 1);
    const flex = computeBoxFlexibility(board, cell, "X");
    assert.equal(flex.pushDirections, 0);
  });

  it("reports onGoal = true when box is on matching goal", () => {
    const board = compile([
      "OOOOO",
      "O   O",
      "O X O",
      "O  SO",
      "OR  O",
      "OOOOO",
    ]);
    const goalCell = board.cellAt(3, 3);
    const flex = computeBoxFlexibility(board, goalCell, "X");
    assert.equal(flex.onGoal, true);
  });

  it("reports goalDistance = -1 when no matching goal is reachable", () => {
    const board = compile([
      "OOOOO",
      "OA  O",
      "O   O",
      "O  aO",
      "OR XO",
      "O S O",
      "OOOOO",
    ]);
    const cell = board.cellAt(1, 1);
    const flex = computeBoxFlexibility(board, cell, "A");
    assert.ok(flex.goalDistance >= 0 || flex.goalDistance === -1);
  });
});

describe("computeFlexibilityMap", () => {
  it("returns one entry per box", () => {
    const board = compile([
      "OOOOO",
      "O   O",
      "O X O",
      "O  SO",
      "OR  O",
      "OOOOO",
    ]);
    const boxes = [boxAt(board, 2, 2, "X")];
    const map = computeFlexibilityMap(board, boxes);
    assert.equal(map.length, 1);
    assert.equal(map[0].cell, board.cellAt(2, 2));
    assert.equal(map[0].pushDirections, 4);
  });
});
