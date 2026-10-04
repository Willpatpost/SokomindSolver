import type { CompiledSearchBoard } from "./compiled-board.ts";

export type ProofAlgorithm = "astar" | "ida-star";

export function selectProofAlgorithm(
  board: CompiledSearchBoard,
  boxCount: number,
  maxMemoryBytes?: number,
): ProofAlgorithm {
  if (maxMemoryBytes !== undefined && maxMemoryBytes < 768 * 1024 * 1024) {
    return "ida-star";
  }
  const highMemory = maxMemoryBytes === undefined || maxMemoryBytes >= 2 * 1024 * 1024 * 1024;
  const boxThreshold = highMemory ? 12 : 8;
  const cellThreshold = highMemory ? 150 : 96;
  if (boxCount <= boxThreshold && board.cellCount <= cellThreshold) {
    return "astar";
  }
  return "ida-star";
}

export interface ProofLanePlan {
  readonly algorithm: ProofAlgorithm;
  readonly lanes: number;
}

/**
 * Picks the algorithm and lane count together from the memory all lanes share.
 * A* keeps every visited state, while IDA* searches each transposition again
 * and can stall on boards that A* proves in a few thousand states. The plan
 * keeps the most lanes whose share of memory still selects A*, and runs IDA*
 * on every lane only when no lane count can.
 */
export function selectProofLanes(
  board: CompiledSearchBoard,
  boxCount: number,
  maxLanes: number,
  sharedMemoryBytes?: number,
): ProofLanePlan {
  for (let lanes = maxLanes; lanes >= 1; lanes--) {
    const laneMemoryBytes = sharedMemoryBytes === undefined
      ? undefined
      : Math.floor(sharedMemoryBytes / lanes);
    if (selectProofAlgorithm(board, boxCount, laneMemoryBytes) === "astar") {
      return { algorithm: "astar", lanes };
    }
  }
  return { algorithm: "ida-star", lanes: maxLanes };
}
