import type { CompiledSearchBoard } from "./compiled-board.ts";
import type { DenseBox } from "./model.ts";

export interface ProofHeuristicRegistration {
  readonly id: string;
  readonly objective: "moves";
  readonly proofFamily: string;
  evaluate(board: CompiledSearchBoard, boxes: readonly DenseBox[]): number;
}

export class ProofHeuristicRegistry {
  readonly #registrations: ProofHeuristicRegistration[] = [];

  register(heuristic: ProofHeuristicRegistration): void {
    this.#registrations.push(heuristic);
  }

  get registrations(): readonly ProofHeuristicRegistration[] {
    return this.#registrations;
  }
}
