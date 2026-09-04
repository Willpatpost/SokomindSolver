import { isRecord, type UnknownRecord } from "../../core/type-guards.ts";

export interface SolverValidationIssue {
  readonly path: string;
  readonly message: string;
}

export class SolverValidationError extends TypeError {
  readonly issues: readonly SolverValidationIssue[];

  constructor(
    subject: string,
    issues: readonly SolverValidationIssue[],
  ) {
    super(
      `${subject} is invalid: ${issues
        .map(({ path, message }) => `${path}: ${message}`)
        .join("; ")}`,
    );
    this.name = "SolverValidationError";
    this.issues = Object.freeze([...issues]);
  }
}

export type Issues = SolverValidationIssue[];

export function issue(issues: Issues, path: string, message: string): false {
  issues.push({ path, message });
  return false;
}

export function checkRecord(
  value: unknown,
  path: string,
  issues: Issues,
): value is UnknownRecord {
  return isRecord(value) || issue(issues, path, "must be a plain object");
}

export function checkExactKeys(
  value: UnknownRecord,
  allowed: readonly string[],
  path: string,
  issues: Issues,
): boolean {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  return (
    unknown.length === 0 ||
    issue(issues, path, `contains unknown field(s): ${unknown.join(", ")}`)
  );
}

export function checkNonEmptyString(
  value: unknown,
  path: string,
  issues: Issues,
): value is string {
  return (
    (typeof value === "string" && value.trim().length > 0) ||
    issue(issues, path, "must be a non-empty string")
  );
}

export function checkFiniteNonNegative(
  value: unknown,
  path: string,
  issues: Issues,
): value is number {
  return (
    (typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0) ||
    issue(issues, path, "must be a finite non-negative number")
  );
}

export function checkNonNegativeInteger(
  value: unknown,
  path: string,
  issues: Issues,
): value is number {
  return (
    (typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0) ||
    issue(issues, path, "must be a non-negative safe integer")
  );
}

export function checkPositiveInteger(
  value: unknown,
  path: string,
  issues: Issues,
): value is number {
  return (
    (typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value > 0) ||
    issue(issues, path, "must be a positive safe integer")
  );
}

export function checkEnum(
  value: unknown,
  values: ReadonlySet<string>,
  path: string,
  issues: Issues,
): value is string {
  return (
    (typeof value === "string" && values.has(value)) ||
    issue(issues, path, `must be one of: ${[...values].join(", ")}`)
  );
}

