/**
 * Zobrist hashing for solver state identity.
 *
 * Pre-generates random 64-bit values (as hi/lo 32-bit pairs) for every
 * (cell, labelId) token and every keeper cell. State hash = XOR of all
 * box-token random values XOR keeper random value.
 *
 * The lower 53 bits of the hash are safe as a JS number key for Map/Set.
 * The full BigInt key from ExactStateCodec is kept as a collision-check
 * backup when needed.
 */

import { mulberry32 } from "./rng.ts";

export interface ZobristTable {
  readonly cellCount: number;
  readonly labelCount: number;
  readonly maxToken: number;

  /** Full Zobrist hash from token array + robot cell → 53-bit safe integer. */
  hashFromTokens(sortedTokens: ArrayLike<number>, robotCell: number): number;

  /** Push-only hash (no robot) from token array → 53-bit safe integer. */
  hashFromTokensNoRobot(sortedTokens: ArrayLike<number>): number;

  /** Incremental update: XOR out old token, XOR in new token. */
  updateToken(currentHi: number, currentLo: number, oldToken: number, newToken: number): { hi: number; lo: number };

  /** Incremental update for robot movement. */
  updateRobot(currentHi: number, currentLo: number, oldRobotCell: number, newRobotCell: number): { hi: number; lo: number };

  /** Combine hi/lo into a 53-bit safe integer key. */
  toSafeKey(hi: number, lo: number): number;

  /** Full hash returning hi/lo components for incremental use. */
  hashComponents(sortedTokens: ArrayLike<number>, robotCell: number): { hi: number; lo: number };

  /** Push-only hash returning hi/lo components. */
  hashComponentsNoRobot(sortedTokens: ArrayLike<number>): { hi: number; lo: number };
}

export function createZobristTable(
  cellCount: number,
  labelCount: number,
  seed = 0x534f4b4f,
): ZobristTable {
  const maxToken = labelCount * cellCount;
  const rng = mulberry32(seed);

  const tokenHi = new Uint32Array(maxToken);
  const tokenLo = new Uint32Array(maxToken);
  for (let i = 0; i < maxToken; i++) {
    tokenHi[i] = rng();
    tokenLo[i] = rng();
  }

  const robotHi = new Uint32Array(cellCount);
  const robotLo = new Uint32Array(cellCount);
  for (let i = 0; i < cellCount; i++) {
    robotHi[i] = rng();
    robotLo[i] = rng();
  }

  function hashComponents(
    sortedTokens: ArrayLike<number>,
    robotCell: number,
  ): { hi: number; lo: number } {
    let hi = robotHi[robotCell];
    let lo = robotLo[robotCell];
    for (let i = 0; i < sortedTokens.length; i++) {
      const t = sortedTokens[i];
      hi = (hi ^ tokenHi[t]) >>> 0;
      lo = (lo ^ tokenLo[t]) >>> 0;
    }
    return { hi, lo };
  }

  function hashComponentsNoRobot(
    sortedTokens: ArrayLike<number>,
  ): { hi: number; lo: number } {
    let hi = 0;
    let lo = 0;
    for (let i = 0; i < sortedTokens.length; i++) {
      const t = sortedTokens[i];
      hi = (hi ^ tokenHi[t]) >>> 0;
      lo = (lo ^ tokenLo[t]) >>> 0;
    }
    return { hi, lo };
  }

  function toSafeKey(hi: number, lo: number): number {
    return (hi & 0x1fffff) * 0x100000000 + lo;
  }

  function hashFromTokens(
    sortedTokens: ArrayLike<number>,
    robotCell: number,
  ): number {
    const { hi, lo } = hashComponents(sortedTokens, robotCell);
    return toSafeKey(hi, lo);
  }

  function hashFromTokensNoRobot(
    sortedTokens: ArrayLike<number>,
  ): number {
    const { hi, lo } = hashComponentsNoRobot(sortedTokens);
    return toSafeKey(hi, lo);
  }

  function updateToken(
    currentHi: number,
    currentLo: number,
    oldToken: number,
    newToken: number,
  ): { hi: number; lo: number } {
    return {
      hi: (currentHi ^ tokenHi[oldToken] ^ tokenHi[newToken]) >>> 0,
      lo: (currentLo ^ tokenLo[oldToken] ^ tokenLo[newToken]) >>> 0,
    };
  }

  function updateRobot(
    currentHi: number,
    currentLo: number,
    oldRobotCell: number,
    newRobotCell: number,
  ): { hi: number; lo: number } {
    return {
      hi: (currentHi ^ robotHi[oldRobotCell] ^ robotHi[newRobotCell]) >>> 0,
      lo: (currentLo ^ robotLo[oldRobotCell] ^ robotLo[newRobotCell]) >>> 0,
    };
  }

  return {
    cellCount,
    labelCount,
    maxToken,
    hashFromTokens,
    hashFromTokensNoRobot,
    updateToken,
    updateRobot,
    toSafeKey,
    hashComponents,
    hashComponentsNoRobot,
  };
}
