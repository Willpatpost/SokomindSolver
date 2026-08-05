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
  readonly #seenEpoch: Uint32Array;
  readonly #distance: Int32Array;
  readonly #predecessor: Int32Array;
  readonly #predecessorDirection: Int8Array;
  readonly #queue: Int32Array;
  #epoch = 0;

  constructor(topology: ReachabilityTopology) {
    if (
      !Number.isSafeInteger(topology.cellCount) ||
      topology.cellCount < 0 ||
      topology.neighbors.length !== topology.cellCount
    ) {
      throw new RangeError("Reachability topology dimensions are inconsistent.");
    }
    this.#topology = topology;
    this.#seenEpoch = new Uint32Array(topology.cellCount);
    this.#distance = new Int32Array(topology.cellCount);
    this.#predecessor = new Int32Array(topology.cellCount);
    this.#predecessorDirection = new Int8Array(topology.cellCount);
    this.#queue = new Int32Array(topology.cellCount);
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

    while (head < tail) {
      const cell = this.#queue[head];
      head += 1;
      if (cell === undefined) break;
      if (cell < canonicalCell) canonicalCell = cell;

      const neighbors = this.#topology.neighbors[cell];
      if (!neighbors) continue;
      for (
        let directionIndex = 0;
        directionIndex < DIRECTIONS.length;
        directionIndex += 1
      ) {
        const next = neighbors[directionIndex] ?? -1;
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
        this.#predecessorDirection[next] = directionIndex;
        this.#queue[tail] = next;
        tail += 1;
      }
    }

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

  saveState(): ReachabilitySnapshot {
    return {
      epoch: this.#epoch,
      seenEpoch: new Uint32Array(this.#seenEpoch),
      distance: new Int32Array(this.#distance),
      predecessor: new Int32Array(this.#predecessor),
      predecessorDirection: new Int8Array(this.#predecessorDirection),
    };
  }

  restoreState(snapshot: ReachabilitySnapshot): void {
    this.#epoch = snapshot.epoch;
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
