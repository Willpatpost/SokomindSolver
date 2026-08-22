// Deadlock detection: corner, static dead, 2x2, frozen component, closed diagonal, pattern database, and dynamic.
// Part of the Sokomind solver engine. Functions are bare globals for
// cross-module compatibility. The namespace object is registered for new usage.

function corner(y, x, board, label) {
  if (board.goals.get(pkey(y, x)) === label) return false;
  const wall = (dy, dx) => board.walls.has(pkey(y + dy, x + dx));
  return (wall(-1, 0) && wall(0, -1)) || (wall(-1, 0) && wall(0, 1)) ||
    (wall(1, 0) && wall(0, -1)) || (wall(1, 0) && wall(0, 1));
}
function staticDead(y, x, board, label) {
  const position = pkey(y, x);
  if (board.goals.get(position) === label) return false;
  const targets = board.goalPushTables?.byLabel?.get(label);
  if (targets) return !targets.some(({distances}) => distances.has(position));
  // Compatibility for small hand-built test boards without compiled tables.
  const distances = playerAwarePushDistances(board, position);
  return !(board.goalsByLabel.get(label) || []).some(goal => distances.has(goal));
}

function createDeadlockOccupancyContext(boxes, board) {
  const layout = denseBoxLayout(boxes, board);
  return {
    boxes,
    layout,
    indexByCell: layout.indexByCell,
    parentIndexByCell: layout.parentIndexByCell,
  };
}

function occupiedIndex(context, board, position) {
  const cell = board.dense.idByKey.get(position);
  if (cell === undefined) return -1;
  if (context.indexByCell) return context.indexByCell[cell];
  if (context.parentIndexByCell) {
    if (cell === context.layout.previousCell) return -1;
    if (cell === context.layout.destinationCell) return context.layout.changedIndex;
    return context.parentIndexByCell[cell];
  }
  context.indexByCell = ensureIndexByCell(context.layout, board);
  return context.indexByCell[cell];
}

function occupiedHas(context, board, position) {
  return occupiedIndex(context, board, position) >= 0;
}

function occupiedLabel(context, board, position) {
  const index = occupiedIndex(context, board, position);
  return index < 0 ? undefined : context.boxes[index][2];
}

function creates2x2Deadlock(boxes, board, movedBox, context = null) {
  const occupancy = context || createDeadlockOccupancyContext(boxes, board);
  const [boxY, boxX] = movedBox;
  for (const originY of [boxY - 1, boxY]) {
    for (const originX of [boxX - 1, boxX]) {
      const cells = [
        [originY, originX], [originY + 1, originX],
        [originY, originX + 1], [originY + 1, originX + 1],
      ];
      if (!cells.every(([y, x]) => {
        const position = pkey(y, x);
        return board.walls.has(position) || occupiedHas(occupancy, board, position);
      })) continue;
      if (cells.some(([y, x]) => {
        const label = occupiedLabel(occupancy, board, pkey(y, x));
        return label && board.goals.get(pkey(y, x)) !== label;
      })) return true;
    }
  }
  return false;
}
function createsFrozenComponentDeadlock(boxes, board, movedBox, context = null) {
  const occupancy = context || createDeadlockOccupancyContext(boxes, board);
  const start = pkey(movedBox[0], movedBox[1]);
  if (!occupiedHas(occupancy, board, start)) return false;
  const component = new Set([start]), queue = [movedBox];
  for (let head = 0; head < queue.length; head++) {
    const [y, x] = queue[head];
    for (const [dy, dx] of Object.values(DIRS)) {
      const adjacent = pkey(y + dy, x + dx);
      if (!occupiedHas(occupancy, board, adjacent) || component.has(adjacent)) continue;
      component.add(adjacent);
      queue.push([y + dy, x + dx]);
    }
  }
  board.metrics.recursiveFreezeChecks++;
  const recursivelyFrozen = new Set();
  const isBlocker = position =>
    !board.floor.has(position) ||
    (occupiedHas(occupancy, board, position) && recursivelyFrozen.has(position));
  let changed = true;
  while (changed) {
    changed = false;
    for (const position of component) {
      if (recursivelyFrozen.has(position)) continue;
      const [y, x] = position.split(",").map(Number);
      const horizontal = isBlocker(pkey(y, x - 1)) || isBlocker(pkey(y, x + 1));
      const vertical = isBlocker(pkey(y - 1, x)) || isBlocker(pkey(y + 1, x));
      if (!horizontal || !vertical) continue;
      recursivelyFrozen.add(position);
      changed = true;
    }
  }
  board.metrics.recursiveFreezeBoxes += recursivelyFrozen.size;
  if ([...recursivelyFrozen]
    .some(position => board.goals.get(position) !==
      occupiedLabel(occupancy, board, position))) return true;
  const movable = queue.some(([y, x]) => Object.values(DIRS).some(([dy, dx]) => {
    const destination = pkey(y + dy, x + dx);
    const support = pkey(y - dy, x - dx);
    return board.floor.has(destination) && board.floor.has(support) &&
      !occupiedHas(occupancy, board, destination) &&
      !occupiedHas(occupancy, board, support);
  }));
  if (movable) return false;
  return [...component].some(position => board.goals.get(position) !==
    occupiedLabel(occupancy, board, position));
}

function createsClosedDiagonalDeadlock(boxes, board, movedBox, context = null) {
  const occupancy = context || createDeadlockOccupancyContext(boxes, board);
  const movedKey = pkey(movedBox[0], movedBox[1]);
  if (!occupiedHas(occupancy, board, movedKey)) return false;
  const limit = board.rows.length + Math.max(...board.rows.map(row => row.length)) + 2;
  const blocked = (y, x) => {
    const position = pkey(y, x);
    return board.walls.has(position) || occupiedHas(occupancy, board, position);
  };

  const scanHalf = (startY, startX, stepY, stepX) => {
    const boxesOnBorder = new Set();
    const boxSides = [];
    let y = startY, x = startX;
    for (let distance = 0; distance < limit; distance++, y += stepY, x += stepX) {
      const center = pkey(y, x);
      if (board.walls.has(center)) {
        return {closed: true, boxes: boxesOnBorder, boxSides, rows: distance};
      }
      if (occupiedHas(occupancy, board, center) && staticallyImmovable(center, board)) {
        boxesOnBorder.add(center);
        return {closed: true, boxes: boxesOnBorder, boxSides, rows: distance};
      }
      if (!board.floor.has(center) || occupiedHas(occupancy, board, center) ||
          board.goals.has(center)) {
        return {closed: false, boxes: boxesOnBorder, boxSides, rows: distance};
      }
      let rowBoxSide = null;
      for (const [sideOffset, sideX] of [[-1, x - 1], [1, x + 1]]) {
        const side = pkey(y, sideX);
        if (!blocked(y, sideX) ||
            (board.goals.has(side) && !occupiedHas(occupancy, board, side))) {
          return {closed: false, boxes: boxesOnBorder, boxSides, rows: distance};
        }
        if (occupiedHas(occupancy, board, side)) {
          if (rowBoxSide !== null) {
            return {closed: false, boxes: boxesOnBorder, boxSides, rows: distance};
          }
          rowBoxSide = sideOffset;
          boxesOnBorder.add(side);
        }
      }
      if (rowBoxSide === null) {
        return {closed: false, boxes: boxesOnBorder, boxSides, rows: distance};
      }
      boxSides.push(rowBoxSide);
    }
    return {closed: false, boxes: boxesOnBorder, boxSides, rows: limit};
  };

  for (const centerX of [movedBox[1] - 1, movedBox[1] + 1]) {
    for (const slope of [-1, 1]) {
      const up = scanHalf(movedBox[0], centerX, -1, -slope);
      const down = scanHalf(movedBox[0] + 1, centerX + slope, 1, slope);
      if (!up.closed || !down.closed || up.rows + down.rows < 2) continue;
      const participants = new Set([...up.boxes, ...down.boxes]);
      const boxSides = [...up.boxSides].reverse().concat(down.boxSides);
      const outwardFacing = boxSides.length === 2 &&
        boxSides[0] === -slope && boxSides[1] === slope;
      const unfinished = [...participants]
        .some(position => board.goals.get(position) !==
          occupiedLabel(occupancy, board, position));
      if (!unfinished || !participants.has(movedKey) || participants.size < 2) continue;
      if (outwardFacing || (board.patternEligibleCount !== 0 &&
          createsPatternDatabaseDeadlock(boxes, board, movedBox, occupancy))) return true;
    }
  }
  return false;
}

function canonicalLocalPattern(floor, boxes, goals) {
  const points = [...floor].map(position => position.split(",").map(Number));
  const transforms = [
    ([y, x]) => [y, x], ([y, x]) => [y, -x],
    ([y, x]) => [-y, x], ([y, x]) => [-y, -x],
    ([y, x]) => [x, y], ([y, x]) => [x, -y],
    ([y, x]) => [-x, y], ([y, x]) => [-x, -y],
  ];
  const variants = transforms.map(transform => {
    const transformed = points.map(transform);
    const minY = Math.min(...transformed.map(([y]) => y));
    const minX = Math.min(...transformed.map(([, x]) => x));
    const keyFor = position => {
      const [y, x] = transform(position.split(",").map(Number));
      return `${y - minY},${x - minX}`;
    };
    const floorKey = [...floor].map(keyFor).sort().join(".");
    const goalKey = [...goals]
      .filter(([position]) => floor.has(position))
      .map(([position, label]) => `${keyFor(position)},${label}`).sort().join(".");
    const boxKey = boxes
      .map(([position, label]) => `${keyFor(position)},${label}`).sort().join(".");
    return `${floorKey}|${goalKey}|${boxKey}`;
  });
  return variants.sort()[0];
}

function createsPatternDatabaseDeadlock(
  boxes,
  board,
  movedBox,
  contextOrMaxStates = null,
  maxStates = PATTERN_EXACT_STATE_LIMIT,
) {
  // Preserve the legacy direct-call overload where the fourth argument was
  // the state limit; dynamic dispatch now uses that slot for shared occupancy.
  if (Number.isFinite(contextOrMaxStates)) maxStates = contextOrMaxStates;
  const metrics = board.metrics;
  metrics.patternDeadlockCalls++;
  const [centerY, centerX] = movedBox;
  const center = cellId(centerY, centerX, board.dense);
  if (center < 0 || (board.patternEligibility && !board.patternEligibility[center])) {
    metrics.patternDeadlockBypasses++;
    return false;
  }
  const inside = position => {
    const [y, x] = position.split(",").map(Number);
    return Math.abs(y - centerY) <= 4 && Math.abs(x - centerX) <= 4;
  };
  const windowKey = `${centerY},${centerX}`;
  let window = memoLookup(board.patternWindowMemo, windowKey);
  if (!window) {
    const floor = new Set();
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const cell = cellId(centerY + dy, centerX + dx, board.dense);
        if (cell >= 0) floor.add(board.dense.keys[cell]);
      }
    }
    const eligible = board.patternEligibility
      ? Boolean(board.patternEligibility[center])
      : floor.size <= PATTERN_FLOOR_LIMIT &&
        ![...floor].some(position => floorNeighbors(position, board.floor).length > 2);
    window = {floor, eligible};
    board.patternWindowMemo.set(windowKey, window);
  }
  if (!window.eligible) return false;
  const localFloor = window.floor;
  const localBoxes = boxes
    .map(([y, x, label]) => [pkey(y, x), label])
    .filter(([position]) => localFloor.has(position));
  if (localBoxes.length < 2 || localBoxes.length > PATTERN_BOX_LIMIT) return false;
  const stateUpperBound = localExactStateUpperBound(localFloor.size, localBoxes);
  if (stateUpperBound > PATTERN_EXACT_STATE_LIMIT) return false;
  const cacheKey = canonicalLocalPattern(localFloor, localBoxes, board.goals);
  metrics.patternCanonicalizations++;
  const cachedPatternDeadlock = memoLookup(board.patternDeadlockMemo, cacheKey);
  if (cachedPatternDeadlock !== undefined) {
    metrics.patternDeadlockCacheHits++;
    return cachedPatternDeadlock;
  }

  const signature = local => local
    .map(([position, label]) => `${position},${label}`).sort().join(";");
  const queue = [localBoxes], seen = new Set([signature(localBoxes)]);
  let head = 0, salvaged = false;
  const stateLimit = Math.min(maxStates, PATTERN_EXACT_STATE_LIMIT, stateUpperBound + 1);
  for (; head < queue.length && seen.size <= stateLimit; head++) {
    const current = queue[head];
    if (current.every(([position, label]) => board.goals.get(position) === label)) {
      salvaged = true;
      break;
    }
    const occupied = new Set(current.map(([position]) => position));
    current.forEach(([position, label], boxIndex) => {
      const [y, x] = position.split(",").map(Number);
      for (const [dy, dx] of Object.values(DIRS)) {
        const support = pkey(y - dy, x - dx);
        const destination = pkey(y + dy, x + dx);
        if (!board.floor.has(support) || occupied.has(support) ||
            !board.floor.has(destination) || occupied.has(destination)) continue;
        const next = inside(destination)
          ? current.map((box, index) => index === boxIndex ? [destination, label] : box)
          : current.filter((_, index) => index !== boxIndex);
        const nextSignature = signature(next);
        if (seen.has(nextSignature)) continue;
        seen.add(nextSignature);
        queue.push(next);
      }
    });
  }
  metrics.patternDeadlockStates += Math.min(head, queue.length);
  const cutoff = !salvaged && head < queue.length;
  const deadlocked = !salvaged && !cutoff;
  if (deadlocked) metrics.patternDeadlockPrunes++;
  return cutoff ? false : memoizeBounded(
    board.patternDeadlockMemo, cacheKey, deadlocked, PATTERN_DEADLOCK_MEMO_LIMIT);
}

function createsDynamicDeadlock(boxes, board, movedBox) {
  const occupancy = createDeadlockOccupancyContext(boxes, board);
  const movedCell = cellId(movedBox[0], movedBox[1], board.dense);
  const signature = occupancy.layout.valid && movedCell >= 0
    ? (occupancy.layout.identity << BigInt(board.dense.cellBits)) | BigInt(movedCell)
    : `${boxSignature(boxes, board)}|${movedBox.join(",")}`;
  const cachedDeadlock = memoLookup(board.deadlockMemo, signature);
  if (cachedDeadlock !== undefined) {
    board.metrics.dynamicDeadlockCacheHits++;
    return cachedDeadlock;
  }
  board.metrics.dynamicDeadlockCalls++;
  const started = now();
  let rules = board.dynamicHardPruningRules;
  if (!rules) {
    rules = board.patternEligibleCount === 0
      ? DYNAMIC_HARD_PRUNING_RULES.filter(rule => rule.name !== "pattern-database")
      : DYNAMIC_HARD_PRUNING_RULES;
    board.dynamicHardPruningRules = rules;
  }
  if (rules.length < DYNAMIC_HARD_PRUNING_RULES.length) {
    board.metrics.patternDeadlockBoardBypasses++;
  }
  let matchedRule = null;
  const deadlocked = rules.some(rule => {
    if (!rule.detect(boxes, board, movedBox, occupancy)) return false;
    matchedRule = rule.name;
    return true;
  });
  if (matchedRule) {
    board.metrics.dynamicDeadlockRuleHits[matchedRule] =
      (board.metrics.dynamicDeadlockRuleHits[matchedRule] || 0) + 1;
  }
  board.metrics.dynamicDeadlockMs += now() - started;
  // The legacy PI-corral helper guessed the keeper region from an arbitrary
  // free neighbor of the moved box. That is not a proof and can reject legal
  // states. Exact-player-region corral checks remain active in analysis.js.
  return memoizeBounded(board.deadlockMemo, signature, deadlocked, DEADLOCK_MEMO_LIMIT);
}

// --- Module registration ---
const SokomindDeadlock = {
  corner,
  staticDead,
  createDeadlockOccupancyContext,
  creates2x2Deadlock,
  createsFrozenComponentDeadlock,
  createsClosedDiagonalDeadlock,
  canonicalLocalPattern,
  createsPatternDatabaseDeadlock,
  createsDynamicDeadlock,
};
if (typeof globalThis !== "undefined") globalThis.SokomindDeadlock = SokomindDeadlock;
if (typeof module === "object" && module.exports) module.exports = SokomindDeadlock;
