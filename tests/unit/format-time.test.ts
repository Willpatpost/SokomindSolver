import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatTime } from "../../src/features/game/timer-math.ts";

describe("formatTime", () => {
  it("formats zero as 0:00", () => {
    assert.equal(formatTime(0), "0:00");
  });

  it("formats seconds under a minute", () => {
    assert.equal(formatTime(5_000), "0:05");
    assert.equal(formatTime(45_000), "0:45");
  });

  it("formats exact minutes", () => {
    assert.equal(formatTime(60_000), "1:00");
    assert.equal(formatTime(120_000), "2:00");
  });

  it("formats minutes and seconds", () => {
    assert.equal(formatTime(90_000), "1:30");
    assert.equal(formatTime(3_599_000), "59:59");
  });

  it("switches to H:MM:SS at one hour", () => {
    assert.equal(formatTime(3_600_000), "1:00:00");
    assert.equal(formatTime(3_661_000), "1:01:01");
  });

  it("handles multi-hour values", () => {
    assert.equal(formatTime(7_200_000), "2:00:00");
    assert.equal(formatTime(36_000_000), "10:00:00");
  });

  it("truncates sub-second precision", () => {
    assert.equal(formatTime(1_999), "0:01");
    assert.equal(formatTime(500), "0:00");
  });
});
