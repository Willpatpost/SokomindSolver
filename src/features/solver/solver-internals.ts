/**
 * Shared helpers used by the decomposed solver hooks.
 * Kept separate to avoid circular imports and reduce per-hook line count.
 */
import type { GameSession } from "@/src/core";
import type { SolverMetadata, SolverProgress } from "@/src/solver";
import { phaseLabel } from "./solver-format";
import type { SolverRunFingerprint, SolverUiPhase } from "./solver-ui-types";

export const PROGRESS_LOG_INTERVAL_MS = 1_000;
export const WORKER_STARTUP_TIMEOUT_MS = 5_000;
export const MEBIBYTE = 1024 * 1024;

export function fingerprintFor(session: GameSession): SolverRunFingerprint {
  return Object.freeze({
    puzzleId: session.puzzle.id,
    actionLog: session.actionLog,
  });
}

export function fingerprintKey(fingerprint: SolverRunFingerprint): string {
  return `${fingerprint.puzzleId}\0${fingerprint.actionLog}`;
}

export function sessionKey(session: GameSession): string {
  return fingerprintKey(fingerprintFor(session));
}

export function isAStar(metadata: SolverMetadata): boolean {
  return (
    /(^|-)a-?star($|-)/i.test(metadata.id) ||
    /\ba\s*\*/i.test(metadata.displayName) ||
    /\ba[\s-]*star\b/i.test(metadata.displayName)
  );
}

export function automaticMemoryLimitBytes(): number {
  const memoryGb = (
    navigator as Navigator & { readonly deviceMemory?: number }
  ).deviceMemory;
  if (memoryGb === undefined) return 768 * MEBIBYTE;
  if (memoryGb <= 4) return 384 * MEBIBYTE;
  if (memoryGb <= 8) return 768 * MEBIBYTE;
  if (memoryGb <= 16) return 2_048 * MEBIBYTE;
  return 4_096 * MEBIBYTE;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "The solver worker stopped unexpectedly.";
}

export function progressLogMessage(progress: SolverProgress): string {
  const detail = progress.detail?.trim();
  const message = detail || phaseLabel(progress.phase);
  const counters = [
    progress.expandedStates === undefined
      ? null
      : `${progress.expandedStates.toLocaleString()} expanded`,
    progress.generatedStates === undefined
      ? null
      : `${progress.generatedStates.toLocaleString()} generated`,
    progress.frontierSize === undefined
      ? null
      : `${progress.frontierSize.toLocaleString()} queued`,
  ].filter((value): value is string => value !== null);
  return counters.length > 0 ? `${message} | ${counters.join(" | ")}` : message;
}

/**
 * Shared state setters that multiple hooks need to write into.
 * Passed as a single object to reduce per-hook parameter noise.
 */
export interface SolverSharedState {
  readonly setUiPhase: React.Dispatch<React.SetStateAction<SolverUiPhase>>;
  readonly setError: React.Dispatch<React.SetStateAction<string | null>>;
  readonly setStatusMessage: React.Dispatch<React.SetStateAction<string>>;
}
