/**
 * A deterministic binary min-heap.
 *
 * The caller supplies the semantic ordering. Entries that compare equally are
 * removed in insertion order, which keeps solver runs reproducible without
 * forcing every strategy to manufacture a final tie-break field.
 *
 * Values and sequence numbers are stored in parallel arrays to avoid
 * per-entry object allocation.
 */
export class StablePriorityQueue<T> {
  readonly #compare: (left: T, right: T) => number;
  readonly #values: T[] = [];
  readonly #sequences: number[] = [];
  #nextSequence = 0;

  constructor(compare: (left: T, right: T) => number) {
    this.#compare = compare;
  }

  get size(): number {
    return this.#values.length;
  }

  get empty(): boolean {
    return this.#values.length === 0;
  }

  clear(): void {
    this.#values.length = 0;
    this.#sequences.length = 0;
  }

  enqueue(value: T): void {
    this.#values.push(value);
    this.#sequences.push(this.#nextSequence);
    this.#nextSequence += 1;
    this.#siftUp(this.#values.length - 1);
  }

  peek(): T | undefined {
    return this.#values[0];
  }

  dequeue(): T | undefined {
    const length = this.#values.length;
    if (length === 0) return undefined;
    const root = this.#values[0];

    if (length > 1) {
      this.#values[0] = this.#values[length - 1];
      this.#sequences[0] = this.#sequences[length - 1];
    }
    this.#values.length = length - 1;
    this.#sequences.length = length - 1;
    if (this.#values.length > 0) {
      this.#siftDown(0);
    }
    return root;
  }

  #compareAt(i: number, j: number): number {
    const compared = this.#compare(this.#values[i], this.#values[j]);
    return compared === 0
      ? this.#sequences[i] - this.#sequences[j]
      : compared;
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
    const length = this.#values.length;
    let index = startIndex;
    for (;;) {
      const leftIndex = index * 2 + 1;
      if (leftIndex >= length) return;
      const rightIndex = leftIndex + 1;
      let bestIndex = index;

      if (this.#compareAt(leftIndex, bestIndex) < 0) {
        bestIndex = leftIndex;
      }
      if (rightIndex < length && this.#compareAt(rightIndex, bestIndex) < 0) {
        bestIndex = rightIndex;
      }

      if (bestIndex === index) return;
      this.#swap(index, bestIndex);
      index = bestIndex;
    }
  }
}

/** Lexicographic comparison for deterministic objective and heuristic tuples. */
export function compareNumberTuples(
  left: readonly number[],
  right: readonly number[],
): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? Number.NEGATIVE_INFINITY;
    const rightValue = right[index] ?? Number.NEGATIVE_INFINITY;
    if (leftValue < rightValue) return -1;
    if (leftValue > rightValue) return 1;
  }
  return 0;
}
