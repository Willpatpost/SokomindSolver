import {
  type Direction,
  type GameSnapshot,
  type Position,
  stepSnapshot,
  directionDelta,
  translate,
} from "../../core/index.ts";
import type { SolutionStep, SolverRequest, SolverSolution } from "../contracts.ts";
import { verifySolverSolution } from "../verification.ts";
import { scoreSolverObjective } from "../validation.ts";
import {
  compileSearchBoard,
  type CompiledSearchBoard,
} from "./compiled-board.ts";
import { KeeperReachability } from "./reachability.ts";
import {
  analyzeBoxEpisodes,
  type PushEvent,
} from "./analyzer-diagnostics.ts";
import type { DenseBox } from "./model.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PushInfo {
  readonly direction: Direction;
  readonly boxId: string;
  readonly boxLabel: string;
  readonly boxFrom: Position;
  readonly boxTo: Position;
  readonly supportPosition: Position;
  readonly originalStepIndex: number;
}

export interface PushBlock {
  readonly blockIndex: number;
  readonly boxId: string;
  readonly boxLabel: string;
  readonly pushes: readonly PushInfo[];
  readonly walkStepsBefore: number;
  readonly snapshotBefore: GameSnapshot;
  readonly snapshotAfter: GameSnapshot;
}

export interface PushBlockSequence {
  readonly blocks: readonly PushBlock[];
  readonly request: SolverRequest;
  readonly originalSolution: SolverSolution;
  readonly trailingWalkSteps: number;
}

export interface OptimizationReport {
  readonly originalMoves: number;
  readonly originalPushes: number;
  readonly optimizedMoves: number;
  readonly optimizedPushes: number;
  readonly routingOnlyMoves: number;
  readonly routingOnlyPushes: number;
  readonly blockCount: number;
  readonly successfulSwaps: number;
  readonly attemptedSwaps: number;
  readonly rejectedSwaps: number;
  readonly totalEpisodesBefore: number;
  readonly totalEpisodesAfter: number;
  readonly maxEpisodesPerBoxBefore: number;
  readonly maxEpisodesPerBoxAfter: number;
  readonly elapsedMs: number;
  readonly optimizedSolution: SolverSolution | null;
  readonly routingOnlySolution: SolverSolution | null;
}

export interface OptimizationOptions {
  readonly maxPasses?: number;
  readonly maxSwapAttempts?: number;
  readonly maxElapsedMs?: number;
}

// ---------------------------------------------------------------------------
// Opposite direction (for computing support cell)
// ---------------------------------------------------------------------------

const OPPOSITE_DIRECTION: Readonly<Record<Direction, Direction>> = {
  up: "down",
  down: "up",
  left: "right",
  right: "left",
};

function supportPosition(boxPosition: Position, pushDirection: Direction): Position {
  const delta = directionDelta(OPPOSITE_DIRECTION[pushDirection]);
  return translate(boxPosition, delta);
}

// ---------------------------------------------------------------------------
// extractPushBlocks
// ---------------------------------------------------------------------------

export function extractPushBlocks(
  request: SolverRequest,
  solution: SolverSolution,
): PushBlockSequence {
  const blocks: PushBlock[] = [];
  let snapshot = request.snapshot;
  let currentPushes: PushInfo[] = [];
  let currentBoxId: string | null = null;
  let currentBoxLabel = "";
  let walkStepsBefore = 0;
  let blockSnapshotBefore = snapshot;

  for (let stepIndex = 0; stepIndex < solution.steps.length; stepIndex++) {
    const step = solution.steps[stepIndex];
    const transition = stepSnapshot(request.board, snapshot, step.direction);

    if (step.kind === "push" && transition.pushed) {
      const pushedBoxId = transition.pushedBoxId!;
      const pushedBox = snapshot.boxes.find(
        (b) => b.id === pushedBoxId,
      )!;

      if (currentBoxId !== null && currentBoxId !== pushedBoxId) {
        blocks.push(Object.freeze({
          blockIndex: blocks.length,
          boxId: currentBoxId,
          boxLabel: currentBoxLabel,
          pushes: Object.freeze(currentPushes),
          walkStepsBefore,
          snapshotBefore: blockSnapshotBefore,
          snapshotAfter: snapshot,
        }));
        currentPushes = [];
        walkStepsBefore = 0;
        blockSnapshotBefore = snapshot;
      }

      if (currentPushes.length === 0) {
        currentBoxId = pushedBoxId;
        currentBoxLabel = pushedBox.label;
      }

      currentPushes.push(Object.freeze({
        direction: step.direction,
        boxId: pushedBoxId,
        boxLabel: pushedBox.label,
        boxFrom: pushedBox.position,
        boxTo: translate(pushedBox.position, directionDelta(step.direction)),
        supportPosition: supportPosition(pushedBox.position, step.direction),
        originalStepIndex: stepIndex,
      }));
    } else {
      if (currentPushes.length > 0) {
        blocks.push(Object.freeze({
          blockIndex: blocks.length,
          boxId: currentBoxId!,
          boxLabel: currentBoxLabel,
          pushes: Object.freeze(currentPushes),
          walkStepsBefore,
          snapshotBefore: blockSnapshotBefore,
          snapshotAfter: snapshot,
        }));
        currentPushes = [];
        currentBoxId = null;
        walkStepsBefore = 0;
        blockSnapshotBefore = snapshot;
      }
      walkStepsBefore++;
    }

    snapshot = transition.snapshot;
  }

  let trailingWalkSteps = 0;
  if (currentPushes.length > 0) {
    blocks.push(Object.freeze({
      blockIndex: blocks.length,
      boxId: currentBoxId!,
      boxLabel: currentBoxLabel,
      pushes: Object.freeze(currentPushes),
      walkStepsBefore,
      snapshotBefore: blockSnapshotBefore,
      snapshotAfter: snapshot,
    }));
  } else {
    trailingWalkSteps = walkStepsBefore;
  }

  return Object.freeze({
    blocks: Object.freeze(blocks),
    request,
    originalSolution: solution,
    trailingWalkSteps,
  });
}

// ---------------------------------------------------------------------------
// Occupancy and path reconstruction
// ---------------------------------------------------------------------------

function buildOccupancy(
  board: CompiledSearchBoard,
  boxes: readonly { readonly position: Position }[],
): Uint8Array {
  const occ = new Uint8Array(board.cellCount);
  for (const box of boxes) {
    const cell = board.cellAt(box.position.row, box.position.column);
    if (cell >= 0) occ[cell] = 1;
  }
  return occ;
}

export function reconstructSolution(
  request: SolverRequest,
  board: CompiledSearchBoard,
  blocks: readonly PushBlock[],
  blockOrder: readonly number[],
): SolverSolution | null {
  const reach = new KeeperReachability(board);
  const steps: SolutionStep[] = [];
  let snapshot = request.snapshot;
  let pushes = 0;

  for (const blockIdx of blockOrder) {
    const block = blocks[blockIdx];
    for (const push of block.pushes) {
      const occupancy = buildOccupancy(board, snapshot.boxes);
      const keeperCell = board.cellAt(snapshot.robot.row, snapshot.robot.column);
      const supportCell = board.cellAt(
        push.supportPosition.row,
        push.supportPosition.column,
      );

      if (keeperCell < 0 || supportCell < 0) return null;

      if (keeperCell !== supportCell) {
        const reachResult = reach.flood(keeperCell, occupancy);
        const walkPath = reachResult.pathTo(supportCell);
        if (!walkPath) return null;

        for (const walkDir of walkPath) {
          const transition = stepSnapshot(request.board, snapshot, walkDir);
          if (!transition.moved || transition.pushed) return null;
          steps.push(Object.freeze({ direction: walkDir, kind: "walk" as const }));
          snapshot = transition.snapshot;
        }
      }

      const transition = stepSnapshot(request.board, snapshot, push.direction);
      if (!transition.moved || !transition.pushed) return null;
      steps.push(Object.freeze({ direction: push.direction, kind: "push" as const }));
      snapshot = transition.snapshot;
      pushes++;
    }
  }

  if (!snapshot.solved) return null;

  const candidate: SolverSolution = Object.freeze({
    steps: Object.freeze(steps),
    moves: steps.length,
    pushes,
    objective: request.objective,
    objectiveScore: scoreSolverObjective(request.objective, steps.length),
    optimality: "unknown" as const,
  });

  const verification = verifySolverSolution(request, candidate);
  if (!verification.valid) return null;

  return candidate;
}

// ---------------------------------------------------------------------------
// Adjacent swap
// ---------------------------------------------------------------------------

function swappedOrder(blockCount: number, swapIndex: number): number[] {
  const order: number[] = [];
  for (let i = 0; i < blockCount; i++) {
    if (i === swapIndex) {
      order.push(swapIndex + 1);
    } else if (i === swapIndex + 1) {
      order.push(swapIndex);
    } else {
      order.push(i);
    }
  }
  return order;
}

export function attemptAdjacentSwap(
  request: SolverRequest,
  board: CompiledSearchBoard,
  blocks: readonly PushBlock[],
  swapIndex: number,
): SolverSolution | null {
  if (swapIndex < 0 || swapIndex >= blocks.length - 1) return null;
  const order = swappedOrder(blocks.length, swapIndex);
  return reconstructSolution(request, board, blocks, order);
}

// ---------------------------------------------------------------------------
// Episode analysis bridge
// ---------------------------------------------------------------------------

function solutionToPushEvents(
  request: SolverRequest,
  solution: SolverSolution,
  board: CompiledSearchBoard,
): { events: PushEvent[]; denseBoxes: DenseBox[] } {
  const denseBoxes: DenseBox[] = request.snapshot.boxes.map((box) => ({
    id: box.id,
    label: box.label,
    cell: board.cellAt(box.position.row, box.position.column),
  }));

  const events: PushEvent[] = [];
  let snapshot = request.snapshot;
  const boxIndexById = new Map<string, number>();
  for (let i = 0; i < denseBoxes.length; i++) {
    boxIndexById.set(denseBoxes[i].id, i);
  }

  for (const step of solution.steps) {
    const transition = stepSnapshot(request.board, snapshot, step.direction);
    if (transition.pushed && transition.pushedBoxId) {
      const boxIdx = boxIndexById.get(transition.pushedBoxId) ?? 0;
      const pushedBox = snapshot.boxes.find(
        (b) => b.id === transition.pushedBoxId,
      )!;
      const fromCell = board.cellAt(pushedBox.position.row, pushedBox.position.column);
      const delta = directionDelta(step.direction);
      const toPos = translate(pushedBox.position, delta);
      const toCell = board.cellAt(toPos.row, toPos.column);
      const keeperCell = board.cellAt(snapshot.robot.row, snapshot.robot.column);
      events.push({ boxIndex: boxIdx, fromCell, toCell, keeperCell });
    }
    snapshot = transition.snapshot;
  }

  return { events, denseBoxes };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

const DEFAULT_MAX_PASSES = 5;
const DEFAULT_MAX_SWAP_ATTEMPTS = 200;
const DEFAULT_MAX_ELAPSED_MS = 30_000;

export function optimizePushBlockOrder(
  request: SolverRequest,
  solution: SolverSolution,
  options?: OptimizationOptions,
): OptimizationReport {
  const started = performance.now();
  const maxPasses = options?.maxPasses ?? DEFAULT_MAX_PASSES;
  const maxSwapAttempts = options?.maxSwapAttempts ?? DEFAULT_MAX_SWAP_ATTEMPTS;
  const maxElapsedMs = options?.maxElapsedMs ?? DEFAULT_MAX_ELAPSED_MS;

  const board = compileSearchBoard(request.board);

  const initialSequence = extractPushBlocks(request, solution);
  const originalOrder = initialSequence.blocks.map((_, i) => i);

  const routingOnlySolution = reconstructSolution(
    request,
    board,
    initialSequence.blocks,
    originalOrder,
  );

  let best = routingOnlySolution ?? solution;
  let currentBlocks = initialSequence.blocks;
  let successfulSwaps = 0;
  let attemptedSwaps = 0;
  let rejectedSwaps = 0;

  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false;

    for (let i = 0; i < currentBlocks.length - 1; i++) {
      if (attemptedSwaps >= maxSwapAttempts) break;
      if (performance.now() - started > maxElapsedMs) break;

      attemptedSwaps++;
      const candidate = attemptAdjacentSwap(request, board, currentBlocks, i);

      if (
        candidate &&
        candidate.moves < best.moves &&
        candidate.pushes <= best.pushes
      ) {
        best = candidate;
        successfulSwaps++;

        const newSequence = extractPushBlocks(request, best);
        currentBlocks = newSequence.blocks;
        improved = true;
        break;
      } else {
        rejectedSwaps++;
      }
    }

    if (!improved) break;
    if (attemptedSwaps >= maxSwapAttempts) break;
    if (performance.now() - started > maxElapsedMs) break;
  }

  const elapsedMs = performance.now() - started;

  const { events: beforeEvents, denseBoxes } = solutionToPushEvents(
    request,
    solution,
    board,
  );
  const beforeEpisodes = analyzeBoxEpisodes(board, denseBoxes, beforeEvents);

  let afterEpisodes = beforeEpisodes;
  if (best !== solution) {
    const { events: afterEvents, denseBoxes: afterBoxes } = solutionToPushEvents(
      request,
      best,
      board,
    );
    afterEpisodes = analyzeBoxEpisodes(board, afterBoxes, afterEvents);
  }

  return Object.freeze({
    originalMoves: solution.moves,
    originalPushes: solution.pushes,
    optimizedMoves: best.moves,
    optimizedPushes: best.pushes,
    routingOnlyMoves: routingOnlySolution?.moves ?? solution.moves,
    routingOnlyPushes: routingOnlySolution?.pushes ?? solution.pushes,
    blockCount: initialSequence.blocks.length,
    successfulSwaps,
    attemptedSwaps,
    rejectedSwaps,
    totalEpisodesBefore: beforeEpisodes.totalEpisodes,
    totalEpisodesAfter: afterEpisodes.totalEpisodes,
    maxEpisodesPerBoxBefore: beforeEpisodes.maxEpisodesForAnyBox,
    maxEpisodesPerBoxAfter: afterEpisodes.maxEpisodesForAnyBox,
    elapsedMs,
    optimizedSolution: best !== solution ? best : null,
    routingOnlySolution,
  });
}
