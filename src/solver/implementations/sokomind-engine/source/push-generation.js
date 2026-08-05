// Push neighbor generation, macro expansion, reverse states, and solution path utilities.
// Part of the Sokomind solver engine. Functions are bare globals for
// cross-module compatibility. The namespace object is registered for new usage.

function pushNeighbors(state, board, reachable = reachablePaths(state, board), options = {}) {
  board.metrics.pushNeighborCalls++;
  const occupied = reachable.occupied || denseOccupancy(state, board);
  const commitments = options.commitments || (options.lockProven && board.topology.rooms.length
    ? stateGoalCommitments(state, board, reachable)
    : null);
  const result = [];
  state.boxes.forEach(([y, x, label], index) => {
    const boxId = cellId(y, x, board.dense);
    if (commitments) {
      const boxPosition = board.dense.keys[boxId];
      if (commitments.get(boxPosition) === GOAL_COMMITMENT.PROVEN) {
        board.metrics.commitmentBoxLocks++;
        return;
      }
    }
    for (let direction = 0; direction < DIRECTION_ENTRIES.length; direction++) {
      const [move] = DIRECTION_ENTRIES[direction];
      const supportId = board.dense.neighbors[
        boxId * DIRECTION_ENTRIES.length + OPPOSITE_DIRECTION_INDEX[direction]
      ];
      const destinationId = board.dense.neighbors[boxId * DIRECTION_ENTRIES.length + direction];
      if (!reachable.hasId(supportId) || destinationId < 0 || occupied[destinationId] >= 0) continue;
      const destinationY = board.dense.y[destinationId], destinationX = board.dense.x[destinationId];
      const dest = board.dense.keys[destinationId];
      board.metrics.pushCandidates++;
      if (staticDead(destinationY, destinationX, board, label)) {
        board.metrics.staticDeadPrunes++;
        continue;
      }
      const boxes = cachedPushedBoxes(
        state.boxes, index, destinationId, label, board,
      );
      if (createsDynamicDeadlock(boxes, board, [destinationY, destinationX])) {
        board.metrics.dynamicDeadPrunes++;
        continue;
      }
      board.assignmentParentMemo.set(boxes, {parentBoxes: state.boxes, changedIndex: index});
      result.push({
        robot: [y, x],
        boxes,
        path: [...reachable.getId(supportId), move],
        pushClass: `${label}:${y},${x}:${move}`,
        pushedFrom: board.dense.keys[boxId],
        pushedTo: dest,
      });
      board.metrics.pushesRetained++;
    }
  });
  return result;
}

function pushBoxNeighbors(
  state,
  board,
  boxPosition,
  reachable = reachablePaths(state, board),
  options = {},
) {
  const occupied = reachable.occupied || denseOccupancy(state, board);
  const boxId = board.dense.idByKey.get(boxPosition);
  if (boxId === undefined || boxId < 0 || occupied[boxId] < 0) return [];
  const commitments = options.commitments || (options.lockProven && board.topology.rooms.length
    ? stateGoalCommitments(state, board, reachable)
    : null);
  if (commitments?.get(boxPosition) === GOAL_COMMITMENT.PROVEN) {
    board.metrics.commitmentBoxLocks++;
    return [];
  }
  const index = occupied[boxId];
  const [y, x, label] = state.boxes[index], result = [];
  for (let direction = 0; direction < DIRECTION_ENTRIES.length; direction++) {
    const [move] = DIRECTION_ENTRIES[direction];
    const supportId = board.dense.neighbors[
      boxId * DIRECTION_ENTRIES.length + OPPOSITE_DIRECTION_INDEX[direction]
    ];
    const destinationId = board.dense.neighbors[boxId * DIRECTION_ENTRIES.length + direction];
    if (!reachable.hasId(supportId) || destinationId < 0 || occupied[destinationId] >= 0) continue;
    const destinationY = board.dense.y[destinationId], destinationX = board.dense.x[destinationId];
    const destination = board.dense.keys[destinationId];
    if (staticDead(destinationY, destinationX, board, label)) continue;
    const boxes = cachedPushedBoxes(
      state.boxes, index, destinationId, label, board,
    );
    if (createsDynamicDeadlock(boxes, board, [destinationY, destinationX])) continue;
    board.assignmentParentMemo.set(boxes, {parentBoxes: state.boxes, changedIndex: index});
    result.push({
      robot: [y, x],
      boxes,
      path: [...reachable.getId(supportId), move],
      pushClass: `${label}:${y},${x}:${move}`,
      pushedFrom: boxPosition,
      pushedTo: destination,
    });
  }
  return result;
}

function pushKey(state, reachable) {
  if (reachable.board && reachable.regionId !== undefined) {
    return `${reachable.regionId.toString(36)}|${boxSignature(state.boxes, reachable.board)}`;
  }
  let robotRegion = null;
  for (const position of reachable.keys()) {
    if (robotRegion === null || position < robotRegion) robotRegion = position;
  }
  return `${robotRegion}|${[...state.boxes.map(b => b.join(","))].sort().join(";")}`;
}

function collapseForcedPushes(first, board, limit = 32, options = {}) {
  let state = {robot: first.robot, boxes: first.boxes};
  const path = [...first.path], seen = new Set([exactPushKey(state, board)]);
  let pushes = 1;
  while (pushes < limit && !goal(state.boxes, board.goals)) {
    const reachable = reachablePaths(state, board);
    if (createsSealedCorralDeadlock(state, board, reachable)) return null;
    const choices = pushNeighbors(state, board, reachable, {lockProven: options.lockProven});
    if (choices.length !== 1) break;
    const next = choices[0], signature = exactPushKey(next, board);
    if (seen.has(signature)) break;
    seen.add(signature);
    path.push(...next.path);
    state = {robot: next.robot, boxes: next.boxes};
    pushes++;
  }
  return {...state, path, pushes, pushClass: first.pushClass};
}

function tunnelSegmentLookup(board) {
  if (board._tunnelSegmentMap) return board._tunnelSegmentMap;
  const map = new Map();
  for (const segment of board.topology.tunnelSegments || []) {
    for (const cell of segment.cells) {
      map.set(cell, segment);
    }
  }
  board._tunnelSegmentMap = map;
  return map;
}

function expandPushMacro(next, board, enabled = true, options = {}) {
  if (!enabled || !board.topology.tunnels.has(next.pushedTo)) return {...next, pushes: 1};

  // Check tunnel segment for one-way dead-end pruning
  const segMap = tunnelSegmentLookup(board);
  const segment = segMap.get(next.pushedTo);
  if (segment && segment.oneWay) {
    // One-way tunnel: check if pushing box into dead end with no matching goal
    const label = next.boxes.find(([y, x]) =>
      pkey(y, x) === next.pushedTo)?.[2];
    if (label && segment.goals.length === 0) {
      // No goals in this one-way tunnel, box will be stuck
      board.metrics.tunnelOneWayPrunes = (board.metrics.tunnelOneWayPrunes || 0) + 1;
      return null;
    }
    // Check if the goals in the tunnel match the box label
    if (label && segment.goals.length > 0) {
      const hasMatchingGoal = segment.goals.some(g => board.goals.get(g) === label);
      if (!hasMatchingGoal) {
        board.metrics.tunnelOneWayPrunes = (board.metrics.tunnelOneWayPrunes || 0) + 1;
        return null;
      }
    }
  }

  return collapseForcedPushes(next, board, 32, options);
}

function recordMacroDiscoveryRejection(metrics, reason) {
  if (!metrics) return;
  metrics.macroDiscoveryRejections++;
  if (reason === "stranded-export") metrics.macroEgressRejections++;
  if (reason === "packing-order") metrics.macroPackingRejections++;
  if (reason === "goal-access") metrics.macroGoalAccessRejections++;
}

function macroPathRoot(path) {
  return {parent: null, segment: path, length: path.length};
}

function extendMacroPath(state, segment) {
  const parent = state.macroPath || macroPathRoot(state.path);
  return {parent, segment, length: parent.length + segment.length};
}

function materializeMacroPath(state) {
  if (!state.macroPath) return state;
  let path = state.path;
  if (!path) {
    const segments = [];
    for (let node = state.macroPath; node; node = node.parent) {
      if (node.segment.length) segments.push(node.segment);
    }
    path = [];
    for (let index = segments.length - 1; index >= 0; index--) {
      path.push(...segments[index]);
    }
  }
  const {macroPath: _macroPath, ...result} = state;
  return {...result, path};
}

function expandPushSequences(
  first,
  board,
  maxPushes = 12,
  maxExplored = 48,
  maxReturned = 8,
  options = {},
) {
  const metrics = activePerformance;
  const initial = {...first, pushes: 1, macroPath: macroPathRoot(first.path)};
  const queue = [initial], endpoints = [];
  const seen = new Set([exactPushKey(initial, board)]);
  let head = 0;
  for (; head < queue.length && queue.length < maxExplored; head++) {
    const current = queue[head];
    if (current.pushes >= maxPushes || goal(current.boxes, board.goals)) {
      endpoints.push(current);
      continue;
    }
    const state = {robot: current.robot, boxes: current.boxes};
    const reachable = reachablePaths(state, board);
    if (createsSealedCorralDeadlock(state, board, reachable)) {
      if (metrics) metrics.macroHardDeadlockRejections++;
      endpoints.push(current);
      continue;
    }
    const continuations = pushBoxNeighbors(
      state,
      board,
      current.pushedTo,
      reachable,
      {lockProven: options.lockProven},
    );
    if (!continuations.length) {
      endpoints.push({...current, macroDecision: true, targetDeadEnd: true});
    }
    else if (continuations.length > 1) endpoints.push({...current, macroDecision: true});
    for (const next of continuations) {
      const sequence = {
        robot: next.robot,
        boxes: next.boxes,
        macroPath: extendMacroPath(current, next.path),
        pushes: current.pushes + 1,
        pushClass: `${first.pushClass}:${current.pushes + 1}`,
        pushedFrom: next.pushedFrom,
        pushedTo: next.pushedTo,
      };
      if (metrics) metrics.macroIntermediateStates++;
      const rejection = options.intermediateGuard?.(sequence, current);
      if (rejection) {
        recordMacroDiscoveryRejection(metrics, rejection);
        endpoints.push({...sequence, macroRejectedReason: rejection});
        continue;
      }
      const signature = exactPushKey(sequence, board);
      if (seen.has(signature)) continue;
      seen.add(signature);
      queue.push(sequence);
      if (queue.length >= maxExplored) break;
    }
  }
  endpoints.push(...queue.slice(head));
  endpoints.sort((left, right) =>
    Number(Boolean(right.macroDecision)) - Number(Boolean(left.macroDecision)) ||
    right.pushes - left.pushes ||
    (left.path?.length ?? left.macroPath.length) -
      (right.path?.length ?? right.macroPath.length));
  const selected = [], destinations = new Set();
  const viableEndpoint = endpoint => {
    if (!(endpoint.targetDistance > 0)) return true;
    const state = {robot: endpoint.robot, boxes: endpoint.boxes};
    const reachable = reachablePaths(state, board);
    return pushBoxNeighbors(
      state,
      board,
      endpoint.pushedTo,
      reachable,
      {lockProven: options.lockProven},
    ).length > 0;
  };
  for (const endpoint of endpoints) {
    if (destinations.has(endpoint.pushedTo)) continue;
    if (!viableEndpoint(endpoint)) continue;
    destinations.add(endpoint.pushedTo);
    selected.push(endpoint);
    if (selected.length >= maxReturned) break;
  }
  const approaches = new Set(selected.map(endpoint =>
    `${endpoint.pushedTo}|${endpoint.robot.join(",")}`));
  for (const endpoint of endpoints) {
    if (selected.length >= maxReturned) break;
    const approach = `${endpoint.pushedTo}|${endpoint.robot.join(",")}`;
    if (approaches.has(approach) || !viableEndpoint(endpoint)) continue;
    approaches.add(approach);
    selected.push(endpoint);
  }
  if (metrics) metrics.macroEndpointsRetained += selected.length;
  return [
    materializeMacroPath(initial),
    ...selected
      .filter(endpoint => exactPushKey(endpoint, board) !== exactPushKey(initial, board))
      .map(materializeMacroPath),
  ];
}

function expandTargetedPushSequence(
  first,
  board,
  objective,
  maxPushes = 24,
  maxExplored = 96,
  maxReturned = 4,
  options = {},
) {
  const metrics = activePerformance;
  const room = Number.isInteger(objective?.roomIndex)
    ? board.topology.rooms[objective.roomIndex] : null;
  const distance = state => {
    const position = state.pushedTo;
    if (objective?.direction === "export" && room) {
      if (!room.cells.has(position) && position !== room.gate) return 0;
      const toGate = playerAwarePushDistances(board, position).get(room.gate);
      return Number.isFinite(toGate) ? toGate + 1 : Infinity;
    }
    if (objective?.direction === "import" && room) {
      if (room.cells.has(position)) return 0;
      const toGate = playerAwarePushDistances(board, position).get(room.gate);
      return Number.isFinite(toGate) ? toGate + 1 : Infinity;
    }
    if (objective?.direction === "clear" && room) {
      if (!room.exteriorStaging.has(position) && position !== room.gate) return 0;
      const distances = playerAwarePushDistances(board, position);
      let best = Infinity;
      for (const candidate of board.floor) {
        if (room.exteriorStaging.has(candidate) || candidate === room.gate) continue;
        best = Math.min(best, distances.get(candidate) ?? Infinity);
      }
      return best;
    }
    if (objective?.target) {
      return compiledGoalPushDistance(board, position, objective.target);
    }
    return Infinity;
  };
  let macroOrder = 0;
  const initial = {
    ...first,
    pushes: 1,
    macroOrder: macroOrder++,
    macroPath: macroPathRoot(first.path),
  };
  initial.targetDistance = distance(initial);
  const open = new Heap(), endpoints = [], completedTargets = new Map();
  const openPriority = sequence => {
    const combined = sequence.pushes + sequence.targetDistance;
    return Number.isFinite(combined)
      ? (combined * 1000 + sequence.targetDistance) * 1000 + sequence.macroOrder
      : 1e15 + sequence.macroOrder;
  };
  open.push([openPriority(initial), initial]);
  const seen = new Set([exactPushKey(initial, board)]);
  let explored = 0;
  while (open.length && explored++ < maxExplored) {
    if (options.targetBound !== false && completedTargets.size >= maxReturned) {
      const worstPushes = Math.max(
        ...[...completedTargets.values()].map(endpoint => endpoint.pushes),
      );
      const bestOpen = open.items[0][1];
      if (bestOpen.pushes + bestOpen.targetDistance > worstPushes) {
        if (metrics) metrics.macroTargetBoundCutoffs++;
        break;
      }
    }
    const current = open.pop()[1];
    if (current.targetDistance === 0 || current.pushes >= maxPushes) {
      endpoints.push(current);
      if (current.targetDistance === 0) {
        const previous = completedTargets.get(current.pushedTo);
        if (!previous || current.pushes < previous.pushes) {
          completedTargets.set(current.pushedTo, current);
        }
      }
      continue;
    }
    const state = {robot: current.robot, boxes: current.boxes};
    const reachable = reachablePaths(state, board);
    if (createsSealedCorralDeadlock(state, board, reachable)) {
      if (metrics) metrics.macroHardDeadlockRejections++;
      continue;
    }
    const continuations = pushBoxNeighbors(
      state,
      board,
      current.pushedTo,
      reachable,
      {lockProven: options.lockProven},
    );
    if (!continuations.length) endpoints.push({...current, macroDecision: true});
    for (const next of continuations) {
      const sequence = {
        robot: next.robot,
        boxes: next.boxes,
        macroPath: extendMacroPath(current, next.path),
        pushes: current.pushes + 1,
        pushClass: `${first.pushClass}:target:${current.pushes + 1}`,
        pushedFrom: next.pushedFrom,
        pushedTo: next.pushedTo,
        macroOrder: macroOrder++,
      };
      if (metrics) metrics.macroIntermediateStates++;
      sequence.targetDistance = distance(sequence);
      if (!Number.isFinite(sequence.targetDistance)) {
        if (metrics) metrics.macroTargetUnreachableStates++;
      }
      const rejection = options.intermediateGuard?.(sequence, current);
      if (rejection) {
        recordMacroDiscoveryRejection(metrics, rejection);
        endpoints.push({...sequence, macroRejectedReason: rejection});
        continue;
      }
      const signature = exactPushKey(sequence, board);
      if (seen.has(signature)) continue;
      seen.add(signature);
      open.push([openPriority(sequence), sequence]);
    }
  }
  endpoints.push(...open.items.map(item => item[1]));
  endpoints.sort((left, right) =>
    Number(Boolean(left.targetDeadEnd)) - Number(Boolean(right.targetDeadEnd)) ||
    left.targetDistance - right.targetDistance ||
    left.pushes - right.pushes ||
    left.macroOrder - right.macroOrder);
  const selected = [], destinations = new Set();
  for (const endpoint of endpoints) {
    if (destinations.has(endpoint.pushedTo)) continue;
    destinations.add(endpoint.pushedTo);
    selected.push(endpoint);
    if (selected.length >= maxReturned) break;
  }
  const approaches = new Set(selected.map(endpoint =>
    `${endpoint.pushedTo}|${endpoint.robot.join(",")}`));
  for (const endpoint of endpoints) {
    if (selected.length >= maxReturned) break;
    const approach = `${endpoint.pushedTo}|${endpoint.robot.join(",")}`;
    if (approaches.has(approach)) continue;
    approaches.add(approach);
    selected.push(endpoint);
  }
  if (metrics) metrics.macroEndpointsRetained += selected.length;
  return [
    materializeMacroPath(initial),
    ...selected
      .filter(endpoint => exactPushKey(endpoint, board) !== exactPushKey(initial, board))
      .map(materializeMacroPath),
  ];
}

function expandStraightPushes(first, board, maxPushes = 8, options = {}) {
  const [fromY, fromX] = first.pushedFrom.split(",").map(Number);
  const [toY, toX] = first.pushedTo.split(",").map(Number);
  const dy = toY - fromY, dx = toX - fromX;
  const results = [{...first, pushes: 1}];
  let current = results[0];
  while (current.pushes < maxPushes && !goal(current.boxes, board.goals)) {
    const state = {robot: current.robot, boxes: current.boxes};
    const reachable = reachablePaths(state, board);
    if (createsSealedCorralDeadlock(state, board, reachable)) break;
    const [y, x] = current.pushedTo.split(",").map(Number);
    const destination = pkey(y + dy, x + dx);
    const next = pushBoxNeighbors(
      state,
      board,
      current.pushedTo,
      reachable,
      {lockProven: options.lockProven},
    )
      .find(candidate => candidate.pushedTo === destination);
    if (!next) break;
    current = {
      ...next,
      path: [...current.path, ...next.path],
      pushes: current.pushes + 1,
      pushClass: `${first.pushClass}:${current.pushes + 1}`,
    };
    results.push(current);
  }
  return results;
}

function invertWalk(path) {
  return [...path].reverse().map(move => OPPOSITE[move]);
}
function encodeMoves(path) {
  return path.map(move => MOVE_CODE[move]).join("");
}

function reversePullNeighbors(state, board, reachable = reachablePaths(state, board)) {
  const occupied = reachable.occupied || denseOccupancy(state, board);
  const result = [];
  state.boxes.forEach(([y, x, label], index) => {
    const boxId = cellId(y, x, board.dense);
    for (let direction = 0; direction < DIRECTION_ENTRIES.length; direction++) {
      const [move] = DIRECTION_ENTRIES[direction];
      const opposite = OPPOSITE_DIRECTION_INDEX[direction];
      const boxBeforeId = board.dense.neighbors[boxId * DIRECTION_ENTRIES.length + opposite];
      if (!reachable.hasId(boxBeforeId) || occupied[boxBeforeId] >= 0) continue;
      const robotAfterPullId = board.dense.neighbors[
        boxBeforeId * DIRECTION_ENTRIES.length + opposite
      ];
      if (robotAfterPullId < 0 || occupied[robotAfterPullId] >= 0) continue;
      const boxY = board.dense.y[boxBeforeId], boxX = board.dense.x[boxBeforeId];
      if (staticDead(boxY, boxX, board, label)) continue;
      const boxes = state.boxes.slice();
      boxes[index] = [boxY, boxX, label];
      deriveDenseBoxLayout(state.boxes, boxes, index, boxBeforeId, board);
      if (creates2x2Deadlock(boxes, board, [boxY, boxX]) ||
          createsFrozenComponentDeadlock(boxes, board, [boxY, boxX])) continue;
      const walkToPullSpot = reachable.getId(boxBeforeId);
      const walkFromPushLanding = invertWalk(walkToPullSpot);
      result.push({
        robot: [board.dense.y[robotAfterPullId], board.dense.x[robotAfterPullId]],
        boxes,
        cost: state.cost + 1,
        segment: [move, ...walkFromPushLanding],
      });
    }
  });
  return result;
}

function solvedBoxes(board, initialBoxes) {
  const byLabel = new Map();
  initialBoxes.forEach(([, , label]) => byLabel.set(label, (byLabel.get(label) || 0) + 1));
  const boxes = [];
  for (const [label, count] of byLabel) {
    const goals = [...board.goals]
      .filter(([, goalLabel]) => goalLabel === label)
      .map(([position]) => position.split(",").map(Number))
      .slice(0, count);
    goals.forEach(([y, x]) => boxes.push([y, x, label]));
  }
  return boxes.sort((a, b) => a.join(",").localeCompare(b.join(",")));
}

function reverseStartPortfolio(board, initialBoxes, initialTargets = null) {
  const boxes = solvedBoxes(board, initialBoxes);
  const occupied = new Set(boxes.map(([y, x]) => pkey(y, x)));
  const unique = new Map();
  for (const position of board.floor) {
    if (occupied.has(position)) continue;
    const robot = position.split(",").map(Number);
    const state = {robot, boxes, cost: 0};
    const reachable = reachablePaths(state, board);
    const signature = pushKey(state, reachable);
    if (!unique.has(signature)) unique.set(signature, {state, signature, reachable});
  }
  const targets = initialTargets || targetMapFromBoxes(initialBoxes, board);
  return [...unique.values()].map(entry => {
    const pulls = reversePullNeighbors(entry.state, board, entry.reachable);
    const nextEstimate = pulls.reduce((best, next) =>
      Math.min(best, homeHeuristic(next.boxes, targets)), Infinity);
    const gateAccess = [...board.topology.articulations]
      .filter(position => entry.reachable.has(position)).length;
    return {
      ...entry,
      pullOptions: pulls.length,
      pullSignatures: pulls.map(next => exactPushKey(next, board)),
      nextEstimate,
      reachableCells: entry.reachable.size,
      gateAccess,
    };
  }).sort((left, right) =>
    Number(right.pullOptions > 0) - Number(left.pullOptions > 0) ||
    right.pullOptions - left.pullOptions ||
    left.nextEstimate - right.nextEstimate ||
    right.gateAccess - left.gateAccess ||
    right.reachableCells - left.reachableCells ||
    left.signature.localeCompare(right.signature));
}

function reverseStartStates(board, initialBoxes, shard, initialTargets = null) {
  const portfolio = reverseStartPortfolio(board, initialBoxes, initialTargets);
  const states = portfolio.map(entry => entry.state);
  const assignedPullOptions = portfolio.reduce((sum, entry) => sum +
    entry.pullSignatures.filter(signature => reverseShardOwns(signature, shard)).length, 0);
  states.portfolioStats = {
    totalRegions: portfolio.length,
    productiveRegions: portfolio.filter(entry => entry.pullOptions > 0).length,
    totalPullOptions: portfolio.reduce((sum, entry) => sum + entry.pullOptions, 0),
    assignedRegions: states.length,
    assignedProductiveRegions: portfolio.filter(entry => entry.pullSignatures
      .some(signature => reverseShardOwns(signature, shard))).length,
    assignedPullOptions,
  };
  return states;
}

function reverseShardOwns(signature, shard) {
  if (!shard || shard.count <= 1) return true;
  return Math.floor(signatureNoise(signature, 0x51f15e) * shard.count) === shard.index;
}

// --- Module registration ---
const SokomindPushGeneration = {
  pushNeighbors,
  pushBoxNeighbors,
  pushKey,
  collapseForcedPushes,
  tunnelSegmentLookup,
  expandPushMacro,
  recordMacroDiscoveryRejection,
  macroPathRoot,
  extendMacroPath,
  materializeMacroPath,
  expandPushSequences,
  expandTargetedPushSequence,
  expandStraightPushes,
  invertWalk,
  encodeMoves,
  reversePullNeighbors,
  solvedBoxes,
  reverseStartPortfolio,
  reverseStartStates,
  reverseShardOwns,
};
if (typeof globalThis !== "undefined") globalThis.SokomindPushGeneration = SokomindPushGeneration;
if (typeof module === "object" && module.exports) module.exports = SokomindPushGeneration;
