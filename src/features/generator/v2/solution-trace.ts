import type { Direction } from "../../../core/model.ts";
import { directionDelta } from "../../../core/position.ts";
import type { SolutionStep } from "../../../solver/contracts.ts";
import {
  enumerateReachablePushes,
  floodKeeperReachable,
} from "./reachable-pushes.ts";
import {
  buildSemanticZoneIndex,
  deriveSemanticZones,
  type SemanticZoneMap,
} from "./semantic-zones.ts";
import { boardHash as computeBoardHash } from "./puzzle-identity.ts";
import {
  isBoxChar,
  isGenericBoxChar,
  isGenericGoalChar,
  isGoalChar,
  isRobotChar,
  isTypedBoxChar,
  isTypedGoalChar,
  isWallChar,
} from "./tile-semantics.ts";

export interface TracePosition {
  readonly row: number;
  readonly column: number;
}

export type TraceBoxKind = "generic" | "typed";
export type TraceGoalKind = "generic" | "typed";

export interface TraceBox {
  readonly id: number;
  readonly kind: TraceBoxKind;
  readonly label?: string;
  readonly initialPosition: TracePosition;
  readonly finalPosition: TracePosition;
  readonly initialZoneId: string;
  readonly finalZoneId: string;
  readonly finalGoalId?: string;
  readonly pushCount: number;
}

export interface TraceGoal {
  readonly id: string;
  readonly kind: TraceGoalKind;
  readonly label?: string;
  readonly position: TracePosition;
  readonly zoneId: string;
}

export interface TracePushOption {
  readonly boxId: number;
  readonly direction: Direction;
  readonly support: TracePosition;
  readonly destination: TracePosition;
}

export interface TraceStepEvent {
  readonly stepIndex: number;
  readonly direction: Direction;
  readonly kind: "walk" | "push";
  readonly robotBefore: TracePosition;
  readonly robotAfter: TracePosition;
  readonly boxId?: number;
}

export interface TracePushEvent {
  readonly stepIndex: number;
  readonly pushIndex: number;
  readonly boxId: number;
  readonly boxKind: TraceBoxKind;
  readonly boxLabel?: string;
  readonly direction: Direction;
  readonly from: TracePosition;
  readonly to: TracePosition;
  readonly keeperSupport: TracePosition;
  readonly fromZoneId: string;
  readonly toZoneId: string;
  readonly fromGoalId?: string;
  readonly toGoalId?: string;
  readonly goalBefore?: string;
  readonly goalAfter?: string;
  readonly fromGoalMatched: boolean;
  readonly toGoalMatched: boolean;
  readonly keeperRegionBefore: string;
  readonly keeperRegionAfter: string;
  readonly reachableRegionBefore: string;
  readonly reachableRegionAfter: string;
  readonly keeperReachableBefore: number;
  readonly keeperReachableAfter: number;
  readonly reachablePushesBefore: readonly TracePushOption[];
  readonly reachablePushesAfter: readonly TracePushOption[];
  readonly enabledPushes: readonly TracePushOption[];
  readonly disabledPushes: readonly TracePushOption[];
  readonly enabledBoxIds: readonly number[];
  readonly disabledBoxIds: readonly number[];
}

/** Canonical phase shape; passive analysis emits inferred phases separately. */
export interface TracePhase {
  readonly id: string;
  readonly startPushIndex: number;
  readonly endPushIndex: number;
  readonly boxIds: readonly number[];
  readonly zoneIds: readonly string[];
}

export interface CanonicalSolutionTrace {
  readonly puzzleId: string;
  readonly boardHash: string;
  readonly boardWidth: number;
  readonly boardHeight: number;
  readonly initialRobot: TracePosition;
  readonly finalRobot: TracePosition;
  readonly boxes: readonly TraceBox[];
  readonly goals: readonly TraceGoal[];
  readonly steps: readonly TraceStepEvent[];
  readonly pushes: readonly TracePushEvent[];
  readonly phases: readonly TracePhase[];
  readonly semanticZones: SemanticZoneMap;
  readonly solved: boolean;
}

export type TraceBuildErrorCode =
  | "empty-grid"
  | "ragged-grid"
  | "missing-robot"
  | "multiple-robots"
  | "blocked-step"
  | "step-kind-mismatch"
  | "unsolved-final-state";

export interface TraceBuildError {
  readonly code: TraceBuildErrorCode;
  readonly message: string;
  readonly stepIndex?: number;
}

export type TraceBuildResult =
  | { readonly ok: true; readonly trace: CanonicalSolutionTrace }
  | { readonly ok: false; readonly error: TraceBuildError };

export interface TraceBuildOptions {
  readonly requireSolved?: boolean;
  readonly puzzleId?: string;
}

interface MutableBox {
  readonly id: number;
  readonly kind: TraceBoxKind;
  readonly label?: string;
  readonly initialPosition: TracePosition;
  row: number;
  column: number;
  pushCount: number;
}

function pos(row: number, column: number): TracePosition {
  return Object.freeze({ row, column });
}

function key(position: TracePosition): string {
  return `${position.row},${position.column}`;
}

function boxPositions(boxes: readonly MutableBox[]): Set<string> {
  return new Set(boxes.map((box) => `${box.row},${box.column}`));
}

function regionFingerprint(cells: ReadonlySet<string>, width: number): string {
  const indices = [...cells]
    .map((cell) => {
      const separator = cell.indexOf(",");
      return Number(cell.slice(0, separator)) * width + Number(cell.slice(separator + 1));
    })
    .sort((left, right) => left - right);
  let hash = 0x811c9dc5;
  for (const index of indices) {
    hash ^= index;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `keeper-${indices.length}-${hash.toString(16).padStart(8, "0")}`;
}

function tracePushOptions(
  grid: readonly (readonly string[])[],
  robot: TracePosition,
  boxes: readonly MutableBox[],
): readonly TracePushOption[] {
  return Object.freeze(enumerateReachablePushes(grid, robot, boxes).map((option) =>
    Object.freeze({
      boxId: boxes[option.boxIndex].id,
      direction: option.direction,
      support: pos(option.support.row, option.support.column),
      destination: pos(option.destination.row, option.destination.column),
    })));
}

function optionKey(option: TracePushOption): string {
  return `${option.boxId},${option.direction}`;
}

function optionDifference(
  left: readonly TracePushOption[],
  right: readonly TracePushOption[],
  movedBoxId: number,
): readonly TracePushOption[] {
  const rightKeys = new Set(right.map(optionKey));
  return Object.freeze(left.filter(
    (option) => option.boxId !== movedBoxId && !rightKeys.has(optionKey(option)),
  ));
}

function distinctSortedBoxIds(options: readonly TracePushOption[]): readonly number[] {
  return Object.freeze([...new Set(options.map((option) => option.boxId))]
    .sort((left, right) => left - right));
}

function goalMatchesBox(goal: TraceGoal | undefined, box: MutableBox): boolean {
  if (!goal) return false;
  if (box.kind === "generic") return goal.kind === "generic";
  return goal.kind === "typed" && goal.label === box.label?.toLowerCase();
}

function failure(
  code: TraceBuildErrorCode,
  message: string,
  stepIndex?: number,
): TraceBuildResult {
  return { ok: false, error: Object.freeze({ code, message, stepIndex }) };
}

/** Build a strict, deterministic trace from the exact board rows and route. */
export function buildCanonicalSolutionTrace(
  grid: readonly (readonly string[])[],
  solutionSteps: readonly SolutionStep[],
  options: TraceBuildOptions = {},
): TraceBuildResult {
  const height = grid.length;
  const width = height > 0 ? grid[0].length : 0;
  if (height === 0 || width === 0) return failure("empty-grid", "Trace grid is empty");
  if (grid.some((row) => row.length !== width)) {
    return failure("ragged-grid", "Trace grid rows must be rectangular");
  }

  const boxes: MutableBox[] = [];
  const goals: TraceGoal[] = [];
  const robots: TracePosition[] = [];
  const rows = grid.map((row) => row.join(""));
  const traceBoardHash = computeBoardHash(rows);
  const semanticZones = deriveSemanticZones(grid);
  const zoneByCell = buildSemanticZoneIndex(semanticZones);
  const zoneAt = (position: TracePosition) => zoneByCell.get(key(position)) ?? "outside";

  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const character = grid[row][column];
      if (isRobotChar(character)) robots.push(pos(row, column));
      if (isBoxChar(character)) {
        const kind = isGenericBoxChar(character) ? "generic" : "typed";
        boxes.push({
          id: boxes.length,
          kind,
          label: isTypedBoxChar(character) ? character : undefined,
          initialPosition: pos(row, column),
          row,
          column,
          pushCount: 0,
        });
      }
      if (isGoalChar(character)) {
        const kind = isGenericGoalChar(character) ? "generic" : "typed";
        const goalPosition = pos(row, column);
        goals.push(Object.freeze({
          id: `goal-${goals.length}`,
          kind,
          label: isTypedGoalChar(character) ? character : undefined,
          position: goalPosition,
          zoneId: zoneAt(goalPosition),
        }));
      }
    }
  }

  if (robots.length === 0) return failure("missing-robot", "Trace grid has no robot");
  if (robots.length > 1) return failure("multiple-robots", "Trace grid has multiple robots");

  const goalByCell = new Map(goals.map((goal) => [key(goal.position), goal] as const));
  const initialRobot = robots[0];
  let robot = initialRobot;
  const stepEvents: TraceStepEvent[] = [];
  const pushEvents: TracePushEvent[] = [];

  for (let stepIndex = 0; stepIndex < solutionSteps.length; stepIndex++) {
    const step = solutionSteps[stepIndex];
    const delta = directionDelta(step.direction);
    const target = pos(robot.row + delta.row, robot.column + delta.column);
    if (
      target.row < 0 || target.row >= height ||
      target.column < 0 || target.column >= width ||
      isWallChar(grid[target.row][target.column])
    ) {
      return failure("blocked-step", `Step ${stepIndex} moves into a wall or outside the board`, stepIndex);
    }

    const box = boxes.find((candidate) =>
      candidate.row === target.row && candidate.column === target.column);

    if (!box) {
      if (step.kind !== "walk") {
        return failure("step-kind-mismatch", `Step ${stepIndex} is marked push but moves no box`, stepIndex);
      }
      const before = robot;
      robot = target;
      stepEvents.push(Object.freeze({
        stepIndex,
        direction: step.direction,
        kind: "walk",
        robotBefore: before,
        robotAfter: robot,
      }));
      continue;
    }

    if (step.kind !== "push") {
      return failure("step-kind-mismatch", `Step ${stepIndex} is marked walk but contacts a box`, stepIndex);
    }

    const destination = pos(target.row + delta.row, target.column + delta.column);
    if (
      destination.row < 0 || destination.row >= height ||
      destination.column < 0 || destination.column >= width ||
      isWallChar(grid[destination.row][destination.column]) ||
      boxes.some((candidate) =>
        candidate.row === destination.row && candidate.column === destination.column)
    ) {
      return failure("blocked-step", `Step ${stepIndex} attempts an illegal push`, stepIndex);
    }

    const beforeBoxSet = boxPositions(boxes);
    const reachableBefore = floodKeeperReachable(grid, robot, beforeBoxSet);
    const pushesBefore = tracePushOptions(grid, robot, boxes);
    const fromGoal = goalByCell.get(key(target));
    const toGoal = goalByCell.get(key(destination));
    const robotBefore = robot;

    box.row = destination.row;
    box.column = destination.column;
    box.pushCount++;
    robot = target;

    const afterBoxSet = boxPositions(boxes);
    const reachableAfter = floodKeeperReachable(grid, robot, afterBoxSet);
    const pushesAfter = tracePushOptions(grid, robot, boxes);
    const enabledPushes = optionDifference(pushesAfter, pushesBefore, box.id);
    const disabledPushes = optionDifference(pushesBefore, pushesAfter, box.id);
    const enabledBoxIds = distinctSortedBoxIds(enabledPushes);
    const disabledBoxIds = distinctSortedBoxIds(disabledPushes);
    const reachableRegionBefore = regionFingerprint(reachableBefore, width);
    const reachableRegionAfter = regionFingerprint(reachableAfter, width);

    pushEvents.push(Object.freeze({
      stepIndex,
      pushIndex: pushEvents.length,
      boxId: box.id,
      boxKind: box.kind,
      boxLabel: box.label,
      direction: step.direction,
      from: target,
      to: destination,
      keeperSupport: robotBefore,
      fromZoneId: zoneAt(target),
      toZoneId: zoneAt(destination),
      fromGoalId: fromGoal?.id,
      toGoalId: toGoal?.id,
      goalBefore: fromGoal?.id,
      goalAfter: toGoal?.id,
      fromGoalMatched: goalMatchesBox(fromGoal, box),
      toGoalMatched: goalMatchesBox(toGoal, box),
      keeperRegionBefore: reachableRegionBefore,
      keeperRegionAfter: reachableRegionAfter,
      reachableRegionBefore,
      reachableRegionAfter,
      keeperReachableBefore: reachableBefore.size,
      keeperReachableAfter: reachableAfter.size,
      reachablePushesBefore: pushesBefore,
      reachablePushesAfter: pushesAfter,
      enabledPushes,
      disabledPushes,
      enabledBoxIds,
      disabledBoxIds,
    }));

    stepEvents.push(Object.freeze({
      stepIndex,
      direction: step.direction,
      kind: "push",
      robotBefore,
      robotAfter: robot,
      boxId: box.id,
    }));
  }

  const finalBoxes: TraceBox[] = boxes.map((box) => {
    const finalPosition = pos(box.row, box.column);
    const finalGoal = goalByCell.get(key(finalPosition));
    return Object.freeze({
      id: box.id,
      kind: box.kind,
      label: box.label,
      initialPosition: box.initialPosition,
      finalPosition,
      initialZoneId: zoneAt(box.initialPosition),
      finalZoneId: zoneAt(finalPosition),
      finalGoalId: goalMatchesBox(finalGoal, box) ? finalGoal?.id : undefined,
      pushCount: box.pushCount,
    });
  });
  const solved = finalBoxes.length === goals.length &&
    finalBoxes.every((box) => box.finalGoalId !== undefined);

  if (options.requireSolved && !solved) {
    return failure("unsolved-final-state", "Trace route does not finish in a solved state");
  }

  return {
    ok: true,
    trace: Object.freeze({
      puzzleId: options.puzzleId ?? `trace-${traceBoardHash}`,
      boardHash: traceBoardHash,
      boardWidth: width,
      boardHeight: height,
      initialRobot,
      finalRobot: robot,
      boxes: Object.freeze(finalBoxes),
      goals: Object.freeze(goals),
      steps: Object.freeze(stepEvents),
      pushes: Object.freeze(pushEvents),
      phases: Object.freeze([]),
      semanticZones,
      solved,
    }),
  };
}
