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
  SolverRequest,
  SolverResult,
} from "../../src/solver/contracts.ts";
import type { SolverCompatibilityErrorCode } from "../../src/solver/compatibility.ts";
import {
  RemoteSolverError,
  SolverClientDisposedError,
  SolverRunSupersededError,
  SolverWorkerClient,
} from "../../src/solver/worker-client.ts";
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
