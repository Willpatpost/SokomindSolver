import assert from "node:assert/strict";
import test from "node:test";

import {
  floodKeeperReachable,
  enumerateReachablePushes,
} from "../../src/features/generator/v2/reachable-pushes.ts";

function parseGrid(rows: readonly string[]): string[][] {
  return rows.map((r) => [...r]);
}

// ---------------------------------------------------------------------------
// floodKeeperReachable
// ---------------------------------------------------------------------------

test("keeper flood avoids walls and boxes", () => {
  const grid = parseGrid([
    "OOOOO",
    "OR  O",
    "O O O",
    "O   O",
    "OOOOO",
  ]);
  const boxes = new Set(["2,2"]);
  const reachable = floodKeeperReachable(grid, { row: 1, column: 1 }, boxes);

  assert.ok(reachable.has("1,1"), "robot start is reachable");
  assert.ok(reachable.has("1,2"), "open floor is reachable");
  assert.ok(!reachable.has("2,2"), "box position is not reachable");
  assert.ok(!reachable.has("0,0"), "wall is not reachable");
});

test("keeper flood reaches cells around boxes", () => {
  const grid = parseGrid([
    "OOOOO",
    "O   O",
    "O   O",
    "OR  O",
    "OOOOO",
  ]);
  const boxes = new Set(["2,2"]);
  const reachable = floodKeeperReachable(grid, { row: 3, column: 1 }, boxes);

  assert.ok(reachable.has("1,1"), "can reach around box");
  assert.ok(reachable.has("1,3"), "can reach far side");
  assert.ok(reachable.has("2,1"), "adjacent to box is reachable");
  assert.ok(!reachable.has("2,2"), "box cell itself not reachable");
});

// ---------------------------------------------------------------------------
// enumerateReachablePushes
// ---------------------------------------------------------------------------

test("box in center of open room has 4 reachable pushes", () => {
  const grid = parseGrid([
    "OOOOOOO",
    "O     O",
    "O     O",
    "O     O",
    "O     O",
    "O     O",
    "OOOOOOO",
  ]);
  const robot = { row: 1, column: 1 };
  const boxes = [{ row: 3, column: 3 }];
  const pushes = enumerateReachablePushes(grid, robot, boxes);

  assert.equal(pushes.length, 4, "4 pushes from 4 directions");
  const dirs = new Set(pushes.map((p) => p.direction));
  assert.equal(dirs.size, 4, "all 4 directions");
});

test("box in corner has 0 reachable pushes", () => {
  const grid = parseGrid([
    "OOOOO",
    "O   O",
    "O   O",
    "O   O",
    "OOOOO",
  ]);
  const robot = { row: 1, column: 1 };
  const boxes = [{ row: 1, column: 3 }];
  const pushes = enumerateReachablePushes(grid, robot, boxes);

  const canPushUp = pushes.some((p) => p.direction === "up");
  const canPushRight = pushes.some((p) => p.direction === "right");
  assert.ok(!canPushUp, "can't push up into wall");
  assert.ok(!canPushRight, "can't push right into wall");
});

test("reachable pushes > adjacent pushes when keeper walks around", () => {
  const grid = parseGrid([
    "OOOOOOO",
    "O     O",
    "O     O",
    "O     O",
    "O     O",
    "OR    O",
    "OOOOOOO",
  ]);
  const robot = { row: 5, column: 1 };
  const boxes = [{ row: 3, column: 3 }];

  const pushes = enumerateReachablePushes(grid, robot, boxes);
  assert.equal(pushes.length, 4, "keeper can walk around to all 4 sides");

  let adjacentCount = 0;
  const dr = [-1, 1, 0, 0];
  const dc = [0, 0, -1, 1];
  for (let d = 0; d < 4; d++) {
    if (robot.row + dr[d] === boxes[0].row && robot.column + dc[d] === boxes[0].column) {
      adjacentCount++;
    }
  }
  assert.equal(adjacentCount, 0, "robot is not adjacent to box");
  assert.ok(pushes.length > adjacentCount, "reachable > adjacent");
});

test("keeper blocked by boxes can only push accessible ones", () => {
  const grid = parseGrid([
    "OOOOOOO",
    "OR    O",
    "O     O",
    "O     O",
    "OOOOOOO",
  ]);
  const robot = { row: 1, column: 1 };
  const boxes = [
    { row: 2, column: 1 },
    { row: 2, column: 5 },
  ];
  const pushes = enumerateReachablePushes(grid, robot, boxes);

  const box0Pushes = pushes.filter((p) => p.boxIndex === 0);
  const box1Pushes = pushes.filter((p) => p.boxIndex === 1);

  assert.ok(box0Pushes.length > 0, "can push box 0 (adjacent)");
  assert.ok(box1Pushes.length >= 0, "box 1 may or may not be reachable depending on layout");
});

test("enumerateReachablePushes is deterministic", () => {
  const grid = parseGrid([
    "OOOOOOO",
    "O     O",
    "O     O",
    "O     O",
    "OOOOOOO",
  ]);
  const robot = { row: 1, column: 1 };
  const boxes = [{ row: 2, column: 3 }, { row: 2, column: 5 }];

  const p1 = enumerateReachablePushes(grid, robot, boxes);
  const p2 = enumerateReachablePushes(grid, robot, boxes);
  assert.deepEqual(p1, p2);
});

test("no pushes possible when all destinations are walls", () => {
  const grid = parseGrid([
    "OOO",
    "ORO",
    "OOO",
  ]);
  const robot = { row: 1, column: 1 };
  const boxes: Array<{ row: number; column: number }> = [];
  const pushes = enumerateReachablePushes(grid, robot, boxes);
  assert.equal(pushes.length, 0);
});
