import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  calculateElapsedTime,
  nextTimerUpdateDelay,
} from "../../src/features/game/timer-math.ts";

describe("timer scheduling", () => {
  it("preserves precise accumulated time while running and paused", () => {
    assert.equal(calculateElapsedTime(1_250.5, null, 9_000), 1_250.5);
    assert.equal(calculateElapsedTime(1_250.5, 4_000, 4_375.25), 1_625.75);
  });

  it("aligns updates to displayed second boundaries", () => {
    assert.equal(nextTimerUpdateDelay(0), 1_000);
    assert.equal(nextTimerUpdateDelay(250), 750);
    assert.equal(nextTimerUpdateDelay(999.5), 1);
    assert.equal(nextTimerUpdateDelay(1_000), 1_000);
    assert.equal(nextTimerUpdateDelay(1_250), 750);
  });
});
