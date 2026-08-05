import assert from "node:assert/strict";
import test from "node:test";

import { resolveSwipeDirection } from "../../src/features/game/swipe-direction.ts";

test("returns null when delta is below threshold", () => {
  assert.equal(resolveSwipeDirection(10, 5, 30), null);
  assert.equal(resolveSwipeDirection(-15, 20, 30), null);
  assert.equal(resolveSwipeDirection(0, 0, 30), null);
});

test("detects rightward swipe", () => {
  assert.equal(resolveSwipeDirection(50, 10, 30), "right");
  assert.equal(resolveSwipeDirection(100, -20, 30), "right");
});

test("detects leftward swipe", () => {
  assert.equal(resolveSwipeDirection(-50, 10, 30), "left");
  assert.equal(resolveSwipeDirection(-80, -15, 30), "left");
});

test("detects downward swipe", () => {
  assert.equal(resolveSwipeDirection(10, 50, 30), "down");
  assert.equal(resolveSwipeDirection(-5, 80, 30), "down");
});

test("detects upward swipe", () => {
  assert.equal(resolveSwipeDirection(10, -50, 30), "up");
  assert.equal(resolveSwipeDirection(-5, -80, 30), "up");
});

test("dominant axis wins on diagonal swipes", () => {
  assert.equal(resolveSwipeDirection(60, 40, 30), "right");
  assert.equal(resolveSwipeDirection(-60, 40, 30), "left");
  assert.equal(resolveSwipeDirection(40, 60, 30), "down");
  assert.equal(resolveSwipeDirection(40, -60, 30), "up");
});

test("exact 45-degree defaults to horizontal", () => {
  assert.equal(resolveSwipeDirection(50, 50, 30), "right");
  assert.equal(resolveSwipeDirection(-50, -50, 30), "left");
});

test("custom threshold works", () => {
  assert.equal(resolveSwipeDirection(15, 0, 10), "right");
  assert.equal(resolveSwipeDirection(15, 0, 20), null);
});
