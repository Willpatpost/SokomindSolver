import { createRng } from "../board-template.ts";
import { rasterizeBlueprint } from "./blueprint-graph.ts";
import type {
  FunctionalBlueprint,
  FunctionalRoom,
  GoalCell,
  GoalStyle,
  PassageEdge,
  SolvedBlueprint,
} from "./blueprint-types.ts";
import {
  collectRoomFloorCells,
  chooseRobotPosition,
  findDoorways,
  selectGoals,
  type RoomFloorCell,
} from "./goal-placement.ts";
import {
  placeGoalsWithMotif,
  type MotifType,
  type DependencyHint,
} from "./motifs.ts";
import {
  reverseBeamSearch,
  replayForwardSolution,
  type BeamSearchParams,
  DEFAULT_BEAM_PARAMS,
} from "./reverse-beam-search.ts";
import { toSolvedTemplate } from "./goal-placement.ts";
import { buildPuzzleFromScramble } from "../generate-puzzle.ts";
import { validatePuzzle } from "../../../core/puzzle.ts";
import { createSession } from "../../../core/game-session.ts";
import { classicGreedySolver } from "../../../solver/implementations/classic-solvers.ts";
import type { SolutionStep } from "../../../solver/contracts.ts";
import type { PuzzleDefinition } from "../../../core/model.ts";
import type { GridPosition } from "../generator-types.ts";
import { verifyDependenciesWithEvidence, collectPassageCells } from "./dependency-verification.ts";
import { witnessFromPullHistory } from "./generation-evidence.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DependencyEdgeType =
  | "must-precede"
  | "must-stage"
  | "shares-passage"
  | "blocks-access"
  | "must-reopen"
  | "must-park"
  | "chain-link"
  | "exchange-cross"
  | "assignment-cross"
  | "support-conflict"
  | "chain-merge";

export interface DependencyNode {
  readonly id: number;
  readonly goalId?: string;
  readonly goalIndex: number;
  readonly roomId: number;
  readonly role: string;
}

export interface DependencyEdge {
  readonly from: number;
  readonly to: number;
  readonly type: DependencyEdgeType;
  readonly description: string;
}

export interface DependencyDAG {
  readonly nodes: readonly DependencyNode[];
  readonly edges: readonly DependencyEdge[];
  readonly compositionId: string;
  readonly motifs: readonly MotifType[];
}

export type CompositionType =
  | "gate-pack"
  | "gate-staging"
  | "traffic-staging";

export const COMPOSITION_TYPES: readonly CompositionType[] = [
  "gate-pack",
  "gate-staging",
  "traffic-staging",
];

export interface CompositionParams {
  readonly seed: number;
  readonly boxCount: number;
  readonly composition: CompositionType | "auto";
  readonly beamParams?: BeamSearchParams;
  readonly maxRetries?: number;
}

export const DEFAULT_COMPOSITION_PARAMS: CompositionParams = {
  seed: 0,
  boxCount: 4,
  composition: "auto",
  maxRetries: 5,
};

export type VerificationConfidence = "observed" | "structural" | "counterfactual" | "proven";

export interface DependencyEvidence {
  readonly kind: string;
  readonly description: string;
}

export interface DependencyRealizationResult {
  readonly dag: DependencyDAG;
  readonly totalEdges: number;
  readonly realizedEdges: number;
  readonly realizationRate: number;
  readonly edgeDetails: readonly EdgeRealizationDetail[];
}

export interface EdgeRealizationDetail {
  readonly edge: DependencyEdge;
  readonly realized: boolean;
  readonly confidence: VerificationConfidence;
  readonly reason: string;
  readonly evidence: readonly DependencyEvidence[];
}

export interface ComposedPuzzleResult {
  readonly solutionSteps?: readonly SolutionStep[];
  readonly puzzle: PuzzleDefinition;
  readonly dag: DependencyDAG;
  readonly realization: DependencyRealizationResult;
  readonly solved: SolvedBlueprint;
  readonly goalStyle: GoalStyle;
  readonly retries: number;
}

// ---------------------------------------------------------------------------
// DAG validation
// ---------------------------------------------------------------------------

export function isAcyclic(dag: DependencyDAG): boolean {
  const adj = new Map<number, number[]>();
  for (const node of dag.nodes) adj.set(node.id, []);
  for (const edge of dag.edges) {
    adj.get(edge.from)?.push(edge.to);
  }

  const visited = new Set<number>();
  const inStack = new Set<number>();

  function dfs(n: number): boolean {
    if (inStack.has(n)) return false;
    if (visited.has(n)) return true;
    visited.add(n);
    inStack.add(n);
    for (const next of adj.get(n) ?? []) {
      if (!dfs(next)) return false;
    }
    inStack.delete(n);
    return true;
  }

  for (const node of dag.nodes) {
    if (!dfs(node.id)) return false;
  }
  return true;
}

export function topologicalOrder(dag: DependencyDAG): number[] | null {
  if (!isAcyclic(dag)) return null;

  const inDegree = new Map<number, number>();
  const adj = new Map<number, number[]>();
  for (const node of dag.nodes) {
    inDegree.set(node.id, 0);
    adj.set(node.id, []);
  }
  for (const edge of dag.edges) {
    adj.get(edge.from)?.push(edge.to);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  const queue: number[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const order: number[] = [];
  while (queue.length > 0) {
    queue.sort((a, b) => a - b);
    const n = queue.shift()!;
    order.push(n);
    for (const next of adj.get(n) ?? []) {
      const d = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }

  return order.length === dag.nodes.length ? order : null;
}

// ---------------------------------------------------------------------------
// Composition compatibility check
// ---------------------------------------------------------------------------

export function findCompatibleCompositions(
  blueprint: FunctionalBlueprint,
  boxCount: number,
): CompositionType[] {
  const narrowPassages = blueprint.passages.filter((p) => p.width === 1);
  const terminalRooms = blueprint.rooms.filter((r) => r.isTerminal);
  const compatible: CompositionType[] = [];

  const hasLargeRoom = blueprint.rooms.some(
    (r) => (r.width >= 2 && r.height >= 3) || (r.width >= 3 && r.height >= 2),
  );

  if (
    narrowPassages.length >= 1 &&
    terminalRooms.length >= 1 &&
    boxCount >= 3 &&
    blueprint.rooms.length >= 2
  ) {
    compatible.push("gate-pack");
  }

  if (
    narrowPassages.length >= 1 &&
    blueprint.rooms.length >= 2 &&
    hasLargeRoom &&
    boxCount >= 3
  ) {
    compatible.push("gate-staging");
  }

  if (
    narrowPassages.length >= 1 &&
    blueprint.rooms.length >= 2 &&
    hasLargeRoom &&
    boxCount >= 3
  ) {
    compatible.push("traffic-staging");
  }

  return compatible;
}

// ---------------------------------------------------------------------------
// Composition dispatch
// ---------------------------------------------------------------------------

interface CompositionResult {
  goals: GoalCell[];
  dag: DependencyDAG;
  goalStyle: GoalStyle;
}

export function composeMotifs(
  blueprint: FunctionalBlueprint,
  params: CompositionParams,
): CompositionResult | null {
  const rng = createRng(params.seed);
  const grid = rasterizeBlueprint(blueprint);

  const composition =
    params.composition === "auto"
      ? selectComposition(blueprint, params.boxCount, rng)
      : params.composition;

  if (!composition) return null;

  switch (composition) {
    case "gate-pack":
      return gatePackComposition(blueprint, grid, params.boxCount, rng);
    case "gate-staging":
      return gateStagingComposition(blueprint, grid, params.boxCount, rng);
    case "traffic-staging":
      return trafficStagingComposition(blueprint, grid, params.boxCount, rng);
  }
}

function selectComposition(
  blueprint: FunctionalBlueprint,
  boxCount: number,
  rng: () => number,
): CompositionType | null {
  const compatible = findCompatibleCompositions(blueprint, boxCount);
  if (compatible.length === 0) return null;

  const scores: { comp: CompositionType; score: number }[] = [];
  const narrowPassages = blueprint.passages.filter((p) => p.width === 1);
  const terminalRooms = blueprint.rooms.filter((r) => r.isTerminal);

  for (const comp of compatible) {
    let score = 1;
    switch (comp) {
      case "gate-pack":
        score += terminalRooms.length + narrowPassages.length;
        break;
      case "gate-staging":
        score += narrowPassages.length + (terminalRooms.length > 0 ? 1 : 0);
        break;
      case "traffic-staging":
        score += narrowPassages.length;
        break;
    }
    scores.push({ comp, score });
  }

  scores.sort((a, b) => b.score - a.score);
  const topScore = scores[0].score;
  const ties = scores.filter((s) => s.score === topScore);
  return ties[Math.floor(rng() * ties.length)].comp;
}

// ---------------------------------------------------------------------------
// 1. Gate-Pack composition
//
// Combines gatekeeper + packing-order:
// - 1 goal adjacent to a narrow passage (gatekeeper)
// - Remaining goals deep in the far room (packing-order)
// - DAG: gate blocks-access to all inner goals; inner goals
//   have must-precede edges from deepest to shallowest
// ---------------------------------------------------------------------------

function gatePackComposition(
  blueprint: FunctionalBlueprint,
  grid: readonly (readonly string[])[],
  boxCount: number,
  rng: () => number,
): CompositionResult | null {
  if (boxCount < 3) return null;

  const narrowPassages = blueprint.passages.filter((p) => p.width === 1);
  const roomMap = new Map<number, FunctionalRoom>();
  for (const room of blueprint.rooms) roomMap.set(room.id, room);

  const shuffled = [...narrowPassages];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  for (const passage of shuffled) {
    const roomFrom = roomMap.get(passage.from);
    const roomTo = roomMap.get(passage.to);
    if (!roomFrom || !roomTo) continue;

    const nearRoom =
      roomFrom.distanceFromCenter <= roomTo.distanceFromCenter
        ? roomFrom
        : roomTo;
    const farRoom = nearRoom === roomFrom ? roomTo : roomFrom;

    const nearCells = collectRoomFloorCells(nearRoom, grid, blueprint);
    const farCells = collectRoomFloorCells(farRoom, grid, blueprint);

    const gateCandidates = findGateAdjacentCells(nearCells, passage);
    if (gateCandidates.length === 0) continue;

    const innerViable = farCells.filter((c) => c.reversePullDirs >= 1);
    if (innerViable.length < boxCount - 1) continue;

    const gateCell = gateCandidates[0];
    const gateGoal: GoalCell = {
      goalId: `r${nearRoom.id}-gate`,
      row: gateCell.row,
      column: gateCell.column,
      roomId: nearRoom.id,
      depthFromDoorway: gateCell.depthFromDoorway,
      reversePullDirs: gateCell.reversePullDirs,
    };

    innerViable.sort((a, b) => {
      if (b.depthFromDoorway !== a.depthFromDoorway)
        return b.depthFromDoorway - a.depthFromDoorway;
      if (a.wallAdjacent !== b.wallAdjacent) return a.wallAdjacent ? -1 : 1;
      return a.reversePullDirs - b.reversePullDirs;
    });

    const innerGoals = selectGoals(innerViable, boxCount - 1, farRoom.id, grid);
    if (innerGoals.length < boxCount - 1) continue;

    const depths = innerGoals.map((g) => g.depthFromDoorway);
    const maxDepth = Math.max(...depths);
    const minDepth = Math.min(...depths);
    if (maxDepth - minDepth < 1 && boxCount > 3) continue;

    const goals: GoalCell[] = [gateGoal, ...innerGoals];

    const nodes: DependencyNode[] = goals.map((g, i) => ({
      id: i,
      goalId: g.goalId ?? `r${g.roomId}-g${i}`,
      goalIndex: i,
      roomId: g.roomId,
      role: i === 0 ? "gatekeeper" : "inner-pack",
    }));

    const edges: DependencyEdge[] = [];

    for (let i = 1; i < goals.length; i++) {
      edges.push({
        from: 0,
        to: i,
        type: "blocks-access",
        description:
          `Gate goal[0] at (${gateGoal.row},${gateGoal.column}) blocks passage ` +
          `to inner goal[${i}] at (${goals[i].row},${goals[i].column})`,
      });
    }

    const sortedInner = innerGoals
      .map((g, i) => ({ g, nodeId: i + 1 }))
      .sort((a, b) => b.g.depthFromDoorway - a.g.depthFromDoorway);

    for (let i = 0; i < sortedInner.length - 1; i++) {
      edges.push({
        from: sortedInner[i].nodeId,
        to: sortedInner[i + 1].nodeId,
        type: "must-precede",
        description:
          `Inner goal[${sortedInner[i].nodeId}] depth=${sortedInner[i].g.depthFromDoorway} ` +
          `must be filled before goal[${sortedInner[i + 1].nodeId}] ` +
          `depth=${sortedInner[i + 1].g.depthFromDoorway}`,
      });
    }

    const dag: DependencyDAG = {
      nodes,
      edges,
      compositionId: "gate-pack",
      motifs: ["gatekeeper", "packing-order"],
    };

    return { goals, dag, goalStyle: "mixed" };
  }

  return null;
}

// ---------------------------------------------------------------------------
// 2. Gate-Staging composition
//
// Combines gatekeeper + staging-dep:
// - 1 goal adjacent to a narrow passage (gatekeeper)
// - 2+ goals in the far room arranged so one blocks access to another
// - DAG: gate blocks-access to inner goals; deep inner goal must-stage
//   through blocker position
// ---------------------------------------------------------------------------

function gateStagingComposition(
  blueprint: FunctionalBlueprint,
  grid: readonly (readonly string[])[],
  boxCount: number,
  rng: () => number,
): CompositionResult | null {
  if (boxCount < 3) return null;

  const narrowPassages = blueprint.passages.filter((p) => p.width === 1);
  const roomMap = new Map<number, FunctionalRoom>();
  for (const room of blueprint.rooms) roomMap.set(room.id, room);

  const shuffled = [...narrowPassages];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  for (const passage of shuffled) {
    const roomFrom = roomMap.get(passage.from);
    const roomTo = roomMap.get(passage.to);
    if (!roomFrom || !roomTo) continue;

    const nearRoom =
      roomFrom.distanceFromCenter <= roomTo.distanceFromCenter
        ? roomFrom
        : roomTo;
    const farRoom = nearRoom === roomFrom ? roomTo : roomFrom;

    const nearCells = collectRoomFloorCells(nearRoom, grid, blueprint);
    const farCells = collectRoomFloorCells(farRoom, grid, blueprint);

    const gateCandidates = findGateAdjacentCells(nearCells, passage);
    if (gateCandidates.length === 0) continue;

    const innerViable = farCells.filter((c) => c.reversePullDirs >= 1);
    if (innerViable.length < boxCount - 1) continue;

    innerViable.sort((a, b) => b.depthFromDoorway - a.depthFromDoorway);

    const deepGoal = innerViable[0];
    if (deepGoal.depthFromDoorway < 2) continue;

    const doorways = findDoorways(farRoom, blueprint);
    const blockingCandidates = innerViable.filter((c) => {
      if (c.row === deepGoal.row && c.column === deepGoal.column) return false;
      return isOnStagingPath(c, deepGoal, doorways);
    });

    if (blockingCandidates.length === 0) continue;
    const blockerGoal = blockingCandidates[0];

    const gateCell = gateCandidates[0];
    const gateGoal: GoalCell = {
      goalId: `r${nearRoom.id}-gate`,
      row: gateCell.row,
      column: gateCell.column,
      roomId: nearRoom.id,
      depthFromDoorway: gateCell.depthFromDoorway,
      reversePullDirs: gateCell.reversePullDirs,
    };

    const goals: GoalCell[] = [
      gateGoal,
      {
        goalId: `r${farRoom.id}-deep`,
        row: deepGoal.row,
        column: deepGoal.column,
        roomId: farRoom.id,
        depthFromDoorway: deepGoal.depthFromDoorway,
        reversePullDirs: deepGoal.reversePullDirs,
      },
      {
        goalId: `r${farRoom.id}-blocker`,
        row: blockerGoal.row,
        column: blockerGoal.column,
        roomId: farRoom.id,
        depthFromDoorway: blockerGoal.depthFromDoorway,
        reversePullDirs: blockerGoal.reversePullDirs,
      },
    ];

    if (boxCount > 3) {
      const usedKeys = new Set(goals.map((g) => `${g.row},${g.column}`));
      const remaining = innerViable.filter(
        (c) => !usedKeys.has(`${c.row},${c.column}`),
      );
      const extra = selectGoals(remaining, boxCount - 3, farRoom.id, grid);
      for (const g of extra) {
        if (goals.length >= boxCount) break;
        if (!usedKeys.has(`${g.row},${g.column}`)) {
          usedKeys.add(`${g.row},${g.column}`);
          goals.push(g);
        }
      }
    }

    if (goals.length < boxCount) continue;

    const nodes: DependencyNode[] = goals.map((g, i) => ({
      id: i,
      goalId: g.goalId ?? `r${g.roomId}-g${i}`,
      goalIndex: i,
      roomId: g.roomId,
      role: i === 0 ? "gatekeeper" : i === 1 ? "staging-deep" : i === 2 ? "staging-blocker" : "extra",
    }));

    const edges: DependencyEdge[] = [];

    for (let i = 1; i < goals.length; i++) {
      edges.push({
        from: 0,
        to: i,
        type: "blocks-access",
        description:
          `Gate goal[0] blocks passage to inner goal[${i}]`,
      });
    }

    edges.push({
      from: 1,
      to: 2,
      type: "must-stage",
      description:
        `Deep goal[1] at (${deepGoal.row},${deepGoal.column}) requires staging ` +
        `through blocker goal[2] at (${blockerGoal.row},${blockerGoal.column})`,
    });

    const dag: DependencyDAG = {
      nodes,
      edges,
      compositionId: "gate-staging",
      motifs: ["gatekeeper", "staging-dep"],
    };

    return { goals, dag, goalStyle: "mixed" };
  }

  return null;
}

// ---------------------------------------------------------------------------
// 3. Traffic-Staging composition
//
// Combines doorway-traffic + staging-dep:
// - Goals split across a narrow passage (traffic)
// - In one room, a staging dependency exists between two goals
// - DAG: shares-passage between cross-room goals; must-stage
//   within the staging room
// ---------------------------------------------------------------------------

function trafficStagingComposition(
  blueprint: FunctionalBlueprint,
  grid: readonly (readonly string[])[],
  boxCount: number,
  rng: () => number,
): CompositionResult | null {
  if (boxCount < 3) return null;

  const narrowPassages = blueprint.passages.filter((p) => p.width === 1);
  const roomMap = new Map<number, FunctionalRoom>();
  for (const room of blueprint.rooms) roomMap.set(room.id, room);

  const shuffled = [...narrowPassages];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  for (const passage of shuffled) {
    const roomA = roomMap.get(passage.from);
    const roomB = roomMap.get(passage.to);
    if (!roomA || !roomB) continue;

    const cellsA = collectRoomFloorCells(roomA, grid, blueprint);
    const cellsB = collectRoomFloorCells(roomB, grid, blueprint);
    const viableA = cellsA.filter((c) => c.reversePullDirs >= 1);
    const viableB = cellsB.filter((c) => c.reversePullDirs >= 1);

    const stagingRoom = pickStagingRoom(roomA, roomB, viableA, viableB);
    if (!stagingRoom) continue;

    const isARoomStaging = stagingRoom.id === roomA.id;
    const stagingCells = isARoomStaging ? viableA : viableB;
    const trafficCells = isARoomStaging ? viableB : viableA;
    const trafficRoom = isARoomStaging ? roomB : roomA;

    stagingCells.sort((a, b) => b.depthFromDoorway - a.depthFromDoorway);

    const deepGoal = stagingCells[0];
    if (!deepGoal || deepGoal.depthFromDoorway < 2) continue;

    const doorways = findDoorways(stagingRoom, blueprint);
    const blockingCandidates = stagingCells.filter((c) => {
      if (c.row === deepGoal.row && c.column === deepGoal.column) return false;
      return isOnStagingPath(c, deepGoal, doorways);
    });

    if (blockingCandidates.length === 0) continue;
    const blockerGoal = blockingCandidates[0];

    const stagingGoalCount = Math.min(
      Math.max(2, Math.ceil(boxCount / 2)),
      stagingCells.length,
    );
    const trafficGoalCount = boxCount - stagingGoalCount;

    if (trafficCells.length < trafficGoalCount) continue;

    const goals: GoalCell[] = [
      {
        goalId: `r${stagingRoom.id}-deep`,
        row: deepGoal.row,
        column: deepGoal.column,
        roomId: stagingRoom.id,
        depthFromDoorway: deepGoal.depthFromDoorway,
        reversePullDirs: deepGoal.reversePullDirs,
      },
      {
        goalId: `r${stagingRoom.id}-blocker`,
        row: blockerGoal.row,
        column: blockerGoal.column,
        roomId: stagingRoom.id,
        depthFromDoorway: blockerGoal.depthFromDoorway,
        reversePullDirs: blockerGoal.reversePullDirs,
      },
    ];

    if (stagingGoalCount > 2) {
      const usedKeys = new Set(goals.map((g) => `${g.row},${g.column}`));
      const remaining = stagingCells.filter(
        (c) => !usedKeys.has(`${c.row},${c.column}`),
      );
      const extra = selectGoals(
        remaining,
        stagingGoalCount - 2,
        stagingRoom.id,
        grid,
      );
      for (const g of extra) {
        if (goals.length >= stagingGoalCount) break;
        goals.push(g);
      }
    }

    if (goals.length < stagingGoalCount) continue;

    trafficCells.sort((a, b) => b.depthFromDoorway - a.depthFromDoorway);
    const trafficGoals = selectGoals(
      trafficCells,
      trafficGoalCount,
      trafficRoom.id,
      grid,
    );
    if (trafficGoals.length < trafficGoalCount) continue;
    goals.push(...trafficGoals);

    if (goals.length < boxCount) continue;

    const nodes: DependencyNode[] = goals.map((g, i) => ({
      id: i,
      goalId: g.goalId ?? `r${g.roomId}-g${i}`,
      goalIndex: i,
      roomId: g.roomId,
      role:
        i === 0
          ? "staging-deep"
          : i === 1
            ? "staging-blocker"
            : g.roomId === stagingRoom.id
              ? "staging-extra"
              : "traffic",
    }));

    const edges: DependencyEdge[] = [];

    edges.push({
      from: 0,
      to: 1,
      type: "must-stage",
      description:
        `Deep goal[0] at (${deepGoal.row},${deepGoal.column}) requires staging ` +
        `through blocker goal[1] at (${blockerGoal.row},${blockerGoal.column})`,
    });

    const stagingIndices = goals
      .map((g, i) => ({ g, i }))
      .filter((x) => x.g.roomId === stagingRoom.id)
      .map((x) => x.i);
    const trafficIndices = goals
      .map((g, i) => ({ g, i }))
      .filter((x) => x.g.roomId === trafficRoom.id)
      .map((x) => x.i);

    for (const si of stagingIndices) {
      for (const ti of trafficIndices) {
        edges.push({
          from: si,
          to: ti,
          type: "shares-passage",
          description:
            `Goal[${si}] in staging room ${stagingRoom.id} and ` +
            `goal[${ti}] in traffic room ${trafficRoom.id} share ` +
            `width-1 passage — transit sequencing required`,
        });
      }
    }

    const dag: DependencyDAG = {
      nodes,
      edges,
      compositionId: "traffic-staging",
      motifs: ["doorway-traffic", "staging-dep"],
    };

    return { goals, dag, goalStyle: "multi-room" };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helpers for compositions
// ---------------------------------------------------------------------------

function findGateAdjacentCells(
  roomCells: RoomFloorCell[],
  passage: PassageEdge,
): RoomFloorCell[] {
  const adjacent = roomCells.filter((cell) => {
    if (cell.reversePullDirs < 1) return false;
    for (const pc of passage.cells) {
      const dist =
        Math.abs(cell.row - pc.row) + Math.abs(cell.column - pc.column);
      if (dist === 1) return true;
    }
    return false;
  });
  adjacent.sort((a, b) => a.floorNeighbors - b.floorNeighbors);
  return adjacent;
}

function isOnStagingPath(
  candidate: RoomFloorCell,
  target: RoomFloorCell,
  doorways: readonly GridPosition[],
): boolean {
  for (const door of doorways) {
    const doorToTarget =
      Math.abs(door.row - target.row) + Math.abs(door.column - target.column);
    const doorToCandidate =
      Math.abs(door.row - candidate.row) +
      Math.abs(door.column - candidate.column);
    const candidateToTarget =
      Math.abs(candidate.row - target.row) +
      Math.abs(candidate.column - target.column);

    if (
      doorToCandidate < doorToTarget &&
      candidateToTarget < doorToTarget
    ) {
      if (
        candidate.row === target.row ||
        candidate.column === target.column
      ) {
        return true;
      }
      if (doorToCandidate + candidateToTarget <= doorToTarget + 1) {
        return true;
      }
    }
  }
  return false;
}

function pickStagingRoom(
  roomA: FunctionalRoom,
  roomB: FunctionalRoom,
  viableA: RoomFloorCell[],
  viableB: RoomFloorCell[],
): FunctionalRoom | null {
  const aDepth = viableA.reduce(
    (max, c) => Math.max(max, c.depthFromDoorway),
    0,
  );
  const bDepth = viableB.reduce(
    (max, c) => Math.max(max, c.depthFromDoorway),
    0,
  );

  if (aDepth >= 2 && viableA.length >= 2) {
    if (bDepth >= 2 && viableB.length >= 2) {
      return aDepth >= bDepth ? roomA : roomB;
    }
    return roomA;
  }
  if (bDepth >= 2 && viableB.length >= 2) return roomB;
  return null;
}

// ---------------------------------------------------------------------------
// Dependency verification via solution analysis (delegated to dependency-verification.ts)
// ---------------------------------------------------------------------------

export function verifyDependencies(
  dag: DependencyDAG,
  puzzle: PuzzleDefinition,
  steps: readonly SolutionStep[],
  passageCells?: ReadonlySet<string>,
): DependencyRealizationResult {
  const result = verifyDependenciesWithEvidence(dag, puzzle, steps, passageCells);
  const edgeMap = new Map(dag.edges.map((e) => [`${e.from}-${e.to}-${e.type}`, e]));
  return {
    dag,
    totalEdges: result.totalEdges,
    realizedEdges: result.realizedEdges,
    realizationRate: result.realizationRate,
    edgeDetails: result.edgeDetails.map((d) => ({
      edge: edgeMap.get(`${d.edge.from}-${d.edge.to}-${d.edge.type}`) ?? dag.edges[0],
      realized: d.realized,
      confidence: d.confidence,
      reason: d.reason,
      evidence: d.evidence,
    })),
  };
}

// ---------------------------------------------------------------------------
// Full pipeline: compose → place → beam search → solve → verify
// ---------------------------------------------------------------------------

export async function generateComposedPuzzle(
  blueprint: FunctionalBlueprint,
  params: CompositionParams,
  onSolverCall?: () => void,
): Promise<ComposedPuzzleResult | null> {
  const maxRetries = params.maxRetries ?? 5;
  const beamParams = params.beamParams ?? {
    ...DEFAULT_BEAM_PARAMS,
    seed: params.seed,
    maxDepth: 30,
  };

  for (let retry = 0; retry < maxRetries; retry++) {
    const adjustedSeed = params.seed + retry * 7919;
    const compositionResult = composeMotifs(blueprint, {
      ...params,
      seed: adjustedSeed,
    });
    if (!compositionResult) continue;

    const { goals, dag, goalStyle } = compositionResult;

    if (!isAcyclic(dag)) continue;

    const rng = createRng(adjustedSeed + 1);
    const grid = rasterizeBlueprint(blueprint);
    const robotPos = chooseRobotPosition(blueprint, grid, goals, rng);
    if (!robotPos) continue;

    const solved: SolvedBlueprint = {
      blueprint,
      grid,
      goals,
      robotPosition: robotPos,
      goalStyle,
    };

    const template = toSolvedTemplate(solved);
    const beam = reverseBeamSearch(solved, {
      ...beamParams,
      seed: adjustedSeed,
    });
    if (beam.best.depth === 0) continue;

    if (!replayForwardSolution(template, beam.best)) continue;

    const scrambled = {
      template,
      boxPositions: beam.best.boxPositions as Array<{
        row: number;
        column: number;
      }>,
      robotPosition: beam.best.robotPosition,
      reversePulls: beam.best.depth,
    };

    const puzzle = buildPuzzleFromScramble(scrambled, "intermediate");
    const validation = validatePuzzle(puzzle);
    if (!validation.valid) continue;

    onSolverCall?.();
    const solveResult = await solvePuzzleForVerification(puzzle);
    if (!solveResult) continue;

    const pCells = collectPassageCells(blueprint.passages);
    const realization = verifyDependencies(dag, puzzle, solveResult.steps, pCells);

    if (realization.realizationRate < 0.5 && retry < maxRetries - 1) {
      continue;
    }

    return {
      puzzle: {
        ...puzzle,
        id: `composed-${dag.compositionId}-${params.seed}`,
      },
      dag,
      realization,
      solved,
      goalStyle,
      retries: retry,
      solutionSteps: solveResult.steps,
    };
  }

  return null;
}

async function solvePuzzleForVerification(
  puzzle: PuzzleDefinition,
): Promise<{ steps: SolutionStep[] } | null> {
  const session = createSession(puzzle);
  const request = {
    board: session.board,
    snapshot: session.snapshot,
    objective: { kind: "moves" as const },
    limits: { maxElapsedMs: 15_000, maxExpandedStates: 2_000_000 },
  };
  const context = {
    signal: new AbortController().signal,
    reportProgress: () => {},
    now: () => performance.now(),
  };

  const result = await classicGreedySolver.solve(request, context);
  if (result.status !== "solved") return null;
  return { steps: result.solution.steps as SolutionStep[] };
}

// ---------------------------------------------------------------------------
// Convenience: single-motif with dependency verification
// ---------------------------------------------------------------------------

export async function generateVerifiedMotifPuzzle(
  blueprint: FunctionalBlueprint,
  params: {
    seed: number;
    boxCount: number;
    motif: MotifType | "auto";
    beamParams?: BeamSearchParams;
  },
): Promise<{
  puzzle: PuzzleDefinition;
  witness?: readonly SolutionStep[];
  hints: readonly DependencyHint[];
  motif: MotifType;
} | null> {
  const result = placeGoalsWithMotif(blueprint, {
    seed: params.seed,
    boxCount: params.boxCount,
    motif: params.motif,
  });
  if (!result) return null;

  const beamParams = params.beamParams ?? {
    ...DEFAULT_BEAM_PARAMS,
    seed: params.seed,
    maxDepth: 25,
  };

  const template = toSolvedTemplate(result.solved);
  const beam = reverseBeamSearch(result.solved, beamParams);
  if (beam.best.depth === 0) return null;

  const scrambled = {
    template,
    boxPositions: beam.best.boxPositions as Array<{
      row: number;
      column: number;
    }>,
    robotPosition: beam.best.robotPosition,
    reversePulls: beam.best.depth,
  };

  const puzzle = buildPuzzleFromScramble(scrambled, "intermediate");
  const validation = validatePuzzle(puzzle);
  if (!validation.valid) return null;

  return {
    puzzle: { ...puzzle, id: `motif-${result.motif}-${params.seed}` },
    hints: result.hints,
    motif: result.motif,
    witness: witnessFromPullHistory(puzzle, beam.best.pullHistory),
  };
}
