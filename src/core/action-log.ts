import type { Direction } from "./model.ts";

export const ACTION_CODES = ["U", "D", "L", "R"] as const;
export const MAX_SHARED_ACTIONS = 2_000;

export type ActionCode = (typeof ACTION_CODES)[number];

export type ActionLogErrorCode =
  | "invalid-log-type"
  | "invalid-action-code"
  | "blocked-action";

export class ActionLogError extends Error {
  readonly code: ActionLogErrorCode;
  readonly index: number | undefined;
  readonly action: string | undefined;

  constructor(
    code: ActionLogErrorCode,
    message: string,
    options: Readonly<{ index?: number; action?: string }> = {},
  ) {
    super(message);
    this.name = "ActionLogError";
    this.code = code;
    this.index = options.index;
    this.action = options.action;
  }
}

const ACTION_CODE_BY_DIRECTION = Object.freeze({
  up: "U",
  down: "D",
  left: "L",
  right: "R",
} satisfies Readonly<Record<Direction, ActionCode>>);

const DIRECTION_BY_ACTION_CODE = Object.freeze({
  U: "up",
  D: "down",
  L: "left",
  R: "right",
} satisfies Readonly<Record<ActionCode, Direction>>);

export function encodeDirection(direction: Direction): ActionCode {
  return ACTION_CODE_BY_DIRECTION[direction];
}

export function isActionCode(value: unknown): value is ActionCode {
  return (
    typeof value === "string" &&
    Object.hasOwn(DIRECTION_BY_ACTION_CODE, value)
  );
}

export function decodeActionCode(value: unknown): Direction {
  if (!isActionCode(value)) {
    throw new ActionLogError(
      "invalid-action-code",
      `Expected one action code (U, D, L, or R); received ${JSON.stringify(value)}.`,
      typeof value === "string" ? { action: value } : {},
    );
  }
  return DIRECTION_BY_ACTION_CODE[value];
}

export function isActionLog(value: unknown): value is string {
  return typeof value === "string" && /^[UDLR]*$/.test(value);
}

export function isShareableActionLog(value: unknown): value is string {
  return isActionLog(value) && value.length <= MAX_SHARED_ACTIONS;
}

/**
 * Decode a compact action log. Logs are deliberately strict: whitespace,
 * lowercase input, and unknown symbols are rejected rather than normalized.
 */
export function decodeActionLog(value: unknown): readonly Direction[] {
  if (typeof value !== "string") {
    throw new ActionLogError(
      "invalid-log-type",
      `Action log must be a string; received ${typeof value}.`,
    );
  }

  const directions: Direction[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const action = value[index];
    if (!isActionCode(action)) {
      throw new ActionLogError(
        "invalid-action-code",
        `Invalid action ${JSON.stringify(action)} at index ${index}; expected U, D, L, or R.`,
        { index, action },
      );
    }
    directions.push(DIRECTION_BY_ACTION_CODE[action]);
  }
  return Object.freeze(directions);
}

export function encodeActionLog(
  directions: Iterable<Direction>,
): string {
  let log = "";
  for (const direction of directions) {
    log += encodeDirection(direction);
  }
  return log;
}
