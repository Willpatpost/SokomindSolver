let workerScheduler: (() => Promise<void>) | undefined;

/** An isolated offline host may supply its own scheduler. Browser defaults are unchanged. */
export function configureSearchScheduler(scheduler?: () => Promise<void>): void {
  workerScheduler = scheduler;
}

export function delayForEventLoop(): Promise<void> {
  if (workerScheduler) return workerScheduler();
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
