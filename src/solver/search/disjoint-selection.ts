import type { HeuristicCandidate } from "./room-pattern-heuristic.ts";

const EXACT_DP_LABEL_LIMIT = 20;

/**
 * Select maximum-weight label-disjoint subset of candidates.
 *
 * No two selected candidates share a label, ensuring each box contributes
 * to at most one boost — preserving admissibility.
 *
 * Uses exact bitmask DP for ≤20 labels, greedy fallback otherwise.
 */
export function maximumDisjointSelection(
  candidates: readonly HeuristicCandidate[],
): readonly HeuristicCandidate[] {
  if (candidates.length === 0) return [];

  const labels = [
    ...new Set(candidates.flatMap((c) => [...c.labels])),
  ];

  if (labels.length > EXACT_DP_LABEL_LIMIT) {
    return greedySelection(candidates);
  }

  return exactBitmaskDp(candidates, labels);
}

function exactBitmaskDp(
  candidates: readonly HeuristicCandidate[],
  labels: string[],
): readonly HeuristicCandidate[] {
  const labelIndex = new Map<string, number>();
  labels.forEach((label, i) => labelIndex.set(label, i));

  const weighted = candidates.map((candidate) => {
    let mask = 0;
    for (const label of candidate.labels) {
      mask |= 1 << labelIndex.get(label)!;
    }
    return { candidate, mask };
  });

  const best = new Map<number, { boost: number; selected: HeuristicCandidate[] }>();
  best.set(0, { boost: 0, selected: [] });

  for (const { candidate, mask } of weighted) {
    for (const [used, entry] of [...best]) {
      if (used & mask) continue;
      const combined = used | mask;
      const boost = entry.boost + candidate.boost;
      if ((best.get(combined)?.boost ?? -Infinity) >= boost) continue;
      best.set(combined, {
        boost,
        selected: [...entry.selected, candidate],
      });
    }
  }

  let bestEntry = { boost: -Infinity, selected: [] as HeuristicCandidate[] };
  for (const entry of best.values()) {
    if (entry.boost > bestEntry.boost) bestEntry = entry;
  }
  return bestEntry.selected;
}

function greedySelection(
  candidates: readonly HeuristicCandidate[],
): readonly HeuristicCandidate[] {
  const sorted = [...candidates].sort((a, b) => b.boost - a.boost);
  const used = new Set<string>();
  const selected: HeuristicCandidate[] = [];

  for (const candidate of sorted) {
    let conflicts = false;
    for (const label of candidate.labels) {
      if (used.has(label)) {
        conflicts = true;
        break;
      }
    }
    if (conflicts) continue;
    selected.push(candidate);
    for (const label of candidate.labels) used.add(label);
  }

  return selected;
}
