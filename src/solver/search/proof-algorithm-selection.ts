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
