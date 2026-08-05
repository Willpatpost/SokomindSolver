import {
  DIFFICULTIES,
  type Box,
  type Goal,
  type ParsedBoard,
  type Position,
  type PuzzleDefinition,
  type PuzzleValidationIssue,
  type PuzzleValidationResult,
} from "./model.ts";
import { freezeBox, freezePosition } from "./position.ts";

export const WALL = "O";
const ROBOT = "R";
const GENERIC_BOX = "X";
const GENERIC_GOAL = "S";
const SUPPORTED_SYMBOL = /^[A-Za-z ORSX]$/;

interface RowAnalysis {
  readonly errors: PuzzleValidationIssue[];
  readonly width: number;
  readonly height: number;
  readonly robotCount: number;
  readonly boxCounts: ReadonlyMap<string, number>;
  readonly goalCounts: ReadonlyMap<string, number>;
  readonly totalBoxes: number;
}

export class PuzzleValidationError extends Error {
  readonly issues: readonly PuzzleValidationIssue[];

  constructor(issues: readonly PuzzleValidationIssue[]) {
    super(issues.map((issue) => issue.message).join(" "));
    this.name = "PuzzleValidationError";
    this.issues = Object.freeze([...issues]);
  }
}

function issue(
  code: PuzzleValidationIssue["code"],
  message: string,
  row?: number,
  column?: number,
): PuzzleValidationIssue {
  return Object.freeze({
    code,
    message,
    ...(row === undefined ? {} : { row }),
    ...(column === undefined ? {} : { column }),
  });
}

function increment(counts: Map<string, number>, label: string): void {
  counts.set(label, (counts.get(label) ?? 0) + 1);
}

function isDedicatedBox(symbol: string): boolean {
  return /^[A-Z]$/.test(symbol) && !["O", "R", "S", "X"].includes(symbol);
}

function goalLabel(symbol: string): string | undefined {
  if (symbol === GENERIC_GOAL) return GENERIC_BOX;
  if (/^[a-z]$/.test(symbol)) return symbol.toUpperCase();
  return undefined;
}

function analyzeRows(rows: unknown): RowAnalysis {
  const errors: PuzzleValidationIssue[] = [];
  const boxCounts = new Map<string, number>();
  const goalCounts = new Map<string, number>();

  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      errors: [issue("empty-board", "Puzzle must contain at least one row.")],
      width: 0,
      height: 0,
      robotCount: 0,
      boxCounts,
      goalCounts,
      totalBoxes: 0,
    };
  }

  let width = 0;
  let robotCount = 0;
  let totalBoxes = 0;

  rows.forEach((row, rowIndex) => {
    if (typeof row !== "string") {
      errors.push(
        issue("invalid-row", `Puzzle row ${rowIndex + 1} must be a string.`, rowIndex),
      );
      return;
    }

    width = Math.max(width, [...row].length);
    [...row].forEach((symbol, columnIndex) => {
      if (!SUPPORTED_SYMBOL.test(symbol) || symbol === "x") {
        errors.push(
          issue(
            "unsupported-symbol",
            `Unsupported symbol ${JSON.stringify(symbol)} at row ${rowIndex + 1}, column ${columnIndex + 1}.`,
            rowIndex,
            columnIndex,
          ),
        );
        return;
      }

      if (symbol === ROBOT) {
        robotCount += 1;
      } else if (symbol === GENERIC_BOX || isDedicatedBox(symbol)) {
        increment(boxCounts, symbol);
        totalBoxes += 1;
      } else {
        const label = goalLabel(symbol);
        if (label) increment(goalCounts, label);
      }
    });
  });

  if (width === 0) {
    errors.push(issue("empty-board", "Puzzle rows must contain at least one cell."));
  }

  if (robotCount !== 1) {
    errors.push(
      issue(
        "robot-count",
        `Puzzle must contain exactly one robot; found ${robotCount}.`,
      ),
    );
  }

  const labels = new Set([...boxCounts.keys(), ...goalCounts.keys()]);
  for (const label of [...labels].sort()) {
    const boxes = boxCounts.get(label) ?? 0;
    const goals = goalCounts.get(label) ?? 0;
    if (boxes === goals) continue;

    const description =
      label === GENERIC_BOX ? "Generic boxes/goals" : `Dedicated box ${JSON.stringify(label)}`;
    errors.push(
      issue(
        "box-goal-mismatch",
        `${description} mismatch: ${boxes} box(es), ${goals} goal(s).`,
      ),
    );
  }

  return {
    errors,
    width,
    height: rows.length,
    robotCount,
    boxCounts,
    goalCounts,
    totalBoxes,
  };
}

function validateMetadata(
  puzzle: Record<string, unknown>,
  analysis: RowAnalysis,
): PuzzleValidationIssue[] {
  const errors: PuzzleValidationIssue[] = [];

  if (typeof puzzle.id !== "string" || puzzle.id.trim() === "") {
    errors.push(issue("invalid-metadata", "Puzzle id must be a non-empty string."));
  }
  if (typeof puzzle.title !== "string" || puzzle.title.trim() === "") {
    errors.push(issue("invalid-metadata", "Puzzle title must be a non-empty string."));
  }
  if (
    typeof puzzle.difficulty !== "string" ||
    !DIFFICULTIES.includes(puzzle.difficulty as (typeof DIFFICULTIES)[number])
  ) {
    errors.push(
      issue(
        "invalid-metadata",
        `Puzzle difficulty must be one of: ${DIFFICULTIES.join(", ")}.`,
      ),
    );
  }
  if (!Number.isInteger(puzzle.boxes) || (puzzle.boxes as number) < 0) {
    errors.push(
      issue("invalid-metadata", "Puzzle boxes metadata must be a non-negative integer."),
    );
  } else if (puzzle.boxes !== analysis.totalBoxes) {
    errors.push(
      issue(
        "box-metadata-mismatch",
        `Puzzle declares ${String(puzzle.boxes)} box(es), but its rows contain ${analysis.totalBoxes}.`,
      ),
    );
  }
  if (puzzle.hint !== undefined && typeof puzzle.hint !== "string") {
    errors.push(issue("invalid-metadata", "Puzzle hint must be a string when provided."));
  }

  return errors;
}

export function validatePuzzleRows(rows: unknown): PuzzleValidationResult {
  const errors = analyzeRows(rows).errors;
  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze([...errors]),
  });
}

export function validatePuzzle(puzzle: unknown): PuzzleValidationResult {
  if (typeof puzzle !== "object" || puzzle === null || Array.isArray(puzzle)) {
    const errors = Object.freeze([
      issue("invalid-puzzle", "Puzzle must be an object."),
    ]);
    return Object.freeze({ valid: false, errors });
  }

  const candidate = puzzle as Record<string, unknown>;
  const analysis = analyzeRows(candidate.rows);
  const errors = [...analysis.errors, ...validateMetadata(candidate, analysis)];
  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze(errors),
  });
}

function freezeGoal(goal: Goal): Goal {
  return Object.freeze({
    label: goal.label,
    position: freezePosition(goal.position),
  });
}

function parsePuzzleRowsFromAnalysis(
  rows: readonly string[],
  analysis: RowAnalysis,
): ParsedBoard {
  const { width } = analysis;
  const normalizedRows = rows.map((row) => row.padEnd(width, WALL));
  const walls: Position[] = [];
  const floor: Position[] = [];
  const goals: Goal[] = [];
  const initialBoxes: Box[] = [];
  const boxIndexes = new Map<string, number>();
  let initialRobot: Position | undefined;

  normalizedRows.forEach((row, rowIndex) => {
    [...row].forEach((symbol, columnIndex) => {
      const position = { row: rowIndex, column: columnIndex };
      if (symbol === WALL) {
        walls.push(freezePosition(position));
        return;
      }

      floor.push(freezePosition(position));
      if (symbol === ROBOT) initialRobot = freezePosition(position);

      if (symbol === GENERIC_BOX || isDedicatedBox(symbol)) {
        const index = boxIndexes.get(symbol) ?? 0;
        boxIndexes.set(symbol, index + 1);
        initialBoxes.push(
          freezeBox({
            id: `${symbol}:${index}`,
            label: symbol,
            position,
          }),
        );
      }

      const label = goalLabel(symbol);
      if (label) goals.push(freezeGoal({ label, position }));
    });
  });

  if (!initialRobot) {
    throw new PuzzleValidationError([
      issue("robot-count", "Puzzle must contain exactly one robot; found 0."),
    ]);
  }

  return Object.freeze({
    width,
    height: normalizedRows.length,
    rows: Object.freeze(normalizedRows),
    walls: Object.freeze(walls),
    floor: Object.freeze(floor),
    goals: Object.freeze(goals),
    initialRobot,
    initialBoxes: Object.freeze(initialBoxes),
  });
}

/**
 * Parse row symbols into an immutable, rectangular board.
 *
 * Ragged rows are padded with walls rather than floor. This prevents accidental
 * paths through missing cells and keeps the board representation solver-ready.
 */
export function parsePuzzleRows(rows: readonly string[]): ParsedBoard {
  const analysis = analyzeRows(rows);
  if (analysis.errors.length > 0) {
    throw new PuzzleValidationError(analysis.errors);
  }
  return parsePuzzleRowsFromAnalysis(rows as readonly string[], analysis);
}

export function parsePuzzle(puzzle: PuzzleDefinition): ParsedBoard {
  if (typeof puzzle !== "object" || puzzle === null || Array.isArray(puzzle)) {
    throw new PuzzleValidationError([
      issue("invalid-puzzle", "Puzzle must be an object."),
    ]);
  }

  const analysis = analyzeRows(puzzle.rows);
  const metadataErrors = validateMetadata(
    puzzle as unknown as Record<string, unknown>,
    analysis,
  );
  const errors = [...analysis.errors, ...metadataErrors];
  if (errors.length > 0) {
    throw new PuzzleValidationError(errors);
  }
  return parsePuzzleRowsFromAnalysis(puzzle.rows, analysis);
}
