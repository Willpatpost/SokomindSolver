import assert from "node:assert/strict";
import test from "node:test";
import { moveAnnouncement } from "../../src/features/game/board-announcement.ts";

test("move announcements use singular counts for one", () => {
  assert.equal(
    moveAnnouncement({
      robot: { row: 0, column: 2 },
      matchedBoxes: 0,
      totalBoxes: 1,
      moves: 1,
      pushes: 1,
      solved: false,
    }),
    "Keeper at row 1, column 3. 0 of 1 box on matching goals. 1 move, 1 push.",
  );
});

test("move announcements use plural counts and report a solve", () => {
  assert.equal(
    moveAnnouncement({
      robot: { row: 4, column: 1 },
      matchedBoxes: 3,
      totalBoxes: 3,
      moves: 12,
      pushes: 0,
      solved: true,
    }),
    "Keeper at row 5, column 2. 3 of 3 boxes on matching goals. 12 moves, 0 pushes. Puzzle solved.",
  );
});
