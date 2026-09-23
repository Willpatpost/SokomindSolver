/**
 * Frozen move-optimal records replayed by the exact classic gate.
 *
 * Only entries that carry `oracleStates` are oracle-verified: the independent
 * step oracle (`exactRemainingMoves` in `tests/support/exact-solver-oracle.ts`)
 * established their outcome, and `pushes` is the push count of its first
 * move-optimal route. Solved entries without `oracleStates` are frozen
 * exact-solver outputs with no independent provenance. `moves` is the
 * correctness constraint. `pushes` is a separate deterministic regression
 * signal; exact benchmark acceptance does not optimize pushes.
 */

import { TUNNEL_SOUNDNESS_BY_ID } from "./tunnel-soundness.ts";

export interface KnownOptimum {
  readonly moves: number;
  readonly pushes: number;
  /** Independent step-BFS state count when it reached a goal; present only when oracle-verified. */
  readonly oracleStates?: number;
}

export interface KnownSolvedOutcome extends KnownOptimum {
  readonly kind: "solved";
}

export interface KnownUnsolvableOutcome {
  readonly kind: "unsolvable";
  /** Independent step-BFS state count at exhaustion. */
  readonly oracleStates?: number;
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
  es01c: Object.freeze({
    moves: 19,
    pushes: 5,
    oracleStates: 311,
  }),
  es01d: Object.freeze({
    moves: 22,
    pushes: 6,
    oracleStates: 2_344,
  }),
});

/** Fixtures the independent step oracle exhausts without a solution. */
export const KNOWN_UNSOLVABLE_BY_FIXTURE_ID: Readonly<
  Record<string, Omit<KnownUnsolvableOutcome, "kind">>
> = Object.freeze({
  "blocked-typed-corridor": Object.freeze({ oracleStates: 814 }),
});

/**
 * Rows for gated fixtures outside the benchmark corpus. Benchmarks read
 * outcomes only for corpus fixtures, so only the known-optimum gate runs
 * these boards.
 */
export const KNOWN_FIXTURE_ROWS_OUTSIDE_CORPUS: Readonly<
  Record<string, readonly string[]>
> = Object.freeze({
  es01c: TUNNEL_SOUNDNESS_BY_ID.es01c.rows,
  es01d: TUNNEL_SOUNDNESS_BY_ID.es01d.rows,
  // B can only be pushed deeper into the one-wide corridor and the robot can
  // never get behind it, so A can never pass B to reach its goal. No box
  // starts on a dead square, so only an exhaustive search proves it.
  "blocked-typed-corridor": Object.freeze([
    "OOOOOOOOO",
    "OabB    O",
    "OOOO    O",
    "OOOO A  O",
    "OOOO  R O",
    "OOOOOOOOO",
  ]),
});

/**
 * Canonical independent truth used by exact benchmark acceptance.
 * Already-solved fixtures are represented as solved with a 0/0 optimum.
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
      ...Object.entries(KNOWN_UNSOLVABLE_BY_FIXTURE_ID).map(
        ([fixtureId, outcome]) => [
          fixtureId,
          Object.freeze({ kind: "unsolvable" as const, ...outcome }),
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

const IDA_STAR_GATE_MAX_ORACLE_STATES = 100_000;

/** Small oracle-backed standard entries that exact IDA* must also reproduce. */
export const KNOWN_OPTIMA_IDA_STAR_GATE_FIXTURE_IDS = Object.freeze(
  KNOWN_OPTIMA_STANDARD_GATE_FIXTURE_IDS.filter((fixtureId) => {
    const { oracleStates } = KNOWN_FIXTURE_OUTCOMES_BY_ID[fixtureId];
    return oracleStates !== undefined &&
      oracleStates < IDA_STAR_GATE_MAX_ORACLE_STATES;
  }),
);
