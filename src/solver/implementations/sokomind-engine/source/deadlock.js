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
  if (board.goals.get(pkey(y, x)) === label) return false;
  const distances = playerAwarePushDistances(board, pkey(y, x));
  return !(board.goalsByLabel.get(label) || []).some(goal => distances.has(goal));
}
function creates2x2Deadlock(boxes, board, movedBox) {
  const occupied = new Map(boxes.map(([y, x, label]) => [pkey(y, x), label]));
  const [boxY, boxX] = movedBox;
  for (const originY of [boxY - 1, boxY]) {
    for (const originX of [boxX - 1, boxX]) {
      const cells = [
        [originY, originX], [originY + 1, originX],
        [originY, originX + 1], [originY + 1, originX + 1],
      ];
      if (!cells.every(([y, x]) => board.walls.has(pkey(y, x)) || occupied.has(pkey(y, x)))) continue;
      if (cells.some(([y, x]) => {
        const label = occupied.get(pkey(y, x));
        return label && board.goals.get(pkey(y, x)) !== label;
      })) return true;
    }
  }
  return false;
}
function createsFrozenComponentDeadlock(boxes, board, movedBox) {
  const occupied = new Map(boxes.map(([y, x, label]) => [pkey(y, x), label]));
  const start = pkey(movedBox[0], movedBox[1]);
  if (!occupied.has(start)) return false;
  const component = new Set([start]), queue = [movedBox];
  for (let head = 0; head < queue.length; head++) {
    const [y, x] = queue[head];
    for (const [dy, dx] of Object.values(DIRS)) {
      const adjacent = pkey(y + dy, x + dx);
      if (!occupied.has(adjacent) || component.has(adjacent)) continue;
      component.add(adjacent);
      queue.push([y + dy, x + dx]);
    }
  }
  board.metrics.recursiveFreezeChecks++;
  const recursivelyFrozen = new Set();
  const isBlocker = position =>
    !board.floor.has(position) ||
    (occupied.has(position) && recursivelyFrozen.has(position));
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
    .some(position => board.goals.get(position) !== occupied.get(position))) return true;
  const movable = queue.some(([y, x]) => Object.values(DIRS).some(([dy, dx]) => {
    const destination = pkey(y + dy, x + dx);
    const support = pkey(y - dy, x - dx);
    return board.floor.has(destination) && board.floor.has(support) &&
      !occupied.has(destination) && !occupied.has(support);
  }));
  if (movable) return false;
  return [...component].some(position => board.goals.get(position) !== occupied.get(position));
}

function createsClosedDiagonalDeadlock(boxes, board, movedBox) {
  const occupied = new Map(boxes.map(([y, x, label]) => [pkey(y, x), label]));
  const movedKey = pkey(movedBox[0], movedBox[1]);
  if (!occupied.has(movedKey)) return false;
  const limit = board.rows.length + Math.max(...board.rows.map(row => row.length)) + 2;
  const blocked = (y, x) => board.walls.has(pkey(y, x)) || occupied.has(pkey(y, x));

  const scanHalf = (startY, startX, stepY, stepX) => {
    const boxesOnBorder = new Set();
    const boxSides = [];
    let y = startY, x = startX;
    for (let distance = 0; distance < limit; distance++, y += stepY, x += stepX) {
      const center = pkey(y, x);
      if (board.walls.has(center)) {
        return {closed: true, boxes: boxesOnBorder, boxSides, rows: distance};
      }
      if (occupied.has(center) && staticallyImmovable(center, board)) {
        boxesOnBorder.add(center);
        return {closed: true, boxes: boxesOnBorder, boxSides, rows: distance};
      }
      if (!board.floor.has(center) || occupied.has(center) || board.goals.has(center)) {
        return {closed: false, boxes: boxesOnBorder, boxSides, rows: distance};
      }
      let rowBoxSide = null;
      for (const [sideOffset, sideX] of [[-1, x - 1], [1, x + 1]]) {
        const side = pkey(y, sideX);
        if (!blocked(y, sideX) || (board.goals.has(side) && !occupied.has(side))) {
          return {closed: false, boxes: boxesOnBorder, boxSides, rows: distance};
        }
        if (occupied.has(side)) {
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
        .some(position => board.goals.get(position) !== occupied.get(position));
      if (!unfinished || !participants.has(movedKey) || participants.size < 2) continue;
      if (outwardFacing || createsPatternDatabaseDeadlock(boxes, board, movedBox)) return true;
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
  maxStates = PATTERN_EXACT_STATE_LIMIT,
) {
  const metrics = board.metrics;
  metrics.patternDeadlockCalls++;
  const [centerY, centerX] = movedBox;
  const inside = position => {
    const [y, x] = position.split(",").map(Number);
    return Math.abs(y - centerY) <= 4 && Math.abs(x - centerX) <= 4;
  };
  const windowKey = `${centerY},${centerX}`;
  let window = memoLookup(board.patternWindowMemo, windowKey);
  if (!window) {
    const floor = new Set([...board.floor].filter(inside));
    const eligible = floor.size <= PATTERN_FLOOR_LIMIT &&
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
  const signature = `${boxSignature(boxes, board)}|${movedBox.join(",")}`;
  const cachedDeadlock = memoLookup(board.deadlockMemo, signature);
  if (cachedDeadlock !== undefined) return cachedDeadlock;
  const deadlocked = DYNAMIC_HARD_PRUNING_RULES.some(
    rule => rule.detect(boxes, board, movedBox),
  );
  // The legacy PI-corral helper guessed the keeper region from an arbitrary
  // free neighbor of the moved box. That is not a proof and can reject legal
  // states. Exact-player-region corral checks remain active in analysis.js.
  return memoizeBounded(board.deadlockMemo, signature, deadlocked, DEADLOCK_MEMO_LIMIT);
}

// --- Module registration ---
const SokomindDeadlock = {
  corner,
  staticDead,
  creates2x2Deadlock,
  createsFrozenComponentDeadlock,
  createsClosedDiagonalDeadlock,
  canonicalLocalPattern,
  createsPatternDatabaseDeadlock,
  createsDynamicDeadlock,
};
if (typeof globalThis !== "undefined") globalThis.SokomindDeadlock = SokomindDeadlock;
if (typeof module === "object" && module.exports) module.exports = SokomindDeadlock;
