import { isRecord } from "../../core/type-guards.ts";
import type { SolverLimits, SolverObjective, SolverOptions } from "../contracts.ts";
import {
  checkEnum,
  checkExactKeys,
  checkPositiveInteger,
  checkRecord,
  issue,
  type Issues,
} from "./common.ts";

export const OBJECTIVE_KINDS = new Set(["moves"]);

export function checkObjective(
  value: unknown,
  path: string,
  issues: Issues,
): value is SolverObjective {
  if (!checkRecord(value, path, issues)) return false;
  let valid = checkExactKeys(value, ["kind"], path, issues);
  valid =
    checkEnum(value.kind, OBJECTIVE_KINDS, `${path}.kind`, issues) && valid;
  return valid;
}

export function checkLimits(
  value: unknown,
  path: string,
  issues: Issues,
): value is SolverLimits {
  if (!checkRecord(value, path, issues)) return false;
  let valid = checkExactKeys(
    value,
    [
      "maxElapsedMs",
      "maxExpandedStates",
      "maxGeneratedStates",
      "maxMemoryBytes",
    ],
    path,
    issues,
  );
  for (const key of [
    "maxElapsedMs",
    "maxExpandedStates",
    "maxGeneratedStates",
    "maxMemoryBytes",
  ] as const) {
    if (value[key] !== undefined) {
      valid =
        checkPositiveInteger(value[key], `${path}.${key}`, issues) && valid;
    }
  }
  return valid;
}

function checkJsonValue(
  value: unknown,
  path: string,
  issues: Issues,
  ancestors: ReadonlySet<object>,
  depth: number,
): boolean {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return (
      Number.isFinite(value) ||
      issue(issues, path, "JSON numbers must be finite")
    );
  }
  if (depth > 64) return issue(issues, path, "exceeds maximum nesting depth");
  if (typeof value !== "object" || value === null) {
    return issue(issues, path, "must be JSON-safe");
  }
  if (ancestors.has(value)) return issue(issues, path, "must not be cyclic");

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  let valid = true;
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      valid =
        checkJsonValue(
          child,
          `${path}[${index}]`,
          issues,
          nextAncestors,
          depth + 1,
        ) && valid;
    }
    return valid;
  }
  if (!isRecord(value)) return issue(issues, path, "must be a plain object");
  for (const [key, child] of Object.entries(value)) {
    valid =
      checkJsonValue(
        child,
        `${path}.${key}`,
        issues,
        nextAncestors,
        depth + 1,
      ) && valid;
  }
  return valid;
}

export function checkOptions(
  value: unknown,
  path: string,
  issues: Issues,
): value is SolverOptions {
  if (!checkRecord(value, path, issues)) return false;
  return checkJsonValue(value, path, issues, new Set(), 0);
}
