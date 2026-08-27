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

export function framePuzzleRows(
  rows: readonly string[],
): readonly string[] {
  if (rows.length === 0) return [];

  // 1. Normalize ragged rows by padding shorter ones with WALL to max width
  const maxWidth = Math.max(...rows.map((r) => r.length));
  const padded = rows.map((r) => r.padEnd(maxWidth, WALL));

  // 2. Find bounding box of all non-wall cells
  let top = padded.length;
  let bottom = -1;
  let left = maxWidth;
  let right = -1;
  for (let r = 0; r < padded.length; r++) {
    for (let c = 0; c < padded[r].length; c++) {
      if (padded[r][c] !== WALL) {
        if (r < top) top = r;
        if (r > bottom) bottom = r;
        if (c < left) left = c;
        if (c > right) right = c;
      }
    }
  }

  // All wall — return minimal wall board
  if (bottom < 0) return [WALL];

  // 3. Expand bounding box by 1 on each side
  const frameTop = top - 1;
  const frameBottom = bottom + 1;
  const frameLeft = left - 1;
  const frameRight = right + 1;

  // 4–6. Extract the region, synthesizing WALL for out-of-bounds cells
  const result: string[] = [];
  for (let r = frameTop; r <= frameBottom; r++) {
    let row = "";
    for (let c = frameLeft; c <= frameRight; c++) {
      if (r < 0 || r >= padded.length || c < 0 || c >= maxWidth) {
        row += WALL;
      } else {
        row += padded[r][c];
      }
    }
    result.push(row);
  }

  // Ensure perimeter cells are all WALL
  const h = result.length;
  const w = result[0].length;

  // Top and bottom rows
  result[0] = WALL.repeat(w);
  result[h - 1] = WALL.repeat(w);

  // Left and right columns (interior rows only — top/bottom already done)
  for (let r = 1; r < h - 1; r++) {
    const chars = [...result[r]];
    chars[0] = WALL;
    chars[w - 1] = WALL;
    result[r] = chars.join("");
  }

  return result;
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
