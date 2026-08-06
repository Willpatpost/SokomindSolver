import {
  isSolverCancellation,
  throwIfSolverCancelled,
} from "../cancellation.ts";
import type {
  SolverExecutionContext,
  SolverProgress,
  SolverProof,
  SolverRequest,
  SolverResult,
  SolverRunMetrics,
  SolverSolution,
} from "../contracts.ts";
import { verifySolverSolution } from "../verification.ts";
import {
  compileSearchBoard,
  SEARCH_DIRECTIONS,
} from "./compiled-board.ts";
import { createCompactNodeArena } from "./compact-node-arena.ts";
import {
  createsFullyBlockedTwoByTwoDeadlock,
  hasFreezeDeadlock,
  isStaticDeadCell,
} from "./deadlocks.ts";
import {
  estimatedArenaMemoryBytes,
  fillDeadlockOccupancy,
  fillOccupancy,
  isSolved,
  objectiveScore,
  OPPOSITE_DIRECTION,
  reconstructFromArena,
  type SearchCounters,
} from "./exact-search-types.ts";
import {
  AssignmentHeuristic,
  minimumManhattanWalkToPotentialPush,
} from "./heuristic.ts";
import { toDenseBoxes, type DenseBox } from "./model.ts";
import { createExactStateCodec } from "./exact-state.ts";
import { NumericPriorityQueue } from "./numeric-priority-queue.ts";
import { KeeperReachability } from "./reachability.ts";
import {
  sortedBoxes,
  estimateStaticSearchBytes,
  delayForEventLoop,
} from "./engine.ts";

export interface ExactIncumbent {
  readonly solution: SolverSolution;
  readonly cost: number;
}

export interface ExactMoveAStarOptions {
  readonly incumbent?: ExactIncumbent;
}

const PROGRESS_INTERVAL_MS = 100;
const YIELD_INTERVAL_MS = 10;
const YIELD_WORK_INTERVAL = 256;

function createMetrics(
  context: SolverExecutionContext,
  startedAt: number,
  counters: SearchCounters,
  frontierSize: number,
  uniqueStates: number,
  arenaSize: number,
  heuristic: AssignmentHeuristic,
  staticBytes: number,
  boxCount: number,
  arenaRetainedBytes: number,
): SolverRunMetrics {
  const heuristicStats = heuristic.stats;
  const memoryBytes = estimatedArenaMemoryBytes(
    staticBytes,
    arenaRetainedBytes,
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
      retainedStates: arenaSize,
      duplicateStates: counters.duplicates,
      deadlockPrunes: counters.deadlockPrunes,
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
  arenaSize: number,
  heuristic: AssignmentHeuristic,
  staticBytes: number,
  boxCount: number,
  arenaRetainedBytes: number,
  incumbentInfo: { moves: number; pushes: number; objectiveScore: number } | undefined,
  lowerBound: number | undefined,
  upperBound: number | undefined,
): SolverProgress {
  const metrics = createMetrics(
    context,
    startedAt,
    counters,
    frontierSize,
    uniqueStates,
    arenaSize,
    heuristic,
    staticBytes,
    boxCount,
    arenaRetainedBytes,
  );
  return {
    phase,
    elapsedMs: metrics.elapsedMs,
    expandedStates: metrics.expandedStates,
    generatedStates: metrics.generatedStates,
    frontierSize,
    counters: metrics.counters,
    detail,
    ...(incumbentInfo ? { incumbent: incumbentInfo } : {}),
    ...(lowerBound !== undefined ? { lowerBound } : {}),
    ...(upperBound !== undefined ? { upperBound } : {}),
    ...(lowerBound !== undefined && upperBound !== undefined
      ? { gap: upperBound - lowerBound }
      : {}),
  };
}

function sortedInsertToken(
  src: Uint32Array,
  count: number,
  removeIndex: number,
  newToken: number,
  out: Uint32Array,
): void {
  let j = 0;
  let inserted = false;
  for (let i = 0; i < count; i++) {
    if (i === removeIndex) continue;
    if (!inserted && newToken <= src[i]) {
      out[j++] = newToken;
      inserted = true;
    }
    out[j++] = src[i];
  }
  if (!inserted) out[j] = newToken;
}

export async function runExactMoveAStar(
  request: SolverRequest,
  context: SolverExecutionContext,
  options?: ExactMoveAStarOptions,
): Promise<SolverResult> {
  const startedAt = context.now();

  const counters: SearchCounters = {
    expanded: 0,
    generated: 0,
    duplicates: 0,
    deadlockPrunes: 0,
    infeasiblePrunes: 0,
    reopens: 0,
    reachabilityFloods: 0,
    avoidedReachabilityFloods: 0,
    retainedBytes: 0,
    peakFrontier: 0,
    maxDepth: 0,
  };
  let collectCurrentMetrics: (() => SolverRunMetrics) | undefined;
  let incumbentSolution: SolverSolution | null =
    options?.incumbent?.solution ?? null;
  let U = options?.incumbent?.cost ?? Infinity;
  let lastLowerBound = 0;

  try {
    throwIfSolverCancelled(context.signal);
    const board = compileSearchBoard(request.board);
    const { cellCount } = board;
    const labels = [...board.goalCellsByLabel.keys()].sort();
    const heuristic = new AssignmentHeuristic(board);
    const reachability = new KeeperReachability(board);
    const exactCodec = createExactStateCodec(cellCount, labels);
    const staticBytes = estimateStaticSearchBytes(board);
    const labelCount = labels.length;
    const labelToId = new Map<string, number>();
    for (let i = 0; i < labels.length; i++) labelToId.set(labels[i], i);

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
    const boxCount = initialBoxes.length;

    const initialOccupancy = new Uint8Array(cellCount);
    for (const box of initialBoxes) initialOccupancy[box.cell] = 1;
    reachability.flood(initialRobot, initialOccupancy);
    counters.reachabilityFloods += 1;

    const maxToken = labelCount * cellCount - 1;
    const arena = createCompactNodeArena(boxCount, maxToken);

    const parentTokenBuf = new Uint32Array(boxCount);
    const childTokenBuf = new Uint32Array(boxCount);

    const expansionBoxes: DenseBox[] = new Array(boxCount);
    for (let i = 0; i < boxCount; i++) {
      expansionBoxes[i] = { id: initialBoxes[i].id, label: initialBoxes[i].label, cell: initialBoxes[i].cell };
    }

    function tokenToCell(token: number): number {
      return token % cellCount;
    }

    function tokenToLabelId(token: number): number {
      return (token / cellCount) | 0;
    }

    const initialTokens = exactCodec.tokensFromBoxes(initialBoxes);
    const initialKey = exactCodec.packMoveState(initialRobot, initialTokens);
    const initialPushBound = heuristic.evaluate(initialBoxes);
    const initialWalkBound = minimumManhattanWalkToPotentialPush(
      board,
      initialRobot,
      initialBoxes,
    );
    const initialH = initialPushBound + initialWalkBound;
    lastLowerBound = initialH;

    let heapSize = 0;
    let uniqueStates = 0;

    const metrics = () =>
      createMetrics(
        context,
        startedAt,
        counters,
        heapSize,
        uniqueStates,
        arena.size,
        heuristic,
        staticBytes,
        boxCount,
        arena.estimatedRetainedBytes(),
      );
    collectCurrentMetrics = metrics;

    const incumbentInfo = () =>
      incumbentSolution
        ? {
            moves: incumbentSolution.moves,
            pushes: incumbentSolution.pushes,
            objectiveScore: incumbentSolution.objectiveScore,
          }
        : undefined;

    const report = (phase: SolverProgress["phase"], detail: string) => {
      context.reportProgress(
        createProgress(
          phase,
          detail,
          context,
          startedAt,
          counters,
          heapSize,
          uniqueStates,
          arena.size,
          heuristic,
          staticBytes,
          boxCount,
          arena.estimatedRetainedBytes(),
          incumbentInfo(),
          incumbentSolution ? lastLowerBound : undefined,
          incumbentSolution ? U : undefined,
        ),
      );
    };

    const elapsedLimitReached = () => {
      const maximum = request.limits?.maxElapsedMs;
      return (
        maximum !== undefined &&
        Math.max(0, context.now() - startedAt) >= maximum
      );
    };

    const memoryLimitReached = () => {
      const maximum = request.limits?.maxMemoryBytes;
      if (maximum === undefined) return false;
      const stats = heuristic.stats;
      return (
        estimatedArenaMemoryBytes(
          staticBytes,
          arena.estimatedRetainedBytes(),
          uniqueStates,
          heapSize,
          stats.cacheEntries,
          boxCount,
        ) > maximum
      );
    };

    const makeOptimalProof = (): SolverProof => ({
      objective: request.objective,
      kind: "optimal",
      algorithm: "move-astar",
      lowerBound: U,
      upperBound: U,
      gap: 0,
    });

    const makeBoundedProof = (lb: number): SolverProof => ({
      objective: request.objective,
      kind: "bounded",
      algorithm: "move-astar",
      lowerBound: lb,
      upperBound: U,
      gap: U - lb,
    });

    const makeUnsolvableProof = (): SolverProof => ({
      objective: request.objective,
      kind: "unsolvable",
      algorithm: "move-astar",
    });

    const finishSolvedOptimal = (): SolverResult => ({
      status: "solved",
      solution: {
        ...incumbentSolution!,
        optimality: "proven",
      },
      metrics: metrics(),
      proof: makeOptimalProof(),
    });

    const finishSolvedBounded = (lb: number): SolverResult => {
      if (lb >= U) return finishSolvedOptimal();
      return {
        status: "solved",
        solution: incumbentSolution!,
        metrics: metrics(),
        proof: makeBoundedProof(lb),
      };
    };

    report("preparing", "Preparing exact A* search");
    throwIfSolverCancelled(context.signal);

    if (elapsedLimitReached()) {
      if (incumbentSolution) {
        return finishSolvedBounded(0);
      }
      return {
        status: "unsolved",
        reason: "limit-reached",
        detail: "Maximum elapsed time reached during preparation.",
        metrics: metrics(),
      };
    }
    if (memoryLimitReached()) {
      if (incumbentSolution) {
        return finishSolvedBounded(0);
      }
      return {
        status: "unsolved",
        reason: "limit-reached",
        detail: "Estimated solver memory limit reached during preparation.",
        metrics: metrics(),
      };
    }

    if (isSolved(board, initialBoxes)) {
      if (0 < U) {
        const solution: SolverSolution = {
          steps: [],
          moves: 0,
          pushes: 0,
          objective: request.objective,
          objectiveScore: 0,
          optimality: "proven",
        };
        const verification = verifySolverSolution(request, solution);
        if (!verification.valid) {
          throw new Error(
            `Exact A* verification failed: ${verification.message}`,
          );
        }
        U = 0;
        incumbentSolution = solution;
      }
      return finishSolvedOptimal();
    }

    if (!Number.isFinite(initialH)) {
      counters.infeasiblePrunes += 1;
      return {
        status: "unsolved",
        reason: "exhausted",
        detail: "No label-compatible goal assignment is reachable.",
        metrics: metrics(),
        proof: makeUnsolvableProof(),
      };
    }

    if (initialH >= U) {
      return finishSolvedOptimal();
    }

    const rootIndex = arena.allocate();
    arena.setRobotCell(rootIndex, initialRobot);
    arena.setGMoves(rootIndex, 0);
    arena.setPushes(rootIndex, 0);
    arena.setParentNode(rootIndex, -1);
    arena.setPushedFromCell(rootIndex, 0);
    arena.setPushDirection(rootIndex, 0);
    arena.setHeuristic(rootIndex, initialH);
    arena.writeBoxTokens(rootIndex, initialTokens);
    counters.retainedBytes = arena.estimatedRetainedBytes();

    const heap = new NumericPriorityQueue(
      (a: number, b: number) => {
        const fa = arena.gMoves(a) + arena.heuristic(a);
        const fb = arena.gMoves(b) + arena.heuristic(b);
        if (fa !== fb) return fa - fb;
        return arena.heuristic(a) - arena.heuristic(b);
      },
    );
    heap.enqueue(rootIndex);
    heapSize = 1;
    counters.peakFrontier = 1;

    const bestG = new Map<bigint, number>([[initialKey, 0]]);
    uniqueStates = 1;
    let lastProgressAt = context.now();
    let lastYieldAt = lastProgressAt;
    let workSinceYield = 0;

    const occupancyBuffer = new Uint8Array(cellCount);
    const deadlockOccupancyBuffer = new Int32Array(cellCount);

    report(
      incumbentSolution ? "proving" : "searching",
      incumbentSolution ? "Proving optimality" : "Searching for solution",
    );
    throwIfSolverCancelled(context.signal);

    let limitDetail: string | undefined;

    const syncState = () => { heapSize = heap.size; };

    searchLoop: while (heap.size > 0) {
      throwIfSolverCancelled(context.signal);
      if (elapsedLimitReached()) {
        limitDetail = "Maximum elapsed time reached.";
        break;
      }

      const now = context.now();
      if (now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
        report(
          incumbentSolution ? "proving" : "searching",
          incumbentSolution ? "Proving optimality" : "Searching for solution",
        );
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

      const nodeIndex = heap.dequeue();
      if (nodeIndex === undefined) break;
      syncState();

      arena.readBoxTokens(nodeIndex, parentTokenBuf);
      const nodeKey = exactCodec.packMoveState(arena.robotCell(nodeIndex), parentTokenBuf);
      const nodeMoves = arena.gMoves(nodeIndex);

      if (bestG.get(nodeKey) !== nodeMoves) continue;

      const L = nodeMoves + arena.heuristic(nodeIndex);
      lastLowerBound = L;

      if (L >= U) {
        return finishSolvedOptimal();
      }

      for (let b = 0; b < boxCount; b++) {
        const token = parentTokenBuf[b];
        const mbox = expansionBoxes[b] as { label: string; cell: number };
        mbox.label = labels[tokenToLabelId(token)];
        mbox.cell = tokenToCell(token);
      }

      if (isSolved(board, expansionBoxes)) {
        if (nodeMoves < U) {
          report("improving", "Found improved incumbent, verifying");
          throwIfSolverCancelled(context.signal);
          const steps = reconstructFromArena(
            board,
            arena,
            nodeIndex,
            reachability,
          );
          const pushes = steps.reduce(
            (total, step) => total + (step.kind === "push" ? 1 : 0),
            0,
          );
          if (steps.length !== nodeMoves || pushes !== arena.pushes(nodeIndex)) {
            throw new Error(
              "Reconstructed path counters disagree with the selected search node.",
            );
          }
          const solution: SolverSolution = {
            steps,
            moves: steps.length,
            pushes,
            objective: request.objective,
            objectiveScore: objectiveScore(steps.length),
            optimality: "unknown",
          };
          const verification = verifySolverSolution(request, solution);
          if (!verification.valid) {
            throw new Error(
              `Exact A* verification failed: ${verification.message}`,
            );
          }
          U = nodeMoves;
          incumbentSolution = solution;
          throwIfSolverCancelled(context.signal);

          if (L >= U) {
            return finishSolvedOptimal();
          }
          report("proving", "Proving optimality of incumbent");
        }
        continue;
      }

      const maxExpanded = request.limits?.maxExpandedStates;
      if (maxExpanded !== undefined && counters.expanded >= maxExpanded) {
        limitDetail = "Maximum expanded-state count reached.";
        break;
      }

      counters.expanded += 1;
      workSinceYield += 1;

      fillOccupancy(occupancyBuffer, expansionBoxes);
      const occupied = occupancyBuffer;
      const robotCell = arena.robotCell(nodeIndex);
      const reachable = reachability.flood(robotCell, occupied);
      counters.reachabilityFloods += 1;

      for (let boxIndex = 0; boxIndex < boxCount; boxIndex += 1) {
        const box = expansionBoxes[boxIndex];
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
            syncState();
            break searchLoop;
          }
          counters.generated += 1;
          workSinceYield += 1;

          if (isStaticDeadCell(board, destination, box.label)) {
            counters.deadlockPrunes += 1;
            continue;
          }

          const savedCell = expansionBoxes[boxIndex].cell;
          (expansionBoxes[boxIndex] as { cell: number }).cell = destination;

          fillDeadlockOccupancy(deadlockOccupancyBuffer, expansionBoxes);
          if (
            createsFullyBlockedTwoByTwoDeadlock(
              board,
              expansionBoxes,
              destination,
              deadlockOccupancyBuffer,
            )
          ) {
            (expansionBoxes[boxIndex] as { cell: number }).cell = savedCell;
            counters.deadlockPrunes += 1;
            continue;
          }

          if (hasFreezeDeadlock(board, expansionBoxes, deadlockOccupancyBuffer)) {
            (expansionBoxes[boxIndex] as { cell: number }).cell = savedCell;
            counters.deadlockPrunes += 1;
            continue;
          }

          const distance = reachable.distanceTo(support);
          if (distance < 0) {
            (expansionBoxes[boxIndex] as { cell: number }).cell = savedCell;
            throw new Error("Reachable support cell has no keeper distance.");
          }
          const childMoves = nodeMoves + distance + 1;
          const childPushes = arena.pushes(nodeIndex) + 1;

          const oldToken = parentTokenBuf[boxIndex];
          const newLabelId = tokenToLabelId(oldToken);
          const newToken = newLabelId * cellCount + destination;
          sortedInsertToken(parentTokenBuf, boxCount, boxIndex, newToken, childTokenBuf);

          const childKey = exactCodec.packMoveState(savedCell, childTokenBuf);
          const prevBestG = bestG.get(childKey);
          if (prevBestG !== undefined && childMoves >= prevBestG) {
            (expansionBoxes[boxIndex] as { cell: number }).cell = savedCell;
            counters.duplicates += 1;
            continue;
          }

          const pushLowerBound = heuristic.evaluate(expansionBoxes);
          const maxMemoryAfterHeuristic = request.limits?.maxMemoryBytes;
          if (
            maxMemoryAfterHeuristic !== undefined &&
            estimatedArenaMemoryBytes(
              staticBytes,
              arena.estimatedRetainedBytes(),
              uniqueStates,
              heap.size,
              heuristic.stats.cacheEntries,
              boxCount,
            ) > maxMemoryAfterHeuristic
          ) {
            (expansionBoxes[boxIndex] as { cell: number }).cell = savedCell;
            limitDetail = "Estimated solver memory limit reached.";
            syncState();
            break searchLoop;
          }
          if (!Number.isFinite(pushLowerBound)) {
            (expansionBoxes[boxIndex] as { cell: number }).cell = savedCell;
            counters.infeasiblePrunes += 1;
            continue;
          }

          counters.avoidedReachabilityFloods += 1;

          const walkBound = minimumManhattanWalkToPotentialPush(
            board,
            savedCell,
            expansionBoxes,
          );
          const h = pushLowerBound + walkBound;
          const f = childMoves + h;

          (expansionBoxes[boxIndex] as { cell: number }).cell = savedCell;

          if (f >= U) {
            continue;
          }

          const projectedArenaBytes = arena.estimatedRetainedBytes() + arena.estimatedBytesPerNode();
          const maxMemory = request.limits?.maxMemoryBytes;
          if (maxMemory !== undefined) {
            const stats = heuristic.stats;
            const projectedMemory = estimatedArenaMemoryBytes(
              staticBytes,
              projectedArenaBytes,
              uniqueStates + 1,
              heap.size + 1,
              stats.cacheEntries,
              boxCount,
            );
            if (projectedMemory > maxMemory) {
              limitDetail = "Estimated solver memory limit reached.";
              syncState();
              break searchLoop;
            }
          }

          const childIndex = arena.allocate();
          arena.setRobotCell(childIndex, box.cell);
          arena.setGMoves(childIndex, childMoves);
          arena.setPushes(childIndex, childPushes);
          arena.setParentNode(childIndex, nodeIndex);
          arena.setPushedFromCell(childIndex, box.cell);
          arena.setPushDirection(childIndex, directionIndex);
          arena.setHeuristic(childIndex, h);
          arena.writeBoxTokens(childIndex, childTokenBuf);
          counters.retainedBytes = arena.estimatedRetainedBytes();
          counters.maxDepth = Math.max(counters.maxDepth, childPushes);

          if (prevBestG === undefined) {
            uniqueStates += 1;
          } else {
            counters.reopens += 1;
          }
          bestG.set(childKey, childMoves);
          heap.enqueue(childIndex);
          syncState();
          counters.peakFrontier = Math.max(counters.peakFrontier, heap.size);
        }
      }
    }

    syncState();
    if (limitDetail) {
      if (incumbentSolution) {
        const peekIndex = heap.size > 0 ? heap.peek() : undefined;
        let bestL = lastLowerBound;
        if (peekIndex !== undefined) {
          bestL = arena.gMoves(peekIndex) + arena.heuristic(peekIndex);
        }
        return finishSolvedBounded(bestL);
      }
      const m = metrics();
      let cutoffLB = lastLowerBound;
      const peekIdx = heap.size > 0 ? heap.peek() : undefined;
      if (peekIdx !== undefined) {
        cutoffLB = arena.gMoves(peekIdx) + arena.heuristic(peekIdx);
      }
      return {
        status: "unsolved",
        reason: "limit-reached",
        detail: limitDetail,
        metrics: {
          ...m,
          counters: { ...m.counters, lowerBound: cutoffLB },
        },
      };
    }

    if (incumbentSolution) {
      return finishSolvedOptimal();
    }
    return {
      status: "unsolved",
      reason: "exhausted",
      metrics: metrics(),
      proof: makeUnsolvableProof(),
    };
  } catch (error) {
    if (isSolverCancellation(error) || context.signal.aborted) {
      const cancelMetrics = collectCurrentMetrics?.() ?? {
        elapsedMs: Math.max(0, context.now() - startedAt),
        expandedStates: counters.expanded,
        generatedStates: counters.generated,
        peakFrontierSize: counters.peakFrontier,
        counters: {
          uniqueStates: 0,
          retainedStates: 0,
          duplicateStates: counters.duplicates,
          deadlockPrunes: counters.deadlockPrunes,
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
      };
      if (incumbentSolution && U < Infinity) {
        const boundedProof: SolverProof =
          lastLowerBound >= U
            ? {
                objective: request.objective,
                kind: "optimal",
                algorithm: "move-astar",
                lowerBound: U,
                upperBound: U,
                gap: 0,
              }
            : {
                objective: request.objective,
                kind: "bounded",
                algorithm: "move-astar",
                lowerBound: lastLowerBound,
                upperBound: U,
                gap: U - lastLowerBound,
              };
        return {
          status: "solved",
          solution: incumbentSolution,
          metrics: cancelMetrics,
          proof: boundedProof,
        };
      }
      return {
        status: "cancelled",
        metrics: cancelMetrics,
      };
    }
    throw error;
  }
}
