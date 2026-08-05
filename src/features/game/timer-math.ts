const TIMER_DISPLAY_INTERVAL_MS = 1_000;

export function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function calculateElapsedTime(
  accumulatedMs: number,
  resumedAtMs: number | null,
  nowMs: number,
): number {
  return resumedAtMs === null
    ? accumulatedMs
    : accumulatedMs + (nowMs - resumedAtMs);
}

export function nextTimerUpdateDelay(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return TIMER_DISPLAY_INTERVAL_MS;
  }

  const remainder = elapsedMs % TIMER_DISPLAY_INTERVAL_MS;
  return Math.max(1, TIMER_DISPLAY_INTERVAL_MS - remainder);
}
