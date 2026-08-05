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
  if (boxCount <= 8 && board.cellCount <= 96) {
    return "astar";
  }
  return "ida-star";
}
