import type { Difficulty, PuzzleDefinition } from "@/src/core/model";

export interface EditorState {
  readonly width: number;
  readonly height: number;
  readonly cells: readonly (readonly string[])[];
  readonly title: string;
  readonly difficulty: Difficulty;
  readonly hint: string;
  readonly selectedTool: string;
}

export type EditorAction =
  | { type: "set-cell"; row: number; column: number }
  | { type: "resize"; width: number; height: number }
  | { type: "set-title"; title: string }
  | { type: "set-difficulty"; difficulty: Difficulty }
  | { type: "set-hint"; hint: string }
  | { type: "set-tool"; tool: string }
  | { type: "clear" }
  | { type: "load"; puzzle: PuzzleDefinition };

const WALL = "O";
const FLOOR = " ";
const ROBOT = "R";

export const TYPED_LABELS = [
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "I",
  "J",
  "K",
  "L",
  "M",
  "N",
  "P",
  "Q",
  "T",
  "U",
  "V",
  "W",
  "Y",
  "Z",
] as const;

export type TypedLabel = (typeof TYPED_LABELS)[number];

export const EDITOR_TOOLS = [
  { symbol: "O", label: "Wall", group: "terrain" },
  { symbol: " ", label: "Floor", group: "terrain" },
  { symbol: "R", label: "Robot", group: "pieces" },
  { symbol: "X", label: "Generic box", group: "pieces" },
  { symbol: "S", label: "Generic goal", group: "pieces" },
] as const;

export const MIN_SIZE = 3;
export const MAX_SIZE = 20;

function createEmptyGrid(width: number, height: number): string[][] {
  return Array.from({ length: height }, () => Array<string>(width).fill(WALL));
}

function cloneGrid(cells: readonly (readonly string[])[]): string[][] {
  return cells.map((row) => [...row]);
}

function removeRobot(cells: string[][]): void {
  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < cells[r].length; c++) {
      if (cells[r][c] === ROBOT) cells[r][c] = FLOOR;
    }
  }
}

export function isTypedBoxSymbol(symbol: string): symbol is TypedLabel {
  return (TYPED_LABELS as readonly string[]).includes(symbol);
}

export function isTypedGoalSymbol(symbol: string): boolean {
  return (
    symbol.length === 1 &&
    (TYPED_LABELS as readonly string[]).includes(symbol.toUpperCase()) &&
    symbol === symbol.toLowerCase()
  );
}

export function createInitialState(): EditorState {
  return {
    width: 7,
    height: 7,
    cells: createEmptyGrid(7, 7),
    title: "Untitled",
    difficulty: "beginner",
    hint: "",
    selectedTool: WALL,
  };
}

export function editorReducer(
  state: EditorState,
  action: EditorAction,
): EditorState {
  switch (action.type) {
    case "set-cell": {
      const { row, column } = action;
      if (row < 0 || row >= state.height || column < 0 || column >= state.width)
        return state;
      if (state.cells[row][column] === state.selectedTool) return state;
      const cells = cloneGrid(state.cells);
      if (state.selectedTool === ROBOT) removeRobot(cells);
      cells[row][column] = state.selectedTool;
      return { ...state, cells };
    }

    case "resize": {
      const width = Math.max(MIN_SIZE, Math.min(MAX_SIZE, action.width));
      const height = Math.max(MIN_SIZE, Math.min(MAX_SIZE, action.height));
      if (width === state.width && height === state.height) return state;
      const cells = createEmptyGrid(width, height);
      for (let r = 0; r < Math.min(height, state.height); r++) {
        for (let c = 0; c < Math.min(width, state.width); c++) {
          cells[r][c] = state.cells[r][c];
        }
      }
      return { ...state, width, height, cells };
    }

    case "set-title":
      return { ...state, title: action.title };

    case "set-difficulty":
      return { ...state, difficulty: action.difficulty };

    case "set-hint":
      return { ...state, hint: action.hint };

    case "set-tool":
      return { ...state, selectedTool: action.tool };

    case "clear":
      return {
        ...state,
        cells: createEmptyGrid(state.width, state.height),
      };

    case "load": {
      const { puzzle } = action;
      const rows = puzzle.rows;
      const height = rows.length;
      const width = Math.max(...rows.map((r) => [...r].length));
      const cells: string[][] = [];
      for (let r = 0; r < height; r++) {
        const symbols = [...rows[r]];
        const row: string[] = [];
        for (let c = 0; c < width; c++) {
          row.push(c < symbols.length ? symbols[c] : WALL);
        }
        cells.push(row);
      }
      return {
        ...state,
        width,
        height,
        cells,
        title: puzzle.title,
        difficulty: puzzle.difficulty,
        hint: puzzle.hint ?? "",
        selectedTool: state.selectedTool,
      };
    }
  }
}

export function stateToRows(state: EditorState): string[] {
  return state.cells.map((row) => row.join(""));
}

export function stateToPuzzle(state: EditorState): PuzzleDefinition {
  const rows = stateToRows(state);
  let boxes = 0;
  for (const row of state.cells) {
    for (const cell of row) {
      if (cell === "X" || isTypedBoxSymbol(cell)) {
        boxes++;
      }
    }
  }
  return {
    id: `custom-${Date.now()}`,
    title: state.title,
    difficulty: state.difficulty,
    boxes,
    hint: state.hint || undefined,
    rows,
  };
}

export interface EditorValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export function validateEditorState(state: EditorState): EditorValidation {
  const errors: string[] = [];

  let robotCount = 0;
  const boxCounts = new Map<string, number>();
  const goalCounts = new Map<string, number>();

  for (const row of state.cells) {
    for (const cell of row) {
      if (cell === ROBOT) robotCount++;
      if (cell === "X") boxCounts.set("X", (boxCounts.get("X") ?? 0) + 1);
      if (cell === "S") goalCounts.set("S", (goalCounts.get("S") ?? 0) + 1);
      if (isTypedBoxSymbol(cell)) {
        boxCounts.set(cell, (boxCounts.get(cell) ?? 0) + 1);
      }
      if (isTypedGoalSymbol(cell)) {
        goalCounts.set(cell.toUpperCase(), (goalCounts.get(cell.toUpperCase()) ?? 0) + 1);
      }
    }
  }

  if (robotCount === 0) errors.push("Place a robot (R) on the board.");
  if (robotCount > 1) errors.push("Only one robot allowed.");

  const totalBoxes = [...boxCounts.values()].reduce((a, b) => a + b, 0);
  const totalGoals = [...goalCounts.values()].reduce((a, b) => a + b, 0);
  if (totalBoxes === 0) errors.push("Place at least one box.");
  if (totalGoals === 0) errors.push("Place at least one goal.");

  const genericBoxes = boxCounts.get("X") ?? 0;
  const genericGoals = goalCounts.get("S") ?? 0;
  if (genericBoxes !== genericGoals) {
    errors.push(`Generic box/goal mismatch: ${genericBoxes} boxes, ${genericGoals} goals.`);
  }

  for (const [label, count] of boxCounts) {
    if (label === "X") continue;
    const goalCount = goalCounts.get(label) ?? 0;
    if (count !== goalCount) {
      errors.push(`Label ${label}: ${count} boxes but ${goalCount} goals.`);
    }
  }

  for (const [label, count] of goalCounts) {
    if (label === "S" || label === "X") continue;
    if (!boxCounts.has(label)) {
      errors.push(`Label ${label}: ${count} goals but no boxes.`);
    }
  }

  if (!state.title.trim()) errors.push("Give your puzzle a title.");

  return { valid: errors.length === 0, errors };
}
