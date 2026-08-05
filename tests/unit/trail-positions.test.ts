import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GameHistoryEntry, Position } from "../../src/core/model.ts";
import { extractTrailPositions } from "../../src/features/game/trail-positions.ts";

function pos(row: number, column: number): Position {
  return Object.freeze({ row, column });
}

function buildHistory(
  robotPositions: Position[],
): GameHistoryEntry | null {
  let head: GameHistoryEntry | null = null;
  for (const robot of robotPositions) {
    head = Object.freeze({
      snapshot: Object.freeze({
        puzzleId: "test",
        robot,
        boxes: Object.freeze([]),
        moves: 0,
        pushes: 0,
        solved: false,
      }),
      previous: head,
    });
  }
  return head;
}

describe("extractTrailPositions", () => {
  it("returns empty trail for null history", () => {
    const trail = extractTrailPositions(null, pos(0, 0));
    assert.equal(trail.length, 0);
  });

  it("returns trail markers with correct ages for 3-move history", () => {
    const head = buildHistory([pos(2, 0), pos(1, 0), pos(0, 0)]);
    const current = pos(0, 1);
    const trail = extractTrailPositions(head, current);

    assert.equal(trail.length, 3);
    assert.deepEqual(trail[0].position, pos(0, 0));
    assert.equal(trail[0].age, 0);
    assert.deepEqual(trail[1].position, pos(1, 0));
    assert.equal(trail[1].age, 1);
    assert.deepEqual(trail[2].position, pos(2, 0));
    assert.equal(trail[2].age, 2);
  });

  it("limits trail to maxLength", () => {
    const positions = Array.from({ length: 10 }, (_, i) => pos(i, 0));
    const head = buildHistory(positions);
    const current = pos(10, 0);
    const trail = extractTrailPositions(head, current, 4);

    assert.equal(trail.length, 4);
  });

  it("defaults to 6 trail markers max", () => {
    const positions = Array.from({ length: 12 }, (_, i) => pos(i, 0));
    const head = buildHistory(positions);
    const current = pos(12, 0);
    const trail = extractTrailPositions(head, current);

    assert.equal(trail.length, 6);
  });

  it("deduplicates consecutive same-position entries", () => {
    const head = buildHistory([pos(1, 0), pos(1, 0), pos(0, 0)]);
    const current = pos(0, 1);
    const trail = extractTrailPositions(head, current);

    assert.equal(trail.length, 2);
    assert.deepEqual(trail[0].position, pos(0, 0));
    assert.deepEqual(trail[1].position, pos(1, 0));
  });

  it("excludes current robot position from trail", () => {
    const head = buildHistory([pos(0, 0)]);
    const current = pos(0, 0);
    const trail = extractTrailPositions(head, current);

    assert.equal(trail.length, 0);
  });
});
