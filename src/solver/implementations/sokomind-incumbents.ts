import type { SolverSolution } from "../contracts.ts";

export interface DiversitySignature {
  readonly moves: number;
  readonly pushes: number;
  readonly pushChainHash: string;
  readonly boxGoalHash: string;
  /** Exact canonical keys keep hash collisions from collapsing distinct plans. */
  readonly pushChainKey: string;
  readonly boxGoalKey: string;
}

/**
 * Replay-derived semantics supplied by the adapter. The fallback signature is
 * still useful to callers that only have a SolverSolution, but quality-mode
 * harvesting uses actual box identities, pushes, and final goal assignments.
 */
export interface SemanticDiversityTrace {
  readonly pushChain: string;
  readonly boxGoals: string;
}

export interface HarvestedIncumbent {
  readonly solution: SolverSolution;
  readonly signature: DiversitySignature;
  readonly discoveryOrder: number;
}

export function isSolutionBetter(
  candidate: SolverSolution,
  incumbent: SolverSolution,
): boolean {
  return (
    candidate.moves < incumbent.moves ||
    (candidate.moves === incumbent.moves && candidate.pushes < incumbent.pushes)
  );
}

export function computeDiversitySignature(
  solution: SolverSolution,
  semanticTrace?: SemanticDiversityTrace,
): DiversitySignature {
  const pushParts: string[] = [];
  let pushIndex = 0;
  for (const step of solution.steps) {
    if (step.kind === "push") {
      pushParts.push(`${pushIndex}:${step.direction}`);
      pushIndex++;
    }
  }
  const pushChainKey = semanticTrace?.pushChain ?? pushParts.join(";");
  const pushChainHash = simpleHash(pushChainKey);

  const goalParts: string[] = [];
  let dirAccum = "";
  for (const step of solution.steps) {
    dirAccum += step.direction[0];
    if (step.kind === "push") {
      goalParts.push(dirAccum);
      dirAccum = "";
    }
  }
  const boxGoalKey = semanticTrace?.boxGoals ?? goalParts.join("|");
  const boxGoalHash = simpleHash(boxGoalKey);

  return {
    moves: solution.moves,
    pushes: solution.pushes,
    pushChainHash,
    boxGoalHash,
    pushChainKey,
    boxGoalKey,
  };
}

export function isDiverse(
  sig: DiversitySignature,
  existing: readonly DiversitySignature[],
): boolean {
  for (const e of existing) {
    if (sig.pushChainKey === e.pushChainKey && sig.boxGoalKey === e.boxGoalKey) {
      return false;
    }
  }
  return true;
}

function simpleHash(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) - h + input.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

export function computeHarvestMs(
  configuredMs: number,
  requestTimeMs: number | undefined,
): number {
  let harvestMs = configuredMs;
  if (requestTimeMs !== undefined && Number.isFinite(requestTimeMs)) {
    harvestMs = Math.min(harvestMs, Math.floor(requestTimeMs * 0.1));
  }
  return Math.max(harvestMs, 500);
}

const REWRITE_CAP = 3;

export function selectForRewrite(
  incumbents: readonly HarvestedIncumbent[],
): readonly HarvestedIncumbent[] {
  if (incumbents.length <= 1) return incumbents.slice(0, REWRITE_CAP);

  // Keep the best route, then prefer a different box-to-goal assignment before
  // filling the remaining slot with a different push chain. This gives rewrite
  // genuinely different basins instead of three cosmetically different walks.
  const remaining = [...incumbents.slice(1)];
  const selected = [incumbents[0]];
  while (selected.length < REWRITE_CAP && remaining.length) {
    let bestIndex = 0;
    let bestNovelty = -1;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      const novelty = selected.reduce((score, chosen) =>
        score +
          (candidate.signature.boxGoalKey === chosen.signature.boxGoalKey ? 0 : 4) +
          (candidate.signature.pushChainKey === chosen.signature.pushChainKey ? 0 : 1), 0);
      if (novelty > bestNovelty) {
        bestNovelty = novelty;
        bestIndex = index;
      }
    }
    selected.push(remaining.splice(bestIndex, 1)[0]);
  }
  return selected;
}

export function selectBest(
  candidates: readonly { solution: SolverSolution; discoveryOrder: number }[],
): SolverSolution {
  let best = candidates[0];
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i];
    if (
      isSolutionBetter(c.solution, best.solution) ||
      (c.solution.moves === best.solution.moves &&
        c.solution.pushes === best.solution.pushes &&
        c.discoveryOrder < best.discoveryOrder)
    ) {
      best = c;
    }
  }
  return best.solution;
}

export class IncumbentCollector {
  readonly #limit: number;
  #items: HarvestedIncumbent[] = [];
  #nextOrder = 0;
  readonly stats = { offered: 0, accepted: 0, duplicatesRejected: 0 };

  constructor(maximumIncumbents: number) {
    this.#limit = maximumIncumbents;
  }

  offer(
    solution: SolverSolution,
    semanticTrace?: SemanticDiversityTrace,
  ): boolean {
    this.stats.offered++;
    const sig = computeDiversitySignature(solution, semanticTrace);
    const duplicateIndex = this.#items.findIndex(({ signature }) =>
      sig.pushChainKey === signature.pushChainKey &&
      sig.boxGoalKey === signature.boxGoalKey);
    if (duplicateIndex >= 0) {
      const duplicate = this.#items[duplicateIndex];
      if (!isSolutionBetter(solution, duplicate.solution)) {
        this.stats.duplicatesRejected++;
        return false;
      }
      // Semantic diversity deliberately ignores cosmetic keeper walking. Keep
      // that de-duplication, but never let it discard a shorter realization of
      // the same push plan and box-to-goal assignment.
      this.#items[duplicateIndex] = {
        solution,
        signature: sig,
        discoveryOrder: duplicate.discoveryOrder,
      };
      this.#sort();
      this.stats.accepted++;
      return true;
    }

    if (this.#items.length >= this.#limit) {
      const worst = this.#items[this.#items.length - 1];
      if (!isSolutionBetter(solution, worst.solution)) {
        return false;
      }
      this.#items.pop();
    }

    const incumbent: HarvestedIncumbent = {
      solution,
      signature: sig,
      discoveryOrder: this.#nextOrder++,
    };
    this.#items.push(incumbent);
    this.#sort();
    this.stats.accepted++;
    return true;
  }

  #sort(): void {
    this.#items.sort((a, b) => {
      if (a.solution.moves !== b.solution.moves) return a.solution.moves - b.solution.moves;
      if (a.solution.pushes !== b.solution.pushes) return a.solution.pushes - b.solution.pushes;
      return a.discoveryOrder - b.discoveryOrder;
    });
  }

  get incumbents(): readonly HarvestedIncumbent[] {
    return this.#items;
  }

  get best(): HarvestedIncumbent | undefined {
    return this.#items[0];
  }
}
