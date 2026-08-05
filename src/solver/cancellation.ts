const DEFAULT_CANCELLATION_MESSAGE = "Solver run cancelled";

export class SolverCancelledError extends Error {
  readonly code = "SOLVER_CANCELLED";

  constructor(message = DEFAULT_CANCELLATION_MESSAGE) {
    super(message);
    this.name = "SolverCancelledError";
  }
}

/**
 * A stable cancellation check for hot search loops. Unlike
 * `AbortSignal.throwIfAborted`, this always throws the same domain error.
 */
export function throwIfSolverCancelled(signal: AbortSignal): void {
  if (!signal.aborted) return;

  const reason =
    typeof signal.reason === "string" && signal.reason.trim()
      ? signal.reason
      : DEFAULT_CANCELLATION_MESSAGE;
  throw new SolverCancelledError(reason);
}

export function isSolverCancellation(error: unknown): boolean {
  if (error instanceof SolverCancelledError) return true;
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return error.name === "AbortError";
  }
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      (error as Error & { code?: string }).code === "ABORT_ERR")
  );
}

export interface SolverCancellationController {
  readonly signal: AbortSignal;
  cancel(reason?: string): void;
  /**
   * Removes a parent-signal listener. It does not cancel the run.
   */
  dispose(): void;
}

/**
 * Creates a run-scoped controller and optionally links it to a broader
 * lifecycle signal (for example, page navigation).
 */
export function createSolverCancellationController(
  parentSignal?: AbortSignal,
): SolverCancellationController {
  const controller = new AbortController();
  const onParentAbort = () => {
    controller.abort(parentSignal?.reason ?? DEFAULT_CANCELLATION_MESSAGE);
  };

  if (parentSignal?.aborted) {
    onParentAbort();
  } else {
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  }

  return {
    signal: controller.signal,
    cancel(reason = DEFAULT_CANCELLATION_MESSAGE) {
      if (!controller.signal.aborted) controller.abort(reason);
    },
    dispose() {
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
  };
}
