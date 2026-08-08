import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createSession,
  type PuzzleDefinition,
} from "../../src/core/index.ts";
import type {
  SolverAdapter,
  SolverCapabilities,
  SolverExecutionContext,
  SolverProgress,
  SolverRequest,
  SolverResult,
} from "../../src/solver/contracts.ts";
import { SOLVER_WORKER_PROTOCOL_VERSION } from "../../src/solver/protocol.ts";
import type {
  SolverWorkerEvent,
  SolverWorkerCommand,
} from "../../src/solver/protocol.ts";
import {
  SolverWorkerHost,
  type SolverMessageListener,
  type SolverWorkerHostTransport,
} from "../../src/solver/worker-host.ts";
import { SolverRegistry } from "../../src/solver/registry.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type PostedEvent = SolverWorkerEvent;

class MockTransport implements SolverWorkerHostTransport {
  readonly posted: PostedEvent[] = [];
  readonly #listeners = new Set<SolverMessageListener>();

  postMessage(message: SolverWorkerEvent): void {
    this.posted.push(message);
  }

  addEventListener(_type: "message", listener: SolverMessageListener): void {
    this.#listeners.add(listener);
  }

  removeEventListener(_type: "message", listener: SolverMessageListener): void {
    this.#listeners.delete(listener);
  }

  emit(data: unknown): void {
    for (const listener of this.#listeners) {
      listener({ data });
    }
  }
}

const capabilities = Object.freeze({
  executionTargets: ["web-worker"] as const,
  runtime: "javascript",
  objectives: ["moves"] as const,
  quality: "first-found",
  labeledBoxes: true,
  genericBoxes: true,
  partialState: true,
  reportsProgress: true,
  cooperativeCancellation: true,
  deterministic: true,
}) satisfies SolverCapabilities;

const puzzle: PuzzleDefinition = {
  id: "wh-test",
  title: "Worker Host Test",
  difficulty: "tutorial",
  boxes: 1,
  rows: ["OOOOO", "ORXSO", "OOOOO"],
};

function makeRequest(): SolverRequest {
  const session = createSession(puzzle);
  return {
    board: session.board,
    snapshot: session.snapshot,
    objective: { kind: "moves" },
  };
}

function solvedResult(): SolverResult {
  return {
    status: "solved",
    solution: {
      steps: [{ direction: "right", kind: "push" }],
      moves: 1,
      pushes: 1,
      objective: { kind: "moves" },
      objectiveScore: 1,
      optimality: "unknown",
    },
    metrics: { elapsedMs: 4, expandedStates: 2 },
  };
}

function testAdapter(
  solve: SolverAdapter["solve"],
  overrides: Partial<SolverCapabilities> = {},
): SolverAdapter {
  return {
    metadata: {
      id: "test-solver",
      displayName: "Test solver",
      description: "Test",
      version: "1.0.0",
      capabilities: { ...capabilities, ...overrides },
    },
    solve,
  };
}

function runCommand(
  jobId = "job-1",
  solverId = "test-solver",
): SolverWorkerCommand {
  return {
    protocolVersion: SOLVER_WORKER_PROTOCOL_VERSION,
    type: "solver/run",
    jobId,
    solverId,
    request: makeRequest(),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SolverWorkerHost - uncovered paths", () => {
  // Lines 104-108: start() after dispose throws SolverWorkerRuntimeError
  it("throws when start() is called on a disposed host", () => {
    const transport = new MockTransport();
    const registry = new SolverRegistry([
      testAdapter(async () => solvedResult()),
    ]);
    const host = new SolverWorkerHost(registry, transport);
    host.dispose();

    assert.throws(
      () => host.start(),
      (error: unknown) =>
        error instanceof Error &&
        error.name === "SolverWorkerRuntimeError" &&
        /disposed/.test(error.message),
    );
  });

  // Lines 120-128 + 56-63 + 65-69: handleMessage with invalid command
  it("emits a failure event for an invalid protocol command", () => {
    const transport = new MockTransport();
    const registry = new SolverRegistry([
      testAdapter(async () => solvedResult()),
    ]);
    const host = new SolverWorkerHost(registry, transport);

    // Non-command value with no jobId
    host.handleMessage("not a command");

    assert.equal(transport.posted.length, 1);
    const event = transport.posted[0]!;
    assert.equal(event.type, "solver/failure");
    if (event.type === "solver/failure") {
      assert.equal("jobId" in event, false);
      assert.equal(event.error.name, "SolverWorkerRuntimeError");
    }

    host.dispose();
  });

  // Lines 65-69: inferJobId extracts jobId from partial objects
  it("emits failure with extracted jobId from malformed command", () => {
    const transport = new MockTransport();
    const registry = new SolverRegistry([
      testAdapter(async () => solvedResult()),
    ]);
    const host = new SolverWorkerHost(registry, transport);

    // Object with a valid jobId but not a valid command
    host.handleMessage({ jobId: "partial-job", bogus: true });

    assert.equal(transport.posted.length, 1);
    const event = transport.posted[0]!;
    assert.equal(event.type, "solver/failure");
    if (event.type === "solver/failure") {
      assert.equal(event.jobId, "partial-job");
    }

    host.dispose();
  });

  // Lines 65-69: inferJobId returns undefined for various shapes
  it("emits failure without jobId when jobId is empty or non-string", () => {
    const transport = new MockTransport();
    const registry = new SolverRegistry([
      testAdapter(async () => solvedResult()),
    ]);
    const host = new SolverWorkerHost(registry, transport);

    // Empty-string jobId
    host.handleMessage({ jobId: "   ", type: "invalid" });
    assert.equal(transport.posted.length, 1);
    if (transport.posted[0]!.type === "solver/failure") {
      assert.equal("jobId" in transport.posted[0]!, false);
    }

    // Number jobId
    host.handleMessage({ jobId: 42 });
    assert.equal(transport.posted.length, 2);
    if (transport.posted[1]!.type === "solver/failure") {
      assert.equal("jobId" in transport.posted[1]!, false);
    }

    // null value
    host.handleMessage(null);
    assert.equal(transport.posted.length, 3);
    if (transport.posted[2]!.type === "solver/failure") {
      assert.equal("jobId" in transport.posted[2]!, false);
    }

    host.dispose();
  });

  // Line 118: handleMessage when disposed is a no-op
  it("ignores messages after dispose", () => {
    const transport = new MockTransport();
    const registry = new SolverRegistry([
      testAdapter(async () => solvedResult()),
    ]);
    const host = new SolverWorkerHost(registry, transport);
    host.dispose();

    host.handleMessage("anything");
    assert.equal(transport.posted.length, 0);
  });

  // Lines 151-153: dispose cancels active runs
  it("dispose cancels all active runs and clears them", async () => {
    const pending = deferred<SolverResult>();
    let signal: AbortSignal | undefined;
    const transport = new MockTransport();
    const registry = new SolverRegistry([
      testAdapter(async (_req, ctx) => {
        signal = ctx.signal;
        return pending.promise;
      }),
    ]);
    const host = new SolverWorkerHost(registry, transport);
    host.start();

    transport.emit(runCommand("active-job"));
    await flushMicrotasks();
    assert.equal(host.activeJobCount, 1);

    host.dispose("test dispose reason");
    assert.equal(host.activeJobCount, 0);
    assert.equal(signal?.aborted, true);

    pending.resolve(solvedResult());
  });

  // Lines 179-180: discover error path
  it("emits failure when discover throws", () => {
    const transport = new MockTransport();
    // Create a registry that will throw on listMetadata
    const registry = new SolverRegistry();
    // Override listMetadata to throw
    Object.defineProperty(registry, "listMetadata", {
      value: () => {
        throw new Error("registry boom");
      },
    });
    const host = new SolverWorkerHost(registry, transport);

    host.handleMessage({
      protocolVersion: SOLVER_WORKER_PROTOCOL_VERSION,
      type: "solver/discover",
    });

    assert.equal(transport.posted.length, 1);
    const event = transport.posted[0]!;
    assert.equal(event.type, "solver/failure");
    if (event.type === "solver/failure") {
      assert.match(event.error.message, /registry boom/);
    }

    host.dispose();
  });

  // Lines 203-211: duplicate job ID
  it("emits failure for a duplicate job ID", async () => {
    const pending = deferred<SolverResult>();
    const transport = new MockTransport();
    const registry = new SolverRegistry([
      testAdapter(async () => pending.promise),
    ]);
    const host = new SolverWorkerHost(registry, transport);
    host.start();

    transport.emit(runCommand("dup-job"));
    await flushMicrotasks();
    assert.equal(host.activeJobCount, 1);

    // Send same job ID again
    transport.emit(runCommand("dup-job"));
    await flushMicrotasks();

    const failures = transport.posted.filter((e) => e.type === "solver/failure");
    assert.equal(failures.length, 1);
    const failure = failures[0]!;
    if (failure.type === "solver/failure") {
      assert.equal(failure.jobId, "dup-job");
      assert.match(failure.error.message, /already running/);
    }

    host.dispose();
    pending.resolve(solvedResult());
  });

  // Lines 248-258: lowerBound monotonicity violation
  it("cancels job when progress lowerBound decreases", async () => {
    const pending = deferred<SolverResult>();
    let reportProgress: ((p: SolverProgress) => void) | undefined;
    const transport = new MockTransport();
    const registry = new SolverRegistry([
      testAdapter(async (_req, ctx) => {
        reportProgress = ctx.reportProgress;
        return pending.promise;
      }),
    ]);
    const host = new SolverWorkerHost(registry, transport);
    host.start();

    transport.emit(runCommand("lb-job"));
    await flushMicrotasks();
    assert.ok(reportProgress);

    // First progress with lowerBound=10
    reportProgress!({
      phase: "searching",
      elapsedMs: 1,
      lowerBound: 10,
    });

    // Second progress with lowerBound=5 -- should throw
    assert.throws(
      () =>
        reportProgress!({
          phase: "searching",
          elapsedMs: 2,
          lowerBound: 5,
        }),
      (error: unknown) =>
        error instanceof Error && error.name === "SolverWorkerRuntimeError",
    );

    pending.resolve(solvedResult());
    await flushMicrotasks();
    host.dispose();
  });

  // Lines 259-268: upperBound monotonicity violation
  it("cancels job when progress upperBound increases", async () => {
    const pending = deferred<SolverResult>();
    let reportProgress: ((p: SolverProgress) => void) | undefined;
    const transport = new MockTransport();
    const registry = new SolverRegistry([
      testAdapter(async (_req, ctx) => {
        reportProgress = ctx.reportProgress;
        return pending.promise;
      }),
    ]);
    const host = new SolverWorkerHost(registry, transport);
    host.start();

    transport.emit(runCommand("ub-job"));
    await flushMicrotasks();
    assert.ok(reportProgress);

    reportProgress!({
      phase: "searching",
      elapsedMs: 1,
      upperBound: 20,
    });

    assert.throws(
      () =>
        reportProgress!({
          phase: "searching",
          elapsedMs: 2,
          upperBound: 25,
        }),
      (error: unknown) =>
        error instanceof Error && error.name === "SolverWorkerRuntimeError",
    );

    pending.resolve(solvedResult());
    await flushMicrotasks();
    host.dispose();
  });

  // Lines 269-279: gap monotonicity violation
  it("cancels job when progress gap increases", async () => {
    const pending = deferred<SolverResult>();
    let reportProgress: ((p: SolverProgress) => void) | undefined;
    const transport = new MockTransport();
    const registry = new SolverRegistry([
      testAdapter(async (_req, ctx) => {
        reportProgress = ctx.reportProgress;
        return pending.promise;
      }),
    ]);
    const host = new SolverWorkerHost(registry, transport);
    host.start();

    transport.emit(runCommand("gap-job"));
    await flushMicrotasks();
    assert.ok(reportProgress);

    reportProgress!({
      phase: "searching",
      elapsedMs: 1,
      gap: 0.5,
    });

    assert.throws(
      () =>
        reportProgress!({
          phase: "searching",
          elapsedMs: 2,
          gap: 0.8,
        }),
      (error: unknown) =>
        error instanceof Error && error.name === "SolverWorkerRuntimeError",
    );

    pending.resolve(solvedResult());
    await flushMicrotasks();
    host.dispose();
  });

  // Lines 306-309: adapter resolve after signal is aborted -> cancelled result
  it("produces cancelled result when signal aborts before adapter resolves", async () => {
    const pending = deferred<SolverResult>();
    let cancellation: SolverExecutionContext | undefined;
    const transport = new MockTransport();
    const registry = new SolverRegistry([
      testAdapter(async (_req, ctx) => {
        cancellation = ctx;
        // Report some progress, then wait
        ctx.reportProgress({
          phase: "searching",
          elapsedMs: 1,
          expandedStates: 5,
        });
        return pending.promise;
      }),
    ]);
    const host = new SolverWorkerHost(registry, transport);
    host.start();

    transport.emit(runCommand("abort-before-result"));
    await flushMicrotasks();
    assert.ok(cancellation);

    // Cancel the run via the protocol
    host.handleMessage({
      protocolVersion: SOLVER_WORKER_PROTOCOL_VERSION,
      type: "solver/cancel",
      jobId: "abort-before-result",
    });

    // Now the pending adapter resolves with a result, but signal is aborted
    // The host should already have emitted a cancelled result from #cancel
    const resultEvents = transport.posted.filter(
      (e) => e.type === "solver/result",
    );
    assert.ok(resultEvents.length >= 1);
    const firstResult = resultEvents[0]!;
    if (firstResult.type === "solver/result") {
      assert.equal(firstResult.result.status, "cancelled");
    }

    pending.resolve(solvedResult());
    await flushMicrotasks();
    host.dispose();
  });

  // Line 325: solver that throws a cancellation error
  it("produces cancelled result when solver throws after being cancelled", async () => {
    const transport = new MockTransport();
    const registry = new SolverRegistry([
      testAdapter(async (_req, ctx) => {
        // Simulate solver checking signal and throwing
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        throw error;
      }),
    ]);
    const host = new SolverWorkerHost(registry, transport);
    host.start();

    transport.emit(runCommand("cancel-throw-job"));
    await flushMicrotasks();

    const resultEvents = transport.posted.filter(
      (e) => e.type === "solver/result",
    );
    assert.ok(resultEvents.length >= 1);
    const result = resultEvents[0]!;
    if (result.type === "solver/result") {
      assert.equal(result.result.status, "cancelled");
    }

    host.dispose();
  });

  // Lines 351-355: #finishCancelled is also exercised by cancel command
  // but let's ensure that the metrics include fields from last progress
  it("includes progress metrics in cancelled result from cancel command", async () => {
    const pending = deferred<SolverResult>();
    let clock = 0;
    const transport = new MockTransport();
    const registry = new SolverRegistry([
      testAdapter(async (_req, ctx) => {
        ctx.reportProgress({
          phase: "searching",
          elapsedMs: 10,
          expandedStates: 100,
          generatedStates: 200,
          frontierSize: 50,
          counters: { deadlocks: 3 },
        });
        return pending.promise;
      }),
    ]);
    const host = new SolverWorkerHost(registry, transport, {
      now: () => clock++,
    });
    host.start();

    transport.emit(runCommand("metrics-cancel"));
    await flushMicrotasks();

    host.handleMessage({
      protocolVersion: SOLVER_WORKER_PROTOCOL_VERSION,
      type: "solver/cancel",
      jobId: "metrics-cancel",
    });

    const resultEvents = transport.posted.filter(
      (e) => e.type === "solver/result",
    );
    assert.ok(resultEvents.length >= 1);
    const result = resultEvents[0]!;
    if (result.type === "solver/result") {
      assert.equal(result.result.status, "cancelled");
      assert.equal(result.result.metrics.expandedStates, 100);
      assert.equal(result.result.metrics.generatedStates, 200);
      assert.equal(result.result.metrics.peakFrontierSize, 50);
      assert.deepEqual(result.result.metrics.counters, { deadlocks: 3 });
    }

    pending.resolve(solvedResult());
    await flushMicrotasks();
    host.dispose();
  });

  // Cancel when no job is running -- should be a no-op
  it("ignores cancel for an unknown job ID", () => {
    const transport = new MockTransport();
    const registry = new SolverRegistry([
      testAdapter(async () => solvedResult()),
    ]);
    const host = new SolverWorkerHost(registry, transport);
    host.start();

    host.handleMessage({
      protocolVersion: SOLVER_WORKER_PROTOCOL_VERSION,
      type: "solver/cancel",
      jobId: "nonexistent",
    });

    // No failure or result events should be posted
    assert.equal(transport.posted.length, 0);
    host.dispose();
  });

  // Discover command -- lines 170-181
  it("handles discover command and returns solver metadata", () => {
    const transport = new MockTransport();
    const registry = new SolverRegistry([
      testAdapter(async () => solvedResult()),
    ]);
    const host = new SolverWorkerHost(registry, transport);

    host.handleMessage({
      protocolVersion: SOLVER_WORKER_PROTOCOL_VERSION,
      type: "solver/discover",
    });

    assert.equal(transport.posted.length, 1);
    const event = transport.posted[0]!;
    assert.equal(event.type, "solver/ready");
    if (event.type === "solver/ready") {
      assert.equal(event.solvers.length, 1);
      assert.equal(event.solvers[0]!.id, "test-solver");
    }

    host.dispose();
  });

  // Solver that throws a non-cancellation error
  it("emits failure when solver throws a runtime error", async () => {
    const transport = new MockTransport();
    const registry = new SolverRegistry([
      testAdapter(async () => {
        throw new Error("solver exploded");
      }),
    ]);
    const host = new SolverWorkerHost(registry, transport);
    host.start();

    transport.emit(runCommand("error-job"));
    await flushMicrotasks();

    const failures = transport.posted.filter((e) => e.type === "solver/failure");
    assert.equal(failures.length, 1);
    if (failures[0]!.type === "solver/failure") {
      assert.match(failures[0]!.error.message, /solver exploded/);
      assert.equal(failures[0]!.jobId, "error-job");
    }

    host.dispose();
  });

  // start() is idempotent (line 109)
  it("start() is idempotent", () => {
    const transport = new MockTransport();
    const registry = new SolverRegistry([
      testAdapter(async () => solvedResult()),
    ]);
    const host = new SolverWorkerHost(registry, transport);
    host.start();
    host.start(); // second call should be fine

    host.dispose();
  });

  // dispose() is idempotent (line 144)
  it("dispose() is idempotent", () => {
    const transport = new MockTransport();
    const registry = new SolverRegistry([
      testAdapter(async () => solvedResult()),
    ]);
    const host = new SolverWorkerHost(registry, transport);
    host.start();
    host.dispose();
    host.dispose(); // second call should be fine
  });

  // Monotonicity: valid non-decreasing lowerBound is fine
  it("allows valid monotonic progress updates", async () => {
    let reportProgress: ((p: SolverProgress) => void) | undefined;
    const transport = new MockTransport();
    const registry = new SolverRegistry([
      testAdapter(async (_req, ctx) => {
        reportProgress = ctx.reportProgress;
        ctx.reportProgress({
          phase: "searching",
          elapsedMs: 1,
          lowerBound: 5,
          upperBound: 20,
          gap: 0.75,
        });
        ctx.reportProgress({
          phase: "searching",
          elapsedMs: 2,
          lowerBound: 10,
          upperBound: 15,
          gap: 0.33,
        });
        return solvedResult();
      }),
    ]);
    const host = new SolverWorkerHost(registry, transport);
    host.start();

    transport.emit(runCommand("mono-ok"));
    await flushMicrotasks();

    const progressEvents = transport.posted.filter(
      (e) => e.type === "solver/progress",
    );
    assert.equal(progressEvents.length, 2);

    host.dispose();
  });

  // Invalid solver result (invalid status field)
  it("emits failure when solver returns invalid result structure", async () => {
    const transport = new MockTransport();
    const registry = new SolverRegistry([
      testAdapter(async () => {
        return { status: "bogus", metrics: { elapsedMs: 0 } } as unknown as SolverResult;
      }),
    ]);
    const host = new SolverWorkerHost(registry, transport);
    host.start();

    transport.emit(runCommand("invalid-result"));
    await flushMicrotasks();

    const failures = transport.posted.filter((e) => e.type === "solver/failure");
    assert.ok(failures.length >= 1);

    host.dispose();
  });

  // Progress that fails assertValidSolverProgress (e.g. fraction > 1 is caught by validation)
  it("emits failure when progress has invalid fraction", async () => {
    const transport = new MockTransport();
    const registry = new SolverRegistry([
      testAdapter(async (_req, ctx) => {
        ctx.reportProgress({
          phase: "searching",
          elapsedMs: 1,
          fraction: 2, // invalid: must not exceed 1
        });
        return solvedResult();
      }),
    ]);
    const host = new SolverWorkerHost(registry, transport);
    host.start();

    transport.emit(runCommand("bad-fraction"));
    await flushMicrotasks();

    const failures = transport.posted.filter((e) => e.type === "solver/failure");
    assert.ok(failures.length >= 1);

    host.dispose();
  });

  // dispose without start (lines 146-148 -- removeEventListener branch)
  it("dispose works when start was never called", () => {
    const transport = new MockTransport();
    const registry = new SolverRegistry([
      testAdapter(async () => solvedResult()),
    ]);
    const host = new SolverWorkerHost(registry, transport);
    // Never start; dispose should not call removeEventListener
    host.dispose();
    // No error means it works
  });
});
