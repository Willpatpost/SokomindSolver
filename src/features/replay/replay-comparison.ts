import {
  ActionLogError,
  decodeActionLog,
  encodeDirection,
  isActionCode,
  type ActionCode,
} from "../../core/action-log.ts";
import { createSession, move } from "../../core/game-session.ts";
import type {
  GameSession,
  GameSnapshot,
  ParsedBoard,
  PuzzleDefinition,
} from "../../core/model.ts";

export interface ReplayTrace {
  readonly actionLog: string;
  readonly puzzle: PuzzleDefinition;
  readonly board: ParsedBoard;
  readonly frames: readonly GameSnapshot[];
  readonly pushedSteps: readonly boolean[];
}

export interface ReplayDivergenceMarker {
  readonly step: number;
  readonly kind: "direction" | "push" | "finish";
  readonly symbol: "D" | "P" | "F";
  readonly label: string;
}

export interface ReplayComparison {
  readonly commonPrefixMoves: number;
  readonly moveDelta: number;
  readonly pushDelta: number;
  readonly firstActionDifference?: number;
  readonly firstPushDifference?: number;
  readonly markers: readonly ReplayDivergenceMarker[];
  readonly summary: string;
}

const ACTION_LABELS = Object.freeze({
  U: "up",
  D: "down",
  L: "left",
  R: "right",
} satisfies Readonly<Record<ActionCode, string>>);

/** Builds immutable display frames exclusively through the canonical engine. */
export function buildReplayTrace(
  puzzle: PuzzleDefinition,
  actionLog: unknown,
): ReplayTrace {
  const directions = decodeActionLog(actionLog);
  const log = typeof actionLog === "string" ? actionLog : "";
  const frames: GameSnapshot[] = [];
  const pushedSteps: boolean[] = [];
  let session = createSession(puzzle);
  frames.push(session.snapshot);

  for (let index = 0; index < directions.length; index += 1) {
    const direction = directions[index]!;
    const next = move(session, direction);
    if (next === session) {
      const action = encodeDirection(direction);
      throw new ActionLogError(
        "blocked-action",
        `Action ${action} at index ${index} is blocked in puzzle ${JSON.stringify(puzzle.id)}.`,
        { index, action },
      );
    }
    pushedSteps.push(next.pushes > session.pushes);
    frames.push(next.snapshot);
    session = next;
  }

  return Object.freeze({
    actionLog: log,
    puzzle,
    board: session.board,
    frames: Object.freeze(frames),
    pushedSteps: Object.freeze(pushedSteps),
  });
}

/** Creates one lightweight Board-compatible view without retaining log prefixes. */
export function replayTraceSession(
  trace: ReplayTrace,
  step: number,
): GameSession {
  const boundedStep = Math.max(0, Math.min(step, trace.actionLog.length));
  const snapshot = trace.frames[boundedStep]!;
  return Object.freeze({
    puzzle: trace.puzzle,
    board: trace.board,
    snapshot,
    history: Object.freeze({ head: null, length: 0 }),
    actionLog: trace.actionLog.slice(0, boundedStep),
    moves: snapshot.moves,
    pushes: snapshot.pushes,
    solved: snapshot.solved,
  });
}

function routeAt(log: string, zeroBasedIndex: number): string {
  const action = log[zeroBasedIndex];
  return action && isActionCode(action) ? ACTION_LABELS[action] : "finished";
}

function deltaPhrase(delta: number, noun: string): string {
  if (delta === 0) return `the same number of ${noun}`;
  return `${Math.abs(delta)} ${noun} ${delta < 0 ? "fewer" : "more"}`;
}

export function compareReplayTraces(
  primary: ReplayTrace,
  reference: ReplayTrace,
): ReplayComparison {
  const sharedLength = Math.min(primary.actionLog.length, reference.actionLog.length);
  let commonPrefixMoves = 0;
  while (
    commonPrefixMoves < sharedLength &&
    primary.actionLog[commonPrefixMoves] === reference.actionLog[commonPrefixMoves]
  ) {
    commonPrefixMoves += 1;
  }

  const firstActionDifference =
    primary.actionLog === reference.actionLog ? undefined : commonPrefixMoves + 1;
  let firstPushDifference: number | undefined;
  const comparedSteps = Math.max(
    primary.pushedSteps.length,
    reference.pushedSteps.length,
  );
  let primaryPushes = 0;
  let referencePushes = 0;
  for (let index = 0; index < comparedSteps; index += 1) {
    if (primary.pushedSteps[index]) primaryPushes += 1;
    if (reference.pushedSteps[index]) referencePushes += 1;
    if (primaryPushes !== referencePushes) {
      firstPushDifference = index + 1;
      break;
    }
  }

  const markers: ReplayDivergenceMarker[] = [];
  if (firstActionDifference !== undefined) {
    const index = firstActionDifference - 1;
    markers.push(Object.freeze({
      step: Math.min(firstActionDifference, primary.actionLog.length),
      kind: "direction",
      symbol: "D",
      label: `Direction changes at move ${firstActionDifference}: ${routeAt(primary.actionLog, index)} instead of ${routeAt(reference.actionLog, index)}.`,
    }));
  }
  if (
    firstPushDifference !== undefined &&
    firstPushDifference !== firstActionDifference
  ) {
    markers.push(Object.freeze({
      step: Math.min(firstPushDifference, primary.actionLog.length),
      kind: "push",
      symbol: "P",
      label: `Cumulative push counts first differ after move ${firstPushDifference}.`,
    }));
  }
  if (primary.actionLog.length !== reference.actionLog.length) {
    const shorter = Math.min(primary.actionLog.length, reference.actionLog.length);
    markers.push(Object.freeze({
      step: Math.min(shorter, primary.actionLog.length),
      kind: "finish",
      symbol: "F",
      label: `The shorter route finishes at move ${shorter}.`,
    }));
  }

  const primaryFinal = primary.frames.at(-1)!;
  const referenceFinal = reference.frames.at(-1)!;
  const moveDelta = primary.actionLog.length - reference.actionLog.length;
  const pushDelta = primaryFinal.pushes - referenceFinal.pushes;
  const divergence = firstActionDifference === undefined
    ? "The routes use the same directions."
    : `They match for ${commonPrefixMoves} ${commonPrefixMoves === 1 ? "move" : "moves"}, then the watched route goes ${routeAt(primary.actionLog, commonPrefixMoves)} while the comparison goes ${routeAt(reference.actionLog, commonPrefixMoves)}.`;
  const summary = `${divergence} The watched route uses ${deltaPhrase(moveDelta, "moves")} and ${deltaPhrase(pushDelta, "pushes")}.`;

  return Object.freeze({
    commonPrefixMoves,
    moveDelta,
    pushDelta,
    ...(firstActionDifference === undefined ? {} : { firstActionDifference }),
    ...(firstPushDifference === undefined ? {} : { firstPushDifference }),
    markers: Object.freeze(markers),
    summary,
  });
}

export function replayStepDescription(
  trace: ReplayTrace,
  step: number,
  label: string,
): string {
  const boundedStep = Math.max(0, Math.min(step, trace.actionLog.length));
  const frame = trace.frames[boundedStep]!;
  const robot = frame.robot;
  return `${label}, move ${boundedStep} of ${trace.actionLog.length}. Keeper at row ${robot.row + 1}, column ${robot.column + 1}. ${frame.pushes} ${frame.pushes === 1 ? "push" : "pushes"}. ${frame.solved ? "Puzzle solved." : "Puzzle in progress."}`;
}
