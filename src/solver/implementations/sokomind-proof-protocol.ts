import { positionKey, type Direction } from "../../core/index.ts";
import type { Box, GameSnapshot, Position } from "../../core/model.ts";
import type {
  SolutionStep,
  SolverRequest,
  SolverRunMetrics,
  SolverSolution,
} from "../contracts.ts";
import { isSolverRunMetrics, isSolverSolution } from "../validation.ts";
import { isRecord } from "../../core/type-guards.ts";
import {
  compileSearchBoard,
  SEARCH_DIRECTIONS,
  type CompiledSearchBoard,
} from "../search/compiled-board.ts";
import { KeeperReachability } from "../search/reachability.ts";

/** The coordinator presumes a proof lane dead after this long without a message. */
export const PROOF_SILENCE_TIMEOUT_MS = 30_000;
/** A lane with an active partition sends a message at least this often. */
export const PROOF_HEARTBEAT_MS = 5_000;

export interface ProofStartPartition {
  readonly type: "proof/start-partition";
  /**
   * Names one coordinator run. A lane may serve several runs in turn, and
   * partition ids repeat across runs of the same board, so every result
   * echoes it.
   */
  readonly runId: number;
  readonly partitionId: string;
  readonly request: SolverRequest;
  /** Exclusive numeric move cap; it is not evidence that a route exists. */
  readonly initialUpperBound: number;
  readonly prefixCost: number;
  readonly prefixSteps: readonly SolutionStep[];
  readonly algorithm: "astar" | "ida-star";
  readonly deterministic?: boolean;
  /** A* only: share full exact-state bounds with the run's other lanes. */
  readonly shareHeuristic?: boolean;
}

export interface ProofUpdateUpperBound {
  readonly type: "solver/update-upper-bound";
  readonly moves: number;
}

export interface ProofCancel {
  readonly type: "proof/cancel";
}

/**
 * Exact-state bounds another lane of the run computed in full, relayed by
 * the coordinator. Each entry is the robot cell, the sorted box tokens, then
 * the bound.
 */
export interface ProofHeuristicEntriesCommand {
  readonly type: "proof/heuristic-entries";
  readonly runId: number;
  readonly entries: Uint32Array;
}

export type ProofCommand =
  | ProofStartPartition
  | ProofUpdateUpperBound
  | ProofCancel
  | ProofHeuristicEntriesCommand;

export interface ProofProgress {
  readonly type: "proof/progress";
  readonly runId: number;
  readonly partitionId: string;
  readonly lowerBound: number;
  readonly expandedStates: number;
  readonly generatedStates?: number;
  readonly counters?: Readonly<Record<string, number>>;
}

export interface ProofSolutionFound {
  readonly type: "proof/solution";
  readonly runId: number;
  readonly partitionId: string;
  readonly solution: SolverSolution;
  readonly totalCost: number;
}

export interface ProofPartitionComplete {
  readonly type: "proof/partition-complete";
  readonly runId: number;
  readonly partitionId: string;
  readonly lowerBound: number;
  readonly exhausted: boolean;
  readonly metrics: SolverRunMetrics;
}

export interface ProofError {
  readonly type: "proof/error";
  readonly runId: number;
  readonly partitionId: string;
  readonly message: string;
}

/** Bounds a lane computed in full, in the layout of the relayed command. */
export interface ProofHeuristicEntries {
  readonly type: "proof/heuristic-entries";
  readonly runId: number;
  readonly partitionId: string;
  readonly entries: Uint32Array;
}

/** Posted after a partition's last result, once the lane can take another. */
export interface ProofIdle {
  readonly type: "proof/idle";
  readonly runId: number;
  readonly partitionId: string;
}

export type ProofResult =
  | ProofProgress
  | ProofSolutionFound
  | ProofPartitionComplete
  | ProofError
  | ProofHeuristicEntries
  | ProofIdle;

const PROOF_COMMAND_TYPES: ReadonlySet<unknown> = new Set<unknown>([
  "proof/start-partition",
  "solver/update-upper-bound",
  "proof/cancel",
  "proof/heuristic-entries",
]);

const PROOF_RESULT_TYPES: ReadonlySet<unknown> = new Set<unknown>([
  "proof/progress",
  "proof/solution",
  "proof/partition-complete",
  "proof/error",
  "proof/heuristic-entries",
  "proof/idle",
]);

function isNonNegativeSafeCost(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isProofCommand(value: unknown): value is ProofCommand {
  if (!isRecord(value)) return false;
  if (!PROOF_COMMAND_TYPES.has(value.type)) return false;

  switch (value.type) {
    case "proof/start-partition":
      return (
        isNonNegativeSafeCost(value.runId) &&
        typeof value.partitionId === "string" &&
        isRecord(value.request) &&
        isNonNegativeSafeCost(value.initialUpperBound) &&
        typeof value.prefixCost === "number" &&
        Number.isSafeInteger(value.prefixCost) &&
        value.prefixCost >= 0 &&
        Array.isArray(value.prefixSteps) &&
        (value.algorithm === "astar" || value.algorithm === "ida-star")
      );
    case "solver/update-upper-bound":
      return (
        typeof value.moves === "number" &&
        Number.isSafeInteger(value.moves) &&
        value.moves >= 0
      );
    case "proof/cancel":
      return true;
    case "proof/heuristic-entries":
      return (
        isNonNegativeSafeCost(value.runId) &&
        value.entries instanceof Uint32Array
      );
    default:
      return false;
  }
}

export function isProofResult(value: unknown): value is ProofResult {
  if (!isRecord(value)) return false;
  if (!PROOF_RESULT_TYPES.has(value.type)) return false;
  if (!isNonNegativeSafeCost(value.runId)) return false;

  switch (value.type) {
    case "proof/progress":
      return (
        typeof value.partitionId === "string" &&
        isNonNegativeSafeCost(value.lowerBound) &&
        Number.isSafeInteger(value.expandedStates) &&
        (value.expandedStates as number) >= 0 &&
        (value.generatedStates === undefined ||
          (Number.isSafeInteger(value.generatedStates) &&
            (value.generatedStates as number) >= 0)) &&
        (value.counters === undefined || isSolverRunMetrics({
          elapsedMs: 0,
          counters: value.counters,
        }))
      );
    case "proof/solution":
      return (
        typeof value.partitionId === "string" &&
        isSolverSolution(value.solution) &&
        Number.isSafeInteger(value.totalCost) &&
        (value.totalCost as number) >= 0 &&
        value.totalCost === value.solution.moves
      );
    case "proof/partition-complete":
      return (
        typeof value.partitionId === "string" &&
        isNonNegativeSafeCost(value.lowerBound) &&
        typeof value.exhausted === "boolean" &&
        isSolverRunMetrics(value.metrics)
      );
    case "proof/error":
      return (
        typeof value.partitionId === "string" &&
        typeof value.message === "string"
      );
    case "proof/heuristic-entries":
      return (
        typeof value.partitionId === "string" &&
        value.entries instanceof Uint32Array
      );
    case "proof/idle":
      return typeof value.partitionId === "string";
    default:
      return false;
  }
}

export interface ProofPartition {
  readonly partitionId: string;
  readonly prefixCost: number;
  readonly prefixSteps: readonly SolutionStep[];
  readonly postPushRobot: Position;
  readonly postPushBoxes: readonly Box[];
}

function partitionStateKey(
  robotCell: number,
  boxCells: readonly number[],
): string {
  const sorted = [...boxCells].sort((a, b) => a - b);
  return `${robotCell}:${sorted.join(",")}`;
}

export function enumerateFirstPushPartitions(
  request: SolverRequest,
  board?: CompiledSearchBoard,
): readonly ProofPartition[] {
  const compiled = board ?? compileSearchBoard(request.board);
  const snapshot = request.snapshot;
  const robotCell = compiled.cellAt(snapshot.robot.row, snapshot.robot.column);
  if (robotCell < 0) return [];

  const occupancy = new Uint8Array(compiled.cellCount);
  const boxCells: number[] = [];
  for (const box of snapshot.boxes) {
    const cell = compiled.cellAt(box.position.row, box.position.column);
    if (cell < 0) return [];
    occupancy[cell] = 1;
    boxCells.push(cell);
  }

  const reachability = new KeeperReachability(compiled);
  const reach = reachability.flood(robotCell, occupancy);

  const seen = new Set<string>();
  const partitions: ProofPartition[] = [];

  for (let bi = 0; bi < snapshot.boxes.length; bi++) {
    const boxCell = boxCells[bi];

    for (const searchDir of SEARCH_DIRECTIONS) {
      const supportCell =
        compiled.neighbors[boxCell][searchDir.oppositeIndex];
      if (supportCell < 0) continue;
      if (!reach.isReachable(supportCell)) continue;

      const dirIndex = SEARCH_DIRECTIONS.indexOf(searchDir);
      const destCell = compiled.neighbors[boxCell][dirIndex];
      if (destCell < 0) continue;
      if (occupancy[destCell] !== 0) continue;

      const postPushBoxCells = boxCells.map((c, i) =>
        i === bi ? destCell : c,
      );
      const stateKey = partitionStateKey(boxCell, postPushBoxCells);
      if (seen.has(stateKey)) continue;
      seen.add(stateKey);

      const walkPath = reach.pathTo(supportCell);
      if (!walkPath) continue;
      const walkCost = walkPath.length;

      const prefixSteps: SolutionStep[] = [];
      for (const dir of walkPath) {
        prefixSteps.push({ direction: dir, kind: "walk" });
      }
      prefixSteps.push({
        direction: searchDir.direction as Direction,
        kind: "push",
      });

      const postPushBoxes: Box[] = snapshot.boxes.map((b, i) =>
        i === bi
          ? {
              id: b.id,
              label: b.label,
              position: compiled.positions[destCell],
            }
          : b,
      );

      partitions.push({
        partitionId: stateKey,
        prefixCost: walkCost + 1,
        prefixSteps,
        postPushRobot: compiled.positions[boxCell],
        postPushBoxes,
      });
    }
  }

  return partitions;
}

export function buildPartitionRequest(
  original: SolverRequest,
  partition: ProofPartition,
): SolverRequest {
  // A first push can solve the board; the request must say so to stay valid.
  const goalLabels = new Map(
    original.board.goals.map((goal) => [positionKey(goal.position), goal.label]),
  );
  const snapshot: GameSnapshot = {
    puzzleId: original.snapshot.puzzleId,
    robot: partition.postPushRobot,
    boxes: partition.postPushBoxes,
    moves: 0,
    pushes: 0,
    solved: partition.postPushBoxes.every(
      (box) => goalLabels.get(positionKey(box.position)) === box.label,
    ),
  };
  return { ...original, snapshot };
}
