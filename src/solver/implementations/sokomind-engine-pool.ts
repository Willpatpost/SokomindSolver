import type { SokomindEngineWorker } from "./sokomind-phase-runner.ts";

/**
 * A parked engine that no plan takes within this long is terminated, so idle
 * engines do not hold their heaps through a long proof.
 */
export const ENGINE_IDLE_TIMEOUT_MS = 1_000;

/**
 * Lends engine workers to phase runs. A run hands every worker it acquired
 * back through release exactly once.
 */
export interface EngineWorkerSource {
  /** A worker for one plan. It may have run earlier plans to completion. */
  acquire(): SokomindEngineWorker;
  /**
   * `reusable` means the worker answered its last command with a done that
   * did not fail. The engine runs each command synchronously and posts done
   * last, so such a worker is idle. Any other worker is terminated.
   */
  release(worker: SokomindEngineWorker, reusable: boolean): void;
}

export interface EngineWorkerPool extends EngineWorkerSource {
  /** Terminates every parked worker; workers handed back later are terminated. */
  dispose(): void;
}

/** Every plan gets a fresh worker, terminated when the plan ends. */
export function engineWorkerSourceFromFactory(
  createWorker: () => SokomindEngineWorker,
): EngineWorkerSource {
  return {
    acquire: createWorker,
    release: (worker) => worker.terminate(),
  };
}

/**
 * Keeps idle engine workers between the plans and phases of one request.
 * Acquiring never waits: with no lendable worker, it creates one.
 *
 * A released worker becomes lendable only after a microtask. The done that
 * freed it may still be on its way to other listeners, and a wrapper that
 * iterates a live listener set would also hand it to the listener of a plan
 * that took the worker inside that dispatch. A plan started from the done
 * therefore takes another worker, so the pool can hold one worker more than
 * the phases ran at once.
 */
export function createEngineWorkerPool(
  createWorker: () => SokomindEngineWorker,
  { idleTimeoutMs = ENGINE_IDLE_TIMEOUT_MS }: { readonly idleTimeoutMs?: number } = {},
): EngineWorkerPool {
  // Each parked worker maps to the call that stops watching it.
  const idle = new Map<SokomindEngineWorker, () => void>();
  // Parked workers whose release has not yet left the current dispatch.
  const settling = new Set<SokomindEngineWorker>();
  let disposed = false;

  return {
    acquire(): SokomindEngineWorker {
      for (const [worker, unwatch] of idle) {
        if (settling.has(worker)) continue;
        idle.delete(worker);
        unwatch();
        return worker;
      }
      return createWorker();
    },

    release(worker: SokomindEngineWorker, reusable: boolean): void {
      if (disposed || !reusable) {
        worker.terminate();
        return;
      }
      // A worker that crashes or outstays the idle timeout is dropped.
      const retire = (): void => {
        unwatch();
        idle.delete(worker);
        settling.delete(worker);
        worker.terminate();
      };
      const unwatch = (): void => {
        clearTimeout(timer);
        worker.removeEventListener("error", retire);
        worker.removeEventListener("messageerror", retire);
      };
      const timer = setTimeout(retire, idleTimeoutMs);
      worker.addEventListener("error", retire);
      worker.addEventListener("messageerror", retire);
      idle.set(worker, unwatch);
      settling.add(worker);
      queueMicrotask(() => settling.delete(worker));
    },

    dispose(): void {
      disposed = true;
      for (const [worker, unwatch] of idle) {
        unwatch();
        worker.terminate();
      }
      idle.clear();
      settling.clear();
    },
  };
}
