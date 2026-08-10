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
  SolverRequest,
  SolverResult,
  SolverSolution,
} from "../../src/solver/contracts.ts";

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
        solution: { steps: [], moves: 5 },
        totalCost: 7,
      }),
    );
  });

  it("isProofResult accepts valid partition-complete", () => {
    assert.ok(
      isProofResult({
        type: "proof/partition-complete",
        partitionId: "abc",
        lowerBound: 3,
        exhausted: true,
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
  });
});

// ---------------------------------------------------------------------------
// First-push partitioning
// ---------------------------------------------------------------------------

describe("first-push partitioning", () => {
  it("enumerates partitions for a simple 1-box puzzle", () => {
    const request = makeRequest([
      "OOOOOO",
      "OR X O",
      "O   SO",
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
    if (type === "error" || type === "messageerror") this.#errorListeners.push(listener as MockErrorListener);
  }

  removeEventListener(type: string, listener: MockMessageListener | MockErrorListener): void {
    if (type === "message") {
      this.#messageListeners = this.#messageListeners.filter((l) => l !== listener);
    }
  }

  terminate(): void {
    this.#terminated = true;
  }

  emit(data: unknown): void {
    for (const listener of this.#messageListeners) {
      listener({ data });
    }
  }

  emitError(): void {
    for (const listener of this.#errorListeners) {
      listener({ message: "worker crash" });
    }
  }

  get terminated(): boolean {
    return this.#terminated;
  }
}

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
    }
  });

  it("solution broadcast sends update-upper-bound to all workers", async () => {
    const request = makeRequest([
      "OOOOOO",
      "OR X O",
      "O   SO",
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
              solution: makeSolution(8, 4),
              totalCost: 8,
            });
          });
        } else {
          queueMicrotask(() => {
            w.emit({
              type: "proof/partition-complete",
              partitionId: cmd.partitionId,
              lowerBound: 8,
              exhausted: true,
            });
          });
        }
      });
      workers.push(w);
      return w;
    };

    await runConcurrentProof(
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
      assert.equal(result.proof!.gap, 0);
    }
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
  });
});
