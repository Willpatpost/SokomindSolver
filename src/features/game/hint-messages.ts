import type { SolverResult } from "../../solver/contracts.ts";

type UnsolvedReason = Extract<SolverResult, { status: "unsolved" }>["reason"];

export function hintUnsolvedMessage(reason: UnsolvedReason): string {
  switch (reason) {
    case "exhausted":
      return "No solution exists from this position — try undoing some moves.";
    case "limit-reached":
      return "The hint search reached its time or memory limit — try again.";
    case "unsupported":
      return "Hints are not supported for this puzzle.";
  }
}
