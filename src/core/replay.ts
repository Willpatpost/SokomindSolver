import {
  ActionLogError,
  decodeActionLog,
  encodeDirection,
} from "./action-log.ts";
import { createSession, move } from "./game-session.ts";
import type { GameSession, PuzzleDefinition } from "./model.ts";

/** Outcome of a replay that may include skipped actions. */
export interface ReplayResult {
  readonly session: GameSession;
  readonly applied: number;
  readonly skipped: number;
}

export interface ReplayOptions {
  /** When `true` (the default), blocked actions throw `ActionLogError`.
   *  When `false`, blocked actions are silently skipped. */
  readonly strict?: boolean;
}

/**
 * Rebuild a session from a compact action log using the same transition rules
 * as live play.
 *
 * In strict mode (the default) any blocked step throws `ActionLogError` with
 * code `"blocked-action"`. In non-strict mode blocked steps are skipped and a
 * {@link ReplayResult} is returned so the caller can inspect how many actions
 * were applied versus skipped.
 */
export function replayActionLog(
  puzzle: PuzzleDefinition,
  actionLog: unknown,
  options?: ReplayOptions,
): GameSession;
export function replayActionLog(
  puzzle: PuzzleDefinition,
  actionLog: unknown,
  options: ReplayOptions & { readonly strict: false },
): ReplayResult;
export function replayActionLog(
  puzzle: PuzzleDefinition,
  actionLog: unknown,
  options?: ReplayOptions,
): GameSession | ReplayResult {
  const strict = options?.strict ?? true;
  const directions = decodeActionLog(actionLog);
  let session = createSession(puzzle);
  let applied = 0;
  let skipped = 0;

  for (let index = 0; index < directions.length; index += 1) {
    const direction = directions[index];

    const next = move(session, direction);
    if (next === session) {
      if (strict) {
        const action = encodeDirection(direction);
        throw new ActionLogError(
          "blocked-action",
          `Action ${action} at index ${index} is blocked in puzzle ${JSON.stringify(puzzle.id)}.`,
          { index, action },
        );
      }
      skipped += 1;
    } else {
      session = next;
      applied += 1;
    }
  }

  if (!strict) {
    return Object.freeze({ session, applied, skipped });
  }

  return session;
}
