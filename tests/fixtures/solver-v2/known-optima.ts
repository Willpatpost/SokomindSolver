/**
 * Frozen move-optimal records established by an independent step oracle and
 * replayed by the exact classic gate. `moves` is the independent correctness
 * constraint. `pushes` freezes the deterministic oracle route as a separate
 * regression signal; exact benchmark acceptance does not optimize pushes.
 */
export interface KnownOptimum {
  readonly moves: number;
  readonly pushes: number;
  /** Independent exhaustive step-BFS state count, when retained as provenance. */
  readonly oracleStates?: number;
}

export interface KnownSolvedOutcome extends KnownOptimum {
  readonly kind: "solved";
}

export interface KnownUnsolvableOutcome {
  readonly kind: "unsolvable";
}

export type KnownFixtureOutcome =
  | KnownSolvedOutcome
  | KnownUnsolvableOutcome;

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
  "v2-solved-box-must-move": Object.freeze({
    moves: 14,
    pushes: 4,
    oracleStates: 774,
  }),
  "v2-assignment-infeasible": Object.freeze({
    moves: 17,
    pushes: 7,
    oracleStates: 2_236,
  }),
  "v2-sealed-corral": Object.freeze({
    moves: 19,
    pushes: 7,
    oracleStates: 559,
  }),
  "v2-microban-145": Object.freeze({
    moves: 23,
    pushes: 10,
    oracleStates: 14_425,
  }),
  "v2-microban-146": Object.freeze({
    moves: 23,
    pushes: 6,
    oracleStates: 13_927,
  }),
  "v2-caleb-022": Object.freeze({
    moves: 45,
    pushes: 18,
    oracleStates: 285_582,
  }),
  "v2-wide-multi-entry": Object.freeze({
    moves: 25,
    pushes: 12,
    oracleStates: 370_758,
  }),
  "v2-loop-heavy": Object.freeze({
    moves: 32,
    pushes: 14,
    oracleStates: 66_400,
  }),
});

/** Fixture IDs independently proven to exhaust without a solution. */
export const KNOWN_UNSOLVABLE_FIXTURE_IDS: readonly string[] = Object.freeze([]);

/**
 * Canonical independent truth used by exact benchmark acceptance. The
 * discriminant deliberately supports future proven-unsolvable fixtures;
 * already-solved fixtures are represented as solved with a 0/0 optimum.
 */
export const KNOWN_FIXTURE_OUTCOMES_BY_ID: Readonly<
  Record<string, KnownFixtureOutcome>
> = Object.freeze(
  Object.fromEntries(
    [
      ...Object.entries(KNOWN_OPTIMA_BY_FIXTURE_ID).map(
        ([fixtureId, optimum]) => [
          fixtureId,
          Object.freeze({ kind: "solved" as const, ...optimum }),
        ] as const,
      ),
      ...KNOWN_UNSOLVABLE_FIXTURE_IDS.map(
        (fixtureId) => [
          fixtureId,
          Object.freeze({ kind: "unsolvable" as const }),
        ] as const,
      ),
    ],
  ),
);

/** Entries expected to complete inside the regular exact-oracle gate. */
export const KNOWN_OPTIMA_STANDARD_GATE_FIXTURE_IDS = Object.freeze(
  Object.keys(KNOWN_FIXTURE_OUTCOMES_BY_ID).filter(
    (fixtureId) => fixtureId !== "expert-tetris",
  ),
);

/** Expensive entries retained for an explicitly extended oracle run. */
export const KNOWN_OPTIMA_EXTENDED_GATE_FIXTURE_IDS = Object.freeze([
  "expert-tetris",
]);
