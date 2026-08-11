import { useCallback, useEffect, useRef, useState } from "react";
import type { GameSession } from "@/src/core";
import type { SolverMetadata, SolverProgress, SolverResult, SolverRunHandle, SolverWorkerClient } from "@/src/solver";
import { phaseLabel, resultSummary } from "./solver-format";
import {
  automaticMemoryLimitBytes, errorMessage, fingerprintFor, fingerprintKey,
  MEBIBYTE, PROGRESS_LOG_INTERVAL_MS, progressLogMessage, sessionKey,
  type SolverSharedState,
} from "./solver-internals";
import type { SolverLogEntry, SolverRunFingerprint } from "./solver-ui-types";

export interface UseSolverProgressOptions extends SolverSharedState {
  session: GameSession; open: boolean; uiPhase: string;
  appendLog: (msg: string, tone?: SolverLogEntry["tone"], ms?: number) => void;
  resetLog: (entries?: readonly SolverLogEntry[]) => void;
  setLiveElapsedMs: React.Dispatch<React.SetStateAction<number>>;
  elapsedRef: React.RefObject<number>;
  startedAtRef: React.RefObject<number | null>;
  clientRef: React.RefObject<SolverWorkerClient | null>;
  runRef: React.RefObject<SolverRunHandle | null>;
  runTokenRef: React.RefObject<number>;
  selectedSolverId: string; timeLimitMs: number; memoryLimitMiB: number;
  mode: "fast" | "quality" | "optimal";
  solvers: readonly SolverMetadata[];
}

export function useSolverProgress(opts: UseSolverProgressOptions) {
  const {
    session, open, uiPhase, setUiPhase, setStatusMessage, setError, appendLog,
    resetLog, setLiveElapsedMs, elapsedRef, startedAtRef, clientRef, runRef,
    runTokenRef, selectedSolverId, timeLimitMs, memoryLimitMiB, mode, solvers,
  } = opts;
  const [progress, setProgress] = useState<SolverProgress | null>(null);
  const [result, setResult] = useState<SolverResult | null>(null);
  const [runFingerprint, setRunFingerprint] = useState<SolverRunFingerprint | null>(null);
  const [runSolverId, setRunSolverId] = useState<string | null>(null);
  const currentSessionRef = useRef(session);
  const prevKeyRef = useRef(sessionKey(session));
  const prevOpenRef = useRef(open);
  const lastProgRef = useRef<{ elapsedMs: number; phase?: SolverProgress["phase"] }>(
    { elapsedMs: Number.NEGATIVE_INFINITY },
  );
  useEffect(() => { currentSessionRef.current = session; }, [session]);
  const selectedSolver = solvers.find(({ id }) => id === selectedSolverId);

  const resetRunState = useCallback(() => {
    setProgress(null); setResult(null); setRunFingerprint(null); setRunSolverId(null);
  }, []);

  const cancel = useCallback((reason = "Search cancelled by user") => {
    const run = runRef.current;
    if (!run || uiPhase === "cancelling") return;
    run.cancel(reason);
    setUiPhase("cancelling");
    setStatusMessage("Cancelling search.");
    appendLog("Cancellation requested.", "warning", elapsedRef.current);
  }, [appendLog, uiPhase, runRef, setUiPhase, setStatusMessage, elapsedRef]);

  useEffect(() => {
    const nextKey = sessionKey(session);
    if (prevKeyRef.current === nextKey) return;
    prevKeyRef.current = nextKey;
    runTokenRef.current += 1;
    runRef.current?.cancel("Puzzle state changed");
    runRef.current = null; startedAtRef.current = null;
    resetRunState(); setLiveElapsedMs(0); resetLog();
    lastProgRef.current = { elapsedMs: Number.NEGATIVE_INFINITY };
    setUiPhase(clientRef.current ? "ready" : "loading");
    setStatusMessage("Puzzle state changed. Start a new search when ready.");
    appendLog("Previous search cleared because the puzzle state changed.");
  }, [appendLog, session, runTokenRef, runRef, startedAtRef, setLiveElapsedMs,
    resetLog, setUiPhase, setStatusMessage, clientRef, resetRunState]);

  useEffect(() => {
    if (prevOpenRef.current && !open) cancel("Solver dialog closed");
    prevOpenRef.current = open;
  }, [cancel, open]);

  const start = useCallback(() => {
    const client = clientRef.current;
    const md = selectedSolver;
    if (!client || !md || uiPhase === "running" || uiPhase === "cancelling") return;
    const fp = fingerprintFor(session);
    const token = ++runTokenRef.current;
    const maxMem = memoryLimitMiB > 0 ? memoryLimitMiB * MEBIBYTE : automaticMemoryLimitBytes();
    resetRunState(); setError(null); setRunFingerprint(fp); setRunSolverId(md.id);
    resetLog(); setLiveElapsedMs(0);
    lastProgRef.current = { elapsedMs: Number.NEGATIVE_INFINITY };
    startedAtRef.current = performance.now();
    setUiPhase("running");
    setStatusMessage(`${md.displayName} search started.`);
    appendLog(`Starting ${md.displayName} to minimize moves.`);
    let handle: SolverRunHandle;
    try {
      handle = client.run(md.id, {
        board: session.board, snapshot: session.snapshot, objective: { kind: "moves" },
        limits: { maxMemoryBytes: maxMem, ...(timeLimitMs > 0 ? { maxElapsedMs: timeLimitMs } : {}) },
        options: { "sokomind-solver": { mode } },
      }, {
        onProgress(u) {
          if (runTokenRef.current !== token) return;
          setProgress(u);
          setLiveElapsedMs((c) => Math.max(c, u.elapsedMs));
          const last = lastProgRef.current;
          const pc = last.phase !== u.phase;
          if (pc || u.elapsedMs - last.elapsedMs >= PROGRESS_LOG_INTERVAL_MS) {
            lastProgRef.current = { elapsedMs: u.elapsedMs, phase: u.phase };
            appendLog(progressLogMessage(u), "info", u.elapsedMs);
            if (pc) setStatusMessage(phaseLabel(u.phase));
          }
        },
      });
      runRef.current = handle;
    } catch (caught) {
      const msg = errorMessage(caught); startedAtRef.current = null;
      setUiPhase("error"); setError(msg);
      setStatusMessage(`Search failed: ${msg}`); appendLog(msg, "error"); return;
    }
    void handle.result.then((r) => {
      if (runTokenRef.current !== token) return;
      runRef.current = null; startedAtRef.current = null;
      setLiveElapsedMs(r.metrics.elapsedMs);
      if (fingerprintKey(fp) !== sessionKey(currentSessionRef.current)) {
        setResult(null); setRunFingerprint(null); setRunSolverId(null); setUiPhase("ready");
        setStatusMessage("The puzzle changed, so the result was discarded.");
        appendLog("Result discarded because the puzzle state changed.", "warning", r.metrics.elapsedMs);
        return;
      }
      setResult(r); const s = resultSummary(r); setStatusMessage(s);
      const tone = r.status === "solved" ? "success" as const : "warning" as const;
      setUiPhase(r.status === "solved" ? "solved" : r.status === "cancelled" ? "cancelled" : "unsolved");
      appendLog(s, tone, r.metrics.elapsedMs);
    }, (caught) => {
      if (runTokenRef.current !== token) return;
      runRef.current = null; startedAtRef.current = null;
      const msg = errorMessage(caught); setUiPhase("error"); setError(msg);
      setStatusMessage(`Search failed: ${msg}`); appendLog(msg, "error", elapsedRef.current);
    });
  }, [appendLog, memoryLimitMiB, mode, selectedSolver, session, timeLimitMs, uiPhase,
    clientRef, runTokenRef, runRef, startedAtRef, setLiveElapsedMs, resetLog,
    setUiPhase, setStatusMessage, setError, elapsedRef, resetRunState]);

  return { progress, result, runFingerprint, runSolverId, start, cancel, resetRunState };
}
