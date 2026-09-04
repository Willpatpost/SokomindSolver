import type { ParsedBoard } from "../core/index.ts";
import type {
  SolverMetadata,
  SolverProgress,
  SolverRequest,
  SolverResult,
  SolverRunMetrics,
  SolverSolution,
} from "./contracts.ts";
import { collectProofIssues } from "./proof.ts";
import { checkBoard, checkSnapshot } from "./validation/board.ts";
import {
  checkEnum,
  checkExactKeys,
  checkFiniteNonNegative,
  checkNonNegativeInteger,
  checkRecord,
  issue,
  SolverValidationError,
  type Issues,
  type SolverValidationIssue,
} from "./validation/common.ts";
import { checkMetadata } from "./validation/metadata.ts";
import { checkLimits, checkObjective, checkOptions } from "./validation/request.ts";
import { checkMetrics, checkSolution } from "./validation/solution.ts";

// Keep public imports stable; the checkers are split by contract responsibility.
export { isRecord } from "../core/type-guards.ts";
export type { UnknownRecord } from "../core/type-guards.ts";
export { SolverValidationError, type SolverValidationIssue } from "./validation/common.ts";
export { scoreSolverObjective } from "./validation/solution.ts";

const PHASES = new Set(["preparing", "searching", "improving", "verifying", "proving", "harvesting"]);
const UNSOLVED_REASONS = new Set(["exhausted", "limit-reached", "unsupported"]);

function collectRequestIssues(value: unknown): Issues {
  const issues: Issues = [];
  if (!checkRecord(value, "request", issues)) return issues;
  let valid = checkExactKeys(
    value,
    ["board", "snapshot", "objective", "limits", "options"],
    "request",
    issues,
  );
  const boardValid = checkBoard(value.board, "request.board", issues);
  valid = boardValid && valid;
  valid =
    checkSnapshot(
      value.snapshot,
      boardValid ? (value.board as ParsedBoard) : undefined,
      "request.snapshot",
      issues,
    ) && valid;
  valid =
    checkObjective(value.objective, "request.objective", issues) && valid;
  if (value.limits !== undefined) {
    valid = checkLimits(value.limits, "request.limits", issues) && valid;
  }
  if (value.options !== undefined) {
    valid = checkOptions(value.options, "request.options", issues) && valid;
  }
  void valid;
  return issues;
}

function collectProgressIssues(value: unknown): Issues {
  const issues: Issues = [];
  if (!checkRecord(value, "progress", issues)) return issues;
  let valid = checkExactKeys(
    value,
    [
      "phase",
      "elapsedMs",
      "expandedStates",
      "generatedStates",
      "frontierSize",
      "counters",
      "fraction",
      "incumbent",
      "detail",
      "lowerBound",
      "upperBound",
      "gap",
    ],
    "progress",
    issues,
  );
  valid = checkEnum(value.phase, PHASES, "progress.phase", issues) && valid;
  valid =
    checkFiniteNonNegative(value.elapsedMs, "progress.elapsedMs", issues) &&
    valid;
  for (const key of [
    "expandedStates",
    "generatedStates",
    "frontierSize",
  ] as const) {
    if (value[key] !== undefined) {
      valid =
        checkNonNegativeInteger(value[key], `progress.${key}`, issues) && valid;
    }
  }
  if (value.counters !== undefined) {
    if (!checkRecord(value.counters, "progress.counters", issues)) {
      valid = false;
    } else {
      for (const [key, counter] of Object.entries(value.counters)) {
        valid =
          checkFiniteNonNegative(
            counter,
            `progress.counters.${key}`,
            issues,
          ) && valid;
      }
    }
  }
  if (value.fraction !== undefined) {
    const fraction = value.fraction;
    const fractionValid = checkFiniteNonNegative(
      fraction,
      "progress.fraction",
      issues,
    );
    valid = fractionValid && valid;
    if (fractionValid && fraction > 1) {
      valid =
        issue(issues, "progress.fraction", "must not exceed 1") && valid;
    }
  }
  if (value.incumbent !== undefined) {
    if (!checkRecord(value.incumbent, "progress.incumbent", issues)) {
      valid = false;
    } else {
      valid =
        checkExactKeys(
          value.incumbent,
          ["moves", "pushes", "objectiveScore"],
          "progress.incumbent",
          issues,
        ) && valid;
      valid =
        checkNonNegativeInteger(
          value.incumbent.moves,
          "progress.incumbent.moves",
          issues,
        ) && valid;
      valid =
        checkNonNegativeInteger(
          value.incumbent.pushes,
          "progress.incumbent.pushes",
          issues,
        ) && valid;
      valid =
        checkFiniteNonNegative(
          value.incumbent.objectiveScore,
          "progress.incumbent.objectiveScore",
          issues,
        ) && valid;
    }
  }
  if (value.detail !== undefined && typeof value.detail !== "string") {
    valid = issue(issues, "progress.detail", "must be a string") && valid;
  }
  for (const key of ["lowerBound", "upperBound", "gap"] as const) {
    if (value[key] !== undefined) {
      valid =
        checkFiniteNonNegative(value[key], `progress.${key}`, issues) && valid;
    }
  }
  if (
    value.lowerBound !== undefined &&
    value.upperBound !== undefined &&
    typeof value.lowerBound === "number" &&
    typeof value.upperBound === "number" &&
    value.lowerBound > value.upperBound
  ) {
    valid =
      issue(
        issues,
        "progress.lowerBound",
        "must not exceed progress.upperBound",
      ) && valid;
  }
  void valid;
  return issues;
}

function collectSolutionIssues(value: unknown): Issues {
  const issues: Issues = [];
  checkSolution(value, "solution", issues);
  return issues;
}

function collectResultIssues(value: unknown): Issues {
  const issues: Issues = [];
  if (!checkRecord(value, "result", issues)) return issues;
  if (!checkEnum(
    value.status,
    new Set(["solved", "unsolved", "cancelled"]),
    "result.status",
    issues,
  )) {
    return issues;
  }

  if (value.status === "solved") {
    let valid = checkExactKeys(
      value,
      ["status", "solution", "metrics", "proof"],
      "result",
      issues,
    );
    valid = checkSolution(value.solution, "result.solution", issues) && valid;
    valid = checkMetrics(value.metrics, "result.metrics", issues) && valid;
    if (value.proof !== undefined) {
      const proofIssues = collectProofIssues(value.proof, value.solution);
      for (const msg of proofIssues) {
        valid = issue(issues, "result.proof", msg) && valid;
      }
    }
    void valid;
    return issues;
  }
  if (value.status === "unsolved") {
    let valid = checkExactKeys(
      value,
      ["status", "reason", "metrics", "detail", "proof"],
      "result",
      issues,
    );
    valid =
      checkEnum(value.reason, UNSOLVED_REASONS, "result.reason", issues) &&
      valid;
    valid = checkMetrics(value.metrics, "result.metrics", issues) && valid;
    if (value.detail !== undefined && typeof value.detail !== "string") {
      valid = issue(issues, "result.detail", "must be a string") && valid;
    }
    if (value.proof !== undefined) {
      const proofIssues = collectProofIssues(value.proof, null);
      for (const msg of proofIssues) {
        valid = issue(issues, "result.proof", msg) && valid;
      }
    }
    void valid;
    return issues;
  }

  let valid = checkExactKeys(
    value,
    ["status", "metrics", "proof"],
    "result",
    issues,
  );
  valid = checkMetrics(value.metrics, "result.metrics", issues) && valid;
  if (value.proof !== undefined) {
    const proofIssues = collectProofIssues(value.proof, null);
    for (const msg of proofIssues) {
      valid = issue(issues, "result.proof", msg) && valid;
    }
  }
  void valid;
  return issues;
}

function collectMetadataIssues(value: unknown): Issues {
  const issues: Issues = [];
  checkMetadata(value, "metadata", issues);
  return issues;
}

function isValid(issues: Issues): issues is [] {
  return issues.length === 0;
}

export function getSolverRequestValidationIssues(
  value: unknown,
): readonly SolverValidationIssue[] {
  return Object.freeze(collectRequestIssues(value));
}

export function isSolverRequest(value: unknown): value is SolverRequest {
  return isValid(collectRequestIssues(value));
}

export function assertValidSolverRequest(
  value: unknown,
): asserts value is SolverRequest {
  const issues = collectRequestIssues(value);
  if (!isValid(issues)) throw new SolverValidationError("Solver request", issues);
}

export function isSolverProgress(value: unknown): value is SolverProgress {
  return isValid(collectProgressIssues(value));
}

export function assertValidSolverProgress(
  value: unknown,
): asserts value is SolverProgress {
  const issues = collectProgressIssues(value);
  if (!isValid(issues)) {
    throw new SolverValidationError("Solver progress", issues);
  }
}

export function isSolverSolution(value: unknown): value is SolverSolution {
  return isValid(collectSolutionIssues(value));
}

export function isSolverRunMetrics(value: unknown): value is SolverRunMetrics {
  const issues: SolverValidationIssue[] = [];
  return checkMetrics(value, "metrics", issues) && isValid(issues);
}

export function assertValidSolverSolution(
  value: unknown,
): asserts value is SolverSolution {
  const issues = collectSolutionIssues(value);
  if (!isValid(issues)) {
    throw new SolverValidationError("Solver solution", issues);
  }
}

export function isSolverResult(value: unknown): value is SolverResult {
  return isValid(collectResultIssues(value));
}

export function assertValidSolverResult(
  value: unknown,
): asserts value is SolverResult {
  const issues = collectResultIssues(value);
  if (!isValid(issues)) throw new SolverValidationError("Solver result", issues);
}

export function isSolverMetadata(value: unknown): value is SolverMetadata {
  return isValid(collectMetadataIssues(value));
}

export function assertValidSolverMetadata(
  value: unknown,
): asserts value is SolverMetadata {
  const issues = collectMetadataIssues(value);
  if (!isValid(issues)) {
    throw new SolverValidationError("Solver metadata", issues);
  }
}
