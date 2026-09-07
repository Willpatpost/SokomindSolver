import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { PUZZLE_BY_ID } from "../../src/catalog/puzzles.ts";
import { createSession, type PuzzleDefinition } from "../../src/core/index.ts";
import { replayActionLog } from "../../src/core/replay.ts";
import { search } from "../../src/solver/implementations/sokomind-engine/engine.generated.js";
import { toLegacyState } from "../../src/solver/implementations/sokomind-solver.ts";
import reference from "../fixtures/solver-v2/grand-hall-reference.json" with { type: "json" };

interface TransitPlan {
  hardPruning: boolean;
  commitments: Array<{
    boxIndex: number;
    label: string;
    target: string;
    prerequisites: Array<{
      boxIndex: number;
      label: string;
      position: string;
      releaseCells: string[];
      releaseFrontier: string[];
    }>;
  }>;
}

beforeEach(t => {
  assert.ok("after" in t);
  const original = globalThis.postMessage;
  globalThis.postMessage = (() => {}) as typeof globalThis.postMessage;
  t.after(() => {
    if (original === undefined) Reflect.deleteProperty(globalThis, "postMessage");
    else globalThis.postMessage = original;
  });
});

function planFor(puzzle: PuzzleDefinition, log = ""): TransitPlan {
  const session = log ? replayActionLog(puzzle, log) : createSession(puzzle);
  const result = search({
    algorithm: "analyze-puzzle",
    state: toLegacyState({
      board: session.board,
      snapshot: session.snapshot,
      objective: { kind: "moves" },
    }),
  });
  const plan = (result.analysis as { transportPlan: { goalTransit: TransitPlan } })
    .transportPlan.goalTransit;
  assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan);
  return plan;
}

test("Grand Hall plans G's escape before H's final placement in every orientation", () => {
  const puzzle = PUZZLE_BY_ID.huge;
  const size = puzzle.rows.length;
  for (const transform of [
    { rows: puzzle.rows, point: (y: number, x: number) => `${y},${x}` },
    {
      rows: puzzle.rows.map(row => [...row].reverse().join("")),
      point: (y: number, x: number) => `${y},${size - 1 - x}`,
    },
    {
      rows: [...puzzle.rows].reverse().map(row => [...row].reverse().join("")),
      point: (y: number, x: number) => `${size - 1 - y},${size - 1 - x}`,
    },
  ]) {
    const plan = planFor({ ...puzzle, rows: transform.rows });
    assert.equal(plan.hardPruning, false);
    assert.equal(plan.commitments.length, 1);
    const commitment = plan.commitments[0];
    assert.equal(commitment.label, "H");
    assert.equal(commitment.target, transform.point(7, 4));
    assert.equal(commitment.prerequisites.length, 1);
    const prerequisite = commitment.prerequisites[0];
    assert.notEqual(prerequisite.boxIndex, commitment.boxIndex);
    assert.equal(prerequisite.label, "G");
    assert.equal(prerequisite.position, transform.point(7, 2));
    assert.deepEqual(new Set(prerequisite.releaseFrontier), new Set([
      transform.point(5, 4), transform.point(9, 4),
    ]));
    assert.ok(prerequisite.releaseCells.includes(transform.point(7, 12)));
    assert.ok(!prerequisite.releaseCells.includes(transform.point(7, 3)));
    assert.ok(!prerequisite.releaseCells.includes(commitment.target));
  }
});

test("the human reference clears the transit prerequisite before H finishes", () => {
  const puzzle = PUZZLE_BY_ID.huge;
  assert.ok(planFor(puzzle, reference.actionLog.slice(0, 590))
    .commitments.some(commitment => commitment.label === "H"));
  assert.ok(!planFor(puzzle, reference.actionLog.slice(0, 614))
    .commitments.some(commitment => commitment.label === "H"));
  assert.equal(planFor(puzzle, reference.actionLog).commitments.length, 0);
});

test("a compatible alternative goal prevents a false transit prerequisite", () => {
  const puzzle = PUZZLE_BY_ID.huge;
  const rows = puzzle.rows.map(row => row.replaceAll("G", "X").replaceAll("g", " "));
  const pocket = [...rows[7]];
  pocket[3] = "S";
  rows[7] = pocket.join("");
  const plan = planFor({ ...puzzle, rows });
  assert.ok(!plan.commitments.some(commitment => commitment.label === "H"));
});
