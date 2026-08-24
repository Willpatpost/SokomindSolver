import type { PuzzleDefinition } from "../../../core/model.ts";
import type { SolutionStep } from "../../../solver/contracts.ts";
import { validatePuzzle } from "../../../core/puzzle.ts";
import { createSession } from "../../../core/game-session.ts";
import { classicGreedySolver } from "../../../solver/implementations/classic-solvers.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TighteningParams {
  readonly maxMutationsPerPass: number;
  readonly maxAccepted: number;
  readonly solverLimitMs: number;
  readonly solverLimitStates: number;
}

export const DEFAULT_TIGHTENING_PARAMS: TighteningParams = {
  maxMutationsPerPass: 200,
  maxAccepted: 80,
  solverLimitMs: 10_000,
  solverLimitStates: 1_500_000,
};

export interface TighteningMetrics {
  readonly totalFloor: number;
  readonly unusedFloorRatio: number;
  readonly emptyWalkRatio: number;
  readonly longestWalkStreak: number;
  readonly repetitivePushRatio: number;
  readonly movesPerPush: number;
  readonly solutionMoves: number;
  readonly solutionPushes: number;
  readonly boxIndependenceRatio: number;
  readonly solverExpandedStates: number;
  readonly deadlockDensity: number;
}

export interface TighteningResult {
  readonly original: PuzzleDefinition;
  readonly tightened: PuzzleDefinition;
  readonly mutationsTried: number;
  readonly mutationsAccepted: number;
  readonly mutationsRejected: number;
  readonly cellsRemoved: number;
  readonly elapsedMs: number;
  readonly metrics: {
    readonly before: TighteningMetrics;
    readonly after: TighteningMetrics;
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function tightenPuzzle(
  puzzle: PuzzleDefinition,
  params: TighteningParams = DEFAULT_TIGHTENING_PARAMS,
): Promise<TighteningResult | null> {
  const start = performance.now();

  const baseline = await solvAndMeasure(puzzle, params);
  if (!baseline) return null;

  const grid = puzzle.rows.map((r) => [...r]);

  const entities = findEntities(grid);
  const solutionCells = trackSolutionCells(puzzle, baseline.steps);

  let accepted = 0;
  let rejected = 0;
  let tried = 0;
  let currentMetrics = baseline.metrics;

  const candidates = rankCandidates(grid, entities, solutionCells);

  for (const cell of candidates) {
    if (tried >= params.maxMutationsPerPass) break;
    if (accepted >= params.maxAccepted) break;

    const { row, col } = cell;
    if (grid[row][col] === "O") continue;

    const original = grid[row][col];
    grid[row][col] = "O";
    tried++;

    if (!isConnected(grid, entities)) {
      grid[row][col] = original;
      rejected++;
      continue;
    }

    const mutatedPuzzle = gridToPuzzle(grid, puzzle);
    const validation = validatePuzzle(mutatedPuzzle);
    if (!validation.valid) {
      grid[row][col] = original;
      rejected++;
      continue;
    }

    const solveResult = await solvAndMeasure(mutatedPuzzle, params);
    if (!solveResult) {
      grid[row][col] = original;
      rejected++;
      continue;
    }

    if (hasRegression(currentMetrics, solveResult.metrics)) {
      grid[row][col] = original;
      rejected++;
      continue;
    }

    accepted++;
    currentMetrics = solveResult.metrics;
  }

  if (accepted === 0) {
    return {
      original: puzzle,
      tightened: puzzle,
      mutationsTried: tried,
      mutationsAccepted: 0,
      mutationsRejected: rejected,
      cellsRemoved: 0,
      elapsedMs: performance.now() - start,
      metrics: { before: baseline.metrics, after: baseline.metrics },
    };
  }

  const tightened = gridToPuzzle(grid, puzzle);

  const afterMetrics = currentMetrics;

  return {
    original: puzzle,
    tightened,
    mutationsTried: tried,
    mutationsAccepted: accepted,
    mutationsRejected: rejected,
    cellsRemoved: accepted,
    elapsedMs: performance.now() - start,
    metrics: { before: baseline.metrics, after: afterMetrics },
  };
}

// ---------------------------------------------------------------------------
// Entity detection
// ---------------------------------------------------------------------------

interface EntitySet {
  readonly robot: { row: number; col: number };
  readonly boxes: ReadonlyArray<{ row: number; col: number }>;
  readonly goals: ReadonlyArray<{ row: number; col: number }>;
  readonly allKeys: ReadonlySet<string>;
}

function findEntities(grid: string[][]): EntitySet {
  const h = grid.length;
  const w = h > 0 ? grid[0].length : 0;
  let robot = { row: 0, col: 0 };
  const boxes: Array<{ row: number; col: number }> = [];
  const goals: Array<{ row: number; col: number }> = [];
  const allKeys = new Set<string>();

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const ch = grid[r][c];
      if (ch === "R") {
        robot = { row: r, col: c };
        allKeys.add(`${r},${c}`);
      } else if (ch === "X" || (ch >= "A" && ch <= "Z" && ch !== "O" && ch !== "R" && ch !== "S" && ch !== "X")) {
        boxes.push({ row: r, col: c });
        allKeys.add(`${r},${c}`);
      } else if (ch === "S" || (ch >= "a" && ch <= "z")) {
        goals.push({ row: r, col: c });
        allKeys.add(`${r},${c}`);
      }
    }
  }

  return { robot, boxes, goals, allKeys };
}

// ---------------------------------------------------------------------------
// Solution path tracking
// ---------------------------------------------------------------------------

function trackSolutionCells(
  puzzle: PuzzleDefinition,
  steps: readonly SolutionStep[],
): Set<string> {
  const grid = puzzle.rows.map((r) => [...r]);
  const h = grid.length;
  const w = h > 0 ? grid[0].length : 0;
  const visited = new Set<string>();

  let robot = { row: 0, col: 0 };
  const boxes: Array<{ row: number; col: number }> = [];

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const ch = grid[r][c];
      if (ch === "R") robot = { row: r, col: c };
      if (ch === "X" || (ch >= "A" && ch <= "Z" && ch !== "O" && ch !== "R" && ch !== "S")) {
        boxes.push({ row: r, col: c });
      }
    }
  }

  visited.add(`${robot.row},${robot.col}`);

  for (const step of steps) {
    const dir = directionDelta(step.direction);
    const nr = robot.row + dir.row;
    const nc = robot.col + dir.col;

    visited.add(`${nr},${nc}`);

    if (step.kind === "push") {
      const destR = nr + dir.row;
      const destC = nc + dir.col;
      visited.add(`${destR},${destC}`);

      const bi = boxes.findIndex((b) => b.row === nr && b.col === nc);
      if (bi >= 0) {
        boxes[bi] = { row: destR, col: destC };
      }
    }

    robot = { row: nr, col: nc };
  }

  return visited;
}

// ---------------------------------------------------------------------------
// Candidate ranking
// ---------------------------------------------------------------------------

interface CellCandidate {
  readonly row: number;
  readonly col: number;
  readonly priority: number;
}

function rankCandidates(
  grid: string[][],
  entities: EntitySet,
  solutionCells: Set<string>,
): CellCandidate[] {
  const h = grid.length;
  const w = h > 0 ? grid[0].length : 0;
  const candidates: CellCandidate[] = [];

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      if (grid[r][c] === "O") continue;
      if (r === 0 || r === h - 1 || c === 0 || c === w - 1) continue;

      const key = `${r},${c}`;
      if (entities.allKeys.has(key)) continue;

      const onSolutionPath = solutionCells.has(key);
      const minEntityDist = minDistToEntities(r, c, entities);
      const neighbors = floorNeighborCount(grid, r, c);
      const isDeadEnd = neighbors <= 1;
      const isAlcove = neighbors === 1 && !onSolutionPath;

      let priority = 0;
      if (isAlcove) priority += 100;
      if (isDeadEnd && !onSolutionPath) priority += 80;
      if (!onSolutionPath) priority += 50;
      priority += minEntityDist * 3;
      priority -= neighbors * 5;

      candidates.push({ row: r, col: c, priority });
    }
  }

  candidates.sort((a, b) => b.priority - a.priority);
  return candidates;
}

function minDistToEntities(row: number, col: number, entities: EntitySet): number {
  let minDist = Infinity;

  const dist = (r: number, c: number) =>
    Math.abs(row - r) + Math.abs(col - c);

  minDist = Math.min(minDist, dist(entities.robot.row, entities.robot.col));
  for (const b of entities.boxes) minDist = Math.min(minDist, dist(b.row, b.col));
  for (const g of entities.goals) minDist = Math.min(minDist, dist(g.row, g.col));

  return minDist;
}

// ---------------------------------------------------------------------------
// Connectivity check
// ---------------------------------------------------------------------------

const DR = [-1, 1, 0, 0];
const DC = [0, 0, -1, 1];

function isConnected(grid: string[][], entities: EntitySet): boolean {
  const h = grid.length;
  const w = h > 0 ? grid[0].length : 0;

  const startR = entities.robot.row;
  const startC = entities.robot.col;
  if (grid[startR][startC] === "O") return false;

  const visited = new Set<string>();
  const queue: Array<[number, number]> = [[startR, startC]];
  visited.add(`${startR},${startC}`);

  while (queue.length > 0) {
    const [r, c] = queue.shift()!;
    for (let d = 0; d < 4; d++) {
      const nr = r + DR[d];
      const nc = c + DC[d];
      if (nr < 0 || nr >= h || nc < 0 || nc >= w) continue;
      if (grid[nr][nc] === "O") continue;
      const key = `${nr},${nc}`;
      if (visited.has(key)) continue;
      visited.add(key);
      queue.push([nr, nc]);
    }
  }

  for (const b of entities.boxes) {
    if (!visited.has(`${b.row},${b.col}`)) return false;
  }
  for (const g of entities.goals) {
    if (!visited.has(`${g.row},${g.col}`)) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Grid helpers
// ---------------------------------------------------------------------------

function floorNeighborCount(grid: string[][], r: number, c: number): number {
  let count = 0;
  for (let d = 0; d < 4; d++) {
    const nr = r + DR[d];
    const nc = c + DC[d];
    if (nr >= 0 && nr < grid.length && nc >= 0 && nc < grid[0].length && grid[nr][nc] !== "O") {
      count++;
    }
  }
  return count;
}

function directionDelta(dir: string): { row: number; col: number } {
  switch (dir) {
    case "up": return { row: -1, col: 0 };
    case "down": return { row: 1, col: 0 };
    case "left": return { row: 0, col: -1 };
    case "right": return { row: 0, col: 1 };
    default: return { row: 0, col: 0 };
  }
}

function gridToPuzzle(grid: string[][], original: PuzzleDefinition): PuzzleDefinition {
  return {
    ...original,
    rows: grid.map((row) => row.join("")),
  };
}

// ---------------------------------------------------------------------------
// Solve and measure
// ---------------------------------------------------------------------------

interface SolveResult {
  readonly steps: SolutionStep[];
  readonly metrics: TighteningMetrics;
}

async function solvAndMeasure(
  puzzle: PuzzleDefinition,
  params: TighteningParams,
): Promise<SolveResult | null> {
  const session = createSession(puzzle);
  const request = {
    board: session.board,
    snapshot: session.snapshot,
    objective: { kind: "moves" as const },
    limits: {
      maxElapsedMs: params.solverLimitMs,
      maxExpandedStates: params.solverLimitStates,
    },
  };
  const context = {
    signal: new AbortController().signal,
    reportProgress: () => {},
    now: () => performance.now(),
  };

  const result = await classicGreedySolver.solve(request, context);
  if (result.status !== "solved") return null;

  const steps = result.solution.steps as SolutionStep[];
  const metrics = computeTighteningMetrics(puzzle, steps, result.metrics);

  return { steps, metrics };
}

function computeTighteningMetrics(
  puzzle: PuzzleDefinition,
  steps: readonly SolutionStep[],
  solverMetrics: { expandedStates?: number; counters?: Record<string, unknown> },
): TighteningMetrics {
  const grid = puzzle.rows.map((r) => [...r]);
  const h = grid.length;
  const w = h > 0 ? grid[0].length : 0;

  let totalFloor = 0;
  let usedCells = 0;
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      if (grid[r][c] !== "O") totalFloor++;
      if (grid[r][c] !== "O" && grid[r][c] !== " ") usedCells++;
    }
  }
  const unusedFloor = totalFloor - usedCells;
  const unusedFloorRatio = totalFloor > 0 ? Math.max(0, unusedFloor / totalFloor) : 0;

  let walks = 0;
  let pushes = 0;
  let longestWalkStreak = 0;
  let currentWalkStreak = 0;
  let repetitivePushes = 0;
  let lastPushDir = "";

  for (const step of steps) {
    if (step.kind === "walk") {
      walks++;
      currentWalkStreak++;
      if (currentWalkStreak > longestWalkStreak) longestWalkStreak = currentWalkStreak;
    } else {
      currentWalkStreak = 0;
      pushes++;
      if (lastPushDir === step.direction) repetitivePushes++;
      lastPushDir = step.direction;
    }
  }

  const totalMoves = steps.length;
  const emptyWalkRatio = totalMoves > 0 ? walks / totalMoves : 0;
  const repetitivePushRatio = pushes > 1 ? repetitivePushes / (pushes - 1) : 0;
  const movesPerPush = pushes > 0 ? totalMoves / pushes : 0;

  const boxIndependenceRatio = computeBoxIndependence(puzzle, steps);

  const expanded = solverMetrics.expandedStates ?? 0;
  const counters = solverMetrics.counters ?? {};
  const deadlockPrunes =
    ((counters.deadlockPrunes as number) ?? 0) +
    ((counters.patternDeadlockPrunes as number) ?? 0);
  const deadlockDensity = expanded > 0 ? deadlockPrunes / expanded : 0;

  return {
    totalFloor,
    unusedFloorRatio,
    emptyWalkRatio,
    longestWalkStreak,
    repetitivePushRatio,
    movesPerPush,
    solutionMoves: totalMoves,
    solutionPushes: pushes,
    boxIndependenceRatio,
    solverExpandedStates: expanded,
    deadlockDensity,
  };
}

function computeBoxIndependence(
  puzzle: PuzzleDefinition,
  steps: readonly SolutionStep[],
): number {
  const grid = puzzle.rows.map((r) => [...r]);
  const h = grid.length;
  const w = h > 0 ? grid[0].length : 0;

  let robot = { row: 0, col: 0 };
  const boxes: Array<{ row: number; col: number }> = [];

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const ch = grid[r][c];
      if (ch === "R") robot = { row: r, col: c };
      if (ch === "X" || (ch >= "A" && ch <= "Z" && ch !== "O" && ch !== "R" && ch !== "S")) {
        boxes.push({ row: r, col: c });
      }
    }
  }

  if (boxes.length <= 1) return 0;

  let transitions = 0;
  let prevBoxIdx = -1;
  let totalPushes = 0;

  for (const step of steps) {
    const dir = directionDelta(step.direction);
    const nr = robot.row + dir.row;
    const nc = robot.col + dir.col;

    if (step.kind === "push") {
      const bi = boxes.findIndex((b) => b.row === nr && b.col === nc);
      if (bi >= 0) {
        if (prevBoxIdx >= 0 && bi !== prevBoxIdx) transitions++;
        prevBoxIdx = bi;
        totalPushes++;
        boxes[bi] = { row: nr + dir.row, col: nc + dir.col };
      }
    }
    robot = { row: nr, col: nc };
  }

  return totalPushes > 1
    ? Math.max(0, 1 - Math.min(1, transitions / (totalPushes - 1)))
    : 1;
}

// ---------------------------------------------------------------------------
// Regression detection
// ---------------------------------------------------------------------------

function hasRegression(before: TighteningMetrics, after: TighteningMetrics): boolean {
  if (after.boxIndependenceRatio > before.boxIndependenceRatio + 0.15) return true;

  if (after.solutionPushes === 0 && before.solutionPushes > 0) return true;

  if (
    before.solverExpandedStates > 10 &&
    after.solverExpandedStates < before.solverExpandedStates * 0.3
  ) {
    return true;
  }

  if (
    before.deadlockDensity > 0.5 &&
    after.deadlockDensity < before.deadlockDensity * 0.3
  ) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Batch tightening helper
// ---------------------------------------------------------------------------

export async function tightenPuzzles(
  puzzles: readonly PuzzleDefinition[],
  params: TighteningParams = DEFAULT_TIGHTENING_PARAMS,
): Promise<readonly TighteningResult[]> {
  const results: TighteningResult[] = [];
  for (const puzzle of puzzles) {
    const result = await tightenPuzzle(puzzle, params);
    if (result) results.push(result);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Summary statistics for tightening results
// ---------------------------------------------------------------------------

export interface TighteningSummary {
  readonly count: number;
  readonly totalCellsRemoved: number;
  readonly avgCellsRemoved: number;
  readonly avgAcceptanceRate: number;
  readonly avgRejectionRate: number;
  readonly avgElapsedMs: number;
  readonly avgFloorBefore: number;
  readonly avgFloorAfter: number;
  readonly avgUnusedBefore: number;
  readonly avgUnusedAfter: number;
  readonly avgWalkRatioBefore: number;
  readonly avgWalkRatioAfter: number;
  readonly avgLongestWalkBefore: number;
  readonly avgLongestWalkAfter: number;
  readonly avgRepetitiveBefore: number;
  readonly avgRepetitiveAfter: number;
  readonly avgMovesPerPushBefore: number;
  readonly avgMovesPerPushAfter: number;
  readonly avgMovesBefore: number;
  readonly avgMovesAfter: number;
  readonly avgPushesBefore: number;
  readonly avgPushesAfter: number;
  readonly avgBoxIndBefore: number;
  readonly avgBoxIndAfter: number;
  readonly avgSolverEffortBefore: number;
  readonly avgSolverEffortAfter: number;
  readonly avgDeadlockBefore: number;
  readonly avgDeadlockAfter: number;
}

export function summarizeTighteningResults(
  results: readonly TighteningResult[],
): TighteningSummary {
  const n = results.length;
  if (n === 0) {
    return {
      count: 0,
      totalCellsRemoved: 0,
      avgCellsRemoved: 0,
      avgAcceptanceRate: 0,
      avgRejectionRate: 0,
      avgElapsedMs: 0,
      avgFloorBefore: 0,
      avgFloorAfter: 0,
      avgUnusedBefore: 0,
      avgUnusedAfter: 0,
      avgWalkRatioBefore: 0,
      avgWalkRatioAfter: 0,
      avgLongestWalkBefore: 0,
      avgLongestWalkAfter: 0,
      avgRepetitiveBefore: 0,
      avgRepetitiveAfter: 0,
      avgMovesPerPushBefore: 0,
      avgMovesPerPushAfter: 0,
      avgMovesBefore: 0,
      avgMovesAfter: 0,
      avgPushesBefore: 0,
      avgPushesAfter: 0,
      avgBoxIndBefore: 0,
      avgBoxIndAfter: 0,
      avgSolverEffortBefore: 0,
      avgSolverEffortAfter: 0,
      avgDeadlockBefore: 0,
      avgDeadlockAfter: 0,
    };
  }

  const sum = (fn: (r: TighteningResult) => number) =>
    results.reduce((s, r) => s + fn(r), 0) / n;

  return {
    count: n,
    totalCellsRemoved: results.reduce((s, r) => s + r.cellsRemoved, 0),
    avgCellsRemoved: sum((r) => r.cellsRemoved),
    avgAcceptanceRate: sum((r) =>
      r.mutationsTried > 0 ? r.mutationsAccepted / r.mutationsTried : 0,
    ),
    avgRejectionRate: sum((r) =>
      r.mutationsTried > 0 ? r.mutationsRejected / r.mutationsTried : 0,
    ),
    avgElapsedMs: sum((r) => r.elapsedMs),
    avgFloorBefore: sum((r) => r.metrics.before.totalFloor),
    avgFloorAfter: sum((r) => r.metrics.after.totalFloor),
    avgUnusedBefore: sum((r) => r.metrics.before.unusedFloorRatio),
    avgUnusedAfter: sum((r) => r.metrics.after.unusedFloorRatio),
    avgWalkRatioBefore: sum((r) => r.metrics.before.emptyWalkRatio),
    avgWalkRatioAfter: sum((r) => r.metrics.after.emptyWalkRatio),
    avgLongestWalkBefore: sum((r) => r.metrics.before.longestWalkStreak),
    avgLongestWalkAfter: sum((r) => r.metrics.after.longestWalkStreak),
    avgRepetitiveBefore: sum((r) => r.metrics.before.repetitivePushRatio),
    avgRepetitiveAfter: sum((r) => r.metrics.after.repetitivePushRatio),
    avgMovesPerPushBefore: sum((r) => r.metrics.before.movesPerPush),
    avgMovesPerPushAfter: sum((r) => r.metrics.after.movesPerPush),
    avgMovesBefore: sum((r) => r.metrics.before.solutionMoves),
    avgMovesAfter: sum((r) => r.metrics.after.solutionMoves),
    avgPushesBefore: sum((r) => r.metrics.before.solutionPushes),
    avgPushesAfter: sum((r) => r.metrics.after.solutionPushes),
    avgBoxIndBefore: sum((r) => r.metrics.before.boxIndependenceRatio),
    avgBoxIndAfter: sum((r) => r.metrics.after.boxIndependenceRatio),
    avgSolverEffortBefore: sum((r) => r.metrics.before.solverExpandedStates),
    avgSolverEffortAfter: sum((r) => r.metrics.after.solverExpandedStates),
    avgDeadlockBefore: sum((r) => r.metrics.before.deadlockDensity),
    avgDeadlockAfter: sum((r) => r.metrics.after.deadlockDensity),
  };
}
