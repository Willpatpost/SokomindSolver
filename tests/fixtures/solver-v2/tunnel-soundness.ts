/**
 * Tunnel-macro soundness boards.
 *
 * Every board produces a tunnel-macro stop with pushCount >= 2 when
 * `tunnelMacros: true`. Exact search used to replace the single push into a
 * tunnel with the macro stops, and returned the result in `preFix` on these
 * boards.
 *
 * - `moves` is the move optimum from the independent step oracle
 *   (`exactRemainingMoves` in `tests/support/exact-solver-oracle.ts`). It is
 *   the correctness constraint.
 * - `pushOptimum`, where present, is the minimum push count from a separate
 *   0-1 push-cost search. It applies only to push-objective algorithms and is
 *   not a move optimum.
 */

export type TunnelSoundnessId =
  | "es01"
  | "es01a"
  | "es01c"
  | "es01d"
  | "fz-unsolvable"
  | "fz-corridor";

export interface TunnelSoundnessFixture {
  readonly id: TunnelSoundnessId;
  readonly rows: readonly string[];
  readonly moves: number;
  readonly pushOptimum?: number;
  /** What runExactMoveAStar / runIdaStarSearch returned before the fix. */
  readonly preFix: string;
}

function freeze(fixture: TunnelSoundnessFixture): TunnelSoundnessFixture {
  return Object.freeze({ ...fixture, rows: Object.freeze([...fixture.rows]) });
}

export const TUNNEL_SOUNDNESS_BY_ID: Readonly<
  Record<TunnelSoundnessId, TunnelSoundnessFixture>
> = Object.freeze({
  es01: freeze({
    id: "es01",
    rows: [
      "OOOOOOOOO",
      "OOcOOOOOO",
      "OOCOOOOOO",
      "ORA    aO",
      "OXOOOOOOO",
      "OSOOOOOOO",
      "O OOOOOOO",
      "OOOOOOOOO",
    ],
    moves: 9,
    preFix: "defaults: 12 moves, proven (lb = ub = 12)",
  }),
  es01a: freeze({
    id: "es01a",
    rows: [
      "OOOOOOOOOO",
      "OOO      O",
      "OOO OOOO O",
      "OSRX     O",
      "OOOOOOOOOO",
    ],
    moves: 16,
    pushOptimum: 4,
    preFix: "defaults: 16 proven; forcedPushMacros:false: exhausted, proof unsolvable",
  }),
  es01c: freeze({
    id: "es01c",
    rows: [
      "OOOOOOOOOO",
      "OOO      O",
      "OOO OOOO O",
      "OSRX     O",
      "OO OOOOOOO",
      "OO XSOOOOO",
      "OO   OOOOO",
      "OOOOOOOOOO",
    ],
    moves: 19,
    pushOptimum: 5,
    preFix: "defaults: 22 moves, proven; forcedPushMacros:false: exhausted",
  }),
  es01d: freeze({
    id: "es01d",
    rows: [
      "OOOOOOOOOO",
      "OOO      O",
      "OOO OOOO O",
      "OSRX     O",
      "OO OOOOOOO",
      "O     OOOO",
      "O X S OOOO",
      "O     OOOO",
      "OOOOOOOOOO",
    ],
    moves: 22,
    pushOptimum: 6,
    preFix: "defaults: exhausted, proof unsolvable (classic adapters too)",
  }),
  "fz-unsolvable": freeze({
    id: "fz-unsolvable",
    rows: [
      "OOOOOOOO",
      "O      O",
      "O OOO aO",
      "O    AaO",
      "OOOOOOAO",
      "OOOOOORO",
      "OOOOOOOO",
    ],
    moves: 15,
    preFix: "defaults: exhausted, proof unsolvable (classic adapters too)",
  }),
  "fz-corridor": freeze({
    id: "fz-corridor",
    rows: [
      "OOOOO",
      "O  aO",
      "O   O",
      "OOO O",
      "O O O",
      "ObB O",
      "OSXAO",
      "O R O",
      "OOOOO",
    ],
    moves: 10,
    preFix: "defaults: 12 moves, proven",
  }),
});

export const TUNNEL_SOUNDNESS_FIXTURES: readonly TunnelSoundnessFixture[] =
  Object.freeze(Object.values(TUNNEL_SOUNDNESS_BY_ID));
