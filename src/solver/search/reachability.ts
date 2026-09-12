import { DIRECTIONS, type Direction } from "../../core/index.ts";

/**
 * Structural subset of a compiled board needed by keeper reachability.
 * Neighbor rows use the core direction order: up, down, left, right. A value
 * of -1 denotes a wall or the outside of the board.
 */
export interface ReachabilityTopology {
  readonly cellCount: number;
  readonly neighbors: ReadonlyArray<ArrayLike<number>>;
}

export interface KeeperReachabilityResult {
  readonly start: number;
  readonly canonicalCell: number;
  readonly reachableCount: number;
  isReachable(cell: number): boolean;
  distanceTo(cell: number): number;
  /**
   * Returns one deterministic shortest walk. The result is undefined when the
   * target cannot be reached without moving a box.
   */
  pathTo(cell: number): readonly Direction[] | undefined;
}

export interface ReachabilitySnapshot {
  readonly epoch: number;
  readonly canonicalCell: number;
  readonly seenEpoch: Uint32Array;
  readonly distance: Int32Array;
  readonly predecessor: Int32Array;
  readonly predecessorDirection: Int8Array;
}

/**
 * Reusable dense BFS workspace. Each `flood` result remains valid only until
 * the next call to `flood` on the same workspace.
 */
export class KeeperReachability {
  readonly #topology: ReachabilityTopology;
  readonly #flatNeighbors: Int32Array;
  readonly #seenEpoch: Uint32Array;
  readonly #distance: Int32Array;
  readonly #predecessor: Int32Array;
  readonly #predecessorDirection: Int8Array;
  readonly #queue: Int32Array;
  readonly #scratchVisited: Uint8Array;
  #epoch = 0;
  #lastCanonicalCell = -1;

  constructor(topology: ReachabilityTopology) {
    if (
      !Number.isSafeInteger(topology.cellCount) ||
      topology.cellCount < 0 ||
      topology.neighbors.length !== topology.cellCount
    ) {
      throw new RangeError("Reachability topology dimensions are inconsistent.");
    }
    this.#topology = topology;
    const n = topology.cellCount;
    this.#flatNeighbors = new Int32Array(n * 4);
    for (let cell = 0; cell < n; cell++) {
      const row = topology.neighbors[cell];
      const base = cell << 2;
      for (let d = 0; d < 4; d++) {
        this.#flatNeighbors[base + d] = row?.[d] ?? -1;
      }
    }
    this.#seenEpoch = new Uint32Array(n);
    this.#distance = new Int32Array(n);
    this.#predecessor = new Int32Array(n);
    this.#predecessorDirection = new Int8Array(n);
    this.#queue = new Int32Array(n);
    this.#scratchVisited = new Uint8Array(n);
  }

  flood(
    start: number,
    occupied: ArrayLike<number>,
  ): KeeperReachabilityResult {
    if (
      start < 0 ||
      start >= this.#topology.cellCount ||
      occupied.length !== this.#topology.cellCount
    ) {
      throw new RangeError("Reachability input dimensions are inconsistent.");
    }
    if (occupied[start] !== 0) {
      throw new Error("Keeper reachability cannot start on an occupied cell.");
    }

    this.#advanceEpoch();
    const epoch = this.#epoch;
    let head = 0;
    let tail = 0;
    let canonicalCell = start;

    this.#queue[tail] = start;
    tail += 1;
    this.#seenEpoch[start] = epoch;
    this.#distance[start] = 0;
    this.#predecessor[start] = -1;
    this.#predecessorDirection[start] = -1;

    const flatNeighbors = this.#flatNeighbors;
    while (head < tail) {
      const cell = this.#queue[head];
      head += 1;
      if (cell < canonicalCell) canonicalCell = cell;

      const base = cell << 2;
      for (let d = 0; d < 4; d++) {
        const next = flatNeighbors[base + d];
        if (
          next < 0 ||
          occupied[next] !== 0 ||
          this.#seenEpoch[next] === epoch
        ) {
          continue;
        }
        this.#seenEpoch[next] = epoch;
        this.#distance[next] = this.#distance[cell] + 1;
        this.#predecessor[next] = cell;
        this.#predecessorDirection[next] = d;
        this.#queue[tail] = next;
        tail += 1;
      }
    }

    this.#lastCanonicalCell = canonicalCell;
    const isReachable = (cell: number) =>
      cell >= 0 &&
      cell < this.#topology.cellCount &&
      this.#seenEpoch[cell] === epoch;
    return {
      start,
      canonicalCell,
      reachableCount: tail,
      isReachable,
      distanceTo: (cell) => (isReachable(cell) ? this.#distance[cell] : -1),
      pathTo: (cell) => {
        if (!isReachable(cell)) return undefined;
        const reversed: Direction[] = [];
        let cursor = cell;
        while (cursor !== start) {
          const directionIndex = this.#predecessorDirection[cursor];
          const predecessor = this.#predecessor[cursor];
          const direction = DIRECTIONS[directionIndex];
          if (predecessor < 0 || direction === undefined) {
            throw new Error("Reachability predecessor chain is corrupt.");
          }
          reversed.push(direction);
          cursor = predecessor;
        }
        reversed.reverse();
        return reversed;
      },
    };
  }

  /**
   * Compute the canonical cell for a child state without a full BFS.
   * Precondition: the most recent `flood()` on this instance is the parent.
   * Returns the canonical cell, or `null` when a full flood is needed.
   */
  incrementalCanonicalCell(
    freedCell: number,
    blockedCell: number,
    occupancy: ArrayLike<number>,
  ): number | null {
    const epoch = this.#epoch;
    const seenEpoch = this.#seenEpoch;
    const flatNeighbors = this.#flatNeighbors;
    const scratch = this.#scratchVisited;
    const queue = this.#queue;
    const parentCanonical = this.#lastCanonicalCell;

    // Removing a reachable cell can disconnect a whole region even when
    // adjacent cells have other free neighbors. Such pushes require full BFS.
    if (parentCanonical < 0 || seenEpoch[blockedCell] === epoch) return null;

    let candidate = freedCell;

    // Mini-BFS from freedCell through cells not reachable in parent.
    let head = 0;
    let tail = 0;
    const fBase = freedCell << 2;
    for (let d = 0; d < 4; d++) {
      const next = flatNeighbors[fBase + d];
      if (
        next >= 0 &&
        occupancy[next] === 0 &&
        seenEpoch[next] !== epoch &&
        scratch[next] === 0
      ) {
        scratch[next] = 1;
        queue[tail++] = next;
        if (next < candidate) candidate = next;
      }
    }
    while (head < tail) {
      const cell = queue[head++];
      const base = cell << 2;
      for (let d = 0; d < 4; d++) {
        const next = flatNeighbors[base + d];
        if (
          next >= 0 &&
          occupancy[next] === 0 &&
          seenEpoch[next] !== epoch &&
          scratch[next] === 0
        ) {
          scratch[next] = 1;
          queue[tail++] = next;
          if (next < candidate) candidate = next;
        }
      }
    }

    // Clean up scratch marks.
    for (let i = 0; i < tail; i++) scratch[queue[i]] = 0;

    return Math.min(parentCanonical, candidate);
  }

  saveState(): ReachabilitySnapshot {
    return {
      epoch: this.#epoch,
      canonicalCell: this.#lastCanonicalCell,
      seenEpoch: new Uint32Array(this.#seenEpoch),
      distance: new Int32Array(this.#distance),
      predecessor: new Int32Array(this.#predecessor),
      predecessorDirection: new Int8Array(this.#predecessorDirection),
    };
  }

  restoreState(snapshot: ReachabilitySnapshot): void {
    this.#epoch = snapshot.epoch;
    this.#lastCanonicalCell = snapshot.canonicalCell;
    this.#seenEpoch.set(snapshot.seenEpoch);
    this.#distance.set(snapshot.distance);
    this.#predecessor.set(snapshot.predecessor);
    this.#predecessorDirection.set(snapshot.predecessorDirection);
  }

  #advanceEpoch(): void {
    this.#epoch = (this.#epoch + 1) >>> 0;
    if (this.#epoch !== 0) return;
    this.#seenEpoch.fill(0);
    this.#epoch = 1;
  }
}
