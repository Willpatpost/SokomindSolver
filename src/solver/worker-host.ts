import {
  createSolverCancellationController,
  isSolverCancellation,
  type SolverCancellationController,
} from "./cancellation.ts";
import { assertSolverRequestCompatible } from "./compatibility.ts";
import type {
  SolverAdapter,
  SolverProgress,
  SolverResult,
} from "./contracts.ts";
import {
  isSolverWorkerCommand,
  serializeSolverError,
  SOLVER_WORKER_PROTOCOL_VERSION,
  type RunSolverCommand,
  type SolverWorkerEvent,
} from "./protocol.ts";
import { SolverRegistry } from "./registry.ts";
import {
  assertValidSolverProgress,
  assertValidSolverResult,
} from "./validation.ts";
import { assertVerifiedSolverSolution } from "./verification.ts";

interface SolverMessageEvent {
  readonly data: unknown;
}

export type SolverMessageListener = (event: SolverMessageEvent) => void;

/**
 * Smallest transport surface shared by a DedicatedWorkerGlobalScope and test
 * fakes. Keeping DOM globals outside the runtime makes worker behavior easy to
 * unit test.
 */
export interface SolverWorkerHostTransport {
  postMessage(message: SolverWorkerEvent): void;
  addEventListener(type: "message", listener: SolverMessageListener): void;
  removeEventListener(type: "message", listener: SolverMessageListener): void;
}

export interface SolverWorkerHostOptions {
  readonly now?: () => number;
}

interface ActiveRun {
  readonly jobId: string;
  readonly startedAt: number;
  readonly cancellation: SolverCancellationController;
  lastProgress?: SolverProgress;
  peakFrontierSize: number;
}

class SolverWorkerRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SolverWorkerRuntimeError";
    this.code = code;
  }
}

function inferJobId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const jobId = (value as { jobId?: unknown }).jobId;
  return typeof jobId === "string" && jobId.trim() ? jobId : undefined;
}

/**
 * Worker-side protocol host. It validates every inbound command and every
 * adapter output, owns one AbortController per job, and never publishes late
 * progress/results after cancellation or disposal.
 */
export class SolverWorkerHost {
  readonly #registry: SolverRegistry;
  readonly #transport: SolverWorkerHostTransport;
  readonly #now: () => number;
  readonly #runs = new Map<string, ActiveRun>();
  readonly #onMessage: SolverMessageListener;
  #started = false;
  #disposed = false;

  constructor(
    registry: SolverRegistry,
    transport: SolverWorkerHostTransport,
    options: SolverWorkerHostOptions = {},
  ) {
    this.#registry = registry;
    this.#transport = transport;
    this.#now = options.now ?? (() => performance.now());
    this.#onMessage = ({ data }) => {
      this.handleMessage(data);
    };
  }

  get activeJobCount(): number {
    return this.#runs.size;
  }

  start(): void {
    if (this.#disposed) {
      throw new SolverWorkerRuntimeError(
        "HOST_DISPOSED",
        "A disposed solver worker host cannot be restarted.",
      );
    }
    if (this.#started) return;
    this.#started = true;
    this.#transport.addEventListener("message", this.#onMessage);
  }

  /**
   * Public for hosts that prefer forwarding `self.onmessage` themselves.
   */
  handleMessage(value: unknown): void {
    if (this.#disposed) return;
    if (!isSolverWorkerCommand(value)) {
      this.#emitFailure(
        new SolverWorkerRuntimeError(
          "INVALID_SOLVER_COMMAND",
          "Worker received an invalid solver protocol command.",
        ),
        inferJobId(value),
      );
      return;
    }

    switch (value.type) {
      case "solver/discover":
        this.#discover();
        break;
      case "solver/cancel":
        this.#cancel(value.jobId, value.reason);
        break;
      case "solver/run":
        this.#run(value);
        break;
    }
  }

  dispose(reason = "Solver worker host disposed"): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#started) {
      this.#transport.removeEventListener("message", this.#onMessage);
    }
    this.#started = false;
    for (const run of this.#runs.values()) {
      run.cancellation.cancel(reason);
      run.cancellation.dispose();
    }
    this.#runs.clear();
  }

  #post(event: SolverWorkerEvent): void {
    if (!this.#disposed) this.#transport.postMessage(event);
  }

  #emitFailure(error: unknown, jobId?: string): void {
    this.#post({
      protocolVersion: SOLVER_WORKER_PROTOCOL_VERSION,
      type: "solver/failure",
      ...(jobId === undefined ? {} : { jobId }),
      error: serializeSolverError(error),
    });
  }

  #discover(): void {
    try {
      const solvers = this.#registry.listMetadata();
      this.#post({
        protocolVersion: SOLVER_WORKER_PROTOCOL_VERSION,
        type: "solver/ready",
        solvers,
      });
    } catch (error) {
      this.#emitFailure(error);
    }
  }

  #cancel(jobId: string, reason?: string): void {
    const run = this.#runs.get(jobId);
    if (!run) return;

    this.#runs.delete(jobId);
    run.cancellation.cancel(reason);
    run.cancellation.dispose();
    this.#post({
      protocolVersion: SOLVER_WORKER_PROTOCOL_VERSION,
      type: "solver/result",
      jobId,
      result: {
        status: "cancelled",
        metrics: this.#cancelledMetrics(run),
      },
    });
  }

  #run(command: RunSolverCommand): void {
    if (this.#runs.has(command.jobId)) {
      this.#emitFailure(
        new SolverWorkerRuntimeError(
          "DUPLICATE_SOLVER_JOB",
          `Solver job "${command.jobId}" is already running.`,
        ),
        command.jobId,
      );
      return;
    }

    let adapter: SolverAdapter;
    try {
      adapter = this.#registry.require(command.solverId);
      const metadata = this.#registry.requireMetadata(command.solverId);
      assertSolverRequestCompatible(metadata, command.request, "web-worker");
    } catch (error) {
      this.#emitFailure(error, command.jobId);
      return;
    }

    const run: ActiveRun = {
      jobId: command.jobId,
      startedAt: this.#now(),
      cancellation: createSolverCancellationController(),
      peakFrontierSize: 0,
    };
    this.#runs.set(command.jobId, run);
    void this.#execute(adapter, command, run);
  }

  #isActive(run: ActiveRun): boolean {
    return !this.#disposed && this.#runs.get(run.jobId) === run;
  }

  async #execute(
    adapter: SolverAdapter,
    command: RunSolverCommand,
    run: ActiveRun,
  ): Promise<void> {
    let invalidProgress: unknown;
    const reportProgress = (progress: SolverProgress) => {
      if (!this.#isActive(run) || run.cancellation.signal.aborted) return;
      try {
        assertValidSolverProgress(progress);
        if (run.lastProgress) {
          const prev = run.lastProgress;
          if (
            prev.lowerBound !== undefined &&
            progress.lowerBound !== undefined &&
            progress.lowerBound < prev.lowerBound
          ) {
            throw new SolverWorkerRuntimeError(
              "ERR_SOLVER_MONOTONICITY",
              `Progress lowerBound decreased from ${prev.lowerBound} to ${progress.lowerBound}`,
            );
          }
          if (
            prev.upperBound !== undefined &&
            progress.upperBound !== undefined &&
            progress.upperBound > prev.upperBound
          ) {
            throw new SolverWorkerRuntimeError(
              "ERR_SOLVER_MONOTONICITY",
              `Progress upperBound increased from ${prev.upperBound} to ${progress.upperBound}`,
            );
          }
          if (
            prev.gap !== undefined &&
            progress.gap !== undefined &&
            progress.gap > prev.gap
          ) {
            throw new SolverWorkerRuntimeError(
              "ERR_SOLVER_MONOTONICITY",
              `Progress gap increased from ${prev.gap} to ${progress.gap}`,
            );
          }
        }
      } catch (error) {
        invalidProgress = error;
        run.cancellation.cancel("Solver emitted invalid progress");
        throw error;
      }
      run.lastProgress = progress;
      run.peakFrontierSize = Math.max(
        run.peakFrontierSize,
        progress.frontierSize ?? 0,
      );
      this.#post({
        protocolVersion: SOLVER_WORKER_PROTOCOL_VERSION,
        type: "solver/progress",
        jobId: command.jobId,
        progress,
      });
    };

    try {
      const result = await adapter.solve(command.request, {
        signal: run.cancellation.signal,
        reportProgress,
        now: this.#now,
      });
      if (!this.#isActive(run)) return;
      if (invalidProgress) throw invalidProgress;
      if (run.cancellation.signal.aborted) {
        this.#finishCancelled(run);
        return;
      }

      assertValidSolverResult(result);
      if (result.status === "solved") {
        assertVerifiedSolverSolution(command.request, result.solution);
      }
      this.#finishResult(run, result);
    } catch (error) {
      if (!this.#isActive(run)) return;
      if (invalidProgress) {
        this.#finish(run);
        this.#emitFailure(invalidProgress, command.jobId);
      } else if (
        isSolverCancellation(error) ||
        run.cancellation.signal.aborted
      ) {
        this.#finishCancelled(run);
      } else {
        this.#finish(run);
        this.#emitFailure(error, command.jobId);
      }
    }
  }

  #finish(run: ActiveRun): boolean {
    if (!this.#isActive(run)) return false;
    this.#runs.delete(run.jobId);
    run.cancellation.dispose();
    return true;
  }

  #finishResult(run: ActiveRun, result: SolverResult): void {
    if (!this.#finish(run)) return;
    this.#post({
      protocolVersion: SOLVER_WORKER_PROTOCOL_VERSION,
      type: "solver/result",
      jobId: run.jobId,
      result,
    });
  }

  #finishCancelled(run: ActiveRun): void {
    this.#finishResult(run, {
      status: "cancelled",
      metrics: this.#cancelledMetrics(run),
    });
  }

  #cancelledMetrics(run: ActiveRun): SolverResult["metrics"] {
    const progress = run.lastProgress;
    return {
      elapsedMs: Math.max(0, this.#now() - run.startedAt),
      ...(progress?.expandedStates === undefined
        ? {}
        : { expandedStates: progress.expandedStates }),
      ...(progress?.generatedStates === undefined
        ? {}
        : { generatedStates: progress.generatedStates }),
      peakFrontierSize: run.peakFrontierSize,
      ...(progress?.counters === undefined
        ? {}
        : { counters: progress.counters }),
    };
  }
}
