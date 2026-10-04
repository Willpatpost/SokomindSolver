import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createSession,
  move,
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
import type { SolverCompatibilityErrorCode } from "../../src/solver/compatibility.ts";
import { SolverCancelledError } from "../../src/solver/cancellation.ts";
import { SOLVER_WORKER_PROTOCOL_VERSION } from "../../src/solver/protocol.ts";
import {
  RemoteSolverError,
  SolverClientDisposedError,
  SolverRunSupersededError,
  SolverWorkerClient,
} from "../../src/solver/worker-client.ts";
import { SolverSolutionVerificationError } from "../../src/solver/verification.ts";
import { SolverWorkerHost } from "../../src/solver/worker-host.ts";
import { SolverRegistry } from "../../src/solver/registry.ts";

type MessageListener = (event: { readonly data: unknown }) => void;

class LinkedTransport {
  peer?: LinkedTransport;
  readonly sent: unknown[] = [];
  readonly #listeners = new Set<MessageListener>();

  postMessage(message: unknown): void {
    this.sent.push(message);
    queueMicrotask(() => {
      const peer = this.peer;
      if (!peer) return;
      for (const listener of peer.#listeners) {
        listener({ data: message });
      }
    });
  }

  addEventListener(_type: "message", listener: MessageListener): void {
    this.#listeners.add(listener);
  }

  removeEventListener(_type: "message", listener: MessageListener): void {
    this.#listeners.delete(listener);
  }

  emit(message: unknown): void {
    for (const listener of this.#listeners) listener({ data: message });
  }
}

function linkedTransports(): [LinkedTransport, LinkedTransport] {
  const main = new LinkedTransport();
  const worker = new LinkedTransport();
  main.peer = worker;
  worker.peer = main;
  return [main, worker];
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
  id: "runtime",
  title: "Runtime",
  difficulty: "tutorial",
  boxes: 1,
  rows: ["OOOOO", "ORXSO", "OOOOO"],
};

function request(): SolverRequest {
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

function adapter(
  solve: SolverAdapter["solve"],
  capabilityOverrides: Partial<SolverCapabilities> = {},
): SolverAdapter {
  return {
    metadata: {
      id: "test-solver",
      displayName: "Test solver",
      description: "Runtime boundary test adapter",
      version: "1.0.0",
      capabilities: { ...capabilities, ...capabilityOverrides },
    },
    solve,
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

function flushMessages(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("solver worker host and client", () => {
  it("discovers adapters, forwards validated progress, and verifies results", async () => {
    const [mainTransport, workerTransport] = linkedTransports();
    const progress: number[] = [];
    const registry = new SolverRegistry([
      adapter(async (_request, context) => {
        context.reportProgress({
          phase: "searching",
          elapsedMs: 2,
          expandedStates: 1,
          fraction: 0.5,
        });
        return solvedResult();
      }),
    ]);
    const host = new SolverWorkerHost(registry, workerTransport);
    host.start();
    const client = new SolverWorkerClient(mainTransport, {
      createJobId: () => "job-success",
    });

    const discovered = await client.discover();
    assert.deepEqual(
      discovered.map(({ id }) => id),
      ["test-solver"],
    );

    const handle = client.run("test-solver", request(), {
      onProgress(update) {
        progress.push(update.fraction ?? 0);
      },
    });
    const result = await handle.result;

    assert.equal(result.status, "solved");
    assert.deepEqual(progress, [0.5]);
    assert.equal(host.activeJobCount, 0);
    assert.equal(client.activeJobId, undefined);
    client.dispose();
    host.dispose();
  });

  it("keeps healthy discovery results when another adapter becomes invalid", async () => {
    const healthy = adapter(async () => solvedResult());
    const healthyAdapter: SolverAdapter = {
      ...healthy,
      metadata: { ...healthy.metadata, id: "healthy-solver" },
    };
    const unstableMetadata = {
      ...healthy.metadata,
      id: "unstable-solver",
    };
    let valid = true;
    const unstableAdapter = {
      get metadata() {
        if (valid) return unstableMetadata;
        return {
          ...unstableMetadata,
          capabilities: {
            ...unstableMetadata.capabilities,
            labeledBoxes: undefined,
          },
        } as unknown as typeof unstableMetadata;
      },
      async solve() {
        return solvedResult();
      },
    } satisfies SolverAdapter;
    const registry = new SolverRegistry([healthyAdapter, unstableAdapter]);
    valid = false;

    const [mainTransport, workerTransport] = linkedTransports();
    const host = new SolverWorkerHost(registry, workerTransport);
    host.start();
    const client = new SolverWorkerClient(mainTransport);

    const discovered = await client.discover();
    assert.deepEqual(
      discovered.map(({ id }) => id),
      ["healthy-solver"],
    );

    client.dispose();
    host.dispose();
  });

  it("cancels and cleans up a pending job while suppressing late results", async () => {
    const pending = deferred<SolverResult>();
    let signal: AbortSignal | undefined;
    const [mainTransport, workerTransport] = linkedTransports();
    const host = new SolverWorkerHost(
      new SolverRegistry([
        adapter(async (_request, context) => {
          signal = context.signal;
          context.reportProgress({
            phase: "searching",
            elapsedMs: 4,
            expandedStates: 12,
            generatedStates: 30,
            frontierSize: 7,
            counters: { duplicateStates: 5 },
          });
          return pending.promise;
        }),
      ]),
      workerTransport,
    );
    host.start();
    const client = new SolverWorkerClient(mainTransport, {
      createJobId: () => "job-cancel",
    });

    const handle = client.run("test-solver", request());
    await flushMessages();
    assert.equal(host.activeJobCount, 1);
    handle.cancel("User cancelled");

    const result = await handle.result;
    assert.equal(result.status, "cancelled");
    assert.equal(result.metrics.expandedStates, 12);
    assert.equal(result.metrics.generatedStates, 30);
    assert.equal(result.metrics.peakFrontierSize, 7);
    assert.equal(result.metrics.counters?.duplicateStates, 5);
    assert.equal(signal?.aborted, true);
    assert.equal(host.activeJobCount, 0);

    pending.resolve(solvedResult());
    await flushMessages();
    assert.equal(client.activeJobId, undefined);
    assert.equal(host.activeJobCount, 0);
    client.dispose();
    host.dispose();
  });

  it("disposes an active client run without leaving worker-side job state", async () => {
    const pending = deferred<SolverResult>();
    let signal: AbortSignal | undefined;
    const [mainTransport, workerTransport] = linkedTransports();
    const host = new SolverWorkerHost(
      new SolverRegistry([
        adapter(async (_request, context) => {
          signal = context.signal;
          return pending.promise;
        }),
      ]),
      workerTransport,
    );
    host.start();
    const client = new SolverWorkerClient(mainTransport, {
      createJobId: () => "job-dispose",
    });

    const run = client.run("test-solver", request());
    await flushMessages();
    client.dispose();

    await assert.rejects(run.result, SolverClientDisposedError);
    await flushMessages();
    assert.equal(signal?.aborted, true);
    assert.equal(host.activeJobCount, 0);
    pending.resolve(solvedResult());
    host.dispose();
  });

  it("supersedes prior runs and ignores their late progress and result", async () => {
    const runs: Array<{
      deferred: ReturnType<typeof deferred<SolverResult>>;
      context: SolverExecutionContext;
    }> = [];
    const [mainTransport, workerTransport] = linkedTransports();
    const host = new SolverWorkerHost(
      new SolverRegistry([
        adapter(async (_request, context) => {
          const completion = deferred<SolverResult>();
          runs.push({ deferred: completion, context });
          return completion.promise;
        }),
      ]),
      workerTransport,
    );
    host.start();
    let nextId = 1;
    const client = new SolverWorkerClient(mainTransport, {
      createJobId: () => `job-${nextId++}`,
    });
    const observed: string[] = [];

    const first = client.run("test-solver", request(), {
      onProgress: () => observed.push("first"),
    });
    const firstRejected = assert.rejects(
      first.result,
      SolverRunSupersededError,
    );
    const second = client.run("test-solver", request(), {
      onProgress: () => observed.push("second"),
    });
    await firstRejected;
    await flushMessages();
    assert.equal(runs.length, 2);
    assert.equal(host.activeJobCount, 1);

    runs[0]?.context.reportProgress({
      phase: "searching",
      elapsedMs: 1,
    });
    runs[1]?.context.reportProgress({
      phase: "searching",
      elapsedMs: 1,
    });
    runs[0]?.deferred.resolve(solvedResult());
    runs[1]?.deferred.resolve(solvedResult());

    assert.equal((await second.result).status, "solved");
    assert.deepEqual(observed, ["second"]);
    assert.equal(host.activeJobCount, 0);
    client.dispose();
    host.dispose();
  });

  it("turns invalid adapter progress and unverifiable solutions into failures", async () => {
    for (const solve of [
      async (_request: SolverRequest, context: SolverExecutionContext) => {
        context.reportProgress({
          phase: "searching",
          elapsedMs: 1,
          fraction: 2,
        });
        return solvedResult();
      },
      async () =>
        ({
          status: "solved",
          solution: {
            steps: [{ direction: "up", kind: "walk" }],
            moves: 1,
            pushes: 0,
            objective: { kind: "moves" },
            objectiveScore: 1,
            optimality: "unknown",
          },
          metrics: { elapsedMs: 1 },
        }) satisfies SolverResult,
    ]) {
      const [mainTransport, workerTransport] = linkedTransports();
      const host = new SolverWorkerHost(
        new SolverRegistry([adapter(solve)]),
        workerTransport,
      );
      host.start();
      const client = new SolverWorkerClient(mainTransport, {
        createJobId: () => "job-invalid",
      });

      const run = client.run("test-solver", request());
      await assert.rejects(run.result, RemoteSolverError);
      assert.equal(host.activeJobCount, 0);
      client.dispose();
      host.dispose();
    }
  });

  it("rejects unsupported request features before invoking the adapter", async () => {
    const labeledPuzzle: PuzzleDefinition = {
      id: "labeled-runtime",
      title: "Labeled runtime",
      difficulty: "tutorial",
      boxes: 1,
      rows: ["OOOOO", "ORAaO", "OOOOO"],
    };
    const labeledSession = createSession(labeledPuzzle);
    const labeledRequest: SolverRequest = {
      board: labeledSession.board,
      snapshot: labeledSession.snapshot,
      objective: { kind: "moves" },
    };
    const initial = createSession(puzzle);
    const partial = move(initial, "right");
    const partialRequest: SolverRequest = {
      board: partial.board,
      snapshot: partial.snapshot,
      objective: { kind: "moves" },
    };
    const cases: ReadonlyArray<{
      request: SolverRequest;
      capabilities: Partial<SolverCapabilities>;
      code: SolverCompatibilityErrorCode;
    }> = [
      {
        request: labeledRequest,
        capabilities: { labeledBoxes: false },
        code: "UNSUPPORTED_LABELED_BOXES",
      },
      {
        request: request(),
        capabilities: { genericBoxes: false },
        code: "UNSUPPORTED_GENERIC_BOXES",
      },
      {
        request: partialRequest,
        capabilities: { partialState: false },
        code: "UNSUPPORTED_PARTIAL_STATE",
      },
    ];

    for (const testCase of cases) {
      let solveCalls = 0;
      const [mainTransport, workerTransport] = linkedTransports();
      const host = new SolverWorkerHost(
        new SolverRegistry([
          adapter(async () => {
            solveCalls += 1;
            return solvedResult();
          }, testCase.capabilities),
        ]),
        workerTransport,
      );
      host.start();
      const client = new SolverWorkerClient(mainTransport, {
        createJobId: () => `job-${testCase.code.toLowerCase()}`,
      });

      const run = client.run("test-solver", testCase.request);
      await assert.rejects(
        run.result,
        (error: unknown) =>
          error instanceof RemoteSolverError &&
          error.name === "SolverCompatibilityError" &&
          error.code === testCase.code,
      );
      assert.equal(solveCalls, 0);
      assert.equal(host.activeJobCount, 0);
      client.dispose();
      host.dispose();
    }
  });
});

/** A worker stand-in that never answers unless the test emits an event. */
class SilentTransport {
  readonly sent: Array<{ readonly type: string }> = [];
  readonly #listeners = new Set<MessageListener>();
  terminated = 0;

  get listenerCount(): number {
    return this.#listeners.size;
  }

  postMessage(message: { readonly type: string }): void {
    this.sent.push(message);
  }

  addEventListener(_type: "message", listener: MessageListener): void {
    this.#listeners.add(listener);
  }

  removeEventListener(_type: "message", listener: MessageListener): void {
    this.#listeners.delete(listener);
  }

  terminate(): void {
    this.terminated += 1;
  }

  emit(message: unknown): void {
    for (const listener of this.#listeners) listener({ data: message });
  }
}

describe("solver worker client cancellation watchdog", () => {
  it("terminates an unresponsive worker and retires the client", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const transport = new SilentTransport();
    let terminatedEvents = 0;
    const client = new SolverWorkerClient(transport, {
      createJobId: () => "job-watchdog",
      cancelWatchdogMs: 1_000,
      onTerminated: () => { terminatedEvents += 1; },
    });

    const run = client.run("test-solver", request());
    const discovery = client.discover();
    const runRejected = assert.rejects(
      run.result,
      (error: unknown) =>
        error instanceof SolverCancelledError && error.message === "User cancelled",
    );
    const discoveryRejected = assert.rejects(discovery, SolverClientDisposedError);
    run.cancel("User cancelled");
    assert.deepEqual(transport.sent.map(({ type }) => type), [
      "solver/run", "solver/discover", "solver/cancel",
    ]);

    t.mock.timers.tick(999);
    assert.equal(transport.terminated, 0);
    assert.equal(terminatedEvents, 0);
    t.mock.timers.tick(1);
    assert.equal(transport.terminated, 1);
    assert.equal(terminatedEvents, 1);
    await runRejected;
    await discoveryRejected;

    // The retired client stops listening and refuses new work instead of
    // posting into the terminated worker and waiting forever.
    assert.equal(transport.listenerCount, 0);
    assert.equal(client.activeJobId, undefined);
    assert.throws(() => client.run("test-solver", request()), SolverClientDisposedError);
    assert.throws(() => client.discover(), SolverClientDisposedError);
    client.cancel("Again");
    client.dispose();
    assert.equal(transport.sent.length, 3);
    assert.equal(transport.terminated, 1);
    assert.equal(terminatedEvents, 1);
  });

  it("restarts the deadline on progress and stands down once the worker answers", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const transport = new SilentTransport();
    let terminatedEvents = 0;
    let nextId = 1;
    const client = new SolverWorkerClient(transport, {
      createJobId: () => `job-${nextId++}`,
      cancelWatchdogMs: 1_000,
      onTerminated: () => { terminatedEvents += 1; },
    });
    const event = (type: "solver/progress" | "solver/result", payload: object) => ({
      protocolVersion: SOLVER_WORKER_PROTOCOL_VERSION, type, jobId: "job-1", ...payload,
    });

    const run = client.run("test-solver", request());
    run.cancel("User cancelled");
    t.mock.timers.tick(900);
    transport.emit(event("solver/progress", {
      progress: { phase: "searching", elapsedMs: 1 },
    }));
    t.mock.timers.tick(900);
    assert.equal(transport.terminated, 0);

    transport.emit(event("solver/result", {
      result: { status: "cancelled", metrics: { elapsedMs: 2 } },
    }));
    assert.equal((await run.result).status, "cancelled");
    t.mock.timers.tick(10_000);
    assert.equal(transport.terminated, 0);
    assert.equal(terminatedEvents, 0);

    // A worker that answered keeps its client.
    const next = client.run("test-solver", request());
    assert.equal(next.jobId, "job-2");
    client.dispose();
    await assert.rejects(next.result, SolverClientDisposedError);
    assert.equal(transport.terminated, 1);
    assert.equal(terminatedEvents, 0);
  });
});

describe("solver worker client stop and keep best", () => {
  type Incumbent = NonNullable<SolverProgress["incumbent"]>;
  // One walk then one push solves it, so routes of several lengths replay.
  const walkPuzzle: PuzzleDefinition = {
    id: "runtime-walk",
    title: "Runtime walk",
    difficulty: "tutorial",
    boxes: 1,
    rows: ["OOOOOO", "OR XSO", "OOOOOO"],
  };
  const walkRequest = (): SolverRequest => {
    const session = createSession(walkPuzzle);
    return { board: session.board, snapshot: session.snapshot, objective: { kind: "moves" } };
  };
  const routed = (route: string): Incumbent => ({
    moves: route.length, pushes: 1, objectiveScore: route.length, route,
  });
  const silentClient = (options: { cancelWatchdogMs?: number; onTerminated?: () => void } = {}) => {
    const transport = new SilentTransport();
    let nextId = 1;
    const client = new SolverWorkerClient(transport, {
      createJobId: () => `job-${nextId++}`,
      cancelWatchdogMs: Number.POSITIVE_INFINITY,
      ...options,
    });
    const emit = (jobId: string, type: "solver/progress" | "solver/result", payload: object) =>
      transport.emit({ protocolVersion: SOLVER_WORKER_PROTOCOL_VERSION, type, jobId, ...payload });
    const progress = (jobId: string, incumbent?: Incumbent, extra: object = {}) =>
      emit(jobId, "solver/progress", {
        progress: { phase: "improving", elapsedMs: 1, ...extra, ...(incumbent ? { incumbent } : {}) },
      });
    const cancelled = (jobId: string, metrics: object = { elapsedMs: 9 }) =>
      emit(jobId, "solver/result", { result: { status: "cancelled", metrics } });
    return { transport, client, emit, progress, cancelled };
  };
  const directions = (result: SolverResult) =>
    result.status === "solved"
      ? result.solution.steps.map(({ direction, kind }) => `${direction}:${kind}`)
      : [];

  it("keeps the fewest-move route, the first on ties, as an unproven solved result", async () => {
    const { transport, client, progress, cancelled } = silentClient();

    const tied = client.run("test-solver", walkRequest());
    progress("job-1", routed("RLRR"));
    progress("job-1", routed("RRLR"));
    // Kernel progress reports counts only; a route-less incumbent is never kept.
    progress("job-1", { moves: 1, pushes: 1, objectiveScore: 1 });
    tied.stop("Keep best");
    assert.deepEqual(transport.sent.at(-1), {
      protocolVersion: SOLVER_WORKER_PROTOCOL_VERSION, type: "solver/cancel", jobId: "job-1", reason: "Keep best",
    });
    cancelled("job-1", { elapsedMs: 9, expandedStates: 5 });
    const kept = await tied.result;
    assert.deepEqual(directions(kept), ["right:walk", "left:walk", "right:walk", "right:push"]);
    assert.ok(kept.status === "solved");
    assert.equal(kept.solution.moves, 4);
    assert.equal(kept.solution.optimality, "unknown");
    assert.equal(kept.proof, undefined);
    assert.deepEqual(kept.metrics, { elapsedMs: 9, expandedStates: 5 });

    const improved = client.run("test-solver", walkRequest());
    progress("job-2", routed("RLRR"));
    progress("job-2", routed("RR"));
    progress("job-2", routed("RRLR"));
    improved.stop();
    cancelled("job-2");
    assert.deepEqual(directions(await improved.result), ["right:walk", "right:push"]);
    client.dispose();
  });

  it("settles as cancelled without a route, after cancel, or after a later cancel", async () => {
    const { client, progress, cancelled } = silentClient();

    const unrouted = client.run("test-solver", walkRequest());
    progress("job-1", { moves: 2, pushes: 1, objectiveScore: 2 });
    unrouted.stop();
    cancelled("job-1");
    assert.equal((await unrouted.result).status, "cancelled");

    const cancelledRun = client.run("test-solver", walkRequest());
    progress("job-2", routed("RR"));
    cancelledRun.cancel();
    cancelled("job-2");
    assert.equal((await cancelledRun.result).status, "cancelled");

    // The latest request wins: cancel after stop discards the route.
    const overridden = client.run("test-solver", walkRequest());
    progress("job-3", routed("RR"));
    overridden.stop();
    overridden.cancel();
    cancelled("job-3");
    assert.equal((await overridden.result).status, "cancelled");
    client.dispose();
  });

  it("returns a solved worker result as sent even after stop", async () => {
    const { client, emit, progress } = silentClient();
    const run = client.run("test-solver", walkRequest());
    progress("job-1", routed("RLRR"));
    run.stop();
    const solution = {
      steps: [{ direction: "right", kind: "walk" }, { direction: "right", kind: "push" }],
      moves: 2, pushes: 1, objective: { kind: "moves" }, objectiveScore: 2, optimality: "unknown",
    };
    emit("job-1", "solver/result", { result: { status: "solved", solution, metrics: { elapsedMs: 3 } } });
    const result = await run.result;
    assert.ok(result.status === "solved");
    assert.equal(result.solution.moves, 2);
    assert.deepEqual(result.metrics, { elapsedMs: 3 });
    client.dispose();
  });

  it("rejects a kept route that does not replay", async () => {
    const { client, progress, cancelled } = silentClient();
    const run = client.run("test-solver", walkRequest());
    progress("job-1", routed("RU"));
    run.stop();
    const rejected = assert.rejects(
      run.result,
      (error: unknown) =>
        error instanceof SolverSolutionVerificationError &&
        error.failure.code === "illegal-step" &&
        error.failure.stepIndex === 1,
    );
    cancelled("job-1");
    await rejected;
    client.dispose();
  });

  it("resolves the kept route when the watchdog retires a stopped worker", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let terminatedEvents = 0;
    const { transport, client, progress } = silentClient({
      cancelWatchdogMs: 1_000,
      onTerminated: () => { terminatedEvents += 1; },
    });
    const run = client.run("test-solver", walkRequest());
    progress("job-1", routed("RR"), { elapsedMs: 7, expandedStates: 3, counters: { lanes: 2 } });
    run.stop();
    t.mock.timers.tick(1_000);

    assert.equal(transport.terminated, 1);
    assert.equal(terminatedEvents, 1);
    const result = await run.result;
    assert.deepEqual(directions(result), ["right:walk", "right:push"]);
    assert.deepEqual(result.metrics, { elapsedMs: 7, expandedStates: 3, counters: { lanes: 2 } });
    assert.throws(() => client.run("test-solver", walkRequest()), SolverClientDisposedError);
  });

  it("keeps a host-verified route end to end and aborts the adapter", async () => {
    const pending = deferred<SolverResult>();
    let signal: AbortSignal | undefined;
    const [mainTransport, workerTransport] = linkedTransports();
    const host = new SolverWorkerHost(
      new SolverRegistry([
        adapter(async (_request, context) => {
          signal = context.signal;
          context.reportProgress({ phase: "improving", elapsedMs: 2, incumbent: routed("RLRR") });
          return pending.promise;
        }),
      ]),
      workerTransport,
    );
    host.start();
    const client = new SolverWorkerClient(mainTransport, { createJobId: () => "job-stop" });

    const handle = client.run("test-solver", walkRequest());
    await flushMessages();
    handle.stop();
    const result = await handle.result;
    assert.deepEqual(directions(result), ["right:walk", "left:walk", "right:walk", "right:push"]);
    assert.equal(signal?.aborted, true);
    assert.equal(host.activeJobCount, 0);

    pending.resolve(solvedResult());
    await flushMessages();
    client.dispose();
    host.dispose();
  });
});
