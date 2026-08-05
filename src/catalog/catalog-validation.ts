import type { PuzzleDefinition } from "../core/model.ts";
import { validatePuzzle } from "../core/puzzle.ts";

function entryLabel(entry: unknown, index: number): string {
  if (
    typeof entry === "object" &&
    entry !== null &&
    !Array.isArray(entry) &&
    typeof (entry as Record<string, unknown>).id === "string"
  ) {
    return `entry ${index} (${JSON.stringify((entry as Record<string, unknown>).id)})`;
  }
  return `entry ${index}`;
}

function validateOptionalMetadata(entry: Record<string, unknown>): readonly string[] {
  const errors: string[] = [];
  if (
    entry.collection !== undefined &&
    (typeof entry.collection !== "string" || entry.collection.trim() === "")
  ) {
    errors.push("Puzzle collection must be a non-empty string when provided.");
  }
  if (entry.complexity !== undefined) {
    const complexity = entry.complexity;
    if (
      typeof complexity !== "object" ||
      complexity === null ||
      Array.isArray(complexity) ||
      typeof (complexity as Record<string, unknown>).estimatedDifficulty !== "number" ||
      !Number.isFinite((complexity as Record<string, unknown>).estimatedDifficulty) ||
      ((complexity as Record<string, unknown>).estimatedDifficulty as number) < 0
    ) {
      errors.push(
        "Puzzle complexity.estimatedDifficulty must be a finite non-negative number.",
      );
    }
  }
  return errors;
}

function freezePuzzle(entry: PuzzleDefinition): PuzzleDefinition {
  const complexity = entry.complexity === undefined
    ? undefined
    : Object.freeze({ ...entry.complexity });
  return Object.freeze({
    ...entry,
    rows: Object.freeze([...entry.rows]),
    ...(complexity === undefined ? {} : { complexity }),
  });
}

/**
 * Validate an untrusted JSON catalog before it becomes domain data.
 *
 * Invalid or duplicate records are fatal: silently dropping a record would let
 * generated metadata and tests agree on the same incomplete catalog.
 */
export function assertValidPuzzleCatalog(
  value: unknown,
  source: string,
): readonly PuzzleDefinition[] {
  if (!Array.isArray(value)) {
    throw new Error(`${source} must be an array.`);
  }

  const ids = new Set<string>();
  return Object.freeze(value.map((entry, index) => {
    const validation = validatePuzzle(entry);
    const metadataErrors =
      typeof entry === "object" && entry !== null && !Array.isArray(entry)
        ? validateOptionalMetadata(entry as Record<string, unknown>)
        : [];
    const errors = [
      ...validation.errors.map((issue) => issue.message),
      ...metadataErrors,
    ];
    if (errors.length > 0) {
      throw new Error(`${source} ${entryLabel(entry, index)} is invalid: ${errors.join(" ")}`);
    }

    const puzzle = entry as PuzzleDefinition;
    if (ids.has(puzzle.id)) {
      throw new Error(
        `${source} ${entryLabel(entry, index)} duplicates puzzle id ${JSON.stringify(puzzle.id)}.`,
      );
    }
    ids.add(puzzle.id);
    return freezePuzzle(puzzle);
  }));
}

export function assertUniquePuzzleIds(
  puzzles: readonly PuzzleDefinition[],
  source: string,
): readonly PuzzleDefinition[] {
  const ids = new Set<string>();
  for (const [index, puzzle] of puzzles.entries()) {
    if (ids.has(puzzle.id)) {
      throw new Error(
        `${source} entry ${index} duplicates puzzle id ${JSON.stringify(puzzle.id)}.`,
      );
    }
    ids.add(puzzle.id);
  }
  return Object.freeze([...puzzles]);
}

export function createPuzzleByIdIndex(
  puzzles: readonly PuzzleDefinition[],
): Readonly<Record<string, PuzzleDefinition>> {
  const index = Object.create(null) as Record<string, PuzzleDefinition>;
  for (const puzzle of puzzles) {
    index[puzzle.id] = puzzle;
  }
  return Object.freeze(index);
}
