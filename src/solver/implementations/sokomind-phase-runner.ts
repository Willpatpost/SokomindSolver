import type {
  SolverSolution,
} from "../contracts.ts";
import type { EngineCommand, EngineResult } from "./sokomind-engine/engine-protocol.ts";
import { isEngineResult } from "./sokomind-engine/engine-protocol.ts";
import { isSolutionBetter } from "./sokomind-incumbents.ts";
import {
  asLegacyPath,
  isLegacyRecord,
  legacyCheckpointFromValue,
  reconstructBidirectionalPath,
  solutionFromLegacyPath,
  preparedBoardFromAnalysis,
  analysisPlanFromAnalysis,
  type LegacyPreparedBoard,
  type LegacyRecord,
  type LegacySearchCheckpoint,
  type SokomindAnalysisPlan,
} from "./sokomind-legacy.ts";
import type { EnginePlan } from "./sokomind-plans.ts";
import {
  aggregate,
  elapsed,
  reachedLimit,
  invalidateAggregate,
  report,
  retainLegacyRecord,
  updateTelemetry,
  type PhaseStopReason,
  type SearchRunState,
} from "./sokomind-run-state.ts";

export type { PhaseStopReason } from "./sokomind-run-state.ts";

export interface SokomindEngineWorker {
  postMessage(message: EngineCommand): void;
  addEventListener(
    type: "message",
    listener: (event: { readonly data: unknown }) => void,
  ): void;
  addEventListener(
    type: "error" | "messageerror",
    listener: (event: { readonly message?: string }) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: { readonly data: unknown }) => void,
  ): void;
  removeEventListener(
    type: "error" | "messageerror",
    listener: (event: { readonly message?: string }) => void,
  ): void;
  terminate(): void;
}

export interface PhaseRunOptions {
  readonly collectSolutions?: boolean;
  readonly maxSolutions?: number;
  readonly memoryConcurrency?: number;
}

export interface PhaseOutcome {
  readonly solution?: SolverSolution;
  readonly solutions?: readonly SolverSolution[];
  readonly preparedBoard?: LegacyPreparedBoard;
  readonly analysisPlan?: SokomindAnalysisPlan;
  readonly checkpoints?: readonly LegacySearchCheckpoint[];
  readonly stopReason?: PhaseStopReason;
  readonly phaseTimedOut?: boolean;
  readonly watchdogTimedOut?: boolean;
  readonly cutoff: boolean;
  readonly startedWorkers: number;
  readonly failedWorkers: number;
  readonly errors: readonly string[];
}

type EngineMessageListener = (event: { readonly data: unknown }) => void;
type EngineErrorListener = (event: { readonly message?: string }) => void;

function recordMapForPlan(
  plan: EnginePlan,
  forwardRecords: Map<string, LegacyRecord>,
  reverseRecords: Map<string, Map<string, LegacyRecord>>,
): Map<string, LegacyRecord> | undefined {
  if (plan.mode === "bidir-forward") return forwardRecords;
  if (plan.mode === "bidir-reverse") {
    const records = new Map<string, LegacyRecord>();
    reverseRecords.set(plan.id, records);
    return records;
  }
  return undefined;
}

function phaseTimerDelay(run: SearchRunState): number | undefined {
  if (!Number.isFinite(run.deadline)) return undefined;
  return Math.max(0, run.deadline - run.context.now());
}

interface ActiveWorkerEntry {
  readonly worker: SokomindEngineWorker;
  readonly plan: EnginePlan;
  readonly onMessage: EngineMessageListener;
  readonly onError: EngineErrorListener;
  readonly onMessageError: EngineErrorListener;
}

class PhaseRunner {
  private readonly run: SearchRunState;
  private readonly plans: readonly EnginePlan[];
  private readonly createWorker: () => SokomindEngineWorker;
  private readonly maxConcurrent: number;
  private readonly maxPhaseElapsedMs: number | undefined;
  private readonly options: PhaseRunOptions;

  private readonly active = new Map<string, ActiveWorkerEntry>();
  private readonly forwardRecords = new Map<string, LegacyRecord>();
  private readonly reverseRecords = new Map<string, Map<string, LegacyRecord>>();
  private readonly errors: string[] = [];
  private readonly collectedSolutions: SolverSolution[] = [];
  private readonly collectedSolutionKeys = new Set<string>();
  private readonly collectedCheckpoints: LegacySearchCheckpoint[] = [];

  private settled = false;
  private cutoff = false;
  private startedWorkers = 0;
  private failedWorkers = 0;
  private nextPlanIndex = 0;
  private publishedSolution: SolverSolution | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  private resetWatchdog = () => {};

  private resolve!: (outcome: PhaseOutcome) => void;
  private reject!: (error: unknown) => void;

  constructor(
    run: SearchRunState,
    plans: readonly EnginePlan[],
    createWorker: () => SokomindEngineWorker,
    maxConcurrent: number,
    maxPhaseElapsedMs: number | undefined,
    options: PhaseRunOptions,
  ) {
    this.run = run;
    this.plans = plans;
    this.createWorker = createWorker;
    this.maxConcurrent = maxConcurrent;
    this.maxPhaseElapsedMs = maxPhaseElapsedMs;
    this.options = options;
  }

  execute(): Promise<PhaseOutcome> {
    if (this.plans.length === 0) {
      return Promise.resolve({
        cutoff: false,
        startedWorkers: 0,
        failedWorkers: 0,
        errors: Object.freeze([]),
      });
    }

    return new Promise<PhaseOutcome>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;

      const memoryConcurrency = Math.max(
        1,
        Math.floor(
          this.options.memoryConcurrency ?? Math.min(this.maxConcurrent, this.plans.length),
        ),
      );

      const globalTimerDelay = phaseTimerDelay(this.run);
      const timerDelay =
        this.maxPhaseElapsedMs === undefined
          ? globalTimerDelay
          : Math.min(
              globalTimerDelay ?? Infinity,
              Math.max(0, this.maxPhaseElapsedMs),
            );
      const timerRepresentsGlobalDeadline =
        globalTimerDelay !== undefined &&
        (this.maxPhaseElapsedMs === undefined ||
          globalTimerDelay <= Math.max(0, this.maxPhaseElapsedMs));

      if (timerDelay === undefined) {
        this.resetWatchdog = () => {
          if (this.settled) return;
          if (this.watchdogTimer !== undefined) clearTimeout(this.watchdogTimer);
          this.watchdogTimer = setTimeout(() => {
            if (this.settled) return;
            const silentWorkers = this.active.size;
            this.failedWorkers += silentWorkers;
            this.cutoff = true;
            this.run.watchdogTimeouts += 1;
            invalidateAggregate(this.run);
            this.errors.push(
              `${silentWorkers} engine worker${silentWorkers === 1 ? "" : "s"} stopped reporting progress.`,
            );
            this.finish({ watchdogTimedOut: true });
          }, this.run.workerSilenceTimeoutMs);
        };
      }

      const onAbort = () => {
        this.stopForLimit("cancelled");
      };
      this.run.context.signal.addEventListener("abort", onAbort, { once: true });

      if (timerDelay !== undefined) {
        this.timer = setTimeout(() => {
          if (
            timerRepresentsGlobalDeadline ||
            this.run.context.now() >= this.run.deadline
          ) {
            this.stopForLimit("elapsed");
          } else {
            this.run.phaseTimeouts += 1;
            invalidateAggregate(this.run);
            this.finish({ phaseTimedOut: true });
          }
        }, timerDelay);
      }

      // Store onAbort for cleanup
      const cleanupOnAbort = () => {
        this.run.context.signal.removeEventListener("abort", onAbort);
      };

      // Override finish/fail to include onAbort cleanup
      const originalFinish = this.finish.bind(this);
      const originalFail = this.fail.bind(this);
      this.finish = (outcome = {}) => {
        cleanupOnAbort();
        originalFinish(outcome);
      };
      this.fail = (error: unknown) => {
        cleanupOnAbort();
        originalFail(error);
      };

      // Store memoryConcurrency for use in startPlan
      this._memoryConcurrency = memoryConcurrency;

      if (this.settled) return;
      const initialLimit = reachedLimit(this.run);
      if (initialLimit) {
        this.stopForLimit(initialLimit);
        return;
      }
      this.launchAvailable();
      if (this.settled) return;
      if (this.active.size === 0 && this.nextPlanIndex >= this.plans.length) {
        this.finish();
        return;
      }
      try {
        report(
          this.run,
          this.plans.length === 1
            ? `${this.plans[0].label} started.`
            : `${this.plans.length} complementary searches started.`,
          true,
        );
      } catch (error) {
        this.fail(error);
      }
    });
  }

  private _memoryConcurrency = 1;

  private cleanupWorker(id: string): void {
    const entry = this.active.get(id);
    if (!entry) return;
    this.active.delete(id);
    entry.worker.removeEventListener("message", entry.onMessage);
    entry.worker.removeEventListener("error", entry.onError);
    entry.worker.removeEventListener(
      "messageerror",
      entry.onMessageError,
    );
    entry.worker.terminate();
    this.run.registry.deactivate(id);
    this.run.completedWorkers += 1;
    invalidateAggregate(this.run);
  }

  private finish(
    outcome: Omit<
      PhaseOutcome,
      "cutoff" | "startedWorkers" | "failedWorkers" | "errors"
    > = {},
  ): void {
    if (this.settled) return;
    this.settled = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    if (this.watchdogTimer !== undefined) clearTimeout(this.watchdogTimer);
    aggregate(this.run);
    for (const id of [...this.active.keys()]) this.cleanupWorker(id);
    this.run.budget.resetPhase();
    this.resolve({
      ...(this.collectedSolutions.length
        ? { solutions: Object.freeze([...this.collectedSolutions]) }
        : {}),
      ...(this.collectedCheckpoints.length
        ? { checkpoints: Object.freeze([...this.collectedCheckpoints]) }
        : {}),
      ...outcome,
      ...(this.publishedSolution && (!outcome.solution || isSolutionBetter(this.publishedSolution, outcome.solution))
        ? { solution: this.publishedSolution } : {}),
      cutoff: this.cutoff,
      startedWorkers: this.startedWorkers,
      failedWorkers: this.failedWorkers,
      errors: Object.freeze([...this.errors]),
    });
  }

  private fail(error: unknown): void {
    if (this.settled) return;
    this.settled = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    if (this.watchdogTimer !== undefined) clearTimeout(this.watchdogTimer);
    aggregate(this.run);
    for (const id of [...this.active.keys()]) this.cleanupWorker(id);
    this.run.budget.resetPhase();
    this.reject(error);
  }

  private stopForLimit(reason: PhaseStopReason): void {
    this.cutoff = true;
    this.finish({ stopReason: reason });
  }

  private acceptPath(path: readonly unknown[], label: string, retainOnly = false): boolean {
    try {
      const limitBeforeReplay = reachedLimit(this.run);
      if (limitBeforeReplay) {
        this.stopForLimit(limitBeforeReplay);
        return true;
      }
      this.run.context.reportProgress({
        phase: "verifying",
        elapsedMs: elapsed(this.run),
        detail: `Verifying candidate from ${label}.`,
      });
      const solution = solutionFromLegacyPath(this.run.request, path);
      if (!solution) {
        this.run.rejectedCandidates += 1;
        invalidateAggregate(this.run);
        report(this.run, `${label} returned a candidate that failed replay.`, true);
        return false;
      }
      const limitAfterReplay = reachedLimit(this.run);
      if (limitAfterReplay) {
        this.stopForLimit(limitAfterReplay);
        return true;
      }
      if (retainOnly) {
        if (!this.publishedSolution || isSolutionBetter(solution, this.publishedSolution)) {
          this.publishedSolution = solution;
        }
        return false;
      }
      if (this.options.collectSolutions) {
        const key = solution.steps
          .map((step) => `${step.kind[0]}${step.direction[0]}`)
          .join("");
        if (!this.collectedSolutionKeys.has(key)) {
          this.collectedSolutionKeys.add(key);
          this.collectedSolutions.push(solution);
          report(
            this.run,
            `${label} published verified route ${this.collectedSolutions.length}.`,
            true,
          );
        }
        const maximum = Math.max(1, this.options.maxSolutions ?? Infinity);
        if (this.collectedSolutions.length >= maximum) {
          this.finish();
          return true;
        }
        return false;
      }
      this.finish({ solution });
      return true;
    } catch (error) {
      this.fail(error);
      return true;
    }
  }

  private inspectMeetings(
    plan: EnginePlan,
    records: readonly LegacyRecord[],
    ownRecords: Map<string, LegacyRecord>,
  ): boolean {
    for (const record of records) {
      retainLegacyRecord(this.run, ownRecords, record);
    }
    const limit = reachedLimit(this.run);
    if (limit) {
      this.stopForLimit(limit);
      return true;
    }
    if (plan.mode === "bidir-forward") {
      for (const record of records) {
        for (const reverse of this.reverseRecords.values()) {
          if (!reverse.has(record.id)) continue;
          const path = reconstructBidirectionalPath(
            this.run.request.board,
            record.id,
            this.forwardRecords,
            reverse,
          );
          if (path && this.acceptPath(path, "bidirectional meeting")) {
            return true;
          }
        }
      }
    } else if (plan.mode === "bidir-reverse") {
      for (const record of records) {
        if (!this.forwardRecords.has(record.id)) continue;
        const path = reconstructBidirectionalPath(
          this.run.request.board,
          record.id,
          this.forwardRecords,
          ownRecords,
        );
        if (path && this.acceptPath(path, "bidirectional meeting")) return true;
      }
    }
    return false;
  }

  private continueOrFinish(): void {
    if (this.settled) return;
    this.launchAvailable();
    if (this.active.size === 0 && this.nextPlanIndex >= this.plans.length) this.finish();
  }

  private workerFinished(
    id: string,
    message: EngineResult,
    publishedRoute = false,
  ): void {
    const entry = this.active.get(id);
    if (!entry) return;
    this.cutoff ||= Boolean(message.cutoff) || message.status === "cutoff";
    if (message.status === "failed" || message.error) {
      this.failedWorkers += 1;
      this.errors.push(
        message.error ||
          `${entry.plan.label} failed: ${message.terminationReason || "unknown error"}`,
      );
    }
    this.cleanupWorker(id);
    report(
      this.run,
      publishedRoute
        ? `${entry.plan.label} finished after publishing a verified route.`
        : `${entry.plan.label} finished without a verified route.`,
      true,
    );
    this.continueOrFinish();
  }

  private captureCheckpoints(plan: EnginePlan, message: EngineResult): void {
    const values = [
      ...(Array.isArray(message.checkpoints) ? message.checkpoints : []),
      ...(message.checkpoint === undefined ? [] : [message.checkpoint]),
    ];
    const known = new Set(this.collectedCheckpoints.map((checkpoint) =>
      `${checkpoint.path.join(",")}|${checkpoint.state.robot.join(",")}|` +
      checkpoint.state.boxes.map((box) => box.join(",")).join(";")));
    for (const value of values) {
      const checkpoint = legacyCheckpointFromValue(
        value,
        this.run.request,
        plan.pathPrefix,
      );
      if (!checkpoint) continue;
      const key = `${checkpoint.path.join(",")}|${checkpoint.state.robot.join(",")}|` +
        checkpoint.state.boxes.map((box) => box.join(",")).join(";");
      if (known.has(key)) continue;
      known.add(key);
      this.collectedCheckpoints.push(checkpoint);
    }
  }

  private startPlan(plan: EnginePlan): void {
    const executionId = this.run.registry.uniqueId(plan.id);
    try {
      const worker = this.createWorker();
      this.startedWorkers += 1;
      const recordMap = recordMapForPlan(
        plan,
        this.forwardRecords,
        this.reverseRecords,
      );
      this.run.registry.register(executionId, plan.label, plan.mode);

      const onMessage: EngineMessageListener = ({ data }) => {
        if (this.settled) return;
        if (!isEngineResult(data)) {
          this.failedWorkers += 1;
          this.errors.push(`${plan.label} emitted an invalid engine message.`);
          this.cleanupWorker(executionId);
          this.continueOrFinish();
          return;
        }
        this.resetWatchdog();
        const message: EngineResult = data;
        updateTelemetry(this.run, executionId, message);
        try {
          const limit = reachedLimit(this.run);
          if (limit) {
            this.stopForLimit(limit);
            return;
          }
          if (message.type === "progress" && plan.payload.algorithm === "solution-box-reschedule") {
            const path = asLegacyPath(message.path);
            if (path && this.acceptPath(path, plan.label, true)) return;
          }
          if (
            message.type === "records" &&
            recordMap &&
            Array.isArray(message.records)
          ) {
            const records = message.records.filter(isLegacyRecord);
            if (this.inspectMeetings(plan, records, recordMap)) return;
          }

          if (message.type === "done") {
            this.captureCheckpoints(plan, message);
            if (plan.capturesPreparedBoard) {
              const preparedBoard = preparedBoardFromAnalysis(
                message.analysis,
                this.run.request.board.rows,
              );
              if (preparedBoard) {
                this.finish({
                  preparedBoard,
                  analysisPlan: analysisPlanFromAnalysis(message.analysis),
                });
                return;
              }
              this.errors.push(
                "Typed board analysis returned no reusable prepared seed.",
              );
              this.workerFinished(executionId, message);
              return;
            }
            const path = asLegacyPath(message.path);
            const candidatePath = path && plan.pathPrefix
              ? [...plan.pathPrefix, ...path]
              : path;
            const solutionsBefore = this.collectedSolutions.length;
            if (candidatePath && this.acceptPath(candidatePath, plan.label)) return;
            this.workerFinished(
              executionId,
              message,
              this.collectedSolutions.length > solutionsBefore,
            );
            return;
          }

          report(
            this.run,
            `${plan.label} is searching.`,
            message.type === "landmark",
          );
        } catch (error) {
          this.fail(error);
        }
      };
      const onError: EngineErrorListener = (event) => {
        if (this.settled) return;
        this.failedWorkers += 1;
        this.errors.push(
          event.message || `${plan.label} worker stopped unexpectedly.`,
        );
        this.cleanupWorker(executionId);
        this.continueOrFinish();
      };
      const onMessageError: EngineErrorListener = () => {
        if (this.settled) return;
        this.failedWorkers += 1;
        this.errors.push(`${plan.label} emitted an unreadable message.`);
        this.cleanupWorker(executionId);
        this.continueOrFinish();
      };
      this.active.set(executionId, {
        worker,
        plan,
        onMessage,
        onError,
        onMessageError,
      });
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      worker.addEventListener("messageerror", onMessageError);
      const startupLimit = reachedLimit(this.run);
      if (startupLimit) {
        this.stopForLimit(startupLimit);
        return;
      }
      const configuredMemory = this.run.request.limits?.maxMemoryBytes;
      const coordinatorMemoryReserve =
        this.run.budget.coordinatorEstimatedMemoryBytes +
        this.run.budget.preparedBoardEstimatedMemoryBytes;
      const memoryShare =
        plan.payload.maxMemoryBytes === undefined &&
        configuredMemory !== undefined &&
        Number.isFinite(configuredMemory)
          ? Math.max(
              1,
              Math.floor(
                Math.max(0, configuredMemory - coordinatorMemoryReserve) /
                  this._memoryConcurrency,
              ),
            )
          : undefined;
      worker.postMessage({
        mode: plan.mode,
        payload:
          memoryShare === undefined
            ? plan.payload
            : Object.freeze({
                ...plan.payload,
                maxMemoryBytes: memoryShare,
              }),
      });
      this.resetWatchdog();
    } catch (error) {
      this.failedWorkers += 1;
      this.errors.push(
        error instanceof Error ? error.message : String(error),
      );
      this.cleanupWorker(executionId);
    }
  }

  private launchAvailable(): void {
    const concurrency = Math.max(1, Math.floor(this.maxConcurrent));
    while (
      !this.settled &&
      this.active.size < concurrency &&
      this.nextPlanIndex < this.plans.length
    ) {
      const plan = this.plans[this.nextPlanIndex];
      this.nextPlanIndex += 1;
      this.startPlan(plan);
    }
  }
}

export async function runPhase(
  run: SearchRunState,
  plans: readonly EnginePlan[],
  createWorker: () => SokomindEngineWorker,
  maxConcurrent = plans.length,
  maxPhaseElapsedMs?: number,
  options: PhaseRunOptions = {},
): Promise<PhaseOutcome> {
  return new PhaseRunner(
    run, plans, createWorker, maxConcurrent, maxPhaseElapsedMs, options,
  ).execute();
}
