import { type Difficulty, type PuzzleDefinition } from "../core/model.ts";
import generatedPuzzles from "./generated-puzzles.json" with { type: "json" };
import {
  assertUniquePuzzleIds,
  assertValidPuzzleCatalog,
  createPuzzleByIdIndex,
} from "./catalog-validation.ts";
export {
  type PuzzleDifficulty,
  type CollectionInfo,
  DIFFICULTY_ORDER,
  SOKOMIND_ORIGINALS,
} from "./catalog-types.ts";
import {
  type PuzzleDifficulty,
  type CollectionInfo,
  DIFFICULTY_ORDER,
  SOKOMIND_ORIGINALS,
} from "./catalog-types.ts";

/**
 * The canonical Sokomind puzzle catalog.
 *
 * Definitions intentionally stay data-only so they can be shared by the UI,
 * game engine, tests, and future solver workers without importing one another.
 * During migration, stale legacy `boxes` values were corrected to agree
 * with their unchanged board rows.
 */
const CANONICAL_PUZZLES = [
  {
    id: "ultra-tiny",
    title: "First Steps",
    difficulty: "tutorial",
    boxes: 1,
    hint: "Push the box down onto its goal.",
    rows: ["OOOOO", "O R O", "O A O", "O a O", "OOOOO"],
  },
  {
    id: "tiny",
    title: "Two's Company",
    difficulty: "tutorial",
    boxes: 2,
    hint: "Generic boxes go to S goals. Labeled boxes go to matching goals.",
    rows: ["OOOOOO", "O R  O", "O XO O", "OO A O", "OSa  O", "OOOOOO"],
  },
  {
    id: "tutorial-push",
    title: "One Push Wonder",
    difficulty: "tutorial",
    boxes: 1,
    hint: "Walk up and push the box right onto the goal.",
    rows: ["OOOOO", "O XSO", "O   O", "O R O", "OOOOO"],
  },
  {
    id: "tutorial-around",
    title: "Go Around",
    difficulty: "tutorial",
    boxes: 1,
    hint: "You can't pull boxes. Walk around to push from the other side.",
    rows: ["OOOOOOO", "OR    O", "OOOOX O", "O   S O", "OOOOOOO"],
  },
  {
    id: "beginner-three",
    title: "Three in a Row",
    difficulty: "beginner",
    boxes: 3,
    hint: "Order matters! Start with the box farthest from the goals.",
    rows: ["OOOOOOOO", "O R    O", "O XXXO O", "O SSSO O", "O      O", "OOOOOOOO"],
  },
  {
    id: "beginner-detour",
    title: "The Detour",
    difficulty: "beginner",
    boxes: 2,
    hint: "The direct path is blocked. Find the scenic route.",
    rows: ["OOOOOOOO", "OR     O", "OOOO X O", "OS   X O", "OS     O", "OOOOOOOO"],
  },
  {
    id: "beginner-typed-line",
    title: "Color Line",
    difficulty: "beginner",
    boxes: 3,
    hint: "Each box must reach its matching color. Plan the sequence!",
    rows: ["OOOOOOOOO", "Oc b a  O", "O       O", "O A B C O", "O   R   O", "OOOOOOOOO"],
  },
  {
    id: "box-5x5-a",
    title: "Tiny Teaser",
    difficulty: "beginner",
    boxes: 2,
    hint: "A deceptively simple 5x5. Think before you push!",
    rows: ["OOOOO", "OSX O", "O XRO", "O  SO", "OOOOO"],
  },
  {
    id: "medium",
    title: "Color Wheel",
    difficulty: "intermediate",
    boxes: 8,
    hint: "Each labeled box has a specific home. Plan the order carefully.",
    rows: ["OOOOOOO", "Oa   bO", "O AXB O", "O XRX O", "OSCXDSO", "OcS SdO", "OOOOOOO"],
  },
  {
    id: "garden-2",
    title: "Garden Path",
    difficulty: "intermediate",
    boxes: 2,
    hint: "Wind through the garden. Mind the hedges!",
    rows: ["OOOOOOOOOOO", "O    R    O", "O OOO OOO O", "O A     B O", "O OOO OOO O", "O  b   a  O", "O OO O OO O", "O         O", "OOOOOOOOOOO"],
  },
  {
    id: "workshop-1",
    title: "Tool Shed",
    difficulty: "intermediate",
    boxes: 3,
    hint: "Small space, big challenge. Every move counts.",
    rows: ["OOOOOOO", "O   R O", "O OXO O", "O X   O", "OSX   O", "OS    O", "OS    O", "OOOOOOO"],
  },
  {
    id: "classic-1",
    title: "Original Spirit",
    difficulty: "intermediate",
    boxes: 3,
    hint: "Inspired by classic Sokoban. The side alcove is key.",
    rows: ["OOOOOOO", "O     O", "O OXO O", "O  X  O", "OO X OO", "O  R  O", "O SSS O", "OOOOOOO"],
  },
  {
    id: "theme-kitchen",
    title: "Kitchen Cleanup",
    difficulty: "intermediate",
    boxes: 3,
    hint: "Push the ingredients to the counter. Mind the kitchen island!",
    rows: ["OOOOOOOOO", "O R     O", "O  OOO  O", "O X O X O", "O  O    O", "O  O  X O", "O SSS   O", "OOOOOOOOO"],
  },
  {
    id: "large",
    title: "The Warehouse",
    difficulty: "advanced",
    boxes: 6,
    hint: "Navigate the L-shaped corridor. Don't trap boxes against walls.",
    rows: ["OOOOOOOOOO", "OOOOOOOSSO", "OOOOO  abO", "OOOOO XSSO", "OOOOOO  OO", "OR     OOO", "OO A X X O", "OO BXO O O", "OO   O   O", "OOOOOOOOOO"],
  },
  {
    id: "adv-gallery",
    title: "The Gallery",
    difficulty: "advanced",
    boxes: 4,
    hint: "Boxes line the gallery walls. Slide them to the exhibition spots.",
    rows: ["OOOOOOOOOO", "O R      O", "O OOOOOO O", "O O    O O", "O X SS X O", "O O    O O", "O OXOOXO O", "O        O", "O   SS   O", "OOOOOOOOOO"],
  },
  {
    id: "theme-parking",
    title: "Parking Lot",
    difficulty: "advanced",
    boxes: 5,
    hint: "Park each car in its assigned spot. Don't block the exit!",
    rows: ["OOOOOOOOOOO", "O   R     O", "O A B C   O", "O  OOOOO  O", "O    X  X O", "O  OOOOO  O", "O a b c   O", "O      SSOO", "OOOOOOOOOOO"],
  },
  {
    id: "open-field",
    title: "Wide Open",
    difficulty: "advanced",
    boxes: 10,
    hint: "Ten boxes, ten goals, and a vast open floor. Plan your routes carefully.",
    rows: ["OOOOOOOOOOOOOOOOOOOO", "OSX                O", "OS  X              O", "OS                 O", "OS                 O", "OS                 O", "OS                 O", "OS                 O", "OS                 O", "OS                 O", "OX        R        O", "O   X              O", "OX                 O", "O   X              O", "OX                 O", "O   X              O", "OX                 O", "O   X              O", "OS                 O", "OOOOOOOOOOOOOOOOOOOO"],
  },
  {
    id: "huge",
    title: "Grand Hall",
    difficulty: "expert",
    boxes: 17,
    hint: "This symmetric puzzle has mirrored rooms. Solve the outer wings first.",
    rows: ["OOOOOOOOOOOOOOO", "OaSS   S   SSbO", "OSCS  OOO  SDSO", "OX X  OOO  X XO", "O     OOO     O", "OOOO   X   OOOO", "O      O      O", "O G hOOOOOH g O", "O      O      O", "OOO         OOO", "OOO   X X   OOO", "OOOOOOOROOOOOOO", "O B X X X X A O", "O Sc       dS O", "OOOOOOOOOOOOOOO"],
  },
  {
    id: "expert-maze",
    title: "The Maze",
    difficulty: "expert",
    boxes: 5,
    hint: "A winding maze with boxes at dead ends. Free them carefully.",
    rows: ["OOOOOOOOOOOO", "O R  O     O", "OOO  O OOO O", "O X  O O S O", "O OO   O   O", "O O  OOOO  O", "O   XO  X  O", "OOOO OS    O", "O  X    OO O", "O SSS X    O", "OOOOOOOOOOOO"],
  },
] as const satisfies readonly PuzzleDefinition[];

const validatedCanonicalPuzzles = assertValidPuzzleCatalog(
  CANONICAL_PUZZLES,
  "Canonical puzzle catalog",
);
const validatedGeneratedPuzzles = assertValidPuzzleCatalog(
  generatedPuzzles,
  "Generated puzzle catalog",
);

export const PUZZLES: readonly PuzzleDefinition[] = assertUniquePuzzleIds([
  ...validatedCanonicalPuzzles,
  ...validatedGeneratedPuzzles,
], "Combined puzzle catalog");

export type PuzzleId = string;

const puzzleIndexById = new Map<string, number>();
for (let index = 0; index < PUZZLES.length; index += 1) {
  const puzzle = PUZZLES[index];
  puzzleIndexById.set(puzzle.id, index);
}

export const PUZZLE_BY_ID: Readonly<Record<string, PuzzleDefinition>> =
  createPuzzleByIdIndex(PUZZLES);

export interface PuzzleCatalogFilter {
  readonly difficulty?: PuzzleDifficulty | readonly PuzzleDifficulty[];
  readonly collection?: string;
  readonly search?: string;
  readonly minBoxes?: number;
  readonly maxBoxes?: number;
}

const DIFFICULTY_RANK = new Map<PuzzleDifficulty, number>(
  DIFFICULTY_ORDER.map((difficulty, index) => [difficulty, index]),
);

export function getPuzzleById(id: string): PuzzleDefinition | undefined {
  return Object.prototype.hasOwnProperty.call(PUZZLE_BY_ID, id)
    ? PUZZLE_BY_ID[id]
    : undefined;
}

export function getPuzzleIndexById(id: string): number {
  return puzzleIndexById.get(id) ?? -1;
}

export function getPuzzlesByDifficulty(
  difficulty: PuzzleDifficulty,
): readonly PuzzleDefinition[] {
  return PUZZLES.filter((puzzle) => puzzle.difficulty === difficulty);
}

/**
 * Returns catalog entries in curriculum order, preserving source order within
 * each difficulty. Every call returns a new array that callers may safely sort.
 */
export function getOrderedPuzzles(
  filter: PuzzleCatalogFilter = {},
): PuzzleDefinition[] {
  const selectedDifficulties: readonly PuzzleDifficulty[] | undefined =
    filter.difficulty === undefined
    ? undefined
    : typeof filter.difficulty === "string"
      ? [filter.difficulty]
      : filter.difficulty;
  const difficulties = selectedDifficulties === undefined
    ? undefined
    : new Set<PuzzleDifficulty>(selectedDifficulties);
  const search = filter.search?.trim().toLocaleLowerCase();

  return PUZZLES
    .filter((puzzle) => {
      if (difficulties && !difficulties.has(puzzle.difficulty)) return false;
      if (filter.collection !== undefined && getEffectiveCollection(puzzle) !== filter.collection) return false;
      if (filter.minBoxes !== undefined && puzzle.boxes < filter.minBoxes) return false;
      if (filter.maxBoxes !== undefined && puzzle.boxes > filter.maxBoxes) return false;
      if (!search) return true;

      return [puzzle.id, puzzle.title, puzzle.hint ?? ""].some((field) =>
        field.toLocaleLowerCase().includes(search),
      );
    })
    .sort((left, right) => (
      (DIFFICULTY_RANK.get(left.difficulty) ?? Number.MAX_SAFE_INTEGER)
      - (DIFFICULTY_RANK.get(right.difficulty) ?? Number.MAX_SAFE_INTEGER)
    ));
}

export function getOrderedPuzzleIds(
  filter: PuzzleCatalogFilter = {},
): string[] {
  return getOrderedPuzzles(filter).map((puzzle) => puzzle.id);
}

export function groupPuzzlesByDifficulty(): Readonly<
  Record<PuzzleDifficulty, readonly PuzzleDefinition[]>
> {
  return Object.freeze(
    Object.fromEntries(
      DIFFICULTY_ORDER.map((difficulty) => [
        difficulty,
        Object.freeze(getPuzzlesByDifficulty(difficulty)),
      ]),
    ),
  ) as Readonly<Record<PuzzleDifficulty, readonly PuzzleDefinition[]>>;
}

export function getEffectiveCollection(puzzle: PuzzleDefinition): string {
  return puzzle.collection ?? SOKOMIND_ORIGINALS;
}

export function getCollectionsForDifficulty(
  difficulty: PuzzleDifficulty,
): readonly CollectionInfo[] {
  const puzzles = getPuzzlesByDifficulty(difficulty);
  const counts = new Map<string, number>();
  for (const puzzle of puzzles) {
    const collection = getEffectiveCollection(puzzle);
    counts.set(collection, (counts.get(collection) ?? 0) + 1);
  }
  const result: CollectionInfo[] = [];
  if (counts.has(SOKOMIND_ORIGINALS)) {
    result.push({ name: SOKOMIND_ORIGINALS, count: counts.get(SOKOMIND_ORIGINALS)! });
    counts.delete(SOKOMIND_ORIGINALS);
  }
  for (const [name, count] of [...counts].sort((a, b) => a[0].localeCompare(b[0]))) {
    result.push({ name, count });
  }
  return result;
}

export function getBoxCountsForFilter(
  difficulty: PuzzleDifficulty,
  collection: string,
): readonly number[] {
  const puzzles = getPuzzlesByDifficulty(difficulty).filter(
    (p) => getEffectiveCollection(p) === collection,
  );
  const counts = new Set<number>();
  for (const p of puzzles) counts.add(p.boxes);
  return [...counts].sort((a, b) => a - b);
}

const DIFFICULTY_WEIGHT: Readonly<Record<Difficulty, number>> = {
  tutorial: 1,
  beginner: 2,
  intermediate: 3,
  advanced: 5,
  expert: 8,
  master: 13,
};

export function estimatePuzzleComplexity(puzzle: PuzzleDefinition): number {
  const height = puzzle.rows.length;
  const width = Math.max(...puzzle.rows.map((r) => r.length));
  const totalCells = width * height;
  if (totalCells === 0) return 0;
  let floorCells = 0;
  for (const row of puzzle.rows) {
    for (const ch of row) {
      if (ch !== "O") floorCells++;
    }
  }
  const floorAreaRatio = floorCells / totalCells;
  const weight = DIFFICULTY_WEIGHT[puzzle.difficulty] ?? 3;
  return puzzle.boxes * floorAreaRatio * weight;
}

export interface CatalogDiversityStats {
  readonly totalPuzzles: number;
  readonly countPerDifficulty: Readonly<Record<string, number>>;
  readonly countPerCollection: Readonly<Record<string, number>>;
  readonly boxCountDistribution: Readonly<Record<number, number>>;
  readonly hasLabeledBoxes: boolean;
}

export function getCatalogDiversityStats(): CatalogDiversityStats {
  const countPerDifficulty: Record<string, number> = {};
  const countPerCollection: Record<string, number> = {};
  const boxCountDistribution: Record<number, number> = {};
  let hasLabeledBoxes = false;

  for (const puzzle of PUZZLES) {
    countPerDifficulty[puzzle.difficulty] =
      (countPerDifficulty[puzzle.difficulty] ?? 0) + 1;

    const collection = getEffectiveCollection(puzzle);
    countPerCollection[collection] =
      (countPerCollection[collection] ?? 0) + 1;

    boxCountDistribution[puzzle.boxes] =
      (boxCountDistribution[puzzle.boxes] ?? 0) + 1;

    if (!hasLabeledBoxes) {
      for (const row of puzzle.rows) {
        if ([...row].some(ch => /^[A-Z]$/.test(ch) && !["O", "R", "S", "X"].includes(ch))) {
          hasLabeledBoxes = true;
          break;
        }
      }
    }
  }

  return {
    totalPuzzles: PUZZLES.length,
    countPerDifficulty,
    countPerCollection,
    boxCountDistribution,
    hasLabeledBoxes,
  };
}
