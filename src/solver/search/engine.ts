import {
  isSolverCancellation,
  throwIfSolverCancelled,
} from "../cancellation.ts";
import type {
  SolverExecutionContext,
  SolverProgress,
  SolverRequest,
  SolverResult,
  SolverRunMetrics,
} from "../contracts.ts";
import { verifySolverSolution } from "../verification.ts";
import {
  compileSearchBoard,
  SEARCH_DIRECTIONS,
  type CompiledSearchBoard,
} from "./compiled-board.ts";
import {
  createsFullyBlockedTwoByTwoDeadlock,
  hasFreezeDeadlock,
  isStaticDeadCell,
} from "./deadlocks.ts";
import {
  compareBoxes,
  comparePriority,
  estimatedMemoryBytes,
  estimateNodeBytes,
  fillDeadlockOccupancy,
  fillOccupancy,
  isSolved,
  objectiveScore,
  OPPOSITE_DIRECTION,
  reconstructSolution,
  type Frontier,
  type SearchCounters,
  type SearchNode,
  type StateKey,
} from "./exact-search-types.ts";
import { AssignmentHeuristic, minimumManhattanWalkToPotentialPush } from "./heuristic.ts";
import {
  toDenseBoxes,
  ZobristTable,
  type DenseBox,
} from "./model.ts";
import { createExactStateCodec, type ExactStateCodec } from "./exact-state.ts";
import {
  StablePriorityQueue,
} from "./priority-queue.ts";
import { KeeperReachability } from "./reachability.ts";

export type ClassicSearchStrategy = "dfs" | "greedy" | "astar";

export interface ClassicSearchConfiguration {
  readonly strategy: ClassicSearchStrategy;
}

export { OPPOSITE_DIRECTION } from "./exact-search-types.ts";
export type { Frontier, PushRecord, SearchCounters, SearchNode, StateKey } from "./exact-search-types.ts";
export const PROGRESS_INTERVAL_MS = 100;
export const YIELD_INTERVAL_MS = 10;
export const YIELD_WORK_INTERVAL = 256;

const SEGMENT_CAPACITY = 4096;

export class QueueFrontier implements Frontier {
  #segments: number[][] = [[]];
  #headSegment = 0;
  #headIndex = 0;
  #tailSegment = 0;
  #count = 0;

  get size(): number {
    return this.#count;
  }

  push(nodeIndex: number): void {
    let last = this.#segments[this.#tailSegment];
    if (!last || last.length >= SEGMENT_CAPACITY) {
      last = [];
      this.#tailSegment = this.#segments.length;
      this.#segments.push(last);
    }
    last.push(nodeIndex);
    this.#count += 1;
  }

  pop(): number | undefined {
    if (this.#count === 0) return undefined;
    const first = this.#segments[this.#headSegment];
    if (!first) return undefined;
    const value = first[this.#headIndex];
    this.#headIndex += 1;
    this.#count -= 1;
    if (this.#headIndex >= first.length) {
      this.#segments[this.#headSegment] = undefined as unknown as number[];
      this.#headSegment += 1;
      this.#headIndex = 0;
      if (this.#count === 0) {
        this.#segments = [[]];
        this.#headSegment = 0;
        this.#tailSegment = 0;
      }
    }
    return value;
  }
}

class StackFrontier implements Frontier {
  readonly #values: number[] = [];

  get size(): number {
    return this.#values.length;
  }

  push(nodeIndex: number): void {
    this.#values.push(nodeIndex);
  }

  pop(): number | undefined {
    return this.#values.pop();
  }
}

export function sortedBoxes(boxes: readonly DenseBox[]): readonly DenseBox[] {
  return [...boxes].sort(compareBoxes);
}

export function stateKey(robot: number, boxSignature: string): string {
  return `${String(robot)}|${boxSignature}`;
}

function nodePriority(
  strategy: ClassicSearchStrategy,
  moves: number,
  pushLowerBound: number,
): [number, number, number] {
  if (strategy === "astar") {
    return [moves + pushLowerBound, pushLowerBound, moves];
  }
  if (strategy === "greedy") {
    return [pushLowerBound, moves, 0];
  }
  return [0, 0, 0];
}

function occupancyFor(
  cellCount: number,
  boxes: readonly DenseBox[],
): Uint8Array {
  const occupied = new Uint8Array(cellCount);
  for (const box of boxes) occupied[box.cell] = 1;
  return occupied;
}

export { fillOccupancy, fillDeadlockOccupancy } from "./exact-search-types.ts";

export function movedBoxes(
  boxes: readonly DenseBox[],
  movedIndex: number,
  destination: number,
): readonly DenseBox[] {
  const src = boxes[movedIndex];
  const updated: DenseBox = { id: src.id, label: src.label, cell: destination };
  const result: DenseBox[] = new Array(boxes.length);
  let inserted = false;
  let j = 0;
  for (let i = 0; i < boxes.length; i++) {
    if (i === movedIndex) continue;
    if (!inserted && compareBoxes(updated, boxes[i]) <= 0) {
      result[j++] = updated;
      inserted = true;
    }
    result[j++] = boxes[i];
  }
  if (!inserted) result[j] = updated;
  return result;
}

export function estimateStaticSearchBytes(board: CompiledSearchBoard): number {
  const goalCount = [...board.goalCellsByLabel.values()].reduce(
    (total, cells) => total + cells.length,
    0,
  );
  // Includes topology, positions, position lookup, reverse-push tables, maps,
  // and the reusable reachability workspace with intentionally padded object
  // overhead.
  return (
    1_024 +
    board.cellCount * (80 + goalCount * Int32Array.BYTES_PER_ELEMENT) +
    board.cellByOffset.byteLength
  );
}

import { delayForEventLoop } from "./scheduling.ts";
export { delayForEventLoop } from "./scheduling.ts";

function createMetrics(
  context: SolverExecutionContext,
  startedAt: number,
  counters: SearchCounters,
  frontierSize: number,
  uniqueStates: number,
  retainedStates: number,
  heuristic: AssignmentHeuristic,
  staticBytes: number,
  boxCount: number,
): SolverRunMetrics {
  const heuristicStats = heuristic.stats;
  const memoryBytes = estimatedMemoryBytes(
    staticBytes,
    counters,
    uniqueStates,
    frontierSize,
    heuristicStats.cacheEntries,
    boxCount,
  );
  return {
    elapsedMs: Math.max(0, context.now() - startedAt),
    expandedStates: counters.expanded,
    generatedStates: counters.generated,
    peakFrontierSize: counters.peakFrontier,
    counters: {
      uniqueStates,
      retainedStates,
      duplicateStates: counters.duplicates,
      deadlockPrunes: counters.deadlockPrunes,
      patternDeadlockPrunes: counters.patternDeadlockPrunes,
      corralPrunes: counters.corralPrunes,
      commitmentSkips: counters.commitmentSkips,
      interactionBoostTotal: counters.interactionBoostTotal,
      infeasiblePrunes: counters.infeasiblePrunes,
      reopens: counters.reopens,
      reachabilityFloods: counters.reachabilityFloods,
      avoidedReachabilityFloods: counters.avoidedReachabilityFloods,
      heuristicCalls: heuristicStats.calls,
      heuristicCacheHits: heuristicStats.cacheHits,
      frontierSize,
      maxDepth: counters.maxDepth,
      estimatedMemoryBytes: memoryBytes,
    },
  };
}

function createProgress(
  phase: SolverProgress["phase"],
  detail: string,
  context: SolverExecutionContext,
  startedAt: number,
  counters: SearchCounters,
  frontierSize: number,
  uniqueStates: number,
  retainedStates: number,
  heuristic: AssignmentHeuristic,
  staticBytes: number,
  boxCount: number,
): SolverProgress {
  const metrics = createMetrics(
    context,
    startedAt,
    counters,
    frontierSize,
    uniqueStates,
    retainedStates,
    heuristic,
    staticBytes,
    boxCount,
  );
  return {
    phase,
    elapsedMs: metrics.elapsedMs,
    expandedStates: metrics.expandedStates,
    generatedStates: metrics.generatedStates,
    frontierSize,
    counters: metrics.counters,
    detail,
  };
}

/**
 * Shared push-macro engine used by the classic solver adapters.
 *
 * Every edge is a legal box push preceded by an exact shortest keeper walk.
 * Nodes retain only their parent index and push descriptor; walk segments are
 * recomputed once, after a goal is found.
 */
export async function runClassicSearch(
  request: SolverRequest,
  context: SolverExecutionContext,
  configuration: ClassicSearchConfiguration,
): Promise<SolverResult> {
  const startedAt = context.now();

  const counters: SearchCounters = {
    expanded: 0,
    generated: 0,
    duplicates: 0,
    deadlockPrunes: 0,
    patternDeadlockPrunes: 0,
    corralPrunes: 0,
    piCorralPrunes: 0,
    goalMacroPrunes: 0,
    deadlockTablePrunes: 0,
    commitmentSkips: 0,
    interactionBoostTotal: 0,
    infeasiblePrunes: 0,
    reopens: 0,
    reachabilityFloods: 0,
    avoidedReachabilityFloods: 0,
    retainedBytes: 0,
    peakFrontier: 0,
    maxDepth: 0,
  };
  let collectCurrentMetrics: (() => SolverRunMetrics) | undefined;

  try {
    throwIfSolverCancelled(context.signal);
    const board = compileSearchBoard(request.board);
    const heuristic = new AssignmentHeuristic(board);
    const reachability = new KeeperReachability(board);
    const childReachability = new KeeperReachability(board);
    const staticBytes = estimateStaticSearchBytes(board);
    const initialRobot = board.cellAt(
      request.snapshot.robot.row,
      request.snapshot.robot.column,
    );
    if (initialRobot < 0) {
      throw new Error("Solver snapshot robot is not on a compiled floor cell.");
    }
    const initialBoxes = sortedBoxes(
      toDenseBoxes(board, request.snapshot.boxes),
    );
    const labels = [...board.goalCellsByLabel.keys()].sort();
    const zobrist = new ZobristTable(board.cellCount, labels);
    const exactCodec: ExactStateCodec | null =
      configuration.strategy === "astar"
        ? createExactStateCodec(board.cellCount, labels)
        : null;

    context.reportProgress(
      createProgress(
        "preparing",
        `Preparing ${configuration.strategy.toUpperCase()} push search`,
        context,
        startedAt,
        counters,
        0,
        0,
        0,
        heuristic,
        staticBytes,
        initialBoxes.length,
      ),
    );
    throwIfSolverCancelled(context.signal);

    const initialOccupancy = occupancyFor(board.cellCount, initialBoxes);
    const initialReachable = reachability.flood(initialRobot, initialOccupancy);
    counters.reachabilityFloods += 1;

    function exactKey(robotCell: number, boxes: readonly DenseBox[]): bigint {
      const tokens = exactCodec!.tokensFromBoxes(boxes);
      return exactCodec!.packMoveState(robotCell, tokens);
    }

    // A* uses collision-free bigint identity via ExactStateCodec.
    // DFS/Greedy use Zobrist string keys (no proof-level optimality claim).
    const initialIdentityRobot = configuration.strategy === "astar"
      ? initialRobot
      : initialReachable.canonicalCell;
    const initialKey: StateKey = exactCodec
      ? exactKey(initialRobot, initialBoxes)
      : zobrist.stateKey(initialIdentityRobot, initialBoxes);
    const initialPushBound = heuristic.evaluate(initialBoxes);
    // A* walk augmentation: spec 8.3 requires h = push lower bound + walk lower bound.
    // Walk augmentation is only added for A* (exact proof); DFS/Greedy don't need it.
    const initialWalkBound = exactCodec
      ? minimumManhattanWalkToPotentialPush(board, initialRobot, initialBoxes)
      : 0;
    const initialHeuristic = initialPushBound + initialWalkBound;
    const [ip0, ip1, ip2] = nodePriority(
      configuration.strategy,
      0,
      initialHeuristic,
    );
    const initialNode: SearchNode = {
      robot: initialRobot,
      boxes: initialBoxes,
      key: initialKey,
      parentIndex: -1,
      moves: 0,
      pushes: 0,
      depth: 0,
      p0: ip0,
      p1: ip1,
      p2: ip2,
      estimatedBytes: estimateNodeBytes(initialBoxes.length, initialKey),
    };
    const nodes: SearchNode[] = [initialNode];
    counters.retainedBytes = initialNode.estimatedBytes;

    const heap =
      configuration.strategy === "astar" ||
      configuration.strategy === "greedy"
        ? new StablePriorityQueue<number>((leftIndex, rightIndex) => {
            const left = nodes[leftIndex];
            const right = nodes[rightIndex];
            if (!left || !right) return leftIndex - rightIndex;
            return comparePriority(left, right);
          })
        : undefined;
    const frontier: Frontier =
      configuration.strategy === "dfs"
        ? new StackFrontier()
        : {
              get size() {
                return heap?.size ?? 0;
              },
              push(nodeIndex) {
                heap?.enqueue(nodeIndex);
              },
              pop() {
                return heap?.dequeue();
              },
            };
    frontier.push(0);
    counters.peakFrontier = 1;

    // A* uses collision-free bigint keys; DFS/Greedy use Zobrist string keys.
    // Both paths flow through the same Map/Set typed by StateKey.
    const discovered = new Set<StateKey>([initialKey]);
    const bestNodeByKey = new Map<StateKey, number>([[initialKey, 0]]);
    const closed = new Set<StateKey>();
    let uniqueStates = 1;
    let lastProgressAt = context.now();
    let lastYieldAt = lastProgressAt;
    let workSinceYield = 0;

    const metrics = () =>
      createMetrics(
        context,
        startedAt,
        counters,
        frontier.size,
        uniqueStates,
        nodes.length,
        heuristic,
        staticBytes,
        initialBoxes.length,
      );
    collectCurrentMetrics = metrics;
    const report = (phase: SolverProgress["phase"], detail: string) => {
      context.reportProgress(
        createProgress(
          phase,
          detail,
          context,
          startedAt,
          counters,
          frontier.size,
          uniqueStates,
          nodes.length,
          heuristic,
          staticBytes,
          initialBoxes.length,
        ),
      );
    };
    const memoryLimitReached = () => {
      const maximum = request.limits?.maxMemoryBytes;
      if (maximum === undefined) return false;
      const stats = heuristic.stats;
      return (
        estimatedMemoryBytes(
          staticBytes,
          counters,
          uniqueStates,
          frontier.size,
          stats.cacheEntries,
          initialBoxes.length,
        ) > maximum
      );
    };
    const elapsedLimitReached = () => {
      const maximum = request.limits?.maxElapsedMs;
      return (
        maximum !== undefined &&
        Math.max(0, context.now() - startedAt) >= maximum
      );
    };

    report("searching", "Searching push states");
    throwIfSolverCancelled(context.signal);

    if (elapsedLimitReached()) {
      return {
        status: "unsolved",
        reason: "limit-reached",
        detail: "Maximum elapsed time reached during preparation.",
        metrics: metrics(),
      };
    }
    if (memoryLimitReached()) {
      return {
        status: "unsolved",
        reason: "limit-reached",
        detail: "Estimated solver memory limit reached during preparation.",
        metrics: metrics(),
      };
    }
    if (isSolved(board, initialBoxes)) {
      report("verifying", "Verifying candidate solution");
      throwIfSolverCancelled(context.signal);
      const solution = {
        steps: [],
        moves: 0,
        pushes: 0,
        objective: request.objective,
        objectiveScore: 0,
        optimality:
          configuration.strategy === "astar" ? "proven" : "unknown",
      } as const;
      const verification = verifySolverSolution(request, solution);
      if (!verification.valid) {
        throw new Error(`Classic solver verification failed: ${verification.message}`);
      }
      throwIfSolverCancelled(context.signal);
      return { status: "solved", solution, metrics: metrics() };
    }

    if (!Number.isFinite(initialHeuristic)) {
      counters.infeasiblePrunes += 1;
      return {
        status: "unsolved",
        reason: "exhausted",
        detail: "No label-compatible goal assignment is reachable.",
        metrics: metrics(),
      };
    }
    let limitDetail: string | undefined;

    // Pre-allocate reusable buffers to avoid per-node allocations in the hot loop.
    const occupancyBuffer = new Uint8Array(board.cellCount);
    const childOccupancyBuffer = new Uint8Array(board.cellCount);
    const deadlockOccupancyBuffer = new Int32Array(board.cellCount);

    searchLoop: while (frontier.size > 0) {
      throwIfSolverCancelled(context.signal);
      if (elapsedLimitReached()) {
        limitDetail = "Maximum elapsed time reached.";
        break;
      }

      const now = context.now();
      if (now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
        report("searching", "Searching push states");
        lastProgressAt = now;
      }
      if (
        now - lastYieldAt >= YIELD_INTERVAL_MS ||
        workSinceYield >= YIELD_WORK_INTERVAL
      ) {
        await delayForEventLoop();
        throwIfSolverCancelled(context.signal);
        lastYieldAt = context.now();
        workSinceYield = 0;
        if (elapsedLimitReached()) {
          limitDetail = "Maximum elapsed time reached.";
          break;
        }
      }

      const nodeIndex = frontier.pop();
      if (nodeIndex === undefined) break;
      const node = nodes[nodeIndex];
      if (!node) continue;

      if (configuration.strategy === "astar") {
        if (bestNodeByKey.get(node.key) !== nodeIndex) continue;
        if (closed.has(node.key)) continue;
      }

      if (isSolved(board, node.boxes)) {
        report("verifying", "Reconstructing and verifying candidate solution");
        throwIfSolverCancelled(context.signal);
        const steps = reconstructSolution(
          board,
          nodes,
          nodeIndex,
          reachability,
        );
        const pushes = steps.reduce(
          (total, step) => total + (step.kind === "push" ? 1 : 0),
          0,
        );
        if (steps.length !== node.moves || pushes !== node.pushes) {
          throw new Error(
            "Reconstructed path counters disagree with the selected search node.",
          );
        }
        const solution = {
          steps,
          moves: steps.length,
          pushes,
          objective: request.objective,
          objectiveScore: objectiveScore(steps.length),
          optimality:
            configuration.strategy === "astar" ? "proven" : "unknown",
        } as const;
        const verification = verifySolverSolution(request, solution);
        if (!verification.valid) {
          throw new Error(
            `Classic solver verification failed: ${verification.message}`,
          );
        }
        throwIfSolverCancelled(context.signal);
        return { status: "solved", solution, metrics: metrics() };
      }

      const maxExpanded = request.limits?.maxExpandedStates;
      if (
        maxExpanded !== undefined &&
        counters.expanded >= maxExpanded
      ) {
        limitDetail = "Maximum expanded-state count reached.";
        break;
      }

      counters.expanded += 1;
      workSinceYield += 1;
      if (configuration.strategy === "astar") closed.add(node.key);

      fillOccupancy(occupancyBuffer, node.boxes);
      const occupied = occupancyBuffer;
      const reachable = reachability.flood(node.robot, occupied);
      counters.reachabilityFloods += 1;
      const children: number[] = [];

      for (let boxIndex = 0; boxIndex < node.boxes.length; boxIndex += 1) {
        const box = node.boxes[boxIndex];
        if (!box) continue;
        const neighbors = board.neighbors[box.cell];
        if (!neighbors) continue;

        for (
          let directionIndex = 0;
          directionIndex < SEARCH_DIRECTIONS.length;
          directionIndex += 1
        ) {
          const destination = neighbors[directionIndex] ?? -1;
          const opposite = OPPOSITE_DIRECTION[directionIndex];
          const support =
            opposite === undefined ? -1 : (neighbors[opposite] ?? -1);
          if (
            destination < 0 ||
            support < 0 ||
            occupied[destination] !== 0 ||
            !reachable.isReachable(support)
          ) {
            continue;
          }

          const maxGenerated = request.limits?.maxGeneratedStates;
          if (
            maxGenerated !== undefined &&
            counters.generated >= maxGenerated
          ) {
            limitDetail = "Maximum generated-state count reached.";
            break searchLoop;
          }
          counters.generated += 1;
          workSinceYield += 1;

          if (isStaticDeadCell(board, destination, box.label)) {
            counters.deadlockPrunes += 1;
            continue;
          }

          const boxes = movedBoxes(node.boxes, boxIndex, destination);
          fillDeadlockOccupancy(deadlockOccupancyBuffer, boxes);
          if (
            createsFullyBlockedTwoByTwoDeadlock(board, boxes, destination, deadlockOccupancyBuffer)
          ) {
            counters.deadlockPrunes += 1;
            continue;
          }

          if (hasFreezeDeadlock(board, boxes, deadlockOccupancyBuffer)) {
            counters.deadlockPrunes += 1;
            continue;
          }

          const distance = reachable.distanceTo(support);
          if (distance < 0) {
            throw new Error("Reachable support cell has no keeper distance.");
          }
          const moves = node.moves + distance + 1;
          const pushes = node.pushes + 1;

          // A* uses collision-free ExactStateCodec bigint identity.
          // DFS/Greedy use Zobrist string keys (no optimality proof).
          // Both defer expensive work until after cheap pruning checks.
          let childKey: StateKey;
          if (exactCodec) {
            childKey = exactKey(box.cell, boxes);
            const bestIndex = bestNodeByKey.get(childKey);
            const best = bestIndex === undefined ? undefined : nodes[bestIndex];
            if (best && moves >= best.moves) {
              counters.duplicates += 1;
              continue;
            }
          } else {
            childKey = zobrist.stateKey(box.cell, boxes);
          }

          const pushLowerBound = heuristic.evaluate(boxes);
          const maxMemoryAfterHeuristic = request.limits?.maxMemoryBytes;
          if (
            maxMemoryAfterHeuristic !== undefined &&
            estimatedMemoryBytes(
              staticBytes,
              counters,
              uniqueStates,
              frontier.size,
              heuristic.stats.cacheEntries,
              initialBoxes.length,
            ) > maxMemoryAfterHeuristic
          ) {
            limitDetail = "Estimated solver memory limit reached.";
            break searchLoop;
          }
          if (!Number.isFinite(pushLowerBound)) {
            counters.infeasiblePrunes += 1;
            continue;
          }

          // For DFS/Greedy, compute canonical-cell key via flood after
          // pruning. A* key is already final (collision-free bigint).
          if (!exactCodec) {
            fillOccupancy(childOccupancyBuffer, boxes);
            const childReachable = childReachability.flood(box.cell, childOccupancyBuffer);
            counters.reachabilityFloods += 1;
            const canonicalRobot = childReachable.canonicalCell;
            childKey = zobrist.stateKey(canonicalRobot, boxes);
            if (discovered.has(childKey)) {
              counters.duplicates += 1;
              continue;
            }
          } else {
            counters.avoidedReachabilityFloods += 1;
          }

          // A* walk augmentation (spec 8.3): h = push lower bound + walk lower bound.
          // The walk bound is admissible and disjoint from push cost, so adding
          // it preserves admissibility. Only applied for A* (exact proof mode).
          // After pushing, the robot is at box.cell (the cell the box vacated).
          const walkBound = exactCodec
            ? minimumManhattanWalkToPotentialPush(board, box.cell, boxes)
            : 0;
          const heuristic_h = pushLowerBound + walkBound;

          const [cp0, cp1, cp2] = nodePriority(
            configuration.strategy,
            moves,
            heuristic_h,
          );
          const candidate: SearchNode = {
            robot: box.cell,
            boxes,
            key: childKey,
            parentIndex: nodeIndex,
            push: { boxCell: box.cell, directionIndex },
            moves,
            pushes,
            depth: node.depth + 1,
            p0: cp0,
            p1: cp1,
            p2: cp2,
            estimatedBytes: estimateNodeBytes(boxes.length, childKey),
          };

          const projectedBytes = counters.retainedBytes + candidate.estimatedBytes;
          const maxMemory = request.limits?.maxMemoryBytes;
          if (maxMemory !== undefined) {
            const stats = heuristic.stats;
            const projectedMemory = Math.ceil(
              staticBytes +
                projectedBytes +
                (uniqueStates + 1) * 96 +
                (frontier.size + 1) * 56 +
                stats.cacheEntries * (160 + initialBoxes.length * 24),
            );
            if (projectedMemory > maxMemory) {
              limitDetail = "Estimated solver memory limit reached.";
              break searchLoop;
            }
          }

          const childIndex = nodes.length;
          nodes.push(candidate);
          counters.retainedBytes = projectedBytes;
          counters.maxDepth = Math.max(counters.maxDepth, candidate.depth);

          if (configuration.strategy === "astar") {
            const previous = bestNodeByKey.get(childKey);
            if (previous === undefined) {
              uniqueStates += 1;
            } else if (closed.delete(childKey)) {
              counters.reopens += 1;
            }
            bestNodeByKey.set(childKey, childIndex);
          } else {
            discovered.add(childKey);
            uniqueStates += 1;
          }
          children.push(childIndex);
        }
      }

      if (configuration.strategy === "dfs") children.reverse();
      for (const childIndex of children) frontier.push(childIndex);
      counters.peakFrontier = Math.max(
        counters.peakFrontier,
        frontier.size,
      );
    }

    if (limitDetail) {
      return {
        status: "unsolved",
        reason: "limit-reached",
        detail: limitDetail,
        metrics: metrics(),
      };
    }
    return {
      status: "unsolved",
      reason: "exhausted",
      metrics: metrics(),
    };
  } catch (error) {
    if (isSolverCancellation(error) || context.signal.aborted) {
      return {
        status: "cancelled",
        metrics: collectCurrentMetrics?.() ?? {
          elapsedMs: Math.max(0, context.now() - startedAt),
          expandedStates: counters.expanded,
          generatedStates: counters.generated,
          peakFrontierSize: counters.peakFrontier,
          counters: {
            uniqueStates: 0,
            retainedStates: 0,
            duplicateStates: counters.duplicates,
            deadlockPrunes: counters.deadlockPrunes,
            patternDeadlockPrunes: counters.patternDeadlockPrunes,
            infeasiblePrunes: counters.infeasiblePrunes,
            reopens: counters.reopens,
            reachabilityFloods: counters.reachabilityFloods,
            avoidedReachabilityFloods: counters.avoidedReachabilityFloods,
            heuristicCalls: 0,
            heuristicCacheHits: 0,
            frontierSize: 0,
            maxDepth: counters.maxDepth,
            estimatedMemoryBytes: 0,
          },
        },
      };
    }
    throw error;
  }
}
