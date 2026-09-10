import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSession, stepSnapshot, type Direction, type GameSnapshot } from "../../src/core/index.ts";
import { search } from "../../src/solver/implementations/sokomind-engine/engine.generated.js";
import { toLegacyState } from "../../src/solver/implementations/sokomind-solver.ts";

interface ScheduleEntry {
  boxIndex: number;
  label: string;
  original: {
    pushCount: number;
    phaseCount: number;
    firstPushIndex: number;
    lastPushIndex: number;
    prePushWalking: number;
  };
  repaired: {
    pushCount: number;
    phaseCount: number;
    firstPushIndex: number;
    lastPushIndex: number;
    prePushWalking: number;
  } | null;
  improvement: {
    pushesDelta: number;
    phasesDelta: number;
    walkingDelta: number;
  } | null;
}

const session = createSession({
  id: "trace-fixture",
  title: "Schedule trace test",
  difficulty: "tutorial",
  boxes: 2,
  rows: ["OOOOOOO", "O  R  O", "O A a O", "O B b O", "O     O", "OOOOOOO"],
});
const request = {
  board: session.board,
  snapshot: session.snapshot,
  objective: { kind: "moves" as const },
};
const incumbent = [..."LLDDRRUULDLDDRULURR"].map(
  (code) => ({ L: "Left", R: "Right", U: "Up", D: "Down" })[code]!,
);

describe("Schedule trace", () => {
  it("is absent when diagnostics is not set", () => {
    const result = search({
      algorithm: "solution-box-reschedule",
      state: toLegacyState(request),
      solutionPath: incumbent,
      rescheduleRounds: 1,
      maxVisited: 10000,
      maxGenerated: 40000,
    }) as Record<string, unknown>;

    assert.equal(result.scheduleTrace, undefined);
  });

  it("returns per-box schedule entries when diagnostics is true", () => {
    const result = search({
      algorithm: "solution-box-reschedule",
      state: toLegacyState(request),
      solutionPath: incumbent,
      rescheduleRounds: 1,
      maxVisited: 10000,
      maxGenerated: 40000,
      diagnostics: true,
    }) as Record<string, unknown>;

    assert.ok(Array.isArray(result.scheduleTrace));
    const trace = result.scheduleTrace as ScheduleEntry[];
    assert.equal(trace.length, 2);

    for (const entry of trace) {
      assert.equal(typeof entry.boxIndex, "number");
      assert.equal(typeof entry.label, "string");
      assert.ok(entry.original);
      assert.equal(typeof entry.original.pushCount, "number");
      assert.equal(typeof entry.original.phaseCount, "number");
      assert.equal(typeof entry.original.firstPushIndex, "number");
      assert.equal(typeof entry.original.lastPushIndex, "number");
      assert.equal(typeof entry.original.prePushWalking, "number");
    }
  });

  it("original push counts sum to total pushes", () => {
    const result = search({
      algorithm: "solution-box-reschedule",
      state: toLegacyState(request),
      solutionPath: incumbent,
      rescheduleRounds: 1,
      maxVisited: 10000,
      maxGenerated: 40000,
      diagnostics: true,
    }) as Record<string, unknown>;

    const trace = result.scheduleTrace as ScheduleEntry[];
    let snapshot: GameSnapshot = request.snapshot;
    let totalPushes = 0;
    for (const move of incumbent) {
      const dir = move.toLowerCase() as Direction;
      const next = stepSnapshot(request.board, snapshot, dir);
      assert.ok(next.moved);
      if (next.pushed) totalPushes++;
      snapshot = next.snapshot;
    }
    const tracePushes = trace.reduce(
      (sum, entry) => sum + entry.original.pushCount,
      0,
    );
    assert.equal(tracePushes, totalPushes);
  });

  it("repaired entries reflect rescheduled path", () => {
    const result = search({
      algorithm: "solution-box-reschedule",
      state: toLegacyState(request),
      solutionPath: incumbent,
      rescheduleRounds: 2,
      maxVisited: 10000,
      maxGenerated: 40000,
      diagnostics: true,
    }) as Record<string, unknown>;

    const trace = result.scheduleTrace as ScheduleEntry[];
    for (const entry of trace) {
      assert.ok(entry.repaired !== undefined);
      if (entry.repaired) {
        assert.equal(typeof entry.repaired.pushCount, "number");
        assert.ok(entry.improvement !== null);
      }
    }
  });

  it("improvement deltas are original minus repaired", () => {
    const result = search({
      algorithm: "solution-box-reschedule",
      state: toLegacyState(request),
      solutionPath: incumbent,
      rescheduleRounds: 2,
      maxVisited: 10000,
      maxGenerated: 40000,
      diagnostics: true,
    }) as Record<string, unknown>;

    const trace = result.scheduleTrace as ScheduleEntry[];
    for (const entry of trace) {
      if (entry.repaired && entry.improvement) {
        assert.equal(
          entry.improvement.pushesDelta,
          entry.original.pushCount - entry.repaired.pushCount,
        );
        assert.equal(
          entry.improvement.phasesDelta,
          entry.original.phaseCount - entry.repaired.phaseCount,
        );
        assert.equal(
          entry.improvement.walkingDelta,
          entry.original.prePushWalking - entry.repaired.prePushWalking,
        );
      }
    }
  });
});
