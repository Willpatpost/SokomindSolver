import { DIRECTIONS } from "../../core/index.ts";
import type {
  SolutionStep,
  SolverObjective,
  SolverRunMetrics,
  SolverSolution,
} from "../contracts.ts";
import {
  checkEnum,
  checkExactKeys,
  checkFiniteNonNegative,
  checkNonNegativeInteger,
  checkRecord,
  issue,
  type Issues,
} from "./common.ts";
import { checkObjective } from "./request.ts";
const OPTIMALITIES = new Set(["unknown", "proven"]);

function checkStep(
  value: unknown,
  path: string,
  issues: Issues,
): value is SolutionStep {
  if (!checkRecord(value, path, issues)) return false;
  let valid = checkExactKeys(value, ["direction", "kind"], path, issues);
  valid =
    checkEnum(value.direction, new Set(DIRECTIONS), `${path}.direction`, issues) &&
    valid;
  valid =
    checkEnum(value.kind, new Set(["walk", "push"]), `${path}.kind`, issues) &&
    valid;
  return valid;
}

export function scoreSolverObjective(
  _objective: SolverObjective,
  moves: number,
): number {
  return moves;
}

export function checkSolution(
  value: unknown,
  path: string,
  issues: Issues,
): value is SolverSolution {
  if (!checkRecord(value, path, issues)) return false;
  let valid = checkExactKeys(
    value,
    [
      "steps",
      "moves",
      "pushes",
      "objective",
      "objectiveScore",
      "optimality",
    ],
    path,
    issues,
  );
  if (!Array.isArray(value.steps)) {
    valid = issue(issues, `${path}.steps`, "must be an array") && valid;
  } else {
    for (const [index, step] of value.steps.entries()) {
      valid = checkStep(step, `${path}.steps[${index}]`, issues) && valid;
    }
  }
  valid =
    checkNonNegativeInteger(value.moves, `${path}.moves`, issues) && valid;
  valid =
    checkNonNegativeInteger(value.pushes, `${path}.pushes`, issues) && valid;
  valid = checkObjective(value.objective, `${path}.objective`, issues) && valid;
  valid =
    checkFiniteNonNegative(
      value.objectiveScore,
      `${path}.objectiveScore`,
      issues,
    ) && valid;
  valid =
    checkEnum(
      value.optimality,
      OPTIMALITIES,
      `${path}.optimality`,
      issues,
    ) && valid;
  if (!valid) return false;

  const solution = value as unknown as SolverSolution;
  const declaredPushes = solution.steps.filter(
    (step) => step.kind === "push",
  ).length;
  if (solution.moves !== solution.steps.length) {
    valid =
      issue(issues, `${path}.moves`, "must equal the number of steps") &&
      valid;
  }
  if (solution.pushes !== declaredPushes) {
    valid =
      issue(
        issues,
        `${path}.pushes`,
        "must equal the number of declared push steps",
      ) && valid;
  }
  const expectedScore = scoreSolverObjective(
    solution.objective,
    solution.moves,
  );
  if (solution.objectiveScore !== expectedScore) {
    valid =
      issue(
        issues,
        `${path}.objectiveScore`,
        `must equal the objective score ${expectedScore}`,
      ) && valid;
  }
  return valid;
}

export function checkMetrics(
  value: unknown,
  path: string,
  issues: Issues,
): value is SolverRunMetrics {
  if (!checkRecord(value, path, issues)) return false;
  let valid = checkExactKeys(
    value,
    [
      "elapsedMs",
      "expandedStates",
      "generatedStates",
      "peakFrontierSize",
      "counters",
    ],
    path,
    issues,
  );
  valid =
    checkFiniteNonNegative(value.elapsedMs, `${path}.elapsedMs`, issues) &&
    valid;
  for (const key of [
    "expandedStates",
    "generatedStates",
    "peakFrontierSize",
  ] as const) {
    if (value[key] !== undefined) {
      valid =
        checkNonNegativeInteger(value[key], `${path}.${key}`, issues) && valid;
    }
  }
  if (value.counters !== undefined) {
    if (!checkRecord(value.counters, `${path}.counters`, issues)) {
      valid = false;
    } else {
      for (const [key, counter] of Object.entries(value.counters)) {
        valid =
          checkFiniteNonNegative(counter, `${path}.counters.${key}`, issues) &&
          valid;
      }
    }
  }
  return valid;
}

