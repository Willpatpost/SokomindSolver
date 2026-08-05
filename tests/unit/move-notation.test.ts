import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatActionLog,
  GLYPH,
  MAX_VISIBLE,
} from "../../src/features/game/move-notation-format.ts";

describe("formatActionLog", () => {
  it("returns empty glyphs for an empty action log", () => {
    const result = formatActionLog("");
    assert.deepEqual(result.glyphs, []);
    assert.equal(result.truncated, false);
    assert.equal(result.offset, 0);
  });

  it("formats a short log without truncation", () => {
    const result = formatActionLog("RRDD");
    assert.deepEqual(result.glyphs, ["→", "→", "↓", "↓"]);
    assert.equal(result.truncated, false);
    assert.equal(result.offset, 0);
  });

  it("handles a log exactly at MAX_VISIBLE length", () => {
    const log = "U".repeat(MAX_VISIBLE);
    assert.equal(log.length, 24);
    const result = formatActionLog(log);
    assert.equal(result.glyphs.length, 24);
    assert.equal(result.truncated, false);
    assert.equal(result.offset, 0);
    assert.ok(result.glyphs.every((g) => g === "↑"));
  });

  it("truncates a log exceeding MAX_VISIBLE", () => {
    const log = "L".repeat(30);
    const result = formatActionLog(log);
    assert.equal(result.glyphs.length, 24);
    assert.equal(result.truncated, true);
    assert.equal(result.offset, 6);
    assert.ok(result.glyphs.every((g) => g === "←"));
  });

  it("maps each direction code to the correct glyph", () => {
    assert.equal(GLYPH["U"], "↑");
    assert.equal(GLYPH["D"], "↓");
    assert.equal(GLYPH["L"], "←");
    assert.equal(GLYPH["R"], "→");

    const result = formatActionLog("UDLR");
    assert.deepEqual(result.glyphs, ["↑", "↓", "←", "→"]);
  });
});
