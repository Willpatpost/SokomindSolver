import type {
  MechanismPlan,
  MechanismType,
} from "./blueprint-types.ts";
import type { MechanismPlacementResult } from "./mechanism-plan.ts";
import type { PassiveStoryProfile } from "./passive-story-analysis.ts";
import type { CanonicalSolutionTrace, TracePosition } from "./solution-trace.ts";
import { strongStoryPairs } from "./story-interaction-graph.ts";

export type MechanismConstructionDirective =
  | "ordered-goal-depth"
  | "doorway-gate"
  | "doorway-gate-reopen"
  | "temporary-displacement"
  | "shared-passage"
  | "park-and-resume"
  | "ordered-dependency-chain"
  | "cross-room-exchange"
  | "misdirected-assignment"
  | "shared-support-contention"
  | "converging-chains";

export type ConstructedStoryEvidenceKind =
  | "ordered-packing"
  | "gate-traffic"
  | "gate-reopening"
  | "progress-reversal"
  | "multi-room-journey"
  | "box-revisit"
  | "cross-type-interaction"
  | "assignment-misdirection"
  | "support-contention"
  | "multi-chain-merge";

export interface MechanismGoalTarget {
  readonly goalIndex: number;
  readonly goalId: string;
  readonly position: TracePosition;
  readonly roomId: number;
  readonly depthFromDoorway: number;
  readonly role: string;
}

export interface MechanismConstructionTarget {
  readonly id: string;
  readonly mechanismIndex: number;
  readonly type: MechanismType;
  readonly directive: MechanismConstructionDirective;
  readonly roomIds: readonly number[];
  readonly goals: readonly MechanismGoalTarget[];
  readonly requiredEvidence: readonly ConstructedStoryEvidenceKind[];
  readonly dependsOnTargetIds: readonly string[];
}

export interface MechanismConstructionPlan {
  readonly seed: number;
  readonly tier: string;
  readonly boxCount: number;
  readonly minGenericBoxes: number;
  readonly minTypedBoxes: number;
  readonly crossTypeInteractionRequired: boolean;
  readonly targets: readonly MechanismConstructionTarget[];
}

export interface ConstructedEvidenceReference {
  readonly kind: ConstructedStoryEvidenceKind;
  readonly sourceIndex: number;
  readonly boxIds: readonly number[];
  readonly goalIds: readonly string[];
  readonly pushIndices: readonly number[];
  readonly zoneIds: readonly string[];
}

export interface MechanismConstructionTargetResult {
  readonly targetId: string;
  readonly type: MechanismType;
  readonly realized: boolean;
  readonly targetGoalIds: readonly string[];
  readonly targetBoxIds: readonly number[];
  readonly requiredEvidence: readonly ConstructedStoryEvidenceKind[];
  readonly observedEvidence: readonly ConstructedStoryEvidenceKind[];
  readonly missingEvidence: readonly ConstructedStoryEvidenceKind[];
  readonly evidence: readonly ConstructedEvidenceReference[];
}

export interface MechanismConstructionVerification {
  readonly passed: boolean;
  readonly targetCount: number;
  readonly realizedTargetCount: number;
  readonly genericBoxCount: number;
  readonly typedBoxCount: number;
  readonly boxKindMinimumsSatisfied: boolean;
  readonly crossTypeInteractionSatisfied: boolean;
  readonly targetResults: readonly MechanismConstructionTargetResult[];
}

const DIRECTIVE_BY_TYPE: Readonly<Record<MechanismType, MechanismConstructionDirective>> = {
  "packing-chain": "ordered-goal-depth",
  gatekeeper: "doorway-gate",
  "gate-reopening": "doorway-gate-reopen",
  "staging-dependency": "temporary-displacement",
  "corridor-traffic": "shared-passage",
  "temporary-parking": "park-and-resume",
  "dependency-chain": "ordered-dependency-chain",
  "cross-room-exchange": "cross-room-exchange",
  "assignment-misdirection": "misdirected-assignment",
  "support-square-contention": "shared-support-contention",
  "multi-chain-merge": "converging-chains",
};

const REQUIRED_EVIDENCE_BY_TYPE: Readonly<
  Record<MechanismType, readonly ConstructedStoryEvidenceKind[]>
> = {
  "packing-chain": ["ordered-packing"],
  gatekeeper: ["gate-traffic"],
  "gate-reopening": ["gate-traffic", "gate-reopening"],
  "staging-dependency": ["progress-reversal"],
  "corridor-traffic": ["multi-room-journey"],
  "temporary-parking": ["progress-reversal", "box-revisit"],
  "dependency-chain": ["ordered-packing", "box-revisit"],
  "cross-room-exchange": ["multi-room-journey"],
  "assignment-misdirection": ["assignment-misdirection", "multi-room-journey"],
  "support-square-contention": ["support-contention", "box-revisit"],
  "multi-chain-merge": ["multi-chain-merge", "ordered-packing"],
};

function minimumKindCount(tier: string, boxCount: number): number {
  if (boxCount < 2 || tier === "tutorial") return 0;
  if (tier === "beginner") return 1;
  return boxCount >= 4 ? 2 : 1;
}

function dependencyTargetIds(plan: MechanismPlan, mechanismIndex: number): readonly string[] {
  return Object.freeze(plan.intendedDependencies
    .filter((edge) => edge.toMechanism === mechanismIndex)
    .map((edge) => `mechanism-${edge.fromMechanism}`)
    .sort());
}

/**
 * Turn placed mechanism goals into explicit construction targets. The targets
 * preserve the actual goal cells and roles instead of relying on mechanism
 * names after geometry and typing transformations.
 */
export function buildMechanismConstructionPlan(
  placement: MechanismPlacementResult,
): MechanismConstructionPlan {
  const { plan, dag, solved } = placement;
  let goalOffset = 0;
  const targets: MechanismConstructionTarget[] = [];

  for (let mechanismIndex = 0; mechanismIndex < plan.mechanisms.length; mechanismIndex++) {
    const mechanism = plan.mechanisms[mechanismIndex];
    const end = goalOffset + mechanism.allocatedGoals;
    const nodes = dag.nodes
      .filter((node) => node.goalIndex >= goalOffset && node.goalIndex < end)
      .sort((left, right) => left.goalIndex - right.goalIndex);
    const goals: MechanismGoalTarget[] = [];
    for (const node of nodes) {
      const goal = solved.goals[node.goalIndex];
      if (!goal) continue;
      goals.push(Object.freeze({
        goalIndex: node.goalIndex,
        goalId: goal.goalId ?? node.goalId ?? `goal-index-${node.goalIndex}`,
        position: Object.freeze({ row: goal.row, column: goal.column }),
        roomId: goal.roomId,
        depthFromDoorway: goal.depthFromDoorway,
        role: node.role,
      }));
    }
    const requiredEvidence = [...REQUIRED_EVIDENCE_BY_TYPE[mechanism.type]];
    if (mechanism.crossTypeDependencyRequired && goals.length >= 2) {
      requiredEvidence.push("cross-type-interaction");
    }
    targets.push(Object.freeze({
      id: `mechanism-${mechanismIndex}`,
      mechanismIndex,
      type: mechanism.type,
      directive: DIRECTIVE_BY_TYPE[mechanism.type],
      roomIds: Object.freeze([...mechanism.primaryRoomIds]),
      goals: Object.freeze(goals),
      requiredEvidence: Object.freeze(requiredEvidence),
      dependsOnTargetIds: dependencyTargetIds(plan, mechanismIndex),
    }));
    goalOffset = end;
  }

  const boxCount = plan.mechanisms.reduce((sum, mechanism) =>
    sum + mechanism.allocatedGoals, 0);
  const minKindCount = minimumKindCount(plan.tier, boxCount);
  return Object.freeze({
    seed: plan.seed,
    tier: plan.tier,
    boxCount,
    minGenericBoxes: minKindCount,
    minTypedBoxes: minKindCount,
    crossTypeInteractionRequired: minKindCount > 0 && boxCount >= 2,
    targets: Object.freeze(targets),
  });
}

function positionKey(position: TracePosition): string {
  return `${position.row},${position.column}`;
}

function reference(
  kind: ConstructedStoryEvidenceKind,
  sourceIndex: number,
  boxIds: readonly number[] = [],
  goalIds: readonly string[] = [],
  pushIndices: readonly number[] = [],
  zoneIds: readonly string[] = [],
): ConstructedEvidenceReference {
  return Object.freeze({
    kind,
    sourceIndex,
    boxIds: Object.freeze([...new Set(boxIds)].sort((a, b) => a - b)),
    goalIds: Object.freeze([...new Set(goalIds)].sort()),
    pushIndices: Object.freeze([...new Set(pushIndices)].sort((a, b) => a - b)),
    zoneIds: Object.freeze([...new Set(zoneIds)].sort()),
  });
}

function evidenceForKind(
  kind: ConstructedStoryEvidenceKind,
  trace: CanonicalSolutionTrace,
  story: PassiveStoryProfile,
  relevantBoxes: ReadonlySet<number>,
  relevantGoals: ReadonlySet<string>,
): readonly ConstructedEvidenceReference[] {
  const result: ConstructedEvidenceReference[] = [];
  if (kind === "ordered-packing") {
    story.goalRoomPacking.evidence.forEach((item, index) => {
      const placements = item.placements.filter((placement) =>
        relevantGoals.has(placement.goalId));
      if (!placements.some((deeper) => placements.some((shallower) =>
        deeper.depthFromEntrance > shallower.depthFromEntrance &&
        deeper.completionPushIndex < shallower.completionPushIndex))) return;
      result.push(reference(
        kind,
        index,
        placements.map((placement) => placement.boxId),
        placements.map((placement) => placement.goalId),
        placements.map((placement) => placement.completionPushIndex),
        [item.roomId],
      ));
    });
  } else if (kind === "gate-traffic" || kind === "gate-reopening") {
    story.gateTraffic.evidence.forEach((item, index) => {
      if (!relevantBoxes.has(item.gateBoxId)) return;
      const trafficBoxes = item.trafficBoxIds.filter((boxId) => relevantBoxes.has(boxId));
      if (trafficBoxes.length === 0) return;
      if (kind === "gate-reopening" && item.reopeningPushIndex === undefined) return;
      result.push(reference(
        kind,
        index,
        [item.gateBoxId, ...trafficBoxes],
        [],
        [
          item.openingPushIndex,
          ...item.trafficPushIndices,
          ...(item.returnPushIndex === undefined ? [] : [item.returnPushIndex]),
          ...(item.reopeningPushIndex === undefined ? [] : [item.reopeningPushIndex]),
        ],
        [item.doorwayZoneId],
      ));
    });
  } else if (kind === "progress-reversal") {
    story.progressReversals.evidence.forEach((item, index) => {
      if (!relevantBoxes.has(item.boxId)) return;
      const beneficiaries = item.benefitingBoxIds.filter((boxId) => relevantBoxes.has(boxId));
      if (beneficiaries.length === 0) return;
      result.push(reference(
        kind,
        index,
        [item.boxId, ...beneficiaries],
        [item.finalGoalId],
        [item.reversalPushIndex, item.recoveryPushIndex],
      ));
    });
  } else if (kind === "multi-room-journey") {
    story.multiRoomJourneys.evidence.forEach((item, index) => {
      if (!relevantBoxes.has(item.boxId)) return;
      result.push(reference(
        kind,
        index,
        [item.boxId],
        [],
        item.transitions.map((transition) => transition.pushIndex),
        item.zoneSequence,
      ));
    });
  } else if (kind === "box-revisit") {
    story.solutionPhases.phases.forEach((phase, index) => {
      if (!phase.revisitsBox || !phase.boxIds.some((boxId) => relevantBoxes.has(boxId))) return;
      result.push(reference(
        kind,
        index,
        phase.boxIds,
        phase.completedGoalId ? [phase.completedGoalId] : [],
        [phase.startPushIndex, phase.endPushIndex],
        phase.zoneIds,
      ));
    });
  } else if (kind === "assignment-misdirection") {
    story.genericGoalMisdirection.evidence.forEach((item, index) => {
      if (!relevantBoxes.has(item.boxId) || !relevantGoals.has(item.actualGoalId)) return;
      result.push(reference(kind, index, [item.boxId], [item.actualGoalId, ...item.nearestGoalIds]));
    });
  } else if (kind === "support-contention") {
    story.mixedBoxInteraction.sharedCellEvidence.forEach((item, index) => {
      if (item.role !== "support") return;
      const boxes = item.boxIds.filter((boxId) => relevantBoxes.has(boxId));
      if (boxes.length < 2) return;
      result.push(reference(kind, index, boxes));
    });
  } else if (kind === "multi-chain-merge") {
    story.goalRoomPacking.evidence.forEach((item, index) => {
      const placements = item.placements.filter((placement) => relevantGoals.has(placement.goalId));
      if (!placements.some((deeper) => placements.some((shallower) =>
        deeper.depthFromEntrance > shallower.depthFromEntrance &&
        deeper.completionPushIndex < shallower.completionPushIndex))) return;
      result.push(reference(kind, index, placements.map((placement) => placement.boxId), placements.map((placement) => placement.goalId), placements.map((placement) => placement.completionPushIndex), [item.roomId]));
    });
    if (result.length < 2) result.length = 0;
  } else {
    strongStoryPairs(trace, story).forEach((pair, index) => {
      if (!pair.every((boxId) => relevantBoxes.has(boxId)) ||
        trace.boxes[pair[0]].kind === trace.boxes[pair[1]].kind) return;
      result.push(reference(
        kind,
        index,
        pair,
        [],
        trace.pushes.filter((push) => pair.includes(push.boxId)).map((push) => push.pushIndex),
      ));
    });
  }
  return Object.freeze(result);
}

function traceGoalIdsForTarget(
  target: MechanismConstructionTarget,
  trace: CanonicalSolutionTrace,
): readonly string[] {
  const goalByPosition = new Map(trace.goals.map((goal) =>
    [positionKey(goal.position), goal.id] as const));
  return Object.freeze(target.goals
    .map((goal) => goalByPosition.get(positionKey(goal.position)))
    .filter((goalId): goalId is string => goalId !== undefined));
}

/** Verify that constructed targets survive reverse search, typing, and solving. */
export function verifyMechanismConstruction(
  construction: MechanismConstructionPlan,
  trace: CanonicalSolutionTrace,
  story: PassiveStoryProfile,
): MechanismConstructionVerification {
  if (trace.boardHash !== story.boardHash) {
    throw new Error("Mechanism construction verification requires matching trace and story evidence");
  }
  const boxByGoal = new Map<string, number>();
  for (const box of trace.boxes) if (box.finalGoalId) boxByGoal.set(box.finalGoalId, box.id);

  const targetResults = construction.targets.map((target): MechanismConstructionTargetResult => {
    const targetGoalIds = traceGoalIdsForTarget(target, trace);
    const targetBoxIds = targetGoalIds
      .map((goalId) => boxByGoal.get(goalId))
      .filter((boxId): boxId is number => boxId !== undefined);
    const relevantBoxes = new Set(targetBoxIds);
    const relevantGoals = new Set(targetGoalIds);
    const evidence = target.requiredEvidence.flatMap((kind) =>
      evidenceForKind(kind, trace, story, relevantBoxes, relevantGoals));
    const observedEvidence = [...new Set(evidence.map((item) => item.kind))];
    const missingEvidence = target.requiredEvidence.filter((kind) =>
      !observedEvidence.includes(kind));
    return Object.freeze({
      targetId: target.id,
      type: target.type,
      realized: trace.solved && story.solved && target.goals.length > 0 &&
        new Set(targetGoalIds).size === target.goals.length &&
        new Set(targetBoxIds).size === target.goals.length && missingEvidence.length === 0,
      targetGoalIds,
      targetBoxIds: Object.freeze(targetBoxIds),
      requiredEvidence: target.requiredEvidence,
      observedEvidence: Object.freeze(observedEvidence),
      missingEvidence: Object.freeze(missingEvidence),
      evidence: Object.freeze(evidence),
    });
  });

  const genericBoxCount = trace.boxes.filter((box) => box.kind === "generic").length;
  const typedBoxCount = trace.boxes.filter((box) => box.kind === "typed").length;
  const boxKindMinimumsSatisfied =
    genericBoxCount >= construction.minGenericBoxes &&
    typedBoxCount >= construction.minTypedBoxes;
  const locallyRequired = targetResults.filter((result) =>
    result.requiredEvidence.includes("cross-type-interaction"));
  const crossTypeInteractionSatisfied =
    !construction.crossTypeInteractionRequired ||
    (locallyRequired.length > 0 && locallyRequired.every((result) =>
      result.observedEvidence.includes("cross-type-interaction")));
  const realizedTargetCount = targetResults.filter((result) => result.realized).length;

  return Object.freeze({
    passed:
      targetResults.length > 0 &&
      realizedTargetCount === targetResults.length &&
      boxKindMinimumsSatisfied &&
      crossTypeInteractionSatisfied,
    targetCount: targetResults.length,
    realizedTargetCount,
    genericBoxCount,
    typedBoxCount,
    boxKindMinimumsSatisfied,
    crossTypeInteractionSatisfied,
    targetResults: Object.freeze(targetResults),
  });
}
