import type { SolutionStep } from "../../../solver/contracts.ts";
import type { PuzzleDefinition } from "../../../core/model.ts";
import { directionDelta } from "../../../core/position.ts";
import { floodKeeperReachable } from "./reachable-pushes.ts";
import type { PassageEdge } from "./blueprint-types.ts";
import { isBoxChar, isGoalChar, isRobotChar } from "./tile-semantics.ts";

// ---------------------------------------------------------------------------
// Structural interfaces (avoid importing dependency-graph.ts to prevent cycle)
// ---------------------------------------------------------------------------

interface DepNode {
  readonly id: number;
  readonly goalIndex: number;
  readonly roomId: number;
  readonly role: string;
}

type DepEdgeType = "must-precede" | "must-stage" | "shares-passage" | "blocks-access"
  | "must-reopen" | "must-park" | "chain-link" | "exchange-cross"
  | "assignment-cross" | "support-conflict" | "chain-merge";

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

export type VerificationConfidence = "observed" | "structural" | "counterfactual" | "proven";

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

type EdgeVerificationBody = Omit<DependencyEdgeVerification, "edge">;

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
      if (isRobotChar(ch)) robot = { row: r, column: c };
      if (isBoxChar(ch))
        boxes.push({ row: r, column: c });
      if (isGoalChar(ch))
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
): EdgeVerificationBody {
  const fromCompletion = completions.find((c) => c.goalIndex === fromNode.goalIndex);
  const toCompletion = completions.find((c) => c.goalIndex === toNode.goalIndex);

  if (!fromCompletion || !toCompletion) {
    return {
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
): EdgeVerificationBody {
  const fromCompletion = completions.find((c) => c.goalIndex === fromNode.goalIndex);
  const toCompletion = completions.find((c) => c.goalIndex === toNode.goalIndex);

  if (!fromCompletion || !toCompletion) {
    return {
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
): EdgeVerificationBody {
  const fromCompletion = completions.find((c) => c.goalIndex === fromNode.goalIndex);
  const toCompletion = completions.find((c) => c.goalIndex === toNode.goalIndex);

  if (!fromCompletion || !toCompletion) {
    return {

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
): EdgeVerificationBody {
  const fromCompletion = completions.find((c) => c.goalIndex === fromNode.goalIndex);
  const toCompletion = completions.find((c) => c.goalIndex === toNode.goalIndex);

  if (!fromCompletion || !toCompletion) {
    return {

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

function verifyMustReopen(
  fromNode: DepNode,
  toNode: DepNode,
  moveEvents: BoxMoveEvent[],
  completions: BoxCompletionEvent[],
): EdgeVerificationBody {
  const fromCompletion = completions.find((c) => c.goalIndex === fromNode.goalIndex);
  const toCompletion = completions.find((c) => c.goalIndex === toNode.goalIndex);

  if (!fromCompletion || !toCompletion) {
    return {

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

  // Look for: from-box moved off goal, then to-box moved, then from-box returned to goal
  let reopenDetected = false;

  for (let i = 0; i < fromBoxMoves.length; i++) {
    const offGoalMove = fromBoxMoves[i];
    if (!offGoalMove.onGoalBefore || offGoalMove.onGoalAfter) continue;

    // from-box was on goal and moved off — find a to-box move after this
    for (const toMove of toBoxMoves) {
      if (toMove.stepIdx <= offGoalMove.stepIdx) continue;

      // find from-box returning to a goal after to-box moved
      for (let j = i + 1; j < fromBoxMoves.length; j++) {
        const returnMove = fromBoxMoves[j];
        if (returnMove.stepIdx > toMove.stepIdx && returnMove.onGoalAfter) {
          reopenDetected = true;
          evidence.push({
            kind: "reopen-gate",
            description: `Gatekeeper box ${fromCompletion.boxIndex} left goal at step ${offGoalMove.stepIdx}, ` +
              `box ${toCompletion.boxIndex} moved at step ${toMove.stepIdx}, ` +
              `then gatekeeper returned to goal at step ${returnMove.stepIdx}`,
          });
          break;
        }
      }
      if (reopenDetected) break;
    }
    if (reopenDetected) break;
  }

  const realized = reopenDetected;

  return {

    realized,
    confidence: reopenDetected ? "structural" : "observed",
    reason: realized
      ? `Reopen detected: gatekeeper box for goal ${fromNode.goalIndex} moved off goal, to-box passed, then gatekeeper returned`
      : `No reopen pattern detected for gatekeeper box ${fromCompletion.boxIndex} (${fromBoxMoves.length} moves)`,
    evidence,
  };
}

function verifyMustPark(
  fromNode: DepNode,
  toNode: DepNode,
  moveEvents: BoxMoveEvent[],
  completions: BoxCompletionEvent[],
): EdgeVerificationBody {
  const fromCompletion = completions.find((c) => c.goalIndex === fromNode.goalIndex);
  const toCompletion = completions.find((c) => c.goalIndex === toNode.goalIndex);

  if (!fromCompletion || !toCompletion) {
    return {

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

  // Look for a move where box lands on non-goal cell, then later lands on a goal cell
  let parkDetected = false;

  for (let i = 0; i < fromBoxMoves.length; i++) {
    const parkMove = fromBoxMoves[i];
    if (parkMove.onGoalAfter) continue;

    // Box was placed on a non-goal cell — look for a later move to a goal cell
    for (let j = i + 1; j < fromBoxMoves.length; j++) {
      if (fromBoxMoves[j].onGoalAfter) {
        parkDetected = true;
        evidence.push({
          kind: "park-and-resume",
          description: `Box ${fromCompletion.boxIndex} parked at non-goal cell at step ${parkMove.stepIdx}, ` +
            `then moved to goal cell at step ${fromBoxMoves[j].stepIdx}`,
        });
        break;
      }
    }
    if (parkDetected) break;
  }

  const realized = parkDetected;

  return {

    realized,
    confidence: parkDetected ? "structural" : "observed",
    reason: realized
      ? `Parking detected: box for goal ${fromNode.goalIndex} temporarily placed on non-goal cell before reaching goal`
      : `No parking pattern detected for box ${fromCompletion.boxIndex} (${fromBoxMoves.length} moves)`,
    evidence,
  };
}

function verifyChainLink(
  fromNode: DepNode,
  toNode: DepNode,
  completions: BoxCompletionEvent[],
  dag: DepDAG,
): EdgeVerificationBody {
  const fromCompletion = completions.find((c) => c.goalIndex === fromNode.goalIndex);
  const toCompletion = completions.find((c) => c.goalIndex === toNode.goalIndex);

  if (!fromCompletion || !toCompletion) {
    return {

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

  // Count chain-link edges to determine chain length
  const chainLinkEdges = dag.edges.filter((e) => e.type === "chain-link");
  const chainLength = chainLinkEdges.length + 1; // edges + 1 = number of nodes in chain

  if (chainLength >= 3) {
    evidence.push({
      kind: "chain-length",
      description: `Chain has ${chainLength} goals (${chainLinkEdges.length} chain-link edges), enforcing strict sequential ordering`,
    });
  }

  // Verify strict ordering: no other chain-link completion falls between from and to
  if (realized && chainLength >= 3) {
    const chainNodeIds = new Set<number>();
    for (const e of chainLinkEdges) {
      chainNodeIds.add(e.from);
      chainNodeIds.add(e.to);
    }

    const chainCompletions = completions
      .filter((c) => {
        const node = dag.nodes.find((n) => n.goalIndex === c.goalIndex);
        return node != null && chainNodeIds.has(node.id);
      })
      .sort((a, b) => a.completionStep - b.completionStep);

    let strictOrder = true;
    for (let i = 1; i < chainCompletions.length; i++) {
      if (chainCompletions[i].completionStep <= chainCompletions[i - 1].completionStep) {
        strictOrder = false;
        break;
      }
    }

    if (strictOrder) {
      evidence.push({
        kind: "strict-chain-order",
        description: `All ${chainCompletions.length} chain goals completed in strictly increasing step order`,
      });
    }
  }

  const confidence: VerificationConfidence = chainLength >= 3 ? "structural" : "observed";

  return {

    realized,
    confidence,
    reason: realized
      ? `Goal ${fromNode.goalIndex} completed at step ${fromCompletion.completionStep} before goal ${toNode.goalIndex} at step ${toCompletion.completionStep} (chain length ${chainLength})`
      : `Goal ${fromNode.goalIndex} completed at step ${fromCompletion.completionStep}, goal ${toNode.goalIndex} at step ${toCompletion.completionStep} (wrong order)`,
    evidence,
  };
}

function verifyExchangeCross(
  fromNode: DepNode,
  toNode: DepNode,
  boxRoutes: Map<number, Set<string>>,
  completions: BoxCompletionEvent[],
  passageCells?: ReadonlySet<string>,
): EdgeVerificationBody {
  const fromCompletion = completions.find((c) => c.goalIndex === fromNode.goalIndex);
  const toCompletion = completions.find((c) => c.goalIndex === toNode.goalIndex);

  if (!fromCompletion || !toCompletion) {
    return {

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

  // Check that both boxes passed through passage cells
  let fromPassageCells = 0;
  let toPassageCells = 0;
  if (passageCells) {
    for (const cell of fromRoute) {
      if (passageCells.has(cell)) fromPassageCells++;
    }
    for (const cell of toRoute) {
      if (passageCells.has(cell)) toPassageCells++;
    }
  }

  const bothUsedPassage = fromPassageCells > 0 && toPassageCells > 0;

  // Check cross-room movement: box A from room-of-from to room-of-to, box B opposite
  const crossRoom = fromNode.roomId !== toNode.roomId;

  let realized = false;

  if (bothUsedPassage && crossRoom) {
    // Shared passage cells indicate the routes crossed through the same passage
    let sharedPassageCells = 0;
    for (const cell of fromRoute) {
      if (passageCells!.has(cell) && toRoute.has(cell)) sharedPassageCells++;
    }

    if (sharedPassageCells > 0) {
      realized = true;
      evidence.push({
        kind: "exchange-passage",
        description: `Box ${fromCompletion.boxIndex} (room ${fromNode.roomId}) and box ${toCompletion.boxIndex} (room ${toNode.roomId}) crossed through ${sharedPassageCells} shared passage cells`,
      });
    }

    evidence.push({
      kind: "cross-room-routes",
      description: `Box ${fromCompletion.boxIndex} used ${fromPassageCells} passage cells, box ${toCompletion.boxIndex} used ${toPassageCells} passage cells, rooms ${fromNode.roomId} ↔ ${toNode.roomId}`,
    });
  } else if (!bothUsedPassage) {
    evidence.push({
      kind: "no-passage-use",
      description: `Box ${fromCompletion.boxIndex} used ${fromPassageCells} passage cells, box ${toCompletion.boxIndex} used ${toPassageCells} passage cells — both must use passage`,
    });
  } else {
    evidence.push({
      kind: "same-room",
      description: `Both nodes in room ${fromNode.roomId} — exchange requires different rooms`,
    });
  }

  return {

    realized,
    confidence: realized ? "structural" : "observed",
    reason: realized
      ? `Exchange detected: boxes from rooms ${fromNode.roomId} and ${toNode.roomId} crossed through shared passage`
      : bothUsedPassage
        ? `Both boxes used passages but no shared crossing detected`
        : `Passage usage insufficient for exchange (from: ${fromPassageCells}, to: ${toPassageCells})`,
    evidence,
  };
}

// ---------------------------------------------------------------------------
// Main verification entry point
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Counterfactual verification helpers
// ---------------------------------------------------------------------------

function buildFloorGrid(puzzle: PuzzleDefinition): string[][] {
  return puzzle.rows.map((r) => [...r]);
}

function counterfactualBlocksAccess(
  fromNode: DepNode,
  toNode: DepNode,
  puzzle: PuzzleDefinition,
): DependencyEvidence | null {
  const state = initReplayState(puzzle);
  const grid = buildFloorGrid(puzzle);

  const fromBox = state.boxes[fromNode.goalIndex];
  const toGoal = state.goalPositions[toNode.goalIndex];
  if (!fromBox || !toGoal) return null;

  const boxSet = new Set(state.boxes.map((b) => `${b.row},${b.column}`));
  boxSet.add(`${fromBox.row},${fromBox.column}`);

  const reachable = floodKeeperReachable(grid, state.robot, boxSet);
  const goalKey = `${toGoal.row},${toGoal.column}`;

  if (!reachable.has(goalKey)) {
    return {
      kind: "counterfactual-blocked",
      description:
        `With gate box frozen at (${fromBox.row},${fromBox.column}), ` +
        `goal (${toGoal.row},${toGoal.column}) is unreachable — gate is causally required`,
    };
  }

  return null;
}

function counterfactualMustReopen(
  fromNode: DepNode,
  toNode: DepNode,
  puzzle: PuzzleDefinition,
): DependencyEvidence | null {
  return counterfactualBlocksAccess(fromNode, toNode, puzzle);
}

function counterfactualMustPrecede(
  fromNode: DepNode,
  toNode: DepNode,
  puzzle: PuzzleDefinition,
): DependencyEvidence | null {
  const state = initReplayState(puzzle);
  const grid = buildFloorGrid(puzzle);

  const fromBox = state.boxes[fromNode.goalIndex];
  const toGoal = state.goalPositions[toNode.goalIndex];
  if (!fromBox || !toGoal) return null;

  const boxSet = new Set(state.boxes.map((b) => `${b.row},${b.column}`));

  const reachable = floodKeeperReachable(grid, state.robot, boxSet);
  const goalKey = `${toGoal.row},${toGoal.column}`;

  if (!reachable.has(goalKey)) {
    return {
      kind: "counterfactual-order",
      description:
        `Goal (${toGoal.row},${toGoal.column}) is unreachable at start — ` +
        `preceding box at (${fromBox.row},${fromBox.column}) must be moved first`,
    };
  }

  return null;
}

function counterfactualChainLink(
  fromNode: DepNode,
  toNode: DepNode,
  puzzle: PuzzleDefinition,
): DependencyEvidence | null {
  return counterfactualMustPrecede(fromNode, toNode, puzzle);
}

function counterfactualMustPark(
  fromNode: DepNode,
  toNode: DepNode,
  puzzle: PuzzleDefinition,
): DependencyEvidence | null {
  const state = initReplayState(puzzle);
  const grid = buildFloorGrid(puzzle);

  const fromBox = state.boxes[fromNode.goalIndex];
  const toGoal = state.goalPositions[toNode.goalIndex];
  if (!fromBox || !toGoal) return null;

  const boxSet = new Set(state.boxes.map((b) => `${b.row},${b.column}`));
  const reachable = floodKeeperReachable(grid, state.robot, boxSet);
  const goalKey = `${toGoal.row},${toGoal.column}`;

  if (!reachable.has(goalKey)) {
    return {
      kind: "counterfactual-park",
      description:
        `Goal (${toGoal.row},${toGoal.column}) is unreachable at start — ` +
        `box at (${fromBox.row},${fromBox.column}) blocks access, requiring temporary parking`,
    };
  }

  return null;
}

function counterfactualMustStage(
  fromNode: DepNode,
  toNode: DepNode,
  puzzle: PuzzleDefinition,
): DependencyEvidence | null {
  const state = initReplayState(puzzle);
  const grid = buildFloorGrid(puzzle);

  const fromBox = state.boxes[fromNode.goalIndex];
  const toGoal = state.goalPositions[toNode.goalIndex];
  if (!fromBox || !toGoal) return null;

  const boxSet = new Set(state.boxes.map((b) => `${b.row},${b.column}`));
  const reachable = floodKeeperReachable(grid, state.robot, boxSet);
  const goalKey = `${toGoal.row},${toGoal.column}`;

  if (!reachable.has(goalKey)) {
    return {
      kind: "counterfactual-stage",
      description:
        `Goal (${toGoal.row},${toGoal.column}) is unreachable at start — ` +
        `box at (${fromBox.row},${fromBox.column}) must be staged before target can complete`,
    };
  }

  return null;
}

function counterfactualExchangeCross(
  fromNode: DepNode,
  toNode: DepNode,
  puzzle: PuzzleDefinition,
): DependencyEvidence | null {
  const state = initReplayState(puzzle);
  const grid = buildFloorGrid(puzzle);

  const fromBox = state.boxes[fromNode.goalIndex];
  const toGoal = state.goalPositions[toNode.goalIndex];
  if (!fromBox || !toGoal) return null;

  const boxSet = new Set(state.boxes.map((b) => `${b.row},${b.column}`));
  boxSet.add(`${fromBox.row},${fromBox.column}`);

  const reachable = floodKeeperReachable(grid, state.robot, boxSet);
  const goalKey = `${toGoal.row},${toGoal.column}`;

  if (!reachable.has(goalKey)) {
    return {
      kind: "counterfactual-exchange",
      description:
        `With exchange box frozen at (${fromBox.row},${fromBox.column}), ` +
        `opposite goal (${toGoal.row},${toGoal.column}) is unreachable — ` +
        `cross-room exchange is causally required`,
    };
  }

  return null;
}

function applyCounterfactual(
  edge: DepEdge,
  fromNode: DepNode,
  toNode: DepNode,
  puzzle: PuzzleDefinition,
): DependencyEvidence | null {
  switch (edge.type) {
    case "blocks-access":
      return counterfactualBlocksAccess(fromNode, toNode, puzzle);
    case "must-reopen":
      return counterfactualMustReopen(fromNode, toNode, puzzle);
    case "must-precede":
      return counterfactualMustPrecede(fromNode, toNode, puzzle);
    case "chain-link":
      return counterfactualChainLink(fromNode, toNode, puzzle);
    case "must-park":
      return counterfactualMustPark(fromNode, toNode, puzzle);
    case "must-stage":
      return counterfactualMustStage(fromNode, toNode, puzzle);
    case "exchange-cross":
    case "assignment-cross":
      return counterfactualExchangeCross(fromNode, toNode, puzzle);
    default:
      return null;
  }
}

export function verifyDependenciesCounterfactual(
  dag: DepDAG,
  puzzle: PuzzleDefinition,
  steps: readonly SolutionStep[],
  passageCells?: ReadonlySet<string>,
): DependencyVerificationResult {
  const baseResult = verifyDependenciesWithEvidence(dag, puzzle, steps, passageCells);

  const enhanced: DependencyEdgeVerification[] = baseResult.edgeDetails.map((detail) => {
    if (!detail.realized) return detail;
    if (detail.confidence === "counterfactual") return detail;

    const fromNode = dag.nodes.find((n) => n.id === detail.edge.from);
    const toNode = dag.nodes.find((n) => n.id === detail.edge.to);
    if (!fromNode || !toNode) return detail;

    const cf = applyCounterfactual(detail.edge, fromNode, toNode, puzzle);
    if (!cf) return detail;

    return {
      ...detail,
      confidence: "counterfactual" as VerificationConfidence,
      evidence: [...detail.evidence, cf],
    };
  });

  const realizedEdges = enhanced.filter((d) => d.realized).length;

  return {
    totalEdges: enhanced.length,
    realizedEdges,
    realizationRate: enhanced.length > 0 ? realizedEdges / enhanced.length : 1,
    edgeDetails: enhanced,
  };
}

export function verifyDependenciesWithEvidence(
  dag: DepDAG,
  puzzle: PuzzleDefinition,
  steps: readonly SolutionStep[],
  passageCells?: ReadonlySet<string>,
): DependencyVerificationResult {
  const { moveEvents, completions, boxRoutes, boxSupportCells } = replaySolution(puzzle, steps);

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

    let result: EdgeVerificationBody;

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
      case "must-reopen":
        result = verifyMustReopen(fromNode, toNode, moveEvents, completions);
        break;
      case "must-park":
        result = verifyMustPark(fromNode, toNode, moveEvents, completions);
        break;
      case "chain-link":
        result = verifyChainLink(fromNode, toNode, completions, dag);
        break;
      case "exchange-cross":
        result = verifyExchangeCross(fromNode, toNode, boxRoutes, completions, passageCells);
        break;
      case "assignment-cross": {
        const base = verifyExchangeCross(fromNode, toNode, boxRoutes, completions, passageCells);
        result = base.realized ? {
          ...base,
          evidence: [...base.evidence, { kind: "assignment-surprise", description: "The assigned boxes cross rooms instead of taking the locally obvious goal pairing" }],
        } : base;
        break;
      }
      case "support-conflict": {
        const fromCompletion = completions.find((item) => item.goalIndex === fromNode.goalIndex);
        const toCompletion = completions.find((item) => item.goalIndex === toNode.goalIndex);
        const fromSupport = fromCompletion ? boxSupportCells.get(fromCompletion.boxIndex) : undefined;
        const toSupport = toCompletion ? boxSupportCells.get(toCompletion.boxIndex) : undefined;
        const shared = fromSupport && toSupport
          ? [...fromSupport].filter((cell) => toSupport.has(cell))
          : [];
        result = {
          realized: shared.length > 0,
          confidence: "observed",
          reason: shared.length > 0 ? `${shared.length} keeper support cells are shared` : "No shared keeper support cell was used",
          evidence: shared.length > 0 ? [{ kind: "support-contention", description: `Boxes used shared support cells: ${shared.join(", ")}` }] : [],
        };
        break;
      }
      case "chain-merge": {
        const base = verifyMustPrecede(fromNode, toNode, completions);
        result = base.realized ? {
          ...base,
          evidence: [...base.evidence, { kind: "chain-merge", description: "A predecessor chain completed before the shared merge goal" }],
        } : base;
        break;
      }
      default:
        result = {
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
