import type { CompiledSearchBoard } from "./compiled-board.ts";

export interface MatchingComponentResult {
  readonly totalComponents: number;
  /** label → component index per box (ordered by initialBoxes appearance) */
  readonly componentsByLabel: ReadonlyMap<string, readonly number[]>;
  /** label → component index per goal (ordered by goalCellsByLabel) */
  readonly goalComponentsByLabel: ReadonlyMap<string, readonly number[]>;
  readonly componentCountByLabel: ReadonlyMap<string, number>;
  readonly finiteEdges: number;
  readonly allowedEdges: number;
  readonly eliminatedEdges: number;
}

export function analyzeMatchingComponents(
  board: CompiledSearchBoard,
): MatchingComponentResult {
  const componentsByLabel = new Map<string, readonly number[]>();
  const goalComponentsByLabel = new Map<string, readonly number[]>();
  const componentCountByLabel = new Map<string, number>();
  let totalComponents = 0;
  let totalFiniteEdges = 0;
  let totalAllowedEdges = 0;

  for (const [label, goalCells] of board.goalCellsByLabel) {
    const boxCells: number[] = [];
    for (const box of board.source.initialBoxes) {
      if (box.label === label) {
        const cell = board.cellAt(box.position.row, box.position.column);
        if (cell >= 0) boxCells.push(cell);
      }
    }

    const k = goalCells.length;
    if (k <= 1 || boxCells.length !== k) {
      const comp = new Array(k).fill(0);
      componentsByLabel.set(label, comp);
      goalComponentsByLabel.set(label, comp);
      componentCountByLabel.set(label, 1);
      totalComponents += 1;
      continue;
    }

    const reachable = buildReachabilityMatrix(board, boxCells, goalCells);
    const finiteEdges = countFiniteEdges(reachable, k);
    totalFiniteEdges += finiteEdges;

    const matching = findPerfectMatching(reachable, k);
    if (!matching) {
      const comp = new Array(k).fill(0);
      componentsByLabel.set(label, comp);
      goalComponentsByLabel.set(label, comp);
      componentCountByLabel.set(label, 1);
      totalComponents += 1;
      totalAllowedEdges += finiteEdges;
      continue;
    }

    const allowedEdges = findAllowedEdges(reachable, matching, k);
    let labelAllowed = 0;
    for (let i = 0; i < k * k; i++) {
      if (allowedEdges[i]) labelAllowed++;
    }
    totalAllowedEdges += labelAllowed;

    const { boxComponents, goalComponents, count } =
      findComponents(allowedEdges, matching, k);

    if (!validateComponents(boxComponents, goalComponents, count, k)) {
      const comp = new Array(k).fill(0);
      componentsByLabel.set(label, comp);
      goalComponentsByLabel.set(label, comp);
      componentCountByLabel.set(label, 1);
      totalComponents += 1;
      continue;
    }

    componentsByLabel.set(label, boxComponents);
    goalComponentsByLabel.set(label, goalComponents);
    componentCountByLabel.set(label, count);
    totalComponents += count;
  }

  return {
    totalComponents,
    componentsByLabel,
    goalComponentsByLabel,
    componentCountByLabel,
    finiteEdges: totalFiniteEdges,
    allowedEdges: totalAllowedEdges,
    eliminatedEdges: totalFiniteEdges - totalAllowedEdges,
  };
}

/**
 * Build k×k reachability matrix. Entry [box * k + goal] = 1 if the box at
 * boxCells[box] can reach goalCells[goal] via some push sequence (relaxed,
 * ignoring other boxes), using the pre-computed reverse-push distance tables.
 */
function buildReachabilityMatrix(
  board: CompiledSearchBoard,
  boxCells: readonly number[],
  goalCells: readonly number[],
): Uint8Array {
  const k = boxCells.length;
  const matrix = new Uint8Array(k * k);
  for (let goal = 0; goal < k; goal++) {
    const distances = board.reversePushDistancesByGoal.get(goalCells[goal]);
    if (!distances) continue;
    for (let box = 0; box < k; box++) {
      if (distances[boxCells[box]] >= 0) matrix[box * k + goal] = 1;
    }
  }
  return matrix;
}

function countFiniteEdges(reachable: Uint8Array, k: number): number {
  let count = 0;
  for (let i = 0; i < k * k; i++) {
    if (reachable[i]) count++;
  }
  return count;
}

/**
 * Standard augmenting-path bipartite matching. Returns matchBoxToGoal
 * (box index → goal index) or null if no perfect matching exists.
 */
function findPerfectMatching(
  reachable: Uint8Array,
  k: number,
): Int32Array | null {
  const matchBoxToGoal = new Int32Array(k).fill(-1);
  const matchGoalToBox = new Int32Array(k).fill(-1);
  const visited = new Uint8Array(k);

  function augment(box: number): boolean {
    for (let goal = 0; goal < k; goal++) {
      if (!reachable[box * k + goal] || visited[goal]) continue;
      visited[goal] = 1;
      if (matchGoalToBox[goal] < 0 || augment(matchGoalToBox[goal])) {
        matchBoxToGoal[box] = goal;
        matchGoalToBox[goal] = box;
        return true;
      }
    }
    return false;
  }

  let matched = 0;
  for (let box = 0; box < k; box++) {
    visited.fill(0);
    if (augment(box)) matched++;
  }

  return matched === k ? matchBoxToGoal : null;
}

/**
 * Find edges that appear in some perfect matching via alternating-cycle
 * analysis. Contracts matching edges and checks mutual reachability in
 * the resulting directed graph.
 *
 * Port of perfectMatchingDomains() from sokomind-engine/source/heuristic.js.
 */
function findAllowedEdges(
  reachable: Uint8Array,
  matching: Int32Array,
  k: number,
): Uint8Array {
  const matchedGoalByBox = matching;
  const matchedBoxByGoal = new Int32Array(k);
  for (let box = 0; box < k; box++) {
    matchedBoxByGoal[matchedGoalByBox[box]] = box;
  }

  const adjacency: number[][] = Array.from({ length: k }, () => []);
  for (let box = 0; box < k; box++) {
    for (let goal = 0; goal < k; goal++) {
      if (!reachable[box * k + goal]) continue;
      if (goal === matchedGoalByBox[box]) continue;
      adjacency[box].push(matchedBoxByGoal[goal]);
    }
  }

  const reaches = new Uint8Array(k * k);
  const stack: number[] = [];
  for (let origin = 0; origin < k; origin++) {
    reaches[origin * k + origin] = 1;
    stack.length = 0;
    stack.push(origin);
    while (stack.length > 0) {
      const node = stack.pop()!;
      const neighbors = adjacency[node];
      for (let i = neighbors.length - 1; i >= 0; i--) {
        const next = neighbors[i];
        if (reaches[origin * k + next]) continue;
        reaches[origin * k + next] = 1;
        stack.push(next);
      }
    }
  }

  const allowed = new Uint8Array(k * k);
  for (let box = 0; box < k; box++) {
    for (let goal = 0; goal < k; goal++) {
      if (!reachable[box * k + goal]) continue;
      if (goal === matchedGoalByBox[box]) {
        allowed[box * k + goal] = 1;
        continue;
      }
      const matchedBox = matchedBoxByGoal[goal];
      if (reaches[box * k + matchedBox] && reaches[matchedBox * k + box]) {
        allowed[box * k + goal] = 1;
      }
    }
  }

  return allowed;
}

/**
 * Find connected components of the allowed-edge bipartite graph using
 * union-find. Nodes 0..k-1 are boxes, k..2k-1 are goals.
 */
function findComponents(
  allowedEdges: Uint8Array,
  _matching: Int32Array,
  k: number,
): { boxComponents: number[]; goalComponents: number[]; count: number } {
  const parent = new Int32Array(2 * k);
  const rank = new Uint8Array(2 * k);
  for (let i = 0; i < 2 * k; i++) parent[i] = i;

  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }

  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (rank[ra] < rank[rb]) {
      parent[ra] = rb;
    } else if (rank[ra] > rank[rb]) {
      parent[rb] = ra;
    } else {
      parent[rb] = ra;
      rank[ra]++;
    }
  }

  for (let box = 0; box < k; box++) {
    for (let goal = 0; goal < k; goal++) {
      if (allowedEdges[box * k + goal]) {
        union(box, k + goal);
      }
    }
  }

  const rootToComponent = new Map<number, number>();
  let nextComponent = 0;

  const boxComponents = new Array<number>(k);
  for (let box = 0; box < k; box++) {
    const root = find(box);
    let comp = rootToComponent.get(root);
    if (comp === undefined) {
      comp = nextComponent++;
      rootToComponent.set(root, comp);
    }
    boxComponents[box] = comp;
  }

  const goalComponents = new Array<number>(k);
  for (let goal = 0; goal < k; goal++) {
    const root = find(k + goal);
    let comp = rootToComponent.get(root);
    if (comp === undefined) {
      comp = nextComponent++;
      rootToComponent.set(root, comp);
    }
    goalComponents[goal] = comp;
  }

  return { boxComponents, goalComponents, count: nextComponent };
}

function validateComponents(
  boxComponents: number[],
  goalComponents: number[],
  count: number,
  k: number,
): boolean {
  const boxCounts = new Int32Array(count);
  const goalCounts = new Int32Array(count);
  for (let i = 0; i < k; i++) {
    boxCounts[boxComponents[i]]++;
    goalCounts[goalComponents[i]]++;
  }
  for (let c = 0; c < count; c++) {
    if (boxCounts[c] !== goalCounts[c]) return false;
  }
  return true;
}
