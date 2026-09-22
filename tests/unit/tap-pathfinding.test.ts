import assert from "node:assert/strict";
import test from "node:test";

import {
  createSession,
  move,
  type PuzzleDefinition,
} from "../../src/core/index.ts";
import { findWalkPath } from "../../src/features/game/tap-pathfinding.ts";

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
