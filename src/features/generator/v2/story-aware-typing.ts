import type { PuzzleDefinition } from "../../../core/model.ts";
import type { SolverSolution } from "../../../solver/contracts.ts";
import {
  applyHybridTypingConstructionPlan,
  buildHybridTypingConstructionPlan,
  type HybridTypingConstructionPlan,
  type HybridTypingGenericWitness,
  type HybridTypingGoalGroup,
  type HybridTypingOppositionRequirement,
} from "../label-assignment.ts";
import type { MechanismType } from "./blueprint-types.ts";
import type { MechanismConstructionPlan } from "./mechanism-construction.ts";
import { boardHash } from "./puzzle-identity.ts";
import { strongStoryPairs, sharedCellPairs } from "./story-interaction-graph.ts";
import {
  analyzePassiveSolutionStory,
  type PassiveStoryProfile,
} from "./passive-story-analysis.ts";
import {
  buildCanonicalSolutionTrace,
  type CanonicalSolutionTrace,
  type TraceBoxKind,
} from "./solution-trace.ts";

export interface StoryAwareTypingTargetPlan {
  readonly targetId: string;
  readonly mechanismType: MechanismType | "global";
  readonly goalIds: readonly string[];
  readonly boxIds: readonly number[];
  readonly minTyped: number;
  readonly minGeneric: number;
  readonly requireStrongInteraction: boolean;
  readonly genericWitnesses: readonly HybridTypingGenericWitness[];
  readonly oppositionRequirements: readonly HybridTypingOppositionRequirement[];
}

export interface StoryAwareTypingPlan {
  readonly boardHash: string;
  /** Witness pairing, used to rebind goal roles after a different final solve. */
  readonly boxGoalIds: readonly string[];
  readonly hybridPlan: HybridTypingConstructionPlan;
  readonly targets: readonly StoryAwareTypingTargetPlan[];
}

export interface StoryAwareTypingResult {
  readonly puzzle: PuzzleDefinition;
  readonly plan: StoryAwareTypingPlan;
}

export interface StoryAwareTypingTargetVerification {
  readonly targetId: string;
  readonly mechanismType: MechanismType | "global";
  readonly targetBoxIds: readonly number[];
  readonly typedCount: number;
  readonly genericCount: number;
  readonly classMinimumsSatisfied: boolean;
  readonly strongInteractionSatisfied: boolean;
  readonly supportContentionSatisfied: boolean;
  readonly assignmentAmbiguitySatisfied: boolean;
  readonly roleOppositionSatisfied: boolean;
  readonly passed: boolean;
}

export interface StoryAwareTypingVerification {
  readonly passed: boolean;
  readonly boardMatches: boolean;
  readonly targetCount: number;
  readonly realizedTargetCount: number;
  readonly targets: readonly StoryAwareTypingTargetVerification[];
}

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


function minimumClassSize(puzzle: PuzzleDefinition): number {
  return puzzle.difficulty === "beginner" || puzzle.difficulty === "tutorial" ? 1 : 2;
}

function targetGoalIndices(
  trace: CanonicalSolutionTrace,
  positions: readonly { readonly row: number; readonly column: number }[],
): readonly number[] {
  const indexByPosition = new Map(trace.goals.map((goal, index) =>
    [positionKey(goal.position), index] as const));
  return Object.freeze(positions
    .map((position) => indexByPosition.get(positionKey(position)))
    .filter((index): index is number => index !== undefined));
}

function boxesForGoalIndices(
  trace: CanonicalSolutionTrace,
  goalIndices: readonly number[],
): readonly number[] {
  const goalIds = new Set(goalIndices.map((index) => trace.goals[index]?.id));
  return Object.freeze(trace.boxes
    .filter((box) => box.finalGoalId && goalIds.has(box.finalGoalId))
    .map((box) => box.id)
    .sort((left, right) => left - right));
}

function roleOppositions(
  trace: CanonicalSolutionTrace,
  goals: readonly { readonly position: { readonly row: number; readonly column: number }; readonly role: string }[],
  targetId: string,
): readonly HybridTypingOppositionRequirement[] {
  const goalByPosition = new Map(trace.goals.map((goal) =>
    [positionKey(goal.position), goal.id] as const));
  const boxByGoal = new Map(trace.boxes
    .filter((box) => box.finalGoalId !== undefined)
    .map((box) => [box.finalGoalId as string, box.id] as const));
  const byRole = new Map<string, number[]>();
  for (const goal of goals) {
    const goalId = goalByPosition.get(positionKey(goal.position));
    const boxId = goalId === undefined ? undefined : boxByGoal.get(goalId);
    if (boxId === undefined) continue;
    const list = byRole.get(goal.role) ?? [];
    list.push(boxId);
    byRole.set(goal.role, list);
  }
  const requirements: HybridTypingOppositionRequirement[] = [];
  const oppose = (id: string, leftRoles: readonly string[], rightRoles: readonly string[]) => {
    const left = leftRoles.flatMap((role) => byRole.get(role) ?? []);
    const right = rightRoles.flatMap((role) => byRole.get(role) ?? []);
    const pairs = distinctPairs(left.flatMap((leftBox) => right
      .map((rightBox) => normalizedPair(leftBox, rightBox))
      .filter((pair): pair is BoxPair => pair !== null)));
    if (pairs.length > 0) requirements.push(Object.freeze({ id: `${targetId}:${id}`, pairs }));
  };
  const opposeWithin = (id: string, role: string) => {
    const boxes = byRole.get(role) ?? [];
    const pairs: BoxPair[] = [];
    for (let left = 0; left < boxes.length; left++) {
      for (let right = left + 1; right < boxes.length; right++) {
        const pair = normalizedPair(boxes[left], boxes[right]);
        if (pair) pairs.push(pair);
      }
    }
    if (pairs.length > 0) requirements.push(Object.freeze({
      id: `${targetId}:${id}`,
      pairs: distinctPairs(pairs),
    }));
  };
  oppose("gate-traffic", ["gatekeeper", "gate-reopen"], ["inner", "inner-beyond-gate"]);
  oppose("staging", ["staging-deep"], ["staging-blocker"]);
  oppose("corridor", ["traffic-near"], ["traffic-far"]);
  oppose("parking", ["parking-deep"], ["parking-shallow"]);
  opposeWithin("support-contenders", "shared-support");
  oppose("merge-a", ["chain-merge"], ["chain-a"]);
  oppose("merge-b", ["chain-merge"], ["chain-b"]);
  return Object.freeze(requirements);
}

function ambiguityWitnesses(
  trace: CanonicalSolutionTrace,
  story: PassiveStoryProfile,
  targetBoxIds: ReadonlySet<number>,
): readonly HybridTypingGenericWitness[] {
  const boxByGoal = new Map(trace.boxes
    .filter((box) => box.finalGoalId !== undefined)
    .map((box) => [box.finalGoalId as string, box.id] as const));
  return Object.freeze(story.genericGoalMisdirection.evidence
    .filter((evidence) => targetBoxIds.has(evidence.boxId))
    .map((evidence) => Object.freeze({
      boxIndex: evidence.boxId,
      alternativeBoxIndices: Object.freeze(evidence.nearestGoalIds
        .map((goalId) => boxByGoal.get(goalId))
        .filter((boxId): boxId is number => boxId !== undefined && boxId !== evidence.boxId)),
    }))
    .filter((witness) => witness.alternativeBoxIndices.length > 0));
}

function buildTargetPlans(
  puzzle: PuzzleDefinition,
  trace: CanonicalSolutionTrace,
  story: PassiveStoryProfile,
  construction?: MechanismConstructionPlan,
): readonly StoryAwareTypingTargetPlan[] | null {
  const minKind = minimumClassSize(puzzle);
  const allBoxes = trace.boxes.map((box) => box.id);
  const allGoals = trace.goals.map((goal) => goal.id);
  const allStrongPairs = strongStoryPairs(trace, story);
  if (allStrongPairs.length === 0) return null;
  const globalAmbiguityWitnesses = ambiguityWitnesses(trace, story, new Set(allBoxes));
  const witnessesApplicable = allBoxes.length >= minKind + 2;
  const oppositionBoxes = new Set(allStrongPairs.flat());
  const compatibleWitnesses = witnessesApplicable
    ? globalAmbiguityWitnesses.filter((witness) =>
      witness.alternativeBoxIndices.some((alt) =>
        !oppositionBoxes.has(witness.boxIndex) || !oppositionBoxes.has(alt)))
    : [];
  const targets: StoryAwareTypingTargetPlan[] = [Object.freeze({
    targetId: "global-story",
    mechanismType: "global",
    goalIds: Object.freeze(allGoals),
    boxIds: Object.freeze(allBoxes),
    minTyped: minKind,
    minGeneric: minKind,
    requireStrongInteraction: true,
    genericWitnesses: Object.freeze(compatibleWitnesses),
    oppositionRequirements: Object.freeze([Object.freeze({
      id: "global-story:causal-or-ordering",
      pairs: allStrongPairs,
    })]),
  })];

  for (const target of construction?.targets ?? []) {
    const goalIndices = targetGoalIndices(trace, target.goals.map((goal) => goal.position));
    if (goalIndices.length !== target.goals.length) return null;
    const boxIds = boxesForGoalIndices(trace, goalIndices);
    if (boxIds.length !== goalIndices.length) return null;
    const boxSet = new Set(boxIds);
    const targetStrongPairs = allStrongPairs.filter(([left, right]) =>
      boxSet.has(left) && boxSet.has(right));
    const genericWitnesses = target.type === "assignment-misdirection"
      ? ambiguityWitnesses(trace, story, boxSet)
      : Object.freeze([]);
    if (target.type === "assignment-misdirection" && genericWitnesses.length === 0) return null;
    const roleRequirements = roleOppositions(trace, target.goals, target.id);
    const supportPairs = target.type === "support-square-contention"
      ? sharedCellPairs(trace, "support").filter(([left, right]) =>
        boxSet.has(left) && boxSet.has(right))
      : [];
    if (target.type === "support-square-contention" && supportPairs.length === 0) return null;
    const supportRequirements = supportPairs.length > 0
      ? [Object.freeze({ id: `${target.id}:shared-support`, pairs: supportPairs })]
      : [];
    const storyRequirements = targetStrongPairs.length > 0
      ? [Object.freeze({ id: `${target.id}:observed-story`, pairs: targetStrongPairs })]
      : [];
    const requireStrongInteraction = target.requiredEvidence.includes("cross-type-interaction");
    if (requireStrongInteraction && storyRequirements.length === 0 && roleRequirements.length === 0) {
      return null;
    }
    targets.push(Object.freeze({
      targetId: target.id,
      mechanismType: target.type,
      goalIds: Object.freeze(goalIndices.map((index) => trace.goals[index].id)),
      boxIds,
      minTyped: 1,
      minGeneric: target.type === "assignment-misdirection" ? 2 : 1,
      requireStrongInteraction,
      genericWitnesses,
      oppositionRequirements: Object.freeze([
        ...storyRequirements, ...roleRequirements, ...supportRequirements,
      ]),
    }));
  }
  return Object.freeze(targets);
}

function targetToGoalGroup(
  target: StoryAwareTypingTargetPlan,
  trace: CanonicalSolutionTrace,
): HybridTypingGoalGroup {
  const goalIndex = new Map(trace.goals.map((goal, index) => [goal.id, index] as const));
  return Object.freeze({
    id: target.targetId,
    goalIndices: new Set(target.goalIds
      .map((goalId) => goalIndex.get(goalId))
      .filter((index): index is number => index !== undefined)),
    minTyped: target.minTyped,
    minGeneric: target.minGeneric,
    requireInteractionCut: false,
    genericWitnesses: target.genericWitnesses,
    oppositionRequirements: target.oppositionRequirements,
  });
}

/** Construct a hybrid assignment from the actual witness story. */
export function applyStoryAwareTyping(
  puzzle: PuzzleDefinition,
  solution: SolverSolution,
  rng: () => number,
  typedFraction: number,
  construction?: MechanismConstructionPlan,
): StoryAwareTypingResult | null {
  if (!Number.isFinite(typedFraction)) return null;
  const traceResult = buildCanonicalSolutionTrace(
    puzzle.rows.map((row) => [...row]),
    solution.steps,
    { puzzleId: puzzle.id, requireSolved: true },
  );
  if (!traceResult.ok) return null;
  if (traceResult.trace.boxes.some((box) => box.kind !== "generic") ||
    traceResult.trace.goals.some((goal) => goal.kind !== "generic")) return null;
  const story = analyzePassiveSolutionStory(
    puzzle.rows.map((row) => [...row]),
    traceResult.trace,
  );
  const targets = buildTargetPlans(puzzle, traceResult.trace, story, construction);
  if (!targets) return null;
  const hybridPlan = buildHybridTypingConstructionPlan(
    puzzle,
    solution.steps,
    rng,
    typedFraction,
    targets.map((target) => targetToGoalGroup(target, traceResult.trace)),
  );
  if (!hybridPlan || hybridPlan.constraintResults.some((result) => !result.satisfied)) return null;
  const typedPuzzle = applyHybridTypingConstructionPlan(
    puzzle,
    solution.steps,
    hybridPlan,
    rng,
  );
  if (typedPuzzle === puzzle) return null;
  return Object.freeze({
    puzzle: typedPuzzle,
    plan: Object.freeze({
      boardHash: boardHash(typedPuzzle.rows),
      boxGoalIds: Object.freeze(traceResult.trace.boxes.map((box) => box.finalGoalId!)),
      hybridPlan,
      targets,
    }),
  });
}

function kindByBox(trace: CanonicalSolutionTrace): ReadonlyMap<number, TraceBoxKind> {
  return new Map(trace.boxes.map((box) => [box.id, box.kind] as const));
}

function pairIsCrossType(pair: BoxPair, kinds: ReadonlyMap<number, TraceBoxKind>): boolean {
  const left = kinds.get(pair[0]);
  const right = kinds.get(pair[1]);
  return left !== undefined && right !== undefined && left !== right;
}

/** Verify the intended class story on the exact final replay selected by evaluation. */
export function verifyStoryAwareTyping(
  plan: StoryAwareTypingPlan,
  trace: CanonicalSolutionTrace,
  story: PassiveStoryProfile,
): StoryAwareTypingVerification {
  if (trace.boardHash !== story.boardHash) {
    throw new Error("Story-aware typing verification requires matching trace and story evidence");
  }
  const kinds = kindByBox(trace);
  const boardMatches = plan.boardHash === trace.boardHash;
  const finalStrongPairs = strongStoryPairs(trace, story);
  const finalSupportPairs = sharedCellPairs(trace, "support");
  const boxByGoal = new Map(trace.boxes
    .filter((box) => box.finalGoalId !== undefined)
    .map((box) => [box.finalGoalId!, box.id] as const));
  const rebindPair = ([left, right]: BoxPair): BoxPair | null => {
    const finalLeft = boxByGoal.get(plan.boxGoalIds[left]);
    const finalRight = boxByGoal.get(plan.boxGoalIds[right]);
    return finalLeft === undefined || finalRight === undefined
      ? null : normalizedPair(finalLeft, finalRight);
  };
  const results = plan.targets.map((target): StoryAwareTypingTargetVerification => {
    const targetBoxIds = target.goalIds.map((goalId) => boxByGoal.get(goalId))
      .filter((boxId): boxId is number => boxId !== undefined);
    const targetBoxes = new Set(targetBoxIds);
    const typedCount = targetBoxIds.filter((boxId) => kinds.get(boxId) === "typed").length;
    const genericCount = targetBoxIds.filter((boxId) => kinds.get(boxId) === "generic").length;
    const classMinimumsSatisfied =
      typedCount >= target.minTyped && genericCount >= target.minGeneric;
    const strongInteractionSatisfied = !target.requireStrongInteraction || finalStrongPairs.some(
      (pair) => targetBoxes.has(pair[0]) && targetBoxes.has(pair[1]) && pairIsCrossType(pair, kinds),
    );
    const assignmentAmbiguitySatisfied = target.genericWitnesses.length === 0 ||
      story.genericGoalMisdirection.evidence.some((evidence) =>
        targetBoxes.has(evidence.boxId) && target.goalIds.includes(evidence.actualGoalId));
    const supportContentionSatisfied = target.mechanismType !== "support-square-contention" ||
      finalSupportPairs.some((pair) => targetBoxes.has(pair[0]) && targetBoxes.has(pair[1]) &&
        pairIsCrossType(pair, kinds));
    const roleOppositionSatisfied = target.oppositionRequirements.every((requirement) =>
      requirement.pairs.some((pair) => {
        const finalPair = rebindPair(pair);
        return finalPair !== null && pairIsCrossType(finalPair, kinds);
      }));
    const passed = boardMatches && trace.solved && story.solved &&
      targetBoxes.size === target.goalIds.length && classMinimumsSatisfied &&
      strongInteractionSatisfied && supportContentionSatisfied &&
      assignmentAmbiguitySatisfied && roleOppositionSatisfied;
    return Object.freeze({
      targetId: target.targetId,
      mechanismType: target.mechanismType,
      targetBoxIds: Object.freeze(targetBoxIds),
      typedCount,
      genericCount,
      classMinimumsSatisfied,
      strongInteractionSatisfied,
      supportContentionSatisfied,
      assignmentAmbiguitySatisfied,
      roleOppositionSatisfied,
      passed,
    });
  });
  const realizedTargetCount = results.filter((result) => result.passed).length;
  return Object.freeze({
    passed: results.length > 0 && realizedTargetCount === results.length,
    boardMatches,
    targetCount: results.length,
    realizedTargetCount,
    targets: Object.freeze(results),
  });
}
