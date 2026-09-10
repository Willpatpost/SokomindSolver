import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parsePuzzleRows } from "../../src/core/index.ts";
import {
  compileSearchBoard,
  SEARCH_DIRECTIONS,
} from "../../src/solver/search/compiled-board.ts";
import {
  buildCorralChildOrder,
  CorralOrderingAnalyzer,
} from "../../src/solver/search/corral-ordering.ts";
import { toDenseBoxes } from "../../src/solver/search/model.ts";
import { KeeperReachability } from "../../src/solver/search/reachability.ts";

function analyzeCorral(rows: readonly string[], robotRow: number, robotCol: number) {
  const parsed = parsePuzzleRows(rows);
  const board = compileSearchBoard(parsed);
  const boxes = toDenseBoxes(board, parsed.initialBoxes);
  const robotCell = board.cellAt(robotRow, robotCol);
  const occupancy = new Uint8Array(board.cellCount);
  for (const box of boxes) occupancy[box.cell] = 1;
  const reachability = new KeeperReachability(board);
  const reachable = reachability.flood(robotCell, occupancy);
  const analyzer = new CorralOrderingAnalyzer(board.cellCount);
  const result = analyzer.analyze(board, boxes, occupancy, reachable);
  return { board, boxes, result, analyzer };
}

describe("corral ordering analyzer", () => {
  it("reports boundary pushes for off-goal boxes", () => {
    const { result, boxes, analyzer } = analyzeCorral([
      "OOOOOO",
      "OR   O",
      "O X SO",
      "OOOOOO",
    ], 1, 1);

    assert.equal(result.hasCorral, true);
    assert.equal(analyzer.stats.checks, 1);
    assert.equal(analyzer.stats.reorders, 1);

    let hasBoundaryPush = false;
    for (let bi = 0; bi < boxes.length; bi++) {
      for (let d = 0; d < 4; d++) {
        if (result.isCorralBoundaryPush(bi, d)) {
          hasBoundaryPush = true;
        }
      }
    }
    assert.ok(hasBoundaryPush, "should identify at least one boundary push");
  });

  it("returns no corral for sealed-off boxes with no boundary pushes", () => {
    const { result, analyzer } = analyzeCorral([
      "OOOOOOOO",
      "OR     O",
      "O  OOO O",
      "O  OX  O",
      "O  OOS O",
      "O      O",
      "OOOOOOOO",
    ], 1, 1);

    assert.equal(result.hasCorral, false);
    assert.equal(analyzer.stats.reorders, 0);
  });

  it("ignores corral where all boxes are on matching goals", () => {
    const parsed = parsePuzzleRows([
      "OOOOOOOO",
      "OR     O",
      "O  OOO O",
      "O  O   O",
      "O  OOXSO",
      "O      O",
      "OOOOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const goalCells = board.goalCellsByLabel.get("X") ?? [];
    assert.ok(goalCells.length > 0);
    const boxes = goalCells.map((cell, i) => ({
      id: `X:${i}`, label: "X", cell,
    }));
    const robotCell = board.cellAt(1, 1);
    const occupancy = new Uint8Array(board.cellCount);
    for (const box of boxes) occupancy[box.cell] = 1;
    const reachability = new KeeperReachability(board);
    const reachable = reachability.flood(robotCell, occupancy);
    const analyzer = new CorralOrderingAnalyzer(board.cellCount);
    const result = analyzer.analyze(board, boxes, occupancy, reachable);

    assert.equal(result.hasCorral, false);
  });

  it("returns false for a solved state", () => {
    const parsed = parsePuzzleRows([
      "OOOOOO",
      "OR   O",
      "O  XSO",
      "OOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const goalCells = board.goalCellsByLabel.get("X") ?? [];
    assert.ok(goalCells.length > 0);
    const boxes = goalCells.map((cell, i) => ({
      id: `X:${i}`, label: "X", cell,
    }));
    const robotCell = board.cellAt(1, 1);
    const occupancy = new Uint8Array(board.cellCount);
    for (const box of boxes) occupancy[box.cell] = 1;
    const reachability = new KeeperReachability(board);
    const reachable = reachability.flood(robotCell, occupancy);
    const analyzer = new CorralOrderingAnalyzer(board.cellCount);
    const result = analyzer.analyze(board, boxes, occupancy, reachable);

    assert.equal(result.hasCorral, false);
  });

  it("tracks stats correctly across multiple calls", () => {
    const parsed = parsePuzzleRows([
      "OOOOOO",
      "OR   O",
      "O X SO",
      "OOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const boxes = toDenseBoxes(board, parsed.initialBoxes);
    const robotCell = board.cellAt(1, 1);
    const occupancy = new Uint8Array(board.cellCount);
    for (const box of boxes) occupancy[box.cell] = 1;
    const reachability = new KeeperReachability(board);
    const reachable = reachability.flood(robotCell, occupancy);
    const analyzer = new CorralOrderingAnalyzer(board.cellCount);

    analyzer.analyze(board, boxes, occupancy, reachable);
    analyzer.analyze(board, boxes, occupancy, reachable);

    assert.equal(analyzer.stats.checks, 2);
    assert.equal(analyzer.stats.reorders, 2);
  });
});

describe("buildCorralChildOrder", () => {
  it("puts boundary pushes first and non-boundary second", () => {
    const { result, boxes } = analyzeCorral([
      "OOOOOO",
      "OR   O",
      "O X SO",
      "OOOOOO",
    ], 1, 1);

    assert.ok(result.hasCorral);
    const order = buildCorralChildOrder(
      boxes.length, SEARCH_DIRECTIONS.length, result,
    );
    const totalChildren = boxes.length * SEARCH_DIRECTIONS.length;
    assert.equal(order.length, totalChildren);

    const seen = new Set<number>();
    for (let i = 0; i < order.length; i++) {
      assert.ok(!seen.has(order[i]), `duplicate cursor ${order[i]}`);
      seen.add(order[i]);
    }
    assert.equal(seen.size, totalChildren, "must be a permutation");

    let seenNonBoundary = false;
    for (let i = 0; i < order.length; i++) {
      const cursor = order[i];
      const bi = Math.floor(cursor / SEARCH_DIRECTIONS.length);
      const di = cursor % SEARCH_DIRECTIONS.length;
      const isBoundary = result.isCorralBoundaryPush(bi, di);
      if (!isBoundary) seenNonBoundary = true;
      if (isBoundary && seenNonBoundary) {
        assert.fail("boundary push appeared after non-boundary push");
      }
    }
  });

  it("returns identity order when no corrals exist", () => {
    const { result, boxes } = analyzeCorral([
      "OOOOOOOO",
      "OR     O",
      "O  OOO O",
      "O  OX  O",
      "O  OOS O",
      "O      O",
      "OOOOOOOO",
    ], 1, 1);

    assert.equal(result.hasCorral, false);
    const order = buildCorralChildOrder(
      boxes.length, SEARCH_DIRECTIONS.length, result,
    );

    for (let i = 0; i < order.length; i++) {
      assert.equal(order[i], i, "no-corral order should be natural");
    }
  });
});
