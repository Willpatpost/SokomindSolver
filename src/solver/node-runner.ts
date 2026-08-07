import { Worker as NodeWorker } from "node:worker_threads";
import { cpus, totalmem } from "node:os";
import { fileURLToPath } from "node:url";
import {
  createSokomindSolverAdapter,
  type SokomindEngineWorker,
  type SokomindSolverAdapterOptions,
} from "./implementations/sokomind-solver.ts";
import type { SokomindProofWorker } from "./implementations/sokomind-proof.ts";
import type { SolverAdapter } from "./contracts.ts";

type WorkerMessageListener = (event: { data: unknown }) => void;
type WorkerErrorListener = (event: { message?: string; error?: unknown }) => void;

function wrapNodeWorker(
  worker: NodeWorker,
): SokomindEngineWorker & SokomindProofWorker {
  const messageListeners = new Set<WorkerMessageListener>();
  const errorListeners = new Set<WorkerErrorListener>();

  worker.on("message", (data: unknown) => {
    for (const listener of messageListeners) {
      listener({ data });
    }
  });

  worker.on("error", (err: Error) => {
    for (const listener of errorListeners) {
      listener({ message: err.message, error: err });
    }
  });

  worker.on("messageerror", (err: Error) => {
    for (const listener of errorListeners) {
      listener({ message: err.message, error: err });
    }
  });

  return {
    postMessage(message: unknown): void {
      worker.postMessage(message);
    },
    addEventListener(type: string, listener: WorkerMessageListener | WorkerErrorListener): void {
      if (type === "message") {
        messageListeners.add(listener as WorkerMessageListener);
      } else if (type === "error" || type === "messageerror") {
        errorListeners.add(listener as WorkerErrorListener);
      }
    },
    removeEventListener(type: string, listener: WorkerMessageListener | WorkerErrorListener): void {
      if (type === "message") {
        messageListeners.delete(listener as WorkerMessageListener);
      } else if (type === "error" || type === "messageerror") {
        errorListeners.delete(listener as WorkerErrorListener);
      }
    },
    terminate(): void {
      void worker.terminate();
    },
  };
}

function createNodeEngineWorker(): SokomindEngineWorker {
  const workerPath = fileURLToPath(
    new URL("./implementations/sokomind-engine.node-worker.ts", import.meta.url),
  );
  const worker = new NodeWorker(workerPath, {
    execArgv: ["--experimental-strip-types"],
  });
  return wrapNodeWorker(worker);
}

function createNodeProofWorker(): SokomindProofWorker {
  const workerPath = fileURLToPath(
    new URL("./implementations/sokomind-proof.node-worker.ts", import.meta.url),
  );
  const worker = new NodeWorker(workerPath, {
    execArgv: ["--experimental-strip-types"],
  });
  return wrapNodeWorker(worker);
}

export function createNodeSolverAdapter(
  options?: Partial<SokomindSolverAdapterOptions>,
): SolverAdapter {
  return createSokomindSolverAdapter({
    createWorker: createNodeEngineWorker,
    createProofWorker: createNodeProofWorker,
    hardwareConcurrency: cpus().length,
    deviceMemoryGb: totalmem() / (1024 ** 3),
    ...options,
  });
}
