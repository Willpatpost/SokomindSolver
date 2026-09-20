import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSession, type PuzzleDefinition } from "../../src/core/index.ts";
import type { SolverExecutionContext, SolverRequest } from "../../src/solver/contracts.ts";
import { createNodeSolverAdapter } from "../../src/solver/node-runner.ts";
import { createSokomindSolverAdapter } from "../../src/solver/implementations/sokomind-solver.ts";
import { BudgetTracker } from "../../src/solver/implementations/sokomind-budget-tracker.ts";
import { bidirectionalSide } from "../../src/solver/implementations/sokomind-engine/engine.generated.js";
import type { EngineResult } from "../../src/solver/implementations/sokomind-engine/engine-protocol.ts";
import { toLegacyState } from "../../src/solver/implementations/sokomind-legacy.ts";
import { bidirectionalPlans, configuredBudget, discoveryPlans, structuralPlan } from "../../src/solver/implementations/sokomind-plans.ts";
import { runPhase, type SokomindEngineWorker } from "../../src/solver/implementations/sokomind-phase-runner.ts";
import { aggregate, reachedLimit, retainLegacyRecord, type SearchRunState } from "../../src/solver/implementations/sokomind-run-state.ts";
import { resolveSokomindTuning } from "../../src/solver/implementations/sokomind-tuning.ts";
import { WorkerExecutionRegistry } from "../../src/solver/implementations/sokomind-worker-registry.ts";

const ROOM: PuzzleDefinition = {
  id: "integration-budget-room", title: "Integration budget room", difficulty: "tutorial", boxes: 1,
  rows: ["OOOOOOO", "O R   O", "O  A  O", "O     O", "O  a  O", "OOOOOOO"],
};
const LARGE_ROOM: PuzzleDefinition = {
  ...ROOM,
  rows: ["OOOOOOOOOOOO", "O R        O", "O A        O", "O a        O", ...Array.from({ length: 7 }, () => "O          O"), "OOOOOOOOOOOO"],
};
function requestFor(puzzle = ROOM): SolverRequest {
  const session = createSession(puzzle);
  return { board: session.board, snapshot: session.snapshot, objective: { kind: "moves" } };
}
function context(signal = new AbortController().signal): SolverExecutionContext {
  return { signal, now: () => performance.now(), reportProgress() {} };
}
function silentWorker(onPost: SokomindEngineWorker["postMessage"]): SokomindEngineWorker {
  return { postMessage: onPost, addEventListener() {}, removeEventListener() {}, terminate() {} };
}
function runState(request = requestFor()): SearchRunState {
  return {
    startedAt: performance.now(), deadline: Infinity, request, context: context(), profile: resolveSokomindTuning(),
    workerSilenceTimeoutMs: 1000, structuralHeadStartLimitMs: 1000,
    registry: new WorkerExecutionRegistry(), budget: new BudgetTracker(),
    rejectedCandidates: 0, completedWorkers: 0, phaseTimeouts: 0, watchdogTimeouts: 0,
    lastProgressAt: -Infinity, progressPhase: "searching", initialSolutionMoves: 0,
    bestSolutionMoves: 0, solutionImprovements: 0, suppressedImprovementErrors: 0,
    suppressedHarvestErrors: 0, qualitySlicesCompleted: 0, qualityOperatorStalls: 0,
    aggregateGeneration: 1, cachedAggregate: null,
  };
}

describe("Sokomind integration resource contracts", () => {
  it("turns an internal unlimited allowance into a finite engine budget", () => {
    assert.equal(configuredBudget(Infinity, 500_000), 500_000);
  });

  it("leases aggregate worker resources without overcommitting them", () => {
    const budget = new BudgetTracker();
    const first = budget.leaseWorker(
      "first",
      { expanded: 1000, generated: 2000, memory: 1024 },
      { expanded: 1000, generated: 2000, memory: 1024 },
    );
    const second = budget.leaseWorker(
      "second",
      { expanded: 1000, generated: 2000, memory: 1024 },
      { expanded: 1000, generated: 2000, memory: 1024 },
    );
    assert.deepEqual(first, { expanded: 1000, generated: 2000, memory: 1024 });
    assert.deepEqual(second, { expanded: 0, generated: 0, memory: 0 });
    budget.releaseWorkerLease("first");
    assert.equal(budget.leaseWorker("third", { memory: 1024 }, { memory: 1024 }).memory, 1024);
  });

  it("publishes every verified repair route and reports a task-local cutoff", async () => {
    const run = runState();
    const published: number[] = [];
    const result = await runPhase(
      run,
      [{
        id: "repair", label: "Repair", mode: "search",
        payload: {
          algorithm: "solution-box-reschedule",
          state: toLegacyState(run.request),
          solutionPath: ["Left", "Right", "Right", "Down", "Down"],
          maxVisited: 1,
          maxGenerated: 10,
        },
      }],
      () => {
        const listeners = new Set<(event: { data: unknown }) => void>();
        return {
          postMessage() {
            queueMicrotask(() => {
              for (const listener of listeners) {
                listener({ data: { type: "progress", path: ["Left", "Right", "Right", "Down", "Down"], visited: 0, generated: 1 } });
                listener({ data: { type: "progress", path: ["Right", "Down", "Down"], visited: 0, generated: 2 } });
                listener({ data: {
                  type: "done", path: ["Right", "Down", "Down"], visited: 1, generated: 3,
                  boxRescheduling: { budgetExhausted: true, memoryExhausted: false, attempts: [] },
                } });
              }
            });
          },
          addEventListener(type: string, listener: (event: { data: unknown }) => void) {
            if (type === "message") listeners.add(listener);
          },
          removeEventListener(type: string, listener: (event: { data: unknown }) => void) {
            if (type === "message") listeners.delete(listener);
          },
          terminate() {},
        } as SokomindEngineWorker;
      },
      1,
      1000,
      { onSolutionPublished: (candidate) => published.push(candidate.moves) },
    );
    assert.deepEqual(published, [5, 3, 3], JSON.stringify(result));
    assert.equal(result.solution?.moves, 3);
    assert.equal(result.localStopReason, "expanded");
    assert.equal(result.expandedWork, 1);
    assert.equal(result.generatedWork, 3);
  });
  it("activates explicit move-aware tuning consistently in structural and direct lanes", () => {
    const request = requestFor();
    const state = toLegacyState(request);
    for (const moveAwareDiscovery of [0, 0.49, 0.5, 1]) {
      const tuning = { moveAwareDiscovery };
      const plans = [structuralPlan(state, request, tuning, "quality"), ...discoveryPlans(state, request, 1, tuning)];
      for (const plan of plans) {
        assert.equal(plan.payload.planMoveAwareTranspositions, moveAwareDiscovery >= 0.5 ? true : undefined);
      }
    }
  });

  const optionCases: readonly Readonly<Record<string, string | number | boolean>>[] = [
    { mode: "quality" },
    { mode: "quality", strategicAnalysisMs: 0, strategicPlanExecution: false },
    { mode: "quality", strategicAnalysisMs: 0 },
    { mode: "quality", strategicPlanExecution: false },
    { mode: "quality", strategicAnalysisMs: 250, strategicPlanExecution: false },
    { mode: "quality", strategicAnalysisMs: 250, strategicPlanExecution: true },
  ];
  for (const options of optionCases) {
    it(`preserves strategic opt-in settings ${JSON.stringify(options)}`, async () => {
      const controller = new AbortController();
      const commands: Parameters<SokomindEngineWorker["postMessage"]>[0][] = [];
      const adapter = createSokomindSolverAdapter({ createWorker: () => silentWorker((command) => {
        commands.push(command);
        queueMicrotask(() => controller.abort());
      }) });
      await adapter.solve({ ...requestFor(LARGE_ROOM), options: { "sokomind-solver": options } }, context(controller.signal));
      const autoStrategic = options.mode === "quality" && !Object.hasOwn(options, "strategicAnalysisMs");
      const effectiveMs = autoStrategic ? 500 : (options.strategicAnalysisMs || 0);
      const effectiveExec = Object.hasOwn(options, "strategicPlanExecution")
        ? Boolean(options.strategicPlanExecution) : autoStrategic;
      const expected = effectiveMs
        ? { maxMs: effectiveMs, inferenceWork: effectiveExec ? 2048 : 0 }
        : undefined;
      assert.deepEqual(commands[0]?.payload.strategicAnalysis, expected);
    });
  }

  for (const limit of [0, 1, 2, 3, 7, 100]) {
    it(`shares generated allowance ${limit} across a pair and a three-lane portfolio`, () => {
      const request = { ...requestFor(), limits: { maxGeneratedStates: limit } };
      const state = toLegacyState(request);
      for (const plans of [bidirectionalPlans(state, request), discoveryPlans(state, request, 3, {})]) {
        assert.ok(plans.every((plan) => Number.isSafeInteger(plan.payload.maxGenerated)));
        const shares = plans.map((plan) => Number(plan.payload.maxGenerated));
        assert.ok(shares.every((share) => share >= 0));
        assert.ok(shares.reduce((sum, share) => sum + share, 0) <= limit);
        assert.deepEqual(shares, Array.from({ length: plans.length }, () => Math.floor(limit / plans.length)));
      }
    });
  }

  for (const mode of ["bidir-forward", "bidir-reverse"] as const) {
    for (const limit of [0, 1, 3, 7]) {
      it(`${mode} stops generating at allowance ${limit}`, (t) => {
        const original = globalThis.postMessage;
        const messages: EngineResult[] = [];
        globalThis.postMessage = ((message: EngineResult) => messages.push(message)) as typeof globalThis.postMessage;
        t.after(() => {
          if (original === undefined) Reflect.deleteProperty(globalThis, "postMessage");
          else globalThis.postMessage = original;
        });
        bidirectionalSide({ mode, state: toLegacyState(requestFor()), maxVisited: 100, maxGenerated: limit });
        const terminal = messages.find((message) => message.type === "done");
        assert.ok(terminal);
        assert.ok((terminal.generated ?? Infinity) <= limit);
        assert.ok(messages.every((message) => (message.generated ?? 0) <= limit));
        if (terminal.generated === limit) {
          assert.equal(terminal.cutoff, true);
          assert.equal(terminal.terminationReason, "generated-budget");
        }
        if (limit === 0) assert.equal(terminal.visited, 0);
      });
    }
  }

  it("keeps real concurrent workers inside finite generated allowances", { timeout: 10_000 }, async () => {
    for (const maxGeneratedStates of [0, 3, 7]) {
      const adapter = createNodeSolverAdapter({ hardwareConcurrency: 4, deviceMemoryGb: 16 });
      const result = await adapter.solve({ ...requestFor(), limits: { maxGeneratedStates, maxElapsedMs: 3000 } }, context());
      assert.ok((result.metrics.generatedStates ?? 0) <= maxGeneratedStates,
        `generated ${result.metrics.generatedStates} with allowance ${maxGeneratedStates}`);
    }
  });

  it("charges worker startup memory before posting work even without telemetry", async () => {
    let posted = 0;
    const adapter = createSokomindSolverAdapter({ createWorker: () => silentWorker(() => { posted += 1; }) });
    const result = await adapter.solve({ ...requestFor(), limits: { maxMemoryBytes: 1, maxElapsedMs: 100 } }, context());
    assert.equal(posted, 0);
    assert.equal(result.status, "unsolved");
    if (result.status !== "unsolved") return;
    assert.match(result.detail ?? "", /memory/i);
    assert.equal(result.metrics.counters?.peakEstimatedMemoryBytes, 16 * 1024 * 1024);
  });

  it("charges each coordinator record and replacement before checking memory", () => {
    const run = runState({ ...requestFor(), limits: { maxMemoryBytes: 600 } });
    const records = new Map();
    assert.equal(aggregate(run).estimatedMemoryBytes, 0);
    const record = { id: "a", parent: null, robot: [1, 2] as const, segment: "R" };
    retainLegacyRecord(run, records, record);
    assert.equal(aggregate(run).estimatedMemoryBytes, 520);
    assert.equal(reachedLimit(run), undefined);
    retainLegacyRecord(run, records, { ...record, segment: "R".repeat(30) });
    assert.equal(reachedLimit(run), "memory");
    assert.equal(aggregate(run).counters.coordinatorRecords, 1);
  });

  it("releases the coordinator ledger when a phase completes", async () => {
    const run = runState();
    retainLegacyRecord(run, new Map(), { id: "a", parent: null, robot: [1, 2], segment: "R" });
    assert.equal(aggregate(run).estimatedMemoryBytes, 520);
    const result = await runPhase(run, [{ id: "empty", label: "Empty", mode: "search", payload: {} }], () => {
      const listeners = new Set<(event: { data: unknown }) => void>();
      return {
        ...silentWorker(() => queueMicrotask(() => {
          for (const listener of listeners) listener({ data: { type: "done", status: "exhausted", visited: 0, generated: 0 } });
        })),
        addEventListener(type: string, listener: (event: { data: unknown }) => void) { if (type === "message") listeners.add(listener); },
        removeEventListener(type: string, listener: (event: { data: unknown }) => void) { if (type === "message") listeners.delete(listener); },
      } as SokomindEngineWorker;
    });
    assert.equal(result.cutoff, false);
    assert.equal(aggregate(run).estimatedMemoryBytes, 0);
    assert.equal(aggregate(run).counters.coordinatorRecords, 0);
    assert.equal(aggregate(run).counters.peakCoordinatorRecords, 1);
  });
});
