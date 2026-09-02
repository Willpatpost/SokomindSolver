import type { CounterfactualFixture } from "./counterfactual-stories.ts";

export const SHARED_PACKING_STORY: CounterfactualFixture = {
  puzzle: {
    id: "quality-shared-packing", title: "Shared Packing", difficulty: "beginner", boxes: 3,
    rows: [
      "OOOOOOOOOOOO", "O   O      O", "O X RX  SSSO",
      "O X O      O", "O   O      O", "OOOOOOOOOOOO",
    ],
  },
  pushes: [[1, "right", 5], [0, "right", 7], [2, "up", 1], [2, "right", 6]],
};

export const ISOLATED_BOX_STORY: CounterfactualFixture = {
  puzzle: {
    id: "quality-isolated-box", title: "Isolated Filler", difficulty: "beginner", boxes: 3,
    rows: [
      "OOOOOOOOOOOOOO", "O R X SS O   O", "O   X    O   O",
      "O        O   O", "O          X O", "O            O", "O          S O", "OOOOOOOOOOOOOO",
    ],
  },
  pushes: [[0, "right", 3], [1, "up", 1], [1, "right", 2], [2, "down", 2]],
};
