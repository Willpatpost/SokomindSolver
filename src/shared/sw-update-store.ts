export interface ServiceWorkerUpdate {
  readonly sequence: number;
  readonly waitingWorker: ServiceWorker;
}

let updateSequence = 0;
let updateAvailable: ServiceWorkerUpdate | null = null;
const listeners = new Set<() => void>();

function publish(): void {
  for (const listener of listeners) listener();
}

export function notifyUpdateAvailable(waitingWorker: ServiceWorker): void {
  if (updateAvailable?.waitingWorker === waitingWorker) return;
  updateSequence += 1;
  updateAvailable = Object.freeze({
    sequence: updateSequence,
    waitingWorker,
  });
  publish();
}

export function activateWaitingUpdate(waitingWorker: ServiceWorker): void {
  waitingWorker.postMessage({ type: "SKIP_WAITING" });
}

export function subscribeToUpdate(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getUpdateSnapshot(): ServiceWorkerUpdate | null {
  return updateAvailable;
}
