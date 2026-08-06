// Typed-array binary min-heap for unsigned 32-bit integer values with stable FIFO tie-breaking.
export class NumericPriorityQueue {
  readonly #compare: (a: number, b: number) => number;
  #values: Uint32Array;
  #sequences: Uint32Array;
  #size = 0;
  #nextSequence = 0;

  constructor(compare: (a: number, b: number) => number) {
    this.#compare = compare;
    this.#values = new Uint32Array(1024);
    this.#sequences = new Uint32Array(1024);
  }

  get size(): number {
    return this.#size;
  }

  get empty(): boolean {
    return this.#size === 0;
  }

  enqueue(value: number): void {
    if (this.#size === this.#values.length) {
      this.#grow();
    }
    this.#values[this.#size] = value;
    this.#sequences[this.#size] = this.#nextSequence;
    this.#nextSequence += 1;
    this.#siftUp(this.#size);
    this.#size += 1;
  }

  dequeue(): number | undefined {
    if (this.#size === 0) return undefined;
    const root = this.#values[0];
    this.#size -= 1;
    if (this.#size > 0) {
      this.#values[0] = this.#values[this.#size];
      this.#sequences[0] = this.#sequences[this.#size];
      this.#siftDown(0);
    }
    return root;
  }

  peek(): number | undefined {
    return this.#size === 0 ? undefined : this.#values[0];
  }

  clear(): void {
    this.#size = 0;
    this.#nextSequence = 0;
  }

  #grow(): void {
    const newCapacity = this.#values.length * 2;
    const newValues = new Uint32Array(newCapacity);
    const newSequences = new Uint32Array(newCapacity);
    newValues.set(this.#values);
    newSequences.set(this.#sequences);
    this.#values = newValues;
    this.#sequences = newSequences;
  }

  #compareAt(i: number, j: number): number {
    const cmp = this.#compare(this.#values[i], this.#values[j]);
    return cmp !== 0 ? cmp : this.#sequences[i] - this.#sequences[j];
  }

  #swap(i: number, j: number): void {
    const tv = this.#values[i];
    this.#values[i] = this.#values[j];
    this.#values[j] = tv;
    const ts = this.#sequences[i];
    this.#sequences[i] = this.#sequences[j];
    this.#sequences[j] = ts;
  }

  #siftUp(startIndex: number): void {
    let index = startIndex;
    while (index > 0) {
      const parentIndex = (index - 1) >> 1;
      if (this.#compareAt(index, parentIndex) >= 0) return;
      this.#swap(index, parentIndex);
      index = parentIndex;
    }
  }

  #siftDown(startIndex: number): void {
    let index = startIndex;
    for (;;) {
      const leftIndex = index * 2 + 1;
      if (leftIndex >= this.#size) return;
      const rightIndex = leftIndex + 1;
      let bestIndex = index;

      if (this.#compareAt(leftIndex, bestIndex) < 0) {
        bestIndex = leftIndex;
      }
      if (rightIndex < this.#size && this.#compareAt(rightIndex, bestIndex) < 0) {
        bestIndex = rightIndex;
      }

      if (bestIndex === index) return;
      this.#swap(index, bestIndex);
      index = bestIndex;
    }
  }
}
