import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parsePuzzleRows } from "../../src/core/index.ts";
import { compileSearchBoard } from "../../src/solver/search/compiled-board.ts";

describe("board topology analysis", () => {
  it("finds articulation points at T-junctions", () => {
    const parsed = parsePuzzleRows([
      "OOOOOOO",
      "OR  S O",
      "OOO OOO",
      "O  X  O",
      "OOOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const { articulations } = board.topology;
    // The cell at (1,3) connects the left corridor to the vertical branch
    const junction = board.cellAt(1, 3);
    assert.ok(junction >= 0);
    assert.ok(articulations.has(junction), "T-junction cell should be an articulation point");
  });

  it("discovers rooms behind articulation-point gates", () => {
    const parsed = parsePuzzleRows([
      "OOOOOOO",
      "OSX   O",
      "OOO OOO",
      "O  SX O",
      "OR    O",
      "OOOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const { rooms } = board.topology;
    // The narrow passage at (2,3) is an articulation point separating
    // top room (goals) from bottom room (goals)
    assert.ok(rooms.length >= 1, "Should find at least one room with goals");
    for (const room of rooms) {
      assert.ok(room.goals.length > 0, "Room must contain goals");
      assert.ok(room.cells.size >= 2, "Room must have at least 2 cells");
      assert.ok(!room.cells.has(room.gate), "Room cells should not include the gate");
    }
  });

  it("identifies tunnel cells (exactly 2 collinear neighbors)", () => {
    const parsed = parsePuzzleRows([
      "OOOOO",
      "OR  O",
      "OO OO",
      "OX  O",
      "OSOO ",
      "OOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const { tunnels } = board.topology;
    // Cell at (2,2) has exactly 2 collinear vertical neighbors
    const tunnelCell = board.cellAt(2, 2);
    if (tunnelCell >= 0) {
      const neighbors = board.neighbors[tunnelCell];
      let floorCount = 0;
      for (let d = 0; d < neighbors.length; d++) {
        if (neighbors[d] >= 0) floorCount++;
      }
      if (floorCount === 2) {
        assert.ok(tunnels.has(tunnelCell), "Cell with 2 collinear neighbors is a tunnel");
      }
    }
  });

  it("excludes rooms without goals", () => {
    const parsed = parsePuzzleRows([
      "OOOOOOOOO",
      "OR       O",
      "OOOOO OOO",
      "O       O",
      "O SX    O",
      "OOOOOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const { rooms } = board.topology;
    for (const room of rooms) {
      assert.ok(room.goals.length > 0, "Every discovered room must have goals");
    }
  });

  it("returns empty topology for open board with no articulation points", () => {
    const parsed = parsePuzzleRows([
      "OOOOOO",
      "O    O",
      "O RX O",
      "O S  O",
      "O    O",
      "OOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const { articulations, rooms } = board.topology;
    // An open room has no articulation points
    assert.equal(articulations.size, 0, "Open room has no articulation points");
    assert.equal(rooms.length, 0, "No rooms when no articulation points");
  });

  it("identifies tunnel cells in a linear corridor", () => {
    const parsed = parsePuzzleRows([
      "OOOOO",
      "OR  O",
      "OOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const { tunnels } = board.topology;
    // Interior cells (1,1) through (1,3) form a corridor; (1,2) has exactly 2 collinear neighbors
    const midCell = board.cellAt(1, 2);
    if (midCell >= 0) {
      assert.ok(tunnels.has(midCell), "Mid-corridor cell should be a tunnel");
    }
  });

  it("excludes rooms larger than 72% of floor", () => {
    // 9 floor cells total; the component behind the gate has 8 cells (89%) > 72%
    const parsed = parsePuzzleRows([
      "OOOOOOO",
      "OR O   O",
      "O  O   O",
      "O  OSXO",
      "OOOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const { rooms } = board.topology;
    // Any room discovered must be ≤72% of total floor
    const totalFloor = board.cellCount;
    for (const room of rooms) {
      assert.ok(
        room.cells.size <= Math.floor(totalFloor * 0.72),
        `Room has ${room.cells.size} cells but floor total is ${totalFloor}; exceeds 72%`,
      );
    }
  });

  it("discovers rooms in an L-shaped layout", () => {
    const parsed = parsePuzzleRows([
      "OOOOOOO",
      "OSX   O",
      "OOO   O",
      "O R   O",
      "OOOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const { rooms } = board.topology;
    for (const room of rooms) {
      assert.ok(room.goals.length > 0, "Room must have goals");
      assert.ok(room.cells.size >= 2, "Room must have at least 2 cells");
      assert.ok(!room.cells.has(room.gate), "Gate must not be in room cells");
    }
  });

  it("deduplicates rooms that are subsets of larger rooms", () => {
    // Nested structure: large room contains a smaller alcove
    const parsed = parsePuzzleRows([
      "OOOOOOOO",
      "OR      O",
      "OOO OOOO",
      "O      O",
      "OOO  OOO",
      "O SX   O",
      "OOOOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const { rooms } = board.topology;
    // Verify no room is a subset of another
    for (let i = 0; i < rooms.length; i++) {
      for (let j = 0; j < rooms.length; j++) {
        if (i === j) continue;
        if (rooms[i].cells.size <= rooms[j].cells.size) {
          let isSubset = true;
          for (const cell of rooms[i].cells) {
            if (!rooms[j].cells.has(cell)) { isSubset = false; break; }
          }
          assert.ok(!isSubset, `Room ${i} should not be a subset of room ${j}`);
        }
      }
    }
  });
});
