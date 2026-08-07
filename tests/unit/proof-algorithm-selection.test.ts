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

  it("returns ida-star when box count exceeds threshold", () => {
    assert.equal(selectProofAlgorithm(mockBoard(50), 10), "ida-star");
  });
});
