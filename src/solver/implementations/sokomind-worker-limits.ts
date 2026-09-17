// Shared limits for browser controls and the production search scheduler.
export const DEFAULT_MAX_ENGINE_WORKERS = 12;
export const WORKER_MEMORY_RESERVATION_BYTES = 256 * 1024 * 1024;
export const PROOF_WORKER_MEMORY_RESERVATION_BYTES = 512 * 1024 * 1024;
export const COORDINATOR_MEMORY_RESERVATION_BYTES = 128 * 1024 * 1024;

export type WorkerLimitReason = "hardware" | "memory" | "cap" | "requested";

export interface EffectiveWorkerResult {
  readonly count: number;
  readonly limitedBy: WorkerLimitReason;
}

function workerCount(
  totalMemoryBytes: number,
  hardwareConcurrency: number,
  requestedWorkers: number,
  reservationBytes: number,
): EffectiveWorkerResult {
  const memoryBytes = Number.isNaN(totalMemoryBytes) ? 0 : totalMemoryBytes;
  const available = Math.max(0, memoryBytes - COORDINATOR_MEMORY_RESERVATION_BYTES);
  const memoryBound = Math.max(1, Math.floor(available / reservationBytes));
  const hardwareBound = Number.isFinite(hardwareConcurrency)
    ? Math.max(1, Math.floor(hardwareConcurrency) - 1) : 1;
  const requestedBound = requestedWorkers > 0
    ? Math.max(1, Math.floor(requestedWorkers))
    : DEFAULT_MAX_ENGINE_WORKERS;
  const count = Math.min(DEFAULT_MAX_ENGINE_WORKERS, hardwareBound, memoryBound, requestedBound);
  const limitedBy: WorkerLimitReason =
    count === memoryBound && memoryBound <= hardwareBound && memoryBound <= requestedBound ? "memory"
    : count === hardwareBound && hardwareBound <= requestedBound ? "hardware"
    : requestedWorkers > 0 && count === requestedBound ? "requested"
    : "cap";
  return { count, limitedBy };
}

/** Zero selects Auto. Counts are ceilings; a phase can have fewer useful tasks. */
export function effectiveWorkerCount(
  totalMemoryBytes: number,
  hardwareConcurrency: number,
  requestedWorkers = 0,
): EffectiveWorkerResult {
  return workerCount(totalMemoryBytes, hardwareConcurrency, requestedWorkers, WORKER_MEMORY_RESERVATION_BYTES);
}

export function effectiveProofWorkerCount(
  totalMemoryBytes: number,
  hardwareConcurrency: number,
  requestedWorkers = 0,
): EffectiveWorkerResult {
  return workerCount(totalMemoryBytes, hardwareConcurrency, requestedWorkers, PROOF_WORKER_MEMORY_RESERVATION_BYTES);
}
