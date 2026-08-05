export {
  DIFFICULTIES,
  DIRECTIONS,
  type Box,
  type Difficulty,
  type Direction,
  type GameAction,
  type GameHistory,
  type GameHistoryEntry,
  type GameSession,
  type GameSnapshot,
  type Goal,
  type ParsedBoard,
  type Position,
  type PuzzleDefinition,
  type PuzzleDifficulty,
  type PuzzleValidationCode,
  type PuzzleValidationIssue,
  type PuzzleValidationResult,
  type DeadlockDetector,
  type SnapshotTransition,
} from "./model.ts";

export {
  ACTION_CODES,
  MAX_SHARED_ACTIONS,
  ActionLogError,
  decodeActionCode,
  decodeActionLog,
  encodeActionLog,
  encodeDirection,
  isActionCode,
  isActionLog,
  isShareableActionLog,
  type ActionCode,
  type ActionLogErrorCode,
} from "./action-log.ts";

export {
  PuzzleValidationError,
  parsePuzzle,
  parsePuzzleRows,
  validatePuzzle,
  validatePuzzleRows,
} from "./puzzle.ts";

export {
  directionDelta,
  freezeBox,
  numericPositionKey,
  positionKey,
  samePosition,
  translate,
} from "./position.ts";

export {
  createSession,
  isSolved,
  move,
  reset,
  sessionReducer,
  stepSnapshot,
  undo,
} from "./game-session.ts";

export { replayActionLog } from "./replay.ts";
