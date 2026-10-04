import { isProofResult, PROOF_HEARTBEAT_MS } from "./sokomind-proof-protocol.ts";
import type { SokomindProofWorker } from "./sokomind-proof.ts";

/** A cancelled lane that has not gone idle within this long is terminated. */
export const PROOF_DRAIN_TIMEOUT_MS = Math.min(PROOF_HEARTBEAT_MS, 2_000);

/**
 * Lends proof lanes to coordinator runs. A run hands every lane it acquired
 * back through exactly one of release, drain or discard.
 */
export interface ProofWorkerSource {
  /** A lane for one run. It may have served an earlier run. */
  acquire(): SokomindProofWorker;
  /** The lane holds no partition, so a later run may use it. */
  release(worker: SokomindProofWorker): void;
  /**
   * The lane was cancelled mid-partition. A later run may use it only after
   * it posts the idle that ends that partition.
   */
  drain(worker: SokomindProofWorker, runId: number, partitionId: string): void;
  /** The lane failed, so it is never used again. */
  discard(worker: SokomindProofWorker): void;
}

export interface ProofWorkerPool extends ProofWorkerSource {
  /** Terminates every lane the pool holds; lanes handed back later are terminated. */
  dispose(): void;
}

/** Every run gets fresh lanes, each terminated when the run ends. */
export function proofWorkerSourceFromFactory(
  createProofWorker: () => SokomindProofWorker,
): ProofWorkerSource {
  const terminate = (worker: SokomindProofWorker): void => worker.terminate();
  return {
    acquire: createProofWorker,
    release: terminate,
    drain: terminate,
    discard: terminate,
  };
}

/**
 * Keeps healthy lanes between the coordinator runs of one request. Acquiring
 * never waits: with no idle lane, a new lane replaces the oldest cancelled
 * one, so the pool never holds more lanes than one run used.
 */
export function createProofWorkerPool(
  createProofWorker: () => SokomindProofWorker,
  { drainTimeoutMs = PROOF_DRAIN_TIMEOUT_MS }: { readonly drainTimeoutMs?: number } = {},
): ProofWorkerPool {
  // Each held lane maps to the call that stops watching it.
  const idle = new Map<SokomindProofWorker, () => void>();
  // Oldest drain first; each call terminates its lane.
  const draining = new Map<SokomindProofWorker, () => void>();
  let disposed = false;

  function park(worker: SokomindProofWorker): void {
    if (disposed) {
      worker.terminate();
      return;
    }
    // A lane that crashes while it waits is dropped, never lent.
    const onError = (): void => {
      unwatch();
      idle.delete(worker);
      worker.terminate();
    };
    const unwatch = (): void => {
      worker.removeEventListener("error", onError);
      worker.removeEventListener("messageerror", onError);
    };
    worker.addEventListener("error", onError);
    worker.addEventListener("messageerror", onError);
    idle.set(worker, unwatch);
  }

  return {
    acquire(): SokomindProofWorker {
      const [parked] = idle;
      if (parked) {
        const [worker, unwatch] = parked;
        idle.delete(worker);
        unwatch();
        return worker;
      }
      const [abandonOldest] = draining.values();
      abandonOldest?.();
      return createProofWorker();
    },

    release: park,

    drain(worker: SokomindProofWorker, runId: number, partitionId: string): void {
      if (disposed) {
        worker.terminate();
        return;
      }
      // Messages on one port arrive in order, so nothing from the cancelled
      // partition can follow its idle.
      const settle = (reusable: boolean): void => {
        clearTimeout(timer);
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
        worker.removeEventListener("messageerror", onError);
        draining.delete(worker);
        if (reusable) park(worker);
        else worker.terminate();
      };
      const onMessage = (event: { data: unknown }): void => {
        const data = event.data;
        if (isProofResult(data) && data.type === "proof/idle" &&
            data.runId === runId && data.partitionId === partitionId) {
          settle(true);
        }
      };
      const onError = (): void => settle(false);
      const timer = setTimeout(() => settle(false), drainTimeoutMs);
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      worker.addEventListener("messageerror", onError);
      draining.set(worker, () => settle(false));
    },

    discard(worker: SokomindProofWorker): void {
      worker.terminate();
    },

    dispose(): void {
      disposed = true;
      for (const abandon of [...draining.values()]) abandon();
      for (const [worker, unwatch] of idle) {
        unwatch();
        worker.terminate();
      }
      idle.clear();
    },
  };
}
