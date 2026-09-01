import { boardHash } from "./puzzle-identity.ts";
import type {
  CanonicalSolutionTrace,
  TraceBox,
  TraceGoal,
  TracePosition,
  TracePushEvent,
} from "./solution-trace.ts";
import { isWallChar } from "./tile-semantics.ts";

export interface GenericGoalMisdirectionEvidence {
  readonly boxId: number;
  readonly actualGoalId: string;
  readonly nearestGoalIds: readonly string[];
  readonly initialDistanceToActual: number;
  readonly initialDistanceToNearest: number;
  readonly excessDistance: number;
  readonly actualGoalRank: number;
}

export interface GenericGoalMisdirectionAnalysis {
  readonly eligibleBoxCount: number;
  readonly misdirectedBoxCount: number;
  readonly totalExcessDistance: number;
  readonly evidence: readonly GenericGoalMisdirectionEvidence[];
}

export interface ProgressReversalEvidence {
  readonly boxId: number;
  readonly finalGoalId: string;
  readonly reversalPushIndex: number;
  readonly recoveryPushIndex: number;
  readonly distanceBefore: number;
  readonly distanceAfter: number;
  readonly benefitingBoxIds: readonly number[];
}

export interface ProgressReversalAnalysis {
  readonly reversalCount: number;
  readonly reversedBoxCount: number;
  readonly evidence: readonly ProgressReversalEvidence[];
}

export interface ZoneTransitionEvidence {
  readonly pushIndex: number;
  readonly fromZoneId: string;
  readonly toZoneId: string;
}

export interface MultiRoomJourneyEvidence {
  readonly boxId: number;
  readonly roomIds: readonly string[];
  readonly zoneSequence: readonly string[];
  readonly transitions: readonly ZoneTransitionEvidence[];
}

export interface MultiRoomJourneyAnalysis {
  readonly journeyBoxCount: number;
  readonly maxRoomsVisited: number;
  readonly evidence: readonly MultiRoomJourneyEvidence[];
}

export interface GoalPackingPlacement {
  readonly goalId: string;
  readonly boxId: number;
  readonly depthFromEntrance: number;
  readonly completionPushIndex: number;
}

export interface GoalRoomPackingEvidence {
  readonly roomId: string;
  readonly placements: readonly GoalPackingPlacement[];
  readonly orderedPairs: number;
  readonly violatedPairs: number;
  readonly orderRatio: number;
}

export interface GoalRoomPackingAnalysis {
  readonly eligibleRoomCount: number;
  readonly orderedRoomCount: number;
  readonly orderedPairs: number;
  readonly violatedPairs: number;
  readonly evidence: readonly GoalRoomPackingEvidence[];
}

export interface GateTrafficEvidence {
  readonly doorwayZoneId: string;
  readonly gateBoxId: number;
  readonly openingPushIndex: number;
  readonly trafficPushIndices: readonly number[];
  readonly trafficBoxIds: readonly number[];
  readonly returnPushIndex?: number;
  readonly reopeningPushIndex?: number;
}

export interface GateTrafficAnalysis {
  readonly gateStoryCount: number;
  readonly reopenedGateCount: number;
  readonly trafficBoxCount: number;
  readonly evidence: readonly GateTrafficEvidence[];
}

export interface CrossTypeDependencyEvidence {
  readonly sourceBoxId: number;
  readonly targetBoxId: number;
  readonly pushIndex: number;
  readonly effect: "enabled" | "disabled";
}

export interface CrossTypeSwitchEvidence {
  readonly pushIndex: number;
  readonly fromBoxId: number;
  readonly toBoxId: number;
}

export interface CrossTypeSharedCellEvidence {
  readonly row: number;
  readonly column: number;
  readonly role: "route" | "support";
  readonly boxIds: readonly number[];
}

export interface MixedBoxInteractionAnalysis {
  readonly boxSwitchCount: number;
  readonly crossTypeSwitchCount: number;
  readonly crossTypeDependencyCount: number;
  readonly crossTypeSharedRouteCells: number;
  readonly crossTypeSharedSupportCells: number;
  readonly switchEvidence: readonly CrossTypeSwitchEvidence[];
  readonly dependencyEvidence: readonly CrossTypeDependencyEvidence[];
  readonly sharedCellEvidence: readonly CrossTypeSharedCellEvidence[];
}

export type PassiveStoryPhaseKind =
  | "transport"
  | "staging"
  | "goal-placement"
  | "goal-rework";

export interface PassiveStoryPhase {
  readonly id: string;
  readonly kind: PassiveStoryPhaseKind;
  readonly startPushIndex: number;
  readonly endPushIndex: number;
  readonly startStepIndex: number;
  readonly endStepIndex: number;
  readonly boxIds: readonly number[];
  readonly zoneIds: readonly string[];
  readonly completedGoalId?: string;
  readonly revisitsBox: boolean;
}

export interface SolutionPhaseAnalysis {
  readonly phaseCount: number;
  readonly boxRevisitPhaseCount: number;
  readonly phases: readonly PassiveStoryPhase[];
}

export interface StructuralStoryIdentity {
  readonly roomCount: number;
  readonly corridorCount: number;
  readonly doorwayCount: number;
  readonly usedZoneCount: number;
  readonly crossZonePushCount: number;
  readonly traversalSignature: string;
}

export interface PassiveStoryProfile {
  readonly puzzleId: string;
  readonly boardHash: string;
  readonly solved: boolean;
  readonly genericGoalMisdirection: GenericGoalMisdirectionAnalysis;
  readonly progressReversals: ProgressReversalAnalysis;
  readonly multiRoomJourneys: MultiRoomJourneyAnalysis;
  readonly goalRoomPacking: GoalRoomPackingAnalysis;
  readonly gateTraffic: GateTrafficAnalysis;
  readonly mixedBoxInteraction: MixedBoxInteractionAnalysis;
  readonly solutionPhases: SolutionPhaseAnalysis;
  readonly structuralIdentity: StructuralStoryIdentity;
}

/** Compact, JSON-friendly story measurements for diagnostics and review packs. */
export interface PassiveStorySummary {
  readonly assignmentMisdirections: number;
  readonly reversalEpisodes: number;
  readonly multiRoomJourneys: number;
  readonly orderedPackingPairs: number;
  readonly gateTransitions: number;
  readonly gateReopenings: number;
  readonly crossTypeDependencies: number;
  readonly crossTypeSwitches: number;
  readonly solutionPhases: number;
  readonly revisitedPhases: number;
  readonly usedZones: number;
  readonly crossZonePushes: number;
  readonly traversalSignature: string;
}

export function summarizePassiveStory(profile: PassiveStoryProfile): PassiveStorySummary {
  return Object.freeze({
    assignmentMisdirections: profile.genericGoalMisdirection.misdirectedBoxCount,
    reversalEpisodes: profile.progressReversals.reversalCount,
    multiRoomJourneys: profile.multiRoomJourneys.journeyBoxCount,
    orderedPackingPairs: profile.goalRoomPacking.orderedPairs,
    gateTransitions: profile.gateTraffic.gateStoryCount,
    gateReopenings: profile.gateTraffic.reopenedGateCount,
    crossTypeDependencies: profile.mixedBoxInteraction.crossTypeDependencyCount,
    crossTypeSwitches: profile.mixedBoxInteraction.crossTypeSwitchCount,
    solutionPhases: profile.solutionPhases.phaseCount,
    revisitedPhases: profile.solutionPhases.boxRevisitPhaseCount,
    usedZones: profile.structuralIdentity.usedZoneCount,
    crossZonePushes: profile.structuralIdentity.crossZonePushCount,
    traversalSignature: profile.structuralIdentity.traversalSignature,
  });
}

/** Short evidence-led explanations intended for human catalog review. */
export function explainPassiveStory(profile: PassiveStoryProfile): readonly string[] {
  const s = summarizePassiveStory(profile);
  const explanations: string[] = [];
  if (s.assignmentMisdirections > 0) {
    explanations.push(`${s.assignmentMisdirections} generic box assignment${s.assignmentMisdirections === 1 ? "" : "s"} bypass the nearest compatible goal.`);
  }
  if (s.reversalEpisodes > 0) explanations.push(`${s.reversalEpisodes} productive reversal episode${s.reversalEpisodes === 1 ? "" : "s"} temporarily move a box away from its final goal.`);
  if (s.multiRoomJourneys > 0) explanations.push(`${s.multiRoomJourneys} box journey${s.multiRoomJourneys === 1 ? "" : "s"} cross multiple rooms.`);
  if (s.orderedPackingPairs > 0) explanations.push(`${s.orderedPackingPairs} deep-before-shallow packing relation${s.orderedPackingPairs === 1 ? "" : "s"} appear in the solution.`);
  if (s.gateTransitions > 0) explanations.push(`${s.gateTransitions} gate traffic sequence${s.gateTransitions === 1 ? "" : "s"}${s.gateReopenings > 0 ? `, including ${s.gateReopenings} reopening${s.gateReopenings === 1 ? "" : "s"}` : ""}.`);
  if (s.crossTypeDependencies > 0 || s.crossTypeSwitches > 0) explanations.push(`Typed and generic boxes interact through ${s.crossTypeDependencies} causal dependencies and ${s.crossTypeSwitches} consecutive-work switches.`);
  if (s.revisitedPhases > 0) explanations.push(`${s.revisitedPhases} solution phase${s.revisitedPhases === 1 ? "" : "s"} return to an earlier box.`);
  if (explanations.length === 0) explanations.push("The canonical solution contains no measured story mechanism beyond direct transport and placement.");
  return Object.freeze(explanations);
}

type Grid = readonly (readonly string[])[];

function cellKey(position: TracePosition): string {
  return `${position.row},${position.column}`;
}

function parseCellKey(key: string): TracePosition {
  const separator = key.indexOf(",");
  return {
    row: Number(key.slice(0, separator)),
    column: Number(key.slice(separator + 1)),
  };
}

function neighbors(
  position: TracePosition,
  width: number,
  height: number,
): readonly TracePosition[] {
  const result: TracePosition[] = [];
  if (position.row > 0) result.push({ row: position.row - 1, column: position.column });
  if (position.row + 1 < height) result.push({ row: position.row + 1, column: position.column });
  if (position.column > 0) result.push({ row: position.row, column: position.column - 1 });
  if (position.column + 1 < width) result.push({ row: position.row, column: position.column + 1 });
  return result;
}

function staticDistances(grid: Grid, start: TracePosition): ReadonlyMap<string, number> {
  const height = grid.length;
  const width = grid[0]?.length ?? 0;
  const distances = new Map<string, number>();
  const queue: TracePosition[] = [start];
  distances.set(cellKey(start), 0);

  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor];
    const distance = distances.get(cellKey(current))!;
    for (const next of neighbors(current, width, height)) {
      const key = cellKey(next);
      if (distances.has(key) || isWallChar(grid[next.row][next.column])) continue;
      distances.set(key, distance + 1);
      queue.push(next);
    }
  }
  return distances;
}

function uniqueInOrder<T>(values: readonly T[]): readonly T[] {
  const seen = new Set<T>();
  const result: T[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return Object.freeze(result);
}

function collapseConsecutive<T>(values: readonly T[]): readonly T[] {
  const result: T[] = [];
  for (const value of values) {
    if (result.length === 0 || result[result.length - 1] !== value) result.push(value);
  }
  return Object.freeze(result);
}

function uniqueSorted(values: readonly number[]): readonly number[] {
  return Object.freeze([...new Set(values)].sort((left, right) => left - right));
}

function verifyTraceBoard(grid: Grid, trace: CanonicalSolutionTrace): void {
  const width = grid[0]?.length ?? 0;
  if (
    grid.length !== trace.boardHeight ||
    width !== trace.boardWidth ||
    grid.some((row) => row.length !== width)
  ) {
    throw new Error("Passive story analysis requires the exact rectangular trace board");
  }
  const hash = boardHash(grid.map((row) => row.join("")));
  if (hash !== trace.boardHash) {
    throw new Error("Passive story analysis board hash does not match the canonical trace");
  }
}

function distanceCache(grid: Grid, goals: readonly TraceGoal[]) {
  const cache = new Map<string, ReadonlyMap<string, number>>();
  for (const goal of goals) cache.set(goal.id, staticDistances(grid, goal.position));
  return cache;
}

function distanceToGoal(
  cache: ReadonlyMap<string, ReadonlyMap<string, number>>,
  goalId: string,
  position: TracePosition,
): number {
  return cache.get(goalId)?.get(cellKey(position)) ?? Infinity;
}

function analyzeGenericGoalMisdirection(
  trace: CanonicalSolutionTrace,
  distances: ReadonlyMap<string, ReadonlyMap<string, number>>,
): GenericGoalMisdirectionAnalysis {
  const genericGoals = trace.goals.filter((goal) => goal.kind === "generic");
  const eligible = trace.boxes.filter((box) =>
    box.kind === "generic" && box.finalGoalId !== undefined && genericGoals.length >= 2);
  const evidence: GenericGoalMisdirectionEvidence[] = [];

  for (const box of eligible) {
    const ranked = genericGoals.map((goal) => ({
      goal,
      distance: distanceToGoal(distances, goal.id, box.initialPosition),
    })).sort((left, right) =>
      left.distance - right.distance || left.goal.id.localeCompare(right.goal.id));
    const actualIndex = ranked.findIndex(({ goal }) => goal.id === box.finalGoalId);
    if (actualIndex < 0 || !Number.isFinite(ranked[actualIndex].distance)) continue;
    const nearestDistance = ranked[0].distance;
    const actualDistance = ranked[actualIndex].distance;
    if (actualDistance <= nearestDistance) continue;
    evidence.push(Object.freeze({
      boxId: box.id,
      actualGoalId: box.finalGoalId!,
      nearestGoalIds: Object.freeze(ranked
        .filter(({ distance }) => distance === nearestDistance)
        .map(({ goal }) => goal.id)),
      initialDistanceToActual: actualDistance,
      initialDistanceToNearest: nearestDistance,
      excessDistance: actualDistance - nearestDistance,
      actualGoalRank: actualIndex + 1,
    }));
  }

  return Object.freeze({
    eligibleBoxCount: eligible.length,
    misdirectedBoxCount: evidence.length,
    totalExcessDistance: evidence.reduce((sum, item) => sum + item.excessDistance, 0),
    evidence: Object.freeze(evidence),
  });
}

function boxBenefitsBetween(
  trace: CanonicalSolutionTrace,
  distances: ReadonlyMap<string, ReadonlyMap<string, number>>,
  reversal: TracePushEvent,
  recoveryPushIndex: number,
): readonly number[] {
  const boxById = new Map(trace.boxes.map((box) => [box.id, box] as const));
  const intervening = trace.pushes.filter((push) =>
    push.pushIndex > reversal.pushIndex &&
    push.pushIndex <= recoveryPushIndex &&
    push.boxId !== reversal.boxId);
  const pushedBetween = new Set(intervening.map((push) => push.boxId));
  const benefited = new Set<number>(reversal.enabledBoxIds.filter((id) => pushedBetween.has(id)));
  for (const push of intervening) {
    const box = boxById.get(push.boxId);
    if (!box?.finalGoalId) continue;
    const before = distanceToGoal(distances, box.finalGoalId, push.from);
    const after = distanceToGoal(distances, box.finalGoalId, push.to);
    if (after < before || push.toGoalMatched) benefited.add(push.boxId);
  }
  return uniqueSorted([...benefited]);
}

function analyzeProgressReversals(
  trace: CanonicalSolutionTrace,
  distances: ReadonlyMap<string, ReadonlyMap<string, number>>,
): ProgressReversalAnalysis {
  const evidence: ProgressReversalEvidence[] = [];
  const pushesByBox = new Map<number, TracePushEvent[]>();
  for (const push of trace.pushes) {
    const pushes = pushesByBox.get(push.boxId) ?? [];
    pushes.push(push);
    pushesByBox.set(push.boxId, pushes);
  }

  for (const box of trace.boxes) {
    if (!box.finalGoalId) continue;
    const pushes = pushesByBox.get(box.id) ?? [];
    let coveredThrough = -1;
    for (let index = 0; index < pushes.length; index++) {
      const reversal = pushes[index];
      if (reversal.pushIndex <= coveredThrough) continue;
      const before = distanceToGoal(distances, box.finalGoalId, reversal.from);
      const after = distanceToGoal(distances, box.finalGoalId, reversal.to);
      if (!Number.isFinite(before) || after <= before) continue;
      const recovery = pushes.slice(index + 1).find((candidate) =>
        distanceToGoal(distances, box.finalGoalId!, candidate.to) <= before);
      if (!recovery) continue;
      const benefitingBoxIds = boxBenefitsBetween(trace, distances, reversal, recovery.pushIndex);
      if (benefitingBoxIds.length === 0) continue;
      evidence.push(Object.freeze({
        boxId: box.id,
        finalGoalId: box.finalGoalId,
        reversalPushIndex: reversal.pushIndex,
        recoveryPushIndex: recovery.pushIndex,
        distanceBefore: before,
        distanceAfter: after,
        benefitingBoxIds,
      }));
      coveredThrough = recovery.pushIndex;
    }
  }

  return Object.freeze({
    reversalCount: evidence.length,
    reversedBoxCount: new Set(evidence.map((item) => item.boxId)).size,
    evidence: Object.freeze(evidence),
  });
}

function analyzeMultiRoomJourneys(
  trace: CanonicalSolutionTrace,
  zoneKind: ReadonlyMap<string, string>,
): MultiRoomJourneyAnalysis {
  const evidence: MultiRoomJourneyEvidence[] = [];
  for (const box of trace.boxes) {
    const pushes = trace.pushes.filter((push) => push.boxId === box.id);
    const zoneSequence = collapseConsecutive([
      box.initialZoneId,
      ...pushes.map((push) => push.toZoneId),
    ]);
    const roomIds = uniqueInOrder(zoneSequence.filter((zoneId) => zoneKind.get(zoneId) === "room"));
    if (roomIds.length < 2) continue;
    evidence.push(Object.freeze({
      boxId: box.id,
      roomIds,
      zoneSequence,
      transitions: Object.freeze(pushes
        .filter((push) => push.fromZoneId !== push.toZoneId)
        .map((push) => Object.freeze({
          pushIndex: push.pushIndex,
          fromZoneId: push.fromZoneId,
          toZoneId: push.toZoneId,
        }))),
    }));
  }
  return Object.freeze({
    journeyBoxCount: evidence.length,
    maxRoomsVisited: Math.max(0, ...evidence.map((item) => item.roomIds.length)),
    evidence: Object.freeze(evidence),
  });
}

function roomDepths(
  grid: Grid,
  roomId: string,
  roomCells: ReadonlySet<string>,
  zoneByCell: ReadonlyMap<string, string>,
): ReadonlyMap<string, number> {
  const width = grid[0]?.length ?? 0;
  const height = grid.length;
  const entrances = [...roomCells].filter((key) =>
    neighbors(parseCellKey(key), width, height).some((next) => {
      const nextKey = cellKey(next);
      return !isWallChar(grid[next.row][next.column]) && zoneByCell.get(nextKey) !== roomId;
    }));
  const depths = new Map<string, number>();
  const queue = entrances.map(parseCellKey);
  for (const entrance of queue) depths.set(cellKey(entrance), 0);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor];
    const depth = depths.get(cellKey(current))!;
    for (const next of neighbors(current, width, height)) {
      const key = cellKey(next);
      if (!roomCells.has(key) || depths.has(key)) continue;
      depths.set(key, depth + 1);
      queue.push(next);
    }
  }
  return depths;
}

function finalCompletionPush(trace: CanonicalSolutionTrace, box: TraceBox): TracePushEvent | undefined {
  if (!box.finalGoalId) return undefined;
  return [...trace.pushes].reverse().find((push) =>
    push.boxId === box.id && push.toGoalId === box.finalGoalId);
}

function analyzeGoalRoomPacking(
  grid: Grid,
  trace: CanonicalSolutionTrace,
  zoneByCell: ReadonlyMap<string, string>,
): GoalRoomPackingAnalysis {
  const evidence: GoalRoomPackingEvidence[] = [];
  const boxByGoal = new Map<string, TraceBox>();
  for (const box of trace.boxes) if (box.finalGoalId) boxByGoal.set(box.finalGoalId, box);

  for (const zone of trace.semanticZones.zones) {
    if (zone.kind !== "room") continue;
    const goals = trace.goals.filter((goal) => goal.zoneId === zone.id && boxByGoal.has(goal.id));
    if (goals.length < 2) continue;
    const cells = new Set(zone.cells.map(cellKey));
    const depths = roomDepths(grid, zone.id, cells, zoneByCell);
    const placements: GoalPackingPlacement[] = [];
    for (const goal of goals) {
      const box = boxByGoal.get(goal.id)!;
      const completion = finalCompletionPush(trace, box);
      const depth = depths.get(cellKey(goal.position));
      if (!completion || depth === undefined) continue;
      placements.push(Object.freeze({
        goalId: goal.id,
        boxId: box.id,
        depthFromEntrance: depth,
        completionPushIndex: completion.pushIndex,
      }));
    }
    if (placements.length < 2) continue;
    let orderedPairs = 0;
    let violatedPairs = 0;
    for (let left = 0; left < placements.length; left++) {
      for (let right = left + 1; right < placements.length; right++) {
        const a = placements[left];
        const b = placements[right];
        if (a.depthFromEntrance === b.depthFromEntrance) continue;
        const deeper = a.depthFromEntrance > b.depthFromEntrance ? a : b;
        const shallower = deeper === a ? b : a;
        if (deeper.completionPushIndex < shallower.completionPushIndex) orderedPairs++;
        else violatedPairs++;
      }
    }
    const comparable = orderedPairs + violatedPairs;
    if (comparable === 0) continue;
    evidence.push(Object.freeze({
      roomId: zone.id,
      placements: Object.freeze(placements.sort((a, b) =>
        a.completionPushIndex - b.completionPushIndex)),
      orderedPairs,
      violatedPairs,
      orderRatio: orderedPairs / comparable,
    }));
  }

  return Object.freeze({
    eligibleRoomCount: evidence.length,
    orderedRoomCount: evidence.filter((item) =>
      item.orderedPairs > 0 && item.violatedPairs === 0).length,
    orderedPairs: evidence.reduce((sum, item) => sum + item.orderedPairs, 0),
    violatedPairs: evidence.reduce((sum, item) => sum + item.violatedPairs, 0),
    evidence: Object.freeze(evidence),
  });
}

function analyzeGateTraffic(
  trace: CanonicalSolutionTrace,
  zoneKind: ReadonlyMap<string, string>,
): GateTrafficAnalysis {
  const evidence: GateTrafficEvidence[] = [];
  const doorwayIds = new Set([...zoneKind]
    .filter(([, kind]) => kind === "doorway")
    .map(([id]) => id));

  for (const opening of trace.pushes) {
    if (!doorwayIds.has(opening.fromZoneId) || opening.toZoneId === opening.fromZoneId) continue;
    const doorwayZoneId = opening.fromZoneId;
    const returnPush = trace.pushes.find((push) =>
      push.pushIndex > opening.pushIndex &&
      push.boxId === opening.boxId &&
      push.toZoneId === doorwayZoneId);
    const traffic = trace.pushes.filter((push) =>
      push.pushIndex > opening.pushIndex &&
      push.pushIndex < (returnPush?.pushIndex ?? Infinity) &&
      push.boxId !== opening.boxId &&
      (push.fromZoneId === doorwayZoneId || push.toZoneId === doorwayZoneId));
    if (traffic.length === 0) continue;
    const reopeningPush = returnPush
      ? trace.pushes.find((push) =>
        push.pushIndex > returnPush.pushIndex &&
        push.boxId === opening.boxId &&
        push.fromZoneId === doorwayZoneId &&
        push.toZoneId !== doorwayZoneId)
      : undefined;
    evidence.push(Object.freeze({
      doorwayZoneId,
      gateBoxId: opening.boxId,
      openingPushIndex: opening.pushIndex,
      trafficPushIndices: Object.freeze(traffic.map((push) => push.pushIndex)),
      trafficBoxIds: uniqueSorted(traffic.map((push) => push.boxId)),
      returnPushIndex: returnPush?.pushIndex,
      reopeningPushIndex: reopeningPush?.pushIndex,
    }));
  }

  return Object.freeze({
    gateStoryCount: evidence.length,
    reopenedGateCount: evidence.filter((item) => item.reopeningPushIndex !== undefined).length,
    trafficBoxCount: new Set(evidence.flatMap((item) => item.trafficBoxIds)).size,
    evidence: Object.freeze(evidence),
  });
}

function collectSharedCells(
  trace: CanonicalSolutionTrace,
  role: "route" | "support",
): readonly CrossTypeSharedCellEvidence[] {
  const boxesByCell = new Map<string, Set<number>>();
  for (const push of trace.pushes) {
    const positions = role === "route" ? [push.from, push.to] : [push.keeperSupport];
    for (const position of positions) {
      const key = cellKey(position);
      const ids = boxesByCell.get(key) ?? new Set<number>();
      ids.add(push.boxId);
      boxesByCell.set(key, ids);
    }
  }
  const kindByBox = new Map(trace.boxes.map((box) => [box.id, box.kind] as const));
  const evidence: CrossTypeSharedCellEvidence[] = [];
  for (const [key, ids] of boxesByCell) {
    if (new Set([...ids].map((id) => kindByBox.get(id))).size < 2) continue;
    const position = parseCellKey(key);
    evidence.push(Object.freeze({
      ...position,
      role,
      boxIds: uniqueSorted([...ids]),
    }));
  }
  return Object.freeze(evidence.sort((a, b) => a.row - b.row || a.column - b.column));
}

function analyzeMixedBoxInteraction(trace: CanonicalSolutionTrace): MixedBoxInteractionAnalysis {
  const kindByBox = new Map(trace.boxes.map((box) => [box.id, box.kind] as const));
  let boxSwitchCount = 0;
  let crossTypeSwitchCount = 0;
  const switchEvidence: CrossTypeSwitchEvidence[] = [];
  for (let index = 1; index < trace.pushes.length; index++) {
    const before = trace.pushes[index - 1];
    const after = trace.pushes[index];
    if (before.boxId === after.boxId) continue;
    boxSwitchCount++;
    if (before.boxKind !== after.boxKind) {
      crossTypeSwitchCount++;
      switchEvidence.push(Object.freeze({
        pushIndex: after.pushIndex,
        fromBoxId: before.boxId,
        toBoxId: after.boxId,
      }));
    }
  }

  const dependencies: CrossTypeDependencyEvidence[] = [];
  for (const push of trace.pushes) {
    for (const [effect, boxIds] of [
      ["enabled", push.enabledBoxIds],
      ["disabled", push.disabledBoxIds],
    ] as const) {
      for (const targetBoxId of boxIds) {
        if (kindByBox.get(targetBoxId) === push.boxKind) continue;
        dependencies.push(Object.freeze({
          sourceBoxId: push.boxId,
          targetBoxId,
          pushIndex: push.pushIndex,
          effect,
        }));
      }
    }
  }
  const route = collectSharedCells(trace, "route");
  const support = collectSharedCells(trace, "support");
  return Object.freeze({
    boxSwitchCount,
    crossTypeSwitchCount,
    crossTypeDependencyCount: dependencies.length,
    crossTypeSharedRouteCells: route.length,
    crossTypeSharedSupportCells: support.length,
    switchEvidence: Object.freeze(switchEvidence),
    dependencyEvidence: Object.freeze(dependencies),
    sharedCellEvidence: Object.freeze([...route, ...support]),
  });
}

function classifyPhase(pushes: readonly TracePushEvent[], finalBox: TraceBox): PassiveStoryPhaseKind {
  if (pushes.some((push) => push.fromGoalMatched)) return "goal-rework";
  const last = pushes[pushes.length - 1];
  if (last.toGoalMatched && last.toGoalId === finalBox.finalGoalId) return "goal-placement";
  if (new Set(pushes.flatMap((push) => [push.fromZoneId, push.toZoneId])).size > 1) {
    return "transport";
  }
  return "staging";
}

function analyzeSolutionPhases(trace: CanonicalSolutionTrace): SolutionPhaseAnalysis {
  const groups: TracePushEvent[][] = [];
  for (const push of trace.pushes) {
    const current = groups[groups.length - 1];
    if (!current || current[0].boxId !== push.boxId) groups.push([push]);
    else current.push(push);
  }
  const boxById = new Map(trace.boxes.map((box) => [box.id, box] as const));
  const seenBoxes = new Set<number>();
  let boxRevisitPhaseCount = 0;
  const phases = groups.map((pushes, index): PassiveStoryPhase => {
    const box = boxById.get(pushes[0].boxId)!;
    const revisitsBox = seenBoxes.has(box.id);
    if (revisitsBox) boxRevisitPhaseCount++;
    seenBoxes.add(box.id);
    const last = pushes[pushes.length - 1];
    return Object.freeze({
      id: `phase-${index}`,
      kind: classifyPhase(pushes, box),
      startPushIndex: pushes[0].pushIndex,
      endPushIndex: last.pushIndex,
      startStepIndex: pushes[0].stepIndex,
      endStepIndex: last.stepIndex,
      boxIds: Object.freeze([box.id]),
      zoneIds: uniqueInOrder(pushes.flatMap((push) => [push.fromZoneId, push.toZoneId])),
      completedGoalId: last.toGoalMatched && last.toGoalId === box.finalGoalId
        ? last.toGoalId
        : undefined,
      revisitsBox,
    });
  });
  return Object.freeze({
    phaseCount: phases.length,
    boxRevisitPhaseCount,
    phases: Object.freeze(phases),
  });
}

function analyzeStructuralIdentity(trace: CanonicalSolutionTrace): StructuralStoryIdentity {
  const zoneCounts = { room: 0, corridor: 0, doorway: 0 };
  for (const zone of trace.semanticZones.zones) zoneCounts[zone.kind]++;
  const usedZones = new Set<string>();
  const transitions: string[] = [];
  for (const push of trace.pushes) {
    usedZones.add(push.fromZoneId);
    usedZones.add(push.toZoneId);
    if (push.fromZoneId !== push.toZoneId) {
      transitions.push(`${push.fromZoneId}>${push.toZoneId}`);
    }
  }
  return Object.freeze({
    roomCount: zoneCounts.room,
    corridorCount: zoneCounts.corridor,
    doorwayCount: zoneCounts.doorway,
    usedZoneCount: usedZones.size,
    crossZonePushCount: transitions.length,
    traversalSignature: uniqueInOrder(transitions).join("|"),
  });
}

/**
 * Extract evidence that is observable from one replay-valid solution. This
 * function deliberately performs no counterfactual search and assigns no
 * aggregate quality or difficulty score.
 */
export function analyzePassiveSolutionStory(
  grid: Grid,
  trace: CanonicalSolutionTrace,
): PassiveStoryProfile {
  verifyTraceBoard(grid, trace);
  const zoneByCell = new Map<string, string>();
  const zoneKind = new Map<string, string>();
  for (const zone of trace.semanticZones.zones) {
    zoneKind.set(zone.id, zone.kind);
    for (const cell of zone.cells) zoneByCell.set(cellKey(cell), zone.id);
  }
  const distances = distanceCache(grid, trace.goals);

  return Object.freeze({
    puzzleId: trace.puzzleId,
    boardHash: trace.boardHash,
    solved: trace.solved,
    genericGoalMisdirection: analyzeGenericGoalMisdirection(trace, distances),
    progressReversals: analyzeProgressReversals(trace, distances),
    multiRoomJourneys: analyzeMultiRoomJourneys(trace, zoneKind),
    goalRoomPacking: analyzeGoalRoomPacking(grid, trace, zoneByCell),
    gateTraffic: analyzeGateTraffic(trace, zoneKind),
    mixedBoxInteraction: analyzeMixedBoxInteraction(trace),
    solutionPhases: analyzeSolutionPhases(trace),
    structuralIdentity: analyzeStructuralIdentity(trace),
  });
}
