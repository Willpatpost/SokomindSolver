/**
 * Frozen move-optimal records established by the exact classic oracle gate.
 * These values are correctness constraints for proof and feature benchmarks,
 * not performance baselines.
 */
export interface KnownOptimum {
  readonly moves: number;
  readonly pushes: number;
}

export const KNOWN_OPTIMA_BY_FIXTURE_ID: Readonly<
  Record<string, KnownOptimum>
> = Object.freeze({
  "ultra-tiny": Object.freeze({ moves: 1, pushes: 1 }),
  tiny: Object.freeze({ moves: 20, pushes: 5 }),
  "tutorial-push": Object.freeze({ moves: 4, pushes: 1 }),
  "tutorial-corner": Object.freeze({ moves: 3, pushes: 1 }),
  "tutorial-around": Object.freeze({ moves: 4, pushes: 1 }),
  "beginner-three": Object.freeze({ moves: 7, pushes: 3 }),
  "beginner-detour": Object.freeze({ moves: 24, pushes: 10 }),
  "beginner-typed-line": Object.freeze({ moves: 27, pushes: 15 }),
  "garden-1": Object.freeze({ moves: 16, pushes: 6 }),
  "box-5x5-a": Object.freeze({ moves: 6, pushes: 3 }),
  medium: Object.freeze({ moves: 34, pushes: 18 }),
  "inter-rooms": Object.freeze({ moves: 28, pushes: 7 }),
  "corridor-2": Object.freeze({ moves: 41, pushes: 17 }),
  "garden-2": Object.freeze({ moves: 73, pushes: 14 }),
  "workshop-1": Object.freeze({ moves: 23, pushes: 10 }),
  "classic-1": Object.freeze({ moves: 40, pushes: 13 }),
  "theme-kitchen": Object.freeze({ moves: 34, pushes: 12 }),
  "adv-rotary": Object.freeze({ moves: 17, pushes: 4 }),
  "adv-four-color": Object.freeze({ moves: 43, pushes: 30 }),
  "adv-gallery": Object.freeze({ moves: 29, pushes: 10 }),
  "box-7x7": Object.freeze({ moves: 21, pushes: 12 }),
  "sym-diamond": Object.freeze({ moves: 16, pushes: 7 }),
  "theme-library": Object.freeze({ moves: 45, pushes: 22 }),
  "expert-maze": Object.freeze({ moves: 65, pushes: 28 }),
  "expert-tetris": Object.freeze({ moves: 38, pushes: 19 }),
});

