import { Worker } from "node:worker_threads";
import { availableParallelism, freemem } from "node:os";

export interface PoolStats {
  readonly workers: number;
  readonly active: number;
  readonly queued: number;
  readonly completed: number;
  readonly peakActive: number;
  readonly peakQueued: number;
  readonly taskMs: Readonly<Record<string, number>>;
  readonly taskCounts: Readonly<Record<string, number>>;
  readonly peakRssMb: number;
}

export function getForgePoolSize(): number {
  const value = Number(process.env["SOKOMIND_FORGE_CONCURRENCY"]);
  if (Number.isSafeInteger(value) && value >= 1 && value <= 64) return value;
  // Eight workers won the fixed-workload sweep on the development 8-core CPU.
  // Larger machines can override this conservative default after benchmarking.
  return Math.max(1, Math.min(8, availableParallelism() - 1, Math.floor(freemem() / 2 ** 30)));
}

interface Pending {
  index: number;
  payload: unknown;
  kind: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  started?: number;
}

/** One reusable pool shared by stages and tiers; map results retain input order. */
export class ForgeWorkerPool {
  readonly concurrency: number;
  readonly maxQueued: number;
  private readonly workers = new Map<Worker, Pending | null>();
  private readonly queue: Pending[] = [];
  private nextIndex = 0;
  private completed = 0;
  private peakActive = 0;
  private peakQueued = 0;
  private peakRssMb = 0;
  private readonly taskMs: Record<string, number> = {};
  private readonly taskCounts: Record<string, number> = {};
  private failure?: Error;
  private closed = false;
  private closing?: Promise<void>;
  private readonly workerPath: string | URL;
  private readonly sharedData: unknown;
  private readonly signal?: AbortSignal;
  private readonly memoryBudgetMb?: number;
  private readonly initialRssMb = process.memoryUsage.rss() / 2 ** 20;

  constructor(workerPath: string | URL = new URL("./forge-worker.ts", import.meta.url),
    sharedData: unknown = undefined, concurrency = getForgePoolSize(), signal?: AbortSignal, memoryBudgetMb?: number) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 64) {
      throw new Error("Forge concurrency must be an integer in [1, 64]");
    }
    this.workerPath = workerPath;
    this.sharedData = sharedData;
    this.signal = signal;
    if (memoryBudgetMb !== undefined && (!Number.isFinite(memoryBudgetMb) || memoryBudgetMb < 128)) {
      throw new Error("Forge memory budget must be at least 128 MB");
    }
    this.memoryBudgetMb = memoryBudgetMb;
    this.concurrency = concurrency;
    this.maxQueued = concurrency * 4;
    signal?.addEventListener("abort", this.abort, { once: true });
    if (signal?.aborted) this.abort();
  }

  private readonly abort = (): void => { this.fail(new Error("Forge generation cancelled")); };

  cancel(): void { this.abort(); }

  submit<R>(payload: unknown, kind = "task"): Promise<R> {
    if (this.failure || this.closed) return Promise.reject(this.failure ?? new Error("Forge pool is closed"));
    if (this.queue.length >= this.maxQueued) return Promise.reject(new Error("Forge queue capacity exceeded; use map() for backpressure"));
    return new Promise<R>((resolve, reject) => {
      this.queue.push({ index: this.nextIndex++, payload, kind, resolve: resolve as (value: unknown) => void, reject });
      this.peakQueued = Math.max(this.peakQueued, this.queue.length);
      this.dispatch();
    });
  }

  /** Mappers may submit dependent jobs immediately, without waiting for a batch. */
  async map<T, R>(items: readonly T[], mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(items.length, this.concurrency * 2) }, async () => {
      while (next < items.length) {
        if (this.failure || this.closed) throw this.failure ?? new Error("Forge pool is closed");
        const index = next++;
        results[index] = await mapper(items[index], index);
      }
    }));
    return results;
  }

  private dispatch(): void {
    for (const [worker, task] of this.workers) {
      if (!task && this.queue.length > 0) this.feed(worker);
    }
    while (!this.closed && !this.failure && this.queue.length > 0 && this.workers.size < this.concurrency) {
      let worker: Worker;
      try {
        worker = new Worker(this.workerPath, { workerData: this.sharedData, execArgv: ["--experimental-strip-types"],
          ...(this.memoryBudgetMb ? { resourceLimits: {
            maxOldGenerationSizeMb: Math.max(64, Math.floor(this.memoryBudgetMb / this.concurrency * 0.7)),
          } } : {}),
        });
      } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); return; }
      this.workers.set(worker, null);
      worker.on("message", (msg: { type: string; index: number; result?: unknown; error?: string }) => {
        if (this.closed || this.failure) return;
        const task = this.workers.get(worker);
        if (!task || msg.index !== task.index || (msg.type !== "result" && msg.type !== "error")) {
          this.fail(new Error("Invalid forge worker response")); return;
        }
        if (msg.type === "error") { this.fail(new Error(msg.error ?? "Forge task failed")); return; }
        this.workers.set(worker, null);
        this.completed++;
        this.taskMs[task.kind] = (this.taskMs[task.kind] ?? 0) + performance.now() - task.started!;
        this.taskCounts[task.kind] = (this.taskCounts[task.kind] ?? 0) + 1;
        this.sampleMemory();
        if (this.memoryBudgetMb && this.peakRssMb > this.initialRssMb + this.memoryBudgetMb) {
          task.reject(new Error("Forge memory budget exceeded"));
          this.fail(new Error("Forge memory budget exceeded")); return;
        }
        task.resolve(msg.result);
        this.dispatch();
      });
      worker.on("error", (error) => this.fail(error));
      worker.on("exit", (code) => {
        const pending = this.workers.get(worker);
        this.workers.delete(worker);
        if (!this.closed && !this.failure) {
          const error = new Error(`Forge worker exited unexpectedly with code ${code}`);
          pending?.reject(error);
          this.fail(error);
        }
      });
      this.feed(worker);
    }
  }

  private feed(worker: Worker): void {
    const task = this.queue.shift();
    if (!task) return;
    task.started = performance.now();
    this.workers.set(worker, task);
    this.peakActive = Math.max(this.peakActive, [...this.workers.values()].filter(Boolean).length);
    try { worker.postMessage({ type: "task", index: task.index, payload: task.payload }); }
    catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }

  private fail(error: Error): void {
    if (this.failure || this.closed) return;
    this.failure = error;
    void this.close();
  }

  private sampleMemory(): void {
    this.peakRssMb = Math.max(this.peakRssMb, process.memoryUsage.rss() / 2 ** 20);
  }

  snapshot(): PoolStats {
    this.sampleMemory();
    return { workers: this.workers.size, active: [...this.workers.values()].filter(Boolean).length,
      queued: this.queue.length, completed: this.completed, peakActive: this.peakActive, peakQueued: this.peakQueued,
      taskMs: { ...this.taskMs }, taskCounts: { ...this.taskCounts }, peakRssMb: this.peakRssMb };
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.signal?.removeEventListener("abort", this.abort);
    const error = this.failure ?? new Error("Forge pool closed before task completion");
    for (const task of this.queue.splice(0)) task.reject(error);
    for (const task of this.workers.values()) task?.reject(error);
    this.closing = Promise.all([...this.workers.keys()].map((worker) => worker.terminate())).then(() => {
      this.workers.clear();
    });
    return this.closing;
  }
}

/** Compatibility wrapper. Always joins every worker before returning. */
export async function runWorkerPool<T, R>(workerPath: string | URL, tasks: readonly T[], sharedData: unknown, concurrency?: number): Promise<R[]> {
  if (tasks.length === 0) return [];
  const pool = new ForgeWorkerPool(workerPath, sharedData, Math.min(concurrency ?? getForgePoolSize(), tasks.length));
  try { return await pool.map(tasks, (task) => pool.submit<R>(task)); }
  finally { await pool.close(); }
}
