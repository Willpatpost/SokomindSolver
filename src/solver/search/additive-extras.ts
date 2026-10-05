// Shared exact-search heuristic: h = A + extra + W, clamped to MAX_STORED_H.
//
// A is the assignment push bound and W the walking bound. `extra` is the
// largest of linear conflict, interaction boost, PDB surplus and goal cut,
// raised when possible by one label-disjoint sum of their parts:
//
// - a label's PDB surplus: its PDB total less its assignment cost;
// - a room or pair boost candidate, over the candidate's labels;
// - a linear-conflict pair (2), over its two labels, and a connected group of
//   pairs (2 per pair), over all their labels.
//
// Let e_L be the pushes of label L's boxes beyond L's assignment cost in an
// optimal solution. Each label's boxes and goals are equal in number, so the
// e_L are non-negative and sum to the pushes beyond A. Each part is at most
// the sum of e_L over its labels, so parts with pairwise disjoint labels add
// up to at most the pushes beyond A, and the sum stays admissible. Goal cut
// has no label attribution, so it only enters the max.
//
// The backward perimeter, component PDB and move-cost PDB bounds are applied
// afterwards, each only by max, as before.

import type { BackwardPerimeterTable } from "./backward-perimeter.ts";
import type { ComponentPdbCollection } from "./component-pdb.ts";
import type {
  ExactSearchFeatures,
  ExactSearchFeatureTelemetry,
} from "./exact-search-features.ts";
import type { GoalCutEvaluator } from "./goal-cut.ts";
import type { AssignmentHeuristic, PdbHeuristicEvaluator } from "./heuristic.ts";
import type { InteractionBoostEvaluator } from "./interaction-boost.ts";
import type { DenseBox } from "./model.ts";
import type { MoveCostPatternCollection } from "./move-cost-pattern-pdb.ts";
import type { ZobristTable } from "./zobrist-state.ts";

/** Largest finite h the kernels keep; larger finite values are lowered to it. */
export const MAX_STORED_H = 65_535;

const EXACT_LABEL_LIMIT = 20;

/**
 * Best label-disjoint sum of per-label surplus terms and candidates. A
 * candidate replaces the surplus of its labels, so its weight is its value
 * less that surplus. Exact for up to 20 candidate labels, greedy above.
 */
export class DisjointExtraSelector {
  readonly #labelIds = new Map<string, number>();
  readonly #surplus: number[] = [];
  readonly #values: number[] = [];
  readonly #starts: number[] = [0];
  readonly #labels: number[] = [];
  readonly #bits: number[] = [];
  readonly #kept: number[] = [];
  readonly #weights: number[] = [];
  readonly #dpMasks: number[] = [];
  readonly #dpValues: number[] = [];
  readonly #dpIndex = new Map<number, number>();

  reset(): void {
    this.#labelIds.clear();
    this.#surplus.length = 0;
    this.#values.length = 0;
    this.#starts.length = 1;
    this.#labels.length = 0;
  }

  addSurplus(label: string, value: number): void {
    this.#surplus[this.#id(label)] += value;
  }

  /** `labels` must not repeat a label. */
  addCandidate(labels: Iterable<string>, value: number): void {
    for (const label of labels) this.#labels.push(this.#id(label));
    this.#values.push(value);
    this.#starts.push(this.#labels.length);
  }

  best(): number {
    let total = 0;
    for (const value of this.#surplus) total += value;

    const kept = this.#kept;
    const weights = this.#weights;
    const bits = this.#bits;
    kept.length = 0;
    weights.length = 0;
    bits.length = this.#surplus.length;
    bits.fill(-1);
    let bitCount = 0;
    for (let c = 0; c < this.#values.length; c++) {
      let weight = this.#values[c];
      for (let i = this.#starts[c]; i < this.#starts[c + 1]; i++) {
        weight -= this.#surplus[this.#labels[i]];
      }
      if (weight <= 0) continue;
      kept.push(c);
      weights.push(weight);
      for (let i = this.#starts[c]; i < this.#starts[c + 1]; i++) {
        const id = this.#labels[i];
        if (bits[id] < 0) bits[id] = bitCount++;
      }
    }
    if (kept.length === 0) return total;
    return total + (bitCount <= EXACT_LABEL_LIMIT ? this.#exact() : this.#greedy());
  }

  #id(label: string): number {
    let id = this.#labelIds.get(label);
    if (id === undefined) {
      id = this.#labelIds.size;
      this.#labelIds.set(label, id);
      this.#surplus.push(0);
    }
    return id;
  }

  #mask(c: number): number {
    let mask = 0;
    for (let i = this.#starts[c]; i < this.#starts[c + 1]; i++) {
      mask |= 1 << this.#bits[this.#labels[i]];
    }
    return mask;
  }

  // 0/1 knapsack over label masks, keeping only the best value per mask.
  #exact(): number {
    const masks = this.#dpMasks;
    const values = this.#dpValues;
    const index = this.#dpIndex;
    masks.length = 0;
    values.length = 0;
    index.clear();
    masks.push(0);
    values.push(0);
    index.set(0, 0);
    let best = 0;
    for (let k = 0; k < this.#kept.length; k++) {
      const mask = this.#mask(this.#kept[k]);
      const weight = this.#weights[k];
      const size = masks.length;
      for (let i = 0; i < size; i++) {
        if (masks[i] & mask) continue;
        const combined = masks[i] | mask;
        const value = values[i] + weight;
        const j = index.get(combined);
        if (j === undefined) {
          index.set(combined, masks.length);
          masks.push(combined);
          values.push(value);
        } else if (value > values[j]) {
          values[j] = value;
        }
        if (value > best) best = value;
      }
    }
    return best;
  }

  #greedy(): number {
    const order = this.#kept.map((_, k) => k);
    order.sort((a, b) => this.#weights[b] - this.#weights[a] || a - b);
    const used = new Uint8Array(this.#surplus.length);
    let sum = 0;
    for (const k of order) {
      const c = this.#kept[k];
      let free = true;
      for (let i = this.#starts[c]; i < this.#starts[c + 1] && free; i++) {
        if (used[this.#labels[i]]) free = false;
      }
      if (!free) continue;
      for (let i = this.#starts[c]; i < this.#starts[c + 1]; i++) used[this.#labels[i]] = 1;
      sum += this.#weights[k];
    }
    return sum;
  }
}

/**
 * Adds linear-conflict pairs, given flat as [label, label, ...], and every
 * connected group of two or more pairs, worth 2 per pair over its labels.
 */
export function addLinearConflictCandidates(
  selector: DisjointExtraSelector,
  pairs: readonly string[],
): void {
  const count = pairs.length >> 1;
  const parent = Array.from({ length: count }, (_, p) => p);
  const find = (p: number): number => {
    while (parent[p] !== p) p = parent[p] = parent[parent[p]];
    return p;
  };
  const firstPair = new Map<string, number>();
  for (let i = 0; i < pairs.length; i++) {
    const p = i >> 1;
    const q = firstPair.get(pairs[i]);
    if (q === undefined) firstPair.set(pairs[i], p);
    else parent[find(p)] = find(q);
  }
  const groups = new Map<number, { labels: Set<string>; pairs: number }>();
  for (let p = 0; p < count; p++) {
    selector.addCandidate([pairs[2 * p], pairs[2 * p + 1]], 2);
    const root = find(p);
    let group = groups.get(root);
    if (!group) {
      group = { labels: new Set(), pairs: 0 };
      groups.set(root, group);
    }
    group.labels.add(pairs[2 * p]).add(pairs[2 * p + 1]);
    group.pairs += 1;
  }
  for (const group of groups.values()) {
    if (group.pairs >= 2) selector.addCandidate(group.labels, 2 * group.pairs);
  }
}

export interface ExactHeuristicDeps {
  readonly features: ExactSearchFeatures;
  readonly heuristic: AssignmentHeuristic;
  readonly zobristTable: ZobristTable;
  readonly boostEvaluator: InteractionBoostEvaluator | null;
  readonly pdbEvaluator: PdbHeuristicEvaluator | null;
  readonly goalCutEvaluator: GoalCutEvaluator | null;
  readonly perimeterTable: BackwardPerimeterTable | null;
  readonly componentPdbCollection: ComponentPdbCollection | null;
  readonly moveCostPdbCollection: MoveCostPatternCollection | null;
  readonly telemetry: ExactSearchFeatureTelemetry;
  readonly counters: { secondaryCutoffs: number; interactionBoostTotal: number };
}

export interface ExactHeuristicEvaluator {
  /**
   * h for a state whose push bound was just computed by the assignment
   * heuristic. Stops after the extras when g + h >= pruneAt, and then
   * `lastTruncated` is true and h may be below the full value.
   */
  evaluate(
    pushBound: number,
    walkBound: number,
    boxes: readonly DenseBox[],
    tokens: ArrayLike<number>,
    robotCell: number,
    boxKey: bigint,
    g: number,
    pruneAt: number,
  ): number;
  readonly lastTruncated: boolean;
  perimeterLookup(tokens: ArrayLike<number>, boxKey: bigint): number;
  componentPdbLookup(boxes: readonly DenseBox[]): number;
}

function clampH(h: number): number {
  return h > MAX_STORED_H && Number.isFinite(h) ? MAX_STORED_H : h;
}

export function createExactHeuristicEvaluator(
  deps: ExactHeuristicDeps,
): ExactHeuristicEvaluator {
  const {
    features,
    heuristic,
    zobristTable,
    boostEvaluator,
    pdbEvaluator,
    goalCutEvaluator,
    perimeterTable,
    componentPdbCollection,
    moveCostPdbCollection,
    telemetry,
    counters,
  } = deps;
  const selector = new DisjointExtraSelector();
  const linearConflictPairs: string[] = [];
  const componentPdbBoxesByLabel = new Map<string, number[]>();
  let lastTruncated = false;

  const perimeterLookup = (tokens: ArrayLike<number>, boxKey: bigint): number => {
    if (!perimeterTable) return 0;
    const boxZob = zobristTable.hashFromTokensNoRobot(tokens);
    return perimeterTable.lookup(boxZob, boxKey) ?? 0;
  };

  const componentPdbLookup = (boxes: readonly DenseBox[]): number => {
    if (!componentPdbCollection) return 0;
    componentPdbBoxesByLabel.clear();
    for (const box of boxes) {
      let cells = componentPdbBoxesByLabel.get(box.label);
      if (!cells) {
        cells = [];
        componentPdbBoxesByLabel.set(box.label, cells);
      }
      cells.push(box.cell);
    }
    return componentPdbCollection.evaluate(componentPdbBoxesByLabel);
  };

  // Only parts from extras that are positive on this state are read; their
  // evaluators were just called, so their last parts belong to this state.
  const additiveExtra = (lc: boolean, boost: boolean, pdb: boolean): number => {
    selector.reset();
    if (pdb) {
      const parts = pdbEvaluator!.lastSurplusParts;
      for (let i = 0; i < parts.length; i += 2) {
        selector.addSurplus(pdbEvaluator!.slotLabel(parts[i]), parts[i + 1]);
      }
    }
    if (boost) {
      for (const candidate of boostEvaluator!.lastCandidates) {
        if (candidate.boost > 0) selector.addCandidate(candidate.labels, candidate.boost);
      }
    }
    if (lc) addLinearConflictCandidates(selector, linearConflictPairs);
    return selector.best();
  };

  const evaluate = (
    pushBound: number,
    walkBound: number,
    boxes: readonly DenseBox[],
    tokens: ArrayLike<number>,
    robotCell: number,
    boxKey: bigint,
    g: number,
    pruneAt: number,
  ): number => {
    lastTruncated = false;
    const labelCosts = heuristic.lastLabelCosts;
    const labelCostsBoxKey = heuristic.lastBoxKey;
    let boost = 0;
    if (labelCosts && boostEvaluator) {
      boost = boostEvaluator.evaluate(boxes, labelCosts, boxKey, labelCostsBoxKey);
      if (boost > 0) counters.interactionBoostTotal += boost;
    }
    let lc = 0;
    linearConflictPairs.length = 0;
    if (features.linearConflict) {
      telemetry.linearConflictEvaluations += 1;
      lc = heuristic.lastLinearConflict(boxes, linearConflictPairs);
      telemetry.linearConflictTotal += lc;
    }
    let pdb = 0;
    if (pdbEvaluator && labelCosts) {
      telemetry.pdbEvaluations += 1;
      pdb = pdbEvaluator.evaluateWithSurplus(boxes, labelCosts, boxKey, labelCostsBoxKey);
    }
    let gc = 0;
    const states = goalCutEvaluator ? heuristic.lastAssignmentStates : null;
    if (goalCutEvaluator && states) {
      gc = goalCutEvaluator.evaluate(states);
      telemetry.goalCutEvaluations += 1;
      telemetry.goalCutTotal += gc;
    }

    let extra = Math.max(lc, boost, pdb, gc);
    let h = clampH(pushBound + extra + walkBound);
    if (g + h >= pruneAt) {
      counters.secondaryCutoffs++;
      lastTruncated = true;
      return h;
    }
    // With one positive source, the disjoint sum is at most that source.
    if (Number(lc > 0) + Number(boost > 0) + Number(pdb > 0) >= 2) {
      const additive = additiveExtra(lc > 0, boost > 0, pdb > 0);
      if (additive > extra) {
        telemetry.additiveExtraRaises += 1;
        telemetry.additiveExtraTotal += additive - extra;
        extra = additive;
        h = clampH(pushBound + extra + walkBound);
        if (g + h >= pruneAt) {
          counters.secondaryCutoffs++;
          lastTruncated = true;
          return h;
        }
      }
    }

    let totalPushBound = pushBound + extra;
    const perimeterDist = perimeterLookup(tokens, boxKey);
    if (perimeterDist > totalPushBound) {
      const improvement = perimeterDist - totalPushBound;
      telemetry.backwardPerimeterImprovements++;
      telemetry.backwardPerimeterTotalImprovement += improvement;
      if (improvement > telemetry.backwardPerimeterMaxImprovement) {
        telemetry.backwardPerimeterMaxImprovement = improvement;
      }
      totalPushBound = perimeterDist;
    }
    const componentBound = componentPdbLookup(boxes);
    if (componentBound > totalPushBound) {
      const improvement = componentBound - totalPushBound;
      telemetry.componentPdbImprovements++;
      telemetry.componentPdbTotalImprovement += improvement;
      if (improvement > telemetry.componentPdbMaxImprovement) {
        telemetry.componentPdbMaxImprovement = improvement;
      }
      totalPushBound = componentBound;
    }
    h = totalPushBound + walkBound;
    if (moveCostPdbCollection) {
      const mcBound = moveCostPdbCollection.evaluate(boxes, robotCell);
      if (mcBound > h) {
        const improvement = mcBound - h;
        telemetry.moveCostPdbImprovements++;
        telemetry.moveCostPdbTotalImprovement += improvement;
        if (improvement > telemetry.moveCostPdbMaxImprovement) {
          telemetry.moveCostPdbMaxImprovement = improvement;
        }
        h = mcBound;
      }
    }
    return clampH(h);
  };

  return {
    evaluate,
    get lastTruncated() {
      return lastTruncated;
    },
    perimeterLookup,
    componentPdbLookup,
  };
}
