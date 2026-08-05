import type { Difficulty, PuzzleDefinition } from "../../core/model.ts";
import { DIFFICULTIES } from "../../core/model.ts";
import { validatePuzzle } from "../../core/puzzle.ts";
import {
  MAX_SIZE,
  MIN_SIZE,
  isTypedBoxSymbol,
  isTypedGoalSymbol,
} from "./editor-model.ts";

interface CompactPuzzle {
  t: string;
  d: string;
  h?: string;
  r: string[];
}

const MAX_ENCODED_LENGTH = 4096;

function encodeUtf8Base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeUtf8Base64Url(value: string): string {
  // Spaces repair links produced by the old standard-Base64 implementation:
  // URLSearchParams interpreted their "+" characters as spaces.
  const standard = value
    .trim()
    .replace(/ /g, "+")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(standard) || standard.length % 4 === 1) {
    throw new Error("Invalid Base64 data");
  }
  const padded = standard.padEnd(standard.length + ((4 - (standard.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function isEditorSymbol(symbol: string): boolean {
  return (
    symbol === " " ||
    symbol === "O" ||
    symbol === "R" ||
    symbol === "S" ||
    symbol === "X" ||
    isTypedBoxSymbol(symbol) ||
    isTypedGoalSymbol(symbol)
  );
}

export function encodePuzzleUrl(puzzle: PuzzleDefinition): string {
  const compact: CompactPuzzle = {
    t: puzzle.title,
    d: puzzle.difficulty,
    r: [...puzzle.rows],
  };
  if (puzzle.hint) compact.h = puzzle.hint;
  return `#custom=${encodeUtf8Base64Url(JSON.stringify(compact))}`;
}

export function decodeCustomPuzzle(hash: string): PuzzleDefinition | null {
  const serialized = hash.startsWith("#") ? hash.slice(1) : hash;
  const query = serialized.startsWith("/editor?")
    ? serialized.slice("/editor?".length)
    : serialized;
  const params = new URLSearchParams(query);
  const encoded = params.get("custom");
  if (!encoded || encoded.length > MAX_ENCODED_LENGTH) return null;

  try {
    const json = decodeUtf8Base64Url(encoded);
    const compact = JSON.parse(json) as unknown;
    if (typeof compact !== "object" || compact === null) return null;

    const c = compact as Record<string, unknown>;
    if (typeof c.t !== "string" || !c.t.trim() || c.t.length > 60) return null;
    if (typeof c.d !== "string" || !(DIFFICULTIES as readonly string[]).includes(c.d)) return null;
    if (
      c.h !== undefined &&
      (typeof c.h !== "string" || c.h.length > 200)
    ) {
      return null;
    }
    if (!Array.isArray(c.r) || c.r.length < MIN_SIZE || c.r.length > MAX_SIZE) return null;

    const rows = c.r as unknown[];
    let width: number | undefined;
    for (const row of rows) {
      if (typeof row !== "string") return null;
      const symbols = [...row];
      if (
        symbols.length < MIN_SIZE ||
        symbols.length > MAX_SIZE ||
        symbols.some((symbol) => !isEditorSymbol(symbol))
      ) {
        return null;
      }
      if (width === undefined) width = symbols.length;
      if (symbols.length !== width) return null;
    }

    const puzzleRows = rows as string[];
    let boxes = 0;
    for (const row of puzzleRows) {
      for (const ch of row) {
        if (ch === "X" || isTypedBoxSymbol(ch)) {
          boxes++;
        }
      }
    }

    const puzzle: PuzzleDefinition = {
      id: `custom-${Date.now()}`,
      title: c.t,
      difficulty: c.d as Difficulty,
      boxes,
      hint: typeof c.h === "string" ? c.h : undefined,
      rows: puzzleRows,
    };
    return validatePuzzle(puzzle).valid ? puzzle : null;
  } catch {
    return null;
  }
}
