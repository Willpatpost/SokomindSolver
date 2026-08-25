import type { SolutionStep } from "../../../solver/contracts.ts";
import { directionDelta } from "../../../core/position.ts";
import { enumerateReachablePushes } from "./reachable-pushes.ts";

export interface InteractionMetrics {
  readonly sharedRouteCells: number;
  readonly sharedSupportCells: number;
  readonly sharedChokepointUses: number;
  readonly causalEnableCount: number;
  readonly causalDisableCount: number;
}

export function analyzeInteraction(
  grid: readonly (readonly string[])[],
  steps: readonly SolutionStep[],
  structuralChokepoints: ReadonlySet<number>,
  boardWidth: number,
): InteractionMetrics {
  const h = grid.length;
  const w = h > 0 ? grid[0].length : 0;

  let robot = { row: 0, column: 0 };
  const boxes: Array<{ row: number; column: number }> = [];

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const ch = grid[r][c];
      if (ch === "R") robot = { row: r, column: c };
      if (ch === "X" || (ch >= "A" && ch <= "Z" && ch !== "O" && ch !== "R" && ch !== "S")) {
        boxes.push({ row: r, column: c });
      }
    }
  }

  if (boxes.length <= 1) {
    return {
      sharedRouteCells: 0,
      sharedSupportCells: 0,
      sharedChokepointUses: 0,
      causalEnableCount: 0,
      causalDisableCount: 0,
    };
  }

  const routeCellsByBox = new Map<number, Set<string>>();
  const supportCellsByBox = new Map<number, Set<string>>();
  const chokepointUsesByBox = new Map<number, Set<number>>();
  for (let i = 0; i < boxes.length; i++) {
    routeCellsByBox.set(i, new Set());
    supportCellsByBox.set(i, new Set());
    chokepointUsesByBox.set(i, new Set());
  }

  let causalEnableCount = 0;
  let causalDisableCount = 0;

  const flatGrid = grid.map((r) => [...r]);

  for (const step of steps) {
    const delta = directionDelta(step.direction);
    const nr = robot.row + delta.row;
    const nc = robot.column + delta.column;

    if (step.kind === "push") {
      const bi = boxes.findIndex((b) => b.row === nr && b.column === nc);
      if (bi >= 0) {
        const destR = nr + delta.row;
        const destC = nc + delta.column;

        const beforePushes = enumerateReachablePushes(flatGrid, robot, boxes);

        const supportKey = `${robot.row},${robot.column}`;
        supportCellsByBox.get(bi)!.add(supportKey);

        const fromKey = `${nr},${nc}`;
        const toKey = `${destR},${destC}`;
        routeCellsByBox.get(bi)!.add(fromKey);
        routeCellsByBox.get(bi)!.add(toKey);

        const cellIdx = nr * boardWidth + nc;
        if (structuralChokepoints.has(cellIdx)) {
          chokepointUsesByBox.get(bi)!.add(cellIdx);
        }
        const destIdx = destR * boardWidth + destC;
        if (structuralChokepoints.has(destIdx)) {
          chokepointUsesByBox.get(bi)!.add(destIdx);
        }

        boxes[bi] = { row: destR, column: destC };

        const afterPushes = enumerateReachablePushes(flatGrid, { row: nr, column: nc }, boxes);

        const beforeSet = new Set(
          beforePushes
            .filter((p) => p.boxIndex !== bi)
            .map((p) => `${p.boxIndex},${p.direction}`),
        );
        const afterSet = new Set(
          afterPushes
            .filter((p) => p.boxIndex !== bi)
            .map((p) => `${p.boxIndex},${p.direction}`),
        );

        for (const key of afterSet) {
          if (!beforeSet.has(key)) causalEnableCount++;
        }
        for (const key of beforeSet) {
          if (!afterSet.has(key)) causalDisableCount++;
        }
      }
    }

    robot = { row: nr, column: nc };
  }

  let sharedRouteCells = 0;
  const allRouteCells = new Map<string, number>();
  for (const cells of routeCellsByBox.values()) {
    for (const key of cells) {
      allRouteCells.set(key, (allRouteCells.get(key) ?? 0) + 1);
    }
  }
  for (const count of allRouteCells.values()) {
    if (count >= 2) sharedRouteCells++;
  }

  let sharedSupportCells = 0;
  const allSupportCells = new Map<string, number>();
  for (const cells of supportCellsByBox.values()) {
    for (const key of cells) {
      allSupportCells.set(key, (allSupportCells.get(key) ?? 0) + 1);
    }
  }
  for (const count of allSupportCells.values()) {
    if (count >= 2) sharedSupportCells++;
  }

  let sharedChokepointUses = 0;
  const allChokepointUses = new Map<number, number>();
  for (const cells of chokepointUsesByBox.values()) {
    for (const idx of cells) {
      allChokepointUses.set(idx, (allChokepointUses.get(idx) ?? 0) + 1);
    }
  }
  for (const count of allChokepointUses.values()) {
    if (count >= 2) sharedChokepointUses++;
  }

  return {
    sharedRouteCells,
    sharedSupportCells,
    sharedChokepointUses,
    causalEnableCount,
    causalDisableCount,
  };
}
