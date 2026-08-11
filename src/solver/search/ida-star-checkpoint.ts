import type { GameSnapshot, ParsedBoard } from "../../core/model.ts";
import type { SolverObjective, SolverSolution } from "../contracts.ts";
import { isSolverSolution } from "../validation.ts";

export const IDA_STAR_CHECKPOINT_SCHEMA_VERSION = 2 as const;

export interface IdaStarCheckpointCounters {
  readonly expanded: number;
  readonly generated: number;
  readonly iterations: number;
}

export interface IdaStarCheckpointIncumbent {
  readonly solution: SolverSolution;
  readonly cost: number;
}

export interface IdaStarCheckpoint {
  readonly schemaVersion: typeof IDA_STAR_CHECKPOINT_SCHEMA_VERSION;
  readonly boardContentKey: string;
  readonly solverVersion: string;
  readonly objective: SolverObjective;
  readonly exactStateCodecVersion: number;
  readonly currentThreshold: number;
  readonly lastExhaustedThreshold: number;
  readonly incumbent: IdaStarCheckpointIncumbent | null;
  readonly partitionId: string | null;
  readonly transpositionMetadata: { readonly policy: "best-g-per-iteration" };
  readonly counters: IdaStarCheckpointCounters;
}

/** Browser-neutral deterministic 64-bit FNV-1a digest. */
function stableHash64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    hash ^= BigInt(code & 0xff);
    hash = (hash * prime) & mask;
    hash ^= BigInt(code >>> 8);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

type CheckpointStartState = Pick<GameSnapshot, "robot" | "boxes">;

export function createBoardContentKey(
  board: ParsedBoard,
  snapshot: CheckpointStartState = {
    robot: board.initialRobot,
    boxes: board.initialBoxes,
  },
): string {
  const parts: string[] = [];
  parts.push(`${board.width}x${board.height}`);

  const wallKeys = board.walls
    .map((w) => `W${w.row},${w.column}`)
    .sort();
  parts.push(wallKeys.join(";"));

  const goalKeys = board.goals
    .map((g) => `G${g.label}:${g.position.row},${g.position.column}`)
    .sort();
  parts.push(goalKeys.join(";"));

  const floorKeys = board.floor
    .map((f) => `F${f.row},${f.column}`)
    .sort();
  parts.push(floorKeys.join(";"));

  parts.push(`R${snapshot.robot.row},${snapshot.robot.column}`);
  const boxKeys = snapshot.boxes
    .map((box) => `B${box.label}:${box.position.row},${box.position.column}`)
    .sort();
  parts.push(boxKeys.join(";"));

  return stableHash64(parts.join("|"));
}

export function createExactStateCodecVersion(
  cellCount: number,
  labelCount: number,
): number {
  const combined = `codec:${cellCount}:${labelCount}`;
  return Number.parseInt(stableHash64(combined).slice(0, 8), 16);
}

function sortKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sortKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}

export function serializeCheckpoint(checkpoint: IdaStarCheckpoint): string {
  return JSON.stringify(sortKeys(checkpoint));
}

export function deserializeCheckpoint(json: string): IdaStarCheckpoint {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Checkpoint must be a JSON object");
  }

  const obj = parsed as Record<string, unknown>;

  if (obj.schemaVersion !== IDA_STAR_CHECKPOINT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported checkpoint schema version: ${String(obj.schemaVersion)}`,
    );
  }
  if (typeof obj.boardContentKey !== "string") {
    throw new Error("Missing or invalid boardContentKey");
  }
  if (typeof obj.solverVersion !== "string") {
    throw new Error("Missing or invalid solverVersion");
  }
  if (
    typeof obj.objective !== "object" ||
    obj.objective === null ||
    (obj.objective as Record<string, unknown>).kind !== "moves"
  ) {
    throw new Error("Missing or invalid objective");
  }
  if (typeof obj.exactStateCodecVersion !== "number") {
    throw new Error("Missing or invalid exactStateCodecVersion");
  }
  if (
    typeof obj.currentThreshold !== "number" ||
    !Number.isFinite(obj.currentThreshold)
  ) {
    throw new Error("Missing or invalid currentThreshold");
  }
  if (
    typeof obj.lastExhaustedThreshold !== "number" ||
    !Number.isFinite(obj.lastExhaustedThreshold)
  ) {
    throw new Error("Missing or invalid lastExhaustedThreshold");
  }

  if (obj.incumbent !== null) {
    if (typeof obj.incumbent !== "object" || Array.isArray(obj.incumbent)) {
      throw new Error("Invalid incumbent");
    }
    const inc = obj.incumbent as Record<string, unknown>;
    if (!Number.isSafeInteger(inc.cost) || (inc.cost as number) < 0) {
      throw new Error("Missing or invalid incumbent.cost");
    }
    if (!isSolverSolution(inc.solution)) {
      throw new Error("Missing or invalid incumbent.solution");
    }
    if (inc.cost !== inc.solution.moves) {
      throw new Error("incumbent.cost must equal incumbent.solution.moves");
    }
  }

  if (obj.partitionId !== null && typeof obj.partitionId !== "string") {
    throw new Error("Invalid partitionId");
  }

  if (
    typeof obj.transpositionMetadata !== "object" ||
    obj.transpositionMetadata === null ||
    (obj.transpositionMetadata as Record<string, unknown>).policy !==
      "best-g-per-iteration"
  ) {
    throw new Error("Missing transpositionMetadata");
  }

  if (typeof obj.counters !== "object" || obj.counters === null) {
    throw new Error("Missing counters");
  }
  const counters = obj.counters as Record<string, unknown>;
  if (typeof counters.expanded !== "number" || !Number.isFinite(counters.expanded) || counters.expanded < 0) {
    throw new Error("Missing or invalid counters.expanded");
  }
  if (typeof counters.generated !== "number" || !Number.isFinite(counters.generated) || counters.generated < 0) {
    throw new Error("Missing or invalid counters.generated");
  }
  if (typeof counters.iterations !== "number" || !Number.isFinite(counters.iterations) || counters.iterations < 0) {
    throw new Error("Missing or invalid counters.iterations");
  }

  return parsed as IdaStarCheckpoint;
}

export type CheckpointCompatibilityResult =
  | { readonly compatible: true }
  | { readonly compatible: false; readonly reason: string };

export function validateCheckpointCompatibility(
  checkpoint: IdaStarCheckpoint,
  board: ParsedBoard,
  solverVersion: string,
  objective: SolverObjective,
  cellCount: number,
  labelCount: number,
  snapshot: CheckpointStartState,
): CheckpointCompatibilityResult {
  if (checkpoint.schemaVersion !== IDA_STAR_CHECKPOINT_SCHEMA_VERSION) {
    return {
      compatible: false,
      reason: `Schema version mismatch: checkpoint=${checkpoint.schemaVersion}, expected=${IDA_STAR_CHECKPOINT_SCHEMA_VERSION}`,
    };
  }

  const expectedBoardKey = createBoardContentKey(board, snapshot);
  if (checkpoint.boardContentKey !== expectedBoardKey) {
    return {
      compatible: false,
      reason: `Board content key mismatch: checkpoint=${checkpoint.boardContentKey}, expected=${expectedBoardKey}`,
    };
  }

  if (checkpoint.solverVersion !== solverVersion) {
    return {
      compatible: false,
      reason: `Solver version mismatch: checkpoint=${checkpoint.solverVersion}, expected=${solverVersion}`,
    };
  }

  if (checkpoint.objective.kind !== objective.kind) {
    return {
      compatible: false,
      reason: `Objective mismatch: checkpoint=${checkpoint.objective.kind}, expected=${objective.kind}`,
    };
  }

  const expectedCodecVersion = createExactStateCodecVersion(cellCount, labelCount);
  if (checkpoint.exactStateCodecVersion !== expectedCodecVersion) {
    return {
      compatible: false,
      reason: `Exact-state codec version mismatch: checkpoint=${checkpoint.exactStateCodecVersion}, expected=${expectedCodecVersion}`,
    };
  }

  return { compatible: true };
}
