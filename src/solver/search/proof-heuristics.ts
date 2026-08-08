export type {
  ProofHeuristicRegistration,
} from "./proof-heuristic-registry.ts";
export { ProofHeuristicRegistry } from "./proof-heuristic-registry.ts";

export {
  AssignmentHeuristic,
  assignmentLowerBound,
  minimumManhattanWalkToPotentialPush,
  minimumReachableWalkToLegalPush,
} from "./heuristic.ts";
export type {
  AssignmentHeuristicOptions,
  AssignmentHeuristicStats,
} from "./heuristic.ts";

export { InteractionBoostEvaluator } from "./interaction-boost.ts";
export type { InteractionBoostStats } from "./interaction-boost.ts";

export { RoomPatternHeuristic } from "./room-pattern-heuristic.ts";
export type {
  PatternTable,
  HeuristicCandidate,
  RoomPatternStats,
} from "./room-pattern-heuristic.ts";

export { PairConflictHeuristic } from "./pair-conflict-heuristic.ts";
export type { PairConflictStats } from "./pair-conflict-heuristic.ts";

export { LocalRoomLowerBound, LocalRoomDeadlockDetector } from "./local-room-heuristic.ts";
export type { LocalRoomLowerBoundStats, LocalRoomDeadlockStats } from "./local-room-heuristic.ts";

export { LocalCorralLowerBound, LocalCorralDeadlockDetector } from "./local-corral-heuristic.ts";
export type { LocalCorralLowerBoundStats, LocalCorralDeadlockStats } from "./local-corral-heuristic.ts";

export { DoorwayCrossingLowerBound } from "./doorway-crossing-heuristic.ts";
export type { DoorwayCrossingStats } from "./doorway-crossing-heuristic.ts";

export { ForcedPushMacroDetector } from "./forced-push-macros.ts";
export type { ForcedPushMacroStats, ForcedPushResult } from "./forced-push-macros.ts";

import type { CompiledSearchBoard } from "./compiled-board.ts";
import { ProofHeuristicRegistry } from "./proof-heuristic-registry.ts";
import { assignmentLowerBound } from "./heuristic.ts";
import { LocalRoomLowerBound } from "./local-room-heuristic.ts";
import { LocalCorralLowerBound } from "./local-corral-heuristic.ts";
import { DoorwayCrossingLowerBound } from "./doorway-crossing-heuristic.ts";
import { KeeperReachability } from "./reachability.ts";

const roomLBCache = new WeakMap<CompiledSearchBoard, LocalRoomLowerBound>();
const corralLBCache = new WeakMap<CompiledSearchBoard, { lb: LocalCorralLowerBound; reachability: KeeperReachability }>();
const doorwayLBCache = new WeakMap<CompiledSearchBoard, DoorwayCrossingLowerBound>();

export function createDefaultProofRegistry(): ProofHeuristicRegistry {
  const registry = new ProofHeuristicRegistry();

  registry.register({
    id: "typed-assignment-push-lb",
    objective: "moves",
    proofFamily: "assignment",
    evaluate: (board, boxes) => assignmentLowerBound(board, boxes),
  });

  registry.register({
    id: "local-room-push-lb",
    objective: "moves",
    proofFamily: "room",
    evaluate: (board, boxes) => {
      let instance = roomLBCache.get(board);
      if (!instance) {
        instance = new LocalRoomLowerBound(board, board.topology);
        roomLBCache.set(board, instance);
      }
      return instance.evaluate(boxes);
    },
  });

  registry.register({
    id: "local-corral-push-lb",
    objective: "moves",
    proofFamily: "corral",
    evaluate: (board, boxes, robotCell?) => {
      if (robotCell === undefined) return 0;
      let cached = corralLBCache.get(board);
      if (!cached) {
        cached = {
          lb: new LocalCorralLowerBound(board),
          reachability: new KeeperReachability(board),
        };
        corralLBCache.set(board, cached);
      }
      const occupancy = new Uint8Array(board.cellCount);
      for (const box of boxes) {
        occupancy[box.cell] = 1;
      }
      const reachable = cached.reachability.flood(robotCell, occupancy);
      return cached.lb.evaluate(boxes, occupancy, reachable);
    },
  });

  registry.register({
    id: "doorway-crossing-push-lb",
    objective: "moves",
    proofFamily: "doorway",
    evaluate: (board, boxes) => {
      let instance = doorwayLBCache.get(board);
      if (!instance) {
        instance = new DoorwayCrossingLowerBound(board, board.topology);
        doorwayLBCache.set(board, instance);
      }
      return instance.evaluate(boxes);
    },
  });

  return registry;
}
