import { throwIfSolverCancelled } from "../cancellation.ts";

export type ExactPreprocessingLimitReason = "elapsed" | "memory";

export class ExactPreprocessingLimitError extends Error {
  readonly reason: ExactPreprocessingLimitReason;
  readonly estimatedMemoryBytes: number;

  constructor(reason: ExactPreprocessingLimitReason, estimatedMemoryBytes: number) {
    super(
      reason === "elapsed"
        ? "Maximum elapsed time reached during exact-search preprocessing."
        : "Estimated solver memory limit reached during exact-search preprocessing.",
    );
    this.name = "ExactPreprocessingLimitError";
    this.reason = reason;
    this.estimatedMemoryBytes = estimatedMemoryBytes;
  }
}

export interface ExactPreprocessingBudget {
  readonly signal: AbortSignal;
  readonly now: () => number;
  readonly deadline: number;
  readonly maxMemoryBytes?: number;
  readonly baseMemoryBytes: number;
}

export function checkExactPreprocessingBudget(
  budget: ExactPreprocessingBudget | undefined,
  additionalBytes = 0,
): void {
  if (!budget) return;
  throwIfSolverCancelled(budget.signal);
  const estimatedMemoryBytes = budget.baseMemoryBytes + Math.max(0, additionalBytes);
  if (
    budget.maxMemoryBytes !== undefined &&
    estimatedMemoryBytes > budget.maxMemoryBytes
  ) {
    throw new ExactPreprocessingLimitError("memory", estimatedMemoryBytes);
  }
  if (budget.now() >= budget.deadline) {
    throw new ExactPreprocessingLimitError("elapsed", estimatedMemoryBytes);
  }
}

export function isExactPreprocessingLimitError(
  value: unknown,
): value is ExactPreprocessingLimitError {
  return value instanceof ExactPreprocessingLimitError;
}
