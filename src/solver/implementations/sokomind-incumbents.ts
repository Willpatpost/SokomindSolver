import type { SolverSolution } from "../contracts.ts";

export interface DiversitySignature {
  readonly moves: number;
  readonly pushes: number;
  readonly pushChainHash: string;
  readonly boxGoalHash: string;
}

export interface HarvestedIncumbent {
  readonly solution: SolverSolution;
  readonly signature: DiversitySignature;
  readonly discoveryOrder: number;
}

export function computeDiversitySignature(
  solution: SolverSolution,
): DiversitySignature {
  const pushParts: string[] = [];
  let pushIndex = 0;
  for (const step of solution.steps) {
    if (step.kind === "push") {
      pushParts.push(`${pushIndex}:${step.direction}`);
      pushIndex++;
    }
  }
  const pushChainHash = simpleHash(pushParts.join(";"));

  const goalParts: string[] = [];
  let dirAccum = "";
  for (const step of solution.steps) {
    dirAccum += step.direction[0];
    if (step.kind === "push") {
      goalParts.push(dirAccum);
      dirAccum = "";
    }
  }
  const boxGoalHash = simpleHash(goalParts.join("|"));

  return {
    moves: solution.moves,
    pushes: solution.pushes,
    pushChainHash,
    boxGoalHash,
  };
}

export function isDiverse(
  sig: DiversitySignature,
  existing: readonly DiversitySignature[],
): boolean {
  for (const e of existing) {
    if (sig.pushChainHash === e.pushChainHash && sig.boxGoalHash === e.boxGoalHash) {
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
  return incumbents.slice(0, REWRITE_CAP);
}

export function selectBest(
  candidates: readonly { solution: SolverSolution; discoveryOrder: number }[],
): SolverSolution {
  let best = candidates[0];
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i];
    if (
      c.solution.moves < best.solution.moves ||
      (c.solution.moves === best.solution.moves &&
        c.solution.pushes < best.solution.pushes) ||
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

  offer(solution: SolverSolution): boolean {
    this.stats.offered++;
    const sig = computeDiversitySignature(solution);
    const existingSigs = this.#items.map((i) => i.signature);

    if (!isDiverse(sig, existingSigs)) {
      this.stats.duplicatesRejected++;
      return false;
    }

    if (this.#items.length >= this.#limit) {
      const worst = this.#items[this.#items.length - 1];
      if (
        solution.moves > worst.solution.moves ||
        (solution.moves === worst.solution.moves &&
          solution.pushes >= worst.solution.pushes)
      ) {
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
    this.#items.sort((a, b) => {
      if (a.solution.moves !== b.solution.moves) return a.solution.moves - b.solution.moves;
      if (a.solution.pushes !== b.solution.pushes) return a.solution.pushes - b.solution.pushes;
      return a.discoveryOrder - b.discoveryOrder;
    });
    this.stats.accepted++;
    return true;
  }

  get incumbents(): readonly HarvestedIncumbent[] {
    return this.#items;
  }

  get best(): HarvestedIncumbent | undefined {
    return this.#items[0];
  }
}
