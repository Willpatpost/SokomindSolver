// State identity, box signatures, dense box layouts, and core constants.
// Part of the Sokomind solver engine. Functions are bare globals for
// cross-module compatibility. The namespace object is registered for new usage.

const DIRS = {Up: [-1, 0], Down: [1, 0], Left: [0, -1], Right: [0, 1]};
const DIRECTION_ENTRIES = Object.entries(DIRS);
const OPPOSITE_DIRECTION_INDEX = [1, 0, 3, 2];
const OPPOSITE = {Up: "Down", Down: "Up", Left: "Right", Right: "Left"};
const MOVE_CODE = {Up: "U", Down: "D", Left: "L", Right: "R"};
const pkey = (y, x) => `${y},${x}`;
function cellId(y, x, dense) {
  const index = y * dense.width + x;
  return (index >= 0 && index < dense.idByYX.length) ? dense.idByYX[index] : -1;
}
function boxSignatureReference(boxes) {
  return boxes.map(box => box.join(",")).sort().join(";");
}

function packedIdentityFromTokens(tokens, board) {
  const sorted = Uint32Array.from(tokens);
  sorted.sort();
  board.metrics.tokenFullSorts++;
  const shift = BigInt(board.dense.tokenBits);
  let identity = BigInt(tokens.length);
  for (const value of sorted) identity = (identity << shift) | BigInt(value);
  const {zobristHi, zobristLo} = board.dense;
  let zHi = 0, zLo = 0;
  for (let i = 0; i < tokens.length; i++) {
    zHi = (zHi ^ zobristHi[tokens[i]]) >>> 0;
    zLo = (zLo ^ zobristLo[tokens[i]]) >>> 0;
  }
  board.metrics.zobristFullRecomputations++;
  return {
    identity,
    zobristHi: zHi,
    zobristLo: zLo,
    sortedTokens: sorted,
    signature: [...sorted].map(value => value.toString(36)).join("."),
  };
}

function packedIdentityIncremental(parentPacked, oldToken, newToken, board) {
  const parentSorted = parentPacked.sortedTokens;
  const sorted = new Uint32Array(parentSorted.length);
  board.metrics.tokenIncrementalInsertions++;

  let removePos = 0;
  let lo = 0, hi = parentSorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (parentSorted[mid] < oldToken) lo = mid + 1;
    else if (parentSorted[mid] > oldToken) hi = mid - 1;
    else { removePos = mid; break; }
  }

  let insertPos = 0;
  const len = parentSorted.length - 1;
  lo = 0; hi = len - 1;
  let tempIdx = 0;
  for (let i = 0; i < parentSorted.length; i++) {
    if (i === removePos) continue;
    sorted[tempIdx++] = parentSorted[i];
  }

  lo = 0; hi = tempIdx - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < newToken) lo = mid + 1;
    else hi = mid - 1;
  }
  insertPos = lo;

  for (let i = tempIdx; i > insertPos; i--) sorted[i] = sorted[i - 1];
  sorted[insertPos] = newToken;

  const shift = BigInt(board.dense.tokenBits);
  let identity = BigInt(sorted.length);
  for (const value of sorted) identity = (identity << shift) | BigInt(value);

  const {zobristHi, zobristLo} = board.dense;
  const zHi = (parentPacked.zobristHi ^ zobristHi[oldToken] ^ zobristHi[newToken]) >>> 0;
  const zLo = (parentPacked.zobristLo ^ zobristLo[oldToken] ^ zobristLo[newToken]) >>> 0;
  board.metrics.zobristIncrementalUpdates++;

  return {
    identity,
    zobristHi: zHi,
    zobristLo: zLo,
    sortedTokens: sorted,
    signature: [...sorted].map(value => value.toString(36)).join("."),
  };
}

function denseBoxLayout(boxes, board) {
  const cached = board.denseBoxMemo.get(boxes);
  if (cached) return cached;
  const cells = new Uint32Array(boxes.length);
  const labels = new Uint16Array(boxes.length);
  const tokens = new Uint32Array(boxes.length);
  const indexByCell = new Int32Array(board.dense.keys.length);
  const occupancyBits = new Uint32Array(Math.ceil(board.dense.keys.length / 32));
  indexByCell.fill(-1);
  let valid = true;
  for (let index = 0; index < boxes.length; index++) {
    const [y, x, label] = boxes[index];
    const cell = cellId(y, x, board.dense);
    const labelId = board.dense.labelIds.get(label);
    if (cell < 0 || labelId === undefined) {
      valid = false;
      continue;
    }
    cells[index] = cell;
    labels[index] = labelId;
    tokens[index] = labelId * board.dense.keys.length + cell;
    indexByCell[cell] = index;
    occupancyBits[cell >>> 5] |= 1 << (cell & 31);
  }
  const packed = valid
    ? packedIdentityFromTokens(tokens, board)
    : {identity: null, sortedTokens: null, signature: boxSignatureReference(boxes)};
  const layout = {
    cells,
    labels,
    tokens,
    orderedSignature: tokens.join("."),
    indexByCell,
    occupancyBits,
    valid,
    ...packed,
  };
  board.denseBoxMemo.set(boxes, layout);
  board.metrics.denseLayoutBuilds++;
  board.metrics.occupancyWordsBuilt += occupancyBits.length;
  return layout;
}

function ensureIndexByCell(layout, board) {
  if (layout.indexByCell) return layout.indexByCell;
  const indexByCell = new Int32Array(board.dense.keys.length);
  indexByCell.fill(-1);
  for (let i = 0; i < layout.cells.length; i++) {
    indexByCell[layout.cells[i]] = i;
  }
  layout.indexByCell = indexByCell;
  board.metrics.workspaceAllocations++;
  return indexByCell;
}

function deriveDenseBoxLayout(parentBoxes, boxes, changedIndex, destinationId, board) {
  const parent = denseBoxLayout(parentBoxes, board);
  if (!parent.valid) {
    denseBoxLayout(boxes, board);
    return;
  }
  const cells = parent.cells.slice();
  const labels = parent.labels;
  const tokens = parent.tokens.slice();
  const previousId = cells[changedIndex];
  const oldToken = tokens[changedIndex];
  cells[changedIndex] = destinationId;
  const newToken = labels[changedIndex] * board.dense.keys.length + destinationId;
  tokens[changedIndex] = newToken;
  const packed = packedIdentityIncremental(parent, oldToken, newToken, board);
  board.denseBoxMemo.set(boxes, {
    cells,
    labels,
    tokens,
    orderedSignature: tokens.join("."),
    indexByCell: null,
    occupancyBits: null,
    valid: true,
    ...packed,
  });
  board.metrics.denseLayoutDerivations++;
  board.metrics.denseIdentityUpdates++;
  board.metrics.workspacePoolReuses++;
}

function cachedPushedBoxes(parentBoxes, changedIndex, destinationId, label, board) {
  const parentLayout = denseBoxLayout(parentBoxes, board);
  const key = `${parentLayout.orderedSignature}|${changedIndex}|${destinationId}`;
  const cached = memoLookup(board.pushTransitionMemo, key);
  if (cached) {
    board.metrics.denseTransitionCacheHits++;
    return cached;
  }
  const boxes = parentBoxes.slice();
  boxes[changedIndex] = [
    board.dense.y[destinationId],
    board.dense.x[destinationId],
    label,
  ];
  deriveDenseBoxLayout(parentBoxes, boxes, changedIndex, destinationId, board);
  const prevEvictions = board.pushTransitionMemo.evictions || 0;
  board.pushTransitionMemo.set(key, boxes);
  const newEvictions = board.pushTransitionMemo.evictions || 0;
  board.metrics.denseTransitionCacheEvictions += newEvictions - prevEvictions;
  return boxes;
}

function boxSignature(boxes, board = null) {
  const metrics = board?.metrics;
  if (metrics) metrics.signatureCalls++;
  if (board?.boxSignatureMemo.has(boxes)) {
    metrics.signatureCacheHits++;
    return board.boxSignatureMemo.get(boxes);
  }
  const started = metrics ? now() : 0;
  let signature = null;
  if (board) {
    signature = denseBoxLayout(boxes, board).signature;
  }
  signature ??= boxSignatureReference(boxes);
  if (board) board.boxSignatureMemo.set(boxes, signature);
  if (metrics) {
    metrics.signatureMs += now() - started;
    metrics.signatureCharacters += signature.length;
  }
  return signature;
}

function packedBoxIdentity(boxes, board) {
  const metrics = board.metrics;
  metrics.packedIdentityCalls++;
  if (board.boxIdentityMemo.has(boxes)) {
    metrics.packedIdentityCacheHits++;
    return board.boxIdentityMemo.get(boxes);
  }
  const layout = denseBoxLayout(boxes, board);
  if (!layout.valid) {
    throw new Error("Cannot densely encode a box outside the prepared board.");
  }
  const identity = layout.identity;
  board.boxIdentityMemo.set(boxes, identity);
  metrics.packedIdentityValues += layout.tokens.length;
  return identity;
}

function denseStateIdentity(state, board, robotId) {
  if (robotId === undefined || robotId < 0) return exactPushKey(state, board);
  return (packedBoxIdentity(state.boxes, board) << BigInt(board.dense.cellBits)) |
    BigInt(robotId);
}

function exactPushIdentity(state, board) {
  const robotId = cellId(state.robot[0], state.robot[1], board.dense);
  return denseStateIdentity(state, board, robotId >= 0 ? robotId : undefined);
}

function pushIdentity(state, reachable) {
  if (reachable.board && reachable.regionId !== undefined) {
    return denseStateIdentity(state, reachable.board, reachable.regionId);
  }
  return pushKey(state, reachable);
}

function exactPushKey(state, board = null) {
  const robotId = board?.dense ? cellId(state.robot[0], state.robot[1], board.dense) : -1;
  const robot = robotId < 0 ? state.robot.join(",") : robotId.toString(36);
  return `${robot}|${boxSignature(state.boxes, board)}`;
}

// --- Module registration ---
const SokomindState = {
  DIRS,
  DIRECTION_ENTRIES,
  OPPOSITE_DIRECTION_INDEX,
  OPPOSITE,
  MOVE_CODE,
  pkey,
  cellId,
  boxSignatureReference,
  packedIdentityFromTokens,
  packedIdentityIncremental,
  denseBoxLayout,
  deriveDenseBoxLayout,
  ensureIndexByCell,
  cachedPushedBoxes,
  boxSignature,
  packedBoxIdentity,
  denseStateIdentity,
  exactPushIdentity,
  pushIdentity,
  exactPushKey,
};
if (typeof globalThis !== "undefined") globalThis.SokomindState = SokomindState;
if (typeof module === "object" && module.exports) module.exports = SokomindState;
