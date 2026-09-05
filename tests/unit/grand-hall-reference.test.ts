import assert from "node:assert/strict";
import test from "node:test";

import { PUZZLE_BY_ID } from "../../src/catalog/puzzles.ts";
import { replayActionLog } from "../../src/core/replay.ts";
import { puzzleRevisionFingerprint } from "../../src/core/puzzle-revision.ts";
import reference from "../fixtures/solver-v2/grand-hall-reference.json" with { type: "json" };

// A replay-valid incumbent establishes an upper bound, not an optimality proof.
test("Grand Hall human reference solves the fingerprinted board in 626 moves", () => {
  const puzzle = PUZZLE_BY_ID[reference.puzzleId];
  assert.ok(puzzle);
  assert.equal(puzzleRevisionFingerprint(puzzle), reference.boardRevision);
  assert.equal(reference.optimality, "unproven");
  assert.equal(reference.actionLog.length, reference.moves);
  const session = replayActionLog(puzzle, reference.actionLog);
  assert.equal(session.solved, true);
  assert.equal(session.moves, reference.moves);
  assert.equal(session.pushes, reference.pushes);
});

test("Grand Hall reference preserves its bound under mirror and rotation", () => {
  const puzzle = PUZZLE_BY_ID[reference.puzzleId];
  assert.ok(puzzle);
  for (const transform of [
    {
      name: "mirrored",
      rows: puzzle.rows.map((row) => [...row].reverse().join("")),
      directions: { U: "U", D: "D", L: "R", R: "L" },
    },
    {
      name: "rotated",
      rows: [...puzzle.rows].reverse().map((row) => [...row].reverse().join("")),
      directions: { U: "D", D: "U", L: "R", R: "L" },
    },
  ]) {
    const log = [...reference.actionLog].map(
      (code) => transform.directions[code as keyof typeof transform.directions],
    ).join("");
    const session = replayActionLog({ ...puzzle, rows: transform.rows }, log);
    assert.equal(session.solved, true, transform.name);
    assert.equal(session.moves, reference.moves, transform.name);
    assert.equal(session.pushes, reference.pushes, transform.name);
  }
});
