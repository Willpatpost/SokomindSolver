// Chunked typed-array arena for Sokoban exact A* search nodes.

const CHUNK_BITS = 13;
const CHUNK_SIZE = 1 << CHUNK_BITS;
const CHUNK_MASK = CHUNK_SIZE - 1;

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
  setHeuristic(index: number, value: number): void;

  readBoxTokens(index: number, out: Uint16Array | Uint32Array): void;
  writeBoxTokens(index: number, tokens: Uint16Array | Uint32Array): void;
  boxTokenAt(index: number, boxIndex: number): number;

  estimatedRetainedBytes(): number;
  estimatedBytesPerNode(): number;
}

function chunkGet(chunks: ArrayLike<number>[], index: number): number {
  return chunks[index >>> CHUNK_BITS]![index & CHUNK_MASK]!;
}

function chunkSet(chunks: { [i: number]: number }[], index: number, value: number): void {
  chunks[index >>> CHUNK_BITS]![index & CHUNK_MASK] = value;
}

export function createCompactNodeArena(boxCount: number, maxToken?: number): CompactNodeArena {
  const useWideTokens = maxToken !== undefined && maxToken > 65535;
  const bytesPerToken = useWideTokens ? 4 : 2;

  const robotCellChunks: Uint16Array[] = [];
  const gMovesChunks: Uint32Array[] = [];
  const pushesChunks: Uint16Array[] = [];
  const parentNodeChunks: Int32Array[] = [];
  const pushedFromCellChunks: Uint16Array[] = [];
  const pushDirectionChunks: Uint8Array[] = [];
  const heuristicChunks: Uint16Array[] = [];
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
      chunkSet(heuristicChunks, index, value);
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

    estimatedRetainedBytes(): number {
      const numChunks = robotCellChunks.length;
      const scalarBytes =
        numChunks *
        CHUNK_SIZE *
        (2 + 4 + 2 + 4 + 2 + 1 + 2);
      const tokenBytes = numChunks * CHUNK_SIZE * boxCount * bytesPerToken;
      return scalarBytes + tokenBytes;
    },

    estimatedBytesPerNode(): number {
      return 17 + boxCount * bytesPerToken;
    },
  };

  return arena;
}
