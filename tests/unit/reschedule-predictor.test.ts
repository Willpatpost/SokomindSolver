import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  predictRescheduleValue,
} from "../../src/solver/implementations/sokomind-reschedule-predictor.ts";
import type { SolverSolution } from "../../src/solver/contracts.ts";

function makeSolution(moves: number, pushes: number): SolverSolution {
  return {
    steps: [],
    moves,
    pushes,
    objective: { kind: "moves" },
    objectiveScore: moves,
    optimality: "unknown",
  };
}

function makeState(boxCount: number, floorSize = 25): { rows: string[]; boxes: [string, string][]; robot: [number, number] } {
  const width = Math.ceil(Math.sqrt(floorSize)) + 2;
  const height = Math.ceil(floorSize / (width - 2)) + 2;
  const rows: string[] = [];
  for (let y = 0; y < height; y++) {
    if (y === 0 || y === height - 1) {
      rows.push("O".repeat(width));
    } else {
      rows.push("O" + " ".repeat(width - 2) + "O");
    }
  }
  const boxes: [string, string][] = [];
  for (let i = 0; i < boxCount; i++) {
    boxes.push([`${1 + Math.floor(i / (width - 2))},${1 + (i % (width - 2))}`, "X"]);
  }
  return { rows, boxes, robot: [1, 1] };
}

describe("predictRescheduleValue", () => {
  it("skips small puzzles with low walk ratio", () => {
    const state = makeState(3);
    const solution = makeSolution(20, 15);
    const prediction = predictRescheduleValue(state, solution);
    assert.equal(prediction.recommendation, "skip");
    assert.ok(prediction.walkPushRatio < 1.5);
    assert.ok(prediction.boxCount < 4);
  });

  it("recommends light for moderate puzzles", () => {
    const state = makeState(5);
    const solution = makeSolution(30, 18);
    const prediction = predictRescheduleValue(state, solution);
    assert.equal(prediction.recommendation, "light");
  });

  it("recommends full for large puzzles with high walk ratio", () => {
    const state = makeState(10, 100);
    const solution = makeSolution(500, 150);
    const prediction = predictRescheduleValue(state, solution);
    assert.equal(prediction.recommendation, "full");
    assert.ok(prediction.walkPushRatio >= 2.0);
    assert.ok(prediction.boxCount >= 6);
  });

  it("computes walkPushRatio correctly", () => {
    const state = makeState(5);
    const solution = makeSolution(100, 40);
    const prediction = predictRescheduleValue(state, solution);
    assert.equal(prediction.walkPushRatio, (100 - 40) / 40);
  });

  it("handles zero pushes without error", () => {
    const state = makeState(2);
    const solution = makeSolution(10, 0);
    const prediction = predictRescheduleValue(state, solution);
    assert.equal(prediction.walkPushRatio, 0);
  });

  it("returns correct floorBoxRatio", () => {
    const state = makeState(4, 16);
    const solution = makeSolution(50, 20);
    const prediction = predictRescheduleValue(state, solution);
    assert.equal(prediction.boxCount, 4);
    assert.ok(prediction.floorBoxRatio > 0);
  });
});
