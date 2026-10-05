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
  SolverProgress,
  SolverRequest,
  SolverSolution,
} from "../../src/solver/contracts.ts";
import {
  createSokomindSolverAdapter,
  reconstructBidirectionalPath,
  semanticDiversityTrace,
  sokomindDiscoveryBeamWidth,
  solutionFromLegacyPath,
  toLegacyState,
  type SokomindEngineWorker,
} from "../../src/solver/implementations/sokomind-solver.ts";
import type { SokomindProofWorker } from "../../src/solver/implementations/sokomind-proof.ts";
import type { ProofStartPartition } from "../../src/solver/implementations/sokomind-proof-protocol.ts";
import { createProofWorkerRuntime } from "../../src/solver/implementations/sokomind-proof-runtime.ts";
import { COORDINATOR_MEMORY_RESERVATION_BYTES } from "../../src/solver/implementations/sokomind-worker-limits.ts";
import { assertValidSolverProgress, assertValidSolverResult } from "../../src/solver/validation.ts";
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

  it("shares the process memory ceiling across concurrent engine workers", async () => {
    const memoryShares: number[] = [];
    const maxMemoryBytes = 2 * 1024 * 1024 * 1024;
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 4,
      deviceMemoryGb: 16,
      createWorker: () =>
        new ScriptedWorker((self, command) => {
          memoryShares.push(command.payload.maxMemoryBytes as number);
          queueMicrotask(() => {
            self.emit({
              type: "done",
              visited: 0,
              generated: 0,
            });
          });
        }),
    });

    await adapter.solve(
      requestFor(ONE_TYPED_BOX, { limits: { maxMemoryBytes } }),
      context(),
    );

    assert.deepEqual(memoryShares, [
      Math.floor(maxMemoryBytes / 3),
      Math.floor(maxMemoryBytes / 3),
      Math.floor(maxMemoryBytes / 3),
    ]);
  });

  for (const [workerParallelism, deterministic, expectedPeak] of [
    [0, false, 3], [1, false, 1], [2, false, 2], [12, true, 1],
  ] as const) {
    it(`caps useful discovery lanes at worker selection ${workerParallelism}, deterministic=${deterministic}`, async () => {
      let active = 0;
      let peak = 0;
      const adapter = createSokomindSolverAdapter({
        hardwareConcurrency: 16,
        createWorker: () => new ScriptedWorker((self) => {
          active += 1;
          peak = Math.max(peak, active);
          queueMicrotask(() => {
            active -= 1;
            self.emit({ type: "done", visited: 0, generated: 0 });
          });
        }),
      });
      await adapter.solve(requestFor(ONE_TYPED_BOX, {
        limits: { maxMemoryBytes: 4_096 * 1024 * 1024 },
        options: { "sokomind-solver": { workerParallelism, deterministic } },
      }), context());
      assert.equal(peak, expectedPeak);
    });
  }

  it("keeps deterministic proof serial even with an explicit parallel ceiling", async () => {
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 16,
      createWorker: () => new ScriptedWorker((self) => {
        queueMicrotask(() => self.emit({ type: "done", path: ["down"], visited: 0, generated: 0 }));
      }),
      createProofWorker: () => { throw new Error("Deterministic proof must remain serial"); },
    });
    const result = await adapter.solve(requestFor(ONE_TYPED_BOX, {
      options: { "sokomind-solver": {
        mode: "optimal", deterministic: true, workerParallelism: 12,
        proofParallelism: 2, harvestElapsedMs: 0, maximumIncumbents: 1,
      } },
    }), context());
    assert.equal(result.status, "solved");
    if (result.status === "solved") assert.equal(result.solution.optimality, "proven");
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

  it("replays semantic diversity from actual box identities and goals", () => {
    const request = requestFor(ONE_TYPED_BOX);
    const solution = solutionFromLegacyPath(request, ["Down"]);
    assert.ok(solution);

    assert.deepEqual(semanticDiversityTrace(request, solution), {
      pushChain: "A@2,2#0:2,2>3,2",
      boxGoals: "A@2,2#0>3,2",
    });
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
    assert.equal(workers.length, 1);
    assert.equal(workers.every(({ terminated }) => terminated), true);
  });

  it("returns long fast-mode routes immediately without a rewrite", async () => {
    const algorithms: unknown[] = [];
    const longRoute = [
      ...Array.from({ length: 50 }, () => ["Left", "Right"] as const).flat(),
      "Down",
    ];
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 2,
      createWorker: () =>
        new ScriptedWorker((self, command) => {
          const algorithm = command.payload.algorithm;
          algorithms.push(algorithm);
          queueMicrotask(() => {
            self.emit({
              type: "done",
              status: "solved",
              path: longRoute,
              visited: 1,
              generated: 1,
            });
          });
        }),
    });

    const result = await adapter.solve(requestFor(ONE_TYPED_BOX), context());

    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;
    assert.deepEqual(algorithms, ["ultimate"]);
    assert.equal(result.solution.moves, 101);
    assert.equal(result.metrics.counters?.initialSolutionMoves, 101);
    assert.equal(result.metrics.counters?.bestSolutionMoves, 101);
    assert.equal(result.metrics.counters?.solutionImprovements, 0);
  });

  it("finishes quality mode without spinning when every repair is ineligible", async () => {
    const algorithms: unknown[] = [];
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 2,
      // Above the one-move route, so every repair is ineligible.
      improvementMinimumMoves: 2,
      createWorker: () => new ScriptedWorker((self, command) => {
        algorithms.push(command.payload.algorithm);
        queueMicrotask(() => self.emit({
          type: "done", status: "solved", path: ["Down"], visited: 1, generated: 1,
        }));
      }),
    });
    const request = requestFor(ONE_TYPED_BOX, {
      options: { "sokomind-solver": { mode: "quality", maximumIncumbents: 1 } },
      // Under 1 s, so half the time left stays below the exact lane's minimum
      // and the repair loop itself runs.
      limits: { maxElapsedMs: 900 },
    });

    const result = await adapter.solve(request, context());
    assert.equal(result.status, "solved");
    assert.deepEqual(algorithms, ["ultimate"]);
    assert.ok(result.metrics.elapsedMs < 500);
    assert.ok((result.metrics.counters?.qualitySlicesCompleted ?? Infinity) <= 2);
  });

  it("replay-verifies and returns a shorter bounded rewrite", async () => {
    const algorithms: unknown[] = [];
    const phases: string[] = [];
    // No improvementMinimumMoves: the default floor admits the 3-move route.
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 2,
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
    const request = requestFor(ONE_TYPED_BOX, {
      options: {
        "sokomind-solver": { mode: "quality", maximumIncumbents: 1 },
      },
    });

    const result = await adapter.solve(
      request,
      context(undefined, ({ phase }) => phases.push(phase)),
    );

    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;
    assert.equal(algorithms[0], "ultimate");
    assert.ok(algorithms.includes("solution-window-rewrite"));
    assert.ok(algorithms.includes("solution-box-reschedule"));
    assert.equal(result.solution.moves, 1);
    assert.equal(result.solution.pushes, 1);
    assert.equal(verifySolverSolution(request, result.solution).valid, true);
    assert.equal(result.metrics.counters?.initialSolutionMoves, 3);
    assert.equal(result.metrics.counters?.bestSolutionMoves, 1);
    assert.ok((result.metrics.counters?.solutionImprovements ?? 0) >= 1);
    assert.ok(phases.includes("improving"));
  });

  for (const memoryMiB of [384, 768, 1536]) for (const mode of ["quality", "optimal"] as const) {
    it(`preserves ${mode} work and memory allocation at ${memoryMiB} MiB`, async () => {
      const commands: WorkerCommand[] = [];
      const adapter = createSokomindSolverAdapter({
        hardwareConcurrency: 2, improvementMinimumMoves: 0,
        improvementMaxVisited: 150_000, improvementMaxElapsedMs: 1000,
        createWorker: () => new ScriptedWorker((self, command) => {
          commands.push(command);
          queueMicrotask(() => self.emit({type: "done", status: "solved",
            path: ["Left", "Right", "Down"],
            visited: command.payload.algorithm === "solution-window-rewrite" ? Number(command.payload.maxVisited) : 1,
            generated: 3}));
        }),
      });
      const request = requestFor(ONE_TYPED_BOX, {
        options: {"sokomind-solver": {mode, maximumIncumbents: 1, harvestElapsedMs: 0}},
        limits: {maxExpandedStates: 120_000, maxGeneratedStates: 200_000, maxMemoryBytes: memoryMiB * 1024 ** 2},
      });
      const result = await adapter.solve(request, context());
      const window = commands.find(command => command.payload.algorithm === "solution-window-rewrite");
      const repair = commands.find(command => command.payload.algorithm === "solution-box-reschedule");
      assert.ok(window && repair);
      const windowWork = memoryMiB === 384 ? 20_000 : memoryMiB === 768 ? 35_000 : 50_000;
      assert.equal(window.payload.maxVisited, windowWork);
      assert.equal(repair.payload.maxVisited, mode === "quality" ? 119_999 - windowWork :
        Math.min(119_999 - windowWork, memoryMiB === 384 ? 20_000 : memoryMiB === 768 ? 35_000 : Infinity));
      assert.equal(repair.payload.maxGenerated, 199_994);
      assert.ok(Number(repair.payload.maxMemoryBytes) > 0);
      assert.ok(Number(repair.payload.maxMemoryBytes) <= request.limits!.maxMemoryBytes!);
      assert.equal(result.status, "solved");
      if (result.status === "solved") assert.ok(verifySolverSolution(request, result.solution).valid);
    });
  }

  it("retains a replayed repair publication when live memory stops the worker", async () => {
    const workers: ScriptedWorker[] = [];
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 2, improvementMinimumMoves: 0, improvementMaxVisited: 150_000,
      createWorker: () => {
        const worker = new ScriptedWorker((self, command) => queueMicrotask(() => {
          if (command.payload.algorithm === "solution-box-reschedule") {
            self.emit({type: "progress", visited: 21_000, generated: 22_000, retained: 22_000, path: ["Down"]});
            self.emit({type: "progress", visited: 22_000, generated: 300_000, retained: 300_000});
          } else {
            self.emit({type: "done", status: "solved", path: ["Left", "Right", "Down"], visited: 1, generated: 3});
          }
        }));
        workers.push(worker); return worker;
      },
    });
    const request = requestFor(ONE_TYPED_BOX, {
      options: {"sokomind-solver": {mode: "quality", maximumIncumbents: 1, harvestElapsedMs: 0}},
      limits: {maxExpandedStates: 200_000, maxGeneratedStates: 2_000_000, maxMemoryBytes: 384 * 1024 ** 2},
    });
    const result = await adapter.solve(request, context());
    assert.equal(result.status, "solved");
    assert.equal(result.metrics.counters?.bestSolutionMoves, 1);
    assert.ok(Number(result.metrics.counters?.peakEstimatedMemoryBytes) >= request.limits!.maxMemoryBytes!);
    assert.ok(workers.every(worker => worker.terminated));
    if (result.status === "solved") assert.ok(verifySolverSolution(request, result.solution).valid);
  });

  for (const publication of ["valid", "invalid", "at-limit", "over-limit"] as const) {
    it(`handles a ${publication} repair publication before shared-budget termination`, async () => {
      const workers: ScriptedWorker[] = [];
      const adapter = createSokomindSolverAdapter({
        hardwareConcurrency: 2, improvementMinimumMoves: 0,
        improvementMaxVisited: 100, improvementMaxElapsedMs: 1000,
        createWorker: () => {
          const worker = new ScriptedWorker((self, command) => queueMicrotask(() => {
            if (command.payload.algorithm === "solution-box-reschedule") {
              self.emit({type: "progress",
                visited: publication === "at-limit" ? 59 : publication === "over-limit" ? 60 : 10,
                generated: 10, path: publication === "invalid" ? ["Up"] : ["Down"]});
              // No terminal route is delivered: the coordinator must stop at the
              // aggregate limit and retain only replayed candidates whose work
              // stayed within it.
              self.emit({type: "progress", visited: 59, generated: 20});
            } else {
              self.emit({type: "done", status: "solved", path: ["Left", "Right", "Down"],
                visited: command.payload.algorithm === "ultimate" ? 1 : 40, generated: 3});
            }
          }));
          workers.push(worker);
          return worker;
        },
      });
      const request = requestFor(ONE_TYPED_BOX, {
        options: {"sokomind-solver": {mode: "quality", maximumIncumbents: 1, harvestElapsedMs: 0}},
        limits: {maxExpandedStates: 100, maxGeneratedStates: 120},
      });
      const result = await adapter.solve(request, context());
      assert.equal(result.status, "solved");
      if (result.status !== "solved") return;
      const kept = publication === "valid" || publication === "at-limit";
      assert.equal(result.solution.moves, kept ? 1 : 3);
      assert.equal(result.metrics.counters?.bestSolutionMoves, kept ? 1 : 3);
      assert.equal(result.metrics.expandedStates, publication === "over-limit" ? 101 : 100);
      assert.equal(verifySolverSolution(request, result.solution).valid, true);
      assert.ok(workers.every(worker => worker.terminated));
    });
  }

  for (const repairOutcome of ["better", "unchanged", "invalid", "failed", "timeout", "cancelled"] as const) {
    it(`retains a verified incumbent and shared budgets when rescheduling is ${repairOutcome}`, async () => {
      const commands: WorkerCommand[] = [];
      const workers: ScriptedWorker[] = [];
      const controller = new AbortController();
      const adapter = createSokomindSolverAdapter({
        hardwareConcurrency: 2,
        improvementMinimumMoves: 0,
        improvementMaxVisited: 100,
        improvementMaxElapsedMs: 100,
        createWorker: () => {
          const worker = new ScriptedWorker((self, command) => {
            commands.push(command);
            queueMicrotask(() => {
              if (command.payload.algorithm === "solution-box-reschedule") {
                if (repairOutcome === "cancelled") { controller.abort(); return; }
                if (repairOutcome === "timeout") return;
                self.emit({ type: "done", visited: 5, generated: 8,
                  ...(repairOutcome === "failed" ? {status: "failed", error: "Repair failed"} : {
                    status: "solved", path: repairOutcome === "better" ? ["Down"] :
                      repairOutcome === "invalid" ? ["Up"] : ["Left", "Right", "Down"],
                  }),
                });
              } else {
                // Local windows cannot improve this incumbent; rescheduling must
                // still run, sharing the improvement budget with them.
                const visitedCap = Number(command.payload.maxVisited) || 40;
                self.emit({type: "done", status: "solved", path: ["Left", "Right", "Down"],
                  visited: command.payload.algorithm === "ultimate" ? 1 : Math.min(40, visitedCap),
                  generated: command.payload.algorithm === "ultimate" ? 3 : 7});
              }
            });
          });
          workers.push(worker); return worker;
        },
      });
      const request = requestFor(ONE_TYPED_BOX, {
        options: {"sokomind-solver": {mode: "quality", maximumIncumbents: 1}},
        limits: {maxExpandedStates: 1000, maxGeneratedStates: 120},
      });
      const result = await adapter.solve(request, context(controller.signal));
      const repair = commands.find(command => command.payload.algorithm === "solution-box-reschedule");
      assert.ok(repair);
      assert.equal(repair.payload.maxVisited, 60);
      assert.equal(repair.payload.maxGenerated, 110);
      assert.ok(Number(repair.payload.rescheduleMaxMs) > 0 && Number(repair.payload.rescheduleMaxMs) <= 100);
      assert.deepEqual(repair.payload.solutionPath, ["Left", "Right", "Down"]);
      assert.ok(workers.every(worker => worker.terminated));
      const totalExpanded = result.metrics.expandedStates ?? 0;
      assert.ok(totalExpanded <= 101, `expandedStates=${totalExpanded} exceeded 101`);
      assert.ok((result.metrics.generatedStates ?? 0) <= 120);
      if (repairOutcome === "cancelled") { assert.equal(result.status, "cancelled"); return; }
      assert.equal(result.status, "solved");
      if (result.status !== "solved") return;
      // Quality does not dispatch proof; the returned route is the improvement result.
      assert.equal(result.metrics.counters?.bestSolutionMoves, repairOutcome === "better" ? 1 : 3);
      assert.equal(result.solution.moves, repairOutcome === "better" ? 1 : 3);
      assert.equal(result.solution.optimality, "unknown");
      assert.equal(verifySolverSolution(request, result.solution).valid, true);
    });
  }

  it("harvests multiple seeded ordering profiles before stopping on duplicates", async () => {
    const harvestPayloads: Array<Readonly<Record<string, unknown>>> = [];
    let seededRoute = 0;
    const routes = [
      ["Left", "Right", "Down"],
      ["Right", "Left", "Down"],
      ["Left", "Right", "Right", "Left", "Down"],
    ] as const;
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 4,
      deviceMemoryGb: 16,
      createWorker: () =>
        new ScriptedWorker((self, command) => {
          const seeded = typeof command.payload.seed === "number";
          if (seeded) harvestPayloads.push(command.payload);
          const path = seeded
            ? routes[seededRoute++ % routes.length]
            : routes[0];
          queueMicrotask(() => {
            self.emit({
              type: "done",
              status: "solved",
              path,
              visited: 1,
              generated: 1,
            });
          });
        }),
    });
    const request = requestFor(ONE_TYPED_BOX, {
      options: {
        "sokomind-solver": {
          mode: "quality",
          maximumIncumbents: 4,
          harvestElapsedMs: 2000,
        },
      },
    });

    const result = await adapter.solve(request, context());

    assert.equal(result.status, "solved");
    assert.equal(harvestPayloads.length, 6);
    assert.equal(
      new Set(harvestPayloads.map(({ seed }) => seed)).size,
      6,
    );
    assert.deepEqual(
      new Set(harvestPayloads.map(({ beamProfile }) => beamProfile)),
      new Set(["balanced", "detour", "milestone"]),
    );
  });

  for (const mode of ["quality", "optimal"] as const) {
    it(`publishes the verified discovery route before ${mode} harvest finishes`, async () => {
      const events: Array<{ progress: SolverProgress; harvestReplies: number }> = [];
      let harvestReplies = 0;
      const adapter = createSokomindSolverAdapter({
        hardwareConcurrency: 2,
        createWorker: () =>
          new ScriptedWorker((self, command) => {
            // Discovery answers at once; seeded harvest workers answer later
            // with a shorter route.
            const seeded = typeof command.payload.seed === "number";
            const reply = () => {
              if (seeded) harvestReplies += 1;
              self.emit({
                type: "done",
                status: "solved",
                path: seeded ? ["Down"] : ["Left", "Right", "Down"],
                visited: 1,
                generated: 1,
              });
            };
            if (seeded) setTimeout(reply, 20);
            else queueMicrotask(reply);
          }),
      });
      const request = requestFor(ONE_TYPED_BOX, {
        options: {
          "sokomind-solver": { mode, maximumIncumbents: 2, harvestElapsedMs: 500 },
        },
      });

      const result = await adapter.solve(
        request,
        context(undefined, (progress) => events.push({ progress, harvestReplies })),
      );

      assert.equal(result.status, "solved");
      if (result.status !== "solved") return;
      assert.equal(result.solution.moves, 1);
      assert.equal(verifySolverSolution(request, result.solution).valid, true);
      const first = events.find(({ progress }) => progress.incumbent !== undefined);
      assert.ok(first);
      assert.equal(first.progress.phase, "harvesting");
      assert.equal(first.harvestReplies, 0);
      assert.equal(first.progress.incumbent?.moves, 3);
      assert.equal(first.progress.upperBound, 3);
      const upperBounds = events.flatMap(({ progress }) =>
        progress.upperBound === undefined ? [] : [progress.upperBound]);
      assert.ok(upperBounds.includes(1));
      for (let index = 1; index < upperBounds.length; index += 1) {
        assert.ok(upperBounds[index] <= upperBounds[index - 1], `upper bound rose: ${upperBounds}`);
      }
      if (mode === "quality") {
        assert.equal(result.solution.optimality, "unknown");
        assert.ok(events.every(({ progress }) =>
          progress.lowerBound === undefined && progress.gap === undefined));
      }
    });

    it(`returns the published discovery route when time ends during ${mode} harvest`, async () => {
      const adapter = createSokomindSolverAdapter({
        hardwareConcurrency: 2,
        createWorker: () =>
          new ScriptedWorker((self, command) => {
            // Harvest workers never answer, so the request deadline ends harvest.
            if (typeof command.payload.seed === "number") return;
            queueMicrotask(() => self.emit({
              type: "done",
              status: "solved",
              path: ["Left", "Right", "Down"],
              visited: 1,
              generated: 1,
            }));
          }),
      });
      const request = requestFor(ONE_TYPED_BOX, {
        options: {
          "sokomind-solver": { mode, maximumIncumbents: 2, harvestElapsedMs: 5_000 },
        },
        limits: { maxElapsedMs: 400 },
      });

      const result = await adapter.solve(request, context());

      assert.equal(result.status, "solved");
      if (result.status !== "solved") return;
      assert.equal(result.solution.moves, 3);
      assert.notEqual(result.solution.optimality, "proven");
      assert.equal(verifySolverSolution(request, result.solution).valid, true);
    });
  }

  /** The worker host's checks: valid events whose bounds never move the wrong way. */
  function assertHostAcceptsProgress(events: readonly SolverProgress[]): void {
    for (const [index, progress] of events.entries()) {
      assertValidSolverProgress(progress);
      const previous = events[index - 1];
      if (previous === undefined) continue;
      if (previous.lowerBound !== undefined && progress.lowerBound !== undefined) {
        assert.ok(progress.lowerBound >= previous.lowerBound, `lower bound fell at event ${index}`);
      }
      if (previous.upperBound !== undefined && progress.upperBound !== undefined) {
        assert.ok(progress.upperBound <= previous.upperBound, `upper bound rose at event ${index}`);
      }
      if (previous.gap !== undefined && progress.gap !== undefined) {
        assert.ok(progress.gap <= previous.gap, `gap rose at event ${index}`);
      }
    }
  }

  function discoveryOnlyWorker(
    path: readonly string[],
    commands: WorkerCommand[],
  ): () => SokomindEngineWorker {
    return () => new ScriptedWorker((self, command) => {
      commands.push(command);
      queueMicrotask(() => self.emit({
        type: "done", status: "solved", path, visited: 1, generated: 3,
      }));
    });
  }

  it("proves a small Optimal board before harvest, rewrite or rescheduling", async () => {
    const commands: WorkerCommand[] = [];
    const events: SolverProgress[] = [];
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 2,
      createWorker: discoveryOnlyWorker(["Left", "Right", "Down"], commands),
    });
    const request = requestFor(ONE_TYPED_BOX, {
      options: { "sokomind-solver": { mode: "optimal", maximumIncumbents: 2 } },
      limits: { maxElapsedMs: 5_000 },
    });

    const result = await adapter.solve(request, context(undefined, (progress) => events.push(progress)));

    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;
    assert.equal(result.solution.moves, 1);
    assert.equal(result.solution.optimality, "proven");
    assert.equal(result.proof?.kind, "optimal");
    assert.equal(verifySolverSolution(request, result.solution).valid, true);
    assert.ok(commands.length > 0);
    // Discovery only: no seeded harvest lane, window rewrite or box reschedule.
    const improvementAlgorithms = new Set(["solution-window-rewrite", "solution-box-reschedule"]);
    assert.ok(commands.every((command) =>
      typeof command.payload.seed !== "number" &&
      !improvementAlgorithms.has(String(command.payload.algorithm))),
    JSON.stringify(commands.map((command) => command.payload.algorithm ?? command.payload.seed)));
    const proving = events.find((progress) => progress.phase === "proving");
    assert.ok(proving);
    assert.equal(proving.upperBound, 3);
    assert.ok(events.every((progress) => progress.phase !== "harvesting"));
    // The capped proof's own bounds are not forwarded; only the published
    // incumbent's upper bound is.
    assert.ok(events.every((progress) =>
      progress.lowerBound === undefined && progress.gap === undefined));
    assertHostAcceptsProgress(events);
    assert.equal(typeof result.metrics.counters?.proofFirstElapsedMs, "number");
  });

  it("skips proof-first in deterministic Optimal runs", async () => {
    const commands: WorkerCommand[] = [];
    const events: SolverProgress[] = [];
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 2,
      createWorker: discoveryOnlyWorker(["Left", "Right", "Down"], commands),
    });
    const request = requestFor(ONE_TYPED_BOX, {
      options: { "sokomind-solver": { mode: "optimal", deterministic: true, maximumIncumbents: 2 } },
      limits: { maxElapsedMs: 5_000 },
    });

    const result = await adapter.solve(request, context(undefined, (progress) => events.push(progress)));

    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;
    assert.equal(result.solution.optimality, "proven");
    const harvesting = events.findIndex((progress) => progress.phase === "harvesting");
    const proving = events.findIndex((progress) => progress.phase === "proving");
    assert.ok(harvesting >= 0);
    assert.ok(proving === -1 || harvesting < proving);
    assert.ok(commands.some((command) => typeof command.payload.seed === "number"));
    assert.equal(result.metrics.counters?.proofFirstElapsedMs, undefined);
  });

  it("follows a timed-out proof-first attempt with the pipeline proof and keeps bounds monotone", async () => {
    const events: SolverProgress[] = [];
    let proofWorkers = 0;
    // Proof lanes never answer, so each proof ends at its own deadline.
    const silentProofWorker = (): SokomindProofWorker => {
      proofWorkers += 1;
      return {
        postMessage() {},
        addEventListener() {},
        removeEventListener() {},
        terminate() {},
      };
    };
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 4,
      createWorker: discoveryOnlyWorker(["Left", "Right", "Down"], []),
      createProofWorker: silentProofWorker,
      // Checkpoint hooks keep the sequential proof-first path.
      checkpointOptions: { solverVersion: "test" },
    });
    const request = requestFor(ONE_TYPED_BOX, {
      options: {
        "sokomind-solver": { mode: "optimal", proofParallelism: 2, maximumIncumbents: 2, harvestElapsedMs: 100 },
      },
      limits: { maxElapsedMs: 2_000 },
    });

    const result = await adapter.solve(request, context(undefined, (progress) => events.push(progress)));

    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;
    assert.equal(result.solution.moves, 3);
    assert.notEqual(result.solution.optimality, "proven");
    assert.notEqual(result.proof?.kind, "optimal");
    assert.equal(verifySolverSolution(request, result.solution).valid, true);
    const proofFirst = events.findIndex((progress) => /small board first/u.test(progress.detail ?? ""));
    const harvesting = events.findIndex((progress) => progress.phase === "harvesting");
    const pipelineBound = events.findIndex((progress) => progress.lowerBound !== undefined);
    assert.ok(proofFirst >= 0 && harvesting > proofFirst, "proof-first runs before harvest");
    assert.ok(pipelineBound > harvesting, "the pipeline proof reports its own lower bound");
    assert.ok(events.slice(0, pipelineBound).every((progress) => progress.gap === undefined));
    assertHostAcceptsProgress(events);
    assert.ok(proofWorkers >= 2, "each proof starts its own lanes");
    assert.equal(typeof result.metrics.counters?.proofFirstElapsedMs, "number");
  });

  it("skips proof-first under a state limit and proves through the pipeline", async () => {
    // The capped attempt limits only its time, so it would spend the state
    // budget the pipeline's proof needs.
    for (const stateLimit of [{ maxExpandedStates: 10_000 }, { maxGeneratedStates: 100_000 }]) {
      const events: SolverProgress[] = [];
      const adapter = createSokomindSolverAdapter({
        hardwareConcurrency: 2,
        createWorker: discoveryOnlyWorker(["Left", "Right", "Down"], []),
      });
      const request = requestFor(ONE_TYPED_BOX, {
        options: { "sokomind-solver": { mode: "optimal", maximumIncumbents: 2 } },
        limits: { ...stateLimit, maxElapsedMs: 5_000 },
      });

      const result = await adapter.solve(request, context(undefined, (progress) => events.push(progress)));

      const label = JSON.stringify(stateLimit);
      assert.equal(result.status, "solved", label);
      if (result.status !== "solved") return;
      assert.equal(result.solution.moves, 1, label);
      assert.equal(result.solution.optimality, "proven", label);
      assert.equal(result.proof?.kind, "optimal", label);
      assert.ok(events.every((progress) => !/small board first/u.test(progress.detail ?? "")), label);
      const harvesting = events.findIndex((progress) => progress.phase === "harvesting");
      const proving = events.findIndex((progress) => progress.phase === "proving");
      assert.ok(harvesting >= 0 && proving > harvesting, label);
      assertHostAcceptsProgress(events);
      assert.equal(result.metrics.counters?.proofFirstElapsedMs, undefined, label);
      assert.equal(result.metrics.counters?.proofFirstExpandedStates, undefined, label);
    }
  });

  it("never reports a limit-cut pipeline proof as proven", async () => {
    const twoGenericBoxes: PuzzleDefinition = {
      id: "two-generic-boxes",
      title: "Two generic boxes",
      difficulty: "tutorial",
      boxes: 2,
      rows: ["OOOOOOO", "O SS  O", "O XX  O", "O  R  O", "O     O", "OOOOOOO"],
    };
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 2,
      createWorker: discoveryOnlyWorker(["Left", "Right", "Up", "Down", "Left", "Up"], []),
    });
    // Discovery spends one expansion, leaving the proof at most one.
    const request = requestFor(twoGenericBoxes, {
      options: { "sokomind-solver": { mode: "optimal", maximumIncumbents: 2 } },
      limits: { maxExpandedStates: 2, maxElapsedMs: 5_000 },
    });

    const result = await adapter.solve(request, context());

    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;
    assert.equal(result.solution.moves, 6);
    assert.notEqual(result.solution.optimality, "proven");
    assert.notEqual(result.proof?.kind, "optimal");
    assert.equal(verifySolverSolution(request, result.solution).valid, true);
    assert.equal(result.metrics.counters?.proofFirstExpandedStates, undefined);
  });

  it("improves a small Quality board through the exact lane without claiming proof", async () => {
    const commands: WorkerCommand[] = [];
    const events: SolverProgress[] = [];
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 2,
      createWorker: discoveryOnlyWorker(["Left", "Right", "Down"], commands),
    });
    const request = requestFor(ONE_TYPED_BOX, {
      options: { "sokomind-solver": { mode: "quality", maximumIncumbents: 2 } },
      limits: { maxElapsedMs: 5_000 },
    });

    const result = await adapter.solve(request, context(undefined, (progress) => events.push(progress)));

    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;
    assert.equal(result.solution.moves, 1);
    assert.equal(result.solution.optimality, "unknown");
    assert.equal(result.proof, undefined);
    assert.equal(verifySolverSolution(request, result.solution).valid, true);
    assert.equal(result.metrics.counters?.bestSolutionMoves, 1);
    // Discovery only: no seeded harvest lane, window rewrite or box reschedule.
    const improvementAlgorithms = new Set(["solution-window-rewrite", "solution-box-reschedule"]);
    assert.ok(commands.every((command) =>
      typeof command.payload.seed !== "number" &&
      !improvementAlgorithms.has(String(command.payload.algorithm))),
    JSON.stringify(commands.map((command) => command.payload.algorithm ?? command.payload.seed)));
    assert.ok(events.some((progress) => /small board exactly/u.test(progress.detail ?? "")));
    assert.ok(events.some((progress) => progress.upperBound === 1));
    // Quality never shows proof: no proving phase, lower bound, gap or
    // optimality wording, even while the lane's proof runs.
    assert.ok(events.every((progress) =>
      progress.phase !== "proving" && progress.phase !== "harvesting" &&
      progress.lowerBound === undefined && progress.gap === undefined &&
      !/optimality/iu.test(progress.detail ?? "")));
    assertHostAcceptsProgress(events);
    assert.equal(typeof result.metrics.counters?.proofFirstElapsedMs, "number");
  });

  it("skips the Quality exact lane in deterministic runs", async () => {
    const events: SolverProgress[] = [];
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 2,
      createWorker: discoveryOnlyWorker(["Left", "Right", "Down"], []),
    });
    const request = requestFor(ONE_TYPED_BOX, {
      options: { "sokomind-solver": { mode: "quality", deterministic: true, maximumIncumbents: 2 } },
      limits: { maxElapsedMs: 5_000 },
    });

    const result = await adapter.solve(request, context(undefined, (progress) => events.push(progress)));

    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;
    assert.equal(result.solution.optimality, "unknown");
    assert.ok(events.some((progress) => progress.phase === "harvesting"));
    assert.ok(events.every((progress) => !/small board exactly/u.test(progress.detail ?? "")));
    assert.equal(result.metrics.counters?.proofFirstElapsedMs, undefined);
  });

  it("skips the Quality exact lane under a state limit", async () => {
    for (const stateLimit of [{ maxExpandedStates: 10_000 }, { maxGeneratedStates: 100_000 }]) {
      const events: SolverProgress[] = [];
      const adapter = createSokomindSolverAdapter({
        hardwareConcurrency: 2,
        createWorker: discoveryOnlyWorker(["Left", "Right", "Down"], []),
      });
      const request = requestFor(ONE_TYPED_BOX, {
        options: { "sokomind-solver": { mode: "quality", maximumIncumbents: 2 } },
        limits: { ...stateLimit, maxElapsedMs: 5_000 },
      });

      const result = await adapter.solve(request, context(undefined, (progress) => events.push(progress)));

      const label = JSON.stringify(stateLimit);
      assert.equal(result.status, "solved", label);
      if (result.status !== "solved") return;
      assert.equal(result.solution.optimality, "unknown", label);
      assert.equal(result.proof, undefined, label);
      assert.equal(verifySolverSolution(request, result.solution).valid, true, label);
      assert.ok(events.every((progress) => !/small board exactly/u.test(progress.detail ?? "")), label);
      assert.equal(result.metrics.counters?.proofFirstElapsedMs, undefined, label);
    }
  });

  it("continues Quality past a timed-out exact lane without its bounds", async () => {
    const events: SolverProgress[] = [];
    let proofWorkers = 0;
    // Proof lanes never answer, so the lane ends at its own deadline.
    const silentProofWorker = (): SokomindProofWorker => {
      proofWorkers += 1;
      return {
        postMessage() {},
        addEventListener() {},
        removeEventListener() {},
        terminate() {},
      };
    };
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 4,
      createWorker: discoveryOnlyWorker(["Left", "Right", "Down"], []),
      createProofWorker: silentProofWorker,
    });
    const request = requestFor(ONE_TYPED_BOX, {
      options: {
        "sokomind-solver": { mode: "quality", proofParallelism: 2, maximumIncumbents: 2, harvestElapsedMs: 100 },
      },
      limits: { maxElapsedMs: 2_000 },
    });

    const result = await adapter.solve(request, context(undefined, (progress) => events.push(progress)));

    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;
    assert.equal(result.solution.moves, 3);
    assert.equal(result.solution.optimality, "unknown");
    assert.equal(result.proof, undefined);
    assert.equal(verifySolverSolution(request, result.solution).valid, true);
    const lane = events.findIndex((progress) => /small board exactly/u.test(progress.detail ?? ""));
    const harvesting = events.findIndex((progress) => progress.phase === "harvesting");
    assert.ok(lane >= 0 && harvesting > lane, "the exact lane runs before harvest");
    assert.ok(events.every((progress) =>
      progress.phase !== "proving" && progress.lowerBound === undefined && progress.gap === undefined));
    assertHostAcceptsProgress(events);
    assert.ok(proofWorkers >= 2, "the lane starts its own proof lanes");
    assert.equal(typeof result.metrics.counters?.proofFirstElapsedMs, "number");
  });

  /**
   * A proof worker that runs the real proof runtime inline. `hold` may delay a
   * partition's start: until it resolves the lane stays silent, and a cancel
   * meanwhile ends the partition idle.
   */
  function inlineProofWorker(
    hold: (start: ProofStartPartition) => Promise<void> | undefined,
    starts: ProofStartPartition[] = [],
  ): () => SokomindProofWorker {
    return () => {
      const listeners = new Set<(event: { data: unknown }) => void>();
      let terminated = false;
      let held: ProofStartPartition | undefined;
      const deliver = (data: unknown): void => queueMicrotask(() => {
        if (terminated) return;
        for (const listener of [...listeners]) listener({ data });
      });
      const runtime = createProofWorkerRuntime(deliver);
      return {
        postMessage(message) {
          if (message.type === "proof/start-partition") {
            starts.push(message);
            const gate = hold(message);
            if (gate === undefined) {
              runtime(message);
              return;
            }
            held = message;
            void gate.then(() => {
              if (terminated || held !== message) return;
              held = undefined;
              deliver({
                type: "proof/progress",
                runId: message.runId,
                partitionId: message.partitionId,
                lowerBound: message.prefixCost,
                expandedStates: 0,
              });
              runtime(message);
            });
            return;
          }
          if (message.type === "proof/cancel" && held !== undefined) {
            const { runId, partitionId } = held;
            held = undefined;
            deliver({ type: "proof/idle", runId, partitionId });
            return;
          }
          runtime(message);
        },
        addEventListener(type: string, listener: unknown) {
          if (type === "message") listeners.add(listener as (event: { data: unknown }) => void);
        },
        removeEventListener(type: string, listener: unknown) {
          if (type === "message") listeners.delete(listener as (event: { data: unknown }) => void);
        },
        terminate() {
          terminated = true;
          held = undefined;
          listeners.clear();
          runtime({ type: "proof/cancel" });
        },
      };
    };
  }

  /**
   * A proof worker whose lane finds `route` at once and never completes its
   * partition, so the proof ends at its deadline holding that route.
   */
  function routeProofWorker(route: SolverSolution): () => SokomindProofWorker {
    return () => {
      const listeners = new Set<(event: { data: unknown }) => void>();
      let active: ProofStartPartition | undefined;
      const deliver = (data: unknown): void => queueMicrotask(() => {
        for (const listener of [...listeners]) listener({ data });
      });
      return {
        postMessage(message) {
          if (message.type === "proof/start-partition") {
            active = message;
            const { runId, partitionId } = message;
            deliver({
              type: "proof/progress", runId, partitionId, lowerBound: message.prefixCost, expandedStates: 0,
            });
            deliver({ type: "proof/solution", runId, partitionId, solution: route, totalCost: route.moves });
            return;
          }
          if (message.type === "proof/cancel" && active !== undefined) {
            const { runId, partitionId } = active;
            active = undefined;
            deliver({ type: "proof/idle", runId, partitionId });
          }
        },
        addEventListener(type: string, listener: unknown) {
          if (type === "message") listeners.add(listener as (event: { data: unknown }) => void);
        },
        removeEventListener(type: string, listener: unknown) {
          if (type === "message") listeners.delete(listener as (event: { data: unknown }) => void);
        },
        terminate() {
          active = undefined;
          listeners.clear();
        },
      };
    };
  }

  /** The move count a partition may still beat, counted from the start. */
  function globalBound(start: ProofStartPartition): number {
    return start.prefixCost + start.initialUpperBound;
  }

  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const never = (): Promise<void> => new Promise(() => {});

  /**
   * Discovery and rewrites answer `path`; seeded harvest lanes answer
   * `seededPath`, or stay silent until the harvest ends without it.
   */
  function harvestWorker(
    path: readonly string[],
    seededPath?: readonly string[],
  ): () => SokomindEngineWorker {
    return () => new ScriptedWorker((self, command) => {
      const seeded = typeof command.payload.seed === "number";
      if (seeded && seededPath === undefined) return;
      queueMicrotask(() => self.emit({
        type: "done", status: "solved", path: seeded ? seededPath : path, visited: 1, generated: 1,
      }));
    });
  }

  /** A small board with two proof lanes, so its proof runs beside the improvement. */
  function anytimeRequest(
    limits: SolverRequest["limits"],
    harvestElapsedMs?: number,
    mode: "optimal" | "quality" = "optimal",
  ): SolverRequest {
    return requestFor(ONE_TYPED_BOX, {
      options: {
        "sokomind-solver": {
          mode,
          proofParallelism: 2,
          maximumIncumbents: 2,
          ...(harvestElapsedMs === undefined ? {} : { harvestElapsedMs }),
        },
      },
      limits,
    });
  }

  /** Progress that would show proof to a Quality user. */
  const PROOF_WORDING = /\b(proof|proving|proven|optimal(ity)?)\b/iu;

  it("returns a small Optimal board proven within the anytime proof's head start", async () => {
    const commands: WorkerCommand[] = [];
    const events: SolverProgress[] = [];
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 4,
      createWorker: discoveryOnlyWorker(["Left", "Right", "Down"], commands),
      createProofWorker: inlineProofWorker(() => undefined),
    });
    const request = anytimeRequest({ maxElapsedMs: 30_000 });
    const startedAt = performance.now();

    const result = await adapter.solve(request, context(undefined, (progress) => events.push(progress)));

    // The head start is 5 s; the proof ends well inside it.
    assert.ok(performance.now() - startedAt < 4_500);
    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;
    assert.equal(result.solution.moves, 1);
    assert.equal(result.solution.optimality, "proven");
    assert.equal(result.proof?.kind, "optimal");
    assert.equal(verifySolverSolution(request, result.solution).valid, true);
    assert.ok(events.every((progress) => progress.phase !== "harvesting"));
    assert.ok(commands.every((command) => typeof command.payload.seed !== "number"));
    assertHostAcceptsProgress(events);
    assert.equal(typeof result.metrics.counters?.proofFirstElapsedMs, "number");
  });

  it("proves a small Optimal board while the route improvement runs beside it", async () => {
    const events: SolverProgress[] = [];
    const starts: ProofStartPartition[] = [];
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 4,
      createWorker: harvestWorker(["Left", "Right", "Down"]),
      // The proof finishes after its 5 s head start, during the 3 s harvest.
      createProofWorker: inlineProofWorker(() => delay(5_500), starts),
    });
    const maxMemoryBytes = 4 * 1024 * 1024 * 1024;
    const request = anytimeRequest({ maxElapsedMs: 30_000, maxMemoryBytes }, 3_000);
    const startedAt = performance.now();

    const result = await adapter.solve(request, context(undefined, (progress) => events.push(progress)));

    assert.ok(performance.now() - startedAt < 7_500, "the proof's result does not wait for the harvest");
    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;
    assert.equal(result.solution.moves, 1);
    assert.equal(result.solution.optimality, "proven");
    assert.equal(result.proof?.kind, "optimal");
    assert.equal(verifySolverSolution(request, result.solution).valid, true);
    assert.ok(events.some((progress) => progress.phase === "harvesting"));
    // The proof leaves an eighth of the shared memory to the engines. The
    // board's four first pushes give both proof lanes a share of the rest.
    const planBytes = maxMemoryBytes - COORDINATOR_MEMORY_RESERVATION_BYTES;
    const laneBytes = Math.floor((planBytes - Math.floor(planBytes * 0.125)) / 2);
    assert.ok(starts.length > 0);
    assert.ok(starts.every((start) => start.request.limits?.maxMemoryBytes === laneBytes),
      JSON.stringify(starts.map((start) => start.request.limits?.maxMemoryBytes)));
    assertHostAcceptsProgress(events);
  });

  it("keeps the anytime proof running when the harvest finds a shorter route", async () => {
    const events: SolverProgress[] = [];
    const starts: ProofStartPartition[] = [];
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let harvested = false;
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 4,
      createWorker: harvestWorker(["Left", "Right", "Down"], ["Down"]),
      createProofWorker: inlineProofWorker(() => released, starts),
    });
    const request = anytimeRequest({ maxElapsedMs: 5_000 }, 300);

    const result = await adapter.solve(request, context(undefined, (progress) => {
      events.push(progress);
      if (progress.phase === "harvesting") harvested = true;
      if (harvested && progress.detail === "Proving the small board.") release();
    }));

    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;
    assert.equal(result.solution.moves, 1);
    assert.equal(result.solution.optimality, "proven");
    assert.equal(result.proof?.kind, "optimal");
    assert.equal(verifySolverSolution(request, result.solution).valid, true);
    // The proof from the 3-move route continued; no second proof started.
    assert.deepEqual(starts.map(globalBound), [3]);
    const harvesting = events.findIndex((progress) => progress.phase === "harvesting");
    const handoff = events.findIndex((progress, index) =>
      index > harvesting && progress.detail === "Proving the small board.");
    assert.ok(harvesting >= 0 && handoff > harvesting, "the hand-off follows the improvement");
    const proving = events.slice(handoff);
    assert.ok(proving.every((progress) => (progress.upperBound ?? 1) <= 1),
      "progress keeps the harvested route as its upper bound");
    assert.ok(proving.some((progress) => progress.lowerBound !== undefined),
      "the proof's lower bound reaches progress");
    assertHostAcceptsProgress(events);
  });

  it("returns the shorter route with the anytime proof's bounds when it times out", async () => {
    const events: SolverProgress[] = [];
    const starts: ProofStartPartition[] = [];
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 4,
      createWorker: harvestWorker(["Left", "Right", "Down"], ["Down"]),
      createProofWorker: inlineProofWorker(never, starts),
    });
    const request = anytimeRequest({ maxElapsedMs: 2_000 }, 300);

    const result = await adapter.solve(request, context(undefined, (progress) => events.push(progress)));

    assertValidSolverResult(result);
    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;
    assert.equal(result.solution.moves, 1);
    assert.equal(result.solution.optimality, "unknown");
    const proof = result.proof;
    assert.ok(proof);
    assert.equal(proof.kind, "bounded");
    assert.equal(proof.upperBound, 1);
    // The proof never finished, so its bound stays below the route it did
    // not find.
    const lowerBound = proof.lowerBound ?? Infinity;
    assert.ok(lowerBound < 1, `lower bound ${lowerBound}`);
    assert.equal(proof.gap, 1 - lowerBound);
    assert.equal(verifySolverSolution(request, result.solution).valid, true);
    assert.ok(starts.length > 0 && starts.every((start) => globalBound(start) === 3),
      JSON.stringify(starts.map(globalBound)));
    assertHostAcceptsProgress(events);
  });

  it("forwards the anytime proof's bounds once the improvement ends without beating it", async () => {
    const events: SolverProgress[] = [];
    const starts: ProofStartPartition[] = [];
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let harvested = false;
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 4,
      createWorker: discoveryOnlyWorker(["Left", "Right", "Down"], []),
      createProofWorker: inlineProofWorker(() => released, starts),
    });
    const request = anytimeRequest({ maxElapsedMs: 5_000 }, 300);

    const result = await adapter.solve(request, context(undefined, (progress) => {
      events.push(progress);
      if (progress.phase === "harvesting") harvested = true;
      if (harvested && progress.detail === "Proving the small board.") release();
    }));

    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;
    assert.equal(result.solution.moves, 1);
    assert.equal(result.solution.optimality, "proven");
    assert.equal(result.proof?.kind, "optimal");
    assert.equal(verifySolverSolution(request, result.solution).valid, true);
    const harvesting = events.findIndex((progress) => progress.phase === "harvesting");
    const handoff = events.findIndex((progress, index) =>
      index > harvesting && progress.detail === "Proving the small board.");
    const firstBound = events.findIndex((progress) => progress.lowerBound !== undefined);
    assert.ok(harvesting >= 0 && handoff > harvesting, "the hand-off follows the improvement");
    assert.ok(firstBound > handoff, "the proof's bounds reach progress only after the hand-off");
    // The same proof continued: one partition, started from the 3-move route.
    assert.deepEqual(starts.map(globalBound), [3]);
    assertHostAcceptsProgress(events);
  });

  it("cancels both the anytime proof and the improvement", async () => {
    const controller = new AbortController();
    let cancelling = false;
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 4,
      createWorker: harvestWorker(["Left", "Right", "Down"]),
      createProofWorker: inlineProofWorker(never),
    });
    const request = anytimeRequest({ maxElapsedMs: 5_000 }, 3_000);
    const startedAt = performance.now();

    const result = await adapter.solve(request, context(controller.signal, (progress) => {
      if (progress.phase !== "harvesting" || cancelling) return;
      cancelling = true;
      setTimeout(() => controller.abort(), 100);
    }));

    assert.equal(result.status, "cancelled");
    // Uncancelled, the proof would run on to the 5 s deadline.
    assert.ok(performance.now() - startedAt < 3_500);
  });

  it("returns the published route unproven when the anytime proof times out", async () => {
    const events: SolverProgress[] = [];
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 4,
      createWorker: harvestWorker(["Left", "Right", "Down"]),
      createProofWorker: inlineProofWorker(never),
    });
    const request = anytimeRequest({ maxElapsedMs: 2_000 });

    const result = await adapter.solve(request, context(undefined, (progress) => events.push(progress)));

    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;
    assert.equal(result.solution.moves, 3);
    assert.notEqual(result.solution.optimality, "proven");
    assert.notEqual(result.proof?.kind, "optimal");
    assert.equal(verifySolverSolution(request, result.solution).valid, true);
    assertHostAcceptsProgress(events);
  });

  it("returns a Quality exact lane's route once it completes beside the repair, without proof", async () => {
    const events: SolverProgress[] = [];
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 4,
      createWorker: harvestWorker(["Left", "Right", "Down"]),
      // The lane finishes after its 5 s head start, during the 3 s harvest.
      createProofWorker: inlineProofWorker(() => delay(5_500)),
    });
    const request = anytimeRequest({ maxElapsedMs: 30_000 }, 3_000, "quality");
    const startedAt = performance.now();

    const result = await adapter.solve(request, context(undefined, (progress) => events.push(progress)));

    assert.ok(performance.now() - startedAt < 7_500, "the lane's route does not wait for the harvest");
    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;
    assert.equal(result.solution.moves, 1);
    assert.equal(result.solution.optimality, "unknown");
    assert.equal(result.proof, undefined);
    assert.equal(verifySolverSolution(request, result.solution).valid, true);
    assert.ok(events.some((progress) => progress.phase === "harvesting"));
    assert.ok(events.every((progress) =>
      progress.phase !== "proving" &&
      progress.lowerBound === undefined && progress.gap === undefined &&
      !PROOF_WORDING.test(progress.detail ?? "")),
    JSON.stringify(events.map((progress) => progress.detail)));
    assertHostAcceptsProgress(events);
  });

  it("passes an unfinished Quality exact lane's shorter route to the repair", async () => {
    const events: SolverProgress[] = [];
    // The lane's 5.5 s cap ends during the harvest, which runs from its 5 s
    // head start for 1.1 s.
    const request = anytimeRequest({ maxElapsedMs: 11_000 }, 3_000, "quality");
    const laneRoute = solutionFromLegacyPath(request, ["Left", "Right", "Down"]);
    assert.ok(laneRoute);
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 4,
      createWorker: harvestWorker(["Left", "Right", "Left", "Right", "Down"]),
      createProofWorker: routeProofWorker(laneRoute),
    });

    const result = await adapter.solve(request, context(undefined, (progress) => events.push(progress)));

    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;
    assert.equal(result.solution.moves, 3);
    assert.equal(result.solution.optimality, "unknown");
    assert.equal(result.proof, undefined);
    assert.equal(verifySolverSolution(request, result.solution).valid, true);
    const harvesting = events.findIndex((progress) => progress.phase === "harvesting");
    const shorter = events.findIndex((progress) => progress.upperBound === 3);
    assert.ok(harvesting >= 0 && shorter > harvesting, "the repair publishes the lane's route");
    assert.ok(events.every((progress) =>
      progress.phase !== "proving" && progress.lowerBound === undefined && progress.gap === undefined));
    assertHostAcceptsProgress(events);
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

  it("reports a limit, not exhaustion, when time runs out before the fallback search", async () => {
    let now = 0;
    const adapter = createSokomindSolverAdapter({
      createWorker: () =>
        new ScriptedWorker((self) => {
          queueMicrotask(() => {
            self.emit({ type: "done", visited: 0, generated: 0 });
            // The deadline passes after discovery ends but before the solver
            // can start its complete fallback search.
            now = 1_000;
          });
        }),
    });

    const result = await adapter.solve(
      requestFor(ONE_TYPED_BOX, {
        limits: { maxElapsedMs: 1_000 },
        options: { "sokomind-solver": { deterministic: true } },
      }),
      { ...context(), now: () => now },
    );

    assert.equal(result.status, "unsolved");
    if (result.status !== "unsolved") return;
    assert.equal(result.reason, "limit-reached");
    assert.match(result.detail ?? "", /time limit/i);
  });

  for (const route of ["at-limit", "over-limit", "invalid"] as const) {
    const title = route === "at-limit"
      ? "keeps a verified route whose final message reaches the expanded-state limit"
      : route === "over-limit"
        ? "rejects a route whose final message exceeds the expanded-state limit"
        : "rejects an invalid route whose final message reaches the expanded-state limit";
    it(title, async () => {
      const adapter = createSokomindSolverAdapter({
        hardwareConcurrency: 2,
        createWorker: () =>
          new ScriptedWorker((self) => {
            queueMicrotask(() => {
              self.emit({
                type: "done",
                status: "solved",
                path: route === "invalid" ? ["Up"] : ["Down"],
                visited: route === "over-limit" ? 2 : 1,
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

      if (route === "at-limit") {
        assert.equal(result.status, "solved");
        if (result.status !== "solved") return;
        assert.equal(result.solution.moves, 1);
        assert.equal(result.solution.optimality, "unknown");
        assert.equal(result.metrics.expandedStates, 1);
        assert.equal(verifySolverSolution(request, result.solution).valid, true);
        return;
      }
      assert.equal(result.status, "unsolved");
      if (result.status !== "unsolved") return;
      assert.equal(result.reason, "limit-reached");
      assert.match(result.detail ?? "", /expanded/i);
    });
  }

  it("reserves time for discovery after a structural worker goes silent", async () => {
    const algorithms: unknown[] = [];
    const ranBy: ScriptedWorker[] = [];
    const workers: ScriptedWorker[] = [];
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 2,
      structuralHeadStartMs: 5,
      createWorker: () => {
        const worker = new ScriptedWorker((self, command) => {
          const algorithm = command.payload.algorithm;
          algorithms.push(algorithm);
          ranBy.push(self);
          if (algorithm === "analyze-puzzle") {
            queueMicrotask(() => {
              self.emit({ type: "done" });
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
    // The analysis worker finished cleanly and took the structural plan. That
    // plan went silent, so its worker was terminated rather than lent again.
    const [analysis, structural, discovery] = ranBy;
    assert.equal(structural, analysis);
    assert.notEqual(discovery, structural);
    assert.equal(workers.length, 2);
    assert.equal(workers.every(({ terminated }) => terminated), true);
  });

  it("starts the next plan on a fresh engine after a done that failed", async () => {
    const ranBy: ScriptedWorker[] = [];
    const terminatedBeforeNextPlan: boolean[] = [];
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 2,
      structuralHeadStartMs: 5,
      createWorker: () => new ScriptedWorker((self, command) => {
        const algorithm = command.payload.algorithm;
        const previous = ranBy.at(-1);
        if (previous) terminatedBeforeNextPlan.push(previous.terminated);
        ranBy.push(self);
        if (algorithm === "analyze-puzzle") {
          queueMicrotask(() => {
            self.emit({ type: "done", status: "failed", error: "analysis crashed" });
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
      }),
    });

    const result = await adapter.solve(
      requestFor(LARGE_ONE_TYPED_BOX, {
        limits: { maxElapsedMs: 1_000 },
      }),
      context(),
    );

    assert.equal(result.status, "solved");
    assert.equal(ranBy.length, 3);
    assert.equal(new Set(ranBy).size, 3);
    assert.deepEqual(terminatedBeforeNextPlan, [true, true]);
  });

  it("consumes typed analysis recommendations and resumes a structural checkpoint", async () => {
    const ultimatePayloads: Array<Readonly<Record<string, unknown>>> = [];
    const maxMemoryBytes = 2 * 1024 * 1024 * 1024;
    const preparedEstimatedBytes = 4_096;
    const preparedBoard = {
      schemaVersion: 3,
      boardContentKey: LARGE_ONE_TYPED_BOX.rows.join("\n"),
      estimatedBytes: preparedEstimatedBytes,
      floor: new Set<string>(),
      goals: new Map<string, string>(),
      singleBoxGraph: { nodes: new Map<string, unknown>() },
      goalPushTables: { byGoal: new Map<string, unknown>() },
      dense: { idByKey: new Map<string, number>() },
    };
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 2,
      createWorker: () =>
        new ScriptedWorker((self, command) => {
          const algorithm = command.payload.algorithm;
          queueMicrotask(() => {
            if (algorithm === "analyze-puzzle") {
              self.emit({
                type: "done",
                analysis: {
                  preparedBoard,
                  difficulty: "complex",
                  phases: [{ id: "milestone-reverse" }],
                  recommendations: {
                    beamWidth: 17,
                    beamVisited: 23,
                    checkpointLimit: 5,
                    sideVisitedLimit: 29,
                    useSequenceMacros: false,
                  },
                },
              });
              return;
            }
            if (algorithm === "plan-macro-beam") {
              self.emit({
                type: "done",
                visited: 1,
                generated: 1,
                checkpoint: {
                  state: {
                    rows: LARGE_ONE_TYPED_BOX.rows,
                    robot: [1, 2],
                    boxes: [["2,2", "A"]],
                  },
                  path: ["Left", "Right"],
                  // The adapter derives this from replay instead of trusting
                  // stale or malformed engine metadata.
                  cost: 999,
                  estimate: 1,
                },
              });
              return;
            }
            if (algorithm === "ultimate") {
              ultimatePayloads.push(command.payload);
              self.emit({
                type: "done",
                status:
                  typeof command.payload.seed === "number"
                    ? "solved"
                    : undefined,
                path:
                  typeof command.payload.seed === "number" ? ["Down"] : null,
                visited: 1,
                generated: 1,
              });
            }
          });
        }),
    });

    const result = await adapter.solve(
      requestFor(LARGE_ONE_TYPED_BOX, {
        limits: { maxMemoryBytes },
      }),
      context(),
    );

    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;
    assert.equal(result.solution.moves, 3);
    assert.equal(ultimatePayloads.length, 2);
    assert.equal(ultimatePayloads[0]?.beamWidth, 17);
    assert.equal(ultimatePayloads[0]?.maxVisited, 23);
    assert.equal(ultimatePayloads[0]?.checkpointLimit, 5);
    assert.equal(ultimatePayloads[0]?.sequenceMacros, false);
    assert.equal(ultimatePayloads[0]?.beamProfile, "milestone");
    assert.equal(typeof ultimatePayloads[1]?.seed, "number");
    assert.equal(ultimatePayloads[1]?.maxDepth, 360);
    const expectedWorkerMemory =
      maxMemoryBytes - 1024 * 1024 - preparedEstimatedBytes;
    assert.equal(ultimatePayloads[0]?.maxMemoryBytes, expectedWorkerMemory);
    assert.equal(ultimatePayloads[1]?.maxMemoryBytes, expectedWorkerMemory);
  });

  it("rejects a structural checkpoint whose path does not reach its state", async () => {
    const ultimatePayloads: Array<Readonly<Record<string, unknown>>> = [];
    const modes: WorkerCommand["mode"][] = [];
    const preparedBoard = {
      schemaVersion: 3,
      boardContentKey: LARGE_ONE_TYPED_BOX.rows.join("\n"),
      floor: new Set<string>(),
      goals: new Map<string, string>(),
      singleBoxGraph: { nodes: new Map<string, unknown>() },
      goalPushTables: { byGoal: new Map<string, unknown>() },
      dense: { idByKey: new Map<string, number>() },
    };
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 4,
      deviceMemoryGb: 16,
      createWorker: () =>
        new ScriptedWorker((self, command) => {
          modes.push(command.mode);
          const algorithm = command.payload.algorithm;
          queueMicrotask(() => {
            if (command.mode !== "search") {
              self.emit({ type: "done" });
              return;
            }
            if (algorithm === "analyze-puzzle") {
              self.emit({
                type: "done",
                analysis: {
                  preparedBoard,
                  recommendations: { reverseWorkerLimit: 0 },
                },
              });
              return;
            }
            if (algorithm === "plan-macro-beam") {
              self.emit({
                type: "done",
                checkpoint: {
                  state: {
                    rows: LARGE_ONE_TYPED_BOX.rows,
                    robot: [1, 3],
                    boxes: [["2,2", "A"]],
                  },
                  path: ["Left", "Right"],
                  cost: 0,
                  estimate: 1,
                },
              });
              return;
            }
            if (algorithm === "ultimate") {
              ultimatePayloads.push(command.payload);
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
      requestFor(LARGE_ONE_TYPED_BOX),
      context(),
    );

    assert.equal(result.status, "solved");
    assert.equal(ultimatePayloads.length, 1);
    assert.equal(ultimatePayloads[0]?.seed, undefined);
    assert.equal(modes.includes("bidir-forward"), false);
    assert.equal(modes.includes("bidir-reverse"), false);
  });

  it("races Fast discovery beside the structural head start and stops structural when it wins", { timeout: 10_000 }, async () => {
    const posted: unknown[] = [];
    const structuralRunningAtDiscovery: boolean[] = [];
    const structural: ScriptedWorker[] = [];
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 4,
      deviceMemoryGb: 16,
      structuralHeadStartMs: 60_000,
      createWorker: () =>
        new ScriptedWorker((self, command) => {
          const algorithm = command.payload.algorithm;
          posted.push(algorithm);
          if (algorithm === "plan-macro-beam") {
            structural.push(self);
            return;
          }
          if (algorithm === "ultimate") {
            structuralRunningAtDiscovery.push(structural[0]?.terminated === false);
          }
          queueMicrotask(() => {
            self.emit(algorithm === "analyze-puzzle"
              ? { type: "done" }
              : { type: "done", status: "solved", path: ["Down"], visited: 1, generated: 1 });
          });
        }),
    });

    const result = await adapter.solve(requestFor(LARGE_ONE_TYPED_BOX), context());

    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;
    assert.equal(result.solution.moves, 1);
    assert.deepEqual(posted, ["analyze-puzzle", "plan-macro-beam", "ultimate"]);
    assert.deepEqual(structuralRunningAtDiscovery, [true]);
    assert.equal(structural.length, 1);
    assert.equal(structural[0]?.terminated, true);
  });

  it("races only the bidirectional frontiers beside the structural head start on four workers", { timeout: 10_000 }, async () => {
    const posted: string[] = [];
    const parked: ScriptedWorker[] = [];
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 5,
      deviceMemoryGb: 16,
      structuralHeadStartMs: 60_000,
      createWorker: () =>
        new ScriptedWorker((self, command) => {
          const algorithm = command.payload.algorithm;
          posted.push(command.mode === "search" ? String(algorithm) : command.mode);
          // Structural and the reverse frontier stay busy; the forward frontier solves.
          if (algorithm === "plan-macro-beam" || command.mode === "bidir-reverse") {
            parked.push(self);
            return;
          }
          queueMicrotask(() => {
            self.emit(algorithm === "analyze-puzzle"
              ? { type: "done" }
              : { type: "done", status: "solved", path: ["Down"], visited: 1, generated: 1 });
          });
        }),
    });

    const result = await adapter.solve(requestFor(LARGE_ONE_TYPED_BOX), context());

    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;
    assert.equal(result.solution.moves, 1);
    assert.deepEqual(posted, ["analyze-puzzle", "plan-macro-beam", "bidir-forward", "bidir-reverse"]);
    assert.equal(parked.length, 2);
    assert.ok(parked.every((worker) => worker.terminated));
  });

  it("starts the guided push portfolio beside structural once the frontiers end without a route", { timeout: 10_000 }, async () => {
    const posted: string[] = [];
    const structural: ScriptedWorker[] = [];
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 5,
      deviceMemoryGb: 16,
      structuralHeadStartMs: 60_000,
      createWorker: () =>
        new ScriptedWorker((self, command) => {
          const algorithm = command.payload.algorithm;
          posted.push(command.mode === "search" ? String(algorithm) : command.mode);
          if (algorithm === "plan-macro-beam") {
            structural.push(self);
            return;
          }
          queueMicrotask(() => {
            self.emit(algorithm === "ultimate"
              ? { type: "done", status: "solved", path: ["Down"], visited: 1, generated: 1 }
              : { type: "done", visited: 1, generated: 1 });
          });
        }),
    });

    const result = await adapter.solve(requestFor(LARGE_ONE_TYPED_BOX), context());

    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;
    assert.equal(result.solution.moves, 1);
    assert.deepEqual(posted, [
      "analyze-puzzle", "plan-macro-beam", "bidir-forward", "bidir-reverse", "ultimate",
    ]);
    assert.equal(structural.length, 1);
    assert.equal(structural[0]?.terminated, true);
  });

  it("keeps a structural route that wins the Fast race and stops discovery", { timeout: 10_000 }, async () => {
    const discovery: ScriptedWorker[] = [];
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 4,
      deviceMemoryGb: 16,
      createWorker: () =>
        new ScriptedWorker((self, command) => {
          const algorithm = command.payload.algorithm;
          if (algorithm === "ultimate") {
            discovery.push(self);
            return;
          }
          queueMicrotask(() => {
            self.emit(algorithm === "analyze-puzzle"
              ? { type: "done" }
              : { type: "done", status: "solved", path: ["Down"], visited: 1, generated: 1 });
          });
        }),
    });

    const result = await adapter.solve(requestFor(LARGE_ONE_TYPED_BOX), context());

    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;
    assert.equal(result.solution.moves, 1);
    assert.equal(discovery.length, 1);
    assert.equal(discovery[0]?.terminated, true);
  });

  it("starts structural checkpoint continuations beside Fast discovery that is still running", { timeout: 10_000 }, async () => {
    const seeds: unknown[] = [];
    const roots: ScriptedWorker[] = [];
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 4,
      deviceMemoryGb: 16,
      createWorker: () =>
        new ScriptedWorker((self, command) => {
          const algorithm = command.payload.algorithm;
          if (algorithm === "ultimate") {
            seeds.push(command.payload.seed);
            // The root discovery plan stays busy; only the continuation solves.
            if (command.payload.seed === undefined) {
              roots.push(self);
              return;
            }
          }
          queueMicrotask(() => {
            if (algorithm === "analyze-puzzle") {
              self.emit({ type: "done" });
            } else if (algorithm === "plan-macro-beam") {
              self.emit({
                type: "done",
                visited: 1,
                generated: 1,
                checkpoint: {
                  state: {
                    rows: LARGE_ONE_TYPED_BOX.rows,
                    robot: [1, 2],
                    boxes: [["2,2", "A"]],
                  },
                  path: ["Left", "Right"],
                  cost: 2,
                  estimate: 1,
                },
              });
            } else {
              self.emit({ type: "done", status: "solved", path: ["Down"], visited: 1, generated: 1 });
            }
          });
        }),
    });

    const result = await adapter.solve(requestFor(LARGE_ONE_TYPED_BOX), context());

    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;
    assert.equal(result.solution.moves, 3, "the continuation's route keeps its checkpoint prefix");
    assert.equal(seeds.length, 2);
    assert.equal(seeds[0], undefined);
    assert.equal(typeof seeds[1], "number");
    assert.equal(roots.length, 1);
    assert.equal(roots[0]?.terminated, true);
  });

  it("keeps the structural head start ahead of Fast discovery under a state limit", { timeout: 10_000 }, async () => {
    const structuralEndedAtDiscovery: boolean[] = [];
    const structural: ScriptedWorker[] = [];
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 4,
      deviceMemoryGb: 16,
      structuralHeadStartMs: 5,
      createWorker: () =>
        new ScriptedWorker((self, command) => {
          const algorithm = command.payload.algorithm;
          if (algorithm === "plan-macro-beam") {
            structural.push(self);
            return;
          }
          if (algorithm === "ultimate") {
            structuralEndedAtDiscovery.push(structural[0]?.terminated === true);
          }
          queueMicrotask(() => {
            self.emit(algorithm === "analyze-puzzle"
              ? { type: "done" }
              : { type: "done", status: "solved", path: ["Down"], visited: 1, generated: 1 });
          });
        }),
    });

    const result = await adapter.solve(
      requestFor(LARGE_ONE_TYPED_BOX, { limits: { maxExpandedStates: 1_000_000 } }),
      context(),
    );

    assert.equal(result.status, "solved");
    assert.deepEqual(structuralEndedAtDiscovery, [true]);
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
              self.emit({ type: "done" });
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
              self.emit({ type: "done" });
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
    const structuralSolutionComparisonBudgets: unknown[] = [];
    const discoverySolutionComparisonBudgets: unknown[] = [];
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 2,
      createWorker: () =>
        new ScriptedWorker((self, command) => {
          const algorithm = command.payload.algorithm;
          queueMicrotask(() => {
            if (algorithm === "analyze-puzzle") {
              self.emit({ type: "done" });
            } else if (algorithm === "plan-macro-beam") {
              structuralGeneratedBudgets.push(
                command.payload.maxGenerated,
              );
              structuralSolutionComparisonBudgets.push(
                command.payload.planSolutionComparisonBudget,
              );
              self.emit({
                type: "done",
                status: "cutoff",
                cutoff: true,
                visited: 1,
                generated: 6,
              });
            } else {
              discoverySolutionComparisonBudgets.push(
                command.payload.beamSolutionComparisonBudget,
              );
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
    assert.deepEqual(structuralSolutionComparisonBudgets, [0]);
    assert.deepEqual(discoverySolutionComparisonBudgets, [0]);
  });

  it("keeps solution comparison enabled outside fast mode", async () => {
    const structuralSolutionComparisonBudgets: unknown[] = [];
    const discoverySolutionComparisonBudgets: unknown[] = [];
    const controller = new AbortController();
    const adapter = createSokomindSolverAdapter({
      hardwareConcurrency: 2,
      createWorker: () =>
        new ScriptedWorker((self, command) => {
          const algorithm = command.payload.algorithm;
          queueMicrotask(() => {
            if (algorithm === "analyze-puzzle") {
              self.emit({ type: "done" });
              return;
            }
            if (algorithm === "plan-macro-beam") {
              structuralSolutionComparisonBudgets.push(
                command.payload.planSolutionComparisonBudget,
              );
              self.emit({
                type: "done",
                status: "cutoff",
                cutoff: true,
                visited: 1,
                generated: 1,
              });
              return;
            }
            if (algorithm === "ultimate") {
              discoverySolutionComparisonBudgets.push(
                command.payload.beamSolutionComparisonBudget,
              );
              controller.abort();
            }
          });
        }),
    });

    const result = await adapter.solve(
      requestFor(LARGE_ONE_TYPED_BOX, {
        options: {
          "sokomind-solver": { mode: "quality", maximumIncumbents: 1 },
        },
      }),
      context(controller.signal),
    );

    assert.equal(result.status, "cancelled");
    assert.deepEqual(structuralSolutionComparisonBudgets, [undefined]);
    assert.deepEqual(discoverySolutionComparisonBudgets, [undefined]);
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
              visited: 0,
              generated: 0,
              frontier: 1,
              performance: { heapUsedBytes: workerMemoryBytes },
            });
            queueMicrotask(() => {
              self.emit({
                type: "done",
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
              visited: 7,
              generated: 9,
              frontier: 2,
            });
            queueMicrotask(() => {
              self.emit({
                type: "done",
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
