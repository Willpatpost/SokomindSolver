import metadata from "./puzzle-metadata.json" with { type: "json" };
import { DIFFICULTIES, type Difficulty } from "../core/model.ts";
export {
  type PuzzleDifficulty,
  type CollectionInfo,
  DIFFICULTY_ORDER,
  SOKOMIND_ORIGINALS,
} from "./catalog-types.ts";
import {
  type PuzzleDifficulty,
  type CollectionInfo,
  SOKOMIND_ORIGINALS,
} from "./catalog-types.ts";
import { isRecord } from "../core/type-guards.ts";

type MetadataTuple = readonly [
  id: string,
  title: string,
  difficulty: Difficulty,
  boxes: number,
  width: number,
  height: number,
  collection: string,
  shard: string,
];

export interface PuzzleMetadata {
  readonly id: string;
  readonly title: string;
  readonly difficulty: Difficulty;
  readonly boxes: number;
  readonly width: number;
  readonly height: number;
  readonly collection: string;
  readonly shard: string;
}

function metadataTupleError(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length !== 8) {
    return "must be an eight-field tuple";
  }
  if (typeof value[0] !== "string" || value[0].trim() === "") {
    return "has an invalid puzzle id";
  }
  if (typeof value[1] !== "string" || value[1].trim() === "") {
    return "has an invalid title";
  }
  if (
    typeof value[2] !== "string" ||
    !DIFFICULTIES.includes(value[2] as Difficulty)
  ) {
    return "has an invalid difficulty";
  }
  if (!Number.isInteger(value[3]) || (value[3] as number) < 0) {
    return "has an invalid box count";
  }
  if (!Number.isInteger(value[4]) || (value[4] as number) <= 0) {
    return "has an invalid width";
  }
  if (!Number.isInteger(value[5]) || (value[5] as number) <= 0) {
    return "has an invalid height";
  }
  if (typeof value[6] !== "string" || value[6].trim() === "") {
    return "has an invalid collection";
  }
  if (
    typeof value[7] !== "string" ||
    !/^puzzle-shard-\d{3}$/.test(value[7])
  ) {
    return "has an invalid shard name";
  }
  return undefined;
}

export function parsePuzzleMetadata(value: unknown): readonly PuzzleMetadata[] {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.puzzles)) {
    throw new Error("Puzzle metadata must contain version 1 and a puzzles array.");
  }

  const ids = new Set<string>();
  return Object.freeze(value.puzzles.map((tuple, index) => {
    const error = metadataTupleError(tuple);
    const id = Array.isArray(tuple) && typeof tuple[0] === "string"
      ? ` (${JSON.stringify(tuple[0])})`
      : "";
    if (error) {
      throw new Error(`Puzzle metadata entry ${index}${id} ${error}.`);
    }

    const [
      puzzleId,
      title,
      difficulty,
      boxes,
      width,
      height,
      collection,
      shard,
    ] = tuple as unknown as MetadataTuple;
    if (ids.has(puzzleId)) {
      throw new Error(
        `Puzzle metadata entry ${index} duplicates puzzle id ${JSON.stringify(puzzleId)}.`,
      );
    }
    ids.add(puzzleId);
    return Object.freeze({
      id: puzzleId,
      title,
      difficulty,
      boxes,
      width,
      height,
      collection,
      shard,
    });
  }));
}

export const PUZZLE_METADATA = parsePuzzleMetadata(metadata);

const metadataById = new Map(
  PUZZLE_METADATA.map((puzzle) => [puzzle.id, puzzle] as const),
);
const metadataIndexById = new Map(
  PUZZLE_METADATA.map((puzzle, index) => [puzzle.id, index] as const),
);

export function getPuzzleMetadataById(id: string): PuzzleMetadata | undefined {
  return metadataById.get(id);
}

export function getPuzzleMetadataIndexById(id: string): number {
  return metadataIndexById.get(id) ?? -1;
}

export function getPuzzleMetadataByDifficulty(
  difficulty: PuzzleDifficulty,
): readonly PuzzleMetadata[] {
  return PUZZLE_METADATA.filter((puzzle) => puzzle.difficulty === difficulty);
}

export function getMetadataCollectionsForDifficulty(
  difficulty: PuzzleDifficulty,
): readonly CollectionInfo[] {
  const counts = new Map<string, number>();
  for (const puzzle of getPuzzleMetadataByDifficulty(difficulty)) {
    counts.set(puzzle.collection, (counts.get(puzzle.collection) ?? 0) + 1);
  }
  const result: CollectionInfo[] = [];
  if (counts.has(SOKOMIND_ORIGINALS)) {
    result.push({
      name: SOKOMIND_ORIGINALS,
      count: counts.get(SOKOMIND_ORIGINALS) ?? 0,
    });
    counts.delete(SOKOMIND_ORIGINALS);
  }
  for (const [name, count] of [...counts].sort((left, right) =>
    left[0].localeCompare(right[0]))) {
    result.push({ name, count });
  }
  return result;
}

export function getMetadataBoxCounts(
  difficulty: PuzzleDifficulty,
  collection: string,
): readonly number[] {
  return [...new Set(
    getPuzzleMetadataByDifficulty(difficulty)
      .filter((puzzle) => puzzle.collection === collection)
      .map((puzzle) => puzzle.boxes),
  )].sort((left, right) => left - right);
}
