import {
  DIRECTIONS,
  positionKey,
  type Box,
  type GameSnapshot,
  type Goal,
  type ParsedBoard,
  type Position,
} from "../core/index.ts";
import type {
  SolutionStep,
  SolverLimits,
  SolverMetadata,
  SolverObjective,
  SolverOptions,
  SolverProgress,
  SolverRequest,
  SolverResult,
  SolverRunMetrics,
  SolverSolution,
} from "./contracts.ts";

export interface SolverValidationIssue {
  readonly path: string;
  readonly message: string;
}

export class SolverValidationError extends TypeError {
  readonly issues: readonly SolverValidationIssue[];

  constructor(
    subject: string,
    issues: readonly SolverValidationIssue[],
  ) {
    super(
      `${subject} is invalid: ${issues
        .map(({ path, message }) => `${path}: ${message}`)
        .join("; ")}`,
    );
    this.name = "SolverValidationError";
    this.issues = Object.freeze([...issues]);
  }
}

type Issues = SolverValidationIssue[];
type UnknownRecord = Record<string, unknown>;

const OBJECTIVE_KINDS = new Set(["moves"]);
const PHASES = new Set(["preparing", "searching", "improving", "verifying"]);
const EXECUTION_TARGETS = new Set(["main-thread", "web-worker"]);
const RUNTIMES = new Set(["javascript", "webassembly", "hybrid"]);
const QUALITIES = new Set(["first-found", "bounded", "optimal"]);
const OPTIMALITIES = new Set(["unknown", "proven"]);
const UNSOLVED_REASONS = new Set([
  "exhausted",
  "limit-reached",
  "unsupported",
]);

function issue(issues: Issues, path: string, message: string): false {
  issues.push({ path, message });
  return false;
}

export function isRecord(value: unknown): value is UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function checkRecord(
  value: unknown,
  path: string,
  issues: Issues,
): value is UnknownRecord {
  return isRecord(value) || issue(issues, path, "must be a plain object");
}

function checkExactKeys(
  value: UnknownRecord,
  allowed: readonly string[],
  path: string,
  issues: Issues,
): boolean {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  return (
    unknown.length === 0 ||
    issue(issues, path, `contains unknown field(s): ${unknown.join(", ")}`)
  );
}

function checkNonEmptyString(
  value: unknown,
  path: string,
  issues: Issues,
): value is string {
  return (
    (typeof value === "string" && value.trim().length > 0) ||
    issue(issues, path, "must be a non-empty string")
  );
}

function checkFiniteNonNegative(
  value: unknown,
  path: string,
  issues: Issues,
): value is number {
  return (
    (typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0) ||
    issue(issues, path, "must be a finite non-negative number")
  );
}

function checkNonNegativeInteger(
  value: unknown,
  path: string,
  issues: Issues,
): value is number {
  return (
    (typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0) ||
    issue(issues, path, "must be a non-negative safe integer")
  );
}

function checkPositiveInteger(
  value: unknown,
  path: string,
  issues: Issues,
): value is number {
  return (
    (typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value > 0) ||
    issue(issues, path, "must be a positive safe integer")
  );
}

function checkEnum(
  value: unknown,
  values: ReadonlySet<string>,
  path: string,
  issues: Issues,
): value is string {
  return (
    (typeof value === "string" && values.has(value)) ||
    issue(issues, path, `must be one of: ${[...values].join(", ")}`)
  );
}

function checkPosition(
  value: unknown,
  path: string,
  issues: Issues,
): value is Position {
  if (!checkRecord(value, path, issues)) return false;
  let valid = checkExactKeys(value, ["row", "column"], path, issues);
  valid = checkNonNegativeInteger(value.row, `${path}.row`, issues) && valid;
  valid =
    checkNonNegativeInteger(value.column, `${path}.column`, issues) && valid;
  return valid;
}

function isPositionInBoard(position: Position, board: ParsedBoard): boolean {
  return position.row < board.height && position.column < board.width;
}

function checkPositionArray(
  value: unknown,
  path: string,
  issues: Issues,
): value is readonly Position[] {
  if (!Array.isArray(value)) return issue(issues, path, "must be an array");
  let valid = true;
  for (const [index, position] of value.entries()) {
    valid = checkPosition(position, `${path}[${index}]`, issues) && valid;
  }
  return valid;
}

function checkLabel(
  value: unknown,
  path: string,
  issues: Issues,
): value is string {
  return (
    (typeof value === "string" && /^[A-Z]$/.test(value)) ||
    issue(issues, path, "must be one uppercase box/goal label")
  );
}

function checkBox(
  value: unknown,
  path: string,
  issues: Issues,
): value is Box {
  if (!checkRecord(value, path, issues)) return false;
  let valid = checkExactKeys(value, ["id", "label", "position"], path, issues);
  valid = checkNonEmptyString(value.id, `${path}.id`, issues) && valid;
  valid = checkLabel(value.label, `${path}.label`, issues) && valid;
  valid = checkPosition(value.position, `${path}.position`, issues) && valid;
  return valid;
}

function checkGoal(
  value: unknown,
  path: string,
  issues: Issues,
): value is Goal {
  if (!checkRecord(value, path, issues)) return false;
  let valid = checkExactKeys(value, ["label", "position"], path, issues);
  valid = checkLabel(value.label, `${path}.label`, issues) && valid;
  valid = checkPosition(value.position, `${path}.position`, issues) && valid;
  return valid;
}

function checkBoxArray(
  value: unknown,
  path: string,
  issues: Issues,
): value is readonly Box[] {
  if (!Array.isArray(value)) return issue(issues, path, "must be an array");
  let valid = true;
  for (const [index, box] of value.entries()) {
    valid = checkBox(box, `${path}[${index}]`, issues) && valid;
  }
  return valid;
}

function checkGoalArray(
  value: unknown,
  path: string,
  issues: Issues,
): value is readonly Goal[] {
  if (!Array.isArray(value)) return issue(issues, path, "must be an array");
  let valid = true;
  for (const [index, goal] of value.entries()) {
    valid = checkGoal(goal, `${path}[${index}]`, issues) && valid;
  }
  return valid;
}

function reportDuplicatePositions(
  positions: readonly Position[],
  path: string,
  issues: Issues,
): boolean {
  const seen = new Set<string>();
  for (const position of positions) {
    const key = positionKey(position);
    if (seen.has(key)) {
      return issue(issues, path, `contains duplicate position ${key}`);
    }
    seen.add(key);
  }
  return true;
}

function labelsMatch(
  boxes: readonly Box[],
  goals: readonly Goal[],
): boolean {
  const boxCounts = new Map<string, number>();
  const goalCounts = new Map<string, number>();
  for (const box of boxes) {
    boxCounts.set(box.label, (boxCounts.get(box.label) ?? 0) + 1);
  }
  for (const goal of goals) {
    goalCounts.set(goal.label, (goalCounts.get(goal.label) ?? 0) + 1);
  }
  if (boxCounts.size !== goalCounts.size) return false;
  return [...boxCounts].every(
    ([label, count]) => goalCounts.get(label) === count,
  );
}

function boxesAreSolved(
  boxes: readonly Box[],
  goals: readonly Goal[],
): boolean {
  const goalByPosition = new Map(
    goals.map((goal) => [positionKey(goal.position), goal.label]),
  );
  return boxes.every(
    (box) => goalByPosition.get(positionKey(box.position)) === box.label,
  );
}

function checkBoard(
  value: unknown,
  path: string,
  issues: Issues,
): value is ParsedBoard {
  if (!checkRecord(value, path, issues)) return false;
  let valid = checkExactKeys(
    value,
    [
      "width",
      "height",
      "rows",
      "walls",
      "floor",
      "goals",
      "initialRobot",
      "initialBoxes",
    ],
    path,
    issues,
  );
  valid = checkPositiveInteger(value.width, `${path}.width`, issues) && valid;
  valid = checkPositiveInteger(value.height, `${path}.height`, issues) && valid;

  if (!Array.isArray(value.rows)) {
    valid = issue(issues, `${path}.rows`, "must be an array") && valid;
  } else {
    for (const [index, row] of value.rows.entries()) {
      if (typeof row !== "string") {
        valid =
          issue(issues, `${path}.rows[${index}]`, "must be a string") && valid;
      }
    }
  }
  valid = checkPositionArray(value.walls, `${path}.walls`, issues) && valid;
  valid = checkPositionArray(value.floor, `${path}.floor`, issues) && valid;
  valid = checkGoalArray(value.goals, `${path}.goals`, issues) && valid;
  valid =
    checkPosition(value.initialRobot, `${path}.initialRobot`, issues) && valid;
  valid =
    checkBoxArray(value.initialBoxes, `${path}.initialBoxes`, issues) && valid;
  if (!valid) return false;

  const board = value as unknown as ParsedBoard;
  if (board.rows.length !== board.height) {
    valid =
      issue(
        issues,
        `${path}.rows`,
        `must contain exactly ${board.height} rows`,
      ) && valid;
  }
  for (const [index, row] of board.rows.entries()) {
    if (row.length !== board.width) {
      valid =
        issue(
          issues,
          `${path}.rows[${index}]`,
          `must contain exactly ${board.width} columns`,
        ) && valid;
    }
  }

  const walls = new Set(board.walls.map(positionKey));
  const floor = new Set(board.floor.map(positionKey));
  valid =
    reportDuplicatePositions(board.walls, `${path}.walls`, issues) && valid;
  valid =
    reportDuplicatePositions(board.floor, `${path}.floor`, issues) && valid;
  for (const [collection, positions] of [
    ["walls", board.walls],
    ["floor", board.floor],
  ] as const) {
    for (const position of positions) {
      if (!isPositionInBoard(position, board)) {
        valid =
          issue(
            issues,
            `${path}.${collection}`,
            `position ${positionKey(position)} is outside the board`,
          ) && valid;
      }
    }
  }

  for (let row = 0; row < board.height; row += 1) {
    for (let column = 0; column < board.width; column += 1) {
      const key = `${row},${column}`;
      const expectedWall = board.rows[row]?.[column] === "O";
      if (walls.has(key) !== expectedWall || floor.has(key) === expectedWall) {
        valid =
          issue(
            issues,
            path,
            `walls/floor do not match row geometry at ${key}`,
          ) && valid;
      }
    }
  }

  const dynamicPositions = [
    board.initialRobot,
    ...board.initialBoxes.map((box) => box.position),
    ...board.goals.map((goal) => goal.position),
  ];
  for (const position of dynamicPositions) {
    if (!isPositionInBoard(position, board) || !floor.has(positionKey(position))) {
      valid =
        issue(
          issues,
          path,
          `dynamic position ${positionKey(position)} must be on floor`,
        ) && valid;
    }
  }
  valid =
    reportDuplicatePositions(
      board.initialBoxes.map((box) => box.position),
      `${path}.initialBoxes`,
      issues,
    ) && valid;
  valid =
    reportDuplicatePositions(
      board.goals.map((goal) => goal.position),
      `${path}.goals`,
      issues,
    ) && valid;

  const boxIds = new Set(board.initialBoxes.map((box) => box.id));
  if (boxIds.size !== board.initialBoxes.length) {
    valid =
      issue(issues, `${path}.initialBoxes`, "box ids must be unique") && valid;
  }
  if (
    board.initialBoxes.some(
      (box) => positionKey(box.position) === positionKey(board.initialRobot),
    )
  ) {
    valid =
      issue(
        issues,
        `${path}.initialRobot`,
        "must not overlap an initial box",
      ) && valid;
  }
  if (!labelsMatch(board.initialBoxes, board.goals)) {
    valid =
      issue(
        issues,
        path,
        "initial box labels and goal labels must have equal counts",
      ) && valid;
  }
  return valid;
}

function checkSnapshot(
  value: unknown,
  board: ParsedBoard | undefined,
  path: string,
  issues: Issues,
): value is GameSnapshot {
  if (!checkRecord(value, path, issues)) return false;
  let valid = checkExactKeys(
    value,
    ["puzzleId", "robot", "boxes", "moves", "pushes", "solved"],
    path,
    issues,
  );
  valid =
    checkNonEmptyString(value.puzzleId, `${path}.puzzleId`, issues) && valid;
  valid = checkPosition(value.robot, `${path}.robot`, issues) && valid;
  valid = checkBoxArray(value.boxes, `${path}.boxes`, issues) && valid;
  valid =
    checkNonNegativeInteger(value.moves, `${path}.moves`, issues) && valid;
  valid =
    checkNonNegativeInteger(value.pushes, `${path}.pushes`, issues) && valid;
  if (typeof value.solved !== "boolean") {
    valid = issue(issues, `${path}.solved`, "must be a boolean") && valid;
  }
  if (!valid || !board) return valid;

  const snapshot = value as unknown as GameSnapshot;
  const floor = new Set(board.floor.map(positionKey));
  if (
    !isPositionInBoard(snapshot.robot, board) ||
    !floor.has(positionKey(snapshot.robot))
  ) {
    valid =
      issue(issues, `${path}.robot`, "must be on board floor") && valid;
  }
  if (snapshot.pushes > snapshot.moves) {
    valid =
      issue(issues, `${path}.pushes`, "must not exceed moves") && valid;
  }
  if (snapshot.boxes.length !== board.initialBoxes.length) {
    valid =
      issue(
        issues,
        `${path}.boxes`,
        `must contain exactly ${board.initialBoxes.length} boxes`,
      ) && valid;
  }

  const initialById = new Map(
    board.initialBoxes.map((box) => [box.id, box.label]),
  );
  const ids = new Set<string>();
  for (const box of snapshot.boxes) {
    if (initialById.get(box.id) !== box.label) {
      valid =
        issue(
          issues,
          `${path}.boxes`,
          `box ${box.id} does not match initial board identity`,
        ) && valid;
    }
    if (ids.has(box.id)) {
      valid =
        issue(issues, `${path}.boxes`, `duplicate box id ${box.id}`) && valid;
    }
    ids.add(box.id);
    if (
      !isPositionInBoard(box.position, board) ||
      !floor.has(positionKey(box.position))
    ) {
      valid =
        issue(
          issues,
          `${path}.boxes`,
          `box ${box.id} must be on board floor`,
        ) && valid;
    }
  }
  valid =
    reportDuplicatePositions(
      snapshot.boxes.map((box) => box.position),
      `${path}.boxes`,
      issues,
    ) && valid;
  if (
    snapshot.boxes.some(
      (box) => positionKey(box.position) === positionKey(snapshot.robot),
    )
  ) {
    valid =
      issue(issues, `${path}.robot`, "must not overlap a box") && valid;
  }
  if (snapshot.solved !== boxesAreSolved(snapshot.boxes, board.goals)) {
    valid =
      issue(
        issues,
        `${path}.solved`,
        "must agree with box and goal positions",
      ) && valid;
  }
  return valid;
}

function checkObjective(
  value: unknown,
  path: string,
  issues: Issues,
): value is SolverObjective {
  if (!checkRecord(value, path, issues)) return false;
  let valid = checkExactKeys(value, ["kind"], path, issues);
  valid =
    checkEnum(value.kind, OBJECTIVE_KINDS, `${path}.kind`, issues) && valid;
  return valid;
}

function checkLimits(
  value: unknown,
  path: string,
  issues: Issues,
): value is SolverLimits {
  if (!checkRecord(value, path, issues)) return false;
  let valid = checkExactKeys(
    value,
    [
      "maxElapsedMs",
      "maxExpandedStates",
      "maxGeneratedStates",
      "maxMemoryBytes",
    ],
    path,
    issues,
  );
  for (const key of [
    "maxElapsedMs",
    "maxExpandedStates",
    "maxGeneratedStates",
    "maxMemoryBytes",
  ] as const) {
    if (value[key] !== undefined) {
      valid =
        checkPositiveInteger(value[key], `${path}.${key}`, issues) && valid;
    }
  }
  return valid;
}

function checkJsonValue(
  value: unknown,
  path: string,
  issues: Issues,
  ancestors: ReadonlySet<object>,
  depth: number,
): boolean {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return (
      Number.isFinite(value) ||
      issue(issues, path, "JSON numbers must be finite")
    );
  }
  if (depth > 64) return issue(issues, path, "exceeds maximum nesting depth");
  if (typeof value !== "object" || value === null) {
    return issue(issues, path, "must be JSON-safe");
  }
  if (ancestors.has(value)) return issue(issues, path, "must not be cyclic");

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  let valid = true;
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      valid =
        checkJsonValue(
          child,
          `${path}[${index}]`,
          issues,
          nextAncestors,
          depth + 1,
        ) && valid;
    }
    return valid;
  }
  if (!isRecord(value)) return issue(issues, path, "must be a plain object");
  for (const [key, child] of Object.entries(value)) {
    valid =
      checkJsonValue(
        child,
        `${path}.${key}`,
        issues,
        nextAncestors,
        depth + 1,
      ) && valid;
  }
  return valid;
}

function checkOptions(
  value: unknown,
  path: string,
  issues: Issues,
): value is SolverOptions {
  if (!checkRecord(value, path, issues)) return false;
  return checkJsonValue(value, path, issues, new Set(), 0);
}

function checkStep(
  value: unknown,
  path: string,
  issues: Issues,
): value is SolutionStep {
  if (!checkRecord(value, path, issues)) return false;
  let valid = checkExactKeys(value, ["direction", "kind"], path, issues);
  valid =
    checkEnum(value.direction, new Set(DIRECTIONS), `${path}.direction`, issues) &&
    valid;
  valid =
    checkEnum(value.kind, new Set(["walk", "push"]), `${path}.kind`, issues) &&
    valid;
  return valid;
}

export function scoreSolverObjective(
  _objective: SolverObjective,
  moves: number,
): number {
  return moves;
}

function checkSolution(
  value: unknown,
  path: string,
  issues: Issues,
): value is SolverSolution {
  if (!checkRecord(value, path, issues)) return false;
  let valid = checkExactKeys(
    value,
    [
      "steps",
      "moves",
      "pushes",
      "objective",
      "objectiveScore",
      "optimality",
    ],
    path,
    issues,
  );
  if (!Array.isArray(value.steps)) {
    valid = issue(issues, `${path}.steps`, "must be an array") && valid;
  } else {
    for (const [index, step] of value.steps.entries()) {
      valid = checkStep(step, `${path}.steps[${index}]`, issues) && valid;
    }
  }
  valid =
    checkNonNegativeInteger(value.moves, `${path}.moves`, issues) && valid;
  valid =
    checkNonNegativeInteger(value.pushes, `${path}.pushes`, issues) && valid;
  valid = checkObjective(value.objective, `${path}.objective`, issues) && valid;
  valid =
    checkFiniteNonNegative(
      value.objectiveScore,
      `${path}.objectiveScore`,
      issues,
    ) && valid;
  valid =
    checkEnum(
      value.optimality,
      OPTIMALITIES,
      `${path}.optimality`,
      issues,
    ) && valid;
  if (!valid) return false;

  const solution = value as unknown as SolverSolution;
  const declaredPushes = solution.steps.filter(
    (step) => step.kind === "push",
  ).length;
  if (solution.moves !== solution.steps.length) {
    valid =
      issue(issues, `${path}.moves`, "must equal the number of steps") &&
      valid;
  }
  if (solution.pushes !== declaredPushes) {
    valid =
      issue(
        issues,
        `${path}.pushes`,
        "must equal the number of declared push steps",
      ) && valid;
  }
  const expectedScore = scoreSolverObjective(
    solution.objective,
    solution.moves,
  );
  if (solution.objectiveScore !== expectedScore) {
    valid =
      issue(
        issues,
        `${path}.objectiveScore`,
        `must equal the objective score ${expectedScore}`,
      ) && valid;
  }
  return valid;
}

function checkMetrics(
  value: unknown,
  path: string,
  issues: Issues,
): value is SolverRunMetrics {
  if (!checkRecord(value, path, issues)) return false;
  let valid = checkExactKeys(
    value,
    [
      "elapsedMs",
      "expandedStates",
      "generatedStates",
      "peakFrontierSize",
      "counters",
    ],
    path,
    issues,
  );
  valid =
    checkFiniteNonNegative(value.elapsedMs, `${path}.elapsedMs`, issues) &&
    valid;
  for (const key of [
    "expandedStates",
    "generatedStates",
    "peakFrontierSize",
  ] as const) {
    if (value[key] !== undefined) {
      valid =
        checkNonNegativeInteger(value[key], `${path}.${key}`, issues) && valid;
    }
  }
  if (value.counters !== undefined) {
    if (!checkRecord(value.counters, `${path}.counters`, issues)) {
      valid = false;
    } else {
      for (const [key, counter] of Object.entries(value.counters)) {
        valid =
          checkFiniteNonNegative(counter, `${path}.counters.${key}`, issues) &&
          valid;
      }
    }
  }
  return valid;
}

function checkMetadata(
  value: unknown,
  path: string,
  issues: Issues,
): value is SolverMetadata {
  if (!checkRecord(value, path, issues)) return false;
  let valid = checkExactKeys(
    value,
    ["id", "displayName", "description", "version", "capabilities"],
    path,
    issues,
  );
  valid = checkNonEmptyString(value.id, `${path}.id`, issues) && valid;
  if (typeof value.id === "string" && !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value.id)) {
    valid = issue(issues, `${path}.id`, "must be lowercase and URL-safe") && valid;
  }
  valid =
    checkNonEmptyString(value.displayName, `${path}.displayName`, issues) &&
    valid;
  valid =
    checkNonEmptyString(value.description, `${path}.description`, issues) &&
    valid;
  valid =
    checkNonEmptyString(value.version, `${path}.version`, issues) && valid;
  if (!checkRecord(value.capabilities, `${path}.capabilities`, issues)) {
    return false;
  }
  const capabilities = value.capabilities;
  valid =
    checkExactKeys(
      capabilities,
      [
        "executionTargets",
        "runtime",
        "objectives",
        "quality",
        "labeledBoxes",
        "genericBoxes",
        "partialState",
        "reportsProgress",
        "cooperativeCancellation",
        "deterministic",
      ],
      `${path}.capabilities`,
      issues,
    ) && valid;
  if (
    !Array.isArray(capabilities.executionTargets) ||
    capabilities.executionTargets.length === 0
  ) {
    valid =
      issue(
        issues,
        `${path}.capabilities.executionTargets`,
        "must be a non-empty array",
      ) && valid;
  } else {
    for (const [index, target] of capabilities.executionTargets.entries()) {
      valid =
        checkEnum(
          target,
          EXECUTION_TARGETS,
          `${path}.capabilities.executionTargets[${index}]`,
          issues,
        ) && valid;
    }
  }
  valid =
    checkEnum(
      capabilities.runtime,
      RUNTIMES,
      `${path}.capabilities.runtime`,
      issues,
    ) && valid;
  if (
    !Array.isArray(capabilities.objectives) ||
    capabilities.objectives.length === 0
  ) {
    valid =
      issue(
        issues,
        `${path}.capabilities.objectives`,
        "must be a non-empty array",
      ) && valid;
  } else {
    for (const [index, objective] of capabilities.objectives.entries()) {
      valid =
        checkEnum(
          objective,
          OBJECTIVE_KINDS,
          `${path}.capabilities.objectives[${index}]`,
          issues,
        ) && valid;
    }
  }
  valid =
    checkEnum(
      capabilities.quality,
      QUALITIES,
      `${path}.capabilities.quality`,
      issues,
    ) && valid;
  for (const key of [
    "labeledBoxes",
    "genericBoxes",
    "partialState",
    "reportsProgress",
    "cooperativeCancellation",
    "deterministic",
  ] as const) {
    if (typeof capabilities[key] !== "boolean") {
      valid =
        issue(
          issues,
          `${path}.capabilities.${key}`,
          "must be a boolean",
        ) && valid;
    }
  }
  return valid;
}

function collectRequestIssues(value: unknown): Issues {
  const issues: Issues = [];
  if (!checkRecord(value, "request", issues)) return issues;
  let valid = checkExactKeys(
    value,
    ["board", "snapshot", "objective", "limits", "options"],
    "request",
    issues,
  );
  const boardValid = checkBoard(value.board, "request.board", issues);
  valid = boardValid && valid;
  valid =
    checkSnapshot(
      value.snapshot,
      boardValid ? (value.board as ParsedBoard) : undefined,
      "request.snapshot",
      issues,
    ) && valid;
  valid =
    checkObjective(value.objective, "request.objective", issues) && valid;
  if (value.limits !== undefined) {
    valid = checkLimits(value.limits, "request.limits", issues) && valid;
  }
  if (value.options !== undefined) {
    valid = checkOptions(value.options, "request.options", issues) && valid;
  }
  void valid;
  return issues;
}

function collectProgressIssues(value: unknown): Issues {
  const issues: Issues = [];
  if (!checkRecord(value, "progress", issues)) return issues;
  let valid = checkExactKeys(
    value,
    [
      "phase",
      "elapsedMs",
      "expandedStates",
      "generatedStates",
      "frontierSize",
      "counters",
      "fraction",
      "incumbent",
      "detail",
    ],
    "progress",
    issues,
  );
  valid = checkEnum(value.phase, PHASES, "progress.phase", issues) && valid;
  valid =
    checkFiniteNonNegative(value.elapsedMs, "progress.elapsedMs", issues) &&
    valid;
  for (const key of [
    "expandedStates",
    "generatedStates",
    "frontierSize",
  ] as const) {
    if (value[key] !== undefined) {
      valid =
        checkNonNegativeInteger(value[key], `progress.${key}`, issues) && valid;
    }
  }
  if (value.counters !== undefined) {
    if (!checkRecord(value.counters, "progress.counters", issues)) {
      valid = false;
    } else {
      for (const [key, counter] of Object.entries(value.counters)) {
        valid =
          checkFiniteNonNegative(
            counter,
            `progress.counters.${key}`,
            issues,
          ) && valid;
      }
    }
  }
  if (value.fraction !== undefined) {
    const fraction = value.fraction;
    const fractionValid = checkFiniteNonNegative(
      fraction,
      "progress.fraction",
      issues,
    );
    valid = fractionValid && valid;
    if (fractionValid && fraction > 1) {
      valid =
        issue(issues, "progress.fraction", "must not exceed 1") && valid;
    }
  }
  if (value.incumbent !== undefined) {
    if (!checkRecord(value.incumbent, "progress.incumbent", issues)) {
      valid = false;
    } else {
      valid =
        checkExactKeys(
          value.incumbent,
          ["moves", "pushes", "objectiveScore"],
          "progress.incumbent",
          issues,
        ) && valid;
      valid =
        checkNonNegativeInteger(
          value.incumbent.moves,
          "progress.incumbent.moves",
          issues,
        ) && valid;
      valid =
        checkNonNegativeInteger(
          value.incumbent.pushes,
          "progress.incumbent.pushes",
          issues,
        ) && valid;
      valid =
        checkFiniteNonNegative(
          value.incumbent.objectiveScore,
          "progress.incumbent.objectiveScore",
          issues,
        ) && valid;
    }
  }
  if (value.detail !== undefined && typeof value.detail !== "string") {
    valid = issue(issues, "progress.detail", "must be a string") && valid;
  }
  void valid;
  return issues;
}

function collectSolutionIssues(value: unknown): Issues {
  const issues: Issues = [];
  checkSolution(value, "solution", issues);
  return issues;
}

function collectResultIssues(value: unknown): Issues {
  const issues: Issues = [];
  if (!checkRecord(value, "result", issues)) return issues;
  if (!checkEnum(
    value.status,
    new Set(["solved", "unsolved", "cancelled"]),
    "result.status",
    issues,
  )) {
    return issues;
  }

  if (value.status === "solved") {
    let valid = checkExactKeys(
      value,
      ["status", "solution", "metrics"],
      "result",
      issues,
    );
    valid = checkSolution(value.solution, "result.solution", issues) && valid;
    valid = checkMetrics(value.metrics, "result.metrics", issues) && valid;
    void valid;
    return issues;
  }
  if (value.status === "unsolved") {
    let valid = checkExactKeys(
      value,
      ["status", "reason", "metrics", "detail"],
      "result",
      issues,
    );
    valid =
      checkEnum(value.reason, UNSOLVED_REASONS, "result.reason", issues) &&
      valid;
    valid = checkMetrics(value.metrics, "result.metrics", issues) && valid;
    if (value.detail !== undefined && typeof value.detail !== "string") {
      valid = issue(issues, "result.detail", "must be a string") && valid;
    }
    void valid;
    return issues;
  }

  let valid = checkExactKeys(
    value,
    ["status", "metrics"],
    "result",
    issues,
  );
  valid = checkMetrics(value.metrics, "result.metrics", issues) && valid;
  void valid;
  return issues;
}

function collectMetadataIssues(value: unknown): Issues {
  const issues: Issues = [];
  checkMetadata(value, "metadata", issues);
  return issues;
}

function isValid(issues: Issues): issues is [] {
  return issues.length === 0;
}

export function getSolverRequestValidationIssues(
  value: unknown,
): readonly SolverValidationIssue[] {
  return Object.freeze(collectRequestIssues(value));
}

export function isSolverRequest(value: unknown): value is SolverRequest {
  return isValid(collectRequestIssues(value));
}

export function assertValidSolverRequest(
  value: unknown,
): asserts value is SolverRequest {
  const issues = collectRequestIssues(value);
  if (!isValid(issues)) throw new SolverValidationError("Solver request", issues);
}

export function isSolverProgress(value: unknown): value is SolverProgress {
  return isValid(collectProgressIssues(value));
}

export function assertValidSolverProgress(
  value: unknown,
): asserts value is SolverProgress {
  const issues = collectProgressIssues(value);
  if (!isValid(issues)) {
    throw new SolverValidationError("Solver progress", issues);
  }
}

export function isSolverSolution(value: unknown): value is SolverSolution {
  return isValid(collectSolutionIssues(value));
}

export function assertValidSolverSolution(
  value: unknown,
): asserts value is SolverSolution {
  const issues = collectSolutionIssues(value);
  if (!isValid(issues)) {
    throw new SolverValidationError("Solver solution", issues);
  }
}

export function isSolverResult(value: unknown): value is SolverResult {
  return isValid(collectResultIssues(value));
}

export function assertValidSolverResult(
  value: unknown,
): asserts value is SolverResult {
  const issues = collectResultIssues(value);
  if (!isValid(issues)) throw new SolverValidationError("Solver result", issues);
}

export function isSolverMetadata(value: unknown): value is SolverMetadata {
  return isValid(collectMetadataIssues(value));
}

export function assertValidSolverMetadata(
  value: unknown,
): asserts value is SolverMetadata {
  const issues = collectMetadataIssues(value);
  if (!isValid(issues)) {
    throw new SolverValidationError("Solver metadata", issues);
  }
}
