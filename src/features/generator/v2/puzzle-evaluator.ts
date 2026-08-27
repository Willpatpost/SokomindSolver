import type { PuzzleDefinition } from "../../../core/model.ts";
import type { SolverResult, SolverRunMetrics, SolutionStep } from "../../../solver/contracts.ts";
import { createSession } from "../../../core/game-session.ts";
import { classicGreedySolver } from "../../../solver/implementations/classic-solvers.ts";
import { directionDelta } from "../../../core/position.ts";
import { analyzeGrid, type StructuralMetrics } from "./structural-metrics.ts";
import { enumerateReachablePushes } from "./reachable-pushes.ts";
import { analyzeSolutionUsage } from "./solution-usage.ts";
import { analyzeInteraction } from "./interaction-analysis.ts";
import { analyzeSolutionDepth } from "./solution-depth-analysis.ts";
import { isBoxChar, isGoalChar, isRobotChar } from "./tile-semantics.ts";

// ---------------------------------------------------------------------------
// Evaluation vector — all raw metrics, no premature aggregation
// ---------------------------------------------------------------------------

export interface PuzzleEvaluationVector {
  // --- Solver effort ---
  readonly solverExpandedStates: number;
  readonly solverGeneratedStates: number;
  readonly solverElapsedMs: number;
  readonly solverPeakFrontier: number;
  readonly solverDeadlockPrunes: number;
  readonly solverDuplicateStates: number;

  // --- Solution quality ---
  readonly solutionMoves: number;
  readonly solutionPushes: number;
  readonly solutionWalks: number;
  readonly pushRatio: number;
  readonly boxCount: number;

  // --- Decision branching (adjacent-only, legacy) ---
  readonly avgLegalPushes: number;
  readonly maxLegalPushes: number;
  readonly singleChoiceRatio: number;
  readonly highBranchCount: number;

  // --- Decision branching (reachable, correct) ---
  readonly avgReachablePushes: number;
  readonly maxReachablePushes: number;
  readonly reachableSingleChoiceRatio: number;
  readonly reachableHighBranchCount: number;
  readonly reachableForcedPushRatio: number;

  // --- Box interaction (push-switch, legacy name) ---
  readonly boxIndependenceRatio: number;
  readonly boxInteractionEvents: number;
  readonly pushesPerBox: number;
  readonly pushSwitchRatio: number;

  // --- Causal interaction ---
  readonly sharedRouteCells: number;
  readonly sharedSupportCells: number;
  readonly sharedChokepointUses: number;
  readonly causalEnableCount: number;
  readonly causalDisableCount: number;

  // --- Packing / room traffic ---
  readonly roomCrossingsInSolution: number;

  // --- Deadlock pressure ---
  readonly deadlockDensity: number;

  // --- Structural complexity (from Sprint 2 metrics) ---
  readonly articulationPoints: number;
  readonly regionCount: number;
  readonly tunnelCells: number;
  readonly chokepoints: number;
  readonly floorUtilization: number;
  readonly openAreaRatio: number;

  // --- Tedium signals ---
  readonly emptyWalkRatio: number;
  readonly longestWalkStreak: number;
  readonly forcedPushRatio: number;
  readonly repetitivePushRatio: number;
  readonly unusedFloorRatio: number;
  readonly movesPerPush: number;

  // --- Solution floor usage (correct, replaces static unusedFloorRatio) ---
  readonly solutionFloorCoverage: number;
  readonly solutionUnusedFloorRatio: number;

  // --- Solution depth (Phase 6) ---
  readonly nonMonotonicBoxMoves: number;
  readonly nonMonotonicBoxCount: number;
  readonly stagingOperations: number;
  readonly temporaryGoalVacancies: number;
  readonly boxSwitchRate: number;
  readonly distinctBoxesMoved: number;
  readonly multiMoveBoxCount: number;
  readonly maxBoxEpisodes: number;
  readonly estimatedDependencyDepth: number;
  readonly goalOrderConstraints: number;

  // --- Board properties ---
  readonly boardWidth: number;
  readonly boardHeight: number;
  readonly totalFloor: number;

  // --- Status ---
  readonly solved: boolean;
}

// ---------------------------------------------------------------------------
// Evaluate a puzzle
// ---------------------------------------------------------------------------

export interface PuzzleEvaluationResult {
  readonly vector: PuzzleEvaluationVector;
  readonly steps: readonly SolutionStep[] | null;
}

export async function evaluatePuzzleWithSteps(
  puzzle: PuzzleDefinition,
  signal?: AbortSignal,
): Promise<PuzzleEvaluationResult> {
  const session = createSession(puzzle);
  const grid = puzzle.rows.map((r) => [...r]);

  const structMetrics = analyzeGrid(grid);

  const request = {
    board: session.board,
    snapshot: session.snapshot,
    objective: { kind: "moves" as const },
    limits: { maxElapsedMs: 15_000, maxExpandedStates: 2_000_000 },
  };
  const context = {
    signal: signal ?? new AbortController().signal,
    reportProgress: () => {},
    now: () => performance.now(),
  };

  const result: SolverResult = await classicGreedySolver.solve(request, context);

  if (result.status !== "solved") {
    return {
      vector: buildUnsolvedVector(puzzle, grid, structMetrics, result.metrics),
      steps: null,
    };
  }

  const { solution, metrics } = result;
  const steps = solution.steps;

  const branchMetrics = analyzeBranching(puzzle, steps);
  const walkMetrics = analyzeWalkPatterns(steps);
  const boxMetrics = analyzeBoxInteraction(puzzle, steps, puzzle.boxes);
  const roomMetrics = analyzeRoomTraffic(steps, grid, structMetrics);
  const tediumMetrics = analyzeTedium(steps, structMetrics, grid);
  const effortMetrics = extractEffort(metrics);
  const usageMetrics = analyzeSolutionUsage(grid, steps, structMetrics.totalFloor);
  const interactionMetrics = analyzeInteraction(
    grid, steps, structMetrics.chokepoints, grid[0]?.length ?? 0,
  );
  const depthMetrics = analyzeSolutionDepth(grid, steps);

  return {
    vector: {
      solverExpandedStates: effortMetrics.expanded,
      solverGeneratedStates: effortMetrics.generated,
      solverElapsedMs: metrics.elapsedMs,
      solverPeakFrontier: effortMetrics.peakFrontier,
      solverDeadlockPrunes: effortMetrics.deadlockPrunes,
      solverDuplicateStates: effortMetrics.duplicates,
      solutionMoves: solution.moves,
      solutionPushes: solution.pushes,
      solutionWalks: solution.moves - solution.pushes,
      pushRatio: solution.moves > 0 ? solution.pushes / solution.moves : 0,
      boxCount: puzzle.boxes,
      avgLegalPushes: branchMetrics.avgLegalPushes,
      maxLegalPushes: branchMetrics.maxLegalPushes,
      singleChoiceRatio: branchMetrics.singleChoiceRatio,
      highBranchCount: branchMetrics.highBranchCount,
      avgReachablePushes: branchMetrics.avgReachablePushes,
      maxReachablePushes: branchMetrics.maxReachablePushes,
      reachableSingleChoiceRatio: branchMetrics.reachableSingleChoiceRatio,
      reachableHighBranchCount: branchMetrics.reachableHighBranchCount,
      reachableForcedPushRatio: branchMetrics.reachableForcedPushRatio,
      boxIndependenceRatio: boxMetrics.independenceRatio,
      boxInteractionEvents: boxMetrics.interactionEvents,
      pushesPerBox: puzzle.boxes > 0 ? solution.pushes / puzzle.boxes : 0,
      pushSwitchRatio: boxMetrics.independenceRatio,
      sharedRouteCells: interactionMetrics.sharedRouteCells,
      sharedSupportCells: interactionMetrics.sharedSupportCells,
      sharedChokepointUses: interactionMetrics.sharedChokepointUses,
      causalEnableCount: interactionMetrics.causalEnableCount,
      causalDisableCount: interactionMetrics.causalDisableCount,
      roomCrossingsInSolution: roomMetrics.roomCrossings,
      deadlockDensity: effortMetrics.expanded > 0
        ? effortMetrics.deadlockPrunes / effortMetrics.expanded
        : 0,
      articulationPoints: structMetrics.articulationCount,
      regionCount: structMetrics.regionCount,
      tunnelCells: structMetrics.tunnelCount,
      chokepoints: structMetrics.chokepointCount,
      floorUtilization: structMetrics.floorUtilization,
      openAreaRatio: structMetrics.openAreaRatio,
      emptyWalkRatio: walkMetrics.emptyWalkRatio,
      longestWalkStreak: walkMetrics.longestWalkStreak,
      forcedPushRatio: branchMetrics.forcedPushRatio,
      repetitivePushRatio: tediumMetrics.repetitivePushRatio,
      unusedFloorRatio: tediumMetrics.unusedFloorRatio,
      movesPerPush: solution.pushes > 0 ? solution.moves / solution.pushes : 0,
      solutionFloorCoverage: usageMetrics.solutionFloorCoverage,
      solutionUnusedFloorRatio: usageMetrics.solutionUnusedFloorRatio,
      nonMonotonicBoxMoves: depthMetrics.nonMonotonicBoxMoves,
      nonMonotonicBoxCount: depthMetrics.nonMonotonicBoxCount,
      stagingOperations: depthMetrics.stagingOperations,
      temporaryGoalVacancies: depthMetrics.temporaryGoalVacancies,
      boxSwitchRate: depthMetrics.boxSwitchRate,
      distinctBoxesMoved: depthMetrics.distinctBoxesMoved,
      multiMoveBoxCount: depthMetrics.multiMoveBoxCount,
      maxBoxEpisodes: depthMetrics.maxBoxEpisodes,
      estimatedDependencyDepth: depthMetrics.estimatedDependencyDepth,
      goalOrderConstraints: depthMetrics.goalOrderConstraints,
      boardWidth: grid[0]?.length ?? 0,
      boardHeight: grid.length,
      totalFloor: structMetrics.totalFloor,
      solved: true,
    },
    steps,
  };
}

export async function evaluatePuzzle(
  puzzle: PuzzleDefinition,
  signal?: AbortSignal,
): Promise<PuzzleEvaluationVector> {
  const result = await evaluatePuzzleWithSteps(puzzle, signal);
  return result.vector;
}

// ---------------------------------------------------------------------------
// Unsolved fallback — return what we can measure without a solution
// ---------------------------------------------------------------------------

function buildUnsolvedVector(
  puzzle: PuzzleDefinition,
  grid: string[][],
  metrics: StructuralMetrics,
  solverMetrics: SolverRunMetrics,
): PuzzleEvaluationVector {
  const effort = extractEffort(solverMetrics);
  return {
    solverExpandedStates: effort.expanded,
    solverGeneratedStates: effort.generated,
    solverElapsedMs: solverMetrics.elapsedMs,
    solverPeakFrontier: effort.peakFrontier,
    solverDeadlockPrunes: effort.deadlockPrunes,
    solverDuplicateStates: effort.duplicates,

    solutionMoves: 0,
    solutionPushes: 0,
    solutionWalks: 0,
    pushRatio: 0,
    boxCount: puzzle.boxes,

    avgLegalPushes: 0,
    maxLegalPushes: 0,
    singleChoiceRatio: 0,
    highBranchCount: 0,

    avgReachablePushes: 0,
    maxReachablePushes: 0,
    reachableSingleChoiceRatio: 0,
    reachableHighBranchCount: 0,
    reachableForcedPushRatio: 0,

    boxIndependenceRatio: 1,
    boxInteractionEvents: 0,
    pushesPerBox: 0,
    pushSwitchRatio: 1,

    sharedRouteCells: 0,
    sharedSupportCells: 0,
    sharedChokepointUses: 0,
    causalEnableCount: 0,
    causalDisableCount: 0,

    roomCrossingsInSolution: 0,

    deadlockDensity: 0,

    articulationPoints: metrics.articulationCount,
    regionCount: metrics.regionCount,
    tunnelCells: metrics.tunnelCount,
    chokepoints: metrics.chokepointCount,
    floorUtilization: metrics.floorUtilization,
    openAreaRatio: metrics.openAreaRatio,

    emptyWalkRatio: 0,
    longestWalkStreak: 0,
    forcedPushRatio: 0,
    repetitivePushRatio: 0,
    unusedFloorRatio: computeUnusedFloorRatio(grid, metrics),
    movesPerPush: 0,

    solutionFloorCoverage: 0,
    solutionUnusedFloorRatio: 1,

    nonMonotonicBoxMoves: 0,
    nonMonotonicBoxCount: 0,
    stagingOperations: 0,
    temporaryGoalVacancies: 0,
    boxSwitchRate: 0,
    distinctBoxesMoved: 0,
    multiMoveBoxCount: 0,
    maxBoxEpisodes: 0,
    estimatedDependencyDepth: 0,
    goalOrderConstraints: 0,

    boardWidth: grid[0]?.length ?? 0,
    boardHeight: grid.length,
    totalFloor: metrics.totalFloor,

    solved: false,
  };
}

// ---------------------------------------------------------------------------
// Solver effort extraction
// ---------------------------------------------------------------------------

interface EffortMetrics {
  expanded: number;
  generated: number;
  peakFrontier: number;
  deadlockPrunes: number;
  duplicates: number;
}

function extractEffort(metrics: SolverRunMetrics): EffortMetrics {
  const counters = metrics.counters ?? {};
  return {
    expanded: metrics.expandedStates ?? 0,
    generated: metrics.generatedStates ?? 0,
    peakFrontier: metrics.peakFrontierSize ?? 0,
    deadlockPrunes: (counters.deadlockPrunes as number ?? 0) +
      (counters.patternDeadlockPrunes as number ?? 0),
    duplicates: counters.duplicateStates as number ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Walk pattern analysis
// ---------------------------------------------------------------------------

interface WalkMetrics {
  emptyWalkRatio: number;
  longestWalkStreak: number;
}

function analyzeWalkPatterns(steps: readonly SolutionStep[]): WalkMetrics {
  if (steps.length === 0) return { emptyWalkRatio: 0, longestWalkStreak: 0 };

  let walks = 0;
  let longestStreak = 0;
  let currentStreak = 0;

  for (const step of steps) {
    if (step.kind === "walk") {
      walks++;
      currentStreak++;
      if (currentStreak > longestStreak) longestStreak = currentStreak;
    } else {
      currentStreak = 0;
    }
  }

  return {
    emptyWalkRatio: walks / steps.length,
    longestWalkStreak: longestStreak,
  };
}

// ---------------------------------------------------------------------------
// Branching analysis — count legal pushes at each push step
// ---------------------------------------------------------------------------

interface BranchMetrics {
  avgLegalPushes: number;
  maxLegalPushes: number;
  singleChoiceRatio: number;
  highBranchCount: number;
  forcedPushRatio: number;
  avgReachablePushes: number;
  maxReachablePushes: number;
  reachableSingleChoiceRatio: number;
  reachableHighBranchCount: number;
  reachableForcedPushRatio: number;
}

const DR = [-1, 1, 0, 0];
const DC = [0, 0, -1, 1];

function analyzeBranching(
  puzzle: PuzzleDefinition,
  steps: readonly SolutionStep[],
): BranchMetrics {
  const zeroBranch: BranchMetrics = {
    avgLegalPushes: 0, maxLegalPushes: 0, singleChoiceRatio: 0, highBranchCount: 0, forcedPushRatio: 0,
    avgReachablePushes: 0, maxReachablePushes: 0, reachableSingleChoiceRatio: 0, reachableHighBranchCount: 0, reachableForcedPushRatio: 0,
  };

  if (steps.length === 0) return zeroBranch;

  const grid = puzzle.rows.map((r) => [...r]);
  const h = grid.length;
  const w = h > 0 ? grid[0].length : 0;

  let robot = { row: 0, column: 0 };
  const boxes: Array<{ row: number; column: number }> = [];
  const goalSet = new Set<string>();

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const ch = grid[r][c];
      if (isRobotChar(ch)) { robot = { row: r, column: c }; grid[r][c] = " "; }
      if (isBoxChar(ch)) { boxes.push({ row: r, column: c }); grid[r][c] = " "; }
      if (isGoalChar(ch)) { goalSet.add(`${r},${c}`); }
    }
  }

  const pushCounts: number[] = [];
  const reachablePushCounts: number[] = [];
  let forcedPushes = 0;
  let reachableForcedPushes = 0;

  const boxSet = new Set(boxes.map((b) => `${b.row},${b.column}`));

  for (const step of steps) {
    if (step.kind === "push") {
      const legalPushes = countLegalPushes(robot, boxes, boxSet, grid, h, w);
      pushCounts.push(legalPushes);
      if (legalPushes <= 1) forcedPushes++;

      const reachable = enumerateReachablePushes(grid, robot, boxes);
      reachablePushCounts.push(reachable.length);
      if (reachable.length <= 1) reachableForcedPushes++;
    }

    const dir = directionDelta(step.direction);
    const nr = robot.row + dir.row;
    const nc = robot.column + dir.column;

    if (step.kind === "push") {
      const boxKey = `${nr},${nc}`;
      const bi = boxes.findIndex((b) => b.row === nr && b.column === nc);
      if (bi >= 0) {
        boxSet.delete(boxKey);
        boxes[bi] = { row: nr + dir.row, column: nc + dir.column };
        boxSet.add(`${boxes[bi].row},${boxes[bi].column}`);
      }
    }
    robot = { row: nr, column: nc };
  }

  if (pushCounts.length === 0) return zeroBranch;

  const avg = pushCounts.reduce((a, b) => a + b, 0) / pushCounts.length;
  const max = Math.max(...pushCounts);
  const singles = pushCounts.filter((c) => c <= 1).length;
  const highs = pushCounts.filter((c) => c >= 4).length;

  const rAvg = reachablePushCounts.reduce((a, b) => a + b, 0) / reachablePushCounts.length;
  const rMax = Math.max(...reachablePushCounts);
  const rSingles = reachablePushCounts.filter((c) => c <= 1).length;
  const rHighs = reachablePushCounts.filter((c) => c >= 4).length;

  return {
    avgLegalPushes: avg,
    maxLegalPushes: max,
    singleChoiceRatio: singles / pushCounts.length,
    highBranchCount: highs,
    forcedPushRatio: forcedPushes / pushCounts.length,
    avgReachablePushes: rAvg,
    maxReachablePushes: rMax,
    reachableSingleChoiceRatio: rSingles / reachablePushCounts.length,
    reachableHighBranchCount: rHighs,
    reachableForcedPushRatio: reachableForcedPushes / reachablePushCounts.length,
  };
}

function countLegalPushes(
  robot: { row: number; column: number },
  boxes: Array<{ row: number; column: number }>,
  boxSet: Set<string>,
  grid: string[][],
  h: number,
  w: number,
): number {
  let count = 0;
  for (let d = 0; d < 4; d++) {
    const adjR = robot.row + DR[d];
    const adjC = robot.column + DC[d];
    if (adjR < 0 || adjR >= h || adjC < 0 || adjC >= w) continue;
    if (!boxSet.has(`${adjR},${adjC}`)) continue;
    const destR = adjR + DR[d];
    const destC = adjC + DC[d];
    if (destR < 0 || destR >= h || destC < 0 || destC >= w) continue;
    if (grid[destR][destC] === "O") continue;
    if (boxSet.has(`${destR},${destC}`)) continue;
    count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Box interaction analysis
// ---------------------------------------------------------------------------

interface BoxInteractionMetrics {
  independenceRatio: number;
  interactionEvents: number;
}

function analyzeBoxInteraction(
  puzzle: PuzzleDefinition,
  steps: readonly SolutionStep[],
  boxCount: number,
): BoxInteractionMetrics {
  if (boxCount <= 1 || steps.length === 0) {
    return { independenceRatio: boxCount <= 1 ? 0 : 1, interactionEvents: 0 };
  }

  const grid = puzzle.rows.map((r) => [...r]);
  const h = grid.length;
  const w = h > 0 ? grid[0].length : 0;

  let robot = { row: 0, column: 0 };
  const boxes: Array<{ row: number; column: number }> = [];

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const ch = grid[r][c];
      if (isRobotChar(ch)) robot = { row: r, column: c };
      if (isBoxChar(ch)) boxes.push({ row: r, column: c });
    }
  }

  let transitions = 0;
  let prevBoxIdx = -1;
  let totalPushes = 0;

  for (const step of steps) {
    const dir = directionDelta(step.direction);
    const nr = robot.row + dir.row;
    const nc = robot.column + dir.column;

    if (step.kind === "push") {
      const bi = boxes.findIndex((b) => b.row === nr && b.column === nc);
      if (bi >= 0) {
        if (prevBoxIdx >= 0 && bi !== prevBoxIdx) transitions++;
        prevBoxIdx = bi;
        totalPushes++;
        boxes[bi] = { row: nr + dir.row, column: nc + dir.column };
      }
    }
    robot = { row: nr, column: nc };
  }

  const independenceRatio = totalPushes > 1
    ? 1 - Math.min(1, transitions / (totalPushes - 1))
    : 1;

  return {
    independenceRatio: Math.max(0, independenceRatio),
    interactionEvents: transitions,
  };
}

// ---------------------------------------------------------------------------
// Room traffic analysis — count box movements across region boundaries
// ---------------------------------------------------------------------------

interface RoomTrafficMetrics {
  roomCrossings: number;
}

function analyzeRoomTraffic(
  steps: readonly SolutionStep[],
  grid: string[][],
  metrics: StructuralMetrics,
): RoomTrafficMetrics {
  if (metrics.regions.length === 0) return { roomCrossings: 0 };

  const h = grid.length;
  const w = h > 0 ? grid[0].length : 0;

  const regionMap = new Map<string, number>();
  for (let ri = 0; ri < metrics.regions.length; ri++) {
    for (const cellIdx of metrics.regions[ri].cells) {
      const cr = Math.floor(cellIdx / w);
      const cc = cellIdx % w;
      regionMap.set(`${cr},${cc}`, ri);
    }
  }

  let robot = { row: 0, column: 0 };
  const boxes: Array<{ row: number; column: number }> = [];
  const boxSet = new Set<string>();

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const ch = grid[r][c];
      if (isRobotChar(ch)) robot = { row: r, column: c };
      if (isBoxChar(ch)) {
        boxes.push({ row: r, column: c });
        boxSet.add(`${r},${c}`);
      }
    }
  }

  let crossings = 0;
  for (const step of steps) {
    const dir = directionDelta(step.direction);
    const nr = robot.row + dir.row;
    const nc = robot.column + dir.column;

    if (step.kind === "push") {
      const bi = boxes.findIndex((b) => b.row === nr && b.column === nc);
      if (bi >= 0) {
        const fromRegion = regionMap.get(`${nr},${nc}`);
        const destR = nr + dir.row;
        const destC = nc + dir.column;
        const toRegion = regionMap.get(`${destR},${destC}`);
        if (fromRegion !== undefined && toRegion !== undefined && fromRegion !== toRegion) {
          crossings++;
        }
        boxSet.delete(`${nr},${nc}`);
        boxes[bi] = { row: destR, column: destC };
        boxSet.add(`${destR},${destC}`);
      }
    }
    robot = { row: nr, column: nc };
  }

  return { roomCrossings: crossings };
}

// ---------------------------------------------------------------------------
// Tedium analysis
// ---------------------------------------------------------------------------

interface TediumMetrics {
  repetitivePushRatio: number;
  unusedFloorRatio: number;
}

function analyzeTedium(
  steps: readonly SolutionStep[],
  metrics: StructuralMetrics,
  grid: string[][],
): TediumMetrics {
  const pushDirs: string[] = [];
  for (const step of steps) {
    if (step.kind === "push") {
      pushDirs.push(step.direction);
    }
  }

  let repetitive = 0;
  for (let i = 1; i < pushDirs.length; i++) {
    if (pushDirs[i] === pushDirs[i - 1]) repetitive++;
  }
  const repetitivePushRatio = pushDirs.length > 1
    ? repetitive / (pushDirs.length - 1)
    : 0;

  const unusedFloorRatio = computeUnusedFloorRatio(grid, metrics);

  return { repetitivePushRatio, unusedFloorRatio };
}

function computeUnusedFloorRatio(
  grid: string[][],
  metrics: StructuralMetrics,
): number {
  const h = grid.length;
  const w = h > 0 ? grid[0].length : 0;

  let usedCells = 0;
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const ch = grid[r][c];
      if (ch !== "O" && ch !== " ") usedCells++;
    }
  }

  const unusedFloor = metrics.totalFloor - usedCells;
  return metrics.totalFloor > 0 ? Math.max(0, unusedFloor / metrics.totalFloor) : 0;
}

// ---------------------------------------------------------------------------
// Batch evaluation helper
// ---------------------------------------------------------------------------

export async function evaluatePuzzles(
  puzzles: readonly PuzzleDefinition[],
  signal?: AbortSignal,
): Promise<readonly PuzzleEvaluationVector[]> {
  const results: PuzzleEvaluationVector[] = [];
  for (const puzzle of puzzles) {
    if (signal?.aborted) break;
    results.push(await evaluatePuzzle(puzzle, signal));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Summary statistics for a population of evaluations
// ---------------------------------------------------------------------------

export interface PopulationSummary {
  readonly count: number;
  readonly solvedCount: number;
  readonly avg: Readonly<Record<string, number>>;
  readonly median: Readonly<Record<string, number>>;
  readonly min: Readonly<Record<string, number>>;
  readonly max: Readonly<Record<string, number>>;
}

const NUMERIC_KEYS: readonly (keyof PuzzleEvaluationVector)[] = [
  "solverExpandedStates",
  "solverGeneratedStates",
  "solverElapsedMs",
  "solverPeakFrontier",
  "solverDeadlockPrunes",
  "solverDuplicateStates",
  "solutionMoves",
  "solutionPushes",
  "solutionWalks",
  "pushRatio",
  "boxCount",
  "avgLegalPushes",
  "maxLegalPushes",
  "singleChoiceRatio",
  "highBranchCount",
  "avgReachablePushes",
  "maxReachablePushes",
  "reachableSingleChoiceRatio",
  "reachableHighBranchCount",
  "reachableForcedPushRatio",
  "boxIndependenceRatio",
  "boxInteractionEvents",
  "pushesPerBox",
  "pushSwitchRatio",
  "sharedRouteCells",
  "sharedSupportCells",
  "sharedChokepointUses",
  "causalEnableCount",
  "causalDisableCount",
  "roomCrossingsInSolution",
  "deadlockDensity",
  "articulationPoints",
  "regionCount",
  "tunnelCells",
  "chokepoints",
  "floorUtilization",
  "openAreaRatio",
  "emptyWalkRatio",
  "longestWalkStreak",
  "forcedPushRatio",
  "repetitivePushRatio",
  "unusedFloorRatio",
  "movesPerPush",
  "solutionFloorCoverage",
  "solutionUnusedFloorRatio",
  "nonMonotonicBoxMoves",
  "nonMonotonicBoxCount",
  "stagingOperations",
  "temporaryGoalVacancies",
  "boxSwitchRate",
  "distinctBoxesMoved",
  "multiMoveBoxCount",
  "maxBoxEpisodes",
  "estimatedDependencyDepth",
  "goalOrderConstraints",
  "boardWidth",
  "boardHeight",
  "totalFloor",
];

export function summarizePopulation(
  vectors: readonly PuzzleEvaluationVector[],
): PopulationSummary {
  const solved = vectors.filter((v) => v.solved);
  const count = vectors.length;
  const solvedCount = solved.length;

  const avg: Record<string, number> = {};
  const median: Record<string, number> = {};
  const min: Record<string, number> = {};
  const max: Record<string, number> = {};

  for (const key of NUMERIC_KEYS) {
    const values = solved.map((v) => v[key] as number).sort((a, b) => a - b);
    if (values.length === 0) {
      avg[key] = 0;
      median[key] = 0;
      min[key] = 0;
      max[key] = 0;
      continue;
    }
    avg[key] = values.reduce((a, b) => a + b, 0) / values.length;
    median[key] = values[Math.floor(values.length / 2)];
    min[key] = values[0];
    max[key] = values[values.length - 1];
  }

  return { count, solvedCount, avg, median, min, max };
}
