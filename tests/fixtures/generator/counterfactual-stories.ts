import type { Direction, PuzzleDefinition } from "../../../src/core/model.ts";

export interface CounterfactualFixture {
  readonly puzzle: PuzzleDefinition;
  readonly pushes: readonly (readonly [number, Direction, number])[];
}

/** Small feature-isolation fixtures, not catalog candidates or tier examples. */
export const DELAYED_FALSE_START: CounterfactualFixture = {
  puzzle: {
    id: "cf-delayed", title: "Premature Corridor Entry", difficulty: "beginner", boxes: 2,
    rows: ["OOOOOOOOOOOOO", "O   OOO     O", "O X R  A  SaO", "O   OOO     O", "OOOOOOOOOOOOO"],
  },
  pushes: [[1, "right", 4], [0, "right", 8]],
};

export const RECOVERABLE_CORRIDOR: CounterfactualFixture = {
  puzzle: {
    ...DELAYED_FALSE_START.puzzle, id: "cf-recoverable", title: "Corridor With Bypass",
    rows: ["OOOOOOOOOOOOO", "O           O", "O X R  A  SaO", "O   OOO     O", "OOOOOOOOOOOOO"],
  },
  pushes: DELAYED_FALSE_START.pushes,
};

export const NECESSARY_GOAL_VACANCY: CounterfactualFixture = {
  puzzle: {
    id: "cf-packing", title: "Keep Packing Deep", difficulty: "beginner", boxes: 2,
    rows: ["OOOOOOOOOOO", "O   O     O", "O X RX  SSO", "O   O     O", "OOOOOOOOOOO"],
  },
  pushes: [[1, "right", 4], [0, "right", 6]],
};

export const OPTIONAL_GOAL_VACANCY: CounterfactualFixture = {
  puzzle: {
    id: "cf-optional", title: "Unnecessary Vacancy", difficulty: "beginner", boxes: 2,
    rows: ["OOOOOOOOO", "O       O", "O RX S  O", "O  X S  O", "O       O", "OOOOOOOOO"],
  },
  pushes: [[0, "right", 2], [0, "left", 1], [1, "right", 2], [0, "right", 1]],
};

export const NECESSARY_ENABLER: CounterfactualFixture = {
  puzzle: {
    id: "cf-enabler", title: "Doorway Enabler", difficulty: "beginner", boxes: 2,
    rows: [
      "OOOOOOOOOOOO", "O   O      O", "O   O      O", "O R A  X aSO",
      "O   O      O", "O   O      O", "OOOOOOOOOOOO",
    ],
  },
  pushes: [[0, "right", 2], [0, "down", 1], [1, "right", 3], [0, "up", 1], [0, "right", 3]],
};

export const UNRELATED_CONTINUATION: CounterfactualFixture = {
  puzzle: {
    id: "cf-unrelated-work", title: "Unrelated Work Is Not Delay", difficulty: "beginner", boxes: 3,
    rows: [
      "OOOOOOOOOOO", "O   O     O", "O B O     O", "O X RA  SaO",
      "O  OO     O", "O bOO     O", "OOOOOOOOOOO",
    ],
  },
  pushes: [[2, "right", 4], [1, "right", 6], [0, "down", 3]],
};
