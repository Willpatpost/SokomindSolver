import type { SolutionStep } from "../../../solver/contracts.ts";
import {
  buildCanonicalSolutionTrace,
  type CanonicalSolutionTrace,
  type TraceBoxKind,
} from "./solution-trace.ts";
import { isBoxChar } from "./tile-semantics.ts";

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

function countShared<T>(sets: ReadonlyMap<number, ReadonlySet<T>>): number {
  const uses = new Map<T, number>();
  for (const values of sets.values()) {
    for (const value of values) uses.set(value, (uses.get(value) ?? 0) + 1);
  }
  return [...uses.values()].filter((count) => count >= 2).length;
}

function countCrossTypeShared<T>(
  sets: ReadonlyMap<number, ReadonlySet<T>>,
  kindByBox: ReadonlyMap<number, TraceBoxKind>,
): number {
  const kindsByValue = new Map<T, Set<TraceBoxKind>>();
  for (const [boxId, values] of sets) {
    const kind = kindByBox.get(boxId);
    if (!kind) continue;
    for (const value of values) {
      const kinds = kindsByValue.get(value) ?? new Set<TraceBoxKind>();
      kinds.add(kind);
      kindsByValue.set(value, kinds);
    }
  }
  return [...kindsByValue.values()].filter((kinds) => kinds.size >= 2).length;
}

export function analyzeInteractionFromTrace(
  trace: CanonicalSolutionTrace,
  structuralChokepoints: ReadonlySet<number>,
  boardWidth: number = trace.boardWidth,
): InteractionMetrics {
  if (trace.boxes.length === 0) return emptyMetrics(0);

  const routeCellsByBox = new Map<number, Set<string>>();
  const supportCellsByBox = new Map<number, Set<string>>();
  const chokepointUsesByBox = new Map<number, Set<number>>();
  const kindByBox = new Map<number, TraceBoxKind>();
  for (const box of trace.boxes) {
    routeCellsByBox.set(box.id, new Set());
    supportCellsByBox.set(box.id, new Set());
    chokepointUsesByBox.set(box.id, new Set());
    kindByBox.set(box.id, box.kind);
  }

  let causalEnableCount = 0;
  let causalDisableCount = 0;
  let crossTypeCausalEnableCount = 0;
  let crossTypeCausalDisableCount = 0;

  for (const push of trace.pushes) {
    supportCellsByBox.get(push.boxId)!.add(
      `${push.keeperSupport.row},${push.keeperSupport.column}`,
    );
    routeCellsByBox.get(push.boxId)!.add(`${push.from.row},${push.from.column}`);
    routeCellsByBox.get(push.boxId)!.add(`${push.to.row},${push.to.column}`);

    for (const position of [push.from, push.to]) {
      const index = position.row * boardWidth + position.column;
      if (structuralChokepoints.has(index)) {
        chokepointUsesByBox.get(push.boxId)!.add(index);
      }
    }

    causalEnableCount += push.enabledPushes.length;
    causalDisableCount += push.disabledPushes.length;
    for (const option of push.enabledPushes) {
      if (kindByBox.get(option.boxId) !== push.boxKind) crossTypeCausalEnableCount++;
    }
    for (const option of push.disabledPushes) {
      if (kindByBox.get(option.boxId) !== push.boxKind) crossTypeCausalDisableCount++;
    }
  }

  const pushesByBox = trace.boxes.map((box) => box.pushCount);
  return {
    sharedRouteCells: countShared(routeCellsByBox),
    sharedSupportCells: countShared(supportCellsByBox),
    sharedChokepointUses: countShared(chokepointUsesByBox),
    causalEnableCount,
    causalDisableCount,
    crossTypeSharedRouteCells: countCrossTypeShared(routeCellsByBox, kindByBox),
    crossTypeSharedSupportCells: countCrossTypeShared(supportCellsByBox, kindByBox),
    crossTypeSharedChokepoints: countCrossTypeShared(chokepointUsesByBox, kindByBox),
    crossTypeCausalEnableCount,
    crossTypeCausalDisableCount,
    minPushesPerBox: Math.min(...pushesByBox),
    inactiveBoxCount: pushesByBox.filter((pushes) => pushes === 0).length,
    onePushBoxCount: pushesByBox.filter((pushes) => pushes === 1).length,
  };
}

export function analyzeInteraction(
  grid: readonly (readonly string[])[],
  steps: readonly SolutionStep[],
  structuralChokepoints: ReadonlySet<number>,
  boardWidth: number,
): InteractionMetrics {
  const result = buildCanonicalSolutionTrace(grid, steps);
  if (!result.ok) {
    const boxCount = grid.reduce(
      (count, row) => count + row.filter(isBoxChar).length,
      0,
    );
    return emptyMetrics(boxCount);
  }
  return analyzeInteractionFromTrace(result.trace, structuralChokepoints, boardWidth);
}
