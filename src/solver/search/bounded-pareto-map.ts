export interface SearchPair {
  readonly pushes: number;
  readonly moves: number;
}

function searchPairDominates(
  leftPushes: number,
  leftMoves: number,
  rightPushes: number,
  rightMoves: number,
): boolean {
  return leftPushes <= rightPushes && leftMoves <= rightMoves;
}

function compareSearchPair(left: SearchPair, right: SearchPair): number {
  return left.pushes - right.pushes || left.moves - right.moves;
}

export function boundedParetoRecords(
  records: SearchPair[],
  limit: number,
): SearchPair[] {
  if (records.length <= limit) return records;
  const ranked = [...records].sort(compareSearchPair);
  if (limit <= 1) return ranked.slice(0, 1);
  const selected: SearchPair[] = [ranked[0]];
  const minimumMoves = [...ranked].sort(
    (left, right) =>
      left.moves - right.moves || left.pushes - right.pushes,
  )[0];
  if (minimumMoves !== ranked[0]) selected.push(minimumMoves);
  for (const record of ranked) {
    if (selected.length >= limit) break;
    if (!selected.includes(record)) selected.push(record);
  }
  return selected;
}

export class BoundedParetoMap {
  readonly limit: number;
  readonly perKeyLimit: number;
  readonly values: Map<string, SearchPair[]>;
  evictions: number;

  constructor(limit: number, perKeyLimit = 3) {
    this.limit = Math.max(1, limit);
    this.perKeyLimit = Math.max(1, perKeyLimit);
    this.values = new Map();
    this.evictions = 0;
  }

  private _records(key: string): SearchPair[] {
    const records = this.values.get(key);
    if (records !== undefined) {
      this.values.delete(key);
      this.values.set(key, records);
    }
    return records ?? [];
  }

  isDominated(key: string, pushes: number, moves: number): boolean {
    return this._records(key).some((record) =>
      searchPairDominates(record.pushes, record.moves, pushes, moves),
    );
  }

  hasPair(key: string, pushes: number, moves: number): boolean {
    return this._records(key).some(
      (record) => record.pushes === pushes && record.moves === moves,
    );
  }

  set(key: string, pushes: number, moves: number): boolean {
    const records = this._records(key);
    if (
      records.some((record) =>
        searchPairDominates(record.pushes, record.moves, pushes, moves),
      )
    )
      return false;
    const retained = records.filter(
      (record) =>
        !searchPairDominates(pushes, moves, record.pushes, record.moves),
    );
    retained.push({ pushes, moves });
    const bounded = boundedParetoRecords(retained, this.perKeyLimit);
    this.values.set(key, bounded);
    while (this.values.size > this.limit) {
      this.values.delete(this.values.keys().next().value!);
      this.evictions++;
    }
    return bounded.some(
      (record) => record.pushes === pushes && record.moves === moves,
    );
  }

  get size(): number {
    return this.values.size;
  }
}
