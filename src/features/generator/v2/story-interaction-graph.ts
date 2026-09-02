import type { CanonicalSolutionTrace } from "./solution-trace.ts";
import type { PassiveStoryProfile } from "./passive-story-analysis.ts";

type BoxPair = readonly [number, number];

function positionKey(position: { readonly row: number; readonly column: number }): string {
  return `${position.row},${position.column}`;
}

function pairKey([left, right]: BoxPair): string {
  return left < right ? `${left},${right}` : `${right},${left}`;
}

function normalizedPair(left: number, right: number): BoxPair | null {
  return left === right ? null : left < right ? [left, right] : [right, left];
}

function distinctPairs(pairs: readonly BoxPair[]): readonly BoxPair[] {
  const seen = new Set<string>();
  return Object.freeze(pairs.filter((pair) => {
    const key = pairKey(pair);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }));
}

/**
 * Relationships that represent actual Sokoban cooperation rather than mere
 * spatial proximity or two consecutive independent pushes.
 */
export function sharedCellPairs(
  trace: CanonicalSolutionTrace,
  role: "route" | "support",
): readonly BoxPair[] {
  const boxesByCell = new Map<string, Set<number>>();
  for (const push of trace.pushes) {
    for (const position of role === "route" ? [push.from, push.to] : [push.keeperSupport]) {
      const key = positionKey(position);
      const ids = boxesByCell.get(key) ?? new Set<number>();
      ids.add(push.boxId);
      boxesByCell.set(key, ids);
    }
  }
  const pairs: BoxPair[] = [];
  for (const ids of boxesByCell.values()) {
    const boxIds = [...ids];
    for (let left = 0; left < boxIds.length; left++) {
      for (let right = left + 1; right < boxIds.length; right++) {
        const pair = normalizedPair(boxIds[left], boxIds[right]);
        if (pair) pairs.push(pair);
      }
    }
  }
  return distinctPairs(pairs);
}

export function strongStoryPairs(
  trace: CanonicalSolutionTrace,
  story: PassiveStoryProfile,
): readonly BoxPair[] {
  // Passive mixed-box evidence intentionally excludes same-class pairs. Read
  // the class-neutral trace here, since construction starts entirely generic.
  const pairs: BoxPair[] = [...sharedCellPairs(trace, "route"), ...sharedCellPairs(trace, "support")];
  for (const push of trace.pushes) {
    for (const otherBoxId of [...push.enabledBoxIds, ...push.disabledBoxIds]) {
      const pair = normalizedPair(push.boxId, otherBoxId);
      if (pair) pairs.push(pair);
    }
  }
  for (const room of story.goalRoomPacking.evidence) {
    if (room.orderedPairs === 0) continue;
    for (const deeper of room.placements) {
      for (const shallower of room.placements) {
        if (deeper.depthFromEntrance <= shallower.depthFromEntrance ||
          deeper.completionPushIndex >= shallower.completionPushIndex) continue;
        const pair = normalizedPair(deeper.boxId, shallower.boxId);
        if (pair) pairs.push(pair);
      }
    }
  }
  for (const gate of story.gateTraffic.evidence) {
    for (const trafficBoxId of gate.trafficBoxIds) {
      const pair = normalizedPair(gate.gateBoxId, trafficBoxId);
      if (pair) pairs.push(pair);
    }
  }
  for (const reversal of story.progressReversals.evidence) {
    for (const benefitingBoxId of reversal.benefitingBoxIds) {
      const pair = normalizedPair(reversal.boxId, benefitingBoxId);
      if (pair) pairs.push(pair);
    }
  }
  return distinctPairs(pairs);
}
