import type {
  SolverExecutionTarget,
  SolverMetadata,
  SolverRequest,
} from "./contracts.ts";

export type SolverCompatibilityErrorCode =
  | "UNSUPPORTED_EXECUTION_TARGET"
  | "UNSUPPORTED_OBJECTIVE"
  | "UNSUPPORTED_LABELED_BOXES"
  | "UNSUPPORTED_GENERIC_BOXES"
  | "UNSUPPORTED_PARTIAL_STATE";

export class SolverCompatibilityError extends Error {
  readonly code: SolverCompatibilityErrorCode;
  readonly solverId: string;

  constructor(
    code: SolverCompatibilityErrorCode,
    solverId: string,
    message: string,
  ) {
    super(message);
    this.name = "SolverCompatibilityError";
    this.code = code;
    this.solverId = solverId;
  }
}

export interface SolverRequestFeatures {
  readonly labeledBoxes: boolean;
  readonly genericBoxes: boolean;
  readonly partialState: boolean;
}

function samePosition(
  first: Readonly<{ row: number; column: number }>,
  second: Readonly<{ row: number; column: number }>,
): boolean {
  return first.row === second.row && first.column === second.column;
}

export function getSolverRequestFeatures(
  request: SolverRequest,
): SolverRequestFeatures {
  const labels = [
    ...request.board.initialBoxes.map(({ label }) => label),
    ...request.board.goals.map(({ label }) => label),
    ...request.snapshot.boxes.map(({ label }) => label),
  ];
  const initialBoxes = new Map(
    request.board.initialBoxes.map((box) => [box.id, box]),
  );
  const boxesMatchInitial =
    request.snapshot.boxes.length === initialBoxes.size &&
    request.snapshot.boxes.every((box) => {
      const initial = initialBoxes.get(box.id);
      return (
        initial !== undefined &&
        initial.label === box.label &&
        samePosition(initial.position, box.position)
      );
    });

  return Object.freeze({
    labeledBoxes: labels.some((label) => label !== "X"),
    genericBoxes: labels.some((label) => label === "X"),
    partialState:
      !samePosition(request.board.initialRobot, request.snapshot.robot) ||
      !boxesMatchInitial,
  });
}

export function assertSolverRequestCompatible(
  metadata: SolverMetadata,
  request: SolverRequest,
  executionTarget: SolverExecutionTarget,
): void {
  const { capabilities } = metadata;
  if (!capabilities.executionTargets.includes(executionTarget)) {
    throw new SolverCompatibilityError(
      "UNSUPPORTED_EXECUTION_TARGET",
      metadata.id,
      `Solver "${metadata.id}" does not support ${executionTarget} execution.`,
    );
  }
  if (!capabilities.objectives.includes(request.objective.kind)) {
    throw new SolverCompatibilityError(
      "UNSUPPORTED_OBJECTIVE",
      metadata.id,
      `Solver "${metadata.id}" does not support the ${request.objective.kind} objective.`,
    );
  }

  const features = getSolverRequestFeatures(request);
  if (features.labeledBoxes && !capabilities.labeledBoxes) {
    throw new SolverCompatibilityError(
      "UNSUPPORTED_LABELED_BOXES",
      metadata.id,
      `Solver "${metadata.id}" does not support labeled boxes.`,
    );
  }
  if (features.genericBoxes && !capabilities.genericBoxes) {
    throw new SolverCompatibilityError(
      "UNSUPPORTED_GENERIC_BOXES",
      metadata.id,
      `Solver "${metadata.id}" does not support generic boxes.`,
    );
  }
  if (features.partialState && !capabilities.partialState) {
    throw new SolverCompatibilityError(
      "UNSUPPORTED_PARTIAL_STATE",
      metadata.id,
      `Solver "${metadata.id}" does not support partial-state requests.`,
    );
  }
}
