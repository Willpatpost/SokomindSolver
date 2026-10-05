/**
 * Exact move bounds shared between the A* lanes of one proof run. An entry is
 * keyed by the whole exact state, the robot cell plus the sorted box tokens,
 * and keys are compared in full, so a lookup never returns another state's
 * bound. A state's cost to the goal is the same in every lane, so a bound
 * that is admissible in the lane that computed it is admissible in all.
 */
export interface ExactHeuristicShare {
  /** The bound held for the state, or -1 when none is held. */
  lookup(robotCell: number, tokens: ArrayLike<number>): number;
  /** Offers a finite bound the lane computed in full for the state. */
  offer(robotCell: number, tokens: ArrayLike<number>, h: number): void;
  readonly retainedBytes: number;
}

/** Bounds are stored as u16; a larger one is kept as this, which only lowers it. */
export const SHARED_HEURISTIC_MAX_H = 0xffff;

const INITIAL_SLOTS = 1 << 12;
const PROBE_WINDOW = 4;

/**
 * A bounded open-addressing table of exact-state bounds. It starts small and
 * doubles while it is over half full and the doubled table fits its byte
 * budget. Past that, a new state whose probe window is full replaces the
 * entry at its home slot. Slots never empty again, so an empty slot ends a
 * probe. A state stored twice keeps the larger bound.
 */
export class SharedHeuristicTable {
  readonly #boxCount: number;
  /** Words per key: the robot cell + 1 (0 marks an empty slot), then the tokens. */
  readonly #stride: number;
  readonly #maxSlots: number;
  #mask: number;
  #keys: Uint32Array;
  #values: Uint16Array;
  #count = 0;

  constructor(boxCount: number, maxBytes: number) {
    this.#boxCount = boxCount;
    this.#stride = boxCount + 1;
    const slotBytes = this.#stride * 4 + 2;
    let maxSlots = INITIAL_SLOTS;
    while (maxSlots * 2 * slotBytes <= maxBytes) maxSlots *= 2;
    this.#maxSlots = maxSlots;
    this.#mask = INITIAL_SLOTS - 1;
    this.#keys = new Uint32Array(INITIAL_SLOTS * this.#stride);
    this.#values = new Uint16Array(INITIAL_SLOTS);
  }

  get size(): number {
    return this.#count;
  }

  get retainedBytes(): number {
    return this.#keys.byteLength + this.#values.byteLength;
  }

  lookup(robotCell: number, tokens: ArrayLike<number>): number {
    const keys = this.#keys;
    const stride = this.#stride;
    const home = this.#hash(robotCell, tokens);
    for (let probe = 0; probe < PROBE_WINDOW; probe++) {
      const slot = (home + probe) & this.#mask;
      const base = slot * stride;
      if (keys[base] === 0) return -1;
      if (this.#matches(base, robotCell, tokens)) return this.#values[slot];
    }
    return -1;
  }

  insert(robotCell: number, tokens: ArrayLike<number>, h: number): void {
    const tag = robotCell + 1;
    if (!(tag >= 1 && tag <= 0xffffffff) || !(h >= 0)) return;
    if (this.#count * 2 >= this.#mask + 1 && this.#mask + 1 < this.#maxSlots) {
      this.#grow();
    }
    this.#place(tag, tokens, Math.min(h, SHARED_HEURISTIC_MAX_H));
  }

  #place(tag: number, tokens: ArrayLike<number>, value: number): void {
    const keys = this.#keys;
    const stride = this.#stride;
    const home = this.#hash(tag - 1, tokens);
    for (let probe = 0; probe < PROBE_WINDOW; probe++) {
      const slot = (home + probe) & this.#mask;
      const base = slot * stride;
      if (keys[base] === 0) {
        this.#write(slot, tag, tokens, value);
        this.#count += 1;
        return;
      }
      if (this.#matches(base, tag - 1, tokens)) {
        if (value > this.#values[slot]) this.#values[slot] = value;
        return;
      }
    }
    this.#write(home & this.#mask, tag, tokens, value);
  }

  #write(slot: number, tag: number, tokens: ArrayLike<number>, value: number): void {
    const base = slot * this.#stride;
    this.#keys[base] = tag;
    for (let i = 0; i < this.#boxCount; i++) this.#keys[base + 1 + i] = tokens[i];
    this.#values[slot] = value;
  }

  #matches(base: number, robotCell: number, tokens: ArrayLike<number>): boolean {
    const keys = this.#keys;
    if (keys[base] !== robotCell + 1) return false;
    for (let i = 0; i < this.#boxCount; i++) {
      if (keys[base + 1 + i] !== tokens[i]) return false;
    }
    return true;
  }

  #grow(): void {
    const oldKeys = this.#keys;
    const oldValues = this.#values;
    const stride = this.#stride;
    const slots = (this.#mask + 1) * 2;
    this.#mask = slots - 1;
    this.#keys = new Uint32Array(slots * stride);
    this.#values = new Uint16Array(slots);
    this.#count = 0;
    const tokens = new Uint32Array(this.#boxCount);
    for (let slot = 0; slot < oldValues.length; slot++) {
      const base = slot * stride;
      const tag = oldKeys[base];
      if (tag === 0) continue;
      for (let i = 0; i < this.#boxCount; i++) tokens[i] = oldKeys[base + 1 + i];
      this.#place(tag, tokens, oldValues[slot]);
    }
  }

  #hash(robotCell: number, tokens: ArrayLike<number>): number {
    let h = Math.imul(robotCell + 1, 0x9e3779b1);
    for (let i = 0; i < this.#boxCount; i++) {
      h = Math.imul(h ^ tokens[i], 0x85ebca6b);
      h ^= h >>> 15;
    }
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
  }
}
