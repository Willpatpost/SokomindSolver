import type { SolverSolution } from "../contracts.ts";
import {
  computeDiversitySignature,
  isSolutionBetter,
  type DiversitySignature,
  type SemanticDiversityTrace,
} from "./sokomind-incumbents.ts";

// ---------------------------------------------------------------------------
// Task outcome types
// ---------------------------------------------------------------------------

export type TaskEndReason =
  | "exhausted"
  | "completed-pass"
  | "time-cutoff"
  | "expanded-cutoff"
  | "generated-cutoff"
  | "memory-cutoff"
  | "cancelled"
  | "failed";

export type RepairOperator = "window" | "box";

export interface QualityTaskOutcome {
  readonly taskId: string;
  readonly reason: TaskEndReason;
  readonly operator: RepairOperator;
  readonly candidateId: string;
  readonly expanded: number;
  readonly generated: number;
  readonly elapsedMs: number;
  readonly improved: boolean;
}

// ---------------------------------------------------------------------------
// Neighborhood identity — scopes exhaustion to exact candidate+operator
// ---------------------------------------------------------------------------

export interface NeighborhoodKey {
  readonly candidateId: string;
  readonly operator: RepairOperator;
}

function neighborhoodKeyString(key: NeighborhoodKey): string {
  return `${key.candidateId}:${key.operator}`;
}

export interface NeighborhoodRecord {
  exhausted: boolean;
  completedPasses: number;
  totalExpanded: number;
  totalGenerated: number;
  totalElapsedMs: number;
  lastReason: TaskEndReason;
}

// ---------------------------------------------------------------------------
// Candidate provenance and archive entry
// ---------------------------------------------------------------------------

export interface CandidateProvenance {
  readonly sourceOperator: RepairOperator | "discovery" | "harvest";
  readonly parentCandidateId: string | undefined;
  readonly taskId: string | undefined;
  readonly acceptedAt: number;
}

export interface ArchivedCandidate {
  readonly id: string;
  readonly solution: SolverSolution;
  readonly signature: DiversitySignature;
  readonly provenance: CandidateProvenance;
  readonly discoveryOrder: number;
}

const ESTIMATED_CANDIDATE_OVERHEAD_BYTES = 512;

function estimateCandidateBytes(solution: SolverSolution): number {
  return ESTIMATED_CANDIDATE_OVERHEAD_BYTES + solution.steps.length * 16;
}

// ---------------------------------------------------------------------------
// CandidateArchive — bounded, diversity-aware, with protected global best
// ---------------------------------------------------------------------------

export class CandidateArchive {
  readonly #maxCandidates: number;
  readonly #maxBytes: number;
  #items: ArchivedCandidate[] = [];
  #globalBest: ArchivedCandidate | undefined;
  #nextOrder = 0;
  #nextId = 0;
  #currentBytes = 0;
  readonly #neighborhoods = new Map<string, NeighborhoodRecord>();

  readonly stats = {
    offered: 0,
    accepted: 0,
    duplicatesReplaced: 0,
    novelAdmissions: 0,
    evictions: 0,
    memoryPressureRejections: 0,
  };

  constructor(maxCandidates: number, maxBytes = Infinity) {
    this.#maxCandidates = Math.max(1, maxCandidates);
    this.#maxBytes = maxBytes;
  }

  offer(
    solution: SolverSolution,
    provenance: CandidateProvenance,
    semanticTrace?: SemanticDiversityTrace,
  ): boolean {
    this.stats.offered++;
    const sig = computeDiversitySignature(solution, semanticTrace);
    const candidateBytes = estimateCandidateBytes(solution);

    const duplicateIndex = this.#items.findIndex(({ signature }) =>
      sig.pushChainKey === signature.pushChainKey &&
      sig.boxGoalKey === signature.boxGoalKey);

    if (duplicateIndex >= 0) {
      const duplicate = this.#items[duplicateIndex];
      if (!isSolutionBetter(solution, duplicate.solution)) {
        return false;
      }
      const oldBytes = estimateCandidateBytes(duplicate.solution);
      this.#items[duplicateIndex] = {
        id: duplicate.id,
        solution,
        signature: sig,
        provenance,
        discoveryOrder: duplicate.discoveryOrder,
      };
      this.#currentBytes += candidateBytes - oldBytes;
      this.#sort();
      this.stats.accepted++;
      this.stats.duplicatesReplaced++;
      this.#updateGlobalBest();
      return true;
    }

    if (this.#currentBytes + candidateBytes > this.#maxBytes) {
      if (!this.#tryEvictForSpace(candidateBytes, solution)) {
        this.stats.memoryPressureRejections++;
        return false;
      }
    }

    if (this.#items.length >= this.#maxCandidates) {
      if (!this.#tryEvictForCapacity(solution)) {
        return false;
      }
    }

    const entry: ArchivedCandidate = {
      id: `c${this.#nextId++}`,
      solution,
      signature: sig,
      provenance,
      discoveryOrder: this.#nextOrder++,
    };
    this.#items.push(entry);
    this.#currentBytes += candidateBytes;
    this.#sort();
    this.stats.accepted++;
    this.stats.novelAdmissions++;
    this.#updateGlobalBest();
    return true;
  }

  #tryEvictForCapacity(incoming: SolverSolution): boolean {
    const evictable = this.#findEvictable(incoming);
    if (evictable < 0) return false;
    this.#evictAt(evictable);
    return true;
  }

  #tryEvictForSpace(neededBytes: number, incoming: SolverSolution): boolean {
    while (this.#currentBytes + neededBytes > this.#maxBytes && this.#items.length > 1) {
      const evictable = this.#findEvictable(incoming);
      if (evictable < 0) return false;
      this.#evictAt(evictable);
    }
    return this.#currentBytes + neededBytes <= this.#maxBytes;
  }

  #findEvictable(incoming: SolverSolution): number {
    let worstIndex = -1;
    let worstScore = -Infinity;
    for (let i = this.#items.length - 1; i >= 0; i--) {
      const item = this.#items[i];
      if (item === this.#globalBest) continue;
      if (!isSolutionBetter(incoming, item.solution) && !this.#isNovel(item)) {
        const score = item.solution.moves * 1000 + item.solution.pushes;
        if (score > worstScore) {
          worstScore = score;
          worstIndex = i;
        }
        continue;
      }
      if (item.solution.moves > incoming.moves) {
        const redundantScore = item.solution.moves * 1000 + item.solution.pushes;
        if (redundantScore > worstScore) {
          worstScore = redundantScore;
          worstIndex = i;
        }
      }
    }
    return worstIndex;
  }

  #isNovel(candidate: ArchivedCandidate): boolean {
    let matchingAssignment = 0;
    for (const other of this.#items) {
      if (other === candidate) continue;
      if (other.signature.boxGoalKey === candidate.signature.boxGoalKey) {
        matchingAssignment++;
      }
    }
    return matchingAssignment === 0;
  }

  #evictAt(index: number): void {
    const evicted = this.#items.splice(index, 1)[0];
    this.#currentBytes -= estimateCandidateBytes(evicted.solution);
    this.stats.evictions++;
  }

  #updateGlobalBest(): void {
    if (this.#items.length === 0) {
      this.#globalBest = undefined;
      return;
    }
    let best = this.#items[0];
    for (let i = 1; i < this.#items.length; i++) {
      if (isSolutionBetter(this.#items[i].solution, best.solution)) {
        best = this.#items[i];
      }
    }
    this.#globalBest = best;
  }

  #sort(): void {
    this.#items.sort((a, b) => {
      if (a.solution.moves !== b.solution.moves) return a.solution.moves - b.solution.moves;
      if (a.solution.pushes !== b.solution.pushes) return a.solution.pushes - b.solution.pushes;
      return a.discoveryOrder - b.discoveryOrder;
    });
  }

  // ── Neighborhood tracking ───────────────────────────────────────────

  recordOutcome(outcome: QualityTaskOutcome): void {
    const key = neighborhoodKeyString({
      candidateId: outcome.candidateId,
      operator: outcome.operator,
    });
    const existing = this.#neighborhoods.get(key);
    if (existing) {
      existing.totalExpanded += outcome.expanded;
      existing.totalGenerated += outcome.generated;
      existing.totalElapsedMs += outcome.elapsedMs;
      existing.lastReason = outcome.reason;
      if (outcome.reason === "exhausted" || outcome.reason === "completed-pass") {
        existing.completedPasses++;
      }
      if (outcome.reason === "exhausted") {
        existing.exhausted = true;
      }
    } else {
      this.#neighborhoods.set(key, {
        exhausted: outcome.reason === "exhausted",
        completedPasses:
          outcome.reason === "exhausted" || outcome.reason === "completed-pass" ? 1 : 0,
        totalExpanded: outcome.expanded,
        totalGenerated: outcome.generated,
        totalElapsedMs: outcome.elapsedMs,
        lastReason: outcome.reason,
      });
    }
  }

  isNeighborhoodExhausted(candidateId: string, operator: RepairOperator): boolean {
    const key = neighborhoodKeyString({ candidateId, operator });
    return this.#neighborhoods.get(key)?.exhausted ?? false;
  }

  neighborhoodRecord(candidateId: string, operator: RepairOperator): NeighborhoodRecord | undefined {
    const key = neighborhoodKeyString({ candidateId, operator });
    return this.#neighborhoods.get(key);
  }

  invalidateNeighborhoods(candidateId: string): void {
    for (const [key, record] of this.#neighborhoods) {
      if (key.startsWith(`${candidateId}:`)) {
        record.exhausted = false;
        record.completedPasses = 0;
      }
    }
  }

  // ── Accessors ───────────────────────────────────────────────────────

  get candidates(): readonly ArchivedCandidate[] {
    return this.#items;
  }

  get globalBest(): ArchivedCandidate | undefined {
    return this.#globalBest;
  }

  get estimatedMemoryBytes(): number {
    return this.#currentBytes;
  }

  get size(): number {
    return this.#items.length;
  }

  candidateById(id: string): ArchivedCandidate | undefined {
    return this.#items.find((item) => item.id === id);
  }

  selectForRepair(operator: RepairOperator): ArchivedCandidate | undefined {
    for (const candidate of this.#items) {
      if (!this.isNeighborhoodExhausted(candidate.id, operator)) {
        return candidate;
      }
    }
    return undefined;
  }

  allNeighborhoodsExhausted(operator: RepairOperator): boolean {
    return this.#items.every((c) => this.isNeighborhoodExhausted(c.id, operator));
  }
}
