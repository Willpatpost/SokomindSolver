import type { CompiledSearchBoard } from "./compiled-board.ts";
import type { DenseBox } from "./model.ts";
import type { BoardTopology } from "./topology.ts";

export interface DoorwayCrossingStats {
  readonly evaluations: number;
  readonly positiveResults: number;
}

/**
 * Admissible lower bound based on mandatory articulation-point crossings.
 *
 * Articulation points (doorways) partition the board into regions. When a box
 * must cross an articulation point to reach any matching goal, that crossing
 * requires at least one push. Summing mandatory crossings across all unsolved
 * boxes yields an admissible lower bound on remaining moves.
 */
export class DoorwayCrossingLowerBound {
  readonly #board: CompiledSearchBoard;
  #evaluations = 0;
  #positiveResults = 0;

  /**
   * regionId[cell] — the region a non-articulation cell belongs to.
   * Articulation cells get -1 (they border multiple regions).
   */
  readonly #regionId: Int32Array;
  /** Total number of regions (connected components after removing articulation points). */
  readonly #regionCount: number;
  /**
   * Distance matrix between regions, measured in articulation-point crossings.
   * regionDist[r1 * regionCount + r2] = minimum crossings from region r1 to r2.
   * -1 means unreachable.
   */
  readonly #regionDist: Int32Array;

  constructor(board: CompiledSearchBoard, topology: BoardTopology) {
    this.#board = board;

    const cellCount = board.cellCount;
    const articulations = topology.articulations;

    // Step 1: Compute connected components of floor cells with articulation
    // points removed. Each component is a "region".
    const regionId = new Int32Array(cellCount);
    regionId.fill(-1);
    let nextRegion = 0;

    for (let seed = 0; seed < cellCount; seed++) {
      // Skip articulation points and already-assigned cells.
      if (articulations.has(seed) || regionId[seed] >= 0) continue;

      const rid = nextRegion++;
      regionId[seed] = rid;
      const queue: number[] = [seed];

      for (let head = 0; head < queue.length; head++) {
        const current = queue[head];
        const neighbors = board.neighbors[current];
        for (let d = 0; d < neighbors.length; d++) {
          const next = neighbors[d];
          if (next < 0 || regionId[next] >= 0 || articulations.has(next))
            continue;
          regionId[next] = rid;
          queue.push(next);
        }
      }
    }

    this.#regionId = regionId;
    this.#regionCount = nextRegion;

    // Step 2: Build an abstract graph of regions connected through
    // articulation points and BFS all-pairs shortest paths (in terms
    // of articulation crossings).
    //
    // Two regions are adjacent if they both neighbor the same articulation
    // point. Crossing one articulation point costs 1 in this abstract graph.
    // But we model it more precisely: the abstract graph has both region
    // nodes and articulation nodes. An edge connects a region to an
    // articulation point if they are adjacent on the board. The shortest
    // path from region A to region B in this bipartite graph has length 2k
    // (alternating region-artic-region-...), meaning k articulation crossings.

    // Collect which regions each articulation point touches.
    const articulationArray = [...articulations];
    const articulationIndex = new Map<number, number>();
    for (let i = 0; i < articulationArray.length; i++) {
      articulationIndex.set(articulationArray[i], i);
    }
    const artCount = articulationArray.length;

    // Adjacency: for each articulation point, which regions does it touch?
    // For each region, which articulation points does it touch?
    const artToRegions: Set<number>[] = new Array(artCount);
    for (let i = 0; i < artCount; i++) artToRegions[i] = new Set();
    const regionToArts: Set<number>[] = new Array(nextRegion);
    for (let i = 0; i < nextRegion; i++) regionToArts[i] = new Set();

    // Also handle articulation-to-articulation adjacency.
    const artToArts: Set<number>[] = new Array(artCount);
    for (let i = 0; i < artCount; i++) artToArts[i] = new Set();

    for (let ai = 0; ai < artCount; ai++) {
      const artCell = articulationArray[ai];
      const neighbors = board.neighbors[artCell];
      for (let d = 0; d < neighbors.length; d++) {
        const next = neighbors[d];
        if (next < 0) continue;
        if (articulations.has(next)) {
          // Neighbor is also an articulation point.
          const aj = articulationIndex.get(next)!;
          artToArts[ai].add(aj);
        } else {
          // Neighbor is a regular cell — find its region.
          const rid = regionId[next];
          if (rid >= 0) {
            artToRegions[ai].add(rid);
            regionToArts[rid].add(ai);
          }
        }
      }
    }

    // BFS from each region in the bipartite graph (region + articulation nodes).
    // Node encoding: [0, nextRegion) = region nodes,
    //                 [nextRegion, nextRegion + artCount) = articulation nodes.
    const totalNodes = nextRegion + artCount;
    const regionDist = new Int32Array(nextRegion * nextRegion);
    regionDist.fill(-1);

    // Self-distance is 0 crossings.
    for (let r = 0; r < nextRegion; r++) {
      regionDist[r * nextRegion + r] = 0;
    }

    if (artCount > 0) {
      const dist = new Int32Array(totalNodes);
      const bfsQueue = new Int32Array(totalNodes);

      for (let startRegion = 0; startRegion < nextRegion; startRegion++) {
        dist.fill(-1);
        dist[startRegion] = 0;
        let head = 0;
        let tail = 0;
        bfsQueue[tail++] = startRegion;

        while (head < tail) {
          const u = bfsQueue[head++];

          if (u < nextRegion) {
            // u is a region node — expand to adjacent articulation nodes.
            for (const ai of regionToArts[u]) {
              const v = nextRegion + ai;
              if (dist[v] >= 0) continue;
              dist[v] = dist[u] + 1;
              bfsQueue[tail++] = v;
            }
          } else {
            // u is an articulation node — expand to adjacent regions and
            // adjacent articulation nodes.
            const ai = u - nextRegion;
            for (const rid of artToRegions[ai]) {
              if (dist[rid] >= 0) continue;
              dist[rid] = dist[u] + 1;
              bfsQueue[tail++] = rid;
            }
            for (const aj of artToArts[ai]) {
              const v = nextRegion + aj;
              if (dist[v] >= 0) continue;
              dist[v] = dist[u] + 1;
              bfsQueue[tail++] = v;
            }
          }
        }

        // Extract region-to-region distances. The bipartite BFS distance
        // between two region nodes is 2k where k = number of articulation
        // crossings, so crossings = dist / 2.
        for (let r = 0; r < nextRegion; r++) {
          if (dist[r] >= 0) {
            regionDist[startRegion * nextRegion + r] = dist[r] >>> 1;
          }
        }
      }
    }

    this.#regionDist = regionDist;
  }

  get stats(): DoorwayCrossingStats {
    return {
      evaluations: this.#evaluations,
      positiveResults: this.#positiveResults,
    };
  }

  evaluate(boxes: readonly DenseBox[]): number {
    this.#evaluations++;

    const board = this.#board;
    const regionId = this.#regionId;
    const regionCount = this.#regionCount;
    const regionDist = this.#regionDist;
    let totalCrossings = 0;

    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];

      // Skip boxes already on a matching goal.
      if (board.goalLabelByCell[box.cell] === box.label) continue;

      const matchingGoals = board.goalCellsByLabel.get(box.label);
      if (!matchingGoals || matchingGoals.length === 0) continue;

      const boxRegion = regionId[box.cell];

      let minCrossings = Infinity;

      for (let g = 0; g < matchingGoals.length; g++) {
        const goalCell = matchingGoals[g];
        const goalRegion = regionId[goalCell];

        if (boxRegion >= 0 && goalRegion >= 0) {
          // Both are in regular regions — look up precomputed distance.
          const d = regionDist[boxRegion * regionCount + goalRegion];
          if (d >= 0 && d < minCrossings) minCrossings = d;
        } else if (boxRegion >= 0 && goalRegion < 0) {
          // Goal is on an articulation point. Find the minimum crossing
          // distance from boxRegion to any region adjacent to the goal.
          // The final push onto the goal articulation cell is not counted
          // as a "crossing" (the box stops there), preserving admissibility.
          const goalArtNeighbors = board.neighbors[goalCell];
          let bestViaRegion = Infinity;
          for (let d = 0; d < goalArtNeighbors.length; d++) {
            const adj = goalArtNeighbors[d];
            if (adj < 0) continue;
            const adjRegion = regionId[adj];
            if (adjRegion >= 0) {
              const rd = regionDist[boxRegion * regionCount + adjRegion];
              if (rd >= 0 && rd < bestViaRegion) bestViaRegion = rd;
            }
          }
          if (bestViaRegion < minCrossings) minCrossings = bestViaRegion;
        } else if (boxRegion < 0 && goalRegion >= 0) {
          // Box is on an articulation point. Find the minimum crossing
          // distance from any region adjacent to the box to goalRegion.
          const boxArtNeighbors = board.neighbors[box.cell];
          let bestViaRegion = Infinity;
          for (let d = 0; d < boxArtNeighbors.length; d++) {
            const adj = boxArtNeighbors[d];
            if (adj < 0) continue;
            const adjRegion = regionId[adj];
            if (adjRegion >= 0) {
              const rd = regionDist[adjRegion * regionCount + goalRegion];
              if (rd >= 0 && rd < bestViaRegion) bestViaRegion = rd;
            }
          }
          if (bestViaRegion < minCrossings) minCrossings = bestViaRegion;
        } else {
          // Both are on articulation points. Find the minimum crossing
          // distance between any pair of their adjacent regions.
          const boxArtNeighbors = board.neighbors[box.cell];
          const goalArtNeighbors = board.neighbors[goalCell];
          let bestViaRegion = Infinity;

          // Check if they're the same cell.
          if (box.cell === goalCell) {
            bestViaRegion = 0;
          } else {
            // Check if they're directly adjacent articulation points.
            for (let d = 0; d < boxArtNeighbors.length; d++) {
              if (boxArtNeighbors[d] === goalCell) {
                bestViaRegion = 0;
                break;
              }
            }

            if (bestViaRegion > 0) {
              for (let db = 0; db < boxArtNeighbors.length; db++) {
                const adjBox = boxArtNeighbors[db];
                if (adjBox < 0) continue;
                const rBox = regionId[adjBox];
                if (rBox < 0) continue;
                for (let dg = 0; dg < goalArtNeighbors.length; dg++) {
                  const adjGoal = goalArtNeighbors[dg];
                  if (adjGoal < 0) continue;
                  const rGoal = regionId[adjGoal];
                  if (rGoal < 0) continue;
                  const rd = regionDist[rBox * regionCount + rGoal];
                  if (rd >= 0 && rd < bestViaRegion) bestViaRegion = rd;
                }
              }
            }
          }
          if (bestViaRegion < minCrossings) minCrossings = bestViaRegion;
        }
      }

      if (minCrossings > 0 && minCrossings < Infinity) {
        totalCrossings += minCrossings;
      }
    }

    if (totalCrossings > 0) {
      this.#positiveResults++;
    }

    return totalCrossings;
  }
}
