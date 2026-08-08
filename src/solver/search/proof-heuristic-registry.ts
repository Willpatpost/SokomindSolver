import type { CompiledSearchBoard } from "./compiled-board.ts";
import type { DenseBox } from "./model.ts";

export interface ProofHeuristicRegistration {
  readonly id: string;
  readonly objective: "moves";
  readonly proofFamily: string;
  evaluate(board: CompiledSearchBoard, boxes: readonly DenseBox[], robotCell?: number): number;
}

export class ProofHeuristicRegistry {
  readonly #registrations: ProofHeuristicRegistration[] = [];

  register(heuristic: ProofHeuristicRegistration): void {
    if (this.#registrations.some((r) => r.id === heuristic.id)) {
      throw new Error(`Proof heuristic "${heuristic.id}" is already registered.`);
    }
    this.#registrations.push(heuristic);
  }

  get(id: string): ProofHeuristicRegistration | undefined {
    return this.#registrations.find((r) => r.id === id);
  }

  get registrations(): readonly ProofHeuristicRegistration[] {
    return this.#registrations;
  }

  get size(): number {
    return this.#registrations.length;
  }
}
