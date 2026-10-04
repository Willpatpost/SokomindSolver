import {
  decodeActionLog,
  isActionLog,
  stepSnapshot,
  type GameSnapshot,
} from "../core/index.ts";
import type {
  SolutionStep,
  SolverProgress,
  SolverRequest,
  SolverSolution,
} from "./contracts.ts";
import {
  assertValidSolverRequest,
  assertValidSolverSolution,
  SolverValidationError,
} from "./validation.ts";

export type SolverVerificationCode =
  | "invalid-request"
  | "invalid-solution"
  | "illegal-step"
  | "step-kind-mismatch"
  | "move-count-mismatch"
  | "push-count-mismatch"
  | "unsolved";

export interface SolverVerificationFailure {
  readonly valid: false;
  readonly code: SolverVerificationCode;
  readonly message: string;
  readonly stepIndex?: number;
}

export interface SolverVerificationSuccess {
  readonly valid: true;
  readonly finalSnapshot: GameSnapshot;
}

export type SolverVerificationResult =
  | SolverVerificationSuccess
  | SolverVerificationFailure;

export class SolverSolutionVerificationError extends Error {
  readonly failure: SolverVerificationFailure;

  constructor(failure: SolverVerificationFailure) {
    super(failure.message);
    this.name = "SolverSolutionVerificationError";
    this.failure = failure;
  }
}

function failure(
  code: SolverVerificationCode,
  message: string,
  stepIndex?: number,
): SolverVerificationFailure {
  return Object.freeze({
    valid: false,
    code,
    message,
    ...(stepIndex === undefined ? {} : { stepIndex }),
  });
}

function requestFailure(
  request: SolverRequest,
): SolverVerificationFailure | undefined {
  try {
    assertValidSolverRequest(request);
    return undefined;
  } catch (error) {
    const detail =
      error instanceof SolverValidationError ? error.message : "invalid request";
    return failure(
      "invalid-request",
      `Cannot verify against an invalid solver request: ${detail}`,
    );
  }
}

/**
 * Treats a solver result as untrusted input and replays every step through the
 * core transition API. A solution is accepted only when every declared action
 * is legal, walk/push annotations are exact, counters agree, and the final
 * state is solved.
 */
export function verifySolverSolution(
  request: SolverRequest,
  solution: SolverSolution,
): SolverVerificationResult {
  const invalidRequest = requestFailure(request);
  if (invalidRequest) return invalidRequest;

  try {
    assertValidSolverSolution(solution);
  } catch (error) {
    const detail =
      error instanceof SolverValidationError
        ? error.message
        : "invalid solution";
    return failure(
      "invalid-solution",
      `Solver returned an invalid solution: ${detail}`,
    );
  }

  let snapshot = request.snapshot;
  let replayedPushes = 0;

  for (const [stepIndex, step] of solution.steps.entries()) {
    const transition = stepSnapshot(request.board, snapshot, step.direction);
    if (!transition.moved) {
      return failure(
        "illegal-step",
        `Solution step ${stepIndex + 1} is blocked.`,
        stepIndex,
      );
    }
    const actualKind = transition.pushed ? "push" : "walk";
    if (step.kind !== actualKind) {
      return failure(
        "step-kind-mismatch",
        `Solution step ${stepIndex + 1} is a ${actualKind}, not a ${step.kind}.`,
        stepIndex,
      );
    }
    if (transition.pushed) replayedPushes += 1;
    snapshot = transition.snapshot;
  }

  const replayedMoves = snapshot.moves - request.snapshot.moves;
  if (replayedMoves !== solution.moves) {
    return failure(
      "move-count-mismatch",
      `Replayed ${replayedMoves} moves, but the solution declares ${solution.moves}.`,
    );
  }
  if (replayedPushes !== solution.pushes) {
    return failure(
      "push-count-mismatch",
      `Replayed ${replayedPushes} pushes, but the solution declares ${solution.pushes}.`,
    );
  }
  if (!snapshot.solved) {
    return failure(
      "unsolved",
      "The legal solution steps do not finish the puzzle.",
    );
  }

  return Object.freeze({ valid: true, finalSnapshot: snapshot });
}

export function assertVerifiedSolverSolution(
  request: SolverRequest,
  solution: SolverSolution,
): GameSnapshot {
  const result = verifySolverSolution(request, solution);
  if (!result.valid) throw new SolverSolutionVerificationError(result);
  return result.finalSnapshot;
}

/**
 * Rebuilds a progress incumbent's route as a solution. The route is untrusted:
 * each action replays through the core transition API, walk/push kinds come
 * from that replay, and the declared counts and the solved state are checked
 * as for a returned solution. The solution never claims optimality. Throws
 * SolverSolutionVerificationError when the route does not verify.
 */
export function solutionFromIncumbentRoute(
  request: SolverRequest,
  incumbent: NonNullable<SolverProgress["incumbent"]>,
): SolverSolution {
  const invalidRequest = requestFailure(request);
  if (invalidRequest) throw new SolverSolutionVerificationError(invalidRequest);
  const route = incumbent.route;
  if (!isActionLog(route)) {
    throw new SolverSolutionVerificationError(
      failure("invalid-solution", "The incumbent carries no valid route."),
    );
  }

  const steps: SolutionStep[] = [];
  let snapshot = request.snapshot;
  for (const [stepIndex, direction] of decodeActionLog(route).entries()) {
    const transition = stepSnapshot(request.board, snapshot, direction);
    if (!transition.moved) {
      throw new SolverSolutionVerificationError(
        failure(
          "illegal-step",
          `Incumbent route step ${stepIndex + 1} is blocked.`,
          stepIndex,
        ),
      );
    }
    const kind: SolutionStep["kind"] = transition.pushed ? "push" : "walk";
    steps.push(Object.freeze({ direction, kind }));
    snapshot = transition.snapshot;
  }

  const solution: SolverSolution = Object.freeze({
    steps: Object.freeze(steps),
    moves: incumbent.moves,
    pushes: incumbent.pushes,
    objective: request.objective,
    objectiveScore: incumbent.objectiveScore,
    optimality: "unknown",
  });
  assertVerifiedSolverSolution(request, solution);
  return solution;
}
