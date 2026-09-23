/**
 * Pattern-deadlock memo soundness boards.
 *
 * The window around (7,17) holds a real two-box deadlock in a closed pocket.
 * The window around (7,7) has the same in-window floor, but its pocket
 * continues past the window edge to the goal at (7,1). The pattern cache key
 * used to leave out the floor just outside the window, so the verdict cached
 * for the closed pocket pruned every optimal plan through the open one, and
 * exact search returned the result in `preFix`.
 *
 * `moves` is the move optimum from the independent step oracle
 * (`exactRemainingMoves` in `tests/support/exact-solver-oracle.ts`).
 */

export type PatternDeadlockSoundnessId =
  | "pd-false-optimum"
  | "pd-false-unsolvable";

export interface PatternDeadlockSoundnessFixture {
  readonly id: PatternDeadlockSoundnessId;
  readonly rows: readonly string[];
  readonly moves: number;
  /** What runExactMoveAStar / runIdaStarSearch returned before the fix. */
  readonly preFix: string;
}

function freeze(
  fixture: PatternDeadlockSoundnessFixture,
): PatternDeadlockSoundnessFixture {
  return Object.freeze({ ...fixture, rows: Object.freeze([...fixture.rows]) });
}

export const PATTERN_DEADLOCK_SOUNDNESS_BY_ID: Readonly<
  Record<PatternDeadlockSoundnessId, PatternDeadlockSoundnessFixture>
> = Object.freeze({
  "pd-false-optimum": freeze({
    id: "pd-false-optimum",
    rows: [
      "OOOOOOOOOOOOOOOOOOOOOOO",
      "OO  OOO  OOOOOOOOOOOOOO",
      "OO                R OOO",
      "OO OOOO O OOOOOOO O OOO",
      "OO OOOO O OOOOOOO O OOO",
      "OO OOOO O OOOOOOO O OOO",
      "OO OOOO O OOOOOOOXO OOO",
      "OS        XSO       XSO",
      "OOOOOOOOOOOOOOOOOOOOOOO",
    ],
    moves: 63,
    preFix: "defaults: 73 moves, proven (lb = ub = 73)",
  }),
  "pd-false-unsolvable": freeze({
    id: "pd-false-unsolvable",
    rows: [
      "OOOOOOOOOOOOOOOOOOOOOOO",
      "OOOOOOO  OOOOOOOOOOOOOO",
      "OOOOOOO           R OOO",
      "OOOOOOO O OOOOOOO O OOO",
      "OOOOOOO O OOOOOOO O OOO",
      "OOOOOOO O OOOOOOO O OOO",
      "OOOOOOO O OOOOOOOXO OOO",
      "OS        XSO       XSO",
      "OOOOOOOOOOOOOOOOOOOOOOO",
    ],
    moves: 63,
    preFix: "defaults: exhausted, proof unsolvable",
  }),
});

export const PATTERN_DEADLOCK_SOUNDNESS_FIXTURES: readonly PatternDeadlockSoundnessFixture[] =
  Object.freeze(Object.values(PATTERN_DEADLOCK_SOUNDNESS_BY_ID));
