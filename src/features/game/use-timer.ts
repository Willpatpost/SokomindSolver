import { useCallback, useEffect, useRef, useState } from "react";
import {
  calculateElapsedTime,
  nextTimerUpdateDelay,
} from "./timer-math.ts";

export interface TimerController {
  readonly elapsed: number;
  readonly running: boolean;
  reset(): void;
}

function readPersistedTime(key: string | undefined): number {
  if (!key) return 0;
  try {
    const stored = sessionStorage.getItem(key);
    if (stored !== null) {
      const parsed = Number(stored);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  } catch {
    // sessionStorage may be unavailable; silently ignore.
  }
  return 0;
}

export function useTimer(options: {
  paused: boolean;
  persistKey?: string;
  restorePersisted?: boolean;
  persistenceReady?: boolean;
}): TimerController {
  const {
    paused,
    persistKey,
    restorePersisted = true,
    persistenceReady = true,
  } = options;
  const [initialElapsed] = useState(() =>
    persistenceReady && restorePersisted ? readPersistedTime(persistKey) : 0);
  const [elapsed, setElapsed] = useState(initialElapsed);
  const [running, setRunning] = useState(false);
  const stateRef = useRef<{ accumulated: number; resumedAt: number | null }>(
    null as never,
  );
  // Lazy-init the ref so it matches the restored elapsed value on first render.
  if (stateRef.current === null) {
    stateRef.current = {
      accumulated: initialElapsed,
      resumedAt: null,
    };
  }
  const timeoutRef = useRef<number | undefined>(undefined);
  const persistenceDecisionRef = useRef<string | undefined>(
    persistenceReady && persistKey && restorePersisted
      ? `${persistKey}:restore`
      : undefined,
  );

  const stopTick = useCallback(() => {
    if (timeoutRef.current === undefined) return;
    window.clearTimeout(timeoutRef.current);
    timeoutRef.current = undefined;
  }, []);

  useEffect(() => {
    if (!persistenceReady || !persistKey) return;
    const decision = `${persistKey}:${restorePersisted ? "restore" : "clear"}`;
    if (persistenceDecisionRef.current === decision) return;

    stopTick();
    const restored = restorePersisted ? readPersistedTime(persistKey) : 0;
    stateRef.current.accumulated = restored;
    stateRef.current.resumedAt = null;
    setElapsed(restored);
    setRunning(false);
    persistenceDecisionRef.current = decision;

    if (restorePersisted) return;
    try {
      sessionStorage.removeItem(persistKey);
    } catch {
      // sessionStorage may be unavailable; silently ignore.
    }
  }, [persistKey, persistenceReady, restorePersisted, stopTick]);

  function startTick() {
    const state = stateRef.current;
    stopTick();

    function tick() {
      if (state.resumedAt === null) return;
      const nextElapsed = calculateElapsedTime(
        state.accumulated,
        state.resumedAt,
        performance.now(),
      );
      setElapsed(nextElapsed);
      timeoutRef.current = window.setTimeout(
        tick,
        nextTimerUpdateDelay(nextElapsed),
      );
    }

    if (state.resumedAt === null) return;
    const currentElapsed = calculateElapsedTime(
      state.accumulated,
      state.resumedAt,
      performance.now(),
    );
    timeoutRef.current = window.setTimeout(
      tick,
      nextTimerUpdateDelay(currentElapsed),
    );
  }

  function persistAccumulated() {
    if (!persistenceReady || !persistKey) return;
    try {
      sessionStorage.setItem(
        persistKey,
        String(stateRef.current.accumulated),
      );
    } catch {
      // sessionStorage may be unavailable; silently ignore.
    }
  }

  useEffect(() => {
    const state = stateRef.current;

    if (!persistenceReady) {
      stopTick();
      return stopTick;
    }

    if (paused) {
      if (state.resumedAt !== null) {
        state.accumulated = calculateElapsedTime(
          state.accumulated,
          state.resumedAt,
          performance.now(),
        );
        state.resumedAt = null;
      }
      stopTick();
      setElapsed(state.accumulated);
      setRunning(false);
      persistAccumulated();
    } else {
      state.resumedAt = performance.now();
      startTick();
      setRunning(true);
    }

    return stopTick;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused, persistenceReady]);

  useEffect(() => {
    const state = stateRef.current;

    function handleVisibility() {
      if (!persistenceReady) return;
      if (document.hidden && state.resumedAt !== null) {
        state.accumulated = calculateElapsedTime(
          state.accumulated,
          state.resumedAt,
          performance.now(),
        );
        state.resumedAt = null;
        stopTick();
        setElapsed(state.accumulated);
        setRunning(false);
        persistAccumulated();
      } else if (!document.hidden && !paused) {
        state.resumedAt = performance.now();
        startTick();
        setRunning(true);
      }
    }

    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused, persistenceReady]);

  useEffect(() => () => {
    const state = stateRef.current;
    if (state.resumedAt !== null) {
      state.accumulated = calculateElapsedTime(
        state.accumulated,
        state.resumedAt,
        performance.now(),
      );
      state.resumedAt = null;
    }
    stopTick();
    if (!persistenceReady || !persistKey) return;
    try {
      sessionStorage.setItem(persistKey, String(state.accumulated));
    } catch {
      // sessionStorage may be unavailable; silently ignore.
    }
  }, [persistKey, persistenceReady, stopTick]);

  const reset = useCallback(() => {
    stopTick();
    stateRef.current.accumulated = 0;
    stateRef.current.resumedAt = null;
    setElapsed(0);
    setRunning(false);
    if (persistKey) {
      try {
        sessionStorage.removeItem(persistKey);
      } catch {
        // sessionStorage may be unavailable; silently ignore.
      }
    }
  }, [persistKey, stopTick]);

  return { elapsed, running, reset };
}
