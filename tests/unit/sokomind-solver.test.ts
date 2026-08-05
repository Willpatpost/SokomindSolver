import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createSession,
  parsePuzzleRows,
  stepSnapshot,
  type PuzzleDefinition,
} from "../../src/core/index.ts";
import type {
  SolverExecutionContext,
  SolverRequest,
} from "../../src/solver/contracts.ts";
import {
  createSokomindSolverAdapter,
  reconstructBidirectionalPath,
  sokomindDiscoveryBeamWidth,
  solutionFromLegacyPath,
  toLegacyState,
  type SokomindEngineWorker,
} from "../../src/solver/implementations/sokomind-solver.ts";
import { verifySolverSolution } from "../../src/solver/verification.ts";

const ONE_TYPED_BOX: PuzzleDefinition = {
  id: "one-typed-box",
  title: "One typed box",
  difficulty: "tutorial",
  boxes: 1,
  rows: ["OOOOO", "O R O", "O A O", "O a O", "OOOOO"],
};

const LARGE_ONE_TYPED_BOX: PuzzleDefinition = {
  id: "large-one-typed-box",
  title: "Large one typed box",
  difficulty: "tutorial",
  boxes: 1,
  rows: [
    "OOOOOOOOOOOO",
    "O R        O",
    "O A        O",
    "O a        O",
    ...Array.from({ length: 7 }, () => "O          O"),
    "OOOOOOOOOOOO",
  ],
};

function requestFor(
  puzzle: PuzzleDefinition,
  overrides: Partial<SolverRequest> = {},
): SolverRequest {
  const session = createSession(puzzle);
  return Object.freeze({
    board: session.board,
    snapshot: session.snapshot,
    objective: { kind: "moves" } as const,
    ...overrides,
  });
}

function context(
  signal: AbortSignal = new AbortController().signal,
  progress: SolverExecutionContext["reportProgress"] = () => {},
): SolverExecutionContext {
  return {
    signal,
    reportProgress: progress,
    now: () => performance.now(),
  };
}

type WorkerCommand = Parameters<SokomindEngineWorker["postMessage"]>[0];

class ScriptedWorker implements SokomindEngineWorker {
  readonly #messageListeners = new Set<(event: { data: unknown }) => void>();
  readonly #errorListeners = new Set<(event: { message?: string }) => void>();
  readonly #messageErrorListeners = new Set<
    (event: { message?: string }) => void
  >();
  readonly #onPost: (worker: ScriptedWorker, command: WorkerCommand) => void;
  terminated = false;

  constructor(
    onPost: (worker: ScriptedWorker, command: WorkerCommand) => void,
  ) {
    this.#onPost = onPost;
  }

  postMessage(message: WorkerCommand): void {
    this.#onPost(this, message);
  }

  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  addEventListener(
    type: "error" | "messageerror",
    listener: (event: { message?: string }) => void,
  ): void;
  addEventListener(
    type: "message" | "error" | "messageerror",
    listener:
      | ((event: { data: unknown }) => void)
      | ((event: { message?: string }) => void),
  ): void {
    if (type === "message") {
      this.#messageListeners.add(listener as (event: { data: unknown }) => void);
    } else if (type === "error") {
      this.#errorListeners.add(listener as (event: { message?: string }) => void);
    } else {
      this.#messageErrorListeners.add(
        listener as (event: { message?: string }) => void,
      );
    }
  }

  removeEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  removeEventListener(
    type: "error" | "messageerror",
    listener: (event: { message?: string }) => void,
  ): void;
  removeEventListener(
    type: "message" | "error" | "messageerror",
    listener:
      | ((event: { data: unknown }) => void)
      | ((event: { message?: string }) => void),
  ): void {
    if (type === "message") {
      this.#messageListeners.delete(
        listener as (event: { data: unknown }) => void,
      );
    } else if (type === "error") {
      this.#errorListeners.delete(
        listener as (event: { message?: string }) => void,
      );
    } else {
      this.#messageErrorListeners.delete(
        listener as (event: { message?: string }) => void,
      );
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(data: unknown): void {
    if (this.terminated) return;
    for (const listener of this.#messageListeners) listener({ data });
  }
}

describe("Sokomind Solver adapter", () => {
  it("advertises honest typed, partial-state, and bounded capabilities", () => {
    const metadata = createSokomindSolverAdapter().metadata;
    assert.equal(metadata.id, "sokomind-solver");
    assert.equal(metadata.displayName, "Sokomind Solver");
    assert.equal(metadata.capabilities.labeledBoxes, true);
    assert.equal(metadata.capabilities.genericBoxes, true);
    assert.equal(metadata.capabilities.partialState, true);
    assert.equal(metadata.capabilities.cooperativeCancellation, true);
    assert.equal(metadata.capabilities.quality, "bounded");
    assert.deepEqual(metadata.capabilities.objectives, ["moves"]);
    assert.equal(metadata.capabilities.deterministic, false);
  });

  it("scales high-branching beam width to the declared memory class", () => {
    assert.equal(sokomindDiscoveryBeamWidth(2, 20), 320);
    assert.equal(sokomindDiscoveryBeamWidth(6, 60), 700);
    assert.equal(
      sokomindDiscoveryBeamWidth(8, 90, 384 * 1024 * 1024),
      32,
    );
    assert.equal(
      sokomindDiscoveryBeamWidth(8, 90, 768 * 1024 * 1024),
      64,
    );
    assert.equal(
      sokomindDiscoveryBeamWidth(8, 90, 1_536 * 1024 * 1024),
      128,
    );
    assert.equal(sokomindDiscoveryBeamWidth(8, 90), 256);
  });

  it("honors zero-valued resource ceilings before starting a worker", async () => {
    for (const limits of [
      { maxElapsedMs: 0 },
      { maxExpandedStates: 0 },
      { maxGeneratedStates: 0 },
      { maxMemoryBytes: 0 },
    ] as const) {
      let workersCreated = 0;
      const adapter = createSokomindSolverAdapter({
        createWorker: () => {
          workersCreated += 1;
          throw new Error("worker should not start");
        },
      });
      const result = await adapter.solve(
        requestFor(ONE_TYPED_BOX, { limits }),
        context(),
      );

      assert.equal(result.status, "unsolved");
      if (result.status === "unsolved") {
        assert.equal(result.reason, "limit-reached");
      }
      assert.equal(workersCreated, 0);
    }
  });

  it("keeps static rows but takes every dynamic occupant from the exact snapshot", () => {
    const initial = requestFor(ONE_TYPED_BOX);
    const transition = stepSnapshot(initial.board, initial.snapshot, "down");
    assert.equal(transition.snapshot.solved, true);
    const partial = {
      ...initial,
      snapshot: transition.snapshot,
    } satisfies SolverRequest;

    const legacy = toLegacyState(partial);
    assert.deepEqual(legacy.rows, ONE_TYPED_BOX.rows);
    assert.deepEqual(legacy.robot, [2, 2]);
    assert.deepEqual(legacy.boxes, [["3,2", "A"]]);
  });

  it("replays legacy directions into exact typed walk/push annotations", () => {
    const request = requestFor(ONE_TYPED_BOX);
    const solution = solutionFromLegacyPath(request, ["Down"]);

    assert.ok(solution);
    assert.deepEqual(solution.steps, [{ direction: "down", kind: "push" }]);
    assert.equal(solution.moves, 1);
    assert.equal(solution.pushes, 1);
    assert.equal(solution.optimality, "unknown");
    assert.equal(verifySolverSolution(request, solution).valid, true);
    assert.equal(solutionFromLegacyPath(request, ["Up"]), null);
  });

  it("returns and verifies a typed solution from the isolated engine worker", async () => {
    const workers: ScriptedWorker[] = [];
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 2,
      createWorker: () => {
        const worker = new ScriptedWorker((self, command) => {
          assert.equal(command.mode, "search");
          const state = command.payload.state as {
            readonly boxes: readonly (readonly [string, string])[];
          };
          assert.deepEqual(state.boxes, [["2,2", "A"]]);
          queueMicrotask(() => {
            self.emit({
              type: "done",
              status: "solved",
              path: ["Down"],
              visited: 1,
              generated: 1,
              peakFrontier: 1,
              performance: {
                heuristicCalls: 1,
                reachabilityCalls: 1,
              },
            });
          });
        });
        workers.push(worker);
        return worker;
      },
    });
    const request = requestFor(ONE_TYPED_BOX);

    const result = await adapter.solve(request, context());

    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;
    assert.equal(verifySolverSolution(request, result.solution).valid, true);
    assert.equal(result.solution.optimality, "unknown");
    assert.equal(result.metrics.expandedStates, 1);
    assert.equal(workers.every(({ terminated }) => terminated), true);
  });

  it("replay-verifies and returns a shorter bounded rewrite", async () => {
    const algorithms: unknown[] = [];
    const phases: string[] = [];
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 2,
      improvementMinimumMoves: 0,
      improvementMaxVisited: 100,
      improvementMaxElapsedMs: 1_000,
      createWorker: () =>
        new ScriptedWorker((self, command) => {
          const algorithm = command.payload.algorithm;
          algorithms.push(algorithm);
          queueMicrotask(() => {
            self.emit({
              type: "done",
              status: "solved",
              path:
                algorithm === "solution-window-rewrite"
                  ? ["Down"]
                  : ["Left", "Right", "Down"],
              visited: 1,
              generated: 1,
              retained: 1,
              frontier: 0,
            });
          });
        }),
    });
    const request = requestFor(ONE_TYPED_BOX);

    const result = await adapter.solve(
      request,
      context(undefined, ({ phase }) => phases.push(phase)),
    );

    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;
    assert.deepEqual(algorithms, ["ultimate", "solution-window-rewrite"]);
    assert.equal(result.solution.moves, 1);
    assert.equal(result.solution.pushes, 1);
    assert.equal(verifySolverSolution(request, result.solution).valid, true);
    assert.equal(result.metrics.counters?.initialSolutionMoves, 3);
    assert.equal(result.metrics.counters?.bestSolutionMoves, 1);
    assert.equal(result.metrics.counters?.solutionImprovements, 1);
    assert.ok(phases.includes("improving"));
  });

  it("passes a validated tuning profile only into soft engine ordering", async () => {
    let receivedWeight: unknown;
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 2,
      tuning: { heuristicWeight: 2.25, topologyWeight: 1.5 },
      createWorker: () =>
        new ScriptedWorker((self, command) => {
          receivedWeight = command.payload.weight;
          assert.equal(command.payload.topologyWeight, 1.5);
          queueMicrotask(() => {
            self.emit({
              type: "done",
              status: "solved",
              path: ["Down"],
              visited: 1,
              generated: 1,
            });
          });
        }),
    });

    const result = await adapter.solve(
      requestFor(ONE_TYPED_BOX),
      context(),
    );

    assert.equal(result.status, "solved");
    assert.equal(receivedWeight, 2.25);
  });

  it("does not accept a candidate reported at the expanded-state ceiling", async () => {
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 2,
      createWorker: () =>
        new ScriptedWorker((self) => {
          queueMicrotask(() => {
            self.emit({
              type: "done",
              status: "solved",
              path: ["Down"],
              visited: 1,
              generated: 1,
              peakFrontier: 1,
            });
          });
        }),
    });
    const request = requestFor(ONE_TYPED_BOX, {
      limits: { maxExpandedStates: 1 },
    });

    const result = await adapter.solve(request, context());

    assert.equal(result.status, "unsolved");
    if (result.status !== "unsolved") return;
    assert.equal(result.reason, "limit-reached");
    assert.match(result.detail ?? "", /expanded/i);
  });

  it("reserves time for discovery after a structural worker goes silent", async () => {
    const algorithms: unknown[] = [];
    const workers: ScriptedWorker[] = [];
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 2,
      structuralHeadStartMs: 5,
      createWorker: () => {
        const worker = new ScriptedWorker((self, command) => {
          const algorithm = command.payload.algorithm;
          algorithms.push(algorithm);
          if (algorithm === "analyze-puzzle") {
            queueMicrotask(() => {
              self.emit({ type: "done", status: "exhausted" });
            });
          } else if (algorithm !== "plan-macro-beam") {
            queueMicrotask(() => {
              self.emit({
                type: "done",
                status: "solved",
                path: ["Down"],
                visited: 1,
                generated: 1,
              });
            });
          }
        });
        workers.push(worker);
        return worker;
      },
    });

    const result = await adapter.solve(
      requestFor(LARGE_ONE_TYPED_BOX, {
        limits: { maxElapsedMs: 1_000 },
      }),
      context(),
    );

    assert.equal(result.status, "solved");
    assert.deepEqual(algorithms, [
      "analyze-puzzle",
      "plan-macro-beam",
      "ultimate",
    ]);
    assert.equal(workers[1]?.terminated, true);
  });

  it("reserves a one-state expanded budget for discovery", async () => {
    const algorithms: unknown[] = [];
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 4,
      createWorker: () =>
        new ScriptedWorker((self, command) => {
          const algorithm = command.payload.algorithm;
          algorithms.push(algorithm);
          queueMicrotask(() => {
            if (algorithm === "analyze-puzzle") {
              self.emit({ type: "done", status: "exhausted" });
            } else {
              self.emit({
                type: "done",
                status: "solved",
                path: ["Down"],
                visited: 0,
                generated: 0,
              });
            }
          });
        }),
    });

    const result = await adapter.solve(
      requestFor(LARGE_ONE_TYPED_BOX, {
        limits: { maxExpandedStates: 1 },
      }),
      context(),
    );

    assert.equal(result.status, "solved");
    assert.deepEqual(algorithms, ["analyze-puzzle", "ultimate"]);
  });

  it("reserves a one-state generated budget for discovery", async () => {
    const algorithms: unknown[] = [];
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 4,
      createWorker: () =>
        new ScriptedWorker((self, command) => {
          const algorithm = command.payload.algorithm;
          algorithms.push(algorithm);
          queueMicrotask(() => {
            if (algorithm === "analyze-puzzle") {
              self.emit({ type: "done", status: "exhausted" });
            } else {
              self.emit({
                type: "done",
                status: "solved",
                path: ["Down"],
                visited: 0,
                generated: 0,
              });
            }
          });
        }),
    });

    const result = await adapter.solve(
      requestFor(LARGE_ONE_TYPED_BOX, {
        limits: { maxGeneratedStates: 1 },
      }),
      context(),
    );

    assert.equal(result.status, "solved");
    assert.deepEqual(algorithms, ["analyze-puzzle", "ultimate"]);
  });

  it("caps structural generation before using the remaining budget", async () => {
    const structuralGeneratedBudgets: unknown[] = [];
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 2,
      createWorker: () =>
        new ScriptedWorker((self, command) => {
          const algorithm = command.payload.algorithm;
          queueMicrotask(() => {
            if (algorithm === "analyze-puzzle") {
              self.emit({ type: "done", status: "exhausted" });
            } else if (algorithm === "plan-macro-beam") {
              structuralGeneratedBudgets.push(
                command.payload.maxGenerated,
              );
              self.emit({
                type: "done",
                status: "cutoff",
                cutoff: true,
                visited: 1,
                generated: 6,
              });
            } else {
              self.emit({
                type: "done",
                status: "solved",
                path: ["Down"],
                visited: 1,
                generated: 1,
              });
            }
          });
        }),
    });

    const result = await adapter.solve(
      requestFor(LARGE_ONE_TYPED_BOX, {
        limits: { maxGeneratedStates: 10 },
      }),
      context(),
    );

    assert.equal(result.status, "solved");
    assert.deepEqual(structuralGeneratedBudgets, [6]);
  });

  it("runs the bidirectional pair only after direct search at the desktop memory class", async () => {
    const modes: string[] = [];
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 3,
      deviceMemoryGb: 16,
      createWorker: () =>
        new ScriptedWorker((self, command) => {
          modes.push(command.mode);
          queueMicrotask(() => {
            if (command.mode === "search") {
              self.emit({
                type: "done",
                status: "exhausted",
                visited: 1,
                generated: 1,
              });
            } else if (command.mode === "bidir-forward") {
              self.emit({
                type: "done",
                status: "solved",
                path: ["Down"],
                visited: 1,
                generated: 1,
              });
            }
          });
        }),
    });

    const result = await adapter.solve(
      requestFor(ONE_TYPED_BOX, {
        limits: { maxMemoryBytes: 1_536 * 1024 * 1024 },
      }),
      context(),
    );

    assert.equal(result.status, "solved");
    assert.deepEqual(modes, [
      "search",
      "bidir-forward",
      "bidir-reverse",
    ]);
  });

  it("terminates an isolated engine immediately when cancelled", async () => {
    const abort = new AbortController();
    const workers: ScriptedWorker[] = [];
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 2,
      createWorker: () => {
        const worker = new ScriptedWorker(() => {});
        workers.push(worker);
        return worker;
      },
    });

    const pending = adapter.solve(
      requestFor(ONE_TYPED_BOX),
      context(abort.signal),
    );
    abort.abort("test cancellation");
    const result = await pending;

    assert.equal(result.status, "cancelled");
    assert.equal(workers.length, 1);
    assert.equal(workers[0].terminated, true);
  });

  it("falls back when an unlimited engine stops reporting progress", async () => {
    const workers: ScriptedWorker[] = [];
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 2,
      workerSilenceTimeoutMs: 5,
      createWorker: () => {
        const worker = new ScriptedWorker(() => {});
        workers.push(worker);
        return worker;
      },
    });

    const result = await adapter.solve(
      requestFor(ONE_TYPED_BOX),
      context(),
    );

    assert.equal(result.status, "solved");
    assert.equal(workers.length, 1);
    assert.equal(workers[0]?.terminated, true);
  });

  it("enforces the aggregate memory ceiling outside the synchronous engine", async () => {
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 2,
      createWorker: () => new ScriptedWorker(() => {}),
    });
    const request = requestFor(ONE_TYPED_BOX, {
      limits: { maxMemoryBytes: 1 },
    });

    const result = await adapter.solve(request, context());

    assert.equal(result.status, "unsolved");
    if (result.status !== "unsolved") return;
    assert.equal(result.reason, "limit-reached");
    assert.match(result.detail ?? "", /memory/i);
  });

  it("does not treat cumulative generated work as live memory", async () => {
    const generated = 1_000_000;
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 2,
      createWorker: () =>
        new ScriptedWorker((self) => {
          queueMicrotask(() => {
            self.emit({
              type: "progress",
              status: "searching",
              visited: 1,
              generated,
              retained: 1,
              frontier: 1,
            });
            queueMicrotask(() => {
              self.emit({
                type: "done",
                status: "solved",
                path: ["Down"],
                visited: 1,
                generated,
                retained: 1,
                frontier: 0,
              });
            });
          });
        }),
    });

    const result = await adapter.solve(
      requestFor(ONE_TYPED_BOX, {
        limits: { maxMemoryBytes: 64 * 1024 * 1024 },
      }),
      context(),
    );

    assert.equal(result.status, "solved");
    assert.equal(result.metrics.generatedStates, generated);
    assert.ok(
      (result.metrics.counters?.peakEstimatedMemoryBytes ?? Infinity) <
        64 * 1024 * 1024,
    );
  });

  it("uses current isolate heap for cutoffs while retaining its historical peak", async () => {
    const currentBytes = 20 * 1024 * 1024;
    const historicalPeakBytes = 512 * 1024 * 1024;
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 2,
      createWorker: () =>
        new ScriptedWorker((self) => {
          queueMicrotask(() => {
            self.emit({
              type: "done",
              status: "solved",
              path: ["Down"],
              visited: 1,
              generated: 1,
              retained: 1,
              frontier: 0,
              performance: {
                heapUsedBytes: currentBytes,
                heapPeakBytes: historicalPeakBytes,
                memory: {
                  source: "injected-runtime",
                  usedBytes: currentBytes,
                  peakBytes: historicalPeakBytes,
                },
              },
            });
          });
        }),
    });

    const result = await adapter.solve(
      requestFor(ONE_TYPED_BOX, {
        limits: { maxMemoryBytes: 64 * 1024 * 1024 },
      }),
      context(),
    );

    assert.equal(result.status, "solved");
    assert.equal(
      result.metrics.counters?.memoryCurrentDirectPortfolioBytes,
      0,
    );
    assert.equal(
      result.metrics.counters?.memoryPeakDirectPortfolioBytes,
      historicalPeakBytes,
    );
    assert.equal(
      result.metrics.counters?.peakEstimatedMemoryBytes,
      historicalPeakBytes,
    );
  });

  it("accounts for live engine caches without generated-state inflation", async () => {
    const cacheBytes = 56 * 1024 * 1024;
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 2,
      createWorker: () =>
        new ScriptedWorker((self) => {
          queueMicrotask(() => {
            self.emit({
              type: "progress",
              status: "searching",
              visited: 1,
              generated: 1,
              retained: 1,
              frontier: 1,
              performance: {
                engineMemory: {
                  boardBytes: 1024,
                  cacheEntries: 1,
                  cacheBytes,
                },
              },
            });
          });
        }),
    });

    const result = await adapter.solve(
      requestFor(ONE_TYPED_BOX, {
        limits: { maxMemoryBytes: 64 * 1024 * 1024 },
      }),
      context(),
    );

    assert.equal(result.status, "unsolved");
    if (result.status !== "unsolved") return;
    assert.equal(result.reason, "limit-reached");
    assert.match(result.detail ?? "", /memory/i);
    assert.ok(
      (result.metrics.counters?.memoryPeakDirectPortfolioBytes ?? 0) >
        cacheBytes,
    );
  });

  it("lets current retained and cache memory fall while preserving the lane peak", async () => {
    const progressEvents: Parameters<
      SolverExecutionContext["reportProgress"]
    >[0][] = [];
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 2,
      createWorker: () =>
        new ScriptedWorker((self) => {
          queueMicrotask(() => {
            self.emit({
              type: "landmark",
              visited: 1_000,
              generated: 10_000,
              retained: 4_000,
              frontier: 200,
              performance: {
                engineMemory: { cacheBytes: 8 * 1024 * 1024 },
              },
            });
            queueMicrotask(() => {
              self.emit({
                type: "landmark",
                visited: 1_001,
                generated: 20_000,
                retained: 10,
                frontier: 1,
                performance: {
                  engineMemory: { cacheBytes: 1024 },
                },
              });
              queueMicrotask(() => {
                self.emit({
                  type: "done",
                  status: "solved",
                  path: ["Down"],
                  visited: 1_001,
                  generated: 20_000,
                  retained: 10,
                  frontier: 0,
                });
              });
            });
          });
        }),
    });

    const result = await adapter.solve(
      requestFor(ONE_TYPED_BOX),
      context(undefined, (progress) => progressEvents.push(progress)),
    );

    assert.equal(result.status, "solved");
    const currentMemory = progressEvents.flatMap(({ counters }) => {
      const value = counters?.memoryCurrentDirectPortfolioBytes;
      return value === undefined || value === 0 ? [] : [value];
    });
    assert.ok(
      currentMemory.some(
        (value, index) =>
          index > 0 && value < (currentMemory[index - 1] ?? 0),
      ),
    );
    assert.ok(
      (result.metrics.counters?.memoryPeakDirectPortfolioBytes ?? 0) >
        (result.metrics.counters?.estimatedMemoryBytes ?? Infinity),
    );
  });

  it("sums parallel engine memory estimates against the global ceiling", async () => {
    const workers: ScriptedWorker[] = [];
    const workerMemoryBytes = 800 * 1024 * 1024;
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 4,
      deviceMemoryGb: 16,
      createWorker: () => {
        const worker = new ScriptedWorker((self) => {
          queueMicrotask(() => {
            self.emit({
              type: "progress",
              status: "searching",
              visited: 0,
              generated: 0,
              frontier: 1,
              performance: { heapUsedBytes: workerMemoryBytes },
            });
            queueMicrotask(() => {
              self.emit({
                type: "done",
                status: "exhausted",
                visited: 0,
                generated: 0,
                frontier: 0,
                performance: { heapUsedBytes: workerMemoryBytes },
              });
            });
          });
        });
        workers.push(worker);
        return worker;
      },
    });
    const request = requestFor(ONE_TYPED_BOX, {
      limits: { maxMemoryBytes: 2 * 1024 * 1024 * 1024 },
    });

    const result = await adapter.solve(request, context());

    assert.equal(workers.length, 3);
    assert.equal(result.status, "unsolved");
    if (result.status !== "unsolved") return;
    assert.equal(result.reason, "limit-reached");
    assert.match(result.detail ?? "", /memory/i);
    assert.equal(workers.every(({ terminated }) => terminated), true);
  });

  it("does not multiply Chromium's process-wide heap sample across workers", async () => {
    const workerMemoryBytes = 800 * 1024 * 1024;
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 4,
      deviceMemoryGb: 16,
      createWorker: () =>
        new ScriptedWorker((self) => {
          queueMicrotask(() => {
            self.emit({
              type: "progress",
              visited: 0,
              generated: 0,
              frontier: 1,
              performance: {
                heapUsedBytes: workerMemoryBytes,
                memory: { source: "browser-performance-memory" },
              },
            });
            queueMicrotask(() => {
              self.emit({
                type: "done",
                status: "exhausted",
                visited: 0,
                generated: 0,
                frontier: 0,
                performance: {
                  heapUsedBytes: workerMemoryBytes,
                  memory: { source: "browser-performance-memory" },
                },
              });
            });
          });
        }),
    });

    const result = await adapter.solve(
      requestFor(ONE_TYPED_BOX, {
        limits: { maxMemoryBytes: 2 * 1024 * 1024 * 1024 },
      }),
      context(),
    );

    assert.equal(result.status, "solved");
  });

  it("counts Chromium's process-wide heap sample once toward the ceiling", async () => {
    const workerMemoryBytes = 800 * 1024 * 1024;
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 2,
      createWorker: () =>
        new ScriptedWorker((self) => {
          queueMicrotask(() => {
            self.emit({
              type: "progress",
              visited: 0,
              generated: 0,
              frontier: 1,
              performance: {
                heapUsedBytes: workerMemoryBytes,
                heapPeakBytes: workerMemoryBytes,
                memory: { source: "browser-performance-memory" },
              },
            });
          });
        }),
    });

    const result = await adapter.solve(
      requestFor(ONE_TYPED_BOX, {
        limits: { maxMemoryBytes: 512 * 1024 * 1024 },
      }),
      context(),
    );

    assert.equal(result.status, "unsolved");
    if (result.status !== "unsolved") return;
    assert.equal(result.reason, "limit-reached");
    assert.equal(
      result.metrics.counters?.peakBrowserProcessMemoryBytes,
      workerMemoryBytes,
    );
    assert.equal(
      result.metrics.counters?.peakEstimatedMemoryBytes,
      workerMemoryBytes,
    );
  });

  it("keeps fallback progress and counters monotonic across engines", async () => {
    const progressEvents: Parameters<
      SolverExecutionContext["reportProgress"]
    >[0][] = [];
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 2,
      createWorker: () =>
        new ScriptedWorker((self) => {
          queueMicrotask(() => {
            self.emit({
              type: "progress",
              status: "searching",
              visited: 7,
              generated: 9,
              frontier: 2,
            });
            queueMicrotask(() => {
              self.emit({
                type: "done",
                status: "exhausted",
                visited: 7,
                generated: 9,
                frontier: 0,
              });
            });
          });
        }),
    });

    const result = await adapter.solve(
      requestFor(ONE_TYPED_BOX),
      context(undefined, (progress) => progressEvents.push(progress)),
    );

    assert.equal(result.status, "solved");
    assert.equal(
      progressEvents.some(({ detail }) =>
        detail?.startsWith("Compatibility fallback"),
      ),
      true,
    );

    const series = [
      {
        label: "expanded states",
        values: progressEvents.flatMap(({ expandedStates }) =>
          expandedStates === undefined ? [] : [expandedStates],
        ),
      },
      {
        label: "generated states",
        values: progressEvents.flatMap(({ generatedStates }) =>
          generatedStates === undefined ? [] : [generatedStates],
        ),
      },
      {
        label: "unique states",
        values: progressEvents.flatMap(({ counters }) =>
          counters?.uniqueStates === undefined
            ? []
            : [counters.uniqueStates],
        ),
      },
    ];
    const regressions = series.flatMap(({ label, values }) =>
      values.flatMap((value, index) =>
        index > 0 && value < (values[index - 1] ?? 0)
          ? [`${label}: ${values[index - 1]} -> ${value}`]
          : [],
      ),
    );

    assert.deepEqual(regressions, []);
  });

  it("decodes compact typed box tokens before building a bidirectional bridge", () => {
    const board = parsePuzzleRows([
      "OOOOO",
      "ORA O",
      "OO OO",
      "OOaOO",
      "OOOOO",
    ]);
    // Dense floor cell 1 contains the A box, so its compact token is "1".
    const meetKey = "0|1";
    const forward = new Map([
      [
        meetKey,
        {
          id: meetKey,
          parent: null,
          segment: "",
          robot: [1, 1] as const,
        },
      ],
    ]);
    const reverse = new Map([
      [
        meetKey,
        {
          id: meetKey,
          parent: null,
          segment: "",
          robot: [1, 3] as const,
        },
      ],
    ]);

    // The box separates this one-cell-wide corridor. Treating the compact key
    // as the obsolete "row,column,label" format would incorrectly walk through it.
    assert.equal(
      reconstructBidirectionalPath(board, meetKey, forward, reverse),
      null,
    );
  });
});
