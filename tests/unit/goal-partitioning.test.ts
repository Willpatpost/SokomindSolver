import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parsePuzzleRows } from "../../src/core/index.ts";
import { compileSearchBoard } from "../../src/solver/search/compiled-board.ts";
import { partitionGoals } from "../../src/solver/search/goal-partitioning.ts";

describe("partitionGoals", () => {
  it("returns one partition per label for small goal counts", () => {
    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOOOO",
      "OR XX O",
      "O  SS O",
      "OOOOOOO",
    ]));
    const partitions = partitionGoals(board);
    assert.ok(partitions.length >= 1);
    const totalGoals = partitions.reduce((sum, p) => sum + p.goalCells.length, 0);
    const expectedGoals = [...board.goalCellsByLabel.values()]
      .reduce((sum, cells) => sum + cells.length, 0);
    assert.equal(totalGoals, expectedGoals);
  });

  it("returns empty array for board with no goals", () => {
    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOO",
      "OR  O",
      "O   O",
      "OOOOO",
    ]));
    const partitions = partitionGoals(board);
    assert.equal(partitions.length, 0);
  });

  it("returns single partition for one goal", () => {
    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOO",
      "ORX O",
      "O  SO",
      "OOOOO",
    ]));
    const partitions = partitionGoals(board);
    assert.equal(partitions.length, 1);
    assert.equal(partitions[0].goalCells.length, 1);
  });

  it("produces disjoint goal partitions", () => {
    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOOOOOO",
      "OR A a  O",
      "O  B b  O",
      "OOOOOOOOO",
    ]));
    const partitions = partitionGoals(board);
    const allGoals = new Set<number>();
    for (const partition of partitions) {
      for (const cell of partition.goalCells) {
        assert.ok(!allGoals.has(cell), `goal cell ${cell} appears in multiple partitions`);
        allGoals.add(cell);
      }
    }
  });

  it("separates labels into different partitions", () => {
    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOOOOOO",
      "OR A a  O",
      "O  B b  O",
      "OOOOOOOOO",
    ]));
    const partitions = partitionGoals(board);
    assert.equal(partitions.length, 2);
    for (const partition of partitions) {
      const uniqueLabels = new Set(partition.labels);
      assert.equal(uniqueLabels.size, 1, "each partition should have one label");
    }
  });

  it("each partition includes region cells", () => {
    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOOOO",
      "OR XX O",
      "O  SS O",
      "O     O",
      "OOOOOOO",
    ]));
    const partitions = partitionGoals(board);
    for (const partition of partitions) {
      assert.ok(partition.regionCells.length > 0);
      for (const goalCell of partition.goalCells) {
        assert.ok(
          partition.regionCells.includes(goalCell),
          `goal cell ${goalCell} should be in its own region`,
        );
      }
    }
  });

  it("splits large same-label groups when > 5 goals", () => {
    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOOOOOOOOOOOO",
      "OR XXXXXX     O",
      "O  SSSSSS     O",
      "O             O",
      "OOOOOOOOOOOOOOO",
    ]));
    const partitions = partitionGoals(board);
    assert.ok(partitions.length >= 2, `expected split into >= 2 partitions, got ${partitions.length}`);
    for (const partition of partitions) {
      assert.ok(partition.goalCells.length <= 5,
        `partition should have <= 5 goals, got ${partition.goalCells.length}`);
    }
    const totalGoals = partitions.reduce((sum, p) => sum + p.goalCells.length, 0);
    assert.equal(totalGoals, 6);
  });
});
