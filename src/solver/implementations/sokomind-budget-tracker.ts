import type { SolverLimits } from "../contracts.ts";

export interface AggregateSnapshot {
  readonly expandedStates: number;
  readonly generatedStates: number;
  readonly frontierSize: number;
  readonly peakFrontierSize: number;
  readonly estimatedMemoryBytes: number;
  readonly peakEstimatedMemoryBytes: number;
  readonly counters: Readonly<Record<string, number>>;
}

export type BudgetStopReason =
  | "cancelled"
  | "elapsed"
  | "expanded"
  | "generated"
  | "memory";

export class BudgetTracker {
  peakFrontierSize = 0;
  peakEstimatedMemoryBytes = 0;
  coordinatorRecordCount = 0;
  peakCoordinatorRecordCount = 0;
  coordinatorEstimatedMemoryBytes = 0;
  preparedBoardEstimatedMemoryBytes = 0;

  checkLimit(
    snapshot: AggregateSnapshot,
    limits: SolverLimits | undefined,
    signal: AbortSignal,
    now: number,
    deadline: number,
  ): BudgetStopReason | undefined {
    if (signal.aborted) return "cancelled";
    if (now >= deadline) return "elapsed";
    const maxExpanded = finitePositiveLimit(limits?.maxExpandedStates);
    if (maxExpanded !== undefined && snapshot.expandedStates >= maxExpanded) {
      return "expanded";
    }
    const maxGenerated = finitePositiveLimit(limits?.maxGeneratedStates);
    if (
      maxGenerated !== undefined &&
      snapshot.generatedStates >= maxGenerated
    ) {
      return "generated";
    }
    const maxMemory = finitePositiveLimit(limits?.maxMemoryBytes);
    if (
      maxMemory !== undefined &&
      snapshot.estimatedMemoryBytes >= maxMemory
    ) {
      return "memory";
    }
    return undefined;
  }

  retainRecord(recordBytes: number): void {
    this.coordinatorRecordCount += 1;
    this.peakCoordinatorRecordCount = Math.max(
      this.peakCoordinatorRecordCount,
      this.coordinatorRecordCount,
    );
    this.coordinatorEstimatedMemoryBytes += recordBytes;
  }

  updateRecord(oldRecordBytes: number, newRecordBytes: number): void {
    this.coordinatorEstimatedMemoryBytes +=
      newRecordBytes - oldRecordBytes;
  }

  resetPhase(): void {
    this.coordinatorRecordCount = 0;
    this.coordinatorEstimatedMemoryBytes = 0;
  }
}

function finitePositiveLimit(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}
