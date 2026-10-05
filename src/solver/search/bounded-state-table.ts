// Open-addressing state cache for exact IDA*.
//
// Each slot stores a state's whole identity inline: its robot cell followed by
// its sorted box tokens, at the narrowest width that holds every token. The
// 64-bit Zobrist hash only picks the slot (low half) and screens candidates
// (both halves); a state matches only when its full key is equal, so a hash
// collision never merges two states.
//
// Slots carry a generation stamp, and a slot is live only while its stamp
// equals the current generation. Every probe checks the stamp, so `clear` is
// one increment and an entry from an earlier generation is never read. The
// load stays at or below 0.7, so every probe ends at a free slot. The table
// doubles until its slot limit or the memory budget stops it. After that, a
// new state replaces the live entry in its home slot, or is not stored when
// that slot is free; a lost entry only costs repeated work. A failed
// allocation reports failure so the search can stop at its memory limit.

const INITIAL_SLOTS = 256;
const MAX_SLOTS = 1 << 30;
const MAX_LOAD = 0.7;
const META_STRIDE = 4; // stamp, hash low, hash high, value
const MAX_GENERATION = 0xffffffff;

export interface BoundedStateTableOptions {
  readonly cellCount: number;
  /** No box token the search produces exceeds this. */
  readonly maxToken: number;
  readonly boxCount: number;
  /** The table grows until it can hold at least this many entries. */
  readonly maxEntries: number;
  /** Asked before each growth with the extra bytes it would hold. */
  readonly canGrow?: (additionalBytes: number) => boolean;
}

export interface BoundedStateTable {
  /** Live entries in the current generation. */
  readonly size: number;
  readonly byteLength: number;
  /** Starts a new generation; earlier entries are no longer visible. */
  clear(): void;
  /** The slot holding this state, or -1. */
  find(
    hashLo: number,
    hashHi: number,
    robotCell: number,
    tokens: ArrayLike<number>,
  ): number;
  value(slot: number): number;
  setValue(slot: number, value: number): void;
  /**
   * Stores a state that `find` has just missed. Returns false only when
   * growing the table fails to allocate.
   */
  insert(
    hashLo: number,
    hashHi: number,
    robotCell: number,
    tokens: ArrayLike<number>,
    value: number,
  ): boolean;
}

function nextPowerOfTwo(value: number): number {
  let result = 1;
  while (result < value) result *= 2;
  return result;
}

export function createBoundedStateTable(
  options: BoundedStateTableOptions,
): BoundedStateTable {
  const keyLength = options.boxCount + 1;
  const wide = Math.max(options.maxToken, options.cellCount - 1) > 0xffff;
  const bytesPerSlot =
    META_STRIDE * Uint32Array.BYTES_PER_ELEMENT + keyLength * (wide ? 4 : 2);
  const maxSlots = Math.min(
    MAX_SLOTS,
    Math.max(2, nextPowerOfTwo(Math.ceil(options.maxEntries / MAX_LOAD))),
  );
  const loadLimit = (slotCount: number) => Math.floor(slotCount * MAX_LOAD);
  const newKeys = (slotCount: number): Uint16Array | Uint32Array =>
    wide
      ? new Uint32Array(slotCount * keyLength)
      : new Uint16Array(slotCount * keyLength);

  const initialSlots = Math.min(INITIAL_SLOTS, maxSlots);
  let meta: Uint32Array = new Uint32Array(initialSlots * META_STRIDE);
  let keys = newKeys(initialSlots);
  let mask = initialSlots - 1;
  let generation = 1;
  let size = 0;

  function keyMatches(
    slot: number,
    robotCell: number,
    tokens: ArrayLike<number>,
  ): boolean {
    const base = slot * keyLength;
    if (keys[base] !== robotCell) return false;
    for (let i = 0; i < options.boxCount; i++) {
      if (keys[base + 1 + i] !== tokens[i]) return false;
    }
    return true;
  }

  function write(
    slot: number,
    hashLo: number,
    hashHi: number,
    robotCell: number,
    tokens: ArrayLike<number>,
    value: number,
  ): void {
    const m = slot * META_STRIDE;
    meta[m] = generation;
    meta[m + 1] = hashLo;
    meta[m + 2] = hashHi;
    meta[m + 3] = value;
    const base = slot * keyLength;
    keys[base] = robotCell;
    for (let i = 0; i < options.boxCount; i++) keys[base + 1 + i] = tokens[i];
  }

  function rehash(slotCount: number): boolean {
    let nextMeta: Uint32Array;
    let nextKeys: Uint16Array | Uint32Array;
    try {
      nextMeta = new Uint32Array(slotCount * META_STRIDE);
      nextKeys = newKeys(slotCount);
    } catch (error) {
      if (error instanceof RangeError) return false;
      throw error;
    }
    const nextMask = slotCount - 1;
    for (let slot = 0; slot <= mask; slot++) {
      const m = slot * META_STRIDE;
      if (meta[m] !== generation) continue;
      let j = meta[m + 1] & nextMask;
      while (nextMeta[j * META_STRIDE] !== 0) j = (j + 1) & nextMask;
      nextMeta.set(meta.subarray(m, m + META_STRIDE), j * META_STRIDE);
      nextKeys.set(
        keys.subarray(slot * keyLength, (slot + 1) * keyLength),
        j * keyLength,
      );
    }
    meta = nextMeta;
    keys = nextKeys;
    mask = nextMask;
    return true;
  }

  return {
    get size() {
      return size;
    },

    get byteLength() {
      return meta.byteLength + keys.byteLength;
    },

    clear() {
      if (generation === MAX_GENERATION) {
        for (let m = 0; m < meta.length; m += META_STRIDE) meta[m] = 0;
        generation = 1;
      } else {
        generation += 1;
      }
      size = 0;
    },

    find(hashLo, hashHi, robotCell, tokens) {
      let slot = hashLo & mask;
      for (;;) {
        const m = slot * META_STRIDE;
        if (meta[m] !== generation) return -1;
        if (
          meta[m + 1] === hashLo &&
          meta[m + 2] === hashHi &&
          keyMatches(slot, robotCell, tokens)
        ) {
          return slot;
        }
        slot = (slot + 1) & mask;
      }
    },

    value(slot) {
      return meta[slot * META_STRIDE + 3];
    },

    setValue(slot, value) {
      meta[slot * META_STRIDE + 3] = value;
    },

    insert(hashLo, hashHi, robotCell, tokens, value) {
      const slotCount = mask + 1;
      if (size + 1 > loadLimit(slotCount)) {
        const canDouble =
          slotCount < maxSlots &&
          (options.canGrow?.(slotCount * bytesPerSlot) ?? true);
        if (!canDouble) {
          const home = hashLo & mask;
          if (meta[home * META_STRIDE] === generation) {
            write(home, hashLo, hashHi, robotCell, tokens, value);
          }
          return true;
        }
        if (!rehash(slotCount * 2)) return false;
      }
      let slot = hashLo & mask;
      while (meta[slot * META_STRIDE] === generation) slot = (slot + 1) & mask;
      write(slot, hashLo, hashHi, robotCell, tokens, value);
      size += 1;
      return true;
    },
  };
}
