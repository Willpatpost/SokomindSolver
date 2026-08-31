import type { SolutionStep } from "../../../solver/contracts.ts";
import { directionDelta } from "../../../core/position.ts";
import { enumerateReachablePushes } from "./reachable-pushes.ts";
import {
  isBoxChar,
  isGenericBoxChar,
  isRobotChar,
} from "./tile-semantics.ts";

type BoxKind = "generic" | "typed";

export interface InteractionMetrics {
  readonly sharedRouteCells: number;
  readonly sharedSupportCells: number;
  readonly sharedChokepointUses: number;
  readonly causalEnableCount: number;
  readonly causalDisableCount: number;
  /** Cells used by the routes of at least one generic and one typed box. */
  readonly crossTypeSharedRouteCells: number;
  /** Keeper support cells used while pushing both generic and typed boxes. */
  readonly crossTypeSharedSupportCells: number;
  /** Structural chokepoints traversed by both generic and typed boxes. */
  readonly crossTypeSharedChokepoints: number;
  /** Push options for the opposite box class enabled by moving a box. */
  readonly crossTypeCausalEnableCount: number;
  /** Push options for the opposite box class disabled by moving a box. */
  readonly crossTypeCausalDisableCount: number;
  /** Smallest number of pushes made by any box in the verified solution. */
  readonly minPushesPerBox: number;
  readonly inactiveBoxCount: number;
  readonly onePushBoxCount: number;
}

function emptyMetrics(boxCount: number): InteractionMetrics {
  return {
    sharedRouteCells: 0,
    sharedSupportCells: 0,
    sharedChokepointUses: 0,
    causalEnableCount: 0,
    causalDisableCount: 0,
    crossTypeSharedRouteCells: 0,
    crossTypeSharedSupportCells: 0,
    crossTypeSharedChokepoints: 0,
    crossTypeCausalEnableCount: 0,
    crossTypeCausalDisableCount: 0,
    minPushesPerBox: 0,
    inactiveBoxCount: boxCount,
    onePushBoxCount: 0,
  };
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
  const boxes: Array<{ row: number; column: number; kind: BoxKind }> = [];

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const ch = grid[r][c];
      if (isRobotChar(ch)) robot = { row: r, column: c };
      if (isBoxChar(ch)) {
        boxes.push({
          row: r,
          column: c,
          kind: isGenericBoxChar(ch) ? "generic" : "typed",
        });
      }
    }
  }

  if (boxes.length <= 1) {
    return emptyMetrics(boxes.length);
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
  let crossTypeCausalEnableCount = 0;
  let crossTypeCausalDisableCount = 0;
  const pushesByBox = new Array<number>(boxes.length).fill(0);

  const flatGrid = grid.map((r) => [...r]);

  for (const step of steps) {
    const delta = directionDelta(step.direction);
    const nr = robot.row + delta.row;
    const nc = robot.column + delta.column;

    if (step.kind === "push") {
      const bi = boxes.findIndex((b) => b.row === nr && b.column === nc);
      if (bi >= 0) {
        pushesByBox[bi]++;
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

        boxes[bi] = { ...boxes[bi], row: destR, column: destC };

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
          if (!beforeSet.has(key)) {
            causalEnableCount++;
            const otherBox = Number(key.slice(0, key.indexOf(",")));
            if (boxes[otherBox]?.kind !== boxes[bi].kind) {
              crossTypeCausalEnableCount++;
            }
          }
        }
        for (const key of beforeSet) {
          if (!afterSet.has(key)) {
            causalDisableCount++;
            const otherBox = Number(key.slice(0, key.indexOf(",")));
            if (boxes[otherBox]?.kind !== boxes[bi].kind) {
              crossTypeCausalDisableCount++;
            }
          }
        }
      }
    }

    robot = { row: nr, column: nc };
  }

  let sharedRouteCells = 0;
  const allRouteCells = new Map<string, number>();
  const routeKinds = new Map<string, Set<BoxKind>>();
  for (const [boxIndex, cells] of routeCellsByBox) {
    for (const key of cells) {
      allRouteCells.set(key, (allRouteCells.get(key) ?? 0) + 1);
      const kinds = routeKinds.get(key) ?? new Set<BoxKind>();
      kinds.add(boxes[boxIndex].kind);
      routeKinds.set(key, kinds);
    }
  }
  for (const count of allRouteCells.values()) {
    if (count >= 2) sharedRouteCells++;
  }
  const crossTypeSharedRouteCells = [...routeKinds.values()].filter(
    (kinds) => kinds.size >= 2,
  ).length;

  let sharedSupportCells = 0;
  const allSupportCells = new Map<string, number>();
  const supportKinds = new Map<string, Set<BoxKind>>();
  for (const [boxIndex, cells] of supportCellsByBox) {
    for (const key of cells) {
      allSupportCells.set(key, (allSupportCells.get(key) ?? 0) + 1);
      const kinds = supportKinds.get(key) ?? new Set<BoxKind>();
      kinds.add(boxes[boxIndex].kind);
      supportKinds.set(key, kinds);
    }
  }
  for (const count of allSupportCells.values()) {
    if (count >= 2) sharedSupportCells++;
  }
  const crossTypeSharedSupportCells = [...supportKinds.values()].filter(
    (kinds) => kinds.size >= 2,
  ).length;

  let sharedChokepointUses = 0;
  const allChokepointUses = new Map<number, number>();
  const chokepointKinds = new Map<number, Set<BoxKind>>();
  for (const [boxIndex, cells] of chokepointUsesByBox) {
    for (const idx of cells) {
      allChokepointUses.set(idx, (allChokepointUses.get(idx) ?? 0) + 1);
      const kinds = chokepointKinds.get(idx) ?? new Set<BoxKind>();
      kinds.add(boxes[boxIndex].kind);
      chokepointKinds.set(idx, kinds);
    }
  }
  for (const count of allChokepointUses.values()) {
    if (count >= 2) sharedChokepointUses++;
  }
  const crossTypeSharedChokepoints = [...chokepointKinds.values()].filter(
    (kinds) => kinds.size >= 2,
  ).length;

  const inactiveBoxCount = pushesByBox.filter((pushes) => pushes === 0).length;
  const onePushBoxCount = pushesByBox.filter((pushes) => pushes === 1).length;

  return {
    sharedRouteCells,
    sharedSupportCells,
    sharedChokepointUses,
    causalEnableCount,
    causalDisableCount,
    crossTypeSharedRouteCells,
    crossTypeSharedSupportCells,
    crossTypeSharedChokepoints,
    crossTypeCausalEnableCount,
    crossTypeCausalDisableCount,
    minPushesPerBox: Math.min(...pushesByBox),
    inactiveBoxCount,
    onePushBoxCount,
  };
}
