// Open-addressing state table for exact move A*.
//
// Each slot holds the low 32 bits of a state's Zobrist hash and the arena
// node of the best known path to that state. The hash only picks the slot and
// screens candidates: a state matches only when its robot cell and sorted box
// tokens equal the stored node's, so a hash collision never merges two
// states. Entries are never evicted or deleted. A better path re-points the
// slot and marks the old node superseded, so a popped node is current exactly
// when its superseded bit is clear. A table that cannot grow reports failure
// and the search stops at its memory limit.

import type { CompactNodeArena } from "./compact-node-arena.ts";

const INITIAL_SLOTS = 256;
/** 2^30 slots is 8 GiB of slots, beyond any memory limit we accept. */
const MAX_SLOTS = 1 << 30;
const INITIAL_SUPERSEDED_WORDS = 64;

export interface ExactStateTable {
  readonly size: number;
  readonly byteLength: number;
  /** Bytes held after `store` with this node count, counting any growth. */
  byteLengthAfterStore(newState: boolean, nodeCount: number): number;
  /** The arena node stored for this state, or -1. */
  find(hash: number, robotCell: number, tokens: Uint16Array | Uint32Array): number;
  /**
   * Records `node` as the best path to its state. `previousNode` is the node
   * `find` returned for the state (-1 when new) and becomes superseded.
   * Returns false when the table cannot grow.
   */
  store(hash: number, node: number, previousNode: number): boolean;
  isSuperseded(node: number): boolean;
}

export function createExactStateTable(arena: CompactNodeArena): ExactStateTable {
  // slots[2i] = hash, slots[2i + 1] = node + 1 (0 marks an empty slot).
  let slots = new Uint32Array(INITIAL_SLOTS * 2);
  let mask = INITIAL_SLOTS - 1;
  let superseded = new Uint32Array(INITIAL_SUPERSEDED_WORDS);
  let size = 0;

  const growthThreshold = (slotCount: number) => Math.floor(slotCount * 0.7);

  function slotCountAfter(stateCount: number): number {
    let slotCount = mask + 1;
    while (stateCount > growthThreshold(slotCount)) slotCount *= 2;
    return slotCount;
  }

  function supersededWordsAfter(nodeCount: number): number {
    let words = superseded.length;
    while (nodeCount > words * 32) words *= 2;
    return words;
  }

  function rehash(slotCount: number): boolean {
    if (slotCount > MAX_SLOTS) return false;
    let next: Uint32Array;
    try {
      next = new Uint32Array(slotCount * 2);
    } catch (error) {
      if (error instanceof RangeError) return false;
      throw error;
    }
    const nextMask = slotCount - 1;
    for (let i = 0; i < slots.length; i += 2) {
      const entry = slots[i + 1];
      if (entry === 0) continue;
      const hash = slots[i];
      let j = hash & nextMask;
      while (next[j * 2 + 1] !== 0) j = (j + 1) & nextMask;
      next[j * 2] = hash;
      next[j * 2 + 1] = entry;
    }
    slots = next;
    mask = nextMask;
    return true;
  }

  function ensureSupersededCapacity(nodeCount: number): boolean {
    const words = supersededWordsAfter(nodeCount);
    if (words === superseded.length) return true;
    let next: Uint32Array;
    try {
      next = new Uint32Array(words);
    } catch (error) {
      if (error instanceof RangeError) return false;
      throw error;
    }
    next.set(superseded);
    superseded = next;
    return true;
  }

  return {
    get size() {
      return size;
    },

    get byteLength() {
      return slots.byteLength + superseded.byteLength;
    },

    byteLengthAfterStore(newState: boolean, nodeCount: number): number {
      const slotCount = slotCountAfter(size + (newState ? 1 : 0));
      return slotCount * 8 + supersededWordsAfter(nodeCount) * 4;
    },

    find(hash: number, robotCell: number, tokens: Uint16Array | Uint32Array): number {
      let i = hash & mask;
      for (;;) {
        const entry = slots[i * 2 + 1];
        if (entry === 0) return -1;
        if (slots[i * 2] === hash && arena.matchesState(entry - 1, robotCell, tokens)) {
          return entry - 1;
        }
        i = (i + 1) & mask;
      }
    },

    store(hash: number, node: number, previousNode: number): boolean {
      if (!ensureSupersededCapacity(node + 1)) return false;
      if (previousNode >= 0) {
        // The state is present: re-point its slot, found by node identity.
        let i = hash & mask;
        for (;;) {
          const entry = slots[i * 2 + 1];
          if (entry === 0) break;
          if (entry === previousNode + 1) {
            slots[i * 2 + 1] = node + 1;
            superseded[previousNode >>> 5] |= 1 << (previousNode & 31);
            return true;
          }
          i = (i + 1) & mask;
        }
        throw new Error("Exact state table lost a stored state.");
      }
      const slotCount = slotCountAfter(size + 1);
      if (slotCount !== mask + 1 && !rehash(slotCount)) return false;
      let i = hash & mask;
      while (slots[i * 2 + 1] !== 0) i = (i + 1) & mask;
      slots[i * 2] = hash;
      slots[i * 2 + 1] = node + 1;
      size += 1;
      return true;
    },

    isSuperseded(node: number): boolean {
      return (superseded[node >>> 5] & (1 << (node & 31))) !== 0;
    },
  };
}
