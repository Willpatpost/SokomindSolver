// Chunked typed-array arena for Sokoban exact A* search nodes.

const CHUNK_BITS = 13;
const CHUNK_SIZE = 1 << CHUNK_BITS;
const CHUNK_MASK = CHUNK_SIZE - 1;
const MAX_STORED_HEURISTIC = 0xffff;

export interface CompactNodeArena {
  readonly size: number;
  readonly boxCount: number;
  allocate(): number;

  robotCell(index: number): number;
  setRobotCell(index: number, value: number): void;
  gMoves(index: number): number;
  setGMoves(index: number, value: number): void;
  pushes(index: number): number;
  setPushes(index: number, value: number): void;
  parentNode(index: number): number;
  setParentNode(index: number, value: number): void;
  pushedFromCell(index: number): number;
  setPushedFromCell(index: number, value: number): void;
  pushDirection(index: number): number;
  setPushDirection(index: number, value: number): void;
  heuristic(index: number): number;
  /** Values above 65535 are stored as 65535. */
  setHeuristic(index: number, value: number): void;
  /** False unless the arena was created with `pendingExtras`. */
  extrasPending(index: number): boolean;
  setExtrasPending(index: number, value: boolean): void;

  readBoxTokens(index: number, out: Uint16Array | Uint32Array): void;
  writeBoxTokens(index: number, tokens: Uint16Array | Uint32Array): void;
  boxTokenAt(index: number, boxIndex: number): number;
  /** True when the node has exactly this robot cell and sorted box tokens. */
  matchesState(index: number, robotCell: number, tokens: Uint16Array | Uint32Array): boolean;

  estimatedRetainedBytes(): number;
  /** Includes a whole new chunk when the next allocation needs one. */
  estimatedRetainedBytesAfterAllocation(): number;
  estimatedBytesPerNode(): number;
}

function chunkGet(chunks: ArrayLike<number>[], index: number): number {
  return chunks[index >>> CHUNK_BITS]![index & CHUNK_MASK]!;
}

function chunkSet(chunks: { [i: number]: number }[], index: number, value: number): void {
  chunks[index >>> CHUNK_BITS]![index & CHUNK_MASK] = value;
}

export interface CompactNodeArenaOptions {
  /** Keeps one byte per node marking an h that still lacks the extras. */
  readonly pendingExtras?: boolean;
}

export function createCompactNodeArena(
  boxCount: number,
  maxToken?: number,
  options: CompactNodeArenaOptions = {},
): CompactNodeArena {
  const useWideTokens = maxToken !== undefined && maxToken > 65535;
  const bytesPerToken = useWideTokens ? 4 : 2;
  const pendingExtras = options.pendingExtras === true;
  // robot 2 + g 4 + pushes 2 + parent 4 + pushed-from 2 + direction 1 + h 2.
  const scalarBytesPerNode = 17 + (pendingExtras ? 1 : 0);

  const robotCellChunks: Uint16Array[] = [];
  const gMovesChunks: Uint32Array[] = [];
  const pushesChunks: Uint16Array[] = [];
  const parentNodeChunks: Int32Array[] = [];
  const pushedFromCellChunks: Uint16Array[] = [];
  const pushDirectionChunks: Uint8Array[] = [];
  const heuristicChunks: Uint16Array[] = [];
  const pendingChunks: Uint8Array[] = [];
  const boxTokenChunks: (Uint16Array | Uint32Array)[] = [];

  let _size = 0;
  let capacity = 0;

  function grow(): void {
    robotCellChunks.push(new Uint16Array(CHUNK_SIZE));
    gMovesChunks.push(new Uint32Array(CHUNK_SIZE));
    pushesChunks.push(new Uint16Array(CHUNK_SIZE));
    parentNodeChunks.push(new Int32Array(CHUNK_SIZE));
    pushedFromCellChunks.push(new Uint16Array(CHUNK_SIZE));
    pushDirectionChunks.push(new Uint8Array(CHUNK_SIZE));
    heuristicChunks.push(new Uint16Array(CHUNK_SIZE));
    if (pendingExtras) pendingChunks.push(new Uint8Array(CHUNK_SIZE));
    const tokenChunkLen = CHUNK_SIZE * boxCount;
    boxTokenChunks.push(
      useWideTokens ? new Uint32Array(tokenChunkLen) : new Uint16Array(tokenChunkLen),
    );
    capacity += CHUNK_SIZE;
  }

  const arena: CompactNodeArena = {
    get size() {
      return _size;
    },

    boxCount,

    allocate(): number {
      const idx = _size++;
      if (idx >= capacity) {
        grow();
      }
      return idx;
    },

    robotCell(index: number): number {
      return chunkGet(robotCellChunks, index);
    },
    setRobotCell(index: number, value: number): void {
      chunkSet(robotCellChunks, index, value);
    },

    gMoves(index: number): number {
      return chunkGet(gMovesChunks, index);
    },
    setGMoves(index: number, value: number): void {
      chunkSet(gMovesChunks, index, value);
    },

    pushes(index: number): number {
      return chunkGet(pushesChunks, index);
    },
    setPushes(index: number, value: number): void {
      chunkSet(pushesChunks, index, value);
    },

    parentNode(index: number): number {
      return chunkGet(parentNodeChunks, index);
    },
    setParentNode(index: number, value: number): void {
      chunkSet(parentNodeChunks, index, value);
    },

    pushedFromCell(index: number): number {
      return chunkGet(pushedFromCellChunks, index);
    },
    setPushedFromCell(index: number, value: number): void {
      chunkSet(pushedFromCellChunks, index, value);
    },

    pushDirection(index: number): number {
      return chunkGet(pushDirectionChunks, index);
    },
    setPushDirection(index: number, value: number): void {
      chunkSet(pushDirectionChunks, index, value);
    },

    heuristic(index: number): number {
      return chunkGet(heuristicChunks, index);
    },
    setHeuristic(index: number, value: number): void {
      // h is stored in 16 bits. Saturating keeps it a lower bound, unlike a wrap.
      chunkSet(heuristicChunks, index, value > MAX_STORED_HEURISTIC ? MAX_STORED_HEURISTIC : value);
    },

    extrasPending(index: number): boolean {
      return pendingExtras && chunkGet(pendingChunks, index) !== 0;
    },
    setExtrasPending(index: number, value: boolean): void {
      if (pendingExtras) chunkSet(pendingChunks, index, value ? 1 : 0);
    },

    readBoxTokens(index: number, out: Uint16Array | Uint32Array): void {
      const ci = index >>> CHUNK_BITS;
      const baseOffset = (index & CHUNK_MASK) * boxCount;
      const chunk = boxTokenChunks[ci];
      for (let b = 0; b < boxCount; b++) {
        out[b] = chunk[baseOffset + b];
      }
    },

    writeBoxTokens(index: number, tokens: Uint16Array | Uint32Array): void {
      const ci = index >>> CHUNK_BITS;
      const baseOffset = (index & CHUNK_MASK) * boxCount;
      const chunk = boxTokenChunks[ci];
      for (let b = 0; b < boxCount; b++) {
        chunk[baseOffset + b] = tokens[b];
      }
    },

    boxTokenAt(index: number, boxIndex: number): number {
      const ci = index >>> CHUNK_BITS;
      const baseOffset = (index & CHUNK_MASK) * boxCount;
      return boxTokenChunks[ci][baseOffset + boxIndex];
    },

    matchesState(index: number, robotCell: number, tokens: Uint16Array | Uint32Array): boolean {
      if (chunkGet(robotCellChunks, index) !== robotCell) return false;
      const chunk = boxTokenChunks[index >>> CHUNK_BITS];
      const baseOffset = (index & CHUNK_MASK) * boxCount;
      for (let b = 0; b < boxCount; b++) {
        if (chunk[baseOffset + b] !== tokens[b]) return false;
      }
      return true;
    },

    estimatedRetainedBytes(): number {
      const numChunks = robotCellChunks.length;
      const scalarBytes = numChunks * CHUNK_SIZE * scalarBytesPerNode;
      const tokenBytes = numChunks * CHUNK_SIZE * boxCount * bytesPerToken;
      return scalarBytes + tokenBytes;
    },

    estimatedRetainedBytesAfterAllocation(): number {
      const nextCapacity = _size < capacity ? capacity : capacity + CHUNK_SIZE;
      return nextCapacity * (scalarBytesPerNode + boxCount * bytesPerToken);
    },

    estimatedBytesPerNode(): number {
      return scalarBytesPerNode + boxCount * bytesPerToken;
    },
  };

  return arena;
}
