import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  SolverAdapter,
  SolverCapabilities,
} from "../../src/solver/contracts.ts";
import {
  DuplicateSolverError,
  InvalidSolverAdapterError,
  SolverNotFoundError,
  SolverRegistry,
} from "../../src/solver/registry.ts";

const capabilities = Object.freeze({
  executionTargets: ["web-worker"] as const,
  runtime: "javascript",
  objectives: ["moves"] as const,
  quality: "bounded",
  labeledBoxes: true,
  genericBoxes: true,
  partialState: true,
  reportsProgress: true,
  cooperativeCancellation: true,
  deterministic: true,
}) satisfies SolverCapabilities;

function makeAdapter(id: string): SolverAdapter {
  return {
    metadata: {
      id,
      displayName: `Solver ${id}`,
      description: "Test-only adapter",
      version: "1.0.0",
      capabilities,
    },
    async solve() {
      return {
        status: "unsolved",
        reason: "exhausted",
        metrics: { elapsedMs: 0 },
      };
    },
  };
}

describe("SolverRegistry", () => {
  it("registers and discovers adapters in stable insertion order", () => {
    const first = makeAdapter("first");
    const second = makeAdapter("second-solver");
    const registry = new SolverRegistry([first, second]);

    assert.equal(registry.size, 2);
    assert.equal(registry.has("first"), true);
    assert.equal(registry.get("first"), first);
    assert.equal(registry.require("second-solver"), second);
    assert.deepEqual(registry.list(), [first, second]);
    assert.deepEqual(
      registry.listMetadata().map(({ id }) => id),
      ["first", "second-solver"],
    );
    assert.equal(Object.isFrozen(registry.list()), true);
  });

  it("rejects duplicate ids without replacing the original adapter", () => {
    const original = makeAdapter("duplicate");
    const replacement = makeAdapter("duplicate");
    const registry = new SolverRegistry([original]);

    assert.throws(
      () => registry.register(replacement),
      (error: unknown) =>
        error instanceof DuplicateSolverError &&
        error.solverId === "duplicate",
    );
    assert.equal(registry.size, 1);
    assert.equal(registry.require("duplicate"), original);
  });

  it("registration handles are idempotent and cannot remove a replacement", () => {
    const original = makeAdapter("replaceable");
    const registry = new SolverRegistry();
    const registration = registry.register(original);

    assert.equal(registry.unregister("replaceable"), true);
    const replacement = makeAdapter("replaceable");
    registry.register(replacement);

    assert.equal(registration.unregister(), false);
    assert.equal(registry.require("replaceable"), replacement);
  });

  it("reports missing solvers with a domain error", () => {
    const registry = new SolverRegistry();

    assert.equal(registry.get("missing"), undefined);
    assert.throws(
      () => registry.require("missing"),
      (error: unknown) =>
        error instanceof SolverNotFoundError && error.solverId === "missing",
    );
  });

  it("rejects malformed adapter metadata at registration time", () => {
    const invalid = makeAdapter("Not URL Safe");
    const registry = new SolverRegistry();

    assert.throws(
      () => registry.register(invalid),
      InvalidSolverAdapterError,
    );
    assert.equal(registry.size, 0);
  });

  it("rejects invalid capability enums and missing boolean flags", () => {
    const booleanFlags = [
      "labeledBoxes",
      "genericBoxes",
      "partialState",
      "reportsProgress",
      "cooperativeCancellation",
      "deterministic",
    ] as const;
    const invalidCapabilities: Array<Record<string, unknown>> = [
      { ...capabilities, executionTargets: ["gpu"] },
      { ...capabilities, runtime: "native" },
      { ...capabilities, objectives: ["pushes"] },
      { ...capabilities, quality: "approximate" },
      ...booleanFlags.map((flag) => {
        const missing = { ...capabilities } as Record<string, unknown>;
        delete missing[flag];
        return missing;
      }),
    ];

    for (const [index, candidate] of invalidCapabilities.entries()) {
      const invalid = {
        ...makeAdapter(`invalid-${index}`),
        metadata: {
          ...makeAdapter(`invalid-${index}`).metadata,
          capabilities: candidate,
        },
      } as unknown as SolverAdapter;
      assert.throws(
        () => new SolverRegistry([invalid]),
        InvalidSolverAdapterError,
      );
    }
  });

  it("isolates an adapter that becomes invalid during discovery", () => {
    const healthy = makeAdapter("healthy");
    const stableMetadata = makeAdapter("unstable").metadata;
    let valid = true;
    const unstable = {
      get metadata() {
        if (valid) return stableMetadata;
        return {
          ...stableMetadata,
          capabilities: {
            ...stableMetadata.capabilities,
            runtime: "native",
          },
        } as unknown as typeof stableMetadata;
      },
      async solve() {
        return {
          status: "unsolved" as const,
          reason: "exhausted" as const,
          metrics: { elapsedMs: 0 },
        };
      },
    } satisfies SolverAdapter;
    const registry = new SolverRegistry([healthy, unstable]);

    valid = false;

    assert.deepEqual(
      registry.listMetadata().map(({ id }) => id),
      ["healthy"],
    );
    assert.equal(registry.size, 2);
  });
});
