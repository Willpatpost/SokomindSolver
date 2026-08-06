import type {
  SolverExecutionContext,
  SolverRequest,
  SolverResult,
} from "../contracts.ts";
import type { SokomindRequestOptions } from "./sokomind-options.ts";
import { compileSearchBoard } from "../search/compiled-board.ts";
import { selectProofAlgorithm, type ProofAlgorithm } from "../search/proof-algorithm-selection.ts";
import { runExactMoveAStar, type ExactIncumbent } from "../search/exact-move-astar.ts";
import { runIdaStarSearch } from "../search/ida-star.ts";

export async function runSequentialProof(
  request: SolverRequest,
  context: SolverExecutionContext,
  options: SokomindRequestOptions,
  discoveryResult: SolverResult,
): Promise<SolverResult> {
  if (discoveryResult.status !== "solved") {
    return discoveryResult;
  }

  const incumbent: ExactIncumbent = {
    solution: discoveryResult.solution,
    cost: discoveryResult.solution.moves,
  };

  const remaining = request.limits?.maxElapsedMs !== undefined
    ? request.limits.maxElapsedMs - discoveryResult.metrics.elapsedMs
    : undefined;

  if (remaining !== undefined && remaining <= 0) {
    return discoveryResult;
  }

  const proofLimits = options.mode === "optimal"
    ? request.limits
    : remaining !== undefined
      ? { ...request.limits, maxElapsedMs: remaining }
      : request.limits;

  const board = compileSearchBoard(request.board);
  const boxCount = request.snapshot.boxes.length;

  let algorithm: ProofAlgorithm;
  if (options.proofAlgorithm === "auto") {
    algorithm = selectProofAlgorithm(board, boxCount, request.limits?.maxMemoryBytes);
  } else {
    algorithm = options.proofAlgorithm;
  }

  const proofRequest: SolverRequest = {
    ...request,
    limits: proofLimits,
  };

  let proofResult: SolverResult;
  if (algorithm === "astar") {
    proofResult = await runExactMoveAStar(proofRequest, context, { incumbent });
  } else {
    proofResult = await runIdaStarSearch(proofRequest, context, {
      incumbent,
      reachabilityPolicy: options.idaReachabilitySnapshots,
      snapshotPeriod: options.idaSnapshotPeriod,
    });
  }

  if (proofResult.status === "solved") {
    return proofResult;
  }

  return discoveryResult;
}
