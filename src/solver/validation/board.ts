import {
  positionKey,
  type Box,
  type GameSnapshot,
  type Goal,
  type ParsedBoard,
  type Position,
} from "../../core/index.ts";
import {
  checkExactKeys,
  checkNonEmptyString,
  checkNonNegativeInteger,
  checkPositiveInteger,
  checkRecord,
  issue,
  type Issues,
} from "./common.ts";

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

export function checkBoard(
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

export function checkSnapshot(
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

