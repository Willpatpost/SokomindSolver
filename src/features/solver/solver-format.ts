import type {
  SolverPhase,
  SolverResult,
} from "@/src/solver";

const INTEGER_FORMAT = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0,
});

const DECIMAL_FORMAT = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
});

export function formatCount(value: number | undefined): string {
  return value === undefined ? "—" : INTEGER_FORMAT.format(value);
}

export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;

  const seconds = milliseconds / 1_000;
  if (seconds < 60) return `${DECIMAL_FORMAT.format(seconds)} s`;

  const wholeMinutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${wholeMinutes}m ${String(remainingSeconds).padStart(2, "0")}s`;
}

export function formatBytes(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "—";
  if (value < 1_024) return `${Math.round(value)} B`;
  if (value < 1_024 ** 2) {
    return `${DECIMAL_FORMAT.format(value / 1_024)} KiB`;
  }
  return `${DECIMAL_FORMAT.format(value / 1_024 ** 2)} MiB`;
}

export function formatRate(
  expandedStates: number | undefined,
  elapsedMs: number,
): string {
  if (
    expandedStates === undefined ||
    elapsedMs <= 0 ||
    !Number.isFinite(elapsedMs)
  ) {
    return "—";
  }
  return `${INTEGER_FORMAT.format((expandedStates * 1_000) / elapsedMs)}/s`;
}

export function phaseLabel(phase: SolverPhase | undefined): string {
  switch (phase) {
    case "preparing":
      return "Preparing search";
    case "searching":
      return "Searching states";
    case "harvesting":
      return "Harvesting alternatives";
    case "improving":
      return "Improving solution";
    case "verifying":
      return "Verifying solution";
    case "proving":
      return "Proving optimality";
    default:
      return "Waiting";
  }
}

export function formatGap(gap: number | undefined): string {
  if (gap === undefined) return "—";
  if (gap === 0) return "0 (optimal)";
  return String(gap);
}

export function formatProofAlgorithm(algorithm: string): string {
  switch (algorithm) {
    case "move-astar":
      return "A* (exact moves)";
    case "move-ida-star":
      return "IDA* (exact moves)";
    case "parallel-move-astar":
      return "Parallel A* (exact moves)";
    case "parallel-move-ida-star":
      return "Parallel IDA* (exact moves)";
    default:
      return algorithm;
  }
}

export function resultSummary(result: SolverResult): string {
  switch (result.status) {
    case "solved":
      return `Found ${formatCount(result.solution.moves)} moves and ${formatCount(result.solution.pushes)} pushes.`;
    case "cancelled":
      return "Search cancelled.";
    case "unsolved":
      if (result.reason === "exhausted") {
        return "The reachable state space was exhausted without a solution.";
      }
      if (result.reason === "limit-reached") {
        return result.detail
          ? `The search stopped: ${result.detail}`
          : "The search limit was reached before a solution was found.";
      }
      return result.detail ?? "This solver does not support the request.";
  }
}
