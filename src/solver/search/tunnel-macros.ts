import type { CompiledSearchBoard } from "./compiled-board.ts";
import { OPPOSITE_DIRECTION } from "./exact-search-types.ts";

export interface TunnelMacroStop {
  readonly finalCell: number;
  readonly pushCount: number;
  readonly robotCell: number;
}

export interface TunnelMacroResult {
  readonly stops: readonly TunnelMacroStop[];
}

export interface TunnelMacroStats {
  readonly checks: number;
  readonly applications: number;
}

/**
 * Longest stop a tunnel macro may return. The A* node arena stores a push as
 * one byte: the direction in the low two bits and pushCount - 1 in the other
 * six (see encodeTunnelPushDirection).
 */
export const MAX_TUNNEL_MACRO_PUSHES = 64;

const AXIS_DIRS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [2, 3],
];

export class TunnelMacroDetector {
  readonly #board: CompiledSearchBoard;
  readonly #tunnelAxis: Int8Array;
  #checks = 0;
  #applications = 0;

  constructor(board: CompiledSearchBoard) {
    this.#board = board;
    this.#tunnelAxis = new Int8Array(board.cellCount).fill(-1);
    const { tunnels } = board.topology;
    for (const cell of tunnels) {
      for (const [d0, d1] of AXIS_DIRS) {
        const n = board.neighbors[cell];
        if (n[d0] >= 0 && n[d1] >= 0) {
          this.#tunnelAxis[cell] = d0 < 2 ? 0 : 1;
          break;
        }
      }
    }
  }

  get stats(): TunnelMacroStats {
    return {
      checks: this.#checks,
      applications: this.#applications,
    };
  }

  /**
   * If destination is a tunnel cell aligned with pushDirection, return
   * interesting stopping points (matching goals, tunnel exit, blocked
   * position) from 2 to MAX_TUNNEL_MACRO_PUSHES pushes away. Returns null when
   * no multi-push chaining can happen. Stops are additive successors: callers
   * must still generate the single push, which reaches states (a box part-way
   * into the tunnel) that no stop covers. A one-push stop would repeat that
   * single push, so none is returned.
   */
  resolve(
    destination: number,
    pushDirection: number,
    occupancy: Uint8Array,
    goalLabelByCell: readonly (string | null)[],
    boxLabel: string,
  ): TunnelMacroResult | null {
    this.#checks += 1;

    const pushAxis = pushDirection < 2 ? 0 : 1;
    if (this.#tunnelAxis[destination] !== pushAxis) return null;

    const board = this.#board;
    const opposite = OPPOSITE_DIRECTION[pushDirection];
    const stops: TunnelMacroStop[] = [];
    let current = destination;
    let pushCount = 1;
    let blocked = false;

    for (;;) {
      if (pushCount > 1 && goalLabelByCell[current] === boxLabel) {
        const robotCell = board.neighbors[current][opposite];
        if (robotCell >= 0) {
          stops.push({ finalCell: current, pushCount, robotCell });
        }
      }

      const next = board.neighbors[current][pushDirection];
      if (next < 0 || occupancy[next] !== 0) {
        blocked = true;
        break;
      }
      // Farther stops stay reachable through single pushes, and resolve
      // offers them once the box is deeper in the tunnel.
      if (pushCount === MAX_TUNNEL_MACRO_PUSHES) break;

      if (this.#tunnelAxis[next] !== pushAxis) {
        stops.push({
          finalCell: next,
          pushCount: pushCount + 1,
          robotCell: current,
        });
        break;
      }

      pushCount += 1;
      current = next;
    }

    if (blocked && pushCount > 1) {
      const alreadyAdded =
        stops.length > 0 && stops[stops.length - 1]!.finalCell === current;
      if (!alreadyAdded) {
        const robotCell = board.neighbors[current][opposite];
        if (robotCell >= 0) {
          stops.push({ finalCell: current, pushCount, robotCell });
        }
      }
    }

    if (stops.length === 0) return null;

    this.#applications += 1;
    return { stops };
  }
}

export function encodeTunnelPushDirection(
  directionIndex: number,
  pushCount: number,
): number {
  if (pushCount < 1 || pushCount > MAX_TUNNEL_MACRO_PUSHES) {
    throw new RangeError(
      `Tunnel push count ${pushCount} does not fit the node arena encoding.`,
    );
  }
  return directionIndex | ((pushCount - 1) << 2);
}

export function decodeTunnelPushDirection(encoded: number): {
  directionIndex: number;
  pushCount: number;
} {
  return {
    directionIndex: encoded & 3,
    pushCount: (encoded >> 2) + 1,
  };
}
