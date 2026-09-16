import type { CompiledSearchBoard } from "./compiled-board.ts";
import type {
  SingleBoxPushGraph,
  ComponentViableCorridor,
} from "./single-box-push-graph.ts";
import {
  singleBoxCanReach,
  computeComponentCorridor,
} from "./single-box-push-graph.ts";

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
  /** label → per-component viable corridors */
  readonly corridorsByLabel: ReadonlyMap<string, readonly ComponentViableCorridor[]>;
}

export interface MatchingComponent {
  readonly id: number;
  readonly label: string;
  readonly initialCells: readonly number[];
  readonly goalCells: readonly number[];
  readonly corridor: ComponentViableCorridor;
}

export function extractMatchingComponents(
  board: CompiledSearchBoard,
  result: MatchingComponentResult,
): readonly MatchingComponent[] {
  const components: MatchingComponent[] = [];
  let globalId = 0;

  for (const [label, goalCells] of board.goalCellsByLabel) {
    const boxCells: number[] = [];
    for (const box of board.source.initialBoxes) {
      if (box.label === label) {
        const cell = board.cellAt(box.position.row, box.position.column);
        if (cell >= 0) boxCells.push(cell);
      }
    }

    const compCount = result.componentCountByLabel.get(label) ?? 1;
    const boxComps = result.componentsByLabel.get(label);
    const goalComps = result.goalComponentsByLabel.get(label);
    const corridors = result.corridorsByLabel.get(label);

    for (let c = 0; c < compCount; c++) {
      const compBoxCells: number[] = [];
      const compGoalCells: number[] = [];

      if (boxComps) {
        for (let i = 0; i < boxComps.length; i++) {
          if (boxComps[i] === c) compBoxCells.push(boxCells[i]);
        }
      } else {
        compBoxCells.push(...boxCells);
      }

      if (goalComps) {
        for (let i = 0; i < goalComps.length; i++) {
          if (goalComps[i] === c) compGoalCells.push(goalCells[i]);
        }
      } else {
        compGoalCells.push(...goalCells);
      }

      const corridor = corridors?.[c];
      if (!corridor) continue;

      components.push({
        id: globalId++,
        label,
        initialCells: compBoxCells,
        goalCells: compGoalCells,
        corridor,
      });
    }
  }

  return components;
}

export function analyzeMatchingComponents(
  board: CompiledSearchBoard,
  singleBoxGraph?: SingleBoxPushGraph,
): MatchingComponentResult {
  const componentsByLabel = new Map<string, readonly number[]>();
  const goalComponentsByLabel = new Map<string, readonly number[]>();
  const componentCountByLabel = new Map<string, number>();
  const corridorsByLabel = new Map<string, readonly ComponentViableCorridor[]>();
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

      if (singleBoxGraph) {
        corridorsByLabel.set(label, [
          computeComponentCorridor(singleBoxGraph, boxCells, [...goalCells]),
        ]);
      }
      continue;
    }

    const reachable = singleBoxGraph
      ? buildReachabilityMatrixFromGraph(singleBoxGraph, boxCells, goalCells)
      : buildReachabilityMatrix(board, boxCells, goalCells);
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
      if (singleBoxGraph) {
        corridorsByLabel.set(label, [
          computeComponentCorridor(singleBoxGraph, boxCells, [...goalCells]),
        ]);
      }
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
      if (singleBoxGraph) {
        corridorsByLabel.set(label, [
          computeComponentCorridor(singleBoxGraph, boxCells, [...goalCells]),
        ]);
      }
      continue;
    }

    componentsByLabel.set(label, boxComponents);
    goalComponentsByLabel.set(label, goalComponents);
    componentCountByLabel.set(label, count);
    totalComponents += count;

    if (singleBoxGraph) {
      const corridors: ComponentViableCorridor[] = [];
      for (let c = 0; c < count; c++) {
        const compBoxCells: number[] = [];
        const compGoalCells: number[] = [];
        for (let i = 0; i < k; i++) {
          if (boxComponents[i] === c) compBoxCells.push(boxCells[i]);
          if (goalComponents[i] === c) compGoalCells.push(goalCells[i]);
        }
        corridors.push(
          computeComponentCorridor(singleBoxGraph, compBoxCells, compGoalCells),
        );
      }
      corridorsByLabel.set(label, corridors);
    }
  }

  return {
    totalComponents,
    componentsByLabel,
    goalComponentsByLabel,
    componentCountByLabel,
    finiteEdges: totalFiniteEdges,
    allowedEdges: totalAllowedEdges,
    eliminatedEdges: totalFiniteEdges - totalAllowedEdges,
    corridorsByLabel,
  };
}

function buildReachabilityMatrixFromGraph(
  graph: SingleBoxPushGraph,
  boxCells: readonly number[],
  goalCells: readonly number[],
): Uint8Array {
  const k = boxCells.length;
  const matrix = new Uint8Array(k * k);
  for (let box = 0; box < k; box++) {
    for (let goal = 0; goal < k; goal++) {
      if (singleBoxCanReach(graph, boxCells[box], goalCells[goal])) {
        matrix[box * k + goal] = 1;
      }
    }
  }
  return matrix;
}

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
 * analysis. An edge (box, goal) is allowed iff it is in the initial matching
 * OR the contracted directed graph has a cycle through box and matchedBox(goal).
 */
export function findAllowedEdges(
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
