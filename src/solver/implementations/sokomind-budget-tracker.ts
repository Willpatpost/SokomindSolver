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
  persistentEstimatedMemoryBytes = 0;
  private readonly workerLeases = new Map<string, {
    expanded: number;
    generated: number;
    memory: number;
  }>();

  leaseWorker(
    id: string,
    requested: Readonly<{ expanded?: number; generated?: number; memory?: number }>,
    available: Readonly<{ expanded?: number; generated?: number; memory?: number }>,
  ): Readonly<{ expanded?: number; generated?: number; memory?: number }> {
    const outstanding = [...this.workerLeases.values()].reduce(
      (sum, lease) => ({
        expanded: sum.expanded + lease.expanded,
        generated: sum.generated + lease.generated,
        memory: sum.memory + lease.memory,
      }),
      { expanded: 0, generated: 0, memory: 0 },
    );
    const grant = {
      expanded: leaseAmount(requested.expanded, available.expanded, outstanding.expanded),
      generated: leaseAmount(requested.generated, available.generated, outstanding.generated),
      memory: leaseAmount(requested.memory, available.memory, outstanding.memory),
    };
    this.workerLeases.set(id, {
      expanded: grant.expanded ?? 0,
      generated: grant.generated ?? 0,
      memory: grant.memory ?? 0,
    });
    return grant;
  }

  releaseWorkerLease(id: string): void {
    this.workerLeases.delete(id);
  }

  get leasedWorkerMemoryBytes(): number {
    let total = 0;
    for (const lease of this.workerLeases.values()) total += lease.memory;
    return total;
  }

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

  retainPersistent(bytes: number): void {
    this.persistentEstimatedMemoryBytes += bytes;
  }

  updatePersistent(oldBytes: number, newBytes: number): void {
    this.persistentEstimatedMemoryBytes += newBytes - oldBytes;
  }

  releasePersistent(bytes: number): void {
    this.persistentEstimatedMemoryBytes = Math.max(0, this.persistentEstimatedMemoryBytes - bytes);
  }
}

function leaseAmount(
  requested: number | undefined,
  available: number | undefined,
  outstanding: number,
): number | undefined {
  if (available === undefined) return requested;
  const remaining = Math.max(0, Math.floor(available) - outstanding);
  if (requested === undefined || !Number.isFinite(requested)) return remaining;
  return Math.min(Math.max(0, Math.floor(requested)), remaining);
}

function finitePositiveLimit(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}
