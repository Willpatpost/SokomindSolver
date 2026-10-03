/** What a yield may use from its host; Node and browser windows and workers all qualify. */
export interface EventLoopHost {
  readonly setImmediate?: (callback: () => void) => unknown;
  readonly MessageChannel?: new () => {
    readonly port1: { onmessage: ((event: never) => void) | null };
    readonly port2: { postMessage(message: undefined): void };
  };
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
}

let workerScheduler: (() => Promise<void>) | undefined;
let defaultYield: (() => Promise<void>) | undefined;

/** An isolated offline host may supply its own scheduler; no argument restores the default. */
export function configureSearchScheduler(scheduler?: () => Promise<void>): void {
  workerScheduler = scheduler;
}

/**
 * A macrotask yield, so a CPU-heavy search still receives cancellation and
 * other messages. setTimeout is the last resort because hosts clamp it to at
 * least 1 ms (browsers to 4 ms once nested), which a search yielding every few
 * hundred states pays on every yield.
 */
export function createEventLoopYield(host: EventLoopHost): () => Promise<void> {
  const { setImmediate, MessageChannel } = host;
  if (setImmediate) return () => new Promise((resolve) => { setImmediate(resolve); });
  if (MessageChannel) {
    const { port1, port2 } = new MessageChannel();
    const waiting: (() => void)[] = [];
    port1.onmessage = () => { waiting.shift()?.(); };
    return () => new Promise((resolve) => {
      waiting.push(resolve);
      port2.postMessage(undefined);
    });
  }
  return () => new Promise((resolve) => { host.setTimeout(resolve, 0); });
}

export function delayForEventLoop(): Promise<void> {
  if (workerScheduler) return workerScheduler();
  defaultYield ??= createEventLoopYield(globalThis);
  return defaultYield();
}
