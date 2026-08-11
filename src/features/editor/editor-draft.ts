import { DIFFICULTIES } from "../../core/model.ts";
import {
  isTypedBoxSymbol,
  isTypedGoalSymbol,
  MAX_SIZE,
  MIN_SIZE,
  type EditorState,
} from "./editor-model.ts";

function isEditorCell(value: unknown): value is string {
  return typeof value === "string" && (
    value === " " || value === "O" || value === "R" ||
    value === "S" || value === "X" ||
    isTypedBoxSymbol(value) || isTypedGoalSymbol(value)
  );
}

export function serializeEditorDraft(state: EditorState): string {
  return JSON.stringify({
    width: state.width,
    height: state.height,
    cells: state.cells,
    title: state.title,
    difficulty: state.difficulty,
    hint: state.hint,
  });
}

export function parseEditorDraft(raw: string | null): EditorState | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    if (
      !Number.isSafeInteger(value.width) ||
      Number(value.width) < MIN_SIZE || Number(value.width) > MAX_SIZE ||
      !Number.isSafeInteger(value.height) ||
      Number(value.height) < MIN_SIZE || Number(value.height) > MAX_SIZE ||
      !Array.isArray(value.cells) ||
      value.cells.length !== Number(value.height) ||
      !value.cells.every((row) =>
        Array.isArray(row) &&
        row.length === Number(value.width) &&
        row.every(isEditorCell)
      ) ||
      typeof value.title !== "string" || value.title.length > 60 ||
      typeof value.difficulty !== "string" ||
      !(DIFFICULTIES as readonly string[]).includes(value.difficulty) ||
      (value.hint !== undefined &&
        (typeof value.hint !== "string" || value.hint.length > 200))
    ) return null;
    return {
      width: Number(value.width),
      height: Number(value.height),
      cells: value.cells as string[][],
      title: value.title,
      difficulty: value.difficulty as EditorState["difficulty"],
      hint: typeof value.hint === "string" ? value.hint : "",
      selectedTool: "O",
    };
  } catch {
    return null;
  }
}
