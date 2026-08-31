export interface PuzzleRevisionSource {
  readonly boxes: number;
  readonly rows: readonly string[];
}

export const PUZZLE_REVISION_FINGERPRINT_PATTERN = /^puzzle-v1:[0-9a-f]{8}$/u;

function hashText(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Detects a changed board while remaining stable across builds and devices. */
export function puzzleRevisionFingerprint<T extends PuzzleRevisionSource>(puzzle: T): string {
  const canonical = [
    `boxes:${puzzle.boxes}`,
    `rows:${puzzle.rows.length}`,
    ...puzzle.rows.map((row) => `${row.length}:${row}`),
  ].join("\n");
  return `puzzle-v1:${hashText(canonical)}`;
}

export function isPuzzleRevisionFingerprint(value: unknown): value is string {
  return typeof value === "string" && PUZZLE_REVISION_FINGERPRINT_PATTERN.test(value);
}
