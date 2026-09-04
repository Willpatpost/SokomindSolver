import type { SolverMetadata } from "../contracts.ts";
import {
  checkEnum,
  checkExactKeys,
  checkNonEmptyString,
  checkRecord,
  issue,
  type Issues,
} from "./common.ts";
import { OBJECTIVE_KINDS } from "./request.ts";

const EXECUTION_TARGETS = new Set(["main-thread", "web-worker"]);
const RUNTIMES = new Set(["javascript", "webassembly", "hybrid"]);
const QUALITIES = new Set(["first-found", "bounded", "optimal"]);

export function checkMetadata(
  value: unknown,
  path: string,
  issues: Issues,
): value is SolverMetadata {
  if (!checkRecord(value, path, issues)) return false;
  let valid = checkExactKeys(
    value,
    ["id", "displayName", "description", "version", "capabilities"],
    path,
    issues,
  );
  valid = checkNonEmptyString(value.id, `${path}.id`, issues) && valid;
  if (typeof value.id === "string" && !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value.id)) {
    valid = issue(issues, `${path}.id`, "must be lowercase and URL-safe") && valid;
  }
  valid =
    checkNonEmptyString(value.displayName, `${path}.displayName`, issues) &&
    valid;
  valid =
    checkNonEmptyString(value.description, `${path}.description`, issues) &&
    valid;
  valid =
    checkNonEmptyString(value.version, `${path}.version`, issues) && valid;
  if (!checkRecord(value.capabilities, `${path}.capabilities`, issues)) {
    return false;
  }
  const capabilities = value.capabilities;
  valid =
    checkExactKeys(
      capabilities,
      [
        "executionTargets",
        "runtime",
        "objectives",
        "quality",
        "labeledBoxes",
        "genericBoxes",
        "partialState",
        "reportsProgress",
        "cooperativeCancellation",
        "deterministic",
      ],
      `${path}.capabilities`,
      issues,
    ) && valid;
  if (
    !Array.isArray(capabilities.executionTargets) ||
    capabilities.executionTargets.length === 0
  ) {
    valid =
      issue(
        issues,
        `${path}.capabilities.executionTargets`,
        "must be a non-empty array",
      ) && valid;
  } else {
    for (const [index, target] of capabilities.executionTargets.entries()) {
      valid =
        checkEnum(
          target,
          EXECUTION_TARGETS,
          `${path}.capabilities.executionTargets[${index}]`,
          issues,
        ) && valid;
    }
  }
  valid =
    checkEnum(
      capabilities.runtime,
      RUNTIMES,
      `${path}.capabilities.runtime`,
      issues,
    ) && valid;
  if (
    !Array.isArray(capabilities.objectives) ||
    capabilities.objectives.length === 0
  ) {
    valid =
      issue(
        issues,
        `${path}.capabilities.objectives`,
        "must be a non-empty array",
      ) && valid;
  } else {
    for (const [index, objective] of capabilities.objectives.entries()) {
      valid =
        checkEnum(
          objective,
          OBJECTIVE_KINDS,
          `${path}.capabilities.objectives[${index}]`,
          issues,
        ) && valid;
    }
  }
  valid =
    checkEnum(
      capabilities.quality,
      QUALITIES,
      `${path}.capabilities.quality`,
      issues,
    ) && valid;
  for (const key of [
    "labeledBoxes",
    "genericBoxes",
    "partialState",
    "reportsProgress",
    "cooperativeCancellation",
    "deterministic",
  ] as const) {
    if (typeof capabilities[key] !== "boolean") {
      valid =
        issue(
          issues,
          `${path}.capabilities.${key}`,
          "must be a boolean",
        ) && valid;
    }
  }
  return valid;
}
