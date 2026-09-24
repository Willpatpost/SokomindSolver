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
  CorralOrderingAnalyzer,
} from "./corral-ordering.ts";
import {
  findProvenCommitments,
  GoalCommitmentDetector,
  hasPotentialGoalCommitment,
} from "./goal-commitment.ts";
import { buildDeadlockTablesAsync } from "./deadlock-tables.ts";
import { ForcedPushMacroDetector } from "./forced-push-macros.ts";
import {
  TunnelMacroDetector,
  encodeTunnelPushDirection,
} from "./tunnel-macros.ts";
import {
  hasPotentialInteractionBoost,
  InteractionBoostEvaluator,
  isExactInteractionSearchLimitError,
} from "./interaction-boost.ts";
import {
  GoalCutEvaluator,
  hasPotentialGoalCut,
} from "./goal-cut.ts";
import {
  buildBackwardPerimeter,
  type BackwardPerimeterTable,
} from "./backward-perimeter.ts";
import {
  buildComponentPdbCollection,
  type ComponentPdbCollection,
} from "./component-pdb.ts";
import {
  probeAndSelectPatterns,
  type MoveCostPatternCollection,
} from "./move-cost-pattern-pdb.ts";
import {
  analyzeMatchingComponents,
  extractMatchingComponents,
} from "./matching-components.ts";
import { compileSingleBoxPushGraph } from "./single-box-push-graph.ts";
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
      cheapCutoffs: counters.cheapCutoffs,
      secondaryCutoffs: counters.secondaryCutoffs,
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
    incrementalCanonicalCells: 0,
    cheapCutoffs: 0,
    secondaryCutoffs: 0,
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
    const corralOrderer = features.corralOrdering
      ? new CorralOrderingAnalyzer(cellCount)
      : null;
    const commitmentDetector =
      features.goalCommitmentPruning && hasPotentialGoalCommitment(board)
      ? new GoalCommitmentDetector(request.snapshot.boxes.length)
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
    const goalCutEvaluator =
      features.goalCutHeuristic && hasPotentialGoalCut(board, board.topology)
        ? new GoalCutEvaluator(board, board.topology)
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
    const totalBudgetMs = request.limits?.maxElapsedMs ?? Infinity;
    const pdbDeadline = Math.min(deadline, startedAt + 0.25 * totalBudgetMs);
    const pdbStartedAt = context.now();
    const pdbEvaluator = features.patternDatabase
      ? await PdbHeuristicEvaluator.createAsync(board, context.signal, {
          ...preprocessingBudget,
          deadline: pdbDeadline,
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
    const perimeterTable: BackwardPerimeterTable | null = features.backwardPerimeter
      ? buildBackwardPerimeter(
          board, exactCodec, zobristTable,
          { maxStates: 50_000 },
          {
            ...preprocessingBudget,
            baseMemoryBytes:
              baseStaticBytes +
              (deadlockTableLookup?.estimatedRetainedBytes ?? 0) +
              (boostEvaluator?.preprocessingRetainedBytes ?? 0) +
              (pdbEvaluator?.estimatedRetainedBytes ?? 0),
          },
          context.now,
        )
      : null;
    if (perimeterTable) {
      const ps = perimeterTable.stats;
      featureTelemetry.backwardPerimeterBuildExpanded = ps.coloredStatesExplored;
      featureTelemetry.backwardPerimeterColoredStates = ps.coloredStatesExplored;
      featureTelemetry.backwardPerimeterProjectedStates = ps.projectedStates;
      featureTelemetry.backwardPerimeterDuplicateProjections = ps.duplicateProjections;
      featureTelemetry.backwardPerimeterConstrainedSkipped = ps.constrainedTransitionsSkipped;
      featureTelemetry.backwardPerimeterBuildTimeMs = ps.buildTimeMs;
      featureTelemetry.backwardPerimeterRetainedBytes = ps.retainedBytes;
      featureTelemetry.backwardPerimeterPeakWorkingBytes = ps.peakWorkingBytes;
      featureTelemetry.backwardPerimeterMaxDepth = ps.maxDepth;
      featureTelemetry.matchingComponents = ps.matchingComponents;
      featureTelemetry.matchingEliminatedEdges = ps.matchingEliminatedEdges;
      featureTelemetry.corridorViableCells = ps.corridorViableCells;
      featureTelemetry.corridorViableEdges = ps.corridorViableEdges;
    }
    throwIfSolverCancelled(context.signal);
    let componentPdbCollection: ComponentPdbCollection | null = null;
    if (features.componentPdb) {
      const cpdbBudget: ExactPreprocessingBudget = {
        ...preprocessingBudget,
        baseMemoryBytes:
          baseStaticBytes +
          (deadlockTableLookup?.estimatedRetainedBytes ?? 0) +
          (boostEvaluator?.preprocessingRetainedBytes ?? 0) +
          (pdbEvaluator?.estimatedRetainedBytes ?? 0) +
          (perimeterTable?.stats.retainedBytes ?? 0),
      };
      const singleBoxGraph = compileSingleBoxPushGraph(board, cpdbBudget);
      const matchingResult = analyzeMatchingComponents(board, singleBoxGraph);
      const matchingComponents = extractMatchingComponents(board, matchingResult);
      componentPdbCollection = buildComponentPdbCollection(
        board,
        matchingComponents,
        { totalMaxStates: 500_000, maxStatesPerComponent: 200_000 },
        cpdbBudget,
        context.now,
      );
      const cs = componentPdbCollection.stats;
      featureTelemetry.componentPdbBuildTimeMs = cs.componentPdbBuildTimeMs;
      featureTelemetry.componentPdbRetainedBytes = cs.componentPdbRetainedBytes;
      featureTelemetry.componentPdbPeakBuildBytes = cs.componentPdbPeakBuildBytes;
      featureTelemetry.componentPdbComponents = matchingComponents.length;
      if (!perimeterTable) {
        featureTelemetry.matchingComponents = matchingResult.totalComponents;
        featureTelemetry.matchingEliminatedEdges = matchingResult.eliminatedEdges;
      }
    }
    throwIfSolverCancelled(context.signal);
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
    let moveCostPdbCollection: MoveCostPatternCollection | null = null;
    if (features.moveCostPatternPdb) {
      const mcResult = probeAndSelectPatterns(
        board, preprocessingBudget, context.now,
        { incumbentCost: U < Infinity ? U : undefined },
        initialBoxes, initialRobot,
      );
      moveCostPdbCollection = mcResult.collection;
      const t = mcResult.telemetry;
      featureTelemetry.moveCostPdbBuildTimeMs = t.probeTotalMs + t.buildTotalMs;
      featureTelemetry.moveCostPdbRetainedBytes = t.totalRetainedBytes;
      featureTelemetry.moveCostPdbPatterns = t.candidatesSelected;
      featureTelemetry.moveCostPdbSettledStates = t.totalSettledStates;
    }
    throwIfSolverCancelled(context.signal);
    const preprocessingStaticBytes = baseStaticBytes +
      (deadlockTableLookup?.estimatedRetainedBytes ?? 0) +
      (boostEvaluator?.preprocessingRetainedBytes ?? 0) +
      (pdbEvaluator?.preprocessingRetainedBytes ?? 0) +
      (perimeterTable?.stats.retainedBytes ?? 0) +
      (componentPdbCollection?.retainedBytes ?? 0) +
      (moveCostPdbCollection?.estimatedRetainedBytes ?? 0);
    const currentStaticBytes = () =>
      preprocessingStaticBytes +
      (boostEvaluator?.searchCacheRetainedBytes ?? 0) +
      (pdbEvaluator?.searchCacheRetainedBytes ?? 0);
    const labelCount = labels.length;
    const labelToId = new Map<string, number>();
    for (let i = 0; i < labels.length; i++) labelToId.set(labels[i], i);
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
    const pdbSurplus = (
      boxes: readonly DenseBox[],
      labelCosts: ReadonlyMap<string, number> | null,
      boxKey?: bigint,
      labelCostsBoxKey?: bigint,
    ): number => {
      if (!pdbEvaluator || !labelCosts) return 0;
      featureTelemetry.pdbEvaluations += 1;
      return pdbEvaluator.evaluateWithSurplus(boxes, labelCosts, boxKey, labelCostsBoxKey);
    };
    const goalCut = (): number => {
      if (!goalCutEvaluator) return 0;
      const states = heuristic.lastAssignmentStates;
      if (!states) return 0;
      const value = goalCutEvaluator.evaluate(states);
      featureTelemetry.goalCutEvaluations += 1;
      featureTelemetry.goalCutTotal += value;
      return value;
    };
    const perimeterLookup = (
      tokens: ArrayLike<number>,
      boxKey: bigint,
    ): number => {
      if (!perimeterTable) return 0;
      const boxZob = zobristTable.hashFromTokensNoRobot(tokens);
      const dist = perimeterTable.lookup(boxZob, boxKey);
      if (dist === undefined) return 0;
      return dist;
    };
    const componentPdbBoxesByLabel = new Map<string, number[]>();
    const componentPdbLookup = (boxes: readonly DenseBox[]): number => {
      if (!componentPdbCollection) return 0;
      componentPdbBoxesByLabel.clear();
      for (const box of boxes) {
        let cells = componentPdbBoxesByLabel.get(box.label);
        if (!cells) {
          cells = [];
          componentPdbBoxesByLabel.set(box.label, cells);
        }
        cells.push(box.cell);
      }
      return componentPdbCollection.evaluate(componentPdbBoxesByLabel);
    };
    const computeH = (
      pushBound: number,
      lc: number,
      boost: number,
      pdb: number,
      gc: number,
      walkBound: number,
      tokens: ArrayLike<number>,
      boxes: readonly DenseBox[],
      robotCell: number,
      boxKey: bigint,
      g: number,
      pruneThreshold: number,
    ): number => {
      let totalPushBound = pushBound + Math.max(lc, boost, pdb, gc);
      if (g + totalPushBound + walkBound >= pruneThreshold) {
        counters.secondaryCutoffs++;
        return totalPushBound + walkBound;
      }
      const perimeterDist = perimeterLookup(tokens, boxKey);
      if (perimeterDist > totalPushBound) {
        const improvement = perimeterDist - totalPushBound;
        featureTelemetry.backwardPerimeterImprovements++;
        featureTelemetry.backwardPerimeterTotalImprovement += improvement;
        if (improvement > featureTelemetry.backwardPerimeterMaxImprovement) {
          featureTelemetry.backwardPerimeterMaxImprovement = improvement;
        }
        totalPushBound = perimeterDist;
      }
      const componentBound = componentPdbLookup(boxes);
      if (componentBound > totalPushBound) {
        const improvement = componentBound - totalPushBound;
        featureTelemetry.componentPdbImprovements++;
        featureTelemetry.componentPdbTotalImprovement += improvement;
        if (improvement > featureTelemetry.componentPdbMaxImprovement) {
          featureTelemetry.componentPdbMaxImprovement = improvement;
        }
        totalPushBound = componentBound;
      }
      let h = totalPushBound + walkBound;
      if (moveCostPdbCollection) {
        const mcBound = moveCostPdbCollection.evaluate(boxes, robotCell);
        if (mcBound > h) {
          const improvement = mcBound - h;
          featureTelemetry.moveCostPdbImprovements++;
          featureTelemetry.moveCostPdbTotalImprovement += improvement;
          if (improvement > featureTelemetry.moveCostPdbMaxImprovement) {
            featureTelemetry.moveCostPdbMaxImprovement = improvement;
          }
          h = mcBound;
        }
      }
      return h;
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
        preprocessingStaticBytes + (pdbEvaluator?.searchCacheRetainedBytes ?? 0),
        arena.estimatedRetainedBytes(),
        uniqueStates,
        heapSize,
        heuristic.stats.cacheEntries,
        boxCount,
      );
    pdbEvaluator?.setSearchCacheMemoryBudget((additionalBytes) => {
      const maximum = request.limits?.maxMemoryBytes;
      return maximum === undefined || estimatedArenaMemoryBytes(
        currentStaticBytes(),
        arena.estimatedRetainedBytes(),
        uniqueStates,
        heapSize,
        heuristic.stats.cacheEntries,
        boxCount,
      ) + additionalBytes <= maximum;
    });

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
    const initialLabelCostsBoxKey = heuristic.lastBoxKey;
    const initialBoost = initialLabelCosts && boostEvaluator
      ? boostEvaluator.evaluate(initialBoxes, initialLabelCosts)
      : 0;
    const initialLC = linearConflict(initialBoxes);
    const initialWalkBound = minimumManhattanWalkToPotentialPush(
      board,
      initialRobot,
      initialBoxes,
    );
    const initialBoxKey = packBoxKey(initialBoxes);
    const initialPdbSurplus = pdbSurplus(initialBoxes, initialLabelCosts, initialBoxKey, initialLabelCostsBoxKey);
    const initialGoalCut = goalCut();
    const initialH = computeH(initialPushBound, initialLC, initialBoost, initialPdbSurplus, initialGoalCut, initialWalkBound, initialTokens, initialBoxes, initialRobot, initialBoxKey, 0, Infinity);
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
      pdbRetainedBytes: pdbEvaluator?.preprocessingRetainedBytes ?? 0,
      pdbSearchCacheRetainedBytes: pdbEvaluator?.searchCacheRetainedBytes ?? 0,
      pdbEvaluations: featureTelemetry.pdbEvaluations,
      pdbCacheHits: pdbEvaluator?.surplusCacheStats.hits ?? 0,
      pdbCacheMisses: pdbEvaluator?.surplusCacheStats.misses ?? 0,
      pdbLookups: pdbEvaluator?.lookupStats.lookups ?? 0,
      pdbExitCapTrims: pdbEvaluator?.lookupStats.exitCapTrims ?? 0,
      pdbExitCapTrimTotal: pdbEvaluator?.lookupStats.exitCapTrimTotal ?? 0,
      pdbOutsideRegionLookups: pdbEvaluator?.lookupStats.outsideRegionLookups ?? 0,
      forcedPushMacroChecks: macroDetector?.stats.checks ?? 0,
      piCorralChecks: corralDetector?.stats.checks ?? 0,
      corralOrderingChecks: corralOrderer?.stats.checks ?? 0,
      corralOrderingReorders: corralOrderer?.stats.reorders ?? 0,
      patternDeadlockChecks: patternCache?.stats.checks ?? 0,
      patternDeadlockApplicable: patternCache === null ? 0 : 1,
      deadlockTableBuildTimeMs: deadlockTableLookup?.stats.buildTimeMs ?? 0,
      deadlockTableRegions: deadlockTableLookup?.stats.regionCount ?? 0,
      deadlockTablePatterns: deadlockTableLookup?.stats.patternCount ?? 0,
      deadlockTableRetainedBytes:
        deadlockTableLookup?.estimatedRetainedBytes ?? 0,
      preprocessingRetainedBytes:
        (pdbEvaluator?.preprocessingRetainedBytes ?? 0) +
        (deadlockTableLookup?.estimatedRetainedBytes ?? 0) +
        (boostEvaluator?.preprocessingRetainedBytes ?? 0),
      deadlockTableChecks: featureTelemetry.deadlockTableChecks,
      goalCommitmentChecks: commitmentDetector?.stats.checks ?? 0,
      goalCommitments: commitmentDetector?.stats.commitments ?? 0,
      goalCommitmentApplicable: commitmentDetector === null ? 0 : 1,
      tunnelMacroChecks: tunnelDetector?.stats.checks ?? 0,
      tunnelMacroApplications: tunnelDetector?.stats.applications ?? 0,
      goalCutEvaluations: goalCutEvaluator?.stats.evaluations ?? 0,
      goalCutTotal: goalCutEvaluator?.stats.cutTotal ?? 0,
      backwardPerimeterBuildExpanded: featureTelemetry.backwardPerimeterBuildExpanded,
      backwardPerimeterColoredStates: featureTelemetry.backwardPerimeterColoredStates,
      backwardPerimeterProjectedStates: featureTelemetry.backwardPerimeterProjectedStates,
      backwardPerimeterDuplicateProjections: featureTelemetry.backwardPerimeterDuplicateProjections,
      backwardPerimeterConstrainedSkipped: featureTelemetry.backwardPerimeterConstrainedSkipped,
      backwardPerimeterBuildTimeMs: featureTelemetry.backwardPerimeterBuildTimeMs,
      backwardPerimeterRetainedBytes: featureTelemetry.backwardPerimeterRetainedBytes,
      backwardPerimeterPeakWorkingBytes: featureTelemetry.backwardPerimeterPeakWorkingBytes,
      backwardPerimeterLookups: perimeterTable?.stats.lookups ?? 0,
      backwardPerimeterHits: perimeterTable?.stats.hits ?? 0,
      backwardPerimeterImprovements: featureTelemetry.backwardPerimeterImprovements,
      backwardPerimeterTotalImprovement: featureTelemetry.backwardPerimeterTotalImprovement,
      backwardPerimeterMaxImprovement: featureTelemetry.backwardPerimeterMaxImprovement,
      backwardPerimeterMaxDepth: featureTelemetry.backwardPerimeterMaxDepth,
      matchingComponents: featureTelemetry.matchingComponents,
      matchingEliminatedEdges: featureTelemetry.matchingEliminatedEdges,
      corridorViableCells: featureTelemetry.corridorViableCells,
      corridorViableEdges: featureTelemetry.corridorViableEdges,
      componentPdbBuildTimeMs: featureTelemetry.componentPdbBuildTimeMs,
      componentPdbRetainedBytes: featureTelemetry.componentPdbRetainedBytes,
      componentPdbPeakBuildBytes: featureTelemetry.componentPdbPeakBuildBytes,
      componentPdbComponents: featureTelemetry.componentPdbComponents,
      componentPdbImprovements: featureTelemetry.componentPdbImprovements,
      componentPdbTotalImprovement: featureTelemetry.componentPdbTotalImprovement,
      componentPdbMaxImprovement: featureTelemetry.componentPdbMaxImprovement,
      componentPdbPartitionQueries: componentPdbCollection?.stats.partitionQueries ?? 0,
      componentPdbPartitionCacheHits: componentPdbCollection?.stats.partitionCacheHits ?? 0,
      moveCostPdbBuildTimeMs: featureTelemetry.moveCostPdbBuildTimeMs,
      moveCostPdbRetainedBytes: featureTelemetry.moveCostPdbRetainedBytes,
      moveCostPdbPatterns: featureTelemetry.moveCostPdbPatterns,
      moveCostPdbSettledStates: featureTelemetry.moveCostPdbSettledStates,
      moveCostPdbImprovements: featureTelemetry.moveCostPdbImprovements,
      moveCostPdbTotalImprovement: featureTelemetry.moveCostPdbTotalImprovement,
      moveCostPdbMaxImprovement: featureTelemetry.moveCostPdbMaxImprovement,
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

    const nodeAllocationFitsMemory = (
      newState: boolean,
      projectedFrontierSize: number,
    ): boolean => {
      const maximum = request.limits?.maxMemoryBytes;
      return maximum === undefined || estimatedArenaMemoryBytes(
        currentStaticBytes(),
        arena.estimatedRetainedBytesAfterAllocation(),
        uniqueStates + (newState ? 1 : 0),
        projectedFrontierSize,
        heuristic.stats.cacheEntries,
        boxCount,
      ) <= maximum;
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

    const finishLimitReached = (detail: string): SolverResult => {
      if (incumbentSolution) return finishSolvedBounded(lastLowerBound);
      const m = metrics();
      return {
        status: "unsolved",
        reason: "limit-reached",
        detail,
        metrics: {
          ...m,
          counters: { ...m.counters, lowerBound: lastLowerBound },
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

    if (!nodeAllocationFitsMemory(true, 1)) {
      return finishLimitReached("Estimated solver memory limit reached.");
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

    interface RetainedSuccessor {
      readonly robotCell: number;
      readonly moves: number;
      readonly pushes: number;
      readonly parentIndex: number;
      readonly pushedFromCell: number;
      readonly pushDirection: number;
      readonly h: number;
      readonly tokens: Uint32Array;
      readonly key: bigint;
      readonly zobristKey: number;
      readonly previousBestG: number | undefined;
    }

    const retainSuccessor = (child: RetainedSuccessor): boolean => {
      if (!nodeAllocationFitsMemory(child.previousBestG === undefined, heap.size + 1)) {
        limitDetail = "Estimated solver memory limit reached.";
        return false;
      }
      const index = arena.allocate();
      arena.setRobotCell(index, child.robotCell);
      arena.setGMoves(index, child.moves);
      arena.setPushes(index, child.pushes);
      arena.setParentNode(index, child.parentIndex);
      arena.setPushedFromCell(index, child.pushedFromCell);
      arena.setPushDirection(index, child.pushDirection);
      arena.setHeuristic(index, child.h);
      arena.writeBoxTokens(index, child.tokens);
      counters.retainedBytes = arena.estimatedRetainedBytes();
      counters.maxDepth = Math.max(counters.maxDepth, child.pushes);

      if (bestGStore(child.zobristKey, child.key, child.moves)) {
        uniqueStates += 1;
      } else {
        counters.reopens += 1;
      }
      // Even a state's only legal push can have a larger f than another
      // frontier node. Every successor must compete in the global queue.
      heap.enqueue(index);
      syncState();
      counters.peakFrontier = Math.max(counters.peakFrontier, heap.size);
      return true;
    };

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
        let expandedPushBound = heuristic.evaluate(expansionBoxes);
        const expandedBoxKey = exactCodec.packBoxTokens(parentTokenBuf);
        const expandedPerimeter = perimeterLookup(parentTokenBuf, expandedBoxKey);
        if (expandedPerimeter > expandedPushBound) expandedPushBound = expandedPerimeter;
        const expandedComponentBound = componentPdbLookup(expansionBoxes);
        if (expandedComponentBound > expandedPushBound) expandedPushBound = expandedComponentBound;
        const hExpanded = expandedPushBound + expandedWalk;
        if (nodeMoves + hExpanded >= U) {
          continue;
        }
      }

      fillDeadlockOccupancy(deadlockOccupancyBuffer, expansionBoxes);
      const committedBoxes = commitmentDetector
        ? findProvenCommitments(board, expansionBoxes, commitmentDetector, deadlockOccupancyBuffer)
        : new Set<number>();

      const parentBoxKey = exactCodec.packBoxTokens(parentTokenBuf);

      if (corralOrderer) {
        corralOrderer.analyze(board, expansionBoxes, occupied, reachable);
      }

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

              if (memoryLimitReached()) {
                (expansionBoxes[fpBoxIdx] as { cell: number }).cell = savedCell;
                limitDetail = "Estimated solver memory limit reached.";
                break searchLoop;
              }
              if (Number.isFinite(pushLowerBound)) {
                const walkBound = minimumManhattanWalkToPotentialPush(
                  board, savedCell, expansionBoxes,
                );
                if (childMoves + pushLowerBound + walkBound >= U) {
                  counters.cheapCutoffs += 1;
                } else {
                const labelCosts = heuristic.lastLabelCosts;
                const labelCostsBoxKey = heuristic.lastBoxKey;
                const interactionBoost = labelCosts && boostEvaluator
                  ? boostEvaluator.evaluate(expansionBoxes, labelCosts, childBoxKey, labelCostsBoxKey)
                  : 0;
                if (interactionBoost > 0) {
                  counters.interactionBoostTotal += interactionBoost;
                }
                const fpLinearConflict = linearConflict(expansionBoxes);
                const fpPdbBoost = pdbSurplus(expansionBoxes, labelCosts, childBoxKey, labelCostsBoxKey);
                const fpGoalCut = goalCut();
                const h = computeH(pushLowerBound, fpLinearConflict, interactionBoost, fpPdbBoost, fpGoalCut, walkBound, childTokenBuf, expansionBoxes, savedCell, childBoxKey, childMoves, U);
                const f = childMoves + h;

                if (f < U) {
                  if (!retainSuccessor({
                    robotCell: savedCell,
                    moves: childMoves,
                    pushes: childPushes,
                    parentIndex: nodeIndex,
                    pushedFromCell: savedCell,
                    pushDirection: fpDir,
                    h,
                    tokens: childTokenBuf,
                    key: childKey,
                    zobristKey: childZobristKey,
                    previousBestG: prevBestG,
                  })) {
                    (expansionBoxes[fpBoxIdx] as { cell: number }).cell = savedCell;
                    break searchLoop;
                  }
                }
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

          // Tunnel macro: add stop successors (matching goal, tunnel exit, blocked
          // end). Additive only: the single-push child below is always generated.
          const tunnelResult = tunnelDetector?.resolve(
            destination, directionIndex, occupied, board.goalLabelByCell, box.label,
          );
          if (tunnelResult) {
            const tunnelStops = tunnelResult.stops;
            const tSavedCell = expansionBoxes[boxIndex].cell;
            const tDistance = reachable.distanceTo(support);
            if (tDistance < 0) {
              throw new Error("Reachable support cell has no keeper distance.");
            }
            counters.generated += tunnelStops.length;
            workSinceYield += tunnelStops.length;

            for (const stop of tunnelStops) {
              if (isStaticDeadCell(board, stop.finalCell, box.label)) {
                counters.deadlockPrunes += 1;
                continue;
              }

              (expansionBoxes[boxIndex] as { cell: number }).cell = stop.finalCell;
              fillDeadlockOccupancy(deadlockOccupancyBuffer, expansionBoxes);

              if (
                createsFullyBlockedTwoByTwoDeadlock(
                  board, expansionBoxes, stop.finalCell, deadlockOccupancyBuffer,
                )
              ) {
                (expansionBoxes[boxIndex] as { cell: number }).cell = tSavedCell;
                counters.deadlockPrunes += 1;
                continue;
              }
              if (hasFreezeDeadlock(board, expansionBoxes, deadlockOccupancyBuffer)) {
                (expansionBoxes[boxIndex] as { cell: number }).cell = tSavedCell;
                counters.deadlockPrunes += 1;
                continue;
              }
              if (
                patternCache !== null &&
                createsPatternDeadlock(board, expansionBoxes, stop.finalCell, patternCache)
              ) {
                (expansionBoxes[boxIndex] as { cell: number }).cell = tSavedCell;
                counters.patternDeadlockPrunes += 1;
                continue;
              }
              if (deadlockTableCheck(expansionBoxes, stop.finalCell)) {
                (expansionBoxes[boxIndex] as { cell: number }).cell = tSavedCell;
                counters.deadlockTablePrunes += 1;
                continue;
              }

              const tChildMoves = nodeMoves + tDistance + stop.pushCount;
              const tChildPushes = arena.pushes(nodeIndex) + stop.pushCount;
              const tOldToken = parentTokenBuf[boxIndex];
              const tNewLabelId = tokenToLabelId(tOldToken);
              const tNewToken = tNewLabelId * cellCount + stop.finalCell;
              sortedInsertToken(parentTokenBuf, boxCount, boxIndex, tNewToken, childTokenBuf);

              const tChildKey = exactCodec.packMoveState(stop.robotCell, childTokenBuf);
              const tChildZobristKey = zobristTable.hashFromTokens(childTokenBuf, stop.robotCell);
              const tPrevBestG = bestGLookup(tChildZobristKey, tChildKey);
              if (tPrevBestG !== undefined && tChildMoves >= tPrevBestG) {
                (expansionBoxes[boxIndex] as { cell: number }).cell = tSavedCell;
                counters.duplicates += 1;
                continue;
              }

              const tChildBoxKey = exactCodec.packBoxTokens(childTokenBuf);
              const tMovedLabel = labels[tNewLabelId];
              const tPushLowerBound = features.incrementalAssignment
                ? heuristic.evaluateIncremental(
                    expansionBoxes, tChildBoxKey, parentBoxKey, tMovedLabel,
                  )
                : heuristic.evaluate(expansionBoxes);
              if (memoryLimitReached()) {
                (expansionBoxes[boxIndex] as { cell: number }).cell = tSavedCell;
                limitDetail = "Estimated solver memory limit reached.";
                break searchLoop;
              }
              if (!Number.isFinite(tPushLowerBound)) {
                (expansionBoxes[boxIndex] as { cell: number }).cell = tSavedCell;
                counters.infeasiblePrunes += 1;
                continue;
              }

              const tLabelCosts = heuristic.lastLabelCosts;
              const tLabelCostsBoxKey = heuristic.lastBoxKey;
              const tInteractionBoost = tLabelCosts && boostEvaluator
                ? boostEvaluator.evaluate(expansionBoxes, tLabelCosts, tChildBoxKey, tLabelCostsBoxKey)
                : 0;
              if (tInteractionBoost > 0) counters.interactionBoostTotal += tInteractionBoost;
              const tLC = linearConflict(expansionBoxes);
              const tPdbBoost = pdbSurplus(expansionBoxes, tLabelCosts, tChildBoxKey, tLabelCostsBoxKey);
              const tGoalCut = goalCut();
              const tWalkBound = minimumManhattanWalkToPotentialPush(
                board, stop.robotCell, expansionBoxes,
              );
              const tH = computeH(tPushLowerBound, tLC, tInteractionBoost, tPdbBoost, tGoalCut, tWalkBound, childTokenBuf, expansionBoxes, stop.robotCell, tChildBoxKey, tChildMoves, U);
              const tF = tChildMoves + tH;

              (expansionBoxes[boxIndex] as { cell: number }).cell = tSavedCell;

              if (tF >= U) continue;

              if (!retainSuccessor({
                robotCell: stop.robotCell,
                moves: tChildMoves,
                pushes: tChildPushes,
                parentIndex: nodeIndex,
                pushedFromCell: box.cell,
                pushDirection: encodeTunnelPushDirection(directionIndex, stop.pushCount),
                h: tH,
                tokens: childTokenBuf,
                key: tChildKey,
                zobristKey: tChildZobristKey,
                previousBestG: tPrevBestG,
              })) {
                break searchLoop;
              }
            }
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
          if (memoryLimitReached()) {
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
          const labelCostsBoxKey = heuristic.lastBoxKey;
          const interactionBoost = labelCosts && boostEvaluator
            ? boostEvaluator.evaluate(expansionBoxes, labelCosts, childBoxKey, labelCostsBoxKey)
            : 0;
          if (interactionBoost > 0) counters.interactionBoostTotal += interactionBoost;

          const childLinearConflict = linearConflict(expansionBoxes);
          const childPdbBoost = pdbSurplus(expansionBoxes, labelCosts, childBoxKey, labelCostsBoxKey);
          const childGoalCut = goalCut();

          const walkBound = minimumManhattanWalkToPotentialPush(
            board,
            savedCell,
            expansionBoxes,
          );
          const h = computeH(pushLowerBound, childLinearConflict, interactionBoost, childPdbBoost, childGoalCut, walkBound, childTokenBuf, expansionBoxes, savedCell, childBoxKey, childMoves, U);
          const f = childMoves + h;

          (expansionBoxes[boxIndex] as { cell: number }).cell = savedCell;

          if (f >= U) {
            continue;
          }

          if (!retainSuccessor({
            robotCell: box.cell,
            moves: childMoves,
            pushes: childPushes,
            parentIndex: nodeIndex,
            pushedFromCell: box.cell,
            pushDirection: directionIndex,
            h,
            tokens: childTokenBuf,
            key: childKey,
            zobristKey: childZobristKey,
            previousBestG: prevBestG,
          })) {
            break searchLoop;
          }
        }
      }
    }

    syncState();
    if (limitDetail) {
      // Include the dequeued active node's f-value in any cutoff bound;
      // the remaining heap alone can overstate proof progress.
      return finishLimitReached(limitDetail);
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
        // An optimal proof must travel with a proven solution, as in the
        // limit branch above.
        const proven = lastLowerBound >= U;
        const boundedProof: SolverProof =
          proven
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
          solution: proven
            ? { ...incumbentSolution, optimality: "proven" }
            : incumbentSolution,
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
