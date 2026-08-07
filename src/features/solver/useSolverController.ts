import { useCallback, useMemo, useState } from "react";
import type { GameSession } from "@/src/core";
import type { SolutionStep } from "@/src/solver";
import { useSolverLog } from "./use-solver-log";
import { useSolverProgress } from "./use-solver-progress";
import { useSolverWorker } from "./use-solver-worker";
import { fingerprintFor, fingerprintKey } from "./solver-internals";

export const TIME_LIMIT_OPTIONS = Object.freeze([
  { value: 5_000, label: "5 seconds" },
  { value: 15_000, label: "15 seconds" },
  { value: 30_000, label: "30 seconds" },
  { value: 60_000, label: "1 minute" },
  { value: 120_000, label: "2 minutes" },
  { value: 0, label: "No time limit" },
] as const);

export const MEMORY_LIMIT_OPTIONS = Object.freeze([
  { value: 0, label: "Automatic" },
  { value: 384, label: "Low memory (384 MiB)" },
  { value: 768, label: "Desktop (768 MiB)" },
  { value: 1_536, label: "Large desktop (1.5 GiB)" },
] as const);

export interface SolverRunFingerprint {
  readonly puzzleId: string;
  readonly actionLog: string;
}

export type SolverUiPhase =
  | "loading"
  | "ready"
  | "running"
  | "cancelling"
  | "solved"
  | "unsolved"
  | "cancelled"
  | "error";

export interface SolverLogEntry {
  readonly id: number;
  readonly elapsedMs: number;
  readonly message: string;
  readonly tone: "info" | "success" | "warning" | "error";
}

interface UseSolverControllerOptions {
  readonly open: boolean;
  readonly session: GameSession;
}

export function useSolverController({
  open,
  session,
}: UseSolverControllerOptions) {
  const [timeLimitMs, setTimeLimitMs] = useState(60_000);
  const [memoryLimitMiB, setMemoryLimitMiB] = useState(0);
  const [mode, setMode] = useState<"fast" | "quality" | "optimal">("fast");
  const [uiPhase, setUiPhase] = useState<SolverUiPhase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] =
    useState("Connecting to the solver worker.");

  // --- Log & elapsed timer ---
  const log = useSolverLog(uiPhase);

  // --- Worker lifecycle ---
  const worker = useSolverWorker({
    open,
    appendLog: log.appendLog,
    resetLog: log.resetLog,
    setUiPhase,
    setError,
    setStatusMessage,
  });

  // --- Run execution & progress ---
  const run = useSolverProgress({
    session,
    open,
    uiPhase,
    setUiPhase,
    setStatusMessage,
    setError,
    appendLog: log.appendLog,
    resetLog: log.resetLog,
    setLiveElapsedMs: log.setLiveElapsedMs,
    elapsedRef: log.elapsedRef,
    startedAtRef: log.startedAtRef,
    clientRef: worker.clientRef,
    runRef: worker.runRef,
    runTokenRef: worker.runTokenRef,
    selectedSolverId: worker.selectedSolverId,
    timeLimitMs,
    memoryLimitMiB,
    mode,
    solvers: worker.solvers,
  });

  // Wrap retryConnection to also clear run state (which lives in the progress hook).
  const { resetRunState } = run;
  const { retryConnection: workerRetry } = worker;
  const retryConnection = useCallback(() => {
    resetRunState();
    workerRetry();
  }, [resetRunState, workerRetry]);

  // --- Derived values (unchanged from original) ---
  const selectedSolver = useMemo(
    () => worker.solvers.find(({ id }) => id === worker.selectedSolverId),
    [worker.selectedSolverId, worker.solvers],
  );

  const terminalMetrics = run.result?.metrics;
  const counters = terminalMetrics?.counters ?? run.progress?.counters;
  const resultSolver = worker.solvers.find(
    ({ id }) => id === run.runSolverId,
  );
  const expandedStates =
    terminalMetrics?.expandedStates ?? run.progress?.expandedStates;
  const generatedStates =
    terminalMetrics?.generatedStates ?? run.progress?.generatedStates;
  const frontierSize =
    run.progress?.frontierSize ?? (run.result ? 0 : undefined);
  const peakFrontierSize = terminalMetrics?.peakFrontierSize;
  const proof = run.result?.proof ?? null;
  const liveProof = run.progress
    ? {
        lowerBound: run.progress.lowerBound,
        upperBound: run.progress.upperBound,
        gap: run.progress.gap,
      }
    : null;
  const running = uiPhase === "running" || uiPhase === "cancelling";
  const currentFingerprint = fingerprintFor(session);
  const canPlay =
    run.result?.status === "solved" &&
    run.runFingerprint !== null &&
    fingerprintKey(run.runFingerprint) ===
      fingerprintKey(currentFingerprint);

  return {
    solvers: worker.solvers,
    selectedSolver,
    selectedSolverId: worker.selectedSolverId,
    setSelectedSolverId: worker.setSelectedSolverId,
    timeLimitMs,
    setTimeLimitMs,
    memoryLimitMiB,
    setMemoryLimitMiB,
    mode,
    setMode,
    uiPhase,
    running,
    proof,
    liveProof,
    progress: run.progress,
    result: run.result,
    resultSolver,
    runFingerprint: run.runFingerprint,
    error,
    statusMessage,
    logEntries: log.logEntries,
    liveElapsedMs: log.liveElapsedMs,
    expandedStates,
    generatedStates,
    frontierSize,
    peakFrontierSize,
    counters,
    canPlay,
    start: run.start,
    cancel: run.cancel,
    retryConnection,
  } as const;
}

export type SolverPlaybackRequest = Readonly<{
  steps: readonly SolutionStep[];
  fingerprint: SolverRunFingerprint;
}>;
