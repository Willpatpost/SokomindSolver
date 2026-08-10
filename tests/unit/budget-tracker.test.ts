import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BudgetTracker,
  type AggregateSnapshot,
} from "../../src/solver/implementations/sokomind-budget-tracker.ts";

function snapshot(overrides: Partial<AggregateSnapshot> = {}): AggregateSnapshot {
  return {
    expandedStates: 0,
    generatedStates: 0,
    frontierSize: 0,
    peakFrontierSize: 0,
    estimatedMemoryBytes: 0,
    peakEstimatedMemoryBytes: 0,
    counters: {},
    ...overrides,
  };
}

describe("BudgetTracker", () => {
  it("returns undefined when no limits are exceeded", () => {
    const tracker = new BudgetTracker();
    const controller = new AbortController();
    const result = tracker.checkLimit(
      snapshot({ expandedStates: 100 }),
      { maxExpandedStates: 1000 },
      controller.signal,
      0,
      Infinity,
    );
    assert.equal(result, undefined);
  });

  it("returns cancelled when signal is aborted", () => {
    const tracker = new BudgetTracker();
    const controller = new AbortController();
    controller.abort();
    const result = tracker.checkLimit(
      snapshot(),
      undefined,
      controller.signal,
      0,
      Infinity,
    );
    assert.equal(result, "cancelled");
  });

  it("returns elapsed when past deadline", () => {
    const tracker = new BudgetTracker();
    const controller = new AbortController();
    const result = tracker.checkLimit(
      snapshot(),
      undefined,
      controller.signal,
      1000,
      500,
    );
    assert.equal(result, "elapsed");
  });

  it("returns expanded when states exceed limit", () => {
    const tracker = new BudgetTracker();
    const controller = new AbortController();
    const result = tracker.checkLimit(
      snapshot({ expandedStates: 5000 }),
      { maxExpandedStates: 5000 },
      controller.signal,
      0,
      Infinity,
    );
    assert.equal(result, "expanded");
  });

  it("returns generated when states exceed limit", () => {
    const tracker = new BudgetTracker();
    const controller = new AbortController();
    const result = tracker.checkLimit(
      snapshot({ generatedStates: 10_001 }),
      { maxGeneratedStates: 10_000 },
      controller.signal,
      0,
      Infinity,
    );
    assert.equal(result, "generated");
  });

  it("returns memory when bytes exceed limit", () => {
    const tracker = new BudgetTracker();
    const controller = new AbortController();
    const result = tracker.checkLimit(
      snapshot({ estimatedMemoryBytes: 512 * 1024 * 1024 }),
      { maxMemoryBytes: 256 * 1024 * 1024 },
      controller.signal,
      0,
      Infinity,
    );
    assert.equal(result, "memory");
  });

  it("retainRecord increments counts and peak", () => {
    const tracker = new BudgetTracker();
    tracker.retainRecord(100);
    assert.equal(tracker.coordinatorRecordCount, 1);
    assert.equal(tracker.peakCoordinatorRecordCount, 1);
    assert.equal(tracker.coordinatorEstimatedMemoryBytes, 100);
    tracker.retainRecord(200);
    assert.equal(tracker.coordinatorRecordCount, 2);
    assert.equal(tracker.peakCoordinatorRecordCount, 2);
    assert.equal(tracker.coordinatorEstimatedMemoryBytes, 300);
  });

  it("updateRecord adjusts memory delta", () => {
    const tracker = new BudgetTracker();
    tracker.retainRecord(100);
    tracker.updateRecord(100, 150);
    assert.equal(tracker.coordinatorEstimatedMemoryBytes, 150);
    assert.equal(tracker.coordinatorRecordCount, 1);
  });

  it("resetPhase zeroes coordinator state", () => {
    const tracker = new BudgetTracker();
    tracker.retainRecord(100);
    tracker.retainRecord(200);
    tracker.resetPhase();
    assert.equal(tracker.coordinatorRecordCount, 0);
    assert.equal(tracker.coordinatorEstimatedMemoryBytes, 0);
    assert.equal(tracker.peakCoordinatorRecordCount, 2);
  });

  it("priority: cancelled > elapsed > expanded > generated > memory", () => {
    const tracker = new BudgetTracker();
    const controller = new AbortController();
    controller.abort();
    const result = tracker.checkLimit(
      snapshot({
        expandedStates: 99999,
        generatedStates: 99999,
        estimatedMemoryBytes: 99999,
      }),
      {
        maxExpandedStates: 100,
        maxGeneratedStates: 100,
        maxMemoryBytes: 100,
      },
      controller.signal,
      1000,
      500,
    );
    assert.equal(result, "cancelled");
  });
});
