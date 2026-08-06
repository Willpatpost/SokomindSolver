import type { CompiledSearchBoard } from "./compiled-board.ts";

export interface PatternBox {
  readonly cell: number;
  readonly label: string;
}

export interface ReversePushTableResult {
  readonly status: "ready" | "cutoff";
  readonly states: ReadonlyMap<string, number>;
  readonly visited: number;
}

function patternSignature(
  boxes: readonly PatternBox[],
  cellCount: number,
): string {
  const tokens: number[] = [];
  for (const box of boxes) {
    tokens.push(box.label.charCodeAt(0) * cellCount + box.cell);
  }
  tokens.sort((a, b) => a - b);
  return tokens.join(",");
}

/**
 * Relaxed reverse-push BFS from a goal configuration.
 *
 * Explores all box configurations reachable by reverse-pushing each box in
 * all 4 directions. The player position is NOT tracked (relaxation that makes
 * distances lower bounds). Collisions among pattern boxes ARE enforced.
 *
 * "Reverse push" means the box was pushed FROM the predecessor cell TO its
 * current cell. For the push to be valid, the support cell (one further back
 * in the push direction) must be floor.
 */
export function relaxedReversePushTable(
  board: CompiledSearchBoard,
  targetBoxes: readonly PatternBox[],
  maxStates: number,
): ReversePushTableResult {
  const n = board.cellCount;
  const goalSig = patternSignature(targetBoxes, n);
  const states = new Map<string, number>([[goalSig, 0]]);
  const queue: PatternBox[][] = [targetBoxes.map((b) => ({ ...b }))];
  let head = 0;
  let cutoff = false;

  while (head < queue.length && head < maxStates) {
    const current = queue[head];
    const pushes = states.get(patternSignature(current, n))!;
    head++;

    const occupied = new Uint8Array(n);
    for (const box of current) occupied[box.cell] = 1;

    for (let bi = 0; bi < current.length; bi++) {
      const box = current[bi];
      const neighbors = board.neighbors[box.cell];

      for (let d = 0; d < neighbors.length; d++) {
        const destination = neighbors[d];
        if (destination < 0) continue;

        // Reverse-push: box moves from box.cell to destination (direction d).
        // In forward play, robot at support pushed box from destination to box.cell.
        // Support is one more step in direction d from destination.
        if (occupied[destination]) continue;

        const support = board.neighbors[destination]?.[d] ?? -1;
        if (support < 0 || occupied[support]) continue;

        const predecessor: PatternBox[] = current.map((b, i) =>
          i === bi ? { cell: destination, label: b.label } : b,
        );
        const sig = patternSignature(predecessor, n);
        if (states.has(sig)) continue;

        if (states.size >= maxStates) {
          cutoff = true;
          continue;
        }
        states.set(sig, pushes + 1);
        queue.push(predecessor);
      }
    }
  }

  const complete = !cutoff && head >= queue.length;
  return {
    status: complete ? "ready" : "cutoff",
    states,
    visited: head,
  };
}

export { patternSignature };
