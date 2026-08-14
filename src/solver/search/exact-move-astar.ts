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
import {
  hasPotentialInteractionBoost,
  InteractionBoostEvaluator,
  isExactInteractionSearchLimitError,
} from "./interaction-boost.ts";
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
  PdbHeuristicEvaluator,
  minimumManhattanWalkToPotentialPush,
  minimumReachableWalkToLegalPush,
} from "./heuristic.ts";
import { toDenseBoxes, type DenseBox } from "./model.ts";
import { createExactStateCodec } from "./exact-state.ts";
import { createZobristTable } from "./zobrist-state.ts";
import { NumericPriorityQueue } from "./numeric-priority-queue.ts";
import { KeeperReachability } from "./reachability.ts";
import {
  sortedBoxes,
  estimateStaticSearchBytes,
} from "./engine.ts";
import { delayForEventLoop } from "./scheduling.ts";
import {
  createExactSearchFeatureTelemetry,
  exactSearchFeatureMask,
  resolveExactSearchFeatures,
  type ExactSearchFeatures,
} from "./exact-search-features.ts";
import {
  checkExactPreprocessingBudget,
  isExactPreprocessingLimitError,
  type ExactPreprocessingBudget,
} from "./preprocessing-budget.ts";

export interface ExactIncumbent {
  readonly solution: SolverSolution;
  readonly cost: number;
}

export interface UpperBoundChannel {
  poll(): number | undefined;
}

export interface ExactMoveAStarOptions {
  readonly incumbent?: ExactIncumbent;
  /** Exclusive move-cost ceiling. Unlike an incumbent, this carries no route. */
  readonly upperBound?: number;
  readonly upperBoundChannel?: UpperBoundChannel;
  readonly features?: Partial<ExactSearchFeatures>;
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
  macroStats?: { readonly applications: number },
  featureCounters?: () => Readonly<Record<string, number>>,
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
      patternDeadlockPrunes: counters.patternDeadlockPrunes,
      corralPrunes: counters.corralPrunes,
      piCorralPrunes: counters.piCorralPrunes,
      deadlockTablePrunes: counters.deadlockTablePrunes,
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
      forcedPushMacroApplications: macroStats?.applications ?? 0,
      ...featureCounters?.(),
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
  macroStats?: { readonly applications: number },
  featureCounters?: () => Readonly<Record<string, number>>,
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
    macroStats,
    featureCounters,
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
  const features = resolveExactSearchFeatures(options?.features);
  const featureTelemetry = createExactSearchFeatureTelemetry();

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
    reopens: 0,
    reachabilityFloods: 0,
    avoidedReachabilityFloods: 0,
    retainedBytes: 0,
    peakFrontier: 0,
    maxDepth: 0,
  };
  let collectCurrentMetrics: (() => SolverRunMetrics) | undefined;
  const numericUpperBound = options?.upperBound ?? Infinity;
  if (
    numericUpperBound !== Infinity &&
    (!Number.isSafeInteger(numericUpperBound) || numericUpperBound < 0)
  ) {
    throw new Error("Exact A* upper bound must be a non-negative safe integer.");
  }
  let U = Math.min(options?.incumbent?.cost ?? Infinity, numericUpperBound);
  if (options?.incumbent) {
    const { cost, solution } = options.incumbent;
    if (cost !== solution.moves || !Number.isSafeInteger(cost) || cost < 0) {
      throw new Error("Exact A* incumbent cost does not match its route.");
    }
    const verification = verifySolverSolution(request, solution);
    if (!verification.valid) {
      throw new Error(`Exact A* incumbent is invalid: ${verification.message}`);
    }
  }
  let incumbentSolution: SolverSolution | null =
    options?.incumbent && options.incumbent.cost <= U
      ? options.incumbent.solution
      : null;
  let lastLowerBound = 0;

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
    const { cellCount } = board;
    const labels = [...board.goalCellsByLabel.keys()].sort();
    const baseStaticBytes = estimateStaticSearchBytes(board);
    const preprocessingBudget: ExactPreprocessingBudget = {
      signal: context.signal,
      now: context.now,
      deadline,
      maxMemoryBytes: request.limits?.maxMemoryBytes,
      baseMemoryBytes: baseStaticBytes,
    };
    checkExactPreprocessingBudget(preprocessingBudget);
    let estimateInteractionSearchBaseMemory = () => baseStaticBytes;

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
      ? new PiCorralDetector(cellCount)
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
    const deadlockTableLookup = features.deadlockTablePruning
      ? await buildDeadlockTablesAsync(
          board,
          context.signal,
          preprocessingBudget,
        )
      : null;
    throwIfSolverCancelled(context.signal);
    await delayForEventLoop();

    const exactCodec = createExactStateCodec(cellCount, labels);
    const zobristTable = createZobristTable(cellCount, labels.length);
    const packBoxKey = (boxes: readonly DenseBox[]) =>
      exactCodec.packBoxTokens(exactCodec.tokensFromBoxes(boxes));
    const heuristic = new AssignmentHeuristic(board, { packBoxKey });
    const pdbStartedAt = context.now();
    const pdbEvaluator = features.patternDatabase
      ? await PdbHeuristicEvaluator.createAsync(board, context.signal, {
          ...preprocessingBudget,
          baseMemoryBytes:
            baseStaticBytes +
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
    const preprocessingStaticBytes = baseStaticBytes +
      (deadlockTableLookup?.estimatedRetainedBytes ?? 0) +
      (boostEvaluator?.preprocessingRetainedBytes ?? 0) +
      (pdbEvaluator?.estimatedRetainedBytes ?? 0);
    const currentStaticBytes = () =>
      preprocessingStaticBytes +
      (boostEvaluator?.searchCacheRetainedBytes ?? 0);
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
    let heapSize = 0;
    let uniqueStates = 0;

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

    const initialOccupancy = new Uint8Array(cellCount);
    for (const box of initialBoxes) initialOccupancy[box.cell] = 1;
    reachability.flood(initialRobot, initialOccupancy);
    counters.reachabilityFloods += 1;

    const maxToken = labelCount * cellCount - 1;
    const arena = createCompactNodeArena(boxCount, maxToken);
    estimateInteractionSearchBaseMemory = () =>
      estimatedArenaMemoryBytes(
        preprocessingStaticBytes,
        arena.estimatedRetainedBytes(),
        uniqueStates,
        heapSize,
        heuristic.stats.cacheEntries,
        boxCount,
      );

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
    const initialZobristKey = zobristTable.hashFromTokens(initialTokens, initialRobot);
    const initialPushBound = heuristic.evaluate(initialBoxes);
    const initialLabelCosts = heuristic.lastLabelCosts;
    const initialBoost = initialLabelCosts && boostEvaluator
      ? boostEvaluator.evaluate(initialBoxes, initialLabelCosts)
      : 0;
    const initialLC = linearConflict(initialBoxes);
    const initialWalkBound = minimumManhattanWalkToPotentialPush(
      board,
      initialRobot,
      initialBoxes,
    );
    const initialPdbSum = pdbValue(initialBoxes);
    const initialH = Math.max(initialPushBound + Math.max(initialLC, initialBoost), initialPdbSum) + initialWalkBound;
    lastLowerBound = initialH;

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
    });

    const metrics = () =>
      createMetrics(
        context,
        startedAt,
        counters,
        heapSize,
        uniqueStates,
        arena.size,
        heuristic,
        currentStaticBytes(),
        boxCount,
        arena.estimatedRetainedBytes(),
        macroDetector?.stats,
        featureCounters,
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
          currentStaticBytes(),
          boxCount,
          arena.estimatedRetainedBytes(),
          incumbentInfo(),
          U < Infinity ? Math.min(lastLowerBound, U) : undefined,
          U < Infinity ? U : undefined,
          macroDetector?.stats,
          featureCounters,
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
          currentStaticBytes(),
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
      if (U === 0 && !incumbentSolution) {
        return finishCapExhausted(0);
      }
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
      return incumbentSolution
        ? finishSolvedOptimal()
        : finishCapExhausted(U);
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

    interface BestGEntry { bigintKey: bigint; g: number }
    const bestG = new Map<number, BestGEntry[]>();
    bestG.set(initialZobristKey, [{ bigintKey: initialKey, g: 0 }]);

    function bestGLookup(zobKey: number, bigKey: bigint): number | undefined {
      const chain = bestG.get(zobKey);
      if (chain === undefined) return undefined;
      for (let i = 0; i < chain.length; i++) {
        if (chain[i].bigintKey === bigKey) return chain[i].g;
      }
      return undefined;
    }

    function bestGStore(zobKey: number, bigKey: bigint, g: number): boolean {
      const chain = bestG.get(zobKey);
      if (chain === undefined) {
        bestG.set(zobKey, [{ bigintKey: bigKey, g }]);
        return true;
      }
      for (let i = 0; i < chain.length; i++) {
        if (chain[i].bigintKey === bigKey) {
          chain[i].g = g;
          return false;
        }
      }
      chain.push({ bigintKey: bigKey, g });
      return true;
    }
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
          break;
        }
      }

      const nodeIndex = heap.dequeue();
      if (nodeIndex === undefined) break;
      syncState();

      arena.readBoxTokens(nodeIndex, parentTokenBuf);
      const nodeRobotCell = arena.robotCell(nodeIndex);
      const nodeKey = exactCodec.packMoveState(nodeRobotCell, parentTokenBuf);
      const nodeZobristKey = zobristTable.hashFromTokens(parentTokenBuf, nodeRobotCell);
      const nodeMoves = arena.gMoves(nodeIndex);

      if (bestGLookup(nodeZobristKey, nodeKey) !== nodeMoves) continue;

      const L = nodeMoves + arena.heuristic(nodeIndex);
      lastLowerBound = L;

      if (L >= U) {
        return incumbentSolution
          ? finishSolvedOptimal()
          : finishCapExhausted(U);
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

      if (
        corralDetector &&
        hasPiCorralDeadlock(
          board,
          expansionBoxes,
          occupied,
          reachable,
          corralDetector,
        )
      ) {
        counters.piCorralPrunes += 1;
        continue;
      }

      // Expansion-time tighter pruning: recompute h with exact BFS walk
      // bound (reuses the flood already done, no second BFS).
      {
        const expandedWalk = minimumReachableWalkToLegalPush(
          board,
          expansionBoxes,
          occupied,
          reachable,
        );
        if (!Number.isFinite(expandedWalk)) {
          // Unsolved state with no legal push — dead end.
          counters.infeasiblePrunes += 1;
          continue;
        }
        // Push bound is a cache hit (was evaluated at generation time).
        const expandedPushBound = heuristic.evaluate(expansionBoxes);
        const hExpanded = expandedPushBound + expandedWalk;
        if (nodeMoves + hExpanded >= U) {
          continue;
        }
      }

      const committedBoxes = commitmentDetector
        ? findProvenCommitments(board, expansionBoxes, commitmentDetector)
        : new Set<number>();

      const parentBoxKey = exactCodec.packBoxTokens(parentTokenBuf);

      // Forced push macro: if exactly one legal push, skip full successor generation
      const fpResult = macroDetector?.detect(expansionBoxes, occupied, reachable);
      if (fpResult?.forced) {
        const fpBoxIdx = fpResult.boxIndex!;
        const fpDir = fpResult.direction!;
        const fpBox = expansionBoxes[fpBoxIdx];
        const fpNeighbors = board.neighbors[fpBox.cell];
        const fpDest = fpNeighbors?.[fpDir] ?? -1;

        let fpDeadlock = fpDest < 0 || isStaticDeadCell(board, fpDest, fpBox.label);
        if (!fpDeadlock) {
          const savedCell = expansionBoxes[fpBoxIdx].cell;
          (expansionBoxes[fpBoxIdx] as { cell: number }).cell = fpDest;
          fillDeadlockOccupancy(deadlockOccupancyBuffer, expansionBoxes);
          fpDeadlock =
            createsFullyBlockedTwoByTwoDeadlock(board, expansionBoxes, fpDest, deadlockOccupancyBuffer) ||
            hasFreezeDeadlock(board, expansionBoxes, deadlockOccupancyBuffer) ||
            (patternCache !== null &&
              createsPatternDeadlock(board, expansionBoxes, fpDest, patternCache)) ||
            deadlockTableCheck(expansionBoxes, fpDest);

          if (!fpDeadlock) {
            const fpOpposite = OPPOSITE_DIRECTION[fpDir];
            const fpSupport = fpOpposite === undefined ? -1 : (fpNeighbors?.[fpOpposite] ?? -1);
            const fpDistance = reachable.distanceTo(fpSupport);
            if (fpDistance < 0) {
              (expansionBoxes[fpBoxIdx] as { cell: number }).cell = savedCell;
              throw new Error("Forced push support cell has no keeper distance.");
            }

            {
              const maxGenerated = request.limits?.maxGeneratedStates;
              if (maxGenerated !== undefined && counters.generated >= maxGenerated) {
                (expansionBoxes[fpBoxIdx] as { cell: number }).cell = savedCell;
                limitDetail = "Maximum generated-state count reached.";
                syncState();
                break searchLoop;
              }
            }
            counters.generated += 1;
            workSinceYield += 1;

            const childMoves = nodeMoves + fpDistance + 1;
            const childPushes = arena.pushes(nodeIndex) + 1;

            const oldToken = parentTokenBuf[fpBoxIdx];
            const newLabelId = tokenToLabelId(oldToken);
            const newToken = newLabelId * cellCount + fpDest;
            sortedInsertToken(parentTokenBuf, boxCount, fpBoxIdx, newToken, childTokenBuf);

            const childKey = exactCodec.packMoveState(savedCell, childTokenBuf);
            const childZobristKey = zobristTable.hashFromTokens(childTokenBuf, savedCell);
            const prevBestG = bestGLookup(childZobristKey, childKey);

            if (prevBestG === undefined || childMoves < prevBestG) {
              const childBoxKey = exactCodec.packBoxTokens(childTokenBuf);
              const movedLabel = labels[newLabelId];
              const pushLowerBound = features.incrementalAssignment
                ? heuristic.evaluateIncremental(
                    expansionBoxes,
                    childBoxKey,
                    parentBoxKey,
                    movedLabel,
                  )
                : heuristic.evaluate(expansionBoxes);

              if (Number.isFinite(pushLowerBound)) {
                const labelCosts = heuristic.lastLabelCosts;
                const interactionBoost = labelCosts && boostEvaluator
                  ? boostEvaluator.evaluate(expansionBoxes, labelCosts, childBoxKey)
                  : 0;
                if (interactionBoost > 0) {
                  counters.interactionBoostTotal += interactionBoost;
                }
                const fpLinearConflict = linearConflict(expansionBoxes);
                const fpPdbSum = pdbValue(expansionBoxes);
                const walkBound = minimumManhattanWalkToPotentialPush(
                  board, savedCell, expansionBoxes,
                );
                const h = Math.max(pushLowerBound + Math.max(fpLinearConflict, interactionBoost), fpPdbSum) + walkBound;
                const f = childMoves + h;

                if (f < U) {
                  const childIndex = arena.allocate();
                  arena.setRobotCell(childIndex, savedCell);
                  arena.setGMoves(childIndex, childMoves);
                  arena.setPushes(childIndex, childPushes);
                  arena.setParentNode(childIndex, nodeIndex);
                  arena.setPushedFromCell(childIndex, savedCell);
                  arena.setPushDirection(childIndex, fpDir);
                  arena.setHeuristic(childIndex, h);
                  arena.writeBoxTokens(childIndex, childTokenBuf);
                  counters.retainedBytes = arena.estimatedRetainedBytes();
                  counters.maxDepth = Math.max(counters.maxDepth, childPushes);

                  const isNew = bestGStore(childZobristKey, childKey, childMoves);
                  if (isNew) {
                    uniqueStates += 1;
                  } else {
                    counters.reopens += 1;
                  }
                  heap.enqueue(childIndex);
                  syncState();
                  counters.peakFrontier = Math.max(counters.peakFrontier, heap.size);
                }
              } else {
                counters.infeasiblePrunes += 1;
              }
            } else {
              counters.duplicates += 1;
            }
          } else {
            counters.deadlockPrunes += 1;
          }
          (expansionBoxes[fpBoxIdx] as { cell: number }).cell = savedCell;
        } else {
          counters.deadlockPrunes += 1;
        }
        continue;
      }

      for (let boxIndex = 0; boxIndex < boxCount; boxIndex += 1) {
        if (committedBoxes.has(boxIndex)) {
          counters.commitmentSkips += 1;
          continue;
        }
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

          if (
            patternCache !== null &&
            createsPatternDeadlock(board, expansionBoxes, destination, patternCache)
          ) {
            (expansionBoxes[boxIndex] as { cell: number }).cell = savedCell;
            counters.patternDeadlockPrunes += 1;
            continue;
          }

          if (deadlockTableCheck(expansionBoxes, destination)) {
            (expansionBoxes[boxIndex] as { cell: number }).cell = savedCell;
            counters.deadlockTablePrunes += 1;
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
          const childZobristKey = zobristTable.hashFromTokens(childTokenBuf, savedCell);
          const prevBestG = bestGLookup(childZobristKey, childKey);
          if (prevBestG !== undefined && childMoves >= prevBestG) {
            (expansionBoxes[boxIndex] as { cell: number }).cell = savedCell;
            counters.duplicates += 1;
            continue;
          }

          const childBoxKey = exactCodec.packBoxTokens(childTokenBuf);
          const movedLabel = labels[newLabelId];
          const pushLowerBound = features.incrementalAssignment
            ? heuristic.evaluateIncremental(
                expansionBoxes,
                childBoxKey,
                parentBoxKey,
                movedLabel,
              )
            : heuristic.evaluate(expansionBoxes);
          const maxMemoryAfterHeuristic = request.limits?.maxMemoryBytes;
          if (
            maxMemoryAfterHeuristic !== undefined &&
            estimatedArenaMemoryBytes(
              currentStaticBytes(),
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

          const labelCosts = heuristic.lastLabelCosts;
          const interactionBoost = labelCosts && boostEvaluator
            ? boostEvaluator.evaluate(expansionBoxes, labelCosts, childBoxKey)
            : 0;
          if (interactionBoost > 0) counters.interactionBoostTotal += interactionBoost;

          const childLinearConflict = linearConflict(expansionBoxes);
          const childPdbSum = pdbValue(expansionBoxes);

          const walkBound = minimumManhattanWalkToPotentialPush(
            board,
            savedCell,
            expansionBoxes,
          );
          const h = Math.max(pushLowerBound + Math.max(childLinearConflict, interactionBoost), childPdbSum) + walkBound;
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
              currentStaticBytes(),
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

          const isNewState = bestGStore(childZobristKey, childKey, childMoves);
          if (isNewState) {
            uniqueStates += 1;
          } else {
            counters.reopens += 1;
          }
          heap.enqueue(childIndex);
          syncState();
          counters.peakFrontier = Math.max(counters.peakFrontier, heap.size);
        }
      }
    }

    syncState();
    if (limitDetail) {
      if (incumbentSolution) {
        // The current node has already been removed from the heap. A cutoff
        // during its expansion must retain that node's f-value; heap.peek()
        // alone can overstate the proven lower bound.
        return finishSolvedBounded(lastLowerBound);
      }
      const m = metrics();
      return {
        status: "unsolved",
        reason: "limit-reached",
        detail: limitDetail,
        metrics: {
          ...m,
          counters: { ...m.counters, lowerBound: lastLowerBound },
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
      const limitMetrics: SolverRunMetrics = {
        elapsedMs: Math.max(0, context.now() - startedAt),
        expandedStates: counters.expanded,
        generatedStates: counters.generated,
        peakFrontierSize: counters.peakFrontier,
        counters: {
          estimatedMemoryBytes: error.estimatedMemoryBytes,
          currentEstimatedMemoryBytes: error.estimatedMemoryBytes,
          peakEstimatedMemoryBytes: error.estimatedMemoryBytes,
          exactFeatureMask: exactSearchFeatureMask(features),
        },
      };
      if (incumbentSolution && U < Infinity) {
        const proven = lastLowerBound >= U;
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
          patternDeadlockPrunes: counters.patternDeadlockPrunes,
          infeasiblePrunes: counters.infeasiblePrunes,
          corralPrunes: counters.corralPrunes,
          piCorralPrunes: counters.piCorralPrunes,
          deadlockTablePrunes: counters.deadlockTablePrunes,
          commitmentSkips: counters.commitmentSkips,
          interactionBoostTotal: counters.interactionBoostTotal,
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
