import type { Difficulty, PuzzleDefinition } from "../../../core/model.ts";
import type { CounterfactualStoryProfile } from "./counterfactual-analysis.ts";
import { classifyDifficultyByBoxCount } from "./difficulty-model.ts";
import { verifyMechanismConstruction, type MechanismConstructionPlan } from "./mechanism-construction.ts";
import type { PassiveStoryProfile } from "./passive-story-analysis.ts";
import { boardHash } from "./puzzle-identity.ts";
import type { PuzzleEvaluationVector } from "./puzzle-evaluator.ts";
import { assessQuality, type PuzzleQualityProfile } from "./quality-gate.ts";
import type { CanonicalSolutionTrace } from "./solution-trace.ts";
import { verifyStoryAwareTyping, type StoryAwareTypingPlan } from "./story-aware-typing.ts";
import { strongStoryPairs } from "./story-interaction-graph.ts";
import {
  DEFAULT_STORY_QUALITY_POLICY, STORY_QUALITY_FAMILIES, STORY_QUALITY_POLICY_VERSION,
  type StoryQualityPolicy, type StoryQualityFamily, type StoryQualityMeasurements,
  type StoryQualityReport, type StoryQualityViolation, type StoryQualityRejectionCode, type StoryBoxParticipation,
} from "./story-quality-types.ts";
import { isBoxChar } from "./tile-semantics.ts";

export * from "./story-quality-types.ts";

export interface StoryQualityInput {
  readonly puzzle: PuzzleDefinition;
  readonly trace: CanonicalSolutionTrace | null;
  readonly passiveStory: PassiveStoryProfile | null;
  readonly counterfactualStory?: CounterfactualStoryProfile;
  readonly construction?: MechanismConstructionPlan;
  readonly constructionRequired?: boolean;
  readonly typing?: StoryAwareTypingPlan;
}

function validatePolicy(policy: StoryQualityPolicy): void {
  for (const tier of Object.keys(DEFAULT_STORY_QUALITY_POLICY.minStoryFamilies) as Difficulty[]) {
    const value = policy.minStoryFamilies[tier];
    if (!Number.isInteger(value) || value < 0 || value > STORY_QUALITY_FAMILIES.length) {
      throw new Error(`Invalid story quality policy for ${tier}`);
    }
  }
}

/** Shared rule implementation for live evaluation and release-time rechecking. */
export function storyQualityViolations(
  m: StoryQualityMeasurements,
  policy: StoryQualityPolicy = DEFAULT_STORY_QUALITY_POLICY,
): readonly StoryQualityViolation[] {
  validatePolicy(policy);
  const tier = classifyDifficultyByBoxCount(m.boxCount);
  const violations: StoryQualityViolation[] = [];
  const reject = (code: StoryQualityRejectionCode, message: string, boxIds?: readonly number[]) =>
    violations.push(Object.freeze({ code, message, ...(boxIds ? { boxIds: Object.freeze([...boxIds]) } : {}) }));
  if (!m.evidenceValid) reject("story-evidence-invalid", "Story evidence must match the exact final solved board and evaluation.");
  if (!Number.isInteger(m.boxCount) || m.boxCount < 3) reject("story-box-scale", "Generated puzzles require at least three boxes; Tutorial generation is disabled.");
  const minClass = tier === "beginner" ? 1 : 2;
  if (m.genericBoxCount < minClass || m.typedBoxCount < minClass ||
    m.genericBoxCount + m.typedBoxCount !== m.boxCount) {
    reject("story-mixed-typing", `${tier} requires at least ${minClass} generic and ${minClass} typed boxes.`);
  }
  const filler = m.boxes.filter((box) => box.pushes < 2 || box.distinctCells < 2).map((box) => box.boxId);
  if (filler.length > 0 || m.boxes.length !== m.boxCount) {
    reject("story-box-participation", "Every box must move meaningfully, with at least two pushes; untouched and one-push filler is rejected.", filler);
  }
  const isolated = m.boxes.filter((box) => box.interactionPartners.length === 0).map((box) => box.boxId);
  if (isolated.length > 0) reject("story-isolated-boxes", "Every box must share a route, support, dependency, gate, productive reversal, or packing relationship with another box.", isolated);
  if (m.crossTypePairs.length === 0) reject("story-cross-type-interaction", "Typed and generic boxes need a concrete interaction, not just consecutive pushes.");
  const familyCount = new Set(m.families).size;
  if (familyCount < policy.minStoryFamilies[tier]) {
    reject("story-feature-variety", `${tier} needs ${policy.minStoryFamilies[tier]} distinct story families; observed ${familyCount}.`);
  }
  if (!m.constructionVerified || (m.constructionRequired && m.constructionTargets === 0) ||
    m.constructionRealized !== m.constructionTargets || m.missingConstructionTargets.length > 0) {
    reject("story-construction-unrealized", `Constructed mechanisms must survive final evaluation (${m.constructionRealized}/${m.constructionTargets}); missing: ${m.missingConstructionTargets.join(", ") || "construction evidence"}.`);
  }
  if (!m.typingVerified) reject("story-typing-unverified", "The final solution must pass its story-aware typing plan.");
  return Object.freeze(violations);
}

function measuredFamilies(trace: CanonicalSolutionTrace, story: PassiveStoryProfile): readonly StoryQualityFamily[] {
  const present = new Set<StoryQualityFamily>();
  if (story.genericGoalMisdirection.evidence.length > 0) present.add("assignment-misdirection");
  if (story.progressReversals.evidence.length > 0) present.add("productive-reversal");
  if (story.multiRoomJourneys.evidence.length > 0) present.add("multi-room-journey");
  if (story.goalRoomPacking.evidence.some((room) => room.orderedPairs > 0)) present.add("ordered-packing");
  if (story.gateTraffic.evidence.length > 0) present.add("gate-traffic");
  if (trace.pushes.some((push) => push.enabledBoxIds.length > 0 || push.disabledBoxIds.length > 0)) present.add("causal-dependency");
  for (const role of ["route", "support"] as const) {
    const owners = new Map<string, number>();
    for (const push of trace.pushes) {
      for (const position of role === "route" ? [push.from, push.to] : [push.keeperSupport]) {
        const cell = `${position.row},${position.column}`;
        const owner = owners.get(cell);
        if (owner !== undefined && owner !== push.boxId) present.add(role === "route" ? "shared-transport" : "shared-support");
        owners.set(cell, push.boxId);
      }
    }
  }
  return Object.freeze(STORY_QUALITY_FAMILIES.filter((family) => present.has(family)));
}

export function assessStoryQuality(
  input: StoryQualityInput,
  policy: StoryQualityPolicy = DEFAULT_STORY_QUALITY_POLICY,
): StoryQualityReport {
  validatePolicy(policy);
  const { puzzle, trace, passiveStory: story } = input;
  const hash = boardHash(puzzle.rows);
  const boxCount = puzzle.rows.reduce((sum, row) => sum + [...row].filter(isBoxChar).length, 0);
  const valid = !!trace?.solved && !!story?.solved && hash === trace.boardHash && hash === story.boardHash &&
    trace.boxes.length === boxCount && puzzle.boxes === boxCount;
  const pairs = valid ? strongStoryPairs(trace!, story!) : [];
  const boxes = (trace?.boxes ?? []).map((box): StoryBoxParticipation => {
    const cells = new Set([`${box.initialPosition.row},${box.initialPosition.column}`]);
    const pushes = trace!.pushes.filter((push) => push.boxId === box.id);
    for (const push of pushes) cells.add(`${push.to.row},${push.to.column}`);
    return Object.freeze({
      boxId: box.id, kind: box.kind, pushes: pushes.length, distinctCells: cells.size,
      interactionPartners: Object.freeze(pairs.filter((pair) => pair.includes(box.id))
        .map(([left, right]) => left === box.id ? right : left).sort((a, b) => a - b)),
    });
  });
  const construction = valid && input.construction
    ? verifyMechanismConstruction(input.construction, trace!, story!) : undefined;
  const typing = valid && input.typing ? verifyStoryAwareTyping(input.typing, trace!, story!) : undefined;
  const measurements: StoryQualityMeasurements = Object.freeze({
    boardHash: hash, evidenceValid: valid, boxCount,
    genericBoxCount: boxes.filter((box) => box.kind === "generic").length,
    typedBoxCount: boxes.filter((box) => box.kind === "typed").length,
    boxes: Object.freeze(boxes),
    crossTypePairs: Object.freeze(pairs.filter(([left, right]) => boxes[left].kind !== boxes[right].kind)),
    families: valid ? measuredFamilies(trace!, story!) : Object.freeze([]),
    constructionRequired: input.constructionRequired ?? !!input.construction,
    constructionVerified: input.construction ? construction?.passed ?? false : !input.constructionRequired,
    constructionTargets: input.construction?.targets.length ?? 0,
    constructionRealized: construction?.realizedTargetCount ?? 0,
    missingConstructionTargets: Object.freeze(construction?.targetResults.filter((target) => !target.realized)
      .map((target) => target.targetId) ?? input.construction?.targets.map((target) => target.id) ?? []),
    typingVerified: typing?.passed ?? false,
  });
  const violations = storyQualityViolations(measurements, policy);
  const cf = input.counterfactualStory?.boardHash === hash ? input.counterfactualStory : undefined;
  const tier = classifyDifficultyByBoxCount(boxCount);
  return Object.freeze({
    policyVersion: STORY_QUALITY_POLICY_VERSION, tier,
    requiredStoryFamilies: policy.minStoryFamilies[tier], measurements,
    passed: violations.length === 0, violations,
    counterfactual: Object.freeze({
      available: cf !== undefined, necessary: cf?.necessaryDependencies ?? 0,
      optional: cf?.optionalDependencies ?? 0, recoverable: cf?.recoverableAlternatives ?? 0,
      delayedFalseStarts: cf?.delayedFalseStarts ?? 0, unknown: cf?.unknownProbes ?? 0, omitted: cf?.omittedProbes ?? 0,
    }),
  });
}

/** One qualification entry point used by flat and funnel generation. */
export function assessCandidateQuality(
  input: StoryQualityInput & { readonly evaluation: PuzzleEvaluationVector },
  policy: StoryQualityPolicy = DEFAULT_STORY_QUALITY_POLICY,
): PuzzleQualityProfile {
  const story = assessStoryQuality(input, policy);
  const quality = assessQuality(input.evaluation, story.tier);
  const evaluationMatches = input.evaluation.boxCount === story.measurements.boxCount &&
    input.evaluation.solved && input.evaluation.solutionPushes === input.trace?.pushes.length &&
    input.evaluation.solutionMoves === input.trace?.steps.length;
  const reasons = [...quality.reasons, ...story.violations.map((violation) => `${violation.code}: ${violation.message}`)];
  if (!evaluationMatches) reasons.push("story-evidence-invalid: Evaluation does not match the final trace.");
  return Object.freeze({ ...quality, story, passed: reasons.length === 0, reasons: Object.freeze(reasons) });
}

/** Fail closed on old, malformed, stale, or weaker-than-current release evidence. */
export function checkStoryQualityForRelease(
  value: unknown,
  expected: { readonly boardHash: string; readonly boxCount: number;
    readonly genericBoxCount?: number; readonly typedBoxCount?: number; readonly mode: string },
): readonly string[] {
  const record = (item: unknown): item is Record<string, unknown> =>
    typeof item === "object" && item !== null && !Array.isArray(item);
  const integer = (item: unknown): item is number => Number.isInteger(item) && (item as number) >= 0;
  if (!record(value) || value.policyVersion !== STORY_QUALITY_POLICY_VERSION || !record(value.measurements)) {
    return ["current story quality evidence is required"];
  }
  const m = value.measurements;
  const numbers = ["boxCount", "genericBoxCount", "typedBoxCount", "constructionTargets", "constructionRealized"];
  if (numbers.some((field) => !integer(m[field])) || typeof m.boardHash !== "string" ||
    ["evidenceValid", "constructionRequired", "constructionVerified", "typingVerified"].some((field) => typeof m[field] !== "boolean") ||
    !Array.isArray(m.boxes) || !Array.isArray(m.crossTypePairs) || !Array.isArray(m.families) ||
    !Array.isArray(m.missingConstructionTargets) || !m.missingConstructionTargets.every((id) => typeof id === "string") ||
    typeof value.passed !== "boolean" || !Array.isArray(value.violations)) {
    return ["malformed story quality measurements"];
  }
  const count = m.boxCount as number;
  const boxId = (id: unknown): id is number => integer(id) && id < count;
  const boxes = m.boxes;
  if (boxes.length !== count || boxes.some((box, index) => !record(box) || box.boxId !== index ||
    (box.kind !== "generic" && box.kind !== "typed") || !integer(box.pushes) || !integer(box.distinctCells) ||
    !Array.isArray(box.interactionPartners) ||
    box.interactionPartners.some((id) => !boxId(id) || id === index) ||
    new Set(box.interactionPartners).size !== box.interactionPartners.length)) {
    return ["malformed story box participation"];
  }
  const typedBoxes = boxes as unknown as readonly StoryBoxParticipation[];
  if (typedBoxes.some((box) => box.interactionPartners.some((partner) =>
    !typedBoxes[partner].interactionPartners.includes(box.boxId)))) {
    return ["story interaction partners must be symmetric"];
  }
  if (m.crossTypePairs.some((pair) => !Array.isArray(pair) || pair.length !== 2 ||
    !boxId(pair[0]) || !boxId(pair[1]) || pair[0] >= pair[1] ||
    typedBoxes[pair[0]].kind === typedBoxes[pair[1]].kind ||
    !typedBoxes[pair[0]].interactionPartners.includes(pair[1]))) {
    return ["invalid cross-type story pairs"];
  }
  if (m.families.some((family) => !(STORY_QUALITY_FAMILIES as readonly unknown[]).includes(family)) ||
    new Set(m.families).size !== m.families.length) return ["invalid or repeated story families"];
  const metrics = m as unknown as StoryQualityMeasurements;
  const errors: string[] = [];
  if (m.boardHash !== expected.boardHash || count !== expected.boxCount ||
    m.genericBoxCount !== expected.genericBoxCount || m.typedBoxCount !== expected.typedBoxCount ||
    typedBoxes.filter((box) => box.kind === "generic").length !== m.genericBoxCount ||
    typedBoxes.filter((box) => box.kind === "typed").length !== m.typedBoxCount) {
    errors.push("story quality evidence does not match the reviewed board and boxes");
  }
  const tier = classifyDifficultyByBoxCount(count);
  if (value.tier !== tier || !integer(value.requiredStoryFamilies) ||
    value.requiredStoryFamilies < DEFAULT_STORY_QUALITY_POLICY.minStoryFamilies[tier] ||
    metrics.families.length < value.requiredStoryFamilies) {
    errors.push("story quality policy does not meet the current box-count tier floor");
  }
  if (m.constructionRealized as number > (m.constructionTargets as number) ||
    metrics.missingConstructionTargets.length !== metrics.constructionTargets - metrics.constructionRealized ||
    (expected.mode === "mechanism" && !m.constructionRequired)) errors.push("inconsistent story construction evidence");
  if (value.passed !== true || value.violations.length > 0) errors.push("story quality gate did not pass");
  errors.push(...storyQualityViolations(metrics).map((violation) => `${violation.code}: ${violation.message}`));
  return errors;
}
