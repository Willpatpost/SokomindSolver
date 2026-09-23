import assert from "node:assert/strict";
import test from "node:test";

import {
  createSession,
  move,
  type PuzzleDefinition,
} from "../../src/core/index.ts";
import {
  cellFromLocalPoint,
  findWalkPath,
  type BoardGrid,
} from "../../src/features/game/tap-pathfinding.ts";

function session(rows: readonly string[], boxes: number) {
  const def: PuzzleDefinition = {
    id: "tap-test",
    title: "Tap Test",
    difficulty: "tutorial",
    boxes,
    rows,
  };
  return createSession(def);
}

test("findWalkPath", async (t) => {
  await t.test("returns empty array when target is keeper position", () => {
    const s = session([
      "OOOOO",
      "OR XO",
      "O  SO",
      "OOOOO",
    ], 1);
    const path = findWalkPath(s, { row: 1, column: 1 });
    assert.deepEqual(path, []);
  });

  await t.test("finds direct horizontal path", () => {
    const s = session([
      "OOOOO",
      "OR XO",
      "O  SO",
      "OOOOO",
    ], 1);
    const path = findWalkPath(s, { row: 2, column: 1 });
    assert.ok(path);
    assert.deepEqual(path, ["down"]);
  });

  await t.test("finds multi-step path", () => {
    const s = session([
      "OOOOOOO",
      "OR   XO",
      "O    SO",
      "OOOOOOO",
    ], 1);
    const path = findWalkPath(s, { row: 2, column: 4 });
    assert.ok(path);
    assert.equal(path.length, 4);
  });

  await t.test("finds path around wall", () => {
    const s = session([
      "OOOOOOO",
      "OR   XO",
      "OOOO SO",
      "O     O",
      "OOOOOOO",
    ], 1);
    const path = findWalkPath(s, { row: 3, column: 1 });
    assert.ok(path);
    assert.ok(path.length > 2);
    assert.ok(path.includes("right"));
    assert.ok(path.includes("down"));
  });

  await t.test("returns null for wall target", () => {
    const s = session([
      "OOOOO",
      "OR XO",
      "O  SO",
      "OOOOO",
    ], 1);
    const path = findWalkPath(s, { row: 0, column: 0 });
    assert.equal(path, null);
  });

  await t.test("returns null for box target", () => {
    const s = session([
      "OOOOO",
      "OR XO",
      "O  SO",
      "OOOOO",
    ], 1);
    const path = findWalkPath(s, { row: 1, column: 3 });
    assert.equal(path, null);
  });

  await t.test("returns null for unreachable cell", () => {
    const s = session([
      "OOOOOOO",
      "OR O XO",
      "O  O SO",
      "OOOOOOO",
    ], 1);
    const path = findWalkPath(s, { row: 1, column: 4 });
    assert.equal(path, null);
  });

  await t.test("avoids boxes when pathfinding", () => {
    const s = session([
      "OOOOO",
      "OR  O",
      "OX SO",
      "O   O",
      "OOOOO",
    ], 1);
    const path = findWalkPath(s, { row: 2, column: 2 });
    assert.ok(path);
    assert.ok(path.length >= 2);
  });

  await t.test("finds shortest path (BFS guarantees this)", () => {
    const s = session([
      "OOOOOOO",
      "OR  X O",
      "O   S O",
      "O     O",
      "OOOOOOO",
    ], 1);
    const path = findWalkPath(s, { row: 3, column: 5 });
    assert.ok(path);
    assert.equal(path.length, 6);
  });

  await t.test("handles board with multiple boxes", () => {
    const s = session([
      "OOOOOOO",
      "OR    O",
      "O XX  O",
      "O SS  O",
      "OOOOOOO",
    ], 2);
    const path = findWalkPath(s, { row: 1, column: 5 });
    assert.ok(path);
    assert.equal(path.length, 4);
  });

  await t.test("works after move changes keeper position", () => {
    const s = session([
      "OOOOO",
      "OR XO",
      "O  SO",
      "OOOOO",
    ], 1);
    const s2 = move(s, "down");
    const path = findWalkPath(s2, { row: 2, column: 2 });
    assert.ok(path);
    assert.deepEqual(path, ["right"]);
  });

  await t.test("returned directions reach the target cell", () => {
    const s = session([
      "OOOOOOO",
      "OR  X O",
      "O   S O",
      "O     O",
      "OOOOOOO",
    ], 1);
    const target = { row: 3, column: 4 };
    const path = findWalkPath(s, target);
    assert.ok(path);
    let r = 1, c = 1;
    for (const dir of path) {
      if (dir === "up") r--;
      else if (dir === "down") r++;
      else if (dir === "left") c--;
      else if (dir === "right") c++;
    }
    assert.equal(r, target.row);
    assert.equal(c, target.column);
  });
});

test("cellFromLocalPoint", async (t) => {
  // Nine 40px columns and six 40px rows with 3px gaps.
  const grid: BoardGrid = {
    innerWidth: 9 * 40 + 8 * 3,
    innerHeight: 6 * 40 + 5 * 3,
    columnGap: 3,
    rowGap: 3,
    columns: 9,
    rows: 6,
  };
  const pitch = 43;

  await t.test("maps every cell centre to its own cell", () => {
    for (let row = 0; row < grid.rows; row += 1) {
      for (let column = 0; column < grid.columns; column += 1) {
        assert.deepEqual(
          cellFromLocalPoint(column * pitch + 20, row * pitch + 20, grid),
          { row, column },
        );
      }
    }
  });

  await t.test("keeps points near a cell's far edge in that cell", () => {
    // 95% of the way across column 1, and just inside the last cell.
    assert.deepEqual(cellFromLocalPoint(pitch + 38, 20, grid), { row: 0, column: 1 });
    assert.deepEqual(cellFromLocalPoint(8 * pitch + 39.9, 5 * pitch + 39.9, grid), {
      row: 5,
      column: 8,
    });
  });

  await t.test("maps gap pixels to the cell before the gap", () => {
    assert.deepEqual(cellFromLocalPoint(41, 20, grid), { row: 0, column: 0 });
    assert.deepEqual(cellFromLocalPoint(20, 42.5, grid), { row: 0, column: 0 });
    assert.deepEqual(cellFromLocalPoint(43, 43, grid), { row: 1, column: 1 });
  });

  await t.test("rejects points outside the content box", () => {
    assert.equal(cellFromLocalPoint(-0.1, 20, grid), null);
    assert.equal(cellFromLocalPoint(20, -0.1, grid), null);
    assert.equal(cellFromLocalPoint(grid.innerWidth, 20, grid), null);
    assert.equal(cellFromLocalPoint(20, grid.innerHeight, grid), null);
    assert.equal(cellFromLocalPoint(Number.NaN, 20, grid), null);
    assert.equal(cellFromLocalPoint(0, 0, { ...grid, columns: 0 }), null);
  });

  await t.test("gives the same cell for a click on a 3x zoomed board", () => {
    // A board with a 1px border and 7px padding, scaled 3x about its origin:
    // client offsets divide by the scale before the unscaled edges come off.
    const border = 1;
    const padding = 7;
    const scale = 3;
    const toClient = (x: number) => (x + border + padding) * scale;
    const toLocal = (client: number) => client / scale - border - padding;
    for (const x of [0, 20, pitch + 38, 4 * pitch + 41, 8 * pitch + 39]) {
      assert.deepEqual(
        cellFromLocalPoint(toLocal(toClient(x)), 20, grid),
        cellFromLocalPoint(x, 20, grid),
      );
    }
    // Subtracting unscaled padding from the scaled rect, as clicks were once
    // mapped, puts a click just inside the last column in the one before it.
    const client = toClient(8 * pitch + 1);
    const rectWidth = (grid.innerWidth + 2 * (border + padding)) * scale;
    const unscaledColumn = Math.floor(
      ((client - padding) / (rectWidth - 2 * padding)) * grid.columns,
    );
    assert.equal(unscaledColumn, 7);
    assert.deepEqual(cellFromLocalPoint(toLocal(client), 20, grid), { row: 0, column: 8 });
  });
});
