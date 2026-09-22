import type { PuzzleDefinition } from "../../../core/model.ts";
import type { SolverResult, SolverSolution, SolutionStep } from "../../../solver/contracts.ts";
import { createSession } from "../../../core/game-session.ts";
import { classicAStarSolver } from "../../../solver/implementations/classic-solvers.ts";
import { validatePuzzleRows } from "../../../core/puzzle.ts";
import { scoreSolution, type SolutionScore } from "./solution-scoring.ts";

export interface RefinementBudget {
  readonly maxIterations?: number;
  readonly maxElapsedMs?: number;
  readonly maxSolverCalls?: number;
}

export interface RefinementResult {
  readonly puzzle: PuzzleDefinition;
  readonly solutionSteps: readonly SolutionStep[];
  readonly solutionScore: SolutionScore;
  readonly iterations: number;
  readonly solverCalls: number;
  readonly elapsedMs: number;
  readonly improved: boolean;
}

interface CellPosition {
  readonly row: number;
  readonly col: number;
}

function parseGrid(rows: readonly string[]): string[][] {
  return rows.map((row) => [...row]);
}

function gridToRows(grid: readonly (readonly string[])[]): string[] {
  return grid.map((row) => row.join(""));
}

function isWall(ch: string): boolean {
  return ch === "O";
}

function findWallBorderCells(grid: readonly (readonly string[])[]): CellPosition[] {
  const result: CellPosition[] = [];
  const h = grid.length;
  const w = grid[0].length;
  const deltas = [[-1, 0], [1, 0], [0, -1], [0, 1]];

  for (let r = 1; r < h - 1; r++) {
    for (let c = 1; c < w - 1; c++) {
      if (!isWall(grid[r][c])) continue;
      for (const [dr, dc] of deltas) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr >= 0 && nr < h && nc >= 0 && nc < w && !isWall(grid[nr][nc])) {
          result.push({ row: r, col: c });
          break;
        }
      }
    }
  }
  return result;
}

function findFloorBorderCells(grid: readonly (readonly string[])[]): CellPosition[] {
  const result: CellPosition[] = [];
  const h = grid.length;
  const w = grid[0].length;
  const deltas = [[-1, 0], [1, 0], [0, -1], [0, 1]];

  for (let r = 1; r < h - 1; r++) {
    for (let c = 1; c < w - 1; c++) {
      if (grid[r][c] !== " ") continue;
      for (const [dr, dc] of deltas) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr >= 0 && nr < h && nc >= 0 && nc < w && isWall(grid[nr][nc])) {
          result.push({ row: r, col: c });
          break;
        }
      }
    }
  }
  return result;
}

function findGoalCells(grid: readonly (readonly string[])[]): CellPosition[] {
  const result: CellPosition[] = [];
  const h = grid.length;
  const w = grid[0].length;
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const ch = grid[r][c];
      if (ch === "S" || (ch >= "a" && ch <= "z")) {
        result.push({ row: r, col: c });
      }
    }
  }
  return result;
}

function findRobotCell(grid: readonly (readonly string[])[]): CellPosition | null {
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[0].length; c++) {
      if (grid[r][c] === "R") return { row: r, col: c };
    }
  }
  return null;
}

function findEmptyFloorCells(grid: readonly (readonly string[])[]): CellPosition[] {
  const result: CellPosition[] = [];
  for (let r = 1; r < grid.length - 1; r++) {
    for (let c = 1; c < grid[0].length - 1; c++) {
      if (grid[r][c] === " ") result.push({ row: r, col: c });
    }
  }
  return result;
}

function isConnected(grid: readonly (readonly string[])[]): boolean {
  const h = grid.length;
  const w = grid[0].length;
  let startR = -1;
  let startC = -1;
  let totalFloor = 0;

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      if (!isWall(grid[r][c])) {
        totalFloor++;
        if (startR < 0) { startR = r; startC = c; }
      }
    }
  }
  if (startR < 0) return false;

  const visited = new Set<number>();
  const queue = [startR * w + startC];
  visited.add(startR * w + startC);

  while (queue.length > 0) {
    const pos = queue.shift()!;
    const r = Math.floor(pos / w);
    const c = pos % w;
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr >= h || nc < 0 || nc >= w) continue;
      const key = nr * w + nc;
      if (visited.has(key) || isWall(grid[nr][nc])) continue;
      visited.add(key);
      queue.push(key);
    }
  }

  return visited.size === totalFloor;
}

async function trySolve(
  puzzle: PuzzleDefinition,
  signal?: AbortSignal,
): Promise<SolverResult> {
  const session = createSession(puzzle);
  return classicAStarSolver.solve(
    {
      board: session.board,
      snapshot: session.snapshot,
      objective: { kind: "moves" },
      limits: { maxElapsedMs: 10_000, maxExpandedStates: 1_000_000 },
    },
    {
      signal: signal ?? new AbortController().signal,
      reportProgress: () => {},
      now: () => performance.now(),
    },
  );
}

type Perturbation = "add-wall" | "remove-wall" | "swap-goals" | "move-robot";

function pickRandom<T>(items: readonly T[], rng: () => number): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.floor(rng() * items.length)];
}

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isConstrainedImprovement(
  baseline: SolutionScore,
  candidate: SolutionScore,
  solution: SolverSolution,
): boolean {
  if (candidate.composite <= baseline.composite) return false;
  if (candidate.pushVariety < baseline.pushVariety * 0.8) return false;
  if (candidate.directionChanges < baseline.directionChanges * 0.7) return false;
  const movesPerPush = solution.moves / Math.max(solution.pushes, 1);
  if (movesPerPush > 12) return false;
  return true;
}

export async function refinePuzzle(
  puzzle: PuzzleDefinition,
  baseScore: SolutionScore,
  baseSteps: readonly SolutionStep[],
  maxIterations: number = 20,
  seed: number = 42,
  signal?: AbortSignal,
  budget?: RefinementBudget,
): Promise<RefinementResult> {
  const startMs = performance.now();
  const iterLimit = budget?.maxIterations ?? maxIterations;
  const msLimit = budget?.maxElapsedMs ?? Infinity;
  const callLimit = budget?.maxSolverCalls ?? Infinity;

  const rng = mulberry32(seed);
  let bestPuzzle = puzzle;
  let bestScore = baseScore;
  let bestSteps: readonly SolutionStep[] = baseSteps;
  let improved = false;
  let totalSolverCalls = 0;
  let iter = 0;

  const perturbations: Perturbation[] = ["add-wall", "remove-wall", "swap-goals", "move-robot"];

  for (; iter < iterLimit; iter++) {
    if (signal?.aborted) break;
    if (bestScore.composite >= 0.7) break;
    if (performance.now() - startMs >= msLimit) break;
    if (totalSolverCalls >= callLimit) break;

    const pertType = perturbations[Math.floor(rng() * perturbations.length)];
    const grid = parseGrid(bestPuzzle.rows);
    let mutated = false;

    switch (pertType) {
      case "add-wall": {
        const floors = findFloorBorderCells(grid);
        const target = pickRandom(floors, rng);
        if (target) {
          grid[target.row][target.col] = "O";
          mutated = true;
        }
        break;
      }
      case "remove-wall": {
        const walls = findWallBorderCells(grid);
        const target = pickRandom(walls, rng);
        if (target) {
          grid[target.row][target.col] = " ";
          mutated = true;
        }
        break;
      }
      case "swap-goals": {
        const goals = findGoalCells(grid);
        if (goals.length >= 2) {
          const i = Math.floor(rng() * goals.length);
          let j = Math.floor(rng() * (goals.length - 1));
          if (j >= i) j++;
          const a = goals[i];
          const b = goals[j];
          const tmp = grid[a.row][a.col];
          grid[a.row][a.col] = grid[b.row][b.col];
          grid[b.row][b.col] = tmp;
          mutated = true;
        }
        break;
      }
      case "move-robot": {
        const robot = findRobotCell(grid);
        const floors = findEmptyFloorCells(grid);
        const target = pickRandom(floors, rng);
        if (robot && target) {
          grid[robot.row][robot.col] = " ";
          grid[target.row][target.col] = "R";
          mutated = true;
        }
        break;
      }
    }

    if (!mutated) continue;
    if (!isConnected(grid)) continue;

    const newRows = gridToRows(grid);
    const validation = validatePuzzleRows(newRows);
    if (!validation.valid) continue;

    const candidate: PuzzleDefinition = { ...bestPuzzle, rows: newRows };

    let solveResult: SolverResult;
    try {
      totalSolverCalls++;
      solveResult = await trySolve(candidate, signal);
    } catch {
      continue;
    }
    if (solveResult.status !== "solved") continue;
    if (solveResult.solution.pushes < 3) continue;

    let candidateScore: SolutionScore;
    try {
      candidateScore = scoreSolution(candidate, solveResult.solution);
    } catch {
      continue;
    }

    if (isConstrainedImprovement(bestScore, candidateScore, solveResult.solution)) {
      bestPuzzle = candidate;
      bestScore = candidateScore;
      bestSteps = solveResult.solution.steps;
      improved = true;
    }
  }

  return {
    puzzle: bestPuzzle,
    solutionSteps: bestSteps,
    solutionScore: bestScore,
    iterations: iter,
    solverCalls: totalSolverCalls,
    elapsedMs: performance.now() - startMs,
    improved,
  };
}
