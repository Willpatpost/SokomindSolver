const WALL = "O";

function fnv1a32(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function toHex8(n: number): string {
  return n.toString(16).padStart(8, "0");
}

function isAllWall(row: string): boolean {
  for (let i = 0; i < row.length; i++) {
    if (row[i] !== WALL) return false;
  }
  return true;
}

export function canonicalizeRows(
  rows: readonly string[],
): readonly string[] {
  if (rows.length === 0) return [];

  const maxWidth = Math.max(...rows.map((r) => r.length));
  const padded = rows.map((r) => r.padEnd(maxWidth, WALL));

  let top = 0;
  while (top < padded.length && isAllWall(padded[top])) top++;
  let bottom = padded.length - 1;
  while (bottom > top && isAllWall(padded[bottom])) bottom--;

  if (top > bottom) return [WALL];

  const trimmed = padded.slice(top, bottom + 1);

  let left = maxWidth;
  let right = 0;
  for (const row of trimmed) {
    for (let c = 0; c < row.length; c++) {
      if (row[c] !== WALL) {
        if (c < left) left = c;
        if (c > right) right = c;
      }
    }
  }

  if (left > right) return [WALL];

  return trimmed.map((row) => row.slice(left, right + 1));
}

export function boardHash(rows: readonly string[]): string {
  const canonical = canonicalizeRows(rows);
  return toHex8(fnv1a32(canonical.join("\n")));
}

function mirrorHorizontal(rows: readonly string[]): readonly string[] {
  return rows.map((r) => [...r].reverse().join(""));
}

function mirrorVertical(rows: readonly string[]): readonly string[] {
  return [...rows].reverse();
}

function rotate180(rows: readonly string[]): readonly string[] {
  return mirrorVertical(mirrorHorizontal(rows));
}

export function symmetryHash(rows: readonly string[]): string {
  const transforms = [
    rows,
    mirrorHorizontal(rows),
    mirrorVertical(rows),
    rotate180(rows),
  ];

  let minSerialized: string | undefined;
  for (const t of transforms) {
    const canonical = canonicalizeRows(t);
    const serialized = canonical.join("\n");
    if (minSerialized === undefined || serialized < minSerialized) {
      minSerialized = serialized;
    }
  }

  return toHex8(fnv1a32(minSerialized!));
}

export function createGeneratedPuzzleId(
  seed: number,
  rows: readonly string[],
): string {
  return `gen-v2-${seed}-${boardHash(rows)}`;
}
