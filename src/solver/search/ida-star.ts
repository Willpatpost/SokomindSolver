import { isSolverCancellation, throwIfSolverCancelled } from "../cancellation.ts";
import type {
  SolutionStep,
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
import { AssignmentHeuristic, minimumManhattanWalkToPotentialPush } from "./heuristic.ts";
import { toDenseBoxes, type DenseBox } from "./model.ts";
import { KeeperReachability, type KeeperReachabilityResult, type ReachabilitySnapshot } from "./reachability.ts";
import { createExactStateCodec, type ExactStateCodec } from "./exact-state.ts";
import {
  sortedBoxes,
  movedBoxes,
  fillOccupancy,
  fillDeadlockOccupancy,
  delayForEventLoop,
  estimateStaticSearchBytes,
  OPPOSITE_DIRECTION,
  PROGRESS_INTERVAL_MS,
  YIELD_INTERVAL_MS,
  YIELD_WORK_INTERVAL,
} from "./engine.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PushRecord {
  readonly boxCell: number;
  readonly directionIndex: number;
}

/**
 * Stack frame for iterative DFS. Each frame carries all the state needed to
 * generate successors. The `childCursor` field tracks which successor to
 * generate next, allowing the frame to be resumed after a child subtree
 * completes.
 *
 * The BFS reachability state is saved after the first flood and restored
 * when child generation resumes, avoiding redundant re-floods.
 */
interface StackFrame {
  readonly robot: number;
  readonly boxes: readonly DenseBox[];
  readonly exactKey: bigint;
  readonly moves: number;
  readonly pushes: number;
  readonly g: number;
  readonly push?: PushRecord;
  /** Frozen box flags (computed once at expansion, stable across resumes). */
  frozenBoxes: boolean[] | null;
  /** Which (boxIndex * 4 + directionIndex) to try next. */
  childCursor: number;
  /** Whether this node has been expanded (passed f-bound, TT, solved checks). */
  expanded: boolean;
  /** Saved BFS state after the initial flood, restored on child-return resumes. */
  reachabilitySnapshot: ReachabilitySnapshot | null;
  /** Cached flood result paired with the snapshot. */
  cachedReachable: KeeperReachabilityResult | null;
  /** Conservative retained bytes excluding the reachability snapshot. */
  estimatedStackBytes: number;
  /** Conservative retained bytes for the saved reachability state/result. */
  estimatedReachabilityBytes: number;
}

interface SearchCounters {
  expanded: number;
  generated: number;
  duplicates: number;
  deadlockPrunes: number;
  infeasiblePrunes: number;
  reachabilityFloods: number;
  peakStackDepth: number;
  maxDepth: number;
  iterations: number;
}

interface IdaMemoryBreakdown {
  readonly staticBytes: number;
  readonly transpositionBytes: number;
  readonly heuristicCacheBytes: number;
  readonly dfsStackBytes: number;
  readonly reachabilitySnapshotBytes: number;
  readonly currentBytes: number;
}

interface IdaMemorySnapshot extends IdaMemoryBreakdown {
  readonly peakBytes: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isSolved(
  board: CompiledSearchBoard,
  boxes: readonly DenseBox[],
): boolean {
  return boxes.every(
    (box) => board.goalLabelByCell[box.cell] === box.label,
  );
}

/**
 * Identify frozen boxes: boxes on their matching goal and locked on both
 * axes by walls or other frozen boxes. Uses a fixpoint loop.
 */
function identifyFrozenBoxes(
  board: CompiledSearchBoard,
  boxes: readonly DenseBox[],
  boxIndexByCell: Int32Array,
): boolean[] {
  const frozen = new Array<boolean>(boxes.length).fill(false);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < boxes.length; i++) {
      if (frozen[i]) continue;
      const box = boxes[i];
      if (board.goalLabelByCell[box.cell] !== box.label) continue;

      const neighbors = board.neighbors[box.cell];
      if (!neighbors) continue;

      const leftCell = neighbors[2] ?? -1;
      const rightCell = neighbors[3] ?? -1;
      const horizontalLocked =
        (leftCell < 0 || isFrozenBoxAt(leftCell, boxIndexByCell, frozen)) ||
        (rightCell < 0 || isFrozenBoxAt(rightCell, boxIndexByCell, frozen));

      const upCell = neighbors[0] ?? -1;
      const downCell = neighbors[1] ?? -1;
      const verticalLocked =
        (upCell < 0 || isFrozenBoxAt(upCell, boxIndexByCell, frozen)) ||
        (downCell < 0 || isFrozenBoxAt(downCell, boxIndexByCell, frozen));

      if (horizontalLocked && verticalLocked) {
        frozen[i] = true;
        changed = true;
      }
    }
  }
  return frozen;
}

function isFrozenBoxAt(
  cell: number,
  boxIndexByCell: Int32Array,
  frozen: boolean[],
): boolean {
  const idx = boxIndexByCell[cell] ?? -1;
  return idx >= 0 && frozen[idx];
}

const IDA_RUNTIME_BASE_BYTES = 2_048;
const IDA_REUSABLE_BUFFER_BASE_BYTES = 256;
const IDA_HEURISTIC_WORKSPACE_BASE_BYTES = 512;
const IDA_TRANSPOSITION_BASE_BYTES = 256;
const IDA_DFS_STACK_BASE_BYTES = 128;

/**
 * Static reservation for allocations that exist for the whole IDA* run.
 *
 * The shared compiled-board estimate already includes topology, reverse-push
 * tables, maps, and the reusable reachability workspace. IDA* adds its two
 * occupancy buffers plus a padded worst-case assignment matrix workspace.
 * Counting the transient heuristic workspace for the full run is deliberate:
 * memory limits are conservative ceilings rather than heap-profiler samples.
 */
function estimateIdaStaticBytes(
  board: CompiledSearchBoard,
  boxCount: number,
): number {
  const reusableBufferBytes =
    IDA_REUSABLE_BUFFER_BASE_BYTES +
    board.cellCount *
      (Uint8Array.BYTES_PER_ELEMENT + Int32Array.BYTES_PER_ELEMENT);
  const heuristicWorkspaceBytes =
    IDA_HEURISTIC_WORKSPACE_BASE_BYTES +
    boxCount * 160 +
    boxCount * boxCount * 16;
  return Math.ceil(
    estimateStaticSearchBytes(board) +
      IDA_RUNTIME_BASE_BYTES +
      reusableBufferBytes +
      heuristicWorkspaceBytes,
  );
}

function estimateHeuristicCacheBytes(
  cacheEntries: number,
  boxCount: number,
): number {
  // Mirrors the deliberately padded cache-entry estimate in classic search.
  return cacheEntries * (160 + boxCount * 24);
}

function estimateTranspositionEntryBytes(): number {
  // Map entry, numeric g-cost, and the retained bigint identity key.
  return 128 + 64;
}

function estimateStackFrameBytes(
  boxes: readonly DenseBox[],
  hasPush: boolean,
): number {
  // Frame/array overhead, canonical box records, bigint key, and push record.
  return (
    448 +
    boxes.length * 80 +
    64 +
    (hasPush ? 64 : 0)
  );
}

function estimateFrozenBoxesBytes(boxCount: number): number {
  return 64 + boxCount * 8;
}

function estimateReachabilitySnapshotBytes(cellCount: number): number {
  // Four copied typed arrays (13 payload bytes/cell), their headers, and the
  // cached reachability result with its bound query closures.
  return 640 + cellCount * 13;
}

function estimateIdaCurrentBytes(
  staticBytes: number,
  transpositionBytes: number,
  heuristicCacheBytes: number,
  dfsStackBytes: number,
  reachabilitySnapshotBytes: number,
): number {
  return Math.ceil(
    staticBytes +
      transpositionBytes +
      heuristicCacheBytes +
      dfsStackBytes +
      reachabilitySnapshotBytes,
  );
}

function estimateIdaMemory(
  staticBytes: number,
  transpositionBytes: number,
  heuristicCacheEntries: number,
  boxCount: number,
  dfsStackBytes: number,
  reachabilitySnapshotBytes: number,
): IdaMemoryBreakdown {
  const heuristicCacheBytes = estimateHeuristicCacheBytes(
    heuristicCacheEntries,
    boxCount,
  );
  return Object.freeze({
    staticBytes,
    transpositionBytes,
    heuristicCacheBytes,
    dfsStackBytes,
    reachabilitySnapshotBytes,
    currentBytes: estimateIdaCurrentBytes(
      staticBytes,
      transpositionBytes,
      heuristicCacheBytes,
      dfsStackBytes,
      reachabilitySnapshotBytes,
    ),
  });
}

function createMetrics(
  context: SolverExecutionContext,
  startedAt: number,
  counters: SearchCounters,
  transpositionSize: number,
  heuristic: AssignmentHeuristic,
  memory: IdaMemorySnapshot,
): SolverRunMetrics {
  const heuristicStats = heuristic.stats;
  return {
    elapsedMs: Math.max(0, context.now() - startedAt),
    expandedStates: counters.expanded,
    generatedStates: counters.generated,
    peakFrontierSize: counters.peakStackDepth,
    counters: {
      uniqueStates: transpositionSize,
      retainedStates: transpositionSize,
      duplicateStates: counters.duplicates,
      deadlockPrunes: counters.deadlockPrunes,
      infeasiblePrunes: counters.infeasiblePrunes,
      reopens: 0,
      reachabilityFloods: counters.reachabilityFloods,
      identityFloods: 0,
      heuristicCalls: heuristicStats.calls,
      heuristicCacheHits: heuristicStats.cacheHits,
      frontierSize: 0,
      maxDepth: counters.maxDepth,
      estimatedMemoryBytes: memory.currentBytes,
      currentEstimatedMemoryBytes: memory.currentBytes,
      peakEstimatedMemoryBytes: memory.peakBytes,
      memoryStaticBytes: memory.staticBytes,
      memoryTranspositionBytes: memory.transpositionBytes,
      memoryHeuristicCacheBytes: memory.heuristicCacheBytes,
      memoryDfsStackBytes: memory.dfsStackBytes,
      memoryReachabilitySnapshotBytes: memory.reachabilitySnapshotBytes,
      idaStarIterations: counters.iterations,
    },
  };
}

/**
 * Reconstruct the full move+push sequence from the current path stack.
 * Each frame on the stack (except the root) has a push record; the parent
 * frame (one level up) holds the boxes BEFORE that push.
 */
function reconstructSolution(
  board: CompiledSearchBoard,
  stack: readonly StackFrame[],
  initialRobot: number,
  reachability: KeeperReachability,
): readonly SolutionStep[] {
  const steps: SolutionStep[] = [];
  let currentRobot = initialRobot;
  const occupancyBuffer = new Uint8Array(board.cellCount);

  for (let i = 1; i < stack.length; i++) {
    const frame = stack[i];
    const parentFrame = stack[i - 1];
    const push = frame.push;
    if (!push) {
      throw new Error("IDA* path frame missing push record.");
    }

    const support =
      board.neighbors[push.boxCell]?.[
        OPPOSITE_DIRECTION[push.directionIndex] ?? -1
      ] ?? -1;

    fillOccupancy(occupancyBuffer, parentFrame.boxes);

    const reachable = reachability.flood(currentRobot, occupancyBuffer);
    const walk = reachable.pathTo(support);
    const pushDirection = SEARCH_DIRECTIONS[push.directionIndex]?.direction;
    if (!walk || !pushDirection) {
      throw new Error("IDA* solution path contains an unreachable push.");
    }

    for (const direction of walk) {
      steps.push({ direction, kind: "walk" });
    }
    steps.push({ direction: pushDirection, kind: "push" });

    currentRobot = push.boxCell;
  }

  return steps;
}

// ---------------------------------------------------------------------------
// Main IDA* search
// ---------------------------------------------------------------------------

export async function runIdaStarSearch(
  request: SolverRequest,
  context: SolverExecutionContext,
): Promise<SolverResult> {
  const startedAt = context.now();
  const counters: SearchCounters = {
    expanded: 0,
    generated: 0,
    duplicates: 0,
    deadlockPrunes: 0,
    infeasiblePrunes: 0,
    reachabilityFloods: 0,
    peakStackDepth: 0,
    maxDepth: 0,
    iterations: 0,
  };
  let transpositionSize = 0;
  let collectCurrentMetrics: (() => SolverRunMetrics) | undefined;

  try {
    throwIfSolverCancelled(context.signal);
    const board = compileSearchBoard(request.board);
    const heuristic = new AssignmentHeuristic(board);
    const reachability = new KeeperReachability(board);

    const initialRobot = board.cellAt(
      request.snapshot.robot.row,
      request.snapshot.robot.column,
    );
    if (initialRobot < 0) {
      throw new Error(
        "Solver snapshot robot is not on a compiled floor cell.",
      );
    }
    const initialBoxes = sortedBoxes(
      toDenseBoxes(board, request.snapshot.boxes),
    );
    const labels = [...board.goalCellsByLabel.keys()].sort();
    const exactCodec: ExactStateCodec = createExactStateCodec(board.cellCount, labels);

    function exactKey(robotCell: number, boxes: readonly DenseBox[]): bigint {
      const tokens = exactCodec.tokensFromBoxes(boxes);
      return exactCodec.packMoveState(robotCell, tokens);
    }

    const staticMemoryBytes = estimateIdaStaticBytes(
      board,
      initialBoxes.length,
    );
    let transpositionMemoryBytes = 0;
    let dfsStackMemoryBytes = 0;
    let reachabilitySnapshotMemoryBytes = 0;
    let heuristicCacheEntries = 0;
    let peakEstimatedMemoryBytes = 0;

    const currentMemory = (): IdaMemoryBreakdown =>
      estimateIdaMemory(
        staticMemoryBytes,
        transpositionMemoryBytes,
        heuristicCacheEntries,
        initialBoxes.length,
        dfsStackMemoryBytes,
        reachabilitySnapshotMemoryBytes,
      );
    const memorySnapshot = (): IdaMemorySnapshot => {
      const breakdown = currentMemory();
      peakEstimatedMemoryBytes = Math.max(
        peakEstimatedMemoryBytes,
        breakdown.currentBytes,
      );
      return Object.freeze({
        ...breakdown,
        peakBytes: peakEstimatedMemoryBytes,
      });
    };
    const recordCurrentMemory = (): number => {
      const currentBytes = estimateIdaCurrentBytes(
        staticMemoryBytes,
        transpositionMemoryBytes,
        estimateHeuristicCacheBytes(
          heuristicCacheEntries,
          initialBoxes.length,
        ),
        dfsStackMemoryBytes,
        reachabilitySnapshotMemoryBytes,
      );
      peakEstimatedMemoryBytes = Math.max(
        peakEstimatedMemoryBytes,
        currentBytes,
      );
      return currentBytes;
    };
    const memoryLimitReached = () => {
      const currentBytes = recordCurrentMemory();
      const maximum = request.limits?.maxMemoryBytes;
      return maximum !== undefined && currentBytes > maximum;
    };

    const metrics = () =>
      createMetrics(
        context,
        startedAt,
        counters,
        transpositionSize,
        heuristic,
        memorySnapshot(),
      );
    collectCurrentMetrics = metrics;

    const report = (phase: SolverProgress["phase"], detail: string) => {
      context.reportProgress({
        phase,
        elapsedMs: Math.max(0, context.now() - startedAt),
        expandedStates: counters.expanded,
        generatedStates: counters.generated,
        frontierSize: 0,
        counters: metrics().counters,
        detail,
      });
    };

    report("preparing", "Preparing IDA* push search");
    throwIfSolverCancelled(context.signal);

    if (memoryLimitReached()) {
      return {
        status: "unsolved",
        reason: "limit-reached",
        detail: "Estimated solver memory limit reached during preparation.",
        metrics: metrics(),
      };
    }

    // Already solved?
    if (isSolved(board, initialBoxes)) {
      report("verifying", "Verifying candidate solution");
      throwIfSolverCancelled(context.signal);
      const solution = {
        steps: [] as readonly SolutionStep[],
        moves: 0,
        pushes: 0,
        objective: request.objective,
        objectiveScore: 0,
        optimality: "proven" as const,
      };
      const verification = verifySolverSolution(request, solution);
      if (!verification.valid) {
        throw new Error(
          `IDA* solver verification failed: ${verification.message}`,
        );
      }
      return { status: "solved", solution, metrics: metrics() };
    }

    // Initial heuristic (push-only lower bound + walk augmentation)
    const initialHPush = heuristic.evaluate(initialBoxes);
    heuristicCacheEntries = heuristic.stats.cacheEntries;
    if (memoryLimitReached()) {
      return {
        status: "unsolved",
        reason: "limit-reached",
        detail: "Estimated solver memory limit reached during preparation.",
        metrics: metrics(),
      };
    }
    if (!Number.isFinite(initialHPush)) {
      counters.infeasiblePrunes += 1;
      return {
        status: "unsolved",
        reason: "exhausted",
        detail: "No label-compatible goal assignment is reachable.",
        metrics: metrics(),
      };
    }
    const initialHWalk = minimumManhattanWalkToPotentialPush(
      board,
      initialRobot,
      initialBoxes,
    );
    const initialH = initialHPush + initialHWalk;

    const initialExactKey = exactKey(initialRobot, initialBoxes);
    const initialG = 0;

    // Pre-allocate reusable buffers
    const occupancyBuffer = new Uint8Array(board.cellCount);
    const deadlockOccupancyBuffer = new Int32Array(board.cellCount);

    const elapsedLimitReached = () => {
      const maximum = request.limits?.maxElapsedMs;
      return (
        maximum !== undefined &&
        Math.max(0, context.now() - startedAt) >= maximum
      );
    };

    // -------------------------------------------------------------------
    // IDA* main loop
    // -------------------------------------------------------------------
    let fLimit = initialG + initialH;
    let limitDetail: string | undefined;

    // Persistent transposition table: retained across IDA* iterations.
    //
    // Entries are only inserted for states that pass the f-bound check
    // (f <= fLimit), so every stored (key → g) pair represents a state
    // that was fully explored at that g-cost under some prior threshold.
    // When a later iteration with a higher f-limit revisits the same
    // state, the g-cost dominance check (previousG <= frame.g) correctly
    // prunes paths that are no better than what was already explored.
    // States reached via a strictly better path (lower g) will update
    // the entry and be re-explored, preserving optimality.
    //
    // A size limit prevents unbounded memory growth: if the table exceeds
    // the memory budget, it is cleared and rebuilt from scratch in the
    // current iteration.
    let transposition = new Map<bigint, number>();
    transpositionMemoryBytes = IDA_TRANSPOSITION_BASE_BYTES;

    idaLoop: while (true) {
      counters.iterations += 1;
      let nextLimit = Number.POSITIVE_INFINITY;

      // Clear the transposition table each iteration. States explored
      // at g-cost G in iteration N were f-pruned at f > fLimit(N).
      // In iteration N+1 with a higher fLimit, the same states need
      // re-exploration because their children may now pass the f-bound.
      transposition = new Map<bigint, number>();
      transpositionSize = 0;
      transpositionMemoryBytes = IDA_TRANSPOSITION_BASE_BYTES;

      // Path stack: current DFS path from root to active node.
      const pathStack: StackFrame[] = [];
      dfsStackMemoryBytes = IDA_DFS_STACK_BASE_BYTES;
      reachabilitySnapshotMemoryBytes = 0;

      const pushFrame = (frame: StackFrame) => {
        pathStack.push(frame);
        dfsStackMemoryBytes += frame.estimatedStackBytes;
        reachabilitySnapshotMemoryBytes +=
          frame.estimatedReachabilityBytes;
      };
      const popFrame = (): StackFrame | undefined => {
        const frame = pathStack.pop();
        if (!frame) return undefined;
        dfsStackMemoryBytes -= frame.estimatedStackBytes;
        reachabilitySnapshotMemoryBytes -=
          frame.estimatedReachabilityBytes;
        return frame;
      };

      report(
        "searching",
        `IDA* iteration ${counters.iterations}, f-limit=${fLimit}`,
      );
      throwIfSolverCancelled(context.signal);

      if (elapsedLimitReached()) {
        limitDetail = "Maximum elapsed time reached.";
        break;
      }

      const rootFrame: StackFrame = {
        robot: initialRobot,
        boxes: initialBoxes,
        exactKey: initialExactKey,
        moves: 0,
        pushes: 0,
        g: initialG,
        frozenBoxes: null,
        childCursor: 0,
        expanded: false,
        reachabilitySnapshot: null,
        cachedReachable: null,
        estimatedStackBytes: estimateStackFrameBytes(
          initialBoxes,
          false,
        ),
        estimatedReachabilityBytes: 0,
      };
      pushFrame(rootFrame);

      let lastProgressAt = context.now();
      let lastYieldAt = lastProgressAt;
      let workSinceYield = 0;

      while (pathStack.length > 0) {
        throwIfSolverCancelled(context.signal);

        if (elapsedLimitReached()) {
          limitDetail = "Maximum elapsed time reached.";
          break idaLoop;
        }

        const now = context.now();
        if (now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
          report(
            "searching",
            `IDA* iteration ${counters.iterations}, f-limit=${fLimit}, depth=${pathStack.length - 1}`,
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
            break idaLoop;
          }
        }

        if (memoryLimitReached()) {
          limitDetail = "Estimated solver memory limit reached.";
          break idaLoop;
        }

        const frame = pathStack[pathStack.length - 1];

        // ----- First visit: f-bound, TT, solved check, mark expanded -----
        if (!frame.expanded) {
          const hPush = heuristic.evaluate(frame.boxes);
          heuristicCacheEntries = heuristic.stats.cacheEntries;
          if (memoryLimitReached()) {
            limitDetail = "Estimated solver memory limit reached.";
            break idaLoop;
          }
          if (!Number.isFinite(hPush)) {
            counters.infeasiblePrunes += 1;
            popFrame();
            continue;
          }

          const hWalk = minimumManhattanWalkToPotentialPush(
            board,
            frame.robot,
            frame.boxes,
          );
          const h = hPush + hWalk;

          const f = frame.g + h;
          if (f > fLimit) {
            nextLimit = Math.min(nextLimit, f);
            popFrame();
            continue;
          }

          // Transposition check (collision-free bigint identity)
          const previousG = transposition.get(frame.exactKey);
          if (previousG !== undefined && previousG <= frame.g) {
            counters.duplicates += 1;
            popFrame();
            continue;
          }
          transposition.set(frame.exactKey, frame.g);
          if (previousG === undefined) {
            transpositionSize += 1;
            transpositionMemoryBytes += estimateTranspositionEntryBytes();
          }
          if (memoryLimitReached()) {
            limitDetail = "Estimated solver memory limit reached.";
            break idaLoop;
          }

          // Solved?
          if (isSolved(board, frame.boxes)) {
            report(
              "verifying",
              "Reconstructing and verifying IDA* solution",
            );
            throwIfSolverCancelled(context.signal);
            transpositionSize = transposition.size;

            const steps = reconstructSolution(
              board,
              pathStack,
              initialRobot,
              reachability,
            );
            const pushCount = steps.reduce(
              (total, step) => total + (step.kind === "push" ? 1 : 0),
              0,
            );
            const solution = {
              steps,
              moves: steps.length,
              pushes: pushCount,
              objective: request.objective,
              objectiveScore: steps.length,
              optimality: "proven" as const,
            };
            const verification = verifySolverSolution(request, solution);
            if (!verification.valid) {
              throw new Error(
                `IDA* solver verification failed: ${verification.message}`,
              );
            }
            throwIfSolverCancelled(context.signal);
            return { status: "solved", solution, metrics: metrics() };
          }

          // Expansion limit
          const maxExpanded = request.limits?.maxExpandedStates;
          if (
            maxExpanded !== undefined &&
            counters.expanded >= maxExpanded
          ) {
            limitDetail = "Maximum expanded-state count reached.";
            break idaLoop;
          }

          counters.expanded += 1;
          workSinceYield += 1;
          counters.maxDepth = Math.max(
            counters.maxDepth,
            pathStack.length - 1,
          );
          counters.peakStackDepth = Math.max(
            counters.peakStackDepth,
            pathStack.length,
          );

          // Compute frozen boxes (stable, does not depend on reachability workspace)
          fillDeadlockOccupancy(deadlockOccupancyBuffer, frame.boxes);
          const frozenBoxes = identifyFrozenBoxes(
            board,
            frame.boxes,
            deadlockOccupancyBuffer,
          );
          frame.frozenBoxes = frozenBoxes;
          const frozenBoxesBytes = estimateFrozenBoxesBytes(
            frozenBoxes.length,
          );
          frame.estimatedStackBytes += frozenBoxesBytes;
          dfsStackMemoryBytes += frozenBoxesBytes;
          if (memoryLimitReached()) {
            limitDetail = "Estimated solver memory limit reached.";
            break idaLoop;
          }

          frame.expanded = true;
          frame.childCursor = 0;
        }

        // ----- Generate the next valid child -----
        // Restore saved BFS state when resuming after a child subtree,
        // avoiding a full re-flood of the reachability workspace.
        fillOccupancy(occupancyBuffer, frame.boxes);
        let reachable: KeeperReachabilityResult;
        if (frame.reachabilitySnapshot !== null) {
          reachability.restoreState(frame.reachabilitySnapshot);
          reachable = frame.cachedReachable!;
        } else {
          reachable = reachability.flood(frame.robot, occupancyBuffer);
          counters.reachabilityFloods += 1;
          frame.reachabilitySnapshot = reachability.saveState();
          frame.cachedReachable = reachable;
          const snapshotBytes = estimateReachabilitySnapshotBytes(
            board.cellCount,
          );
          frame.estimatedReachabilityBytes += snapshotBytes;
          reachabilitySnapshotMemoryBytes += snapshotBytes;
          if (memoryLimitReached()) {
            limitDetail = "Estimated solver memory limit reached.";
            break idaLoop;
          }
        }

        const frozenBoxes = frame.frozenBoxes!;
        const boxCount = frame.boxes.length;
        const totalChildren = boxCount * SEARCH_DIRECTIONS.length;
        let foundChild = false;

        while (frame.childCursor < totalChildren) {
          const cursor = frame.childCursor;
          frame.childCursor += 1;

          const boxIndex = Math.floor(cursor / SEARCH_DIRECTIONS.length);
          const directionIndex = cursor % SEARCH_DIRECTIONS.length;

          if (frozenBoxes[boxIndex]) continue;

          const box = frame.boxes[boxIndex];
          if (!box) continue;
          const neighbors = board.neighbors[box.cell];
          if (!neighbors) continue;

          const destination = neighbors[directionIndex] ?? -1;
          const opposite = OPPOSITE_DIRECTION[directionIndex];
          const support =
            opposite === undefined
              ? -1
              : (neighbors[opposite] ?? -1);

          if (
            destination < 0 ||
            support < 0 ||
            occupancyBuffer[destination] !== 0 ||
            !reachable.isReachable(support)
          ) {
            continue;
          }

          // Generation limit
          const maxGenerated = request.limits?.maxGeneratedStates;
          if (
            maxGenerated !== undefined &&
            counters.generated >= maxGenerated
          ) {
            limitDetail = "Maximum generated-state count reached.";
            break idaLoop;
          }
          counters.generated += 1;
          workSinceYield += 1;

          // Static dead cell
          if (isStaticDeadCell(board, destination, box.label)) {
            counters.deadlockPrunes += 1;
            continue;
          }

          // Move box
          const newBoxes = movedBoxes(frame.boxes, boxIndex, destination);
          fillDeadlockOccupancy(deadlockOccupancyBuffer, newBoxes);
          if (
            createsFullyBlockedTwoByTwoDeadlock(
              board,
              newBoxes,
              destination,
              deadlockOccupancyBuffer,
            )
          ) {
            counters.deadlockPrunes += 1;
            continue;
          }

          if (hasFreezeDeadlock(board, newBoxes, deadlockOccupancyBuffer)) {
            counters.deadlockPrunes += 1;
            continue;
          }

          const distance = reachable.distanceTo(support);
          if (distance < 0) {
            throw new Error(
              "Reachable support cell has no keeper distance.",
            );
          }

          const newMoves = frame.moves + distance + 1;
          const newPushes = frame.pushes + 1;
          const newG = newMoves;
          const newExactKey = exactKey(box.cell, newBoxes);

          const childFrame: StackFrame = {
            robot: box.cell,
            boxes: newBoxes,
            exactKey: newExactKey,
            moves: newMoves,
            pushes: newPushes,
            g: newG,
            push: { boxCell: box.cell, directionIndex },
            frozenBoxes: null,
            childCursor: 0,
            expanded: false,
            reachabilitySnapshot: null,
            cachedReachable: null,
            estimatedStackBytes: estimateStackFrameBytes(
              newBoxes,
              true,
            ),
            estimatedReachabilityBytes: 0,
          };

          pushFrame(childFrame);
          if (memoryLimitReached()) {
            limitDetail = "Estimated solver memory limit reached.";
            break idaLoop;
          }
          foundChild = true;
          break; // Process child before continuing with siblings
        }

        // No more children: backtrack
        if (!foundChild) {
          popFrame();
        }
      }

      transpositionSize = transposition.size;

      if (nextLimit === Number.POSITIVE_INFINITY) {
        return {
          status: "unsolved",
          reason: "exhausted",
          metrics: metrics(),
        };
      }

      fLimit = nextLimit;
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
      let cancellationMetrics = collectCurrentMetrics?.();
      if (!cancellationMetrics) {
        const fallbackBoard = compileSearchBoard(request.board);
        const fallbackHeuristic = new AssignmentHeuristic(fallbackBoard);
        const fallbackStaticBytes = estimateIdaStaticBytes(
          fallbackBoard,
          request.snapshot.boxes.length,
        );
        const fallbackBreakdown = estimateIdaMemory(
          fallbackStaticBytes,
          0,
          0,
          request.snapshot.boxes.length,
          0,
          0,
        );
        cancellationMetrics = createMetrics(
          context,
          startedAt,
          counters,
          transpositionSize,
          fallbackHeuristic,
          Object.freeze({
            ...fallbackBreakdown,
            peakBytes: fallbackBreakdown.currentBytes,
          }),
        );
      }
      return {
        status: "cancelled",
        metrics: cancellationMetrics,
      };
    }
    throw error;
  }
}
