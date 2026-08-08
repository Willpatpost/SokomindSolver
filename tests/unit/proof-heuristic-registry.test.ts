import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parsePuzzleRows } from "../../src/core/index.ts";
import { compileSearchBoard } from "../../src/solver/search/compiled-board.ts";
import { toDenseBoxes } from "../../src/solver/search/model.ts";
import { createDefaultProofRegistry } from "../../src/solver/search/proof-heuristics.ts";

function boardFromRows(rows: string[]) {
  const parsed = parsePuzzleRows(rows);
  const board = compileSearchBoard(parsed);
  const boxes = toDenseBoxes(board, parsed.initialBoxes);
  const robotCell = board.cellAt(parsed.initialRobot.row, parsed.initialRobot.column);
  return { board, boxes, robotCell };
}

const TINY_1BOX = ["OOOOO", "ORXSO", "OOOOO"];

const TWO_ROOM = [
  "OOOOOOO",
  "OR X  O",
  "OOO OOO",
  "O  S  O",
  "OOOOOOO",
];

describe("ProofHeuristicRegistry", () => {
  it("createDefaultProofRegistry returns 4 registrations", () => {
    const registry = createDefaultProofRegistry();
    assert.equal(registry.size, 4);
  });

  it("all four heuristics are retrievable by id", () => {
    const registry = createDefaultProofRegistry();
    assert.ok(registry.get("typed-assignment-push-lb"));
    assert.ok(registry.get("local-room-push-lb"));
    assert.ok(registry.get("local-corral-push-lb"));
    assert.ok(registry.get("doorway-crossing-push-lb"));
  });

  it("all heuristics return non-negative values on a simple board", () => {
    const registry = createDefaultProofRegistry();
    const { board, boxes, robotCell } = boardFromRows(TINY_1BOX);

    for (const reg of registry.registrations) {
      const value = reg.evaluate(board, boxes, robotCell);
      assert.ok(value >= 0, `${reg.id} returned negative: ${value}`);
    }
  });

  it("corral heuristic returns 0 when robotCell is omitted", () => {
    const registry = createDefaultProofRegistry();
    const { board, boxes } = boardFromRows(TINY_1BOX);

    const corral = registry.get("local-corral-push-lb")!;
    assert.equal(corral.evaluate(board, boxes), 0);
  });

  it("doorway-crossing returns non-negative value via registry", () => {
    const registry = createDefaultProofRegistry();
    const { board, boxes, robotCell } = boardFromRows(TWO_ROOM);

    const doorway = registry.get("doorway-crossing-push-lb")!;
    const value = doorway.evaluate(board, boxes, robotCell);
    assert.ok(value >= 0, `expected non-negative, got ${value}`);
  });

  it("duplicate registration throws", () => {
    const registry = createDefaultProofRegistry();
    assert.throws(
      () =>
        registry.register({
          id: "typed-assignment-push-lb",
          objective: "moves",
          proofFamily: "assignment",
          evaluate: () => 0,
        }),
      /already registered/,
    );
  });

  it("all proof families are distinct", () => {
    const registry = createDefaultProofRegistry();
    const families = new Set(registry.registrations.map((r) => r.proofFamily));
    assert.equal(families.size, registry.size);
  });
});
