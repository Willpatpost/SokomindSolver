import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { selectProofAlgorithm } from "../../src/solver/search/proof-algorithm-selection.ts";
import type { CompiledSearchBoard } from "../../src/solver/search/compiled-board.ts";

function mockBoard(cellCount: number): CompiledSearchBoard {
  return { cellCount } as CompiledSearchBoard;
}

describe("selectProofAlgorithm", () => {
  it("returns ida-star when memory is below 768 MiB", () => {
    assert.equal(
      selectProofAlgorithm(mockBoard(50), 4, 512 * 1024 * 1024),
      "ida-star",
    );
  });

  it("returns astar for small boards with sufficient memory", () => {
    assert.equal(selectProofAlgorithm(mockBoard(50), 6), "astar");
  });

  it("returns ida-star for large boards", () => {
    assert.equal(selectProofAlgorithm(mockBoard(200), 12), "ida-star");
  });

  it("returns astar when box count within high threshold (undefined memory)", () => {
    assert.equal(selectProofAlgorithm(mockBoard(50), 10), "astar");
  });

  it("returns ida-star when box count exceeds high threshold", () => {
    assert.equal(selectProofAlgorithm(mockBoard(50), 13), "ida-star");
  });

  it("returns astar for higher box/cell counts with >= 2 GB memory", () => {
    const twoGB = 2 * 1024 * 1024 * 1024;
    assert.equal(
      selectProofAlgorithm(mockBoard(140), 11, twoGB),
      "astar",
    );
  });

  it("returns ida-star for same board at low memory", () => {
    const oneGB = 1024 * 1024 * 1024;
    assert.equal(
      selectProofAlgorithm(mockBoard(140), 11, oneGB),
      "ida-star",
    );
  });

  it("uses high thresholds with undefined memory (assumes high memory)", () => {
    // 9 boxes, 100 cells — within high threshold (12 boxes, 150 cells)
    assert.equal(selectProofAlgorithm(mockBoard(100), 9), "astar");
  });

  it("uses old thresholds with 1 GB explicit memory", () => {
    const oneGB = 1024 * 1024 * 1024;
    // 9 boxes, 100 cells — above old threshold (8 boxes, 96 cells)
    assert.equal(selectProofAlgorithm(mockBoard(100), 9, oneGB), "ida-star");
  });

  it("returns astar for default (undefined) memory within old thresholds", () => {
    assert.equal(selectProofAlgorithm(mockBoard(80), 7), "astar");
  });

  it("returns ida-star for 13 boxes even with high memory", () => {
    const fourGB = 4 * 1024 * 1024 * 1024;
    assert.equal(
      selectProofAlgorithm(mockBoard(140), 13, fourGB),
      "ida-star",
    );
  });
});
