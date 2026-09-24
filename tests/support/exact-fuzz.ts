/**
 * Seeded differential fuzz of the exact move engines (ACTION-ITEMS P8.8).
 *
 * - `generateFuzzBoard` builds a small board from a seed. Layouts are sparse,
 *   dense, corridor, rooms, and repeated motif (D4-transformed copies of one
 *   corridor motif with random stubs, so congruent windows get different
 *   exits). Boxes are placed by reverse pulls from the goals, which always
 *   gives a solvable board, or at random.
 * - `fuzzOracle` is a step-level BFS that parses the rows itself. It shares no
 *   code with the solver or the core engine; campaigns cross-check it against
 *   `exactRemainingMoves` on small boards.
 * - `runFuzzEngine` runs exact A* or IDA* and replays any solution through the
 *   core engine; `classifyFuzzRun` names the soundness failure, if any. A
 *   limit result is a bound, never a failure.
 */
import {
  encodeActionLog,
  parsePuzzleRows,
  replayActionLog,
} from "../../src/core/index.ts";
import type {
  SolverExecutionContext,
  SolverLimits,
  SolverProofKind,
  SolverRequest,
  SolverResult,
  SolverSolution,
} from "../../src/solver/contracts.ts";
import { compileSearchBoard } from "../../src/solver/search/compiled-board.ts";
import { runExactMoveAStar } from "../../src/solver/search/exact-move-astar.ts";
import {
  DEFAULT_EXACT_SEARCH_FEATURES,
  EXACT_SEARCH_FEATURE_KEYS,
  type ExactSearchFeatures,
} from "../../src/solver/search/exact-search-features.ts";
import { runIdaStarSearch } from "../../src/solver/search/ida-star.ts";
import { toDenseBoxes } from "../../src/solver/search/model.ts";
import { verifySolverSolution } from "../../src/solver/verification.ts";
import { exactRemainingMoves } from "./exact-solver-oracle.ts";

// ---------------------------------------------------------------------------
// Seeded RNG
// ---------------------------------------------------------------------------

export interface FuzzRng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max], both inclusive. */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  chance(probability: number): boolean;
}

/** mulberry32: small, fast and fully determined by the seed. */
export function createFuzzRng(seed: number): FuzzRng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => items[Math.floor(next() * items.length)],
    chance: (probability) => next() < probability,
  };
}

// ---------------------------------------------------------------------------
// Board generation
// ---------------------------------------------------------------------------

export type FuzzLayout = "sparse" | "dense" | "corridor" | "rooms" | "motif";
export type FuzzPlacement = "reverse-pull" | "random";
export type FuzzLabelMode = "all-x" | "typed" | "mixed" | "duplicate-typed";

export const FUZZ_LAYOUTS: readonly FuzzLayout[] = Object.freeze([
  "sparse",
  "dense",
  "corridor",
  "rooms",
  "motif",
]);
export const FUZZ_PLACEMENTS: readonly FuzzPlacement[] = Object.freeze([
  "reverse-pull",
  "random",
]);
export const FUZZ_LABEL_MODES: readonly FuzzLabelMode[] = Object.freeze([
  "all-x",
  "typed",
  "mixed",
  "duplicate-typed",
]);

/** Boards with more floor than this are rejected. */
export const MAX_FUZZ_FLOOR = 36;

export interface FuzzBoard {
  readonly seed: number;
  readonly rows: readonly string[];
  readonly layout: FuzzLayout;
  readonly placement: FuzzPlacement;
  readonly labelMode: FuzzLabelMode;
  readonly boxCount: number;
}

type Cell = readonly [row: number, column: number];
type OpenGrid = boolean[][];

const STEPS: readonly Cell[] = Object.freeze([
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
]);

function blankGrid(height: number, width: number): OpenGrid {
  return Array.from({ length: height }, () => new Array<boolean>(width).fill(false));
}

/** True for cells inside the one-wall border ring. */
function isInterior(open: OpenGrid, row: number, column: number): boolean {
  return row > 0 && column > 0 && row < open.length - 1 && column < open[0].length - 1;
}

function isOpen(open: OpenGrid, row: number, column: number): boolean {
  return open[row]?.[column] === true;
}

function floorCells(open: OpenGrid): Cell[] {
  const cells: Cell[] = [];
  open.forEach((line, row) => line.forEach((value, column) => {
    if (value) cells.push([row, column]);
  }));
  return cells;
}

function floorDegree(open: OpenGrid, [row, column]: Cell): number {
  return STEPS.filter(([dr, dc]) => isOpen(open, row + dr, column + dc)).length;
}

function scatterLayout(
  rng: FuzzRng,
  maxInteriorRows: number,
  minWallChance: number,
  maxWallChance: number,
): OpenGrid {
  const open = blankGrid(rng.int(3, maxInteriorRows) + 2, rng.int(3, 7) + 2);
  const wallChance = minWallChance + rng.next() * (maxWallChance - minWallChance);
  for (let row = 1; row < open.length - 1; row += 1) {
    for (let column = 1; column < open[0].length - 1; column += 1) {
      open[row][column] = !rng.chance(wallChance);
    }
  }
  return open;
}

/** Random walk that carves straight runs of 1-4 cells. */
function corridorLayout(rng: FuzzRng): OpenGrid {
  const open = blankGrid(rng.int(4, 8) + 2, rng.int(4, 9) + 2);
  const target = rng.int(10, 26);
  let row = rng.int(1, open.length - 2);
  let column = rng.int(1, open[0].length - 2);
  open[row][column] = true;
  let carved = 1;
  for (let guard = 0; carved < target && guard < 400; guard += 1) {
    const [dr, dc] = rng.pick(STEPS);
    const run = rng.int(1, 4);
    for (let step = 0; step < run && isInterior(open, row + dr, column + dc); step += 1) {
      row += dr;
      column += dc;
      if (!open[row][column]) {
        open[row][column] = true;
        carved += 1;
      }
    }
  }
  return open;
}

function carveStubs(rng: FuzzRng, open: OpenGrid, count: number): void {
  for (let stub = 0; stub < count; stub += 1) {
    let [row, column] = rng.pick(floorCells(open));
    const [dr, dc] = rng.pick(STEPS);
    const length = rng.int(1, 2);
    for (let step = 0; step < length && isInterior(open, row + dr, column + dc); step += 1) {
      row += dr;
      column += dc;
      open[row][column] = true;
    }
  }
}

/** 2-3 rectangles joined by L-shaped corridors, plus stubs. */
function roomsLayout(rng: FuzzRng): OpenGrid {
  const open = blankGrid(rng.int(5, 8) + 2, rng.int(6, 10) + 2);
  const height = open.length - 2;
  const width = open[0].length - 2;
  const centers: Cell[] = [];
  const roomCount = rng.int(2, 3);
  for (let room = 0; room < roomCount; room += 1) {
    const roomHeight = rng.int(2, 3);
    const roomWidth = rng.int(2, 4);
    const top = rng.int(1, height - roomHeight + 1);
    const left = rng.int(1, width - roomWidth + 1);
    for (let row = top; row < top + roomHeight; row += 1) {
      for (let column = left; column < left + roomWidth; column += 1) open[row][column] = true;
    }
    centers.push([top + Math.floor(roomHeight / 2), left + Math.floor(roomWidth / 2)]);
  }
  for (let index = 1; index < centers.length; index += 1) {
    const [fromRow, fromColumn] = centers[index - 1];
    const [toRow, toColumn] = centers[index];
    const bendRow = rng.chance(0.5) ? fromRow : toRow;
    const bendColumn = bendRow === fromRow ? toColumn : fromColumn;
    for (const [[r1, c1], [r2, c2]] of [
      [[fromRow, fromColumn], [bendRow, bendColumn]],
      [[bendRow, bendColumn], [toRow, toColumn]],
    ] as const) {
      for (let row = Math.min(r1, r2); row <= Math.max(r1, r2); row += 1) {
        for (let column = Math.min(c1, c2); column <= Math.max(c1, c2); column += 1) {
          open[row][column] = true;
        }
      }
    }
  }
  carveStubs(rng, open, rng.int(0, 2));
  return open;
}

/**
 * D4 transform: mirror the columns when `transform >> 2` is set, then rotate a
 * quarter turn `transform & 3` times, mapping (r, c) in h x w to (c, h-1-r).
 */
function transformMotif(motif: OpenGrid, transform: number): OpenGrid {
  let grid = motif.map((line) => (transform >> 2 ? [...line].reverse() : [...line]));
  for (let turn = 0; turn < (transform & 3); turn += 1) {
    const height = grid.length;
    const rotated = blankGrid(grid[0].length, height);
    grid.forEach((line, row) => line.forEach((value, column) => {
      rotated[column][height - 1 - row] = value;
    }));
    grid = rotated;
  }
  return grid;
}

/**
 * Two or three D4-transformed copies of one small corridor motif, side by side
 * below a hub corridor. Each copy connects to the hub at its topmost floor
 * cell, and random stubs (motif cells included) give the congruent windows
 * different exits. This is the shape the pattern-deadlock key bug (P0.9)
 * needed.
 */
function motifLayout(rng: FuzzRng): OpenGrid {
  const motif = blankGrid(rng.int(3, 4), rng.int(3, 4));
  let row = 0;
  let column = rng.int(0, motif[0].length - 1);
  motif[row][column] = true;
  const target = rng.int(3, 7);
  let carved = 1;
  for (let guard = 0; carved < target && guard < 100; guard += 1) {
    const [dr, dc] = rng.pick(STEPS);
    if (motif[row + dr]?.[column + dc] === undefined) continue;
    row += dr;
    column += dc;
    if (!motif[row][column]) {
      motif[row][column] = true;
      carved += 1;
    }
  }
  const copies = Array.from({ length: rng.int(2, 3) }, () => transformMotif(motif, rng.int(0, 7)));
  // Border, hub row, motif rows, one spare row for stubs, border.
  const height = 4 + Math.max(...copies.map((copy) => copy.length));
  const width = 2 + copies.reduce((sum, copy) => sum + copy[0].length, 0) + copies.length - 1;
  const open = blankGrid(height, width);
  for (let hubColumn = 1; hubColumn < width - 1; hubColumn += 1) open[1][hubColumn] = true;
  let left = 1;
  for (const copy of copies) {
    let top: Cell | undefined;
    for (let copyRow = 0; copyRow < copy.length; copyRow += 1) {
      for (let copyColumn = 0; copyColumn < copy[copyRow].length; copyColumn += 1) {
        if (!copy[copyRow][copyColumn]) continue;
        open[2 + copyRow][left + copyColumn] = true;
        top ??= [copyRow, copyColumn];
      }
    }
    if (top) {
      for (let connector = 2; connector < 2 + top[0]; connector += 1) open[connector][left + top[1]] = true;
    }
    left += copy[0].length + 1;
  }
  carveStubs(rng, open, rng.int(1, 3));
  return open;
}

function largestComponent(open: OpenGrid): OpenGrid {
  const component = open.map((line) => line.map(() => -1));
  let best = -1;
  let bestSize = 0;
  let id = 0;
  for (const [startRow, startColumn] of floorCells(open)) {
    if (component[startRow][startColumn] >= 0) continue;
    const stack: Cell[] = [[startRow, startColumn]];
    component[startRow][startColumn] = id;
    let size = 0;
    for (let cell = stack.pop(); cell !== undefined; cell = stack.pop()) {
      const [row, column] = cell;
      size += 1;
      for (const [dr, dc] of STEPS) {
        if (isOpen(open, row + dr, column + dc) && component[row + dr][column + dc] < 0) {
          component[row + dr][column + dc] = id;
          stack.push([row + dr, column + dc]);
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = id;
    }
    id += 1;
  }
  return open.map((line, row) => line.map((value, column) => value && component[row][column] === best));
}

/** Removes random dead-end cells until the floor fits; never disconnects. */
function trimDeadEnds(rng: FuzzRng, open: OpenGrid, targetFloor: number): void {
  for (let guard = 0; guard < 500; guard += 1) {
    const floor = floorCells(open);
    if (floor.length <= targetFloor) return;
    const deadEnds = floor.filter((cell) => floorDegree(open, cell) <= 1);
    if (deadEnds.length === 0) return;
    const [row, column] = rng.pick(deadEnds);
    open[row][column] = false;
  }
}

function buildLayout(layout: FuzzLayout, rng: FuzzRng): OpenGrid {
  switch (layout) {
    case "sparse":
      return scatterLayout(rng, 5, 0, 0.15);
    case "dense":
      return scatterLayout(rng, 6, 0.2, 0.4);
    case "corridor":
      return corridorLayout(rng);
    case "rooms":
      return roomsLayout(rng);
    case "motif":
      return motifLayout(rng);
  }
}

/** 1-4 boxes, weighted about 10/35/35/20%. */
function pickBoxCount(rng: FuzzRng): number {
  const roll = rng.next();
  return roll < 0.1 ? 1 : roll < 0.45 ? 2 : roll < 0.8 ? 3 : 4;
}

function chooseLabels(rng: FuzzRng, boxCount: number): { mode: FuzzLabelMode; labels: string[] } {
  const mode = rng.pick(boxCount === 1 ? FUZZ_LABEL_MODES.slice(0, 2) : FUZZ_LABEL_MODES);
  const labels: string[] = [];
  switch (mode) {
    case "all-x":
      while (labels.length < boxCount) labels.push("X");
      break;
    case "typed":
      labels.push(..."ABCD".slice(0, boxCount));
      break;
    case "mixed":
      labels.push("X", rng.pick(["A", "B"]));
      while (labels.length < boxCount) labels.push(rng.pick(["X", "A", "B"]));
      break;
    case "duplicate-typed":
      labels.push("A", "A");
      while (labels.length < boxCount) labels.push(rng.pick(["X", "B", "A"]));
      break;
  }
  return { mode, labels };
}

function cellKey([row, column]: Cell): string {
  return `${row},${column}`;
}

/** Distinct goal cells; each goal prefers a dead end 40% of the time. */
function chooseGoals(rng: FuzzRng, open: OpenGrid, count: number): Cell[] {
  const floor = floorCells(open);
  const deadEnds = floor.filter((cell) => floorDegree(open, cell) === 1);
  const used = new Set<string>();
  const goals: Cell[] = [];
  while (goals.length < count) {
    const freeDeadEnds = deadEnds.filter((cell) => !used.has(cellKey(cell)));
    const pool = freeDeadEnds.length > 0 && rng.chance(0.4)
      ? freeDeadEnds
      : floor.filter((cell) => !used.has(cellKey(cell)));
    const goal = rng.pick(pool);
    used.add(cellKey(goal));
    goals.push(goal);
  }
  return goals;
}

interface Placement {
  readonly boxes: readonly Cell[];
  readonly robot: Cell;
}

/**
 * Starts from the solved state (each box on its own goal) and applies random
 * reverse moves. A pull is the reverse of a push, so the result can always be
 * pushed back to the solved state.
 */
function reversePullPlacement(rng: FuzzRng, open: OpenGrid, goals: readonly Cell[]): Placement | null {
  const boxes: Cell[] = [...goals];
  const boxAt = new Map(boxes.map((cell, index) => [cellKey(cell), index]));
  const goalKeys = new Set(goals.map(cellKey));
  const free = floorCells(open).filter((cell) => !boxAt.has(cellKey(cell)));
  if (free.length === 0) return null;
  let robot = rng.pick(free);
  const pullChance = rng.pick([0.5, 0.75, 0.9]);
  const steps = rng.int(20, 300);
  const offGoals = (): boolean =>
    !goalKeys.has(cellKey(robot)) && boxes.every((cell) => !goalKeys.has(cellKey(cell)));
  for (let step = 0; step < steps + 300; step += 1) {
    if (step >= steps && offGoals()) break;
    const [dr, dc] = rng.pick(STEPS);
    const next: Cell = [robot[0] + dr, robot[1] + dc];
    if (!isOpen(open, next[0], next[1]) || boxAt.has(cellKey(next))) continue;
    const behind = boxAt.get(cellKey([robot[0] - dr, robot[1] - dc]));
    if (behind !== undefined && rng.chance(pullChance)) {
      boxAt.delete(cellKey(boxes[behind]));
      boxes[behind] = robot;
      boxAt.set(cellKey(robot), behind);
    }
    robot = next;
  }
  return offGoals() ? { boxes, robot } : null;
}

/** Boxes on non-goal cells with floor degree >= 2; often unsolvable. */
function randomPlacement(rng: FuzzRng, open: OpenGrid, goals: readonly Cell[]): Placement | null {
  const goalKeys = new Set(goals.map(cellKey));
  const candidates = floorCells(open).filter((cell) => !goalKeys.has(cellKey(cell)));
  const boxes: Cell[] = [];
  const used = new Set<string>();
  const boxPool = candidates.filter((cell) => floorDegree(open, cell) >= 2);
  while (boxes.length < goals.length) {
    const pool = boxPool.filter((cell) => !used.has(cellKey(cell)));
    if (pool.length === 0) return null;
    const box = rng.pick(pool);
    used.add(cellKey(box));
    boxes.push(box);
  }
  const robotPool = candidates.filter((cell) => !used.has(cellKey(cell)));
  return robotPool.length === 0 ? null : { boxes, robot: rng.pick(robotPool) };
}

/** Crops to the floor's bounding box plus a one-wall ring. */
export function cropRows(rows: readonly string[]): string[] {
  const width = Math.max(0, ...rows.map((row) => row.length));
  const grid = rows.map((row) => row.padEnd(width, "O"));
  let top = Infinity;
  let bottom = -Infinity;
  let left = Infinity;
  let right = -Infinity;
  grid.forEach((row, rowIndex) => [...row].forEach((symbol, column) => {
    if (symbol === "O") return;
    top = Math.min(top, rowIndex);
    bottom = Math.max(bottom, rowIndex);
    left = Math.min(left, column);
    right = Math.max(right, column);
  }));
  if (top === Infinity) return [...grid];
  const wall = "O".repeat(right - left + 3);
  return [
    wall,
    ...grid.slice(top, bottom + 1).map((row) => `O${row.slice(left, right + 1)}O`),
    wall,
  ];
}

function goalSymbol(label: string): string {
  return label === "X" ? "S" : label.toLowerCase();
}

/** Returns null when the seed gives an unusable board (the caller skips it). */
export function generateFuzzBoard(seed: number): FuzzBoard | null {
  const rng = createFuzzRng(seed);
  const layout = rng.pick(FUZZ_LAYOUTS);
  const open = largestComponent(buildLayout(layout, rng));
  // Trimming would erase the motif stubs that make congruent windows differ.
  if (layout !== "motif") trimDeadEnds(rng, open, rng.pick([14, 18, 22, 26, 30]));
  const floorCount = floorCells(open).length;
  const boxCount = pickBoxCount(rng);
  if (floorCount < 2 * boxCount + 2 || floorCount > MAX_FUZZ_FLOOR) return null;
  const { mode, labels } = chooseLabels(rng, boxCount);
  const goals = chooseGoals(rng, open, boxCount);
  const placement: FuzzPlacement = rng.chance(0.75) ? "reverse-pull" : "random";
  const placed = placement === "reverse-pull"
    ? reversePullPlacement(rng, open, goals)
    : randomPlacement(rng, open, goals);
  if (!placed) return null;
  const symbols = open.map((line) => line.map((value) => (value ? " " : "O")));
  goals.forEach(([row, column], index) => {
    symbols[row][column] = goalSymbol(labels[index]);
  });
  placed.boxes.forEach(([row, column], index) => {
    symbols[row][column] = labels[index];
  });
  symbols[placed.robot[0]][placed.robot[1]] = "R";
  return Object.freeze({
    seed,
    rows: Object.freeze(cropRows(symbols.map((line) => line.join("")))),
    layout,
    placement,
    labelMode: mode,
    boxCount,
  });
}

// ---------------------------------------------------------------------------
// Independent step oracle
// ---------------------------------------------------------------------------

export interface FuzzOracleResult {
  /** Minimum moves; null when unsolvable or capped. */
  readonly moves: number | null;
  readonly capped: boolean;
  readonly states: number;
}

/**
 * Breadth-first search over (robot, boxes) with one move per walk or push.
 * Box cells are kept sorted within each label group, and a state is one
 * integer key, so equal-label boxes share one state.
 */
export function fuzzOracle(rows: readonly string[], maxStates: number): FuzzOracleResult {
  const width = Math.max(0, ...rows.map((row) => row.length));
  const indexAt = rows.map(() => new Array<number>(width).fill(-1));
  const goalLabels: string[] = [];
  const boxes: { label: string; cell: number }[] = [];
  let robot = -1;
  rows.forEach((row, rowIndex) => {
    for (let column = 0; column < width; column += 1) {
      const symbol = row[column] ?? "O";
      if (symbol === "O") continue;
      const cell = goalLabels.length;
      indexAt[rowIndex][column] = cell;
      goalLabels.push(symbol === "S" ? "X" : /^[a-z]$/.test(symbol) ? symbol.toUpperCase() : "");
      if (symbol === "R") robot = cell;
      else if (symbol !== "S" && /^[A-Z]$/.test(symbol)) boxes.push({ label: symbol, cell });
      else if (symbol !== " " && symbol !== "S" && !/^[a-z]$/.test(symbol)) {
        throw new Error(`fuzzOracle: unsupported symbol ${JSON.stringify(symbol)}`);
      }
    }
  });
  if (robot < 0) throw new Error("fuzzOracle: board has no robot");
  const cellCount = goalLabels.length;
  const boxCount = boxes.length;
  if (cellCount ** (boxCount + 1) >= Number.MAX_SAFE_INTEGER) {
    throw new Error("fuzzOracle: board is too large for integer state keys");
  }
  const neighbors = new Int32Array(cellCount * 4).fill(-1);
  rows.forEach((_row, rowIndex) => {
    for (let column = 0; column < width; column += 1) {
      const cell = indexAt[rowIndex][column];
      if (cell < 0) continue;
      STEPS.forEach(([dr, dc], direction) => {
        neighbors[cell * 4 + direction] = indexAt[rowIndex + dr]?.[column + dc] ?? -1;
      });
    }
  });

  boxes.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : a.cell - b.cell));
  const labels = [...new Set(boxes.map((box) => box.label))];
  const slotGroup = Int32Array.from(boxes, (box) => labels.indexOf(box.label));
  const groupStart = Int32Array.from(labels, (label) => boxes.findIndex((box) => box.label === label));
  const groupEnd = Int32Array.from(labels, (_label, group) =>
    group + 1 < labels.length ? groupStart[group + 1] : boxCount);
  const goalGroup = Int32Array.from(goalLabels, (label) => labels.indexOf(label));

  const encode = (slots: Int32Array, robotCell: number): number => {
    let key = 0;
    for (let slot = 0; slot < boxCount; slot += 1) key = key * cellCount + slots[slot];
    return key * cellCount + robotCell;
  };
  const decode = (key: number, slots: Int32Array): number => {
    const robotCell = key % cellCount;
    let rest = (key - robotCell) / cellCount;
    for (let slot = boxCount - 1; slot >= 0; slot -= 1) {
      slots[slot] = rest % cellCount;
      rest = (rest - slots[slot]) / cellCount;
    }
    return robotCell;
  };
  const solved = (slots: Int32Array): boolean => {
    for (let slot = 0; slot < boxCount; slot += 1) {
      if (goalGroup[slots[slot]] !== slotGroup[slot]) return false;
    }
    return true;
  };

  const start = Int32Array.from(boxes, (box) => box.cell);
  if (solved(start)) return { moves: 0, capped: false, states: 1 };
  const seen = new Set<number>([encode(start, robot)]);
  let frontier = [encode(start, robot)];
  const slots = new Int32Array(boxCount);
  const pushed = new Int32Array(boxCount);
  for (let depth = 1; frontier.length > 0; depth += 1) {
    const nextFrontier: number[] = [];
    for (const key of frontier) {
      const robotCell = decode(key, slots);
      for (let direction = 0; direction < 4; direction += 1) {
        const target = neighbors[robotCell * 4 + direction];
        if (target < 0) continue;
        const boxSlot = slots.indexOf(target);
        let nextKey: number;
        if (boxSlot < 0) {
          nextKey = encode(slots, target);
        } else {
          const beyond = neighbors[target * 4 + direction];
          if (beyond < 0 || slots.includes(beyond)) continue;
          pushed.set(slots);
          pushed[boxSlot] = beyond;
          // Restore the sorted order inside the pushed box's label group.
          const group = slotGroup[boxSlot];
          for (let slot = boxSlot; slot > groupStart[group] && pushed[slot - 1] > pushed[slot]; slot -= 1) {
            [pushed[slot - 1], pushed[slot]] = [pushed[slot], pushed[slot - 1]];
          }
          for (let slot = boxSlot; slot + 1 < groupEnd[group] && pushed[slot + 1] < pushed[slot]; slot += 1) {
            [pushed[slot + 1], pushed[slot]] = [pushed[slot], pushed[slot + 1]];
          }
          if (solved(pushed)) return { moves: depth, capped: false, states: seen.size };
          nextKey = encode(pushed, target);
        }
        if (seen.has(nextKey)) continue;
        seen.add(nextKey);
        if (seen.size > maxStates) return { moves: null, capped: true, states: seen.size };
        nextFrontier.push(nextKey);
      }
    }
    frontier = nextFrontier;
  }
  return { moves: null, capped: false, states: seen.size };
}

/** The repository oracle (`exactRemainingMoves`, no state cap). */
export function referenceOracleMoves(rows: readonly string[]): number | null {
  const parsed = parsePuzzleRows([...rows]);
  const board = compileSearchBoard(parsed);
  return exactRemainingMoves(
    board,
    board.cellAt(parsed.initialRobot.row, parsed.initialRobot.column),
    toDenseBoxes(board, parsed.initialBoxes),
  ).exactMoves;
}

// ---------------------------------------------------------------------------
// Engine runs
// ---------------------------------------------------------------------------

export type FuzzEngine = "astar" | "ida";

export const FUZZ_ENGINES: readonly FuzzEngine[] = Object.freeze(["astar", "ida"]);

export interface FuzzVariant {
  readonly name: string;
  readonly features: Partial<ExactSearchFeatures>;
}

function variant(name: string, features: Partial<ExactSearchFeatures>): FuzzVariant {
  return Object.freeze({ name, features: Object.freeze({ ...features }) });
}

/**
 * Default features, tunnel macros on (they are off by default), and each
 * default-on feature switched off by itself.
 */
export const FUZZ_VARIANTS: readonly FuzzVariant[] = Object.freeze([
  variant("default", {}),
  variant("tunnelMacros", { tunnelMacros: true }),
  ...EXACT_SEARCH_FEATURE_KEYS.filter((key) => DEFAULT_EXACT_SEARCH_FEATURES[key]).map((key) =>
    variant(`no-${key}`, { [key]: false } as Partial<ExactSearchFeatures>)),
]);

/**
 * Opt-in features that claim an admissible bound. goalCutHeuristic is left out
 * on purpose: it is known not to be admissible (see exact-search-features.ts).
 */
export const FUZZ_OPT_IN_VARIANTS: readonly FuzzVariant[] = Object.freeze([
  variant("backwardPerimeter", { backwardPerimeter: true }),
  variant("componentPdb", { componentPdb: true }),
  variant("moveCostPatternPdb", { moveCostPatternPdb: true }),
]);

export interface FuzzRun {
  readonly engine: FuzzEngine;
  readonly variant: string;
  readonly features: Partial<ExactSearchFeatures>;
  readonly status: SolverResult["status"] | "error";
  readonly reason?: "exhausted" | "limit-reached" | "unsupported";
  readonly detail?: string;
  readonly moves?: number;
  readonly pushes?: number;
  readonly optimality?: "unknown" | "proven";
  readonly proofKind?: SolverProofKind;
  readonly lowerBound?: number;
  readonly upperBound?: number;
  /** Set when the returned solution does not replay. */
  readonly replayError?: string;
  /** Set when the engine threw. */
  readonly error?: string;
  readonly expandedStates: number;
  readonly counters: Readonly<Record<string, number>>;
}

function fuzzContext(): SolverExecutionContext {
  return {
    signal: new AbortController().signal,
    reportProgress: () => undefined,
    now: () => performance.now(),
  };
}

export function fuzzRequest(rows: readonly string[], limits: SolverLimits): SolverRequest {
  const parsed = parsePuzzleRows([...rows]);
  return {
    board: parsed,
    snapshot: {
      puzzleId: "fuzz",
      robot: parsed.initialRobot,
      boxes: parsed.initialBoxes,
      moves: 0,
      pushes: 0,
      solved: false,
    },
    objective: { kind: "moves" },
    limits,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Replays through both core paths: stepSnapshot and a live session. */
function replayFailure(
  request: SolverRequest,
  rows: readonly string[],
  solution: SolverSolution,
): string | undefined {
  const verified = verifySolverSolution(request, solution);
  if (!verified.valid) return `verifySolverSolution ${verified.code}: ${verified.message}`;
  try {
    const session = replayActionLog(
      { id: "fuzz", title: "fuzz", difficulty: "tutorial", boxes: request.board.initialBoxes.length, rows },
      encodeActionLog(solution.steps.map((step) => step.direction)),
    );
    if (!session.solved) return "replayActionLog: the final state is not solved";
    if (session.moves !== solution.moves || session.pushes !== solution.pushes) {
      return `replayActionLog: ${session.moves} moves/${session.pushes} pushes, ` +
        `solution claims ${solution.moves}/${solution.pushes}`;
    }
  } catch (error) {
    return `replayActionLog: ${errorText(error)}`;
  }
  return undefined;
}

export async function runFuzzEngine(
  engine: FuzzEngine,
  rows: readonly string[],
  fuzzVariant: FuzzVariant,
  limits: SolverLimits,
): Promise<FuzzRun> {
  const base = { engine, variant: fuzzVariant.name, features: fuzzVariant.features };
  let request: SolverRequest;
  let result: SolverResult;
  try {
    request = fuzzRequest(rows, limits);
    const options = { features: fuzzVariant.features };
    result = engine === "astar"
      ? await runExactMoveAStar(request, fuzzContext(), options)
      : await runIdaStarSearch(request, fuzzContext(), options);
  } catch (error) {
    return { ...base, status: "error", error: errorText(error), expandedStates: 0, counters: {} };
  }
  const common = {
    ...base,
    status: result.status,
    proofKind: result.proof?.kind,
    lowerBound: result.proof?.lowerBound,
    upperBound: result.proof?.upperBound,
    expandedStates: result.metrics.expandedStates ?? 0,
    counters: result.metrics.counters ?? {},
  };
  if (result.status === "solved") {
    return {
      ...common,
      moves: result.solution.moves,
      pushes: result.solution.pushes,
      optimality: result.solution.optimality,
      replayError: replayFailure(request, rows, result.solution),
    };
  }
  if (result.status === "unsolved") return { ...common, reason: result.reason, detail: result.detail };
  return common;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type FuzzFailureKind =
  /** The engine threw, was cancelled unasked, or called the board unsupported. */
  | "ENGINE_ERROR"
  /** The solution fails replay, or its move/push counts are wrong. */
  | "REPLAY_MISMATCH"
  /** A solution on an oracle-unsolvable board. */
  | "FALSE_SOLVABLE"
  /** Fewer moves than the oracle optimum, or a finite upper bound below it. */
  | "BEATS_ORACLE"
  /** A proven optimum that differs from the oracle. */
  | "WRONG_PROVEN_OPTIMUM"
  /** An unsolvability verdict on a solvable board. */
  | "FALSE_UNSOLVABLE"
  /** A lower bound above the oracle optimum. */
  | "LOWER_BOUND_ABOVE_OPTIMUM";

export const FUZZ_FAILURE_KINDS: readonly FuzzFailureKind[] = Object.freeze([
  "ENGINE_ERROR",
  "REPLAY_MISMATCH",
  "FALSE_SOLVABLE",
  "BEATS_ORACLE",
  "WRONG_PROVEN_OPTIMUM",
  "FALSE_UNSOLVABLE",
  "LOWER_BOUND_ABOVE_OPTIMUM",
]);

/**
 * `oracleMoves` is the exact optimum, or null for an unsolvable board. Never
 * call this with a capped oracle result. A limit result is a bound, so it
 * fails only when the bound itself is wrong.
 */
export function classifyFuzzRun(run: FuzzRun, oracleMoves: number | null): FuzzFailureKind | null {
  if (run.status === "error" || run.status === "cancelled" || run.reason === "unsupported") {
    return "ENGINE_ERROR";
  }
  if (run.status === "solved") {
    if (run.replayError !== undefined) return "REPLAY_MISMATCH";
    if (oracleMoves === null) return "FALSE_SOLVABLE";
    const upperBound = run.upperBound ?? Infinity;
    if ((run.moves ?? Infinity) < oracleMoves || upperBound < oracleMoves) return "BEATS_ORACLE";
    if ((run.optimality === "proven" || run.proofKind === "optimal") && run.moves !== oracleMoves) {
      return "WRONG_PROVEN_OPTIMUM";
    }
  } else if (oracleMoves !== null && (run.proofKind === "unsolvable" || run.reason === "exhausted")) {
    return "FALSE_UNSOLVABLE";
  }
  if (oracleMoves !== null && run.lowerBound !== undefined && run.lowerBound > oracleMoves) {
    return "LOWER_BOUND_ABOVE_OPTIMUM";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Minimization and reporting
// ---------------------------------------------------------------------------

function isValidRows(rows: readonly string[]): boolean {
  try {
    return parsePuzzleRows([...rows]).initialBoxes.length > 0;
  } catch {
    return false;
  }
}

function boxLabel(symbol: string): string | undefined {
  return /^[A-Z]$/.test(symbol) && !"ORS".includes(symbol) ? symbol : undefined;
}

function goalLabel(symbol: string): string | undefined {
  return symbol === "S" ? "X" : /^[a-z]$/.test(symbol) ? symbol.toUpperCase() : undefined;
}

/**
 * Greedy shrink: remove box/goal pairs with the same label, then turn plain
 * floor cells into walls, keeping each change while `stillFails` holds. A
 * predicate that throws counts as not failing.
 */
export async function minimizeFuzzBoard(
  rows: readonly string[],
  stillFails: (candidate: readonly string[]) => boolean | Promise<boolean>,
  maxChecks = 1_000,
): Promise<readonly string[]> {
  let current = [...rows];
  let checks = 0;
  const accept = async (grid: string[][]): Promise<boolean> => {
    const candidate = cropRows(grid.map((line) => line.join("")));
    if (checks >= maxChecks || !isValidRows(candidate)) return false;
    checks += 1;
    try {
      if (!(await stillFails(candidate))) return false;
    } catch {
      return false;
    }
    current = candidate;
    return true;
  };
  const cellsOf = (grid: string[][], test: (symbol: string) => boolean): Cell[] => {
    const cells: Cell[] = [];
    grid.forEach((line, row) => line.forEach((symbol, column) => {
      if (test(symbol)) cells.push([row, column]);
    }));
    return cells;
  };
  const shrinkOnce = async (): Promise<boolean> => {
    const grid = current.map((row) => [...row]);
    const boxes = cellsOf(grid, (symbol) => boxLabel(symbol) !== undefined);
    if (boxes.length > 1) {
      for (const [boxRow, boxColumn] of boxes) {
        const label = grid[boxRow][boxColumn];
        for (const [goalRow, goalColumn] of cellsOf(grid, (symbol) => goalLabel(symbol) === label)) {
          const candidate = grid.map((line) => [...line]);
          candidate[boxRow][boxColumn] = " ";
          candidate[goalRow][goalColumn] = " ";
          if (await accept(candidate)) return true;
        }
      }
    }
    for (const [row, column] of cellsOf(grid, (symbol) => symbol === " ")) {
      const candidate = grid.map((line) => [...line]);
      candidate[row][column] = "O";
      if (await accept(candidate)) return true;
    }
    return false;
  };
  while (checks < maxChecks && await shrinkOnce()) {
    // Each accepted change restarts the scan on the smaller board.
  }
  return current;
}

export interface FuzzFailure {
  readonly kind: FuzzFailureKind;
  readonly board: FuzzBoard;
  readonly oracleMoves: number | null;
  readonly run: FuzzRun;
  readonly minimizedRows?: readonly string[];
}

function describeRun(run: FuzzRun): string {
  const parts = [`status=${run.status}`];
  if (run.reason !== undefined) parts.push(`reason=${run.reason}`);
  if (run.moves !== undefined) parts.push(`moves=${run.moves}`, `pushes=${run.pushes}`);
  if (run.optimality !== undefined) parts.push(`optimality=${run.optimality}`);
  if (run.proofKind !== undefined) parts.push(`proof=${run.proofKind}`);
  if (run.lowerBound !== undefined) parts.push(`lb=${run.lowerBound}`);
  if (run.upperBound !== undefined) parts.push(`ub=${run.upperBound}`);
  parts.push(`expanded=${run.expandedStates}`);
  if (run.detail !== undefined) parts.push(`detail=${JSON.stringify(run.detail)}`);
  if (run.replayError !== undefined) parts.push(`replay=${JSON.stringify(run.replayError)}`);
  if (run.error !== undefined) parts.push(`error=${JSON.stringify(run.error)}`);
  return parts.join(" ");
}

export function formatFuzzFailure(failure: FuzzFailure): string {
  const { board, run } = failure;
  const lines = [
    `fuzz failure ${failure.kind}`,
    `  seed=${board.seed} layout=${board.layout} placement=${board.placement} ` +
      `labels=${board.labelMode} boxes=${board.boxCount}`,
    `  engine=${run.engine} variant=${run.variant} features=${JSON.stringify(run.features)}`,
    `  oracle=${failure.oracleMoves ?? "unsolvable"} ${describeRun(run)}`,
    `  rows=${JSON.stringify(board.rows)}`,
    ...board.rows.map((row) => `    ${row}`),
  ];
  if (failure.minimizedRows) {
    lines.push(`  minimized=${JSON.stringify(failure.minimizedRows)}`);
    lines.push(...failure.minimizedRows.map((row) => `    ${row}`));
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------

export interface FuzzRunPlan {
  readonly engine: FuzzEngine;
  readonly variant: FuzzVariant;
}

/** Every variant on every engine. */
export function crossFuzzRunPlans(
  engines: readonly FuzzEngine[],
  variants: readonly FuzzVariant[],
): FuzzRunPlan[] {
  return variants.flatMap((fuzzVariant) => engines.map((engine) => ({ engine, variant: fuzzVariant })));
}

export interface FuzzCampaignOptions {
  readonly firstSeed: number;
  /** Stop after this many boards reach the engines. */
  readonly boards: number;
  /** Give up after this many seeds (default: 50 per requested board). */
  readonly maxSeeds?: number;
  /** A `performance.now()` value; no new board starts after it. */
  readonly deadline?: number;
  /** The engine runs for the board at this index (0-based, capped boards excluded). */
  readonly plansForBoard: (boardIndex: number) => readonly FuzzRunPlan[];
  readonly limits: SolverLimits;
  /** Boards whose oracle search exceeds this many states are skipped. */
  readonly oracleMaxStates: number;
  /** Cross-check the fuzz oracle against `exactRemainingMoves` below this size. */
  readonly crossCheckMaxStates: number;
  readonly crossCheckLimit: number;
  readonly minimizeFailures?: boolean;
  readonly onFailure?: (failure: FuzzFailure) => void;
}

export interface FuzzCampaignReport {
  seedsTried: number;
  rejected: number;
  capped: number;
  boards: number;
  solvable: number;
  unsolvable: number;
  /** Reverse-pull boards the oracle calls unsolvable; a generator bug. */
  reversePullUnsolvable: number;
  runs: number;
  runsByEngine: Record<FuzzEngine, number>;
  runsByVariant: Record<string, number>;
  provenOptimal: number;
  provenUnsolvable: number;
  /** Runs that stopped at a limit, with or without an incumbent. */
  limitResults: number;
  crossChecks: number;
  crossCheckMismatches: string[];
  byLayout: Record<FuzzLayout, number>;
  byPlacement: Record<FuzzPlacement, number>;
  byLabelMode: Record<FuzzLabelMode, number>;
  /** Index = box count. */
  byBoxCount: number[];
  /** Summed engine counters per variant name, both engines together. */
  countersByVariant: Record<string, Record<string, number>>;
  failures: FuzzFailure[];
  elapsedMs: number;
}

function zeroCounts<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}

export async function runFuzzCampaign(options: FuzzCampaignOptions): Promise<FuzzCampaignReport> {
  const startedAt = performance.now();
  const report: FuzzCampaignReport = {
    seedsTried: 0,
    rejected: 0,
    capped: 0,
    boards: 0,
    solvable: 0,
    unsolvable: 0,
    reversePullUnsolvable: 0,
    runs: 0,
    runsByEngine: zeroCounts(FUZZ_ENGINES),
    runsByVariant: {},
    provenOptimal: 0,
    provenUnsolvable: 0,
    limitResults: 0,
    crossChecks: 0,
    crossCheckMismatches: [],
    byLayout: zeroCounts(FUZZ_LAYOUTS),
    byPlacement: zeroCounts(FUZZ_PLACEMENTS),
    byLabelMode: zeroCounts(FUZZ_LABEL_MODES),
    byBoxCount: [0, 0, 0, 0, 0],
    countersByVariant: {},
    failures: [],
    elapsedMs: 0,
  };
  const lastSeed = options.firstSeed + (options.maxSeeds ?? options.boards * 50);
  for (let seed = options.firstSeed; seed < lastSeed && report.boards < options.boards; seed += 1) {
    if (options.deadline !== undefined && performance.now() > options.deadline) break;
    report.seedsTried += 1;
    const board = generateFuzzBoard(seed);
    if (!board) {
      report.rejected += 1;
      continue;
    }
    const oracle = fuzzOracle(board.rows, options.oracleMaxStates);
    if (oracle.capped) {
      report.capped += 1;
      continue;
    }
    const boardIndex = report.boards;
    report.boards += 1;
    report.byLayout[board.layout] += 1;
    report.byPlacement[board.placement] += 1;
    report.byLabelMode[board.labelMode] += 1;
    report.byBoxCount[board.boxCount] += 1;
    if (oracle.moves === null) {
      report.unsolvable += 1;
      if (board.placement === "reverse-pull") report.reversePullUnsolvable += 1;
    } else {
      report.solvable += 1;
    }
    if (report.crossChecks < options.crossCheckLimit && oracle.states <= options.crossCheckMaxStates) {
      report.crossChecks += 1;
      const reference = referenceOracleMoves(board.rows);
      if (reference !== oracle.moves) {
        report.crossCheckMismatches.push(
          `seed ${seed}: fuzzOracle ${oracle.moves} vs exactRemainingMoves ${reference} ` +
            `rows=${JSON.stringify(board.rows)}`,
        );
      }
    }
    for (const { engine, variant: fuzzVariant } of options.plansForBoard(boardIndex)) {
      const run = await runFuzzEngine(engine, board.rows, fuzzVariant, options.limits);
      report.runs += 1;
      report.runsByEngine[engine] += 1;
      report.runsByVariant[fuzzVariant.name] = (report.runsByVariant[fuzzVariant.name] ?? 0) + 1;
      if (run.status === "solved" && run.proofKind === "optimal") report.provenOptimal += 1;
      if (run.proofKind === "unsolvable") report.provenUnsolvable += 1;
      if (run.reason === "limit-reached" || (run.status === "solved" && run.optimality !== "proven")) {
        report.limitResults += 1;
      }
      const counters = (report.countersByVariant[fuzzVariant.name] ??= {});
      for (const [name, value] of Object.entries(run.counters)) {
        counters[name] = (counters[name] ?? 0) + value;
      }
      const kind = classifyFuzzRun(run, oracle.moves);
      if (kind === null) continue;
      const minimizedRows = options.minimizeFailures
        ? await minimizeFuzzBoard(board.rows, async (candidate) => {
          const candidateOracle = fuzzOracle(candidate, options.oracleMaxStates);
          if (candidateOracle.capped) return false;
          const candidateRun = await runFuzzEngine(engine, candidate, fuzzVariant, options.limits);
          return classifyFuzzRun(candidateRun, candidateOracle.moves) === kind;
        })
        : undefined;
      const failure: FuzzFailure = { kind, board, oracleMoves: oracle.moves, run, minimizedRows };
      report.failures.push(failure);
      options.onFailure?.(failure);
    }
  }
  report.elapsedMs = performance.now() - startedAt;
  return report;
}

/** One-line campaign summary for logs. */
export function summarizeFuzzCampaign(report: FuzzCampaignReport): string {
  return [
    `boards=${report.boards} seeds=${report.seedsTried} rejected=${report.rejected} capped=${report.capped}`,
    `solvable=${report.solvable} unsolvable=${report.unsolvable} runs=${report.runs}`,
    `provenOptimal=${report.provenOptimal} provenUnsolvable=${report.provenUnsolvable} limits=${report.limitResults}`,
    `crossChecks=${report.crossChecks} failures=${report.failures.length} ms=${Math.round(report.elapsedMs)}`,
    `layouts=${JSON.stringify(report.byLayout)} placements=${JSON.stringify(report.byPlacement)}`,
    `labels=${JSON.stringify(report.byLabelMode)} boxCounts=${JSON.stringify(report.byBoxCount)}`,
  ].join(" ");
}
