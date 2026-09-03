import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";

export interface PoolTask<T> {
  readonly index: number;
  readonly payload: T;
}

export interface PoolResult<R> {
  readonly index: number;
  readonly result: R;
}

export function getForgePoolSize(): number {
  const envVal = process.env["SOKOMIND_FORGE_CONCURRENCY"];
  if (envVal) {
    const n = Number(envVal);
    if (Number.isSafeInteger(n) && n >= 1 && n <= 64) return n;
  }
  return Math.max(1, availableParallelism() - 1);
}

export async function runWorkerPool<T, R>(
  workerPath: string,
  tasks: readonly T[],
  sharedData: unknown,
  concurrency?: number,
): Promise<R[]> {
  const poolSize = Math.min(concurrency ?? getForgePoolSize(), tasks.length);
  if (poolSize <= 0) return [];

  const results: R[] = new Array(tasks.length);
  let nextIndex = 0;
  let completedCount = 0;

  return new Promise<R[]>((resolveAll, rejectAll) => {
    let rejected = false;
    const workers: Worker[] = [];

    function feedWorker(worker: Worker): void {
      if (nextIndex < tasks.length) {
        const idx = nextIndex++;
        worker.postMessage({ type: "task", index: idx, payload: tasks[idx] });
      } else {
        worker.postMessage({ type: "shutdown" });
      }
    }

    for (let i = 0; i < poolSize; i++) {
      const worker = new Worker(workerPath, {
        workerData: sharedData,
        execArgv: ["--experimental-strip-types"],
      });

      workers.push(worker);

      worker.on("message", (msg: { type: string; index: number; result: R }) => {
        if (msg.type === "result") {
          results[msg.index] = msg.result;
          completedCount++;
          if (completedCount === tasks.length) {
            resolveAll(results);
          } else {
            feedWorker(worker);
          }
        }
      });

      worker.on("error", (err) => {
        if (!rejected) {
          rejected = true;
          for (const w of workers) w.terminate();
          rejectAll(err);
        }
      });

      worker.on("exit", (code) => {
        if (code !== 0 && !rejected && completedCount < tasks.length) {
          rejected = true;
          for (const w of workers) w.terminate();
          rejectAll(new Error(`Forge worker exited with code ${code}`));
        }
      });

      feedWorker(worker);
    }
  });
}
