import type { SolutionStep } from "../../../solver/contracts.ts";
import type { PuzzleDefinition } from "../../../core/model.ts";
import { directionDelta } from "../../../core/position.ts";
import { floodKeeperReachable } from "./reachable-pushes.ts";
import type { PassageEdge } from "./blueprint-types.ts";

// ---------------------------------------------------------------------------
// Structural interfaces (avoid importing dependency-graph.ts to prevent cycle)
// ---------------------------------------------------------------------------

interface DepNode {
  readonly id: number;
  readonly goalIndex: number;
  readonly roomId: number;
  readonly role: string;
}

type DepEdgeType = "must-precede" | "must-stage" | "shares-passage" | "blocks-access";

interface DepEdge {
  readonly from: number;
  readonly to: number;
  readonly type: DepEdgeType;
  readonly description: string;
}

interface DepDAG {
  readonly nodes: readonly DepNode[];
  readonly edges: readonly DepEdge[];
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VerificationConfidence = "structural" | "observed" | "counterfactual";

export interface DependencyEvidence {
  readonly kind: string;
  readonly description: string;
}

export interface DependencyEdgeVerification {
  readonly edge: DepEdge;
  readonly realized: boolean;
  readonly confidence: VerificationConfidence;
  readonly reason: string;
  readonly evidence: readonly DependencyEvidence[];
}

export interface DependencyVerificationResult {
  readonly totalEdges: number;
  readonly realizedEdges: number;
  readonly realizationRate: number;
  readonly edgeDetails: readonly DependencyEdgeVerification[];
}

// ---------------------------------------------------------------------------
// Solution replay state
// ---------------------------------------------------------------------------

interface ReplayState {
  robot: { row: number; column: number };
  boxes: Array<{ row: number; column: number }>;
  goalPositions: Array<{ row: number; column: number }>;
}

function initReplayState(puzzle: PuzzleDefinition): ReplayState {
  const grid = puzzle.rows.map((r) => [...r]);
  const h = grid.length;

  let robot = { row: 0, column: 0 };
  const boxes: Array<{ row: number; column: number }> = [];
  const goalPositions: Array<{ row: number; column: number }> = [];

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      const ch = grid[r][c];
      if (ch === "R") robot = { row: r, column: c };
      if (ch === "X" || (ch >= "A" && ch <= "Z" && ch !== "O" && ch !== "R" && ch !== "S"))
        boxes.push({ row: r, column: c });
      if (ch === "S" || (ch >= "a" && ch <= "z"))
        goalPositions.push({ row: r, column: c });
    }
  }

  return { robot, boxes, goalPositions };
}

interface BoxMoveEvent {
  readonly stepIdx: number;
  readonly boxIndex: number;
  readonly from: { row: number; column: number };
  readonly to: { row: number; column: number };
  readonly onGoalBefore: boolean;
  readonly onGoalAfter: boolean;
}

interface BoxCompletionEvent {
  readonly boxIndex: number;
  readonly completionStep: number;
  readonly goalIndex: number;
}

function replaySolution(
  puzzle: PuzzleDefinition,
  steps: readonly SolutionStep[],
): {
  moveEvents: BoxMoveEvent[];
  completions: BoxCompletionEvent[];
  boxRoutes: Map<number, Set<string>>;
  boxSupportCells: Map<number, Set<string>>;
} {
  const state = initReplayState(puzzle);
  const goalSet = new Set(state.goalPositions.map((g) => `${g.row},${g.column}`));

  const moveEvents: BoxMoveEvent[] = [];
  const completions: BoxCompletionEvent[] = [];
  const completedBoxes = new Set<number>();
  const boxRoutes = new Map<number, Set<string>>();
  const boxSupportCells = new Map<number, Set<string>>();

  for (let i = 0; i < state.boxes.length; i++) {
    boxRoutes.set(i, new Set([`${state.boxes[i].row},${state.boxes[i].column}`]));
    boxSupportCells.set(i, new Set());
  }

  for (let stepIdx = 0; stepIdx < steps.length; stepIdx++) {
    const step = steps[stepIdx];
    const dir = directionDelta(step.direction);
    const nr = state.robot.row + dir.row;
    const nc = state.robot.column + dir.column;

    if (step.kind === "push") {
      const bi = state.boxes.findIndex((b) => b.row === nr && b.column === nc);
      if (bi >= 0) {
        const from = { row: nr, column: nc };
        const destR = nr + dir.row;
        const destC = nc + dir.column;
        const to = { row: destR, column: destC };

        const onGoalBefore = goalSet.has(`${from.row},${from.column}`);
        const onGoalAfter = goalSet.has(`${to.row},${to.column}`);

        moveEvents.push({ stepIdx, boxIndex: bi, from, to, onGoalBefore, onGoalAfter });

        state.boxes[bi] = to;
        boxRoutes.get(bi)!.add(`${to.row},${to.column}`);
        boxSupportCells.get(bi)!.add(`${state.robot.row},${state.robot.column}`);

        if (onGoalAfter && !completedBoxes.has(bi)) {
          const gi = state.goalPositions.findIndex(
            (g) => g.row === destR && g.column === destC,
          );
          if (gi >= 0) {
            completions.push({ boxIndex: bi, completionStep: stepIdx, goalIndex: gi });
            completedBoxes.add(bi);
          }
        }
      }
    }
    state.robot = { row: nr, column: nc };
  }

  return { moveEvents, completions, boxRoutes, boxSupportCells };
}

// ---------------------------------------------------------------------------
// Evidence-based verification per edge type
// ---------------------------------------------------------------------------

function verifyMustPrecede(
  fromNode: DepNode,
  toNode: DepNode,
  completions: BoxCompletionEvent[],
): DependencyEdgeVerification & { realized: boolean } {
  const fromCompletion = completions.find((c) => c.goalIndex === fromNode.goalIndex);
  const toCompletion = completions.find((c) => c.goalIndex === toNode.goalIndex);

  if (!fromCompletion || !toCompletion) {
    return {
      edge: null!,
      realized: false,
      confidence: "observed",
      reason: !fromCompletion
        ? `Goal ${fromNode.goalIndex} never completed`
        : `Goal ${toNode.goalIndex} never completed`,
      evidence: [],
    };
  }

  const realized = fromCompletion.completionStep < toCompletion.completionStep;
  const evidence: DependencyEvidence[] = [{
    kind: "completion-order",
    description: `Goal ${fromNode.goalIndex} completed at step ${fromCompletion.completionStep}, goal ${toNode.goalIndex} at step ${toCompletion.completionStep}`,
  }];

  return {
    edge: null!,
    realized,
    confidence: "observed",
    reason: realized
      ? `Goal ${fromNode.goalIndex} completed at step ${fromCompletion.completionStep} before goal ${toNode.goalIndex} at step ${toCompletion.completionStep}`
      : `Goal ${fromNode.goalIndex} completed at step ${fromCompletion.completionStep}, goal ${toNode.goalIndex} at step ${toCompletion.completionStep} (wrong order)`,
    evidence,
  };
}

function verifyBlocksAccess(
  fromNode: DepNode,
  toNode: DepNode,
  puzzle: PuzzleDefinition,
  steps: readonly SolutionStep[],
  moveEvents: BoxMoveEvent[],
  completions: BoxCompletionEvent[],
): DependencyEdgeVerification & { realized: boolean } {
  const fromCompletion = completions.find((c) => c.goalIndex === fromNode.goalIndex);
  const toCompletion = completions.find((c) => c.goalIndex === toNode.goalIndex);

  if (!fromCompletion || !toCompletion) {
    return {
      edge: null!,
      realized: false,
      confidence: "observed",
      reason: !fromCompletion
        ? `Goal ${fromNode.goalIndex} never completed`
        : `Goal ${toNode.goalIndex} never completed`,
      evidence: [],
    };
  }

  const orderCorrect = fromCompletion.completionStep < toCompletion.completionStep;
  const evidence: DependencyEvidence[] = [{
    kind: "completion-order",
    description: `Goal ${fromNode.goalIndex} at step ${fromCompletion.completionStep}, goal ${toNode.goalIndex} at step ${toCompletion.completionStep}`,
  }];

  const fromBoxMoves = moveEvents.filter((e) => e.boxIndex === fromCompletion.boxIndex);
  if (fromBoxMoves.length > 0) {
    const grid = puzzle.rows.map((r) => [...r]);
    const state = initReplayState(puzzle);

    const firstFromMove = fromBoxMoves[0];
    const toBoxGoal = state.goalPositions[toNode.goalIndex];

    if (toBoxGoal) {
      const boxSet = new Set(state.boxes.map((b) => `${b.row},${b.column}`));
      const reachableBefore = floodKeeperReachable(
        grid,
        state.robot,
        boxSet,
      );
      const goalKey = `${toBoxGoal.row},${toBoxGoal.column}`;
      const goalReachableBefore = reachableBefore.has(goalKey);

      if (!goalReachableBefore && orderCorrect) {
        evidence.push({
          kind: "access-blocked",
          description: `Goal region for goal ${toNode.goalIndex} at (${toBoxGoal.row},${toBoxGoal.column}) not reachable at start; from-box first moves at step ${firstFromMove.stepIdx}`,
        });
      }
    }
  }

  return {
    edge: null!,
    realized: orderCorrect,
    confidence: evidence.length > 1 ? "structural" : "observed",
    reason: orderCorrect
      ? `Goal ${fromNode.goalIndex} completed before goal ${toNode.goalIndex}, providing access`
      : `Order violation: goal ${fromNode.goalIndex} did not precede goal ${toNode.goalIndex}`,
    evidence,
  };
}

function verifyMustStage(
  fromNode: DepNode,
  toNode: DepNode,
  moveEvents: BoxMoveEvent[],
  completions: BoxCompletionEvent[],
): DependencyEdgeVerification & { realized: boolean } {
  const fromCompletion = completions.find((c) => c.goalIndex === fromNode.goalIndex);
  const toCompletion = completions.find((c) => c.goalIndex === toNode.goalIndex);

  if (!fromCompletion || !toCompletion) {
    return {
      edge: null!,
      realized: false,
      confidence: "observed",
      reason: !fromCompletion
        ? `Goal ${fromNode.goalIndex} never completed`
        : `Goal ${toNode.goalIndex} never completed`,
      evidence: [],
    };
  }

  const evidence: DependencyEvidence[] = [{
    kind: "completion-order",
    description: `Goal ${fromNode.goalIndex} at step ${fromCompletion.completionStep}, goal ${toNode.goalIndex} at step ${toCompletion.completionStep}`,
  }];

  const fromBoxMoves = moveEvents.filter((e) => e.boxIndex === fromCompletion.boxIndex);
  const toBoxMoves = moveEvents.filter((e) => e.boxIndex === toCompletion.boxIndex);

  let stagingDetected = false;

  if (fromBoxMoves.length >= 2) {
    for (let i = 0; i < fromBoxMoves.length; i++) {
      const displacement = fromBoxMoves[i];
      if (displacement.onGoalAfter) continue;

      for (const toMove of toBoxMoves) {
        if (toMove.stepIdx > displacement.stepIdx) {
          const laterFromMoves = fromBoxMoves.filter((m) => m.stepIdx > toMove.stepIdx);
          if (laterFromMoves.length > 0) {
            stagingDetected = true;
            evidence.push({
              kind: "staging-displacement",
              description: `Box for goal ${fromNode.goalIndex} displaced at step ${displacement.stepIdx}, ` +
                `box for goal ${toNode.goalIndex} moved at step ${toMove.stepIdx}, ` +
                `then from-box moved again at step ${laterFromMoves[0].stepIdx}`,
            });
            break;
          }
        }
      }
      if (stagingDetected) break;
    }
  }

  const orderCorrect = fromCompletion.completionStep < toCompletion.completionStep;
  const realized = orderCorrect && stagingDetected;

  return {
    edge: null!,
    realized,
    confidence: stagingDetected ? "structural" : "observed",
    reason: realized
      ? `Staging detected: box for goal ${fromNode.goalIndex} displaced, other box acted on, then from-box revisited`
      : stagingDetected
        ? `Staging pattern found but completion order wrong`
        : `No staging displacement detected (box for goal ${fromNode.goalIndex} has ${fromBoxMoves.length} moves)`,
    evidence,
  };
}

function verifySharesPassage(
  fromNode: DepNode,
  toNode: DepNode,
  boxRoutes: Map<number, Set<string>>,
  completions: BoxCompletionEvent[],
  passageCells?: ReadonlySet<string>,
): DependencyEdgeVerification & { realized: boolean } {
  const fromCompletion = completions.find((c) => c.goalIndex === fromNode.goalIndex);
  const toCompletion = completions.find((c) => c.goalIndex === toNode.goalIndex);

  if (!fromCompletion || !toCompletion) {
    return {
      edge: null!,
      realized: false,
      confidence: "observed",
      reason: !fromCompletion
        ? `Goal ${fromNode.goalIndex} never completed`
        : `Goal ${toNode.goalIndex} never completed`,
      evidence: [],
    };
  }

  const fromRoute = boxRoutes.get(fromCompletion.boxIndex) ?? new Set<string>();
  const toRoute = boxRoutes.get(toCompletion.boxIndex) ?? new Set<string>();
  const evidence: DependencyEvidence[] = [];

  let sharedCells = 0;
  for (const cell of fromRoute) {
    if (toRoute.has(cell)) sharedCells++;
  }

  if (sharedCells > 0) {
    evidence.push({
      kind: "shared-route",
      description: `${sharedCells} cells shared between box routes for goals ${fromNode.goalIndex} and ${toNode.goalIndex}`,
    });
  }

  if (passageCells) {
    let sharedPassageCells = 0;
    for (const cell of fromRoute) {
      if (passageCells.has(cell) && toRoute.has(cell)) sharedPassageCells++;
    }
    if (sharedPassageCells > 0) {
      evidence.push({
        kind: "shared-passage",
        description: `${sharedPassageCells} passage cells shared between routes`,
      });
    }
  }

  const realized = fromCompletion.completionStep !== toCompletion.completionStep &&
    (sharedCells > 0 || evidence.length > 0);

  return {
    edge: null!,
    realized,
    confidence: evidence.length > 0 ? "structural" : "observed",
    reason: realized
      ? `Goals ${fromNode.goalIndex} and ${toNode.goalIndex} share ${sharedCells} route cells and complete at different steps`
      : sharedCells === 0
        ? `No shared route cells between goals ${fromNode.goalIndex} and ${toNode.goalIndex}`
        : `Goals completed simultaneously — no passage sequencing`,
    evidence,
  };
}

// ---------------------------------------------------------------------------
// Main verification entry point
// ---------------------------------------------------------------------------

export function verifyDependenciesWithEvidence(
  dag: DepDAG,
  puzzle: PuzzleDefinition,
  steps: readonly SolutionStep[],
  passageCells?: ReadonlySet<string>,
): DependencyVerificationResult {
  const { moveEvents, completions, boxRoutes } = replaySolution(puzzle, steps);

  const edgeDetails: DependencyEdgeVerification[] = [];

  for (const edge of dag.edges) {
    const fromNode = dag.nodes.find((n) => n.id === edge.from);
    const toNode = dag.nodes.find((n) => n.id === edge.to);

    if (!fromNode || !toNode) {
      edgeDetails.push({
        edge,
        realized: false,
        confidence: "observed",
        reason: "Node not found in DAG",
        evidence: [],
      });
      continue;
    }

    let result: DependencyEdgeVerification & { realized: boolean };

    switch (edge.type) {
      case "must-precede":
        result = verifyMustPrecede(fromNode, toNode, completions);
        break;
      case "blocks-access":
        result = verifyBlocksAccess(fromNode, toNode, puzzle, steps, moveEvents, completions);
        break;
      case "must-stage":
        result = verifyMustStage(fromNode, toNode, moveEvents, completions);
        break;
      case "shares-passage":
        result = verifySharesPassage(fromNode, toNode, boxRoutes, completions, passageCells);
        break;
      default:
        result = {
          edge,
          realized: false,
          confidence: "observed",
          reason: `Unknown edge type: ${edge.type}`,
          evidence: [],
        };
    }

    edgeDetails.push({ ...result, edge });
  }

  const totalEdges = dag.edges.length;
  const realizedEdges = edgeDetails.filter((d) => d.realized).length;

  return {
    totalEdges,
    realizedEdges,
    realizationRate: totalEdges > 0 ? realizedEdges / totalEdges : 1,
    edgeDetails,
  };
}

// ---------------------------------------------------------------------------
// Helper: collect passage cells from blueprint passages
// ---------------------------------------------------------------------------

export function collectPassageCells(
  passages: readonly PassageEdge[],
): Set<string> {
  const cells = new Set<string>();
  for (const p of passages) {
    for (const c of p.cells) {
      cells.add(`${c.row},${c.column}`);
    }
  }
  return cells;
}
