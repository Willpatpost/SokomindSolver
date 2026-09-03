import type { Difficulty, PuzzleDefinition } from "../../../core/model.ts";
import type { SolutionStep } from "../../../solver/contracts.ts";
import { validatePuzzle } from "../../../core/puzzle.ts";
import { classicGreedySolver } from "../../../solver/implementations/classic-solvers.ts";
import { analyzeSolutionUsage } from "./solution-usage.ts";
import { analyzeGrid, type StructuralMetrics } from "./structural-metrics.ts";
import { isBoxChar, isGoalChar, isRobotChar, isWallChar, WALL_CHAR } from "./tile-semantics.ts";
import { solveWithEvidence, witnessedResult, verifiedWitnessResult, type GenerationEvidence } from "./generation-evidence.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TighteningParams {
  readonly maxMutationsPerPass: number;
  readonly maxAccepted: number;
  readonly solverLimitMs: number;
  readonly solverLimitStates: number;
}

export interface TighteningPreservationContext {
  readonly protectedCells?: ReadonlySet<string>;
  readonly baselineStructural?: StructuralMetrics;
  readonly minRoomFloorFraction?: number;
  readonly roomFloorBaselines?: ReadonlyMap<number, number>;
  readonly protectedPassageCells?: ReadonlySet<string>;
  readonly protectedChokepointNeighborhoods?: ReadonlySet<string>;
}

export interface TierTighteningPolicy {
  readonly enabled: boolean;
  readonly maxAccepted: number;
  readonly maxMutationsPerPass: number;
  readonly minPlayableFloor: number;
  readonly minFloorCoverage: number;
  readonly minRegionCount: number;
  readonly minChokepointCount: number;
  readonly protectSolutionPath: boolean;
  readonly protectPassageCells: boolean;
  readonly protectChokepointNeighborhoods: boolean;
  readonly maxFloorPerBox?: number;
  readonly targetSolutionFloorCoverage?: number;
}

export const DEFAULT_TIER_TIGHTENING_POLICIES: Readonly<Record<Difficulty, TierTighteningPolicy>> = {
  tutorial: {
    enabled: true,
    maxAccepted: 80,
    maxMutationsPerPass: 200,
    minPlayableFloor: 8,
    minFloorCoverage: 0.15,
    minRegionCount: 1,
    minChokepointCount: 0,
    protectSolutionPath: false,
    protectPassageCells: false,
    protectChokepointNeighborhoods: false,
  },
  beginner: {
    enabled: true,
    maxAccepted: 80,
    maxMutationsPerPass: 200,
    minPlayableFloor: 10,
    minFloorCoverage: 0.15,
    minRegionCount: 1,
    minChokepointCount: 0,
    protectSolutionPath: false,
    protectPassageCells: false,
    protectChokepointNeighborhoods: false,
  },
  intermediate: {
    enabled: true,
    maxAccepted: 60,
    maxMutationsPerPass: 180,
    minPlayableFloor: 12,
    minFloorCoverage: 0.20,
    minRegionCount: 1,
    minChokepointCount: 0,
    protectSolutionPath: false,
    protectPassageCells: false,
    protectChokepointNeighborhoods: false,
  },
  advanced: {
    enabled: true,
    maxAccepted: 40,
    maxMutationsPerPass: 150,
    minPlayableFloor: 15,
    minFloorCoverage: 0.25,
    minRegionCount: 1,
    minChokepointCount: 0,
    protectSolutionPath: true,
    protectPassageCells: false,
    protectChokepointNeighborhoods: false,
  },
  expert: {
    enabled: true,
    maxAccepted: 30,
    maxMutationsPerPass: 150,
    minPlayableFloor: 15,
    minFloorCoverage: 0.25,
    minRegionCount: 2,
    minChokepointCount: 1,
    protectSolutionPath: true,
    protectPassageCells: true,
    protectChokepointNeighborhoods: true,
    maxFloorPerBox: 12,
  },
  master: {
    enabled: true,
    maxAccepted: 30,
    maxMutationsPerPass: 150,
    minPlayableFloor: 20,
    minFloorCoverage: 0.25,
    minRegionCount: 2,
    minChokepointCount: 1,
    protectSolutionPath: true,
    protectPassageCells: true,
    protectChokepointNeighborhoods: true,
    maxFloorPerBox: 10,
  },
};

export const DEFAULT_TIGHTENING_PARAMS: TighteningParams = {
  maxMutationsPerPass: 200,
  maxAccepted: 80,
  solverLimitMs: 10_000,
  solverLimitStates: 1_500_000,
};

export interface TighteningMetrics {
  readonly totalFloor: number;
  readonly unusedFloorRatio: number;
  readonly solutionUnusedFloorRatio: number;
  readonly emptyWalkRatio: number;
  readonly longestWalkStreak: number;
  readonly repetitivePushRatio: number;
  readonly movesPerPush: number;
  readonly solutionMoves: number;
  readonly solutionPushes: number;
  readonly boxIndependenceRatio: number;
  readonly pushSwitchRatio: number;
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
  readonly protectedCellCount: number;
  readonly tierPolicyUsed?: string;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function tightenPuzzle(
  puzzle: PuzzleDefinition,
  params: TighteningParams = DEFAULT_TIGHTENING_PARAMS,
  preservation?: TighteningPreservationContext,
  tierPolicy?: TierTighteningPolicy,
  evidence?: GenerationEvidence,
  witness?: readonly SolutionStep[],
): Promise<TighteningResult | null> {
  const start = performance.now();

  // If tier policy is provided and disabled, return a no-op result immediately
  if (tierPolicy && !tierPolicy.enabled) {
    const baseline = await solvAndMeasure(puzzle, params, evidence, witness);
    if (!baseline) return null;
    return {
      original: puzzle,
      tightened: puzzle,
      mutationsTried: 0,
      mutationsAccepted: 0,
      mutationsRejected: 0,
      cellsRemoved: 0,
      elapsedMs: performance.now() - start,
      metrics: { before: baseline.metrics, after: baseline.metrics },
      protectedCellCount: 0,
      tierPolicyUsed: findTierPolicyName(tierPolicy),
    };
  }

  // Apply tier policy overrides to params
  const effectiveParams: TighteningParams = tierPolicy
    ? {
        ...params,
        maxAccepted: tierPolicy.maxAccepted,
        maxMutationsPerPass: tierPolicy.maxMutationsPerPass,
      }
    : params;

  const baseline = await solvAndMeasure(puzzle, effectiveParams, evidence, witness);
  if (!baseline) return null;

  const grid = puzzle.rows.map((r) => [...r]);

  const entities = findEntities(grid);
  const solutionCells = trackSolutionCells(puzzle, baseline.steps);

  // Build the effective protected cells set, merging preservation context
  // with tier policy protection flags
  const mergedProtected = new Set<string>(preservation?.protectedCells ?? []);

  if (tierPolicy?.protectSolutionPath) {
    for (const key of solutionCells) {
      mergedProtected.add(key);
    }
  }

  if (tierPolicy?.protectPassageCells && preservation?.protectedPassageCells) {
    for (const key of preservation.protectedPassageCells) {
      mergedProtected.add(key);
    }
  }

  if (tierPolicy?.protectChokepointNeighborhoods && preservation?.protectedChokepointNeighborhoods) {
    for (const key of preservation.protectedChokepointNeighborhoods) {
      mergedProtected.add(key);
    }
  }

  const protectedCellCount = mergedProtected.size;
  const effectiveProtectedCells: ReadonlySet<string> | undefined =
    mergedProtected.size > 0 ? mergedProtected : preservation?.protectedCells;

  let accepted = 0;
  let rejected = 0;
  let tried = 0;
  let currentMetrics = baseline.metrics;
  let currentStructural = preservation?.baselineStructural ?? analyzeGrid(grid);

  const candidates = rankCandidates(grid, entities, solutionCells, effectiveProtectedCells);

  for (const cell of candidates) {
    if (tried >= effectiveParams.maxMutationsPerPass) break;
    if (accepted >= effectiveParams.maxAccepted) break;

    const { row, col } = cell;
    if (isWallChar(grid[row][col])) continue;

    const original = grid[row][col];
    grid[row][col] = WALL_CHAR;
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

    // Structural regression check (preservation context or tier policy)
    if (preservation || tierPolicy) {
      const afterStructural = analyzeGrid(grid);
      if (preservation && hasStructuralRegression(currentStructural, afterStructural, preservation)) {
        grid[row][col] = original;
        rejected++;
        continue;
      }

      // Tier policy structural constraints
      if (tierPolicy) {
        if (!passesTierStructuralConstraints(tierPolicy, afterStructural, grid)) {
          grid[row][col] = original;
          rejected++;
          continue;
        }
      }
    }

    const solveResult = await solvAndMeasure(mutatedPuzzle, effectiveParams, evidence, witness);
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
    if (preservation || tierPolicy) {
      currentStructural = analyzeGrid(grid);
    }

    if (tierPolicy?.maxFloorPerBox && puzzle.boxes > 0) {
      if (currentStructural.totalFloor / puzzle.boxes <= tierPolicy.maxFloorPerBox &&
        1 - currentMetrics.solutionUnusedFloorRatio >= (tierPolicy.targetSolutionFloorCoverage ?? 0)) {
        break;
      }
    }
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
      protectedCellCount,
      tierPolicyUsed: tierPolicy ? findTierPolicyName(tierPolicy) : undefined,
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
    protectedCellCount,
    tierPolicyUsed: tierPolicy ? findTierPolicyName(tierPolicy) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Tier policy helpers
// ---------------------------------------------------------------------------

function passesTierStructuralConstraints(
  policy: TierTighteningPolicy,
  structural: StructuralMetrics,
  grid: string[][],
): boolean {
  if (structural.totalFloor < policy.minPlayableFloor) return false;

  const totalCells = grid.length * (grid.length > 0 ? grid[0].length : 0);
  if (totalCells > 0 && structural.totalFloor / totalCells < policy.minFloorCoverage) return false;

  if (structural.regionCount < policy.minRegionCount) return false;

  if (structural.chokepointCount < policy.minChokepointCount) return false;

  return true;
}

function findTierPolicyName(policy: TierTighteningPolicy): string {
  for (const [name, p] of Object.entries(DEFAULT_TIER_TIGHTENING_POLICIES)) {
    if (p === policy) return name;
  }
  return "custom";
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
      if (isRobotChar(ch)) {
        robot = { row: r, col: c };
        allKeys.add(`${r},${c}`);
      } else if (isBoxChar(ch)) {
        boxes.push({ row: r, col: c });
        allKeys.add(`${r},${c}`);
      } else if (isGoalChar(ch)) {
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
      if (isRobotChar(ch)) robot = { row: r, col: c };
      if (isBoxChar(ch)) {
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
  protectedCells?: ReadonlySet<string>,
): CellCandidate[] {
  const h = grid.length;
  const w = h > 0 ? grid[0].length : 0;
  const candidates: CellCandidate[] = [];

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      if (isWallChar(grid[r][c])) continue;
      if (r === 0 || r === h - 1 || c === 0 || c === w - 1) continue;

      const key = `${r},${c}`;
      if (entities.allKeys.has(key)) continue;
      if (protectedCells?.has(key)) continue;

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
  if (isWallChar(grid[startR][startC])) return false;

  const visited = new Set<string>();
  const queue: Array<[number, number]> = [[startR, startC]];
  visited.add(`${startR},${startC}`);

  while (queue.length > 0) {
    const [r, c] = queue.shift()!;
    for (let d = 0; d < 4; d++) {
      const nr = r + DR[d];
      const nc = c + DC[d];
      if (nr < 0 || nr >= h || nc < 0 || nc >= w) continue;
      if (isWallChar(grid[nr][nc])) continue;
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
    if (nr >= 0 && nr < grid.length && nc >= 0 && nc < grid[0].length && !isWallChar(grid[nr][nc])) {
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
  evidence?: GenerationEvidence,
  witness?: readonly SolutionStep[],
): Promise<SolveResult | null> {
  if (evidence?.witnessFirst) {
    const verified = verifiedWitnessResult(puzzle, witness, evidence);
    // Refinement is optional: never search repeatedly for a replacement route.
    if (!verified) return null;
    return { steps: [...verified.solution.steps], metrics: computeTighteningMetrics(puzzle, verified.solution.steps, {}) };
  }
  const attempted = await solveWithEvidence(puzzle, classicGreedySolver, {
    maxElapsedMs: params.solverLimitMs, maxExpandedStates: params.solverLimitStates,
  }, undefined, evidence);
  const result = witnessedResult(puzzle, witness, attempted, evidence);
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
      if (!isWallChar(grid[r][c])) totalFloor++;
      if (!isWallChar(grid[r][c]) && grid[r][c] !== " ") usedCells++;
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
  const usageMetrics = analyzeSolutionUsage(grid, steps, totalFloor);

  const expanded = solverMetrics.expandedStates ?? 0;
  const counters = solverMetrics.counters ?? {};
  const deadlockPrunes =
    ((counters.deadlockPrunes as number) ?? 0) +
    ((counters.patternDeadlockPrunes as number) ?? 0);
  const deadlockDensity = expanded > 0 ? deadlockPrunes / expanded : 0;

  return {
    totalFloor,
    unusedFloorRatio,
    solutionUnusedFloorRatio: usageMetrics.solutionUnusedFloorRatio,
    emptyWalkRatio,
    longestWalkStreak,
    repetitivePushRatio,
    movesPerPush,
    solutionMoves: totalMoves,
    solutionPushes: pushes,
    boxIndependenceRatio,
    pushSwitchRatio: boxIndependenceRatio,
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
      if (isRobotChar(ch)) robot = { row: r, col: c };
      if (isBoxChar(ch)) {
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

function hasStructuralRegression(
  before: StructuralMetrics,
  after: StructuralMetrics,
  preservation: TighteningPreservationContext,
): boolean {
  if (after.connectedComponents > before.connectedComponents) return true;

  if (after.articulationCount < before.articulationCount - 1) return true;

  if (before.regionCount > 1 && after.regionCount < before.regionCount) return true;

  if (before.chokepointCount > 0 && after.chokepointCount < before.chokepointCount - 1) return true;

  if (preservation.roomFloorBaselines && preservation.minRoomFloorFraction) {
    const fraction = preservation.minRoomFloorFraction;
    for (const [regionGate, baselineFloor] of preservation.roomFloorBaselines) {
      const currentRegion = after.regions.find((r) => r.gate === regionGate);
      if (currentRegion && currentRegion.size < baselineFloor * fraction) return true;
    }
  }

  return false;
}

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
// Convenience: build preservation context from puzzle grid
// ---------------------------------------------------------------------------

export function buildPreservationContext(
  grid: readonly (readonly string[])[],
  protectedCells?: ReadonlySet<string>,
  minRoomFloorFraction: number = 0.6,
): TighteningPreservationContext {
  const height = grid.length;
  const width = height > 0 ? grid[0].length : 0;
  const structural = analyzeGrid(grid);
  const roomFloorBaselines = new Map<number, number>();
  for (const region of structural.regions) {
    roomFloorBaselines.set(region.gate, region.size);
  }

  // Compute protected passage cells: cells in tunnels that connect regions
  // through narrow corridors. Tunnel cells are cells with exactly 2 floor
  // neighbors that are collinear (forming a corridor).
  const protectedPassageCells = new Set<string>();
  for (const tunnelIdx of structural.tunnelCells) {
    const r = Math.floor(tunnelIdx / width);
    const c = tunnelIdx % width;
    protectedPassageCells.add(`${r},${c}`);
  }

  // Compute protected chokepoint neighborhoods: each chokepoint cell
  // plus its cardinal neighbors
  const protectedChokepointNeighborhoods = new Set<string>();
  for (const chokepointIdx of structural.chokepoints) {
    const r = Math.floor(chokepointIdx / width);
    const c = chokepointIdx % width;
    protectedChokepointNeighborhoods.add(`${r},${c}`);
    for (let d = 0; d < 4; d++) {
      const nr = r + DR[d];
      const nc = c + DC[d];
      if (nr >= 0 && nr < height && nc >= 0 && nc < width && !isWallChar(grid[nr][nc])) {
        protectedChokepointNeighborhoods.add(`${nr},${nc}`);
      }
    }
  }

  return {
    protectedCells,
    baselineStructural: structural,
    minRoomFloorFraction,
    roomFloorBaselines,
    protectedPassageCells,
    protectedChokepointNeighborhoods,
  };
}

// ---------------------------------------------------------------------------
// Batch tightening helper
// ---------------------------------------------------------------------------

export async function tightenPuzzles(
  puzzles: readonly PuzzleDefinition[],
  params: TighteningParams = DEFAULT_TIGHTENING_PARAMS,
  preservation?: TighteningPreservationContext,
): Promise<readonly TighteningResult[]> {
  const results: TighteningResult[] = [];
  for (const puzzle of puzzles) {
    const result = await tightenPuzzle(puzzle, params, preservation);
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
