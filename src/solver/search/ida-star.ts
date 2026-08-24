import { isSolverCancellation, throwIfSolverCancelled } from "../cancellation.ts";
import type { IdaStarCheckpoint } from "./ida-star-checkpoint.ts";
import {
  createBoardContentKey,
  IDA_STAR_CHECKPOINT_SCHEMA_VERSION,
} from "./ida-star-checkpoint.ts";
import type {
  SolutionStep,
  SolverExecutionContext,
  SolverProgress,
  SolverProof,
  SolverRequest,
  SolverResult,
  SolverRunMetrics,
  SolverSolution,
} from "../contracts.ts";
import { verifySolverSolution } from "../verification.ts";
import type { ExactIncumbent } from "./exact-move-astar.ts";
export type { ExactIncumbent } from "./exact-move-astar.ts";
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
  createsPatternDeadlock,
  PatternDeadlockCache,
} from "./pattern-deadlock.ts";
import {
  hasPiCorralDeadlock,
  PiCorralDetector,
} from "./pi-corral.ts";
import {
  findProvenCommitments,
  GoalCommitmentDetector,
  hasPotentialGoalCommitment,
} from "./goal-commitment.ts";
import { buildDeadlockTablesAsync } from "./deadlock-tables.ts";
import { ForcedPushMacroDetector } from "./forced-push-macros.ts";
import { TunnelMacroDetector } from "./tunnel-macros.ts";
import {
  hasPotentialInteractionBoost,
  InteractionBoostEvaluator,
  isExactInteractionSearchLimitError,
} from "./interaction-boost.ts";
import { AssignmentHeuristic, PdbHeuristicEvaluator, minimumManhattanWalkToPotentialPush, minimumReachableWalkToLegalPush } from "./heuristic.ts";
import { toDenseBoxes, type DenseBox } from "./model.ts";
import { KeeperReachability, type KeeperReachabilityResult, type ReachabilitySnapshot } from "./reachability.ts";
import { createExactStateCodec, type ExactStateCodec } from "./exact-state.ts";
import { createZobristTable, type ZobristTable } from "./zobrist-state.ts";
import {
  sortedBoxes,
  movedBoxes,
  estimateStaticSearchBytes,
  OPPOSITE_DIRECTION,
  PROGRESS_INTERVAL_MS,
  YIELD_INTERVAL_MS,
  YIELD_WORK_INTERVAL,
} from "./engine.ts";
import { delayForEventLoop } from "./scheduling.ts";
import { fillOccupancy, fillDeadlockOccupancy, isSolved, objectiveScore } from "./exact-search-types.ts";
import {
  createExactSearchFeatureTelemetry,
  exactSearchFeatureMask,
  isDefaultExactSearchFeatures,
  resolveExactSearchFeatures,
  type ExactSearchFeatures,
} from "./exact-search-features.ts";
import {
  checkExactPreprocessingBudget,
  isExactPreprocessingLimitError,
  type ExactPreprocessingBudget,
} from "./preprocessing-budget.ts";

// ---------------------------------------------------------------------------
// Public options
// ---------------------------------------------------------------------------

export type IdaReachabilityPolicy = "all" | "periodic" | "none";

export interface ExactMoveIdaStarOptions {
  readonly incumbent?: ExactIncumbent;
  /** Exclusive move-cost ceiling. Unlike an incumbent, this carries no route. */
  readonly upperBound?: number;
  readonly reachabilityPolicy?: IdaReachabilityPolicy;
  readonly snapshotPeriod?: number;
  readonly upperBoundChannel?: import("./exact-move-astar.ts").UpperBoundChannel;
  readonly checkpoint?: import("./ida-star-checkpoint.ts").IdaStarCheckpoint;
  readonly onCheckpoint?: (checkpoint: import("./ida-star-checkpoint.ts").IdaStarCheckpoint) => void;
  readonly checkpointContext?: {
    readonly boardContentKey: string;
    readonly solverVersion: string;
    readonly exactStateCodecVersion: number;
    readonly partitionId: string | null;
  };
  /**
   * Retained for request compatibility. Exact IDA* always uses a contour-local
   * best-g dominance table: backed f-values are path-dependent and are never
   * safe transposition bounds. Persistence across contours is deliberately
   * disabled for proof-producing search.
   */
  readonly persistTransposition?: boolean;
  /** Internal deterministic feature vector used by controlled proof A/B runs. */
  readonly features?: Partial<ExactSearchFeatures>;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PushRecord {
  readonly boxCell: number;
  readonly directionIndex: number;
  readonly pushCount?: number;
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
  readonly zobristKey: number;
  readonly moves: number;
  readonly pushes: number;
  readonly g: number;
  readonly push?: PushRecord;
  /** Frozen box flags (computed once at expansion, stable across resumes). */
  frozenBoxes: boolean[] | null;
  /** Proven committed box indices (computed once at first child generation). */
  committedBoxes: ReadonlySet<number> | null;
  /** Which (boxIndex * 4 + directionIndex) to try next. */
  childCursor: number;
  tunnelMacro: {
    readonly stops: readonly import("./tunnel-macros.ts").TunnelMacroStop[];
    readonly boxIndex: number;
    readonly directionIndex: number;
    readonly walkDistance: number;
    cursor: number;
  } | null;
  /** Whether this node has been expanded (passed f-bound, TT, solved checks). */
  expanded: boolean;
  /** Heuristic value at expansion (for TT-IDA* backed-up f computation). */
  h: number;
  /** Minimum f-value among explored/pruned children (for TT-IDA* backing up). */
  minChildF: number;
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
  patternDeadlockPrunes: number;
  corralPrunes: number;
  piCorralPrunes: number;
  deadlockTablePrunes: number;
  commitmentSkips: number;
  interactionBoostTotal: number;
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
  macroStats?: { checks: number; applications: number },
  featureCounters?: () => Readonly<Record<string, number>>,
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
      patternDeadlockPrunes: counters.patternDeadlockPrunes,
      corralPrunes: counters.corralPrunes,
      piCorralPrunes: counters.piCorralPrunes,
      deadlockTablePrunes: counters.deadlockTablePrunes,
      commitmentSkips: counters.commitmentSkips,
      interactionBoostTotal: counters.interactionBoostTotal,
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
      forcedPushMacroApplications: macroStats?.applications ?? 0,
      ...featureCounters?.(),
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
    const pc = push.pushCount ?? 1;
    for (let p = 0; p < pc; p++) {
      steps.push({ direction: pushDirection, kind: "push" });
    }

    let robotAfter = push.boxCell;
    for (let p = 1; p < pc; p++) {
      robotAfter = board.neighbors[robotAfter]?.[push.directionIndex] ?? robotAfter;
    }
    currentRobot = robotAfter;
  }

  return steps;
}

// ---------------------------------------------------------------------------
// Main IDA* search
// ---------------------------------------------------------------------------

export async function runIdaStarSearch(
  request: SolverRequest,
  context: SolverExecutionContext,
  options?: ExactMoveIdaStarOptions,
): Promise<SolverResult> {
  const startedAt = context.now();
  const features = resolveExactSearchFeatures(options?.features);
  const featureTelemetry = createExactSearchFeatureTelemetry();
  if (
    !isDefaultExactSearchFeatures(features) &&
    (options?.checkpoint || options?.onCheckpoint || options?.checkpointContext)
  ) {
    throw new Error(
      "IDA* checkpoints are available only with the default exact-search feature vector.",
    );
  }
  const counters: SearchCounters = {
    expanded: 0,
    generated: 0,
    duplicates: 0,
    deadlockPrunes: 0,
    patternDeadlockPrunes: 0,
    corralPrunes: 0,
    piCorralPrunes: 0,
    deadlockTablePrunes: 0,
    commitmentSkips: 0,
    interactionBoostTotal: 0,
    infeasiblePrunes: 0,
    reachabilityFloods: 0,
    peakStackDepth: 0,
    maxDepth: 0,
    iterations: 0,
  };
  let transpositionSize = 0;
  let collectCurrentMetrics: (() => SolverRunMetrics) | undefined;

  const resumeCheckpoint = options?.checkpoint ?? null;
  const numericUpperBound = options?.upperBound ?? Infinity;
  if (
    numericUpperBound !== Infinity &&
    (!Number.isSafeInteger(numericUpperBound) || numericUpperBound < 0)
  ) {
    throw new Error("IDA* upper bound must be a non-negative safe integer.");
  }
  const suppliedIncumbent = resumeCheckpoint?.incumbent ?? options?.incumbent;
  let U = Math.min(suppliedIncumbent?.cost ?? Infinity, numericUpperBound);
  let incumbentSolution: SolverSolution | null =
    suppliedIncumbent && suppliedIncumbent.cost <= U
      ? suppliedIncumbent.solution
      : null;
  let lastExhaustedThreshold = resumeCheckpoint?.lastExhaustedThreshold ?? 0;

  if (resumeCheckpoint) {
    counters.expanded = resumeCheckpoint.counters.expanded;
    counters.generated = resumeCheckpoint.counters.generated;
    counters.iterations = resumeCheckpoint.counters.iterations;
  }

  try {
    throwIfSolverCancelled(context.signal);
    const deadline = request.limits?.maxElapsedMs === undefined
      ? Number.POSITIVE_INFINITY
      : startedAt + request.limits.maxElapsedMs;
    const compilationBudget: ExactPreprocessingBudget = {
      signal: context.signal,
      now: context.now,
      deadline,
      maxMemoryBytes: request.limits?.maxMemoryBytes,
      baseMemoryBytes: 0,
    };
    const board = compileSearchBoard(request.board, compilationBudget);
    if (options?.incumbent) {
      const { cost, solution } = options.incumbent;
      if (cost !== solution.moves || !Number.isSafeInteger(cost) || cost < 0) {
        throw new Error("IDA* incumbent cost does not match its route.");
      }
      const verification = verifySolverSolution(request, solution);
      if (!verification.valid) {
        throw new Error(`IDA* incumbent is invalid: ${verification.message}`);
      }
    }
    const baseStaticMemoryBytes = estimateIdaStaticBytes(
      board,
      request.snapshot.boxes.length,
    );
    const preprocessingBudget: ExactPreprocessingBudget = {
      signal: context.signal,
      now: context.now,
      deadline,
      maxMemoryBytes: request.limits?.maxMemoryBytes,
      baseMemoryBytes: baseStaticMemoryBytes,
    };
    checkExactPreprocessingBudget(preprocessingBudget);
    let estimateInteractionSearchBaseMemory = () => baseStaticMemoryBytes;

    if (resumeCheckpoint) {
      const expectedStateKey = createBoardContentKey(request.board, request.snapshot);
      if (resumeCheckpoint.boardContentKey !== expectedStateKey) {
        throw new Error("IDA* checkpoint does not match the requested start state.");
      }
      if (resumeCheckpoint.objective.kind !== request.objective.kind) {
        throw new Error("IDA* checkpoint objective does not match the request.");
      }
      if (resumeCheckpoint.incumbent) {
        const { cost, solution } = resumeCheckpoint.incumbent;
        const verification = verifySolverSolution(request, solution);
        if (cost !== solution.moves) {
          throw new Error("IDA* checkpoint incumbent cost does not match its route.");
        }
        if (!verification.valid) {
          throw new Error(
            `IDA* checkpoint incumbent is invalid: ${verification.message}`,
          );
        }
      }
    }

    context.reportProgress({
      phase: "preparing",
      elapsedMs: Math.max(0, context.now() - startedAt),
      detail: "Compiling search structures",
      counters: {},
    });

    const reachability = new KeeperReachability(board);
    const patternCacheCandidate = features.patternDeadlockPruning
      ? new PatternDeadlockCache()
      : null;
    const patternCache = patternCacheCandidate?.hasEligibleWindow(board)
      ? patternCacheCandidate
      : null;
    const corralDetector = features.piCorralPruning
      ? new PiCorralDetector(board.cellCount)
      : null;
    const commitmentDetector =
      features.goalCommitmentPruning && hasPotentialGoalCommitment(board)
      ? new GoalCommitmentDetector()
      : null;
    throwIfSolverCancelled(context.signal);
    await delayForEventLoop();

    const boostEvaluator =
      features.interactionBoost &&
        hasPotentialInteractionBoost(board, board.topology)
      ? new InteractionBoostEvaluator(
          board,
          board.topology,
          preprocessingBudget,
          {
            signal: context.signal,
            now: context.now,
            deadline,
            maxMemoryBytes: request.limits?.maxMemoryBytes,
            baseMemoryBytes: () => estimateInteractionSearchBaseMemory(),
          },
        )
      : null;
    const macroDetector = features.forcedPushMacros
      ? new ForcedPushMacroDetector(board)
      : null;
    const tunnelDetector = features.tunnelMacros
      ? new TunnelMacroDetector(board)
      : null;
    const deadlockTableLookup = features.deadlockTablePruning
      ? await buildDeadlockTablesAsync(
          board,
          context.signal,
          preprocessingBudget,
        )
      : null;
    throwIfSolverCancelled(context.signal);
    await delayForEventLoop();

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

    const packBoxKeyFromBoxes = (boxes: readonly DenseBox[]) =>
      exactCodec.packBoxTokens(exactCodec.tokensFromBoxes(boxes));
    const heuristic = new AssignmentHeuristic(board, { packBoxKey: packBoxKeyFromBoxes });
    const pdbStartedAt = context.now();
    const pdbEvaluator = features.patternDatabase
      ? await PdbHeuristicEvaluator.createAsync(board, context.signal, {
          ...preprocessingBudget,
          baseMemoryBytes:
            baseStaticMemoryBytes +
            (deadlockTableLookup?.estimatedRetainedBytes ?? 0) +
            (boostEvaluator?.preprocessingRetainedBytes ?? 0),
        })
      : null;
    featureTelemetry.pdbBuildTimeMs = features.patternDatabase
      ? Math.max(0, context.now() - pdbStartedAt)
      : 0;
    featureTelemetry.pdbTableEntries = pdbEvaluator?.totalTableEntries ?? 0;
    throwIfSolverCancelled(context.signal);
    await delayForEventLoop();

    const zobristTable: ZobristTable = createZobristTable(board.cellCount, exactCodec.labelCount);

    const linearConflict = (boxes: readonly DenseBox[]): number => {
      if (!features.linearConflict) return 0;
      featureTelemetry.linearConflictEvaluations += 1;
      const value = heuristic.lastLinearConflict(boxes);
      featureTelemetry.linearConflictTotal += value;
      return value;
    };
    const pdbValue = (boxes: readonly DenseBox[]): number => {
      if (!pdbEvaluator) return 0;
      featureTelemetry.pdbEvaluations += 1;
      return pdbEvaluator.evaluate(boxes);
    };
    const deadlockTableCheck = (
      boxes: readonly DenseBox[],
      movedCell: number,
    ): boolean => {
      if (!deadlockTableLookup) return false;
      featureTelemetry.deadlockTableChecks += 1;
      return deadlockTableLookup.check(boxes, movedCell);
    };

    function exactKey(robotCell: number, boxes: readonly DenseBox[]): bigint {
      const tokens = exactCodec.tokensFromBoxes(boxes);
      return exactCodec.packMoveState(robotCell, tokens);
    }

    function zobristKey(robotCell: number, boxes: readonly DenseBox[]): number {
      const tokens = exactCodec.tokensFromBoxes(boxes);
      return zobristTable.hashFromTokens(tokens, robotCell);
    }

    const preprocessingStaticMemoryBytes = baseStaticMemoryBytes +
      (deadlockTableLookup?.estimatedRetainedBytes ?? 0) +
      (boostEvaluator?.preprocessingRetainedBytes ?? 0) +
      (pdbEvaluator?.estimatedRetainedBytes ?? 0);
    const currentStaticMemoryBytes = () =>
      preprocessingStaticMemoryBytes +
      (boostEvaluator?.searchCacheRetainedBytes ?? 0);
    let transpositionMemoryBytes = 0;
    let dfsStackMemoryBytes = 0;
    let reachabilitySnapshotMemoryBytes = 0;
    let heuristicCacheEntries = 0;
    let peakEstimatedMemoryBytes = 0;
    estimateInteractionSearchBaseMemory = () =>
      estimateIdaCurrentBytes(
        preprocessingStaticMemoryBytes,
        transpositionMemoryBytes,
        estimateHeuristicCacheBytes(
          heuristicCacheEntries,
          initialBoxes.length,
        ),
        dfsStackMemoryBytes,
        reachabilitySnapshotMemoryBytes,
      );

    const featureCounters = (): Readonly<Record<string, number>> => ({
      exactFeatureMask: exactSearchFeatureMask(features),
      incrementalAssignmentRepairs: heuristic.stats.incrementalRepairs,
      linearConflictEvaluations: featureTelemetry.linearConflictEvaluations,
      linearConflictTotal: featureTelemetry.linearConflictTotal,
      interactionBoostEvaluations: boostEvaluator?.stats.evaluations ?? 0,
      interactionBoostApplicable: boostEvaluator === null ? 0 : 1,
      interactionBoostRetainedBytes:
        boostEvaluator?.estimatedRetainedBytes ?? 0,
      interactionBoostSearchCacheRetainedBytes:
        boostEvaluator?.searchCacheRetainedBytes ?? 0,
      pdbBuildTimeMs: featureTelemetry.pdbBuildTimeMs,
      pdbTableEntries: featureTelemetry.pdbTableEntries,
      pdbRetainedBytes: pdbEvaluator?.estimatedRetainedBytes ?? 0,
      pdbEvaluations: featureTelemetry.pdbEvaluations,
      forcedPushMacroChecks: macroDetector?.stats.checks ?? 0,
      piCorralChecks: corralDetector?.stats.checks ?? 0,
      patternDeadlockChecks: patternCache?.stats.checks ?? 0,
      patternDeadlockApplicable: patternCache === null ? 0 : 1,
      deadlockTableBuildTimeMs: deadlockTableLookup?.stats.buildTimeMs ?? 0,
      deadlockTableRegions: deadlockTableLookup?.stats.regionCount ?? 0,
      deadlockTablePatterns: deadlockTableLookup?.stats.patternCount ?? 0,
      deadlockTableRetainedBytes:
        deadlockTableLookup?.estimatedRetainedBytes ?? 0,
      preprocessingRetainedBytes:
        (pdbEvaluator?.estimatedRetainedBytes ?? 0) +
        (deadlockTableLookup?.estimatedRetainedBytes ?? 0) +
        (boostEvaluator?.preprocessingRetainedBytes ?? 0),
      deadlockTableChecks: featureTelemetry.deadlockTableChecks,
      goalCommitmentChecks: commitmentDetector?.stats.checks ?? 0,
      goalCommitments: commitmentDetector?.stats.commitments ?? 0,
      goalCommitmentApplicable: commitmentDetector === null ? 0 : 1,
      tunnelMacroChecks: tunnelDetector?.stats.checks ?? 0,
      tunnelMacroApplications: tunnelDetector?.stats.applications ?? 0,
    });

    const currentMemory = (): IdaMemoryBreakdown =>
      estimateIdaMemory(
        currentStaticMemoryBytes(),
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
        currentStaticMemoryBytes(),
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
        macroDetector?.stats,
        featureCounters,
      );
    collectCurrentMetrics = metrics;

    const snapshotPolicy: IdaReachabilityPolicy =
      options?.reachabilityPolicy ?? "periodic";
    const snapshotPeriod = options?.snapshotPeriod ?? 4;

    const incumbentInfo = () =>
      incumbentSolution
        ? {
            moves: incumbentSolution.moves,
            pushes: incumbentSolution.pushes,
            objectiveScore: incumbentSolution.objectiveScore,
          }
        : undefined;

    const report = (phase: SolverProgress["phase"], detail: string) => {
      const m = metrics();
      context.reportProgress({
        phase,
        elapsedMs: m.elapsedMs,
        expandedStates: m.expandedStates,
        generatedStates: m.generatedStates,
        frontierSize: 0,
        counters: m.counters,
        detail,
        ...(incumbentInfo() ? { incumbent: incumbentInfo() } : {}),
        ...(U < Infinity
          ? {
              lowerBound: Math.min(lastExhaustedThreshold, U),
              upperBound: U,
              gap: U - Math.min(lastExhaustedThreshold, U),
            }
          : {}),
      });
    };

    const makeOptimalProof = (): SolverProof => ({
      objective: request.objective,
      kind: "optimal",
      algorithm: "move-ida-star",
      lowerBound: U,
      upperBound: U,
      gap: 0,
    });

    const makeBoundedProof = (lb: number): SolverProof => ({
      objective: request.objective,
      kind: "bounded",
      algorithm: "move-ida-star",
      lowerBound: lb,
      upperBound: U,
      gap: U - lb,
    });

    const makeUnsolvableProof = (): SolverProof => ({
      objective: request.objective,
      kind: "unsolvable",
      algorithm: "move-ida-star",
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

    const finishCapExhausted = (lb: number): SolverResult => {
      const m = metrics();
      return {
        status: "unsolved",
        reason: "exhausted",
        detail: `No solution exists below the exclusive move bound ${U}.`,
        metrics: {
          ...m,
          counters: { ...m.counters, lowerBound: Math.min(lb, U) },
        },
      };
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
      if (U === 0 && !incumbentSolution) {
        return finishCapExhausted(0);
      }
      report("verifying", "Verifying candidate solution");
      throwIfSolverCancelled(context.signal);
      const solution: SolverSolution = {
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
      U = 0;
      incumbentSolution = solution;
      return {
        status: "solved",
        solution,
        metrics: metrics(),
        proof: makeOptimalProof(),
      };
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
        proof: makeUnsolvableProof(),
      };
    }
    const initialLabelCosts = heuristic.lastLabelCosts;
    const initialBoost = initialLabelCosts && boostEvaluator
      ? boostEvaluator.evaluate(initialBoxes, initialLabelCosts)
      : 0;
    const initialLC = linearConflict(initialBoxes);
    const initialHWalk = minimumManhattanWalkToPotentialPush(
      board,
      initialRobot,
      initialBoxes,
    );
    const initialPdbSum = pdbValue(initialBoxes);
    const initialH = Math.max(initialHPush + Math.max(initialLC, initialBoost), initialPdbSum) + initialHWalk;
    if (!resumeCheckpoint) lastExhaustedThreshold = initialH;
    if (initialH >= U) {
      return incumbentSolution
        ? finishSolvedOptimal()
        : finishCapExhausted(U);
    }

    const initialExactKey = exactKey(initialRobot, initialBoxes);
    const initialZobristKey = zobristKey(initialRobot, initialBoxes);
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
    let fLimit = resumeCheckpoint
      ? resumeCheckpoint.currentThreshold
      : initialG + initialH;
    let limitDetail: string | undefined;

    const maxMem = request.limits?.maxMemoryBytes;
    const TT_SIZE_CAP = maxMem !== undefined && maxMem >= 2 * 1024 * 1024 * 1024
      ? 4_000_000
      : maxMem !== undefined && maxMem >= 1024 * 1024 * 1024
        ? 3_000_000
        : 2_000_000;
    const transposition = new Map<number, { bigintKey: bigint; bestG: number }>();
    transpositionMemoryBytes = IDA_TRANSPOSITION_BASE_BYTES;

    idaLoop: while (true) {
      if (options?.onCheckpoint && options.checkpointContext) {
        const ctx = options.checkpointContext;
        const cp: IdaStarCheckpoint = {
          schemaVersion: IDA_STAR_CHECKPOINT_SCHEMA_VERSION,
          boardContentKey: ctx.boardContentKey,
          solverVersion: ctx.solverVersion,
          objective: request.objective,
          exactStateCodecVersion: ctx.exactStateCodecVersion,
          currentThreshold: fLimit,
          lastExhaustedThreshold,
          incumbent: incumbentSolution
            ? { solution: incumbentSolution, cost: U }
            : null,
          partitionId: ctx.partitionId,
          transpositionMetadata: { policy: "best-g-per-iteration" },
          counters: {
            expanded: counters.expanded,
            generated: counters.generated,
            iterations: counters.iterations,
          },
        };
        options.onCheckpoint(cp);
      }

      counters.iterations += 1;
      let nextLimit = Number.POSITIVE_INFINITY;

      // Best-g dominance is contour-local. Persisting visited-state costs across
      // contours risks mixing partially explored path contexts and is not
      // required for correctness.
      transposition.clear();
      transpositionMemoryBytes = IDA_TRANSPOSITION_BASE_BYTES;
      transpositionSize = transposition.size;

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
        incumbentSolution ? "proving" : "searching",
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
        zobristKey: initialZobristKey,
        moves: 0,
        pushes: 0,
        g: initialG,
        frozenBoxes: null,
        committedBoxes: null,
        childCursor: 0,
        tunnelMacro: null,
        expanded: false,
        h: 0,
        minChildF: Number.POSITIVE_INFINITY,
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
            incumbentSolution ? "proving" : "searching",
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
          const channelU = options?.upperBoundChannel?.poll();
          if (channelU !== undefined && channelU < U) {
            U = channelU;
            if (incumbentSolution && incumbentSolution.moves > U) {
              incumbentSolution = null;
            }
          }
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
          let hPush: number;
          if (pathStack.length >= 2 && frame.push) {
            const parentFrame = pathStack[pathStack.length - 2];
            const parentBoxKey = packBoxKeyFromBoxes(parentFrame.boxes);
            const childBoxKey = packBoxKeyFromBoxes(frame.boxes);
            const movedBox = parentFrame.boxes.find(
              (b) => b.cell === frame.push!.boxCell,
            );
            if (movedBox) {
              hPush = features.incrementalAssignment
                ? heuristic.evaluateIncremental(
                    frame.boxes,
                    childBoxKey,
                    parentBoxKey,
                    movedBox.label,
                  )
                : heuristic.evaluate(frame.boxes);
            } else {
              hPush = heuristic.evaluate(frame.boxes);
            }
          } else {
            hPush = heuristic.evaluate(frame.boxes);
          }
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

          const labelCosts = heuristic.lastLabelCosts;
          const interactionBoost = labelCosts && boostEvaluator
            ? boostEvaluator.evaluate(
                frame.boxes,
                labelCosts,
                packBoxKeyFromBoxes(frame.boxes),
              )
            : 0;
          if (interactionBoost > 0) counters.interactionBoostTotal += interactionBoost;

          const linearConflictBoost = linearConflict(frame.boxes);

          const hWalk = minimumManhattanWalkToPotentialPush(
            board,
            frame.robot,
            frame.boxes,
          );
          const pdbSum = pdbValue(frame.boxes);
          const h = Math.max(
            hPush + Math.max(linearConflictBoost, interactionBoost),
            pdbSum,
          ) + hWalk;
          frame.h = h;

          const f = frame.g + h;
          if (f > fLimit) {
            nextLimit = Math.min(nextLimit, f);
            popFrame();
            if (pathStack.length > 0) {
              pathStack[pathStack.length - 1].minChildF = Math.min(
                pathStack[pathStack.length - 1].minChildF, f,
              );
            }
            continue;
          }
          if (f >= U) {
            popFrame();
            if (pathStack.length > 0) {
              pathStack[pathStack.length - 1].minChildF = Math.min(
                pathStack[pathStack.length - 1].minChildF, f,
              );
            }
            continue;
          }

          // Collision-checked, contour-local graph dominance. A prior arrival
          // at the exact same state with no greater path cost dominates this
          // arrival. Do not store or reuse backed f-values here: those are
          // root/path-relative and caused false optimality certificates.
          const ttEntry = transposition.get(frame.zobristKey);
          const storedBestG =
            ttEntry !== undefined && ttEntry.bigintKey === frame.exactKey
              ? ttEntry.bestG
              : undefined;
          if (storedBestG !== undefined && storedBestG <= frame.g) {
            counters.duplicates += 1;
            popFrame();
            continue;
          }
          const oldTTSize = transposition.size;
          transposition.set(frame.zobristKey, {
            bigintKey: frame.exactKey,
            bestG: frame.g,
          });
          if (transposition.size > oldTTSize) {
            transpositionSize = transposition.size;
            transpositionMemoryBytes += estimateTranspositionEntryBytes();
          }
          // TT size cap with replacement policy
          if (transposition.size > TT_SIZE_CAP) {
            const firstKey = transposition.keys().next().value;
            if (firstKey !== undefined) transposition.delete(firstKey);
          }
          if (memoryLimitReached()) {
            limitDetail = "Estimated solver memory limit reached.";
            break idaLoop;
          }

          // Solved? Update incumbent if this path is better, then continue DFS.
          if (isSolved(board, frame.boxes) && frame.g < U) {
            report(
              "improving",
              "Reconstructing and verifying IDA* incumbent",
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
            const solution: SolverSolution = {
              steps,
              moves: steps.length,
              pushes: pushCount,
              objective: request.objective,
              objectiveScore: objectiveScore(steps.length),
              optimality: "unknown" as const,
            };
            const verification = verifySolverSolution(request, solution);
            if (!verification.valid) {
              throw new Error(
                `IDA* solver verification failed: ${verification.message}`,
              );
            }
            U = frame.g;
            incumbentSolution = solution;
            throwIfSolverCancelled(context.signal);
            popFrame();
            if (pathStack.length > 0) {
              pathStack[pathStack.length - 1].minChildF = Math.min(
                pathStack[pathStack.length - 1].minChildF, f,
              );
            }
            continue;
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
        fillOccupancy(occupancyBuffer, frame.boxes);
        let reachable: KeeperReachabilityResult;
        if (frame.reachabilitySnapshot !== null) {
          reachability.restoreState(frame.reachabilitySnapshot);
          reachable = frame.cachedReachable!;
        } else {
          reachable = reachability.flood(frame.robot, occupancyBuffer);
          counters.reachabilityFloods += 1;
          const shouldSnapshot =
            snapshotPolicy === "all" ||
            (snapshotPolicy === "periodic" &&
              (pathStack.length - 1) % snapshotPeriod === 0);
          if (shouldSnapshot) {
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
        }

        if (
          frame.childCursor === 0 &&
          corralDetector &&
          hasPiCorralDeadlock(
            board,
            frame.boxes,
            occupancyBuffer,
            reachable,
            corralDetector,
          )
        ) {
          counters.piCorralPrunes += 1;
          popFrame();
          continue;
        }

        // Expansion-time tighter pruning: recompute h with exact BFS walk
        // bound (reuses the flood already done, no second BFS).
        if (frame.childCursor === 0) {
          const expandedWalk = minimumReachableWalkToLegalPush(
            board,
            frame.boxes,
            occupancyBuffer,
            reachable,
          );
          if (!Number.isFinite(expandedWalk)) {
            // Unsolved state with no legal push — dead end.
            counters.infeasiblePrunes += 1;
            popFrame();
            continue;
          }
          // Push bound is a cache hit (was evaluated in the !expanded block).
          const expandedPushBound = heuristic.evaluate(frame.boxes);
          heuristicCacheEntries = heuristic.stats.cacheEntries;
          const hExpanded = expandedPushBound + expandedWalk;
          const fExpanded = frame.g + hExpanded;
          if (fExpanded >= U) {
            popFrame();
            continue;
          }
        }

        const frozenBoxes = frame.frozenBoxes!;
        if (frame.committedBoxes === null) {
          frame.committedBoxes = commitmentDetector
            ? findProvenCommitments(board, frame.boxes, commitmentDetector)
            : new Set<number>();
        }
        const committedBoxes = frame.committedBoxes;
        const boxCount = frame.boxes.length;
        const totalChildren = boxCount * SEARCH_DIRECTIONS.length;

        // Forced push macro: if exactly one legal push, skip child generation
        if (frame.childCursor === 0) {
          const fpResult = macroDetector?.detect(
            frame.boxes,
            occupancyBuffer,
            reachable,
          );
          if (fpResult?.forced) {
            const fpBoxIdx = fpResult.boxIndex!;
            const fpDir = fpResult.direction!;
            const fpBox = frame.boxes[fpBoxIdx];
            const fpNeighbors = board.neighbors[fpBox.cell];
            const fpDest = fpNeighbors?.[fpDir] ?? -1;

            let fpDeadlock = fpDest < 0 || isStaticDeadCell(board, fpDest, fpBox.label);
            let fpNewBoxes: readonly DenseBox[] | null = null;
            if (!fpDeadlock) {
              fpNewBoxes = movedBoxes(frame.boxes, fpBoxIdx, fpDest);
              fillDeadlockOccupancy(deadlockOccupancyBuffer, fpNewBoxes);
              fpDeadlock =
                createsFullyBlockedTwoByTwoDeadlock(board, fpNewBoxes, fpDest, deadlockOccupancyBuffer) ||
                hasFreezeDeadlock(board, fpNewBoxes, deadlockOccupancyBuffer) ||
                (patternCache !== null &&
                  createsPatternDeadlock(board, fpNewBoxes, fpDest, patternCache)) ||
                deadlockTableCheck(fpNewBoxes, fpDest);
            }

            if (fpDeadlock) {
              counters.deadlockPrunes += 1;
              popFrame();
              continue;
            }

            const fpOpposite = OPPOSITE_DIRECTION[fpDir];
            const fpSupport = fpOpposite === undefined ? -1 : (fpNeighbors?.[fpOpposite] ?? -1);
            const fpDistance = reachable.distanceTo(fpSupport);
            if (fpDistance < 0) {
              throw new Error("Forced push support cell has no keeper distance.");
            }

            {
              const maxGenerated = request.limits?.maxGeneratedStates;
              if (maxGenerated !== undefined && counters.generated >= maxGenerated) {
                limitDetail = "Maximum generated-state count reached.";
                break idaLoop;
              }
            }
            counters.generated += 1;
            workSinceYield += 1;

            const fpNewMoves = frame.moves + fpDistance + 1;
            const fpNewKey = exactKey(fpBox.cell, fpNewBoxes!);
            const fpNewZobristKey = zobristKey(fpBox.cell, fpNewBoxes!);

            frame.childCursor = totalChildren;

            pushFrame({
              robot: fpBox.cell,
              boxes: fpNewBoxes!,
              exactKey: fpNewKey,
              zobristKey: fpNewZobristKey,
              moves: fpNewMoves,
              pushes: frame.pushes + 1,
              g: fpNewMoves,
              push: { boxCell: fpBox.cell, directionIndex: fpDir },
              frozenBoxes: null,
              committedBoxes: null,
              childCursor: 0,
              expanded: false,
              h: 0,
              minChildF: Number.POSITIVE_INFINITY,
              reachabilitySnapshot: null,
              cachedReachable: null,
              estimatedStackBytes: estimateStackFrameBytes(fpNewBoxes!, true),
              estimatedReachabilityBytes: 0,
              tunnelMacro: null,
            });
            if (memoryLimitReached()) {
              limitDetail = "Estimated solver memory limit reached.";
              break idaLoop;
            }
            continue;
          }
        }

        let foundChild = false;

        while (frame.childCursor < totalChildren) {
          // Active tunnel macro: process remaining stops
          if (frame.tunnelMacro !== null) {
            const tm = frame.tunnelMacro;
            while (tm.cursor < tm.stops.length) {
              const stop = tm.stops[tm.cursor++]!;
              const tmBox = frame.boxes[tm.boxIndex]!;

              if (isStaticDeadCell(board, stop.finalCell, tmBox.label)) {
                counters.deadlockPrunes += 1;
                continue;
              }

              const tmNewBoxes = movedBoxes(frame.boxes, tm.boxIndex, stop.finalCell);
              fillDeadlockOccupancy(deadlockOccupancyBuffer, tmNewBoxes);
              if (
                createsFullyBlockedTwoByTwoDeadlock(
                  board, tmNewBoxes, stop.finalCell, deadlockOccupancyBuffer,
                )
              ) {
                counters.deadlockPrunes += 1;
                continue;
              }
              if (hasFreezeDeadlock(board, tmNewBoxes, deadlockOccupancyBuffer)) {
                counters.deadlockPrunes += 1;
                continue;
              }
              if (
                patternCache !== null &&
                createsPatternDeadlock(board, tmNewBoxes, stop.finalCell, patternCache)
              ) {
                counters.patternDeadlockPrunes += 1;
                continue;
              }
              if (deadlockTableCheck(tmNewBoxes, stop.finalCell)) {
                counters.deadlockTablePrunes += 1;
                continue;
              }

              const tmNewMoves = frame.moves + tm.walkDistance + stop.pushCount;
              const tmNewPushes = frame.pushes + stop.pushCount;
              const tmNewExactKey = exactKey(tmBox.cell, tmNewBoxes);
              const tmNewZobristKey = zobristKey(tmBox.cell, tmNewBoxes);

              pushFrame({
                robot: stop.robotCell,
                boxes: tmNewBoxes,
                exactKey: tmNewExactKey,
                zobristKey: tmNewZobristKey,
                moves: tmNewMoves,
                pushes: tmNewPushes,
                g: tmNewMoves,
                push: { boxCell: tmBox.cell, directionIndex: tm.directionIndex, pushCount: stop.pushCount },
                frozenBoxes: null,
                committedBoxes: null,
                childCursor: 0,
                tunnelMacro: null,
                expanded: false,
                h: 0,
                minChildF: Number.POSITIVE_INFINITY,
                reachabilitySnapshot: null,
                cachedReachable: null,
                estimatedStackBytes: estimateStackFrameBytes(tmNewBoxes, true),
                estimatedReachabilityBytes: 0,
              });
              if (memoryLimitReached()) {
                limitDetail = "Estimated solver memory limit reached.";
                break idaLoop;
              }
              foundChild = true;
              break;
            }
            if (foundChild) break;
            frame.tunnelMacro = null;
            continue;
          }

          const cursor = frame.childCursor;
          frame.childCursor += 1;

          const boxIndex = Math.floor(cursor / SEARCH_DIRECTIONS.length);
          const directionIndex = cursor % SEARCH_DIRECTIONS.length;

          if (frozenBoxes[boxIndex]) continue;
          if (committedBoxes.has(boxIndex)) {
            if (directionIndex === 0) counters.commitmentSkips += 1;
            continue;
          }

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

          // Tunnel macro: chain pushes through tunnel
          const tStops = tunnelDetector?.resolve(
            destination, directionIndex, occupancyBuffer, board.goalLabelByCell, box.label,
          );
          if (tStops) {
            const tDistance = reachable.distanceTo(support);
            if (tDistance < 0) {
              throw new Error("Reachable support cell has no keeper distance.");
            }
            counters.generated += tStops.length - 1;
            workSinceYield += tStops.length - 1;
            frame.tunnelMacro = {
              stops: tStops,
              boxIndex,
              directionIndex,
              walkDistance: tDistance,
              cursor: 0,
            };
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

          if (
            patternCache !== null &&
            createsPatternDeadlock(board, newBoxes, destination, patternCache)
          ) {
            counters.patternDeadlockPrunes += 1;
            continue;
          }

          if (deadlockTableCheck(newBoxes, destination)) {
            counters.deadlockTablePrunes += 1;
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
          const newZobristKey = zobristKey(box.cell, newBoxes);

          const childFrame: StackFrame = {
            robot: box.cell,
            boxes: newBoxes,
            exactKey: newExactKey,
            zobristKey: newZobristKey,
            moves: newMoves,
            pushes: newPushes,
            g: newG,
            push: { boxCell: box.cell, directionIndex },
            frozenBoxes: null,
            committedBoxes: null,
            childCursor: 0,
            expanded: false,
            h: 0,
            minChildF: Number.POSITIVE_INFINITY,
            reachabilitySnapshot: null,
            cachedReachable: null,
            estimatedStackBytes: estimateStackFrameBytes(
              newBoxes,
              true,
            ),
            estimatedReachabilityBytes: 0,
            tunnelMacro: null,
          };

          pushFrame(childFrame);
          if (memoryLimitReached()) {
            limitDetail = "Estimated solver memory limit reached.";
            break idaLoop;
          }
          foundChild = true;
          break; // Process child before continuing with siblings
        }

        // No more children: backtrack and propagate the contour cutoff only.
        if (!foundChild) {
          const backFrame = pathStack[pathStack.length - 1];
          if (backFrame.expanded) {
            const backedF = Math.max(backFrame.g + backFrame.h, backFrame.minChildF);
            nextLimit = Math.min(nextLimit, backedF);
          }
          popFrame();
          if (pathStack.length > 0) {
            const backF = Math.max(backFrame.g + backFrame.h, backFrame.minChildF);
            pathStack[pathStack.length - 1].minChildF = Math.min(
              pathStack[pathStack.length - 1].minChildF, backF,
            );
          }
        }
      }

      transpositionSize = transposition.size;
      lastExhaustedThreshold = fLimit;

      if (incumbentSolution && (fLimit >= U || nextLimit >= U)) {
        return finishSolvedOptimal();
      }

      if (nextLimit === Number.POSITIVE_INFINITY) {
        if (incumbentSolution) {
          return finishSolvedOptimal();
        }
        if (U < Infinity) {
          return finishCapExhausted(U);
        }
        return {
          status: "unsolved",
          reason: "exhausted",
          metrics: metrics(),
          proof: makeUnsolvableProof(),
        };
      }

      fLimit = nextLimit;
    }

    if (limitDetail) {
      if (incumbentSolution) {
        return finishSolvedBounded(lastExhaustedThreshold);
      }
      const m = metrics();
      return {
        status: "unsolved",
        reason: "limit-reached",
        detail: limitDetail,
        metrics: {
          ...m,
          counters: { ...m.counters, lowerBound: lastExhaustedThreshold },
        },
      };
    }

    if (incumbentSolution) {
      return finishSolvedOptimal();
    }
    if (U < Infinity) {
      return finishCapExhausted(U);
    }
    return {
      status: "unsolved",
      reason: "exhausted",
      metrics: metrics(),
      proof: makeUnsolvableProof(),
    };
  } catch (error) {
    if (
      isExactPreprocessingLimitError(error) ||
      isExactInteractionSearchLimitError(error)
    ) {
      const collected = collectCurrentMetrics?.();
      const estimatedMemoryBytes = Math.max(
        error.estimatedMemoryBytes,
        collected?.counters?.estimatedMemoryBytes ?? 0,
      );
      const limitMetrics: SolverRunMetrics = collected
        ? {
            ...collected,
            counters: {
              ...collected.counters,
              estimatedMemoryBytes,
              currentEstimatedMemoryBytes: estimatedMemoryBytes,
              peakEstimatedMemoryBytes: Math.max(
                estimatedMemoryBytes,
                collected.counters?.peakEstimatedMemoryBytes ?? 0,
              ),
            },
          }
        : {
            elapsedMs: Math.max(0, context.now() - startedAt),
            expandedStates: counters.expanded,
            generatedStates: counters.generated,
            peakFrontierSize: counters.peakStackDepth,
            counters: {
              estimatedMemoryBytes,
              currentEstimatedMemoryBytes: estimatedMemoryBytes,
              peakEstimatedMemoryBytes: estimatedMemoryBytes,
              exactFeatureMask: exactSearchFeatureMask(features),
            },
          };
      if (incumbentSolution && U < Infinity) {
        const proven = lastExhaustedThreshold >= U;
        return {
          status: "solved",
          solution: proven
            ? { ...incumbentSolution, optimality: "proven" }
            : incumbentSolution,
          metrics: limitMetrics,
          proof: proven
            ? {
                objective: request.objective,
                kind: "optimal",
                algorithm: "move-ida-star",
                lowerBound: U,
                upperBound: U,
                gap: 0,
              }
            : {
                objective: request.objective,
                kind: "bounded",
                algorithm: "move-ida-star",
                lowerBound: lastExhaustedThreshold,
                upperBound: U,
                gap: U - lastExhaustedThreshold,
              },
        };
      }
      return {
        status: "unsolved",
        reason: "limit-reached",
        detail: error.message,
        metrics: limitMetrics,
      };
    }
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
      if (incumbentSolution) {
        return {
          status: "solved",
          solution: incumbentSolution,
          metrics: cancellationMetrics,
          proof: {
            objective: request.objective,
            kind: "bounded",
            algorithm: "move-ida-star",
            lowerBound: lastExhaustedThreshold,
            upperBound: U,
            gap: U - lastExhaustedThreshold,
          },
        };
      }
      return {
        status: "cancelled",
        metrics: cancellationMetrics,
      };
    }
    throw error;
  }
}
