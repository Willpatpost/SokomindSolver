import type { CompiledSearchBoard } from "./compiled-board.ts";

export interface TunnelMacroStop {
  readonly finalCell: number;
  readonly pushCount: number;
  readonly robotCell: number;
}

export interface TunnelMacroStats {
  readonly checks: number;
  readonly applications: number;
}

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
   * position). Returns null when no multi-push chaining can happen.
   */
  resolve(
    destination: number,
    pushDirection: number,
    occupancy: Uint8Array,
    goalLabelByCell: readonly (string | null)[],
    boxLabel: string,
  ): readonly TunnelMacroStop[] | null {
    this.#checks += 1;

    const pushAxis = pushDirection < 2 ? 0 : 1;
    if (this.#tunnelAxis[destination] !== pushAxis) return null;

    const board = this.#board;
    const opposite = pushDirection ^ 1;
    const stops: TunnelMacroStop[] = [];
    let current = destination;
    let pushCount = 1;
    let exitedToNonTunnel = false;

    for (;;) {
      if (goalLabelByCell[current] === boxLabel) {
        const robotCell = board.neighbors[current][opposite];
        if (robotCell >= 0) {
          stops.push({ finalCell: current, pushCount, robotCell });
        }
      }

      const next = board.neighbors[current][pushDirection];
      if (next < 0 || occupancy[next] !== 0) break;

      if (this.#tunnelAxis[next] !== pushAxis) {
        stops.push({
          finalCell: next,
          pushCount: pushCount + 1,
          robotCell: current,
        });
        exitedToNonTunnel = true;
        break;
      }

      pushCount += 1;
      current = next;
    }

    if (!exitedToNonTunnel) {
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
    if (stops.length === 1 && stops[0]!.pushCount === 1) return null;

    this.#applications += 1;
    return stops;
  }
}

export function encodeTunnelPushDirection(
  directionIndex: number,
  pushCount: number,
): number {
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
