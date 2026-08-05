# Puzzle format

The catalog stores puzzles as immutable `PuzzleDefinition` values:

```ts
interface PuzzleDefinition {
  readonly id: string;
  readonly title: string;
  readonly difficulty:
    | "tutorial"
    | "beginner"
    | "intermediate"
    | "advanced"
    | "expert"
    | "master";
  readonly boxes: number;
  readonly hint?: string;
  readonly rows: readonly string[];
}
```

## Board symbols

| Symbol | Meaning |
| --- | --- |
| `O` | Wall |
| space | Walkable floor |
| `R` | Robot; exactly one is required |
| `X` | Generic box |
| `S` | Goal for a generic `X` box |
| `A`–`Z` | Dedicated box, excluding reserved `O`, `R`, `S`, and `X` |
| `a`–`z` | Matching dedicated goal, excluding reserved `o`, `r`, `s`, and `x` |

A dedicated box can finish only on the lowercase goal with the same letter.
Generic boxes are interchangeable with one another and finish on `S` goals.
For every label, box and goal counts must match.

Rows may be ragged in source data. `parsePuzzleRows()` normalizes missing
trailing cells to walls, never floor, and returns a rectangular `ParsedBoard`.
Coordinates are zero-based `{ row, column }` values.

## Metadata invariants

- `id` and `title` are non-empty.
- `difficulty` is one of the six supported tiers.
- `boxes` is a non-negative integer and equals the number encoded in `rows`.
- `hint`, when present, is a string.
- Rows contain only supported symbols and exactly one robot.
- Every box label has the same number of matching goals.

Call `validatePuzzle()` when accepting a full definition. It returns structured
issues without throwing. Call `parsePuzzle()` only after validation or handle
`PuzzleValidationError`. For row-only imports, use `validatePuzzleRows()` and
`parsePuzzleRows()`.

Catalog ingestion is deliberately fail-fast. Canonical definitions, imported
definitions, generated metadata tuples, and lazily loaded shard contents are
validated before they are frozen or indexed. Invalid or duplicate IDs produce
an error that names the source and item; they are never silently filtered out.
The puzzle loader has no module-load dependency on Vite and must be configured
explicitly by the browser composition root before the app renders. This keeps
catalog validation usable from Node tests and other non-Vite consumers.

## Example

```ts
const puzzle = {
  id: "first-steps",
  title: "First Steps",
  difficulty: "tutorial",
  boxes: 1,
  hint: "Push the box down onto its goal.",
  rows: ["OOOOO", "O R O", "O A O", "O a O", "OOOOO"],
} as const;
```

Catalog row strings are data, not rendered markup. Preserve spaces and avoid
trimming individual rows during import. The parser assigns stable box IDs in
source-row order so game and solver states can track a box across moves.

## Adding a puzzle

1. Add one definition to the catalog data module.
2. Keep the ID stable; saved progress may refer to it.
3. Validate the definition and confirm its declared box count.
4. Add or update catalog tests for count, unique IDs, and ordering.
5. Play-test it and, once solvers exist, keep at least one replay-verified
   solution fixture.

Changing rows under an existing ID changes the puzzle represented by saved
progress. Prefer a new ID for a materially different board.
