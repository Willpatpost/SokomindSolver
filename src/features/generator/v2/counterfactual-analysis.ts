import { DIRECTIONS } from "../../../core/model.ts";
import { directionDelta } from "../../../core/position.ts";
import { boardHash } from "./puzzle-identity.ts";
import { enumerateReachablePushes, floodKeeperReachable } from "./reachable-pushes.ts";
import type { CanonicalSolutionTrace, TracePosition, TracePushOption } from "./solution-trace.ts";
import { isWallChar } from "./tile-semantics.ts";

export interface CounterfactualBudget {
  readonly maxProbes: number;
  readonly maxStatesPerProbe: number;
  readonly maxTotalStates: number;
  readonly maxElapsedMs: number;
  readonly minDelayedPushes: number;
}

export const DEFAULT_COUNTERFACTUAL_BUDGET: CounterfactualBudget = Object.freeze({
  maxProbes: 12,
  maxStatesPerProbe: 256,
  maxTotalStates: 2048,
  maxElapsedMs: 100,
  minDelayedPushes: 2,
});

/** "solved" means the query has a witness; freeze-enabler only asks for a target push. */
export type CounterfactualOutcome = "solved" | "exhausted" | "unknown";
export type CounterfactualProbeKind = "alternative-push" | "preserve-goal" | "freeze-enabler";
export type CounterfactualClassification = "recoverable-alternative" | "reconvergent-detour"
  | "delayed-false-start" | "immediate-dead-end" | "dead-end" | "necessary" | "optional" | "unknown";

export interface CounterfactualState {
  readonly robot: TracePosition;
  /** Initial row-major box identity is preserved, even for generic boxes. */
  readonly boxes: readonly TracePosition[];
}

export interface CounterfactualProbeEvidence {
  readonly id: string;
  readonly kind: CounterfactualProbeKind;
  readonly checkpointPushIndex: number;
  readonly state: CounterfactualState;
  readonly boxId: number;
  readonly targetBoxId?: number;
  readonly goalId?: string;
  readonly alternative?: TracePushOption;
  readonly plausible: boolean;
  readonly outcome: CounterfactualOutcome;
  readonly classification: CounterfactualClassification;
  readonly stopReason: "witness" | "exhausted" | "static-dead-square" | "state-budget"
    | "total-state-budget" | "time-budget" | "aborted";
  readonly expandedStates: number;
  readonly visitedStates: number;
  readonly nonDeadContinuationPushes: number;
  readonly alternativeBoxContinuationPushes: number;
  readonly continuationWitness: readonly TracePushOption[];
  /** A legal push witness from state, including the alternative when present. */
  readonly witness: readonly TracePushOption[];
  readonly explanation: string;
}

export interface CounterfactualStoryProfile {
  readonly version: 1;
  readonly boardHash: string;
  readonly budget: CounterfactualBudget;
  readonly probes: readonly CounterfactualProbeEvidence[];
  readonly eligibleProbes: number;
  readonly omittedProbes: number;
  readonly expandedStates: number;
  readonly recoverableAlternatives: number;
  readonly reconvergentDetours: number;
  readonly delayedFalseStarts: number;
  readonly immediateDeadEnds: number;
  readonly necessaryDependencies: number;
  readonly optionalDependencies: number;
  readonly unknownProbes: number;
}

interface Probe {
  kind: CounterfactualProbeKind;
  checkpointPushIndex: number;
  state: CounterfactualState;
  boxId: number;
  targetBoxId?: number;
  goalId?: string;
  alternative?: TracePushOption;
  plausible: boolean;
}

function key(position: TracePosition): string {
  return `${position.row},${position.column}`;
}

function pushState(state: CounterfactualState, push: TracePushOption): CounterfactualState {
  const boxes = [...state.boxes];
  boxes[push.boxId] = push.destination;
  return { robot: state.boxes[push.boxId], boxes };
}

/** Static reverse-push distances: a sound dead-square test, not a solvability test. */
function goalDistances(
  grid: readonly (readonly string[])[],
  goals: readonly TracePosition[],
): ReadonlyMap<string, number> {
  const result = new Map(goals.map((goal) => [key(goal), 0]));
  const queue = [...goals];
  const floor = (row: number, column: number) => row >= 0 && row < grid.length &&
    column >= 0 && column < grid[row].length && !isWallChar(grid[row][column]);
  for (let head = 0; head < queue.length; head++) {
    const position = queue[head];
    for (const direction of DIRECTIONS) {
      const delta = directionDelta(direction);
      const from = { row: position.row - delta.row, column: position.column - delta.column };
      if (!floor(from.row, from.column) || !floor(from.row - delta.row, from.column - delta.column) ||
        result.has(key(from))) continue;
      result.set(key(from), result.get(key(position))! + 1);
      queue.push(from);
    }
  }
  return result;
}

function collectProbes(
  trace: CanonicalSolutionTrace,
  distances: readonly ReadonlyMap<string, number>[],
): Probe[] {
  let state: CounterfactualState = {
    robot: trace.initialRobot,
    boxes: trace.boxes.map((box) => box.initialPosition),
  };
  const alternatives: Probe[] = [];
  const dependencies: Probe[] = [];
  const seen = new Set<string>();
  for (const push of trace.pushes) {
    state = { ...state, robot: push.keeperSupport };
    // The checkpoint is immediately before this push, after its keeper walk.
    for (const alternative of push.reachablePushesBefore) {
      if (alternative.boxId === push.boxId && alternative.direction === push.direction) continue;
      const fromDistance = distances[alternative.boxId].get(key(state.boxes[alternative.boxId]));
      const toDistance = distances[alternative.boxId].get(key(alternative.destination));
      alternatives.push({
        kind: "alternative-push", checkpointPushIndex: push.pushIndex, state,
        boxId: alternative.boxId, alternative,
        plausible: toDistance !== undefined && fromDistance !== undefined && toDistance < fromDistance,
      });
    }
    if (push.goalBefore && push.fromGoalMatched) {
      const id = `goal:${push.boxId}:${push.goalBefore}`;
      if (!seen.has(id)) {
        seen.add(id);
        dependencies.push({
          kind: "preserve-goal", checkpointPushIndex: push.pushIndex, state,
          boxId: push.boxId, goalId: push.goalBefore, plausible: true,
        });
      }
    }
    for (const targetBoxId of push.enabledBoxIds) {
      if (push.reachablePushesBefore.some((option) => option.boxId === targetBoxId)) continue;
      const id = `enable:${push.boxId}:${targetBoxId}`;
      if (seen.has(id)) continue;
      seen.add(id);
      dependencies.push({
        kind: "freeze-enabler", checkpointPushIndex: push.pushIndex, state,
        boxId: push.boxId, targetBoxId, plausible: true,
      });
    }
    state = pushState(state, {
      boxId: push.boxId, direction: push.direction,
      support: push.keeperSupport, destination: push.to,
    });
  }
  // Round-robin families and spread alternatives across the complete solution.
  // This avoids spending every probe on the first few pushes of a long puzzle.
  const plausible = alternatives.filter((probe) => probe.plausible);
  const other = alternatives.filter((probe) => !probe.plausible);
  const spread = (items: Probe[]) => {
    const result: Probe[] = [];
    const intervals = [[0, items.length - 1]];
    for (let index = 0; index < intervals.length; index++) {
      const [left, right] = intervals[index];
      if (left > right) continue;
      const middle = Math.floor((left + right) / 2);
      result.push(items[middle]);
      intervals.push([left, middle - 1], [middle + 1, right]);
    }
    return result;
  };
  const families = [dependencies, spread(plausible), spread(other)];
  const result: Probe[] = [];
  for (let index = 0; families.some((family) => index < family.length); index++) {
    for (const family of families) if (family[index]) result.push(family[index]);
  }
  return result;
}

interface SearchNode {
  state: CounterfactualState;
  parent: number;
  push?: TracePushOption;
  depth: number;
  alternativeBoxPushes: number;
}

interface SearchResult {
  outcome: CounterfactualOutcome;
  stopReason: CounterfactualProbeEvidence["stopReason"];
  expandedStates: number;
  visitedStates: number;
  nonDeadContinuationPushes: number;
  alternativeBoxContinuationPushes: number;
  continuationWitness: readonly TracePushOption[];
  witness: readonly TracePushOption[];
  finalState?: CounterfactualState;
}

function search(
  grid: readonly (readonly string[])[],
  trace: CanonicalSolutionTrace,
  probe: Probe,
  distances: readonly ReadonlyMap<string, number>[],
  budget: CounterfactualBudget,
  total: { expanded: number },
  interrupted: () => "time-budget" | "aborted" | undefined,
): SearchResult {
  const initial = probe.alternative ? pushState(probe.state, probe.alternative) : probe.state;
  const nodes: SearchNode[] = [{ state: initial, parent: -1, depth: 0, alternativeBoxPushes: 0 }];
  const seen = new Set<string>();
  let expandedStates = 0;
  let continuationDepth = 0;
  let deepestNode = 0;
  let frontierTruncated = false;
  const result = (
    outcome: CounterfactualOutcome,
    stopReason: SearchResult["stopReason"],
    witness: readonly TracePushOption[] = [],
    finalState?: CounterfactualState,
  ): SearchResult => ({
    outcome, stopReason, expandedStates, visitedStates: seen.size,
    nonDeadContinuationPushes: continuationDepth,
    alternativeBoxContinuationPushes: nodes[deepestNode].alternativeBoxPushes,
    continuationWitness: continuationDepth > 0 ? witnessTo(deepestNode) : [], witness,
    ...(finalState !== undefined && { finalState }),
  });
  const stateKey = (state: CounterfactualState) => {
    const reachable = floodKeeperReachable(grid, state.robot, new Set(state.boxes.map(key)));
    let region = Infinity;
    for (const cell of reachable) {
      const [row, column] = cell.split(",").map(Number);
      region = Math.min(region, row * trace.boardWidth + column);
    }
    return `${state.boxes.map(key).join(";")}|${region}`;
  };
  const staticDead = (state: CounterfactualState) => state.boxes.some((box, id) =>
    !distances[id].has(key(box)));
  const goalsByCell = new Map(trace.goals.map((goal) => [key(goal.position), goal]));
  const solved = (state: CounterfactualState) => state.boxes.length === trace.goals.length &&
    state.boxes.every((position, id) => {
      const goal = goalsByCell.get(key(position));
      const box = trace.boxes[id];
      return goal && box.kind === goal.kind && box.label?.toLowerCase() === goal.label;
    });
  const witnessTo = (index: number): TracePushOption[] => {
    const pushes: TracePushOption[] = [];
    for (let current = index; nodes[current].parent >= 0; current = nodes[current].parent) {
      pushes.push(nodes[current].push!);
    }
    pushes.reverse();
    return probe.alternative ? [probe.alternative, ...pushes] : pushes;
  };
  const stop = interrupted();
  if (stop) return result("unknown", stop);
  if (budget.maxStatesPerProbe === 0) return result("unknown", "state-budget");
  // Local reachability queries must NOT prune states just because the whole
  // puzzle has become unsolvable: the beneficiary may still be movable there.
  if (probe.kind !== "freeze-enabler" && staticDead(initial)) {
    return result("exhausted", "static-dead-square");
  }
  seen.add(stateKey(initial));
  for (let head = 0; head < nodes.length; head++) {
    const interruption = interrupted();
    if (interruption) return result("unknown", interruption);
    const node = nodes[head];
    if (solved(node.state)) {
      if (probe.kind !== "freeze-enabler") return result("solved", "witness", witnessTo(head), node.state);
      continue;
    }
    if (expandedStates >= budget.maxStatesPerProbe) return result("unknown", "state-budget");
    if (total.expanded >= budget.maxTotalStates) return result("unknown", "total-state-budget");
    expandedStates++;
    total.expanded++;
    const options = enumerateReachablePushes(grid, node.state.robot, node.state.boxes);
    for (const option of options) {
      if (probe.kind !== "alternative-push" && option.boxIndex === probe.boxId) continue;
      const push: TracePushOption = {
        boxId: option.boxIndex, direction: option.direction,
        support: option.support, destination: option.destination,
      };
      if (probe.kind === "freeze-enabler" && option.boxIndex === probe.targetBoxId) {
        return result("solved", "witness", [...witnessTo(head), push]);
      }
      const next = pushState(node.state, push);
      if (probe.kind !== "freeze-enabler" && staticDead(next)) continue;
      const signature = stateKey(next);
      if (seen.has(signature)) continue;
      if (nodes.length >= budget.maxStatesPerProbe) {
        frontierTruncated = true;
        continue;
      }
      seen.add(signature);
      const alternativeBoxPushes = node.alternativeBoxPushes + (push.boxId === probe.boxId ? 1 : 0);
      nodes.push({ state: next, parent: head, push, depth: node.depth + 1, alternativeBoxPushes });
      if (alternativeBoxPushes > nodes[deepestNode].alternativeBoxPushes ||
        (alternativeBoxPushes === nodes[deepestNode].alternativeBoxPushes && node.depth + 1 > continuationDepth)) {
        continuationDepth = node.depth + 1;
        deepestNode = nodes.length - 1;
      }
    }
  }
  return frontierTruncated ? result("unknown", "state-budget") : result("exhausted", "exhausted");
}

function classification(
  probe: Probe, result: SearchResult, minDelay: number,
  trace: CanonicalSolutionTrace,
): CounterfactualClassification {
  if (result.outcome === "unknown") return "unknown";
  if (probe.kind !== "alternative-push") return result.outcome === "solved" ? "optional" : "necessary";
  if (result.outcome === "solved") {
    if (result.finalState) {
      const sameAssignment = result.finalState.boxes.every((position, id) => {
        const original = trace.boxes[id];
        return original.finalPosition.row === position.row && original.finalPosition.column === position.column;
      });
      if (sameAssignment) return "reconvergent-detour";
    }
    return "recoverable-alternative";
  }
  if (result.stopReason === "static-dead-square") return "immediate-dead-end";
  return probe.plausible && result.alternativeBoxContinuationPushes >= minDelay
    ? "delayed-false-start" : "dead-end";
}

function explain(probe: Probe, result: SearchResult, label: CounterfactualClassification): string {
  const where = `Before push ${probe.checkpointPushIndex + 1}`;
  if (label === "unknown") return `${where}: ${probe.kind} is unknown (${result.stopReason}); no necessity or dead-end claim.`;
  if (probe.kind === "freeze-enabler") {
    return `${where}: moving box ${probe.boxId} is ${label} for enabling a push of box ${probe.targetBoxId}; ${result.outcome === "exhausted" ? "constrained state space exhausted" : "bypass push witness found"}.`;
  }
  if (probe.kind === "preserve-goal") {
    return `${where}: vacating ${probe.goalId} with box ${probe.boxId} is ${label} for solving from this checkpoint; ${result.outcome === "exhausted" ? "constrained state space exhausted" : "solution keeping that box fixed found"}.`;
  }
  return `${where}: box ${probe.boxId} ${probe.alternative!.direction} is ${label}; ${result.outcome === "solved" ? "legal recovery solution found" : `${result.alternativeBoxContinuationPushes} further pushes of this box explored without a static dead square`}.`;
}

/** Bounded diagnostic searches; never an acceptance or tier-classification input. */
export function analyzeCounterfactualStory(
  grid: readonly (readonly string[])[],
  trace: CanonicalSolutionTrace,
  options: Partial<CounterfactualBudget> = {},
  context: { readonly signal?: AbortSignal; readonly now?: () => number } = {},
): CounterfactualStoryProfile {
  if (!trace.solved || boardHash(grid.map((row) => row.join(""))) !== trace.boardHash) {
    throw new Error("Counterfactual analysis requires a solved trace of the exact final board");
  }
  const budget = Object.freeze({ ...DEFAULT_COUNTERFACTUAL_BUDGET, ...options });
  for (const [name, value] of Object.entries(budget)) {
    if (!Number.isFinite(value) || value < 0 || (name !== "maxElapsedMs" && !Number.isInteger(value))) {
      throw new Error(`Invalid counterfactual budget: ${name}`);
    }
  }
  if (budget.minDelayedPushes < 2) throw new Error("Delayed false starts require at least two continuation pushes");
  const now = context.now ?? (() => performance.now());
  const start = now();
  const interrupted = () => context.signal?.aborted ? "aborted" as const
    : now() - start >= budget.maxElapsedMs ? "time-budget" as const : undefined;
  const distancesByClass = new Map<string, ReadonlyMap<string, number>>();
  const distances = trace.boxes.map((box) => {
    const classKey = `${box.kind}:${box.label ?? ""}`;
    let distance = distancesByClass.get(classKey);
    if (!distance) {
      distance = goalDistances(grid, trace.goals
        .filter((goal) => box.kind === goal.kind && box.label?.toLowerCase() === goal.label)
        .map((goal) => goal.position));
      distancesByClass.set(classKey, distance);
    }
    return distance;
  });
  const eligible = collectProbes(trace, distances);
  const total = { expanded: 0 };
  const probes = eligible.slice(0, budget.maxProbes).map((probe, index): CounterfactualProbeEvidence => {
    const result = search(grid, trace, probe, distances, budget, total, interrupted);
    const label = classification(probe, result, budget.minDelayedPushes, trace);
    return Object.freeze({
      ...probe, ...result, id: `counterfactual-${index}`, classification: label,
      explanation: explain(probe, result, label),
      state: Object.freeze({ robot: probe.state.robot, boxes: Object.freeze([...probe.state.boxes]) }),
      witness: Object.freeze([...result.witness]),
      continuationWitness: Object.freeze([...result.continuationWitness]),
    });
  });
  const count = (label: CounterfactualClassification) => probes.filter((probe) => probe.classification === label).length;
  return Object.freeze({
    version: 1, boardHash: trace.boardHash, budget, probes: Object.freeze(probes),
    eligibleProbes: eligible.length, omittedProbes: eligible.length - probes.length,
    expandedStates: total.expanded,
    recoverableAlternatives: count("recoverable-alternative"), reconvergentDetours: count("reconvergent-detour"),
    delayedFalseStarts: count("delayed-false-start"),
    immediateDeadEnds: count("immediate-dead-end"), necessaryDependencies: count("necessary"),
    optionalDependencies: count("optional"), unknownProbes: count("unknown"),
  });
}
