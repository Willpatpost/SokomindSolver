import type {
  SolverMetadata,
  SolverProgress,
  SolverRequest,
  SolverResult,
} from "./contracts.ts";
import {
  isRecord,
  isSolverMetadata,
  isSolverProgress,
  isSolverRequest,
  isSolverResult,
} from "./validation.ts";

export const SOLVER_WORKER_PROTOCOL_VERSION = 1 as const;

interface SolverWorkerEnvelope {
  readonly protocolVersion: typeof SOLVER_WORKER_PROTOCOL_VERSION;
}

export interface RunSolverCommand extends SolverWorkerEnvelope {
  readonly type: "solver/run";
  readonly jobId: string;
  readonly solverId: string;
  readonly request: SolverRequest;
}

export interface CancelSolverCommand extends SolverWorkerEnvelope {
  readonly type: "solver/cancel";
  readonly jobId: string;
  readonly reason?: string;
}

export interface DiscoverSolversCommand extends SolverWorkerEnvelope {
  readonly type: "solver/discover";
}

export type SolverWorkerCommand =
  | RunSolverCommand
  | CancelSolverCommand
  | DiscoverSolversCommand;

export interface SolverWorkerReadyEvent extends SolverWorkerEnvelope {
  readonly type: "solver/ready";
  readonly solvers: readonly SolverMetadata[];
}

export interface SolverProgressEvent extends SolverWorkerEnvelope {
  readonly type: "solver/progress";
  readonly jobId: string;
  readonly progress: SolverProgress;
}

export interface SolverResultEvent extends SolverWorkerEnvelope {
  readonly type: "solver/result";
  readonly jobId: string;
  readonly result: SolverResult;
}

export interface SerializedSolverError {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly stack?: string;
}

export interface SolverFailureEvent extends SolverWorkerEnvelope {
  readonly type: "solver/failure";
  readonly jobId?: string;
  readonly error: SerializedSolverError;
}

export type SolverWorkerEvent =
  | SolverWorkerReadyEvent
  | SolverProgressEvent
  | SolverResultEvent
  | SolverFailureEvent;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasCurrentEnvelope(
  value: unknown,
): value is Record<string, unknown> & SolverWorkerEnvelope {
  return (
    isRecord(value) &&
    value.protocolVersion === SOLVER_WORKER_PROTOCOL_VERSION
  );
}

/**
 * Validates the transport envelope. The worker must additionally validate
 * puzzle/state invariants through the core module before starting a search.
 */
export function isSolverWorkerCommand(
  value: unknown,
): value is SolverWorkerCommand {
  if (!hasCurrentEnvelope(value)) return false;

  switch (value.type) {
    case "solver/discover":
      return hasOnlyKeys(value, ["protocolVersion", "type"]);
    case "solver/cancel":
      return (
        hasOnlyKeys(value, ["protocolVersion", "type", "jobId", "reason"]) &&
        isNonEmptyString(value.jobId) &&
        (value.reason === undefined || typeof value.reason === "string")
      );
    case "solver/run":
      return (
        hasOnlyKeys(value, [
          "protocolVersion",
          "type",
          "jobId",
          "solverId",
          "request",
        ]) &&
        isNonEmptyString(value.jobId) &&
        isNonEmptyString(value.solverId) &&
        isSolverRequest(value.request)
      );
    default:
      return false;
  }
}

export function isSolverWorkerEvent(value: unknown): value is SolverWorkerEvent {
  if (!hasCurrentEnvelope(value)) return false;

  switch (value.type) {
    case "solver/ready":
      return (
        hasOnlyKeys(value, ["protocolVersion", "type", "solvers"]) &&
        Array.isArray(value.solvers) &&
        value.solvers.every(isSolverMetadata)
      );
    case "solver/progress":
      return (
        hasOnlyKeys(value, [
          "protocolVersion",
          "type",
          "jobId",
          "progress",
        ]) &&
        isNonEmptyString(value.jobId) &&
        isSolverProgress(value.progress)
      );
    case "solver/result":
      return (
        hasOnlyKeys(value, [
          "protocolVersion",
          "type",
          "jobId",
          "result",
        ]) &&
        isNonEmptyString(value.jobId) &&
        isSolverResult(value.result)
      );
    case "solver/failure":
      return (
        hasOnlyKeys(value, [
          "protocolVersion",
          "type",
          "jobId",
          "error",
        ]) &&
        (value.jobId === undefined || isNonEmptyString(value.jobId)) &&
        isRecord(value.error) &&
        hasOnlyKeys(value.error, ["name", "message", "code", "stack"]) &&
        isNonEmptyString(value.error.name) &&
        isNonEmptyString(value.error.message) &&
        (value.error.code === undefined || typeof value.error.code === "string") &&
        (value.error.stack === undefined ||
          typeof value.error.stack === "string")
      );
    default:
      return false;
  }
}

export function serializeSolverError(error: unknown): SerializedSolverError {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return {
      name: error.name || "Error",
      message: error.message,
      ...(typeof code === "string" ? { code } : {}),
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }

  return {
    name: "Error",
    message: typeof error === "string" ? error : "Unknown solver failure",
  };
}
