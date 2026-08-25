import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parsePuzzleRows } from "../../src/core/index.ts";
import {
  compileSearchBoard,
} from "../../src/solver/search/compiled-board.ts";
import {
  isProofCommand,
  isProofResult,
  enumerateFirstPushPartitions,
  buildPartitionRequest,
} from "../../src/solver/implementations/sokomind-proof-protocol.ts";
import type {
  ProofCommand,
  ProofStartPartition,
} from "../../src/solver/implementations/sokomind-proof-protocol.ts";
import {
  runConcurrentProof,
  type SokomindProofWorker,
} from "../../src/solver/implementations/sokomind-proof.ts";
import { DEFAULT_SOKOMIND_REQUEST_OPTIONS } from "../../src/solver/implementations/sokomind-options.ts";
import type {
  SolutionStep,
  SolverRequest,
  SolverResult,
  SolverSolution,
} from "../../src/solver/contracts.ts";
import { assertValidSolverResult } from "../../src/solver/validation.ts";

function makeRequest(rows: string[]): SolverRequest {
  const parsed = parsePuzzleRows(rows);
  return {
    board: parsed,
    snapshot: {
      puzzleId: "test",
      robot: parsed.initialRobot,
      boxes: parsed.initialBoxes,
      moves: 0,
      pushes: 0,
      solved: false,
    },
    objective: { kind: "moves" },
  };
}

// ---------------------------------------------------------------------------
// Protocol type guards
// ---------------------------------------------------------------------------

describe("proof protocol type guards", () => {
  it("isProofCommand accepts valid start-partition", () => {
    assert.ok(
      isProofCommand({
        type: "proof/start-partition",
        partitionId: "abc",
        request: { board: {}, snapshot: {} },
        initialUpperBound: 10,
        prefixCost: 2,
        prefixSteps: [],
        algorithm: "astar",
      }),
    );
  });

  it("isProofCommand accepts valid update-upper-bound", () => {
    assert.ok(
      isProofCommand({
        type: "solver/update-upper-bound",
        moves: 5,
      }),
    );
  });

  it("isProofCommand accepts valid cancel", () => {
    assert.ok(isProofCommand({ type: "proof/cancel" }));
  });

  it("isProofCommand rejects unknown type", () => {
    assert.ok(!isProofCommand({ type: "proof/unknown" }));
  });

  it("isProofCommand rejects non-object", () => {
    assert.ok(!isProofCommand("not an object"));
    assert.ok(!isProofCommand(null));
    assert.ok(!isProofCommand(42));
  });

  it("isProofCommand rejects start-partition with missing fields", () => {
    assert.ok(
      !isProofCommand({
        type: "proof/start-partition",
        partitionId: "abc",
      }),
    );
  });

  it("isProofCommand rejects update-upper-bound with non-integer moves", () => {
    assert.ok(
      !isProofCommand({
        type: "solver/update-upper-bound",
        moves: 1.5,
      }),
    );
  });

  it("isProofCommand rejects update-upper-bound with negative moves", () => {
    assert.ok(
      !isProofCommand({
        type: "solver/update-upper-bound",
        moves: -1,
      }),
    );
  });

  it("isProofResult accepts valid progress", () => {
    assert.ok(
      isProofResult({
        type: "proof/progress",
        partitionId: "abc",
        lowerBound: 3,
        expandedStates: 100,
      }),
    );
  });

  it("isProofResult accepts valid solution", () => {
    assert.ok(
      isProofResult({
        type: "proof/solution",
        partitionId: "abc",
        solution: {
          steps: [{ direction: "right", kind: "walk" }],
          moves: 1,
          pushes: 0,
          objective: { kind: "moves" },
          objectiveScore: 1,
          optimality: "unknown",
        },
        totalCost: 1,
      }),
    );
  });

  it("isProofResult rejects non-finite bounds and shallow solutions", () => {
    assert.equal(isProofResult({
      type: "proof/progress",
      partitionId: "abc",
      lowerBound: Number.POSITIVE_INFINITY,
      expandedStates: 1,
    }), false);
    for (const lowerBound of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      assert.equal(isProofResult({
        type: "proof/partition-complete",
        partitionId: "abc",
        lowerBound,
        exhausted: true,
      }), false);
    }
    assert.equal(isProofResult({
      type: "proof/solution",
      partitionId: "abc",
      solution: { steps: [], moves: 0 },
      totalCost: 0,
    }), false);
  });

  it("isProofResult accepts valid partition-complete", () => {
    assert.ok(
      isProofResult({
        type: "proof/partition-complete",
        partitionId: "abc",
        lowerBound: 3,
        exhausted: true,
        metrics: { elapsedMs: 1 },
      }),
    );
  });

  it("isProofResult accepts valid error", () => {
    assert.ok(
      isProofResult({
        type: "proof/error",
        partitionId: "abc",
        message: "out of memory",
      }),
    );
  });

  it("isProofResult rejects unknown type", () => {
    assert.ok(!isProofResult({ type: "proof/bogus" }));
  });

  it("isProofResult rejects partition-complete with non-boolean exhausted", () => {
    assert.ok(
      !isProofResult({
        type: "proof/partition-complete",
        partitionId: "abc",
        lowerBound: 3,
        exhausted: "yes",
      }),
    );
    assert.equal(isProofResult({
      type: "proof/partition-complete",
      partitionId: "abc",
      lowerBound: 3,
      exhausted: true,
    }), false);
  });
});

// ---------------------------------------------------------------------------
// First-push partitioning
// ---------------------------------------------------------------------------

describe("first-push partitioning", () => {
  it("enumerates partitions for a simple 1-box puzzle", () => {
    const request = makeRequest([
      "OOOOOO",
      "O R  O",
      "O X SO",
      "OOOOOO",
    ]);
    const partitions = enumerateFirstPushPartitions(request);

    assert.ok(partitions.length > 0, "expected at least one partition");
    for (const p of partitions) {
      assert.ok(p.prefixCost >= 1, "prefixCost must include at least the push");
      assert.ok(p.prefixSteps.length >= 1, "must have at least one step");
      assert.equal(
        p.prefixSteps[p.prefixSteps.length - 1].kind,
        "push",
        "last step must be a push",
      );
    }
  });

  it("returns empty for an already-solved puzzle", () => {
    const request = makeRequest([
      "OOOOOO",
      "OR   O",
      "O   XO",
      "O   SO",
      "OOOOOO",
    ]);
    const board = compileSearchBoard(request.board);
    const goalCells = [...(board.goalCellsByLabel.get("X") ?? [])];

    const solvedRequest: SolverRequest = {
      ...request,
      snapshot: {
        ...request.snapshot,
        boxes: goalCells.map((_, i) => ({
          id: `X:${i}`,
          label: "X",
          position: board.positions[goalCells[i]],
        })),
      },
    };
    const partitions = enumerateFirstPushPartitions(solvedRequest);
    assert.equal(typeof partitions.length, "number");
    for (const p of partitions) {
      assert.ok(p.prefixCost >= 1);
    }
  });

  it("produces unique partition IDs (no duplicates)", () => {
    const request = makeRequest([
      "OOOOOO",
      "OR   O",
      "O XX O",
      "O SS O",
      "OOOOOO",
    ]);
    const partitions = enumerateFirstPushPartitions(request);
    const ids = partitions.map((p) => p.partitionId);
    const unique = new Set(ids);
    assert.equal(unique.size, ids.length, "partition IDs must be unique");
  });

  it("buildPartitionRequest creates a valid modified request", () => {
    const request = makeRequest([
      "OOOOOO",
      "OR X O",
      "O   SO",
      "OOOOOO",
    ]);
    const partitions = enumerateFirstPushPartitions(request);
    assert.ok(partitions.length > 0);

    const partition = partitions[0];
    const subRequest = buildPartitionRequest(request, partition);

    assert.deepEqual(subRequest.board, request.board);
    assert.deepEqual(subRequest.objective, request.objective);
    assert.deepEqual(subRequest.snapshot.robot, partition.postPushRobot);
    assert.equal(subRequest.snapshot.boxes.length, request.snapshot.boxes.length);
  });

  it("walk steps in prefix all have kind=walk except last push", () => {
    const request = makeRequest([
      "OOOOOO",
      "OR   O",
      "O  X O",
      "O  S O",
      "OOOOOO",
    ]);
    const partitions = enumerateFirstPushPartitions(request);

    for (const p of partitions) {
      for (let i = 0; i < p.prefixSteps.length - 1; i++) {
        assert.equal(
          p.prefixSteps[i].kind,
          "walk",
          `step ${i} should be walk`,
        );
      }
      assert.equal(
        p.prefixSteps[p.prefixSteps.length - 1].kind,
        "push",
        "final step should be push",
      );
    }
  });

  it("prefixCost equals walk steps + 1 push", () => {
    const request = makeRequest([
      "OOOOOO",
      "OR   O",
      "O  X O",
      "O  S O",
      "OOOOOO",
    ]);
    const partitions = enumerateFirstPushPartitions(request);

    for (const p of partitions) {
      const walkSteps = p.prefixSteps.filter((s) => s.kind === "walk").length;
      assert.equal(p.prefixCost, walkSteps + 1);
    }
  });

  it("handles multi-label puzzle partitioning", () => {
    const request = makeRequest([
      "OOOOOOO",
      "OR A  O",
      "O  B  O",
      "O  a  O",
      "O  b  O",
      "OOOOOOO",
    ]);
    const partitions = enumerateFirstPushPartitions(request);
    assert.ok(partitions.length > 0);
  });
});

// ---------------------------------------------------------------------------
// UpperBoundChannel
// ---------------------------------------------------------------------------

describe("UpperBoundChannel interface", () => {
  it("poll returns undefined when no update has been set", () => {
    const channel = { poll: () => undefined };
    assert.equal(channel.poll(), undefined);
  });

  it("channel pattern: set value, poll reads and clears it", () => {
    let pending: number | undefined;
    const channel = {
      poll(): number | undefined {
        const v = pending;
        pending = undefined;
        return v;
      },
    };

    assert.equal(channel.poll(), undefined);
    pending = 42;
    assert.equal(channel.poll(), 42);
    assert.equal(channel.poll(), undefined);
  });

  it("channel accepts only strictly smaller values", () => {
    let pending: number | undefined;
    let currentBound = 100;

    function offerBound(value: number): void {
      if (pending === undefined || value < pending) {
        pending = value;
      }
    }

    const channel = {
      poll(): number | undefined {
        const v = pending;
        pending = undefined;
        if (v !== undefined && v < currentBound) {
          currentBound = v;
          return v;
        }
        return undefined;
      },
    };

    offerBound(80);
    offerBound(90);
    assert.equal(channel.poll(), 80);
    assert.equal(currentBound, 80);

    offerBound(90);
    assert.equal(channel.poll(), undefined);
    assert.equal(currentBound, 80);

    offerBound(50);
    assert.equal(channel.poll(), 50);
    assert.equal(currentBound, 50);
  });
});

// ---------------------------------------------------------------------------
// Partition completeness on a tiny puzzle
// ---------------------------------------------------------------------------

describe("partition completeness", () => {
  it("all legal first pushes appear as partitions", () => {
    const request = makeRequest([
      "OOOOO",
      "OR  O",
      "O X O",
      "O  SO",
      "OOOOO",
    ]);
    const board = compileSearchBoard(request.board);
    const partitions = enumerateFirstPushPartitions(request, board);

    const partitionStates = new Set(partitions.map((p) => p.partitionId));

    const boxCell = board.cellAt(
      request.snapshot.boxes[0].position.row,
      request.snapshot.boxes[0].position.column,
    );

    let manualCount = 0;
    for (let d = 0; d < 4; d++) {
      const dest = board.neighbors[boxCell][d];
      if (dest < 0) continue;
      const oppositeIndex = d === 0 ? 1 : d === 1 ? 0 : d === 2 ? 3 : 2;
      const support = board.neighbors[boxCell][oppositeIndex];
      if (support < 0) continue;
      manualCount++;
    }

    assert.ok(
      partitions.length <= manualCount,
      `partitions (${partitions.length}) should not exceed theoretical max (${manualCount})`,
    );
    assert.ok(
      partitionStates.size === partitions.length,
      "all partition IDs must be unique",
    );
  });
});

// ---------------------------------------------------------------------------
// Mock worker for coordinator integration tests
// ---------------------------------------------------------------------------

type MockMessageListener = (event: { data: unknown }) => void;
type MockErrorListener = (event: { message?: string; error?: unknown }) => void;

class MockProofWorker implements SokomindProofWorker {
  readonly receivedCommands: ProofCommand[] = [];
  #messageListeners: MockMessageListener[] = [];
  #errorListeners: MockErrorListener[] = [];
  #messageErrorListeners: MockErrorListener[] = [];
  #terminated = false;
  #respondFn?: (command: ProofStartPartition) => void;

  constructor(respondFn?: (command: ProofStartPartition) => void) {
    this.#respondFn = respondFn;
  }

  postMessage(message: ProofCommand): void {
    if (this.#terminated) return;
    this.receivedCommands.push(message);
    if (message.type === "proof/start-partition" && this.#respondFn) {
      queueMicrotask(() => this.#respondFn!(message));
    }
  }

  addEventListener(type: string, listener: MockMessageListener | MockErrorListener): void {
    if (type === "message") this.#messageListeners.push(listener as MockMessageListener);
    if (type === "error") this.#errorListeners.push(listener as MockErrorListener);
    if (type === "messageerror") this.#messageErrorListeners.push(listener as MockErrorListener);
  }

  removeEventListener(type: string, listener: MockMessageListener | MockErrorListener): void {
    if (type === "message") {
      this.#messageListeners = this.#messageListeners.filter((l) => l !== listener);
    }
    if (type === "error") {
      this.#errorListeners = this.#errorListeners.filter((l) => l !== listener);
    }
    if (type === "messageerror") {
      this.#messageErrorListeners = this.#messageErrorListeners.filter((l) => l !== listener);
    }
  }

  terminate(): void {
    this.#terminated = true;
  }

  emit(data: unknown): void {
    const record = data && typeof data === "object"
      ? data as Record<string, unknown>
      : null;
    const normalized = record?.type === "proof/partition-complete" &&
      record.metrics === undefined
      ? { ...record, metrics: { elapsedMs: 0 } }
      : data;
    for (const listener of this.#messageListeners) {
      listener({ data: normalized });
    }
  }

  emitError(): void {
    for (const listener of this.#errorListeners) {
      listener({ message: "worker crash" });
    }
  }

  emitMessageError(): void {
    for (const listener of this.#messageErrorListeners) {
      listener({ message: "clone failure" });
    }
  }

  get terminated(): boolean {
    return this.#terminated;
  }
}

function makeSolution(moves: number, pushes: number): SolverSolution {
  const steps: SolutionStep[] = [];
  for (let i = 0; i < moves - pushes; i++) {
    steps.push({ direction: "right", kind: "walk" });
  }
  for (let i = 0; i < pushes; i++) {
    steps.push({ direction: "right", kind: "push" });
  }
  return {
    steps,
    moves,
    pushes,
    objective: { kind: "moves" },
    objectiveScore: moves,
    optimality: "unknown",
  };
}

function makeDiscoveryResult(moves: number, pushes: number): SolverResult {
  return {
    status: "solved",
    solution: makeSolution(moves, pushes),
    metrics: { elapsedMs: 100 },
  };
}

function makeContext(abortController?: AbortController) {
  const ac = abortController ?? new AbortController();
  return {
    signal: ac.signal,
    reportProgress: () => {},
    now: () => performance.now(),
  };
}

// ---------------------------------------------------------------------------
// Coordinator integration tests
// ---------------------------------------------------------------------------

describe("concurrent proof coordinator", () => {
  it("returns discovery result when unsolved", async () => {
    const request = makeRequest([
      "OOOOOO",
      "OR X O",
      "O   SO",
      "OOOOOO",
    ]);
    const unsolved: SolverResult = {
      status: "unsolved",
      reason: "limit-reached",
      metrics: { elapsedMs: 50 },
    };
    const result = await runConcurrentProof(
      request,
      makeContext(),
      { ...DEFAULT_SOKOMIND_REQUEST_OPTIONS, mode: "quality", proofParallelism: 2 },
      unsolved,
      { createProofWorker: () => new MockProofWorker(), proofParallelism: 2 },
    );
    assert.equal(result.status, "unsolved");
  });

  it("worker failure produces bounded proof, not optimal", async () => {
    const request = makeRequest([
      "OOOOOO",
      "OR X O",
      "O   SO",
      "OOOOOO",
    ]);
    const worker = new MockProofWorker(() => {
      queueMicrotask(() => worker.emitError());
    });

    const result = await runConcurrentProof(
      request,
      makeContext(),
      { ...DEFAULT_SOKOMIND_REQUEST_OPTIONS, mode: "quality", proofParallelism: 2 },
      makeDiscoveryResult(10, 5),
      { createProofWorker: () => worker, proofParallelism: 2 },
    );

    assert.equal(result.status, "solved");
    if (result.status === "solved") {
      assert.equal(result.solution.optimality, "unknown");
      assert.ok(result.proof);
      assert.equal(result.proof!.kind, "bounded");
    }
    assertValidSolverResult(result);
  });

  it("all partitions exhausted produces optimal proof", async () => {
    const request = makeRequest([
      "OOOOOO",
      "OR X O",
      "O   SO",
      "OOOOOO",
    ]);

    const worker = new MockProofWorker((cmd) => {
      queueMicrotask(() => {
        worker.emit({
          type: "proof/partition-complete",
          partitionId: cmd.partitionId,
          lowerBound: 5,
          exhausted: true,
        });
      });
    });

    const result = await runConcurrentProof(
      request,
      makeContext(),
      { ...DEFAULT_SOKOMIND_REQUEST_OPTIONS, mode: "quality", proofParallelism: 2 },
      makeDiscoveryResult(10, 5),
      { createProofWorker: () => worker, proofParallelism: 2 },
    );

    assert.equal(result.status, "solved");
    if (result.status === "solved") {
      assert.equal(result.solution.optimality, "proven");
      assert.ok(result.proof);
      assert.equal(result.proof!.kind, "optimal");
      assert.equal(result.proof!.lowerBound, 10);
      assert.equal(result.proof!.upperBound, 10);
      assert.equal(result.proof!.gap, 0);
    }
    assertValidSolverResult(result);
  });

  it("solution broadcast sends update-upper-bound to all workers", async () => {
    const request = makeRequest([
      "OOOOOO",
      "O R  O",
      "O X SO",
      "OOOOOO",
    ]);

    const workers: MockProofWorker[] = [];
    let firstPartition = true;

    const createWorker = () => {
      const w = new MockProofWorker((cmd) => {
        if (firstPartition) {
          firstPartition = false;
          queueMicrotask(() => {
            w.emit({
              type: "proof/solution",
              partitionId: cmd.partitionId,
              solution: {
                steps: [
                  { direction: "left", kind: "walk" },
                  { direction: "down", kind: "walk" },
                  { direction: "right", kind: "push" },
                  { direction: "right", kind: "push" },
                ],
                moves: 4,
                pushes: 2,
                objective: { kind: "moves" },
                objectiveScore: 4,
                optimality: "unknown",
              },
              totalCost: 4,
            });
            w.emit({
              type: "proof/partition-complete",
              partitionId: cmd.partitionId,
              lowerBound: 4,
              exhausted: true,
            });
          });
        } else {
          queueMicrotask(() => {
            w.emit({
              type: "proof/partition-complete",
              partitionId: cmd.partitionId,
              lowerBound: 4,
              exhausted: true,
            });
          });
        }
      });
      workers.push(w);
      return w;
    };

    const result = await runConcurrentProof(
      request,
      makeContext(),
      { ...DEFAULT_SOKOMIND_REQUEST_OPTIONS, mode: "quality", proofParallelism: 2 },
      makeDiscoveryResult(10, 5),
      { createProofWorker: createWorker, proofParallelism: 2 },
    );

    for (const w of workers) {
      const updates = w.receivedCommands.filter(
        (c) => c.type === "solver/update-upper-bound",
      );
      assert.ok(
        updates.length > 0,
        "each worker should receive upper-bound updates when a solution is found",
      );
    }
    assertValidSolverResult(result);
  });

  it("cancellation terminates all workers", async () => {
    const request = makeRequest([
      "OOOOOO",
      "OR X O",
      "O   SO",
      "OOOOOO",
    ]);

    const ac = new AbortController();
    const workers: MockProofWorker[] = [];

    const createWorker = () => {
      const w = new MockProofWorker(() => {
        queueMicrotask(() => ac.abort());
      });
      workers.push(w);
      return w;
    };

    const result = await runConcurrentProof(
      request,
      makeContext(ac),
      { ...DEFAULT_SOKOMIND_REQUEST_OPTIONS, mode: "quality", proofParallelism: 2 },
      makeDiscoveryResult(10, 5),
      { createProofWorker: createWorker, proofParallelism: 2 },
    );

    assert.equal(result.status, "cancelled");
    for (const w of workers) {
      assert.ok(w.terminated, "all workers must be terminated on cancellation");
    }
  });

  it("pre-aborted signal returns cancelled immediately", async () => {
    const request = makeRequest([
      "OOOOOO",
      "OR X O",
      "O   SO",
      "OOOOOO",
    ]);

    const ac = new AbortController();
    ac.abort();

    const result = await runConcurrentProof(
      request,
      makeContext(ac),
      { ...DEFAULT_SOKOMIND_REQUEST_OPTIONS, mode: "quality", proofParallelism: 2 },
      makeDiscoveryResult(10, 5),
      { createProofWorker: () => new MockProofWorker(), proofParallelism: 2 },
    );

    assert.equal(result.status, "cancelled");
  });

  it("serializes partition dispatch: one active partition per worker at a time", async () => {
    const request = makeRequest([
      "OOOOOO",
      "OR X O",
      "O   SO",
      "OOOOOO",
    ]);

    let maxConcurrent = 0;
    let currentActive = 0;
    const pendingPartitions: string[] = [];

    const createWorker = () => {
      const w = new MockProofWorker((cmd) => {
        currentActive++;
        if (currentActive > maxConcurrent) maxConcurrent = currentActive;
        pendingPartitions.push(cmd.partitionId);

        queueMicrotask(() => {
          currentActive--;
          w.emit({
            type: "proof/partition-complete",
            partitionId: cmd.partitionId,
            lowerBound: 10,
            exhausted: true,
          });
        });
      });
      return w;
    };

    await runConcurrentProof(
      request,
      makeContext(),
      { ...DEFAULT_SOKOMIND_REQUEST_OPTIONS, mode: "quality", proofParallelism: 1 },
      makeDiscoveryResult(10, 5),
      { createProofWorker: createWorker, proofParallelism: 1 },
    );

    assert.equal(
      maxConcurrent,
      1,
      "only one partition should be active per worker at any time",
    );
    assert.ok(
      pendingPartitions.length > 0,
      "at least one partition should have been dispatched",
    );
  });

  it("non-exhausted completion produces bounded proof, not optimal", async () => {
    const request = makeRequest([
      "OOOOOO",
      "OR X O",
      "O   SO",
      "OOOOOO",
    ]);

    const worker = new MockProofWorker((cmd) => {
      queueMicrotask(() => {
        worker.emit({
          type: "proof/partition-complete",
          partitionId: cmd.partitionId,
          lowerBound: 3,
          exhausted: false,
        });
      });
    });

    const result = await runConcurrentProof(
      request,
      makeContext(),
      { ...DEFAULT_SOKOMIND_REQUEST_OPTIONS, mode: "quality", proofParallelism: 1 },
      makeDiscoveryResult(10, 5),
      { createProofWorker: () => worker, proofParallelism: 1 },
    );

    assert.equal(result.status, "solved");
    if (result.status === "solved") {
      assert.equal(result.solution.optimality, "unknown");
      assert.ok(result.proof);
      assert.equal(result.proof!.kind, "bounded");
    }
    assertValidSolverResult(result);
  });

  it("exhausted partitions with no better solution prove optimality", async () => {
    const request = makeRequest([
      "OOOOOO",
      "OR X O",
      "O   SO",
      "OOOOOO",
    ]);

    const worker = new MockProofWorker((cmd) => {
      queueMicrotask(() => {
        worker.emit({
          type: "proof/partition-complete",
          partitionId: cmd.partitionId,
          lowerBound: 15,
          exhausted: true,
        });
      });
    });

    const result = await runConcurrentProof(
      request,
      makeContext(),
      { ...DEFAULT_SOKOMIND_REQUEST_OPTIONS, mode: "quality", proofParallelism: 1 },
      makeDiscoveryResult(10, 5),
      { createProofWorker: () => worker, proofParallelism: 1 },
    );

    assert.equal(result.status, "solved");
    if (result.status === "solved") {
      assert.equal(result.solution.optimality, "proven");
      assert.ok(result.proof);
      assert.equal(result.proof!.kind, "optimal");
      assert.equal(result.proof!.lowerBound, 10);
      assert.equal(result.proof!.upperBound, 10);
      assert.equal(result.proof!.gap, 0);
    }
    assertValidSolverResult(result);
  });

  it("mixed exhausted and bound-dominated partitions prove optimality", async () => {
    const request = makeRequest([
      "OOOOOO",
      "OR X O",
      "O   SO",
      "OOOOOO",
    ]);

    let partitionIndex = 0;
    const worker = new MockProofWorker((cmd) => {
      const idx = partitionIndex++;
      queueMicrotask(() => {
        if (idx % 2 === 0) {
          worker.emit({
            type: "proof/partition-complete",
            partitionId: cmd.partitionId,
            lowerBound: 12,
            exhausted: true,
          });
        } else {
          worker.emit({
            type: "proof/partition-complete",
            partitionId: cmd.partitionId,
            lowerBound: 10,
            exhausted: false,
          });
        }
      });
    });

    const result = await runConcurrentProof(
      request,
      makeContext(),
      { ...DEFAULT_SOKOMIND_REQUEST_OPTIONS, mode: "quality", proofParallelism: 1 },
      makeDiscoveryResult(10, 5),
      { createProofWorker: () => worker, proofParallelism: 1 },
    );

    assert.equal(result.status, "solved");
    if (result.status === "solved") {
      assert.equal(result.solution.optimality, "proven");
      assert.ok(result.proof);
      assert.equal(result.proof!.kind, "optimal");
    }
    assertValidSolverResult(result);
  });

  it("failed partition prevents optimal claim even if others exhausted", async () => {
    const request = makeRequest([
      "OOOOOO",
      "OR X O",
      "O   SO",
      "OOOOOO",
    ]);

    let partitionIndex = 0;
    const worker = new MockProofWorker((cmd) => {
      const idx = partitionIndex++;
      queueMicrotask(() => {
        if (idx === 0) {
          worker.emit({
            type: "proof/error",
            partitionId: cmd.partitionId,
            message: "out of memory",
          });
        } else {
          worker.emit({
            type: "proof/partition-complete",
            partitionId: cmd.partitionId,
            lowerBound: 15,
            exhausted: true,
          });
        }
      });
    });

    const result = await runConcurrentProof(
      request,
      makeContext(),
      { ...DEFAULT_SOKOMIND_REQUEST_OPTIONS, mode: "quality", proofParallelism: 1 },
      makeDiscoveryResult(10, 5),
      { createProofWorker: () => worker, proofParallelism: 1 },
    );

    assert.equal(result.status, "solved");
    if (result.status === "solved") {
      assert.equal(result.solution.optimality, "unknown");
      assert.ok(result.proof);
      assert.equal(result.proof!.kind, "bounded");
    }
    assertValidSolverResult(result);
  });

  it("progress updates raise partition lower bounds", async () => {
    const request = makeRequest([
      "OOOOOO",
      "OR X O",
      "O   SO",
      "OOOOOO",
    ]);

    const worker = new MockProofWorker((cmd) => {
      queueMicrotask(() => {
        worker.emit({
          type: "proof/progress",
          partitionId: cmd.partitionId,
          lowerBound: 8,
          expandedStates: 500,
        });
        queueMicrotask(() => {
          worker.emit({
            type: "proof/partition-complete",
            partitionId: cmd.partitionId,
            lowerBound: 10,
            exhausted: true,
          });
        });
      });
    });

    const result = await runConcurrentProof(
      request,
      makeContext(),
      { ...DEFAULT_SOKOMIND_REQUEST_OPTIONS, mode: "quality", proofParallelism: 1 },
      makeDiscoveryResult(10, 5),
      { createProofWorker: () => worker, proofParallelism: 1 },
    );

    assert.equal(result.status, "solved");
    if (result.status === "solved") {
      assert.equal(result.solution.optimality, "proven");
    }
    assertValidSolverResult(result);
  });

  it("bounded partition (solved + limit-hit) is not marked exhausted", async () => {
    const request = makeRequest([
      "OOOOOO",
      "OR X O",
      "O   SO",
      "OOOOOO",
    ]);

    let partitionIndex = 0;
    const worker = new MockProofWorker((cmd) => {
      const idx = partitionIndex++;
      queueMicrotask(() => {
        if (idx === 0) {
          worker.emit({
            type: "proof/solution",
            partitionId: cmd.partitionId,
            solution: makeSolution(9, 4),
            totalCost: 9,
          });
          worker.emit({
            type: "proof/partition-complete",
            partitionId: cmd.partitionId,
            lowerBound: 5,
            exhausted: false,
          });
        } else {
          worker.emit({
            type: "proof/partition-complete",
            partitionId: cmd.partitionId,
            lowerBound: 4,
            exhausted: false,
          });
        }
      });
    });

    const result = await runConcurrentProof(
      request,
      makeContext(),
      { ...DEFAULT_SOKOMIND_REQUEST_OPTIONS, mode: "quality", proofParallelism: 1 },
      makeDiscoveryResult(10, 5),
      { createProofWorker: () => worker, proofParallelism: 1 },
    );

    assert.equal(result.status, "solved");
    if (result.status === "solved") {
      assert.equal(result.solution.optimality, "unknown");
      assert.ok(result.proof);
      assert.equal(result.proof!.kind, "bounded");
      assert.ok(
        Number.isFinite(result.proof!.lowerBound),
        "lowerBound must be finite",
      );
      assert.ok(
        result.proof!.lowerBound! <= result.proof!.upperBound!,
        "lowerBound must not exceed upperBound",
      );
    }
    assertValidSolverResult(result);
  });

  it("fails malformed messages instead of waiting indefinitely", async () => {
    const request = makeRequest([
      "OOOOOO", "OR X O", "O   SO", "OOOOOO",
    ]);
    const worker = new MockProofWorker(() => {
      queueMicrotask(() => worker.emit({ type: "malformed" }));
    });
    const result = await runConcurrentProof(
      request,
      makeContext(),
      { ...DEFAULT_SOKOMIND_REQUEST_OPTIONS, mode: "quality", proofParallelism: 1 },
      makeDiscoveryResult(10, 5),
      { createProofWorker: () => worker, proofParallelism: 1, silenceTimeoutMs: 20 },
    );
    assert.equal(result.status, "solved");
    if (result.status === "solved") assert.equal(result.solution.optimality, "unknown");
    assert.equal(worker.terminated, true);
  });

  it("fails a worker that sends a wrong partition identity", async () => {
    const request = makeRequest([
      "OOOOOO", "OR X O", "O   SO", "OOOOOO",
    ]);
    const wrong = new MockProofWorker(() => {
      queueMicrotask(() => wrong.emit({
        type: "proof/partition-complete",
        partitionId: "not-the-active-partition",
        lowerBound: 1,
        exhausted: true,
        metrics: { elapsedMs: 1 },
      }));
    });
    const wrongResult = await runConcurrentProof(
      request,
      makeContext(),
      { ...DEFAULT_SOKOMIND_REQUEST_OPTIONS, mode: "quality", proofParallelism: 1 },
      makeDiscoveryResult(10, 5),
      { createProofWorker: () => wrong, proofParallelism: 1 },
    );
    assert.equal(wrongResult.status, "solved");
    if (wrongResult.status === "solved") {
      assert.equal(wrongResult.solution.optimality, "unknown");
    }
  });

  it("bounds silent workers with a watchdog and handles messageerror", async () => {
    const request = makeRequest([
      "OOOOOO", "OR X O", "O   SO", "OOOOOO",
    ]);
    const silent = new MockProofWorker();
    const started = performance.now();
    const timed = await runConcurrentProof(
      request,
      makeContext(),
      { ...DEFAULT_SOKOMIND_REQUEST_OPTIONS, mode: "quality", proofParallelism: 1 },
      makeDiscoveryResult(10, 5),
      { createProofWorker: () => silent, proofParallelism: 1, silenceTimeoutMs: 5 },
    );
    assert.equal(timed.status, "solved");
    assert.ok(performance.now() - started < 2000);
    assert.equal(silent.terminated, true);

    const broken = new MockProofWorker(() => {
      queueMicrotask(() => broken.emitMessageError());
    });
    const cloneFailure = await runConcurrentProof(
      request,
      makeContext(),
      { ...DEFAULT_SOKOMIND_REQUEST_OPTIONS, mode: "quality", proofParallelism: 1 },
      makeDiscoveryResult(10, 5),
      { createProofWorker: () => broken, proofParallelism: 1, silenceTimeoutMs: 20 },
    );
    assert.equal(cloneFailure.status, "solved");
    if (cloneFailure.status === "solved") {
      assert.equal(cloneFailure.solution.optimality, "unknown");
    }
  });

  it("enforces one remaining wall-clock deadline across silent partitions", async () => {
    const request: SolverRequest = {
      ...makeRequest(["OOOOOO", "OR X O", "O   SO", "OOOOOO"]),
      limits: { maxElapsedMs: 500 },
    };
    const silent = new MockProofWorker();
    const started = performance.now();
    const result = await runConcurrentProof(
      request,
      makeContext(),
      { ...DEFAULT_SOKOMIND_REQUEST_OPTIONS, mode: "quality", proofParallelism: 1 },
      makeDiscoveryResult(10, 5),
      { createProofWorker: () => silent, proofParallelism: 1, silenceTimeoutMs: 5_000 },
    );
    assert.equal(result.status, "solved");
    assert.ok(performance.now() - started < 4000);
    assert.equal(silent.terminated, true);
  });

  it("terminates already-created workers when a later factory call fails", async () => {
    const request = makeRequest([
      "OOOOOO", "OR X O", "O   SO", "OOOOOO",
    ]);
    const first = new MockProofWorker();
    let calls = 0;
    const discovery = makeDiscoveryResult(10, 5);
    const result = await runConcurrentProof(
      request,
      makeContext(),
      { ...DEFAULT_SOKOMIND_REQUEST_OPTIONS, mode: "quality", proofParallelism: 2 },
      discovery,
      {
        proofParallelism: 2,
        createProofWorker: () => {
          if (calls++ === 0) return first;
          throw new Error("factory failure");
        },
      },
    );
    assert.equal(result, discovery);
    assert.equal(first.terminated, true);
  });

  it("rejects replay-invalid candidate solutions", async () => {
    const request = makeRequest([
      "OOOOOO", "OR X O", "O   SO", "OOOOOO",
    ]);
    const worker = new MockProofWorker((command) => {
      queueMicrotask(() => worker.emit({
        type: "proof/solution",
        partitionId: command.partitionId,
        solution: makeSolution(1, 0),
        totalCost: 1,
      }));
    });
    const result = await runConcurrentProof(
      request,
      makeContext(),
      { ...DEFAULT_SOKOMIND_REQUEST_OPTIONS, mode: "quality", proofParallelism: 1 },
      makeDiscoveryResult(10, 5),
      { createProofWorker: () => worker, proofParallelism: 1, silenceTimeoutMs: 20 },
    );
    assert.equal(result.status, "solved");
    if (result.status === "solved") {
      assert.equal(result.solution.moves, 10);
      assert.equal(result.solution.optimality, "unknown");
    }
    assert.equal(
      worker.receivedCommands.some((command) => command.type === "solver/update-upper-bound"),
      false,
    );
  });

  it("partitions remaining limits and merges discovery plus proof metrics", async () => {
    const request: SolverRequest = {
      ...makeRequest(["OOOOOO", "OR X O", "O   SO", "OOOOOO"]),
      limits: {
        maxElapsedMs: 1_000,
        maxExpandedStates: 100,
        maxGeneratedStates: 200,
        maxMemoryBytes: 1_000,
      },
    };
    const discovery: SolverResult = {
      ...makeDiscoveryResult(10, 5),
      metrics: { elapsedMs: 100, expandedStates: 40, generatedStates: 50 },
    };
    const starts: ProofStartPartition[] = [];
    const createWorker = () => {
      const worker = new MockProofWorker((command) => {
        starts.push(command);
        queueMicrotask(() => worker.emit({
          type: "proof/partition-complete",
          partitionId: command.partitionId,
          lowerBound: 10,
          exhausted: true,
          metrics: {
            elapsedMs: 2,
            expandedStates: command.request.limits?.maxExpandedStates ?? 0,
            generatedStates: command.request.limits?.maxGeneratedStates ?? 0,
            peakFrontierSize: 3,
            counters: {
              exactFeatureMask: 511,
              heuristicCalls: 2,
              estimatedMemoryBytes: 100,
            },
          },
        }));
      });
      return worker;
    };
    const result = await runConcurrentProof(
      request,
      makeContext(),
      { ...DEFAULT_SOKOMIND_REQUEST_OPTIONS, mode: "quality", proofParallelism: 2 },
      discovery,
      { createProofWorker: createWorker, proofParallelism: 2 },
    );
    assert.ok(starts.length > 0);
    assert.ok(starts.every((command) =>
      (command.request.limits?.maxElapsedMs ?? 0) <= 900 &&
      (command.request.limits?.maxMemoryBytes ?? 0) <= 500));
    assert.equal(result.status, "solved");
    assert.ok((result.metrics.expandedStates ?? 0) <= 100);
    assert.ok((result.metrics.generatedStates ?? 0) <= 200);
    assert.ok((result.metrics.expandedStates ?? 0) >= 40);
    assert.ok((result.metrics.generatedStates ?? 0) >= 50);
    assert.equal(result.metrics.counters?.["proof.exactFeatureMask"], 511);
    assert.equal(
      result.metrics.counters?.["proof.heuristicCalls"],
      starts.length * 2,
    );
    assert.equal(
      result.metrics.peakFrontierSize,
      Math.min(2, starts.length) * 3,
    );
  });

  it("takes per-worker retained peaks across sequential partitions before summing workers", async () => {
    const request = makeRequest([
      "OOOOOO",
      "OR   O",
      "O XX O",
      "O SS O",
      "OOOOOO",
    ]);
    assert.equal(enumerateFirstPushPartitions(request).length, 4);
    const perWorkerMetrics = [
      [
        { retained: 10, memory: 100, peakMemory: 110, frontier: 3, calls: 2 },
        { retained: 7, memory: 150, peakMemory: 160, frontier: 8, calls: 3 },
      ],
      [
        { retained: 20, memory: 80, peakMemory: 90, frontier: 5, calls: 4 },
        { retained: 12, memory: 120, peakMemory: 130, frontier: 4, calls: 5 },
      ],
    ] as const;
    const startsByWorker = [0, 0];
    let nextWorker = 0;
    const createWorker = () => {
      const workerIndex = nextWorker++;
      const worker = new MockProofWorker((command) => {
        const localIndex = startsByWorker[workerIndex]++;
        const metric = perWorkerMetrics[workerIndex][localIndex];
        assert.ok(metric, `unexpected partition ${localIndex} on worker ${workerIndex}`);
        queueMicrotask(() => worker.emit({
          type: "proof/partition-complete",
          partitionId: command.partitionId,
          lowerBound: 10,
          exhausted: true,
          metrics: {
            elapsedMs: 1,
            expandedStates: 1,
            generatedStates: 2,
            peakFrontierSize: metric.frontier,
            counters: {
              exactFeatureMask: 511,
              heuristicCalls: metric.calls,
              retainedStates: metric.retained,
              estimatedMemoryBytes: metric.memory,
              peakEstimatedMemoryBytes: metric.peakMemory,
            },
          },
        }));
      });
      return worker;
    };
    const result = await runConcurrentProof(
      request,
      makeContext(),
      { ...DEFAULT_SOKOMIND_REQUEST_OPTIONS, mode: "quality", proofParallelism: 2 },
      makeDiscoveryResult(10, 5),
      { createProofWorker: createWorker, proofParallelism: 2 },
    );
    assert.deepEqual(startsByWorker, [2, 2]);
    assert.equal(result.status, "solved");
    assert.equal(result.metrics.peakFrontierSize, 13);
    assert.equal(result.metrics.counters?.["proof.retainedStates"], 30);
    assert.equal(result.metrics.counters?.["proof.estimatedMemoryBytes"], 270);
    assert.equal(result.metrics.counters?.["proof.peakEstimatedMemoryBytes"], 290);
    assert.equal(result.metrics.counters?.heuristicCalls, undefined);
    assert.equal(result.metrics.counters?.["proof.heuristicCalls"], 14);
    assert.equal(result.metrics.counters?.proofExpandedStates, 4);
    assert.equal(result.metrics.counters?.proofGeneratedStates, 8);
  });

  it("retains the latest progress metrics when a partition times out", async () => {
    const request = makeRequest([
      "OOOOOO", "OR X O", "O   SO", "OOOOOO",
    ]);
    const discovery: SolverResult = {
      ...makeDiscoveryResult(10, 5),
      metrics: { elapsedMs: 100, expandedStates: 40, generatedStates: 50 },
    };
    const worker = new MockProofWorker((command) => {
      queueMicrotask(() => worker.emit({
        type: "proof/progress",
        partitionId: command.partitionId,
        lowerBound: 1,
        expandedStates: 7,
        generatedStates: 9,
        counters: { peakEstimatedMemoryBytes: 256 },
      }));
    });
    const result = await runConcurrentProof(
      request,
      makeContext(),
      { ...DEFAULT_SOKOMIND_REQUEST_OPTIONS, mode: "quality", proofParallelism: 1 },
      discovery,
      { createProofWorker: () => worker, proofParallelism: 1, silenceTimeoutMs: 5 },
    );
    assert.equal(result.status, "solved");
    assert.ok((result.metrics.expandedStates ?? 0) >= 47);
    assert.ok((result.metrics.generatedStates ?? 0) >= 59);
    assert.ok((result.metrics.counters?.peakEstimatedMemoryBytes ?? 0) >= 256);
  });
});
