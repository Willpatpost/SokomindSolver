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
