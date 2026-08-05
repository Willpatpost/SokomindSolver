import type { DenseBox } from "./model.ts";

/**
 * Collision-free packed state identity for exact move-optimal search.
 *
 * Each box is encoded as a numeric token: labelId × cellCount + cellId.
 * Tokens are sorted numerically (preserving typed-label grouping since
 * labelId is the high part). The sorted token sequence is packed into a
 * BigInt, and the robot cell is appended as the lowest bits.
 *
 * Same-label boxes are interchangeable because their tokens are sorted
 * by cell within the same labelId range. Different labels are
 * distinguishable because the labelId is part of the token.
 */

export interface ExactStateCodec {
  readonly cellCount: number;
  readonly cellBits: number;
  readonly tokenBits: number;
  readonly boxCount: number;
  readonly labelCount: number;

  tokensFromBoxes(boxes: readonly DenseBox[]): Uint32Array;

  packBoxTokens(sortedTokens: ArrayLike<number>): bigint;

  packMoveState(
    robotCell: number,
    sortedTokens: ArrayLike<number>,
  ): bigint;

  decodeTokensForTest(identity: bigint): readonly number[];
}

function ceilLog2(value: number): number {
  if (value <= 1) return 1;
  return Math.ceil(Math.log2(value));
}

export function createExactStateCodec(
  cellCount: number,
  labels: readonly string[],
): ExactStateCodec {
  if (!Number.isInteger(cellCount) || cellCount < 1) {
    throw new RangeError("cellCount must be a positive integer.");
  }
  if (labels.length === 0) {
    throw new RangeError("At least one label is required.");
  }

  const labelToId = new Map<string, number>();
  const sortedLabels = [...labels].sort();
  for (let i = 0; i < sortedLabels.length; i++) {
    if (labelToId.has(sortedLabels[i])) {
      throw new Error(`Duplicate label: "${sortedLabels[i]}"`);
    }
    labelToId.set(sortedLabels[i], i);
  }

  const labelCount = sortedLabels.length;
  const maxToken = labelCount * cellCount - 1;
  const tokenBits = ceilLog2(maxToken + 1);
  const cellBits = ceilLog2(cellCount);
  const tokenMask = (1n << BigInt(tokenBits)) - 1n;

  function tokensFromBoxes(boxes: readonly DenseBox[]): Uint32Array {
    const tokens = new Uint32Array(boxes.length);
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      const labelId = labelToId.get(box.label);
      if (labelId === undefined) {
        throw new RangeError(`Unknown label "${box.label}".`);
      }
      if (box.cell < 0 || box.cell >= cellCount) {
        throw new RangeError(
          `Box cell ${box.cell} out of range [0, ${cellCount}).`,
        );
      }
      const token = labelId * cellCount + box.cell;
      if (token > 0xffffffff) {
        throw new RangeError("Token exceeds Uint32 range.");
      }
      tokens[i] = token;
    }
    tokens.sort();
    return tokens;
  }

  function packBoxTokens(sortedTokens: ArrayLike<number>): bigint {
    let packed = BigInt(sortedTokens.length);
    for (let i = 0; i < sortedTokens.length; i++) {
      packed = (packed << BigInt(tokenBits)) | BigInt(sortedTokens[i]);
    }
    return packed;
  }

  function packMoveState(
    robotCell: number,
    sortedTokens: ArrayLike<number>,
  ): bigint {
    if (robotCell < 0 || robotCell >= cellCount) {
      throw new RangeError(
        `Robot cell ${robotCell} out of range [0, ${cellCount}).`,
      );
    }
    const boxIdentity = packBoxTokens(sortedTokens);
    return (boxIdentity << BigInt(cellBits)) | BigInt(robotCell);
  }

  function decodeTokensForTest(identity: bigint): readonly number[] {
    const remaining = identity >> BigInt(cellBits);

    for (let n = 0; n <= 30; n++) {
      const totalTokenBits = n * tokenBits;
      const countValue = remaining >> BigInt(totalTokenBits);
      if (countValue === BigInt(n)) {
        // Extract the n tokens
        let tokenBitsRemaining = remaining & ((1n << BigInt(totalTokenBits)) - 1n);
        const result: number[] = [];
        for (let i = n - 1; i >= 0; i--) {
          result[i] = Number(tokenBitsRemaining & tokenMask);
          tokenBitsRemaining >>= BigInt(tokenBits);
        }
        return result;
      }
    }

    throw new Error("Could not decode token count from packed identity.");
  }

  return {
    cellCount,
    cellBits,
    tokenBits,
    boxCount: 0, // not fixed per codec, boxes are per-call
    labelCount,
    tokensFromBoxes,
    packBoxTokens,
    packMoveState,
    decodeTokensForTest,
  };
}
