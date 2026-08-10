import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  WorkerExecutionRegistry,
} from "../../src/solver/implementations/sokomind-worker-registry.ts";

describe("WorkerExecutionRegistry", () => {
  it("register creates active telemetry with default values", () => {
    const registry = new WorkerExecutionRegistry();
    const tel = registry.register("test-1", "Test worker", "search");
    assert.equal(tel.active, true);
    assert.equal(tel.label, "Test worker");
    assert.equal(tel.mode, "search");
    assert.equal(tel.visited, 0);
    assert.equal(tel.generated, 0);
    assert.equal(tel.frontier, 0);
    assert.ok(tel.estimatedMemoryBytes > 0);
  });

  it("deactivate clears active and frontier", () => {
    const registry = new WorkerExecutionRegistry();
    const tel = registry.register("w1", "Worker", "search");
    tel.frontier = 500;
    tel.active = true;
    registry.deactivate("w1");
    assert.equal(tel.active, false);
    assert.equal(tel.frontier, 0);
  });

  it("deactivate is a no-op for unknown IDs", () => {
    const registry = new WorkerExecutionRegistry();
    registry.deactivate("nonexistent");
    assert.equal(registry.size, 0);
  });

  it("uniqueId returns the base when first used", () => {
    const registry = new WorkerExecutionRegistry();
    assert.equal(registry.uniqueId("worker"), "worker");
  });

  it("uniqueId appends a counter for duplicates", () => {
    const registry = new WorkerExecutionRegistry();
    assert.equal(registry.uniqueId("worker"), "worker");
    assert.equal(registry.uniqueId("worker"), "worker-1");
    assert.equal(registry.uniqueId("worker"), "worker-2");
  });

  it("uniqueId handles interleaved base names", () => {
    const registry = new WorkerExecutionRegistry();
    assert.equal(registry.uniqueId("alpha"), "alpha");
    assert.equal(registry.uniqueId("beta"), "beta");
    assert.equal(registry.uniqueId("alpha"), "alpha-1");
    assert.equal(registry.uniqueId("beta"), "beta-1");
  });

  it("entries iterates all registered workers", () => {
    const registry = new WorkerExecutionRegistry();
    registry.register("a", "A", "search");
    registry.register("b", "B", "search");
    registry.register("c", "C", "bidir-forward");
    const ids = [...registry.entries()].map(([id]) => id);
    assert.deepEqual(ids, ["a", "b", "c"]);
  });

  it("activeCount reflects only active workers", () => {
    const registry = new WorkerExecutionRegistry();
    registry.register("a", "A", "search");
    registry.register("b", "B", "search");
    registry.register("c", "C", "search");
    assert.equal(registry.activeCount(), 3);
    registry.deactivate("b");
    assert.equal(registry.activeCount(), 2);
    registry.deactivate("a");
    assert.equal(registry.activeCount(), 1);
  });
});
