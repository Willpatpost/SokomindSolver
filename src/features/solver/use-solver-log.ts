import { useCallback, useEffect, useRef, useState } from "react";
import type { SolverLogEntry, SolverUiPhase } from "./solver-ui-types";

const MAX_LOG_ENTRIES = 80;

export interface UseSolverLogReturn {
  readonly logEntries: readonly SolverLogEntry[];
  readonly liveElapsedMs: number;
  readonly elapsedRef: React.RefObject<number>;
  readonly startedAtRef: React.RefObject<number | null>;
  readonly appendLog: (
    message: string,
    tone?: SolverLogEntry["tone"],
    elapsedMs?: number,
  ) => void;
  readonly resetLog: (entries?: readonly SolverLogEntry[]) => void;
  readonly setLiveElapsedMs: React.Dispatch<React.SetStateAction<number>>;
}

export function useSolverLog(uiPhase: SolverUiPhase): UseSolverLogReturn {
  const [logEntries, setLogEntries] = useState<readonly SolverLogEntry[]>(
    () => [
      Object.freeze({
        id: 1,
        elapsedMs: 0,
        message: "Discovering available search algorithms.",
        tone: "info" as const,
      }),
    ],
  );
  const [liveElapsedMs, setLiveElapsedMs] = useState(0);

  const elapsedRef = useRef(0);
  const startedAtRef = useRef<number | null>(null);
  const nextLogIdRef = useRef(2);

  const appendLog = useCallback(
    (
      message: string,
      tone: SolverLogEntry["tone"] = "info",
      elapsedMs = 0,
    ) => {
      const entry: SolverLogEntry = Object.freeze({
        id: nextLogIdRef.current++,
        elapsedMs: Math.max(0, elapsedMs),
        message,
        tone,
      });
      setLogEntries((current) => {
        const next = [...current, entry];
        return next.length > MAX_LOG_ENTRIES
          ? next.slice(next.length - MAX_LOG_ENTRIES)
          : next;
      });
    },
    [],
  );

  const resetLog = useCallback((entries?: readonly SolverLogEntry[]) => {
    setLogEntries(entries ?? []);
  }, []);

  // Elapsed timer that ticks while the solver is running or cancelling.
  useEffect(() => {
    if (uiPhase !== "running" && uiPhase !== "cancelling") return;

    const updateElapsed = () => {
      const startedAt = startedAtRef.current;
      if (startedAt !== null) {
        const elapsed = Math.max(0, performance.now() - startedAt);
        elapsedRef.current = elapsed;
        setLiveElapsedMs(elapsed);
      }
    };
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 500);
    return () => window.clearInterval(timer);
  }, [uiPhase]);

  return {
    logEntries,
    liveElapsedMs,
    elapsedRef,
    startedAtRef,
    appendLog,
    resetLog,
    setLiveElapsedMs,
  };
}
