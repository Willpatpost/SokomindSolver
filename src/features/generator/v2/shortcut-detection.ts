import type { PuzzleDefinition } from "../../../core/model.ts";
import type { SolutionStep } from "../../../solver/contracts.ts";
import { directionDelta } from "../../../core/position.ts";
import { isBoxChar, isRobotChar } from "./tile-semantics.ts";
import type { DistinctRoute } from "./finalist-evaluator.ts";

export interface BoxUsageProfile {
  readonly boxIndex: number;
  readonly pushCount: number;
  readonly netDisplacement: number;
  readonly zonesVisited: number;
}

export interface RouteComparison {
  readonly routeSolverId: string;
  readonly pushFingerprint: string;
  readonly totalPushes: number;
  readonly witnessPushes: number;
  readonly pushReduction: number;
  readonly bypassedBoxes: readonly number[];
  readonly underusedBoxes: readonly number[];
  readonly isShortcut: boolean;
  readonly shortcutSeverity: number;
}

export interface ShortcutAnalysis {
  readonly hasShortcuts: boolean;
  readonly comparisons: readonly RouteComparison[];
  readonly maxSeverity: number;
}

function buildBoxUsage(
  puzzle: PuzzleDefinition,
  steps: readonly SolutionStep[],
): BoxUsageProfile[] {
  const grid = puzzle.rows.map(r => [...r]);
  const h = grid.length;
  const w = h > 0 ? grid[0].length : 0;

  let robot = { row: 0, col: 0 };
  const boxes: Array<{ row: number; col: number; startRow: number; startCol: number }> = [];

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      if (isRobotChar(grid[r][c])) robot = { row: r, col: c };
      if (isBoxChar(grid[r][c])) boxes.push({ row: r, col: c, startRow: r, startCol: c });
    }
  }

  const pushCounts = new Uint16Array(boxes.length);
  const zonesSeen: Set<number>[] = boxes.map(() => new Set());

  for (const step of steps) {
    const delta = directionDelta(step.direction);
    const nr = robot.row + delta.row;
    const nc = robot.col + delta.column;

    if (step.kind === "push") {
      const bi = boxes.findIndex(b => b.row === nr && b.col === nc);
      if (bi >= 0) {
        pushCounts[bi]++;
        const br = nr + delta.row;
        const bc = nc + delta.column;
        boxes[bi].row = br;
        boxes[bi].col = bc;
        zonesSeen[bi].add(Math.floor(br / 3) * 100 + Math.floor(bc / 3));
      }
    }

    robot = { row: nr, col: nc };
  }

  return boxes.map((b, i) => ({
    boxIndex: i,
    pushCount: pushCounts[i],
    netDisplacement: Math.abs(b.row - b.startRow) + Math.abs(b.col - b.startCol),
    zonesVisited: zonesSeen[i].size,
  }));
}

export function detectShortcuts(
  puzzle: PuzzleDefinition,
  witnessSteps: readonly SolutionStep[],
  routes: readonly DistinctRoute[],
): ShortcutAnalysis {
  const witnessUsage = buildBoxUsage(puzzle, witnessSteps);
  const witnessPushes = witnessSteps.filter(s => s.kind === "push").length;
  const participatingBoxes = witnessUsage.filter(b => b.pushCount >= 1);

  const comparisons: RouteComparison[] = [];

  for (const route of routes) {
    const routeUsage = buildBoxUsage(puzzle, route.steps);
    const pushReduction = witnessPushes > 0
      ? 1 - route.pushes / witnessPushes
      : 0;

    const bypassedBoxes: number[] = [];
    const underusedBoxes: number[] = [];

    for (const wb of participatingBoxes) {
      const rb = routeUsage[wb.boxIndex];
      if (!rb || rb.pushCount === 0) {
        bypassedBoxes.push(wb.boxIndex);
      } else if (rb.pushCount < wb.pushCount * 0.5 && wb.pushCount >= 3) {
        underusedBoxes.push(wb.boxIndex);
      }
    }

    let severity = 0;
    if (bypassedBoxes.length > 0) severity += 0.3 * bypassedBoxes.length;
    if (underusedBoxes.length > 0) severity += 0.1 * underusedBoxes.length;
    if (pushReduction > 0.3) severity += pushReduction * 0.4;
    severity = Math.min(severity, 1);

    const isShortcut = severity >= 0.3;

    comparisons.push({
      routeSolverId: route.solverId,
      pushFingerprint: route.pushFingerprint,
      totalPushes: route.pushes,
      witnessPushes,
      pushReduction,
      bypassedBoxes,
      underusedBoxes,
      isShortcut,
      shortcutSeverity: severity,
    });
  }

  const maxSeverity = comparisons.length > 0
    ? Math.max(...comparisons.map(c => c.shortcutSeverity))
    : 0;

  return {
    hasShortcuts: comparisons.some(c => c.isShortcut),
    comparisons,
    maxSeverity,
  };
}
