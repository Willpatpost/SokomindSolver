import {
  createSolverWorkerClient,
  type SolverMetadata,
  type SolverWorkerClient,
} from "../../solver/index.ts";

type TimerHandle = unknown;

export class HintWorkerTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HintWorkerTimeoutError";
  }
}

export interface HintWorkerConnectionOptions {
  readonly startupTimeoutMs: number;
  readonly onFailure: (error: Error) => void;
  readonly setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  readonly clearTimer?: (handle: TimerHandle) => void;
}

export interface HintWorkerConnection {
  readonly client: SolverWorkerClient;
  discover(): Promise<readonly SolverMetadata[]>;
  waitFor<T>(
    promise: Promise<T>,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<T>;
  dispose(): void;
}

/**
 * Owns one hint worker, including its fatal-event listeners and response
 * watchdogs. Disposing the connection rejects pending client work and
 * terminates the worker, so a silent or broken worker cannot retain resources.
 */
export function createHintWorkerConnection(
  worker: Worker,
  options: HintWorkerConnectionOptions,
): HintWorkerConnection {
  if (!Number.isFinite(options.startupTimeoutMs) || options.startupTimeoutMs <= 0) {
    throw new RangeError("Hint worker startup timeout must be positive.");
  }

  const setTimer = options.setTimer ?? ((callback, delayMs) =>
    globalThis.setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer ?? ((handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  const client = createSolverWorkerClient(worker);
  let disposed = false;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    worker.removeEventListener("error", onWorkerError);
    worker.removeEventListener("messageerror", onMessageError);
    client.dispose();
  };

  const fail = (error: Error) => {
    if (disposed) return;
    dispose();
    options.onFailure(error);
  };

  function onWorkerError(event: ErrorEvent) {
    fail(new Error(event.message || "The hint worker stopped unexpectedly."));
  }

  function onMessageError() {
    fail(new Error("The hint worker returned an unreadable message."));
  }

  worker.addEventListener("error", onWorkerError);
  worker.addEventListener("messageerror", onMessageError);

  const waitFor = <T>(
    promise: Promise<T>,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<T> => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new RangeError("Hint worker timeout must be positive."));
    }

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = setTimer(() => {
        if (settled) return;
        settled = true;
        const error = new HintWorkerTimeoutError(timeoutMessage);
        fail(error);
        reject(error);
      }, timeoutMs);

      void promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimer(timer);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimer(timer);
          reject(error);
        },
      );
    });
  };

  return Object.freeze({
    client,
    discover: () => waitFor(
      client.discover(),
      options.startupTimeoutMs,
      "The hint worker did not respond during startup.",
    ),
    waitFor,
    dispose,
  });
}
