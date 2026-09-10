export interface ArrivalCandidate {
  readonly exactIdentity: string;
  readonly cost: number;
  readonly moves: number;
  readonly score: number;
  readonly approachDistance: number;
  readonly approachSide: string;
}

export interface ArrivalRecord {
  readonly exactIdentity: string;
  readonly cost: number;
  readonly moves: number;
  readonly score: number;
  readonly approachDistance: number;
  readonly approachSide: string;
  readonly token: string;
}

function searchPairDominates(
  leftCost: number,
  leftMoves: number,
  rightCost: number,
  rightMoves: number,
): boolean {
  return leftCost <= rightCost && leftMoves <= rightMoves;
}

export function selectKeeperArrivals(
  records: ArrivalRecord[],
  limit: number,
): ArrivalRecord[] {
  if (records.length <= limit) return records;
  const selected: ArrivalRecord[] = [];
  const add = (record: ArrivalRecord | undefined): void => {
    if (record && !selected.includes(record) && selected.length < limit) {
      selected.push(record);
    }
  };

  add(
    [...records].sort(
      (left, right) =>
        left.cost - right.cost ||
        left.moves - right.moves ||
        left.approachDistance - right.approachDistance ||
        left.exactIdentity.localeCompare(right.exactIdentity),
    )[0],
  );

  add(
    [...records].sort(
      (left, right) =>
        left.moves +
        left.approachDistance -
        (right.moves + right.approachDistance) ||
        left.cost - right.cost ||
        left.exactIdentity.localeCompare(right.exactIdentity),
    )[0],
  );

  const representedSides = new Set(
    selected.map((record) => record.approachSide),
  );
  for (const record of [...records].sort(
    (left, right) =>
      left.cost - right.cost ||
      left.moves +
      left.approachDistance -
      (right.moves + right.approachDistance) ||
      left.exactIdentity.localeCompare(right.exactIdentity),
  )) {
    if (selected.length >= limit) break;
    if (representedSides.has(record.approachSide)) continue;
    representedSides.add(record.approachSide);
    add(record);
  }

  for (const record of [...records].sort(
    (left, right) =>
      left.cost - right.cost ||
      left.moves +
      left.approachDistance -
      (right.moves + right.approachDistance) ||
      left.score - right.score ||
      left.exactIdentity.localeCompare(right.exactIdentity),
  ))
    add(record);

  return selected;
}

export class BoundedKeeperArrivalMap {
  readonly limit: number;
  readonly perKeyLimit: number;
  readonly values: Map<string, ArrivalRecord[]>;
  evictions: number;

  constructor(limit: number, perKeyLimit = 4) {
    this.limit = Math.max(1, limit);
    this.perKeyLimit = Math.max(1, perKeyLimit);
    this.values = new Map();
    this.evictions = 0;
  }

  private _records(key: string): ArrivalRecord[] {
    const records = this.values.get(key);
    if (records !== undefined) {
      this.values.delete(key);
      this.values.set(key, records);
    }
    return records ?? [];
  }

  private _candidateRecord(candidate: ArrivalCandidate): ArrivalRecord {
    return {
      exactIdentity: candidate.exactIdentity,
      cost: candidate.cost,
      moves: candidate.moves,
      score: candidate.score,
      approachDistance: candidate.approachDistance,
      approachSide: candidate.approachSide,
      token: `${candidate.exactIdentity}|${candidate.cost}|${candidate.moves}`,
    };
  }

  wouldRetain(key: string, candidate: ArrivalCandidate): boolean {
    const records = this._records(key);
    if (
      records.some(
        (record) =>
          record.exactIdentity === candidate.exactIdentity &&
          searchPairDominates(
            record.cost,
            record.moves,
            candidate.cost,
            candidate.moves,
          ),
      )
    ) {
      return false;
    }
    const next = records.filter(
      (record) =>
        !(
          record.exactIdentity === candidate.exactIdentity &&
          searchPairDominates(
            candidate.cost,
            candidate.moves,
            record.cost,
            record.moves,
          )
        ),
    );
    const added = this._candidateRecord(candidate);
    next.push(added);
    return selectKeeperArrivals(next, this.perKeyLimit).some(
      (record) => record.token === added.token,
    );
  }

  set(key: string, candidate: ArrivalCandidate): void {
    const records = this._records(key).filter(
      (record) =>
        !(
          record.exactIdentity === candidate.exactIdentity &&
          searchPairDominates(
            candidate.cost,
            candidate.moves,
            record.cost,
            record.moves,
          )
        ),
    );
    const added = this._candidateRecord(candidate);
    if (!records.some((record) => record.token === added.token))
      records.push(added);
    this.values.set(key, selectKeeperArrivals(records, this.perKeyLimit));
    while (this.values.size > this.limit) {
      this.values.delete(this.values.keys().next().value!);
      this.evictions++;
    }
  }

  get size(): number {
    return this.values.size;
  }
}
