import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parsePuzzleRows } from "../../src/core/index.ts";
import { compileSearchBoard } from "../../src/solver/search/compiled-board.ts";
import { toDenseBoxes } from "../../src/solver/search/model.ts";
import {
  buildPatternDatabase,
  buildGoalRegion,
  buildBinomials,
  combinadicEncode,
  combinadicDecode,
  UNSOLVED,
} from "../../src/solver/search/pattern-database.ts";

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

  it("returns UNSOLVED for cells outside the region", () => {
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
    const farCell = board.cellAt(1, 1);
    if (farCell >= 0 && !regionCells.includes(farCell)) {
      assert.equal(pdb.lookup([farCell]), UNSOLVED);
    }
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
