/**
 * Framework-independent domain types shared by the game, UI, and future solvers.
 *
 * Every type in this file is JSON-safe. Runtime modules return frozen values as
 * well, so a session can safely cross a worker boundary without leaking mutable
 * engine state.
 */

export const DIFFICULTIES = [
  "tutorial",
  "beginner",
  "intermediate",
  "advanced",
  "expert",
  "master",
] as const;

export type Difficulty = (typeof DIFFICULTIES)[number];

/** Backwards-friendly descriptive alias for catalog consumers. */
export type PuzzleDifficulty = Difficulty;

export interface PuzzleDefinition {
  readonly id: string;
  readonly title: string;
  readonly difficulty: Difficulty;
  readonly boxes: number;
  readonly hint?: string;
  readonly collection?: string;
  readonly rows: readonly string[];
  readonly complexity?: { readonly estimatedDifficulty: number };
}

export const DIRECTIONS = ["up", "down", "left", "right"] as const;

export type Direction = (typeof DIRECTIONS)[number];

export interface Position {
  readonly row: number;
  readonly column: number;
}

export interface Box {
  /** Stable across moves; generated in source-row order. */
  readonly id: string;
  /** `X` is generic; every other value is a dedicated uppercase label. */
  readonly label: string;
  readonly position: Position;
}

export interface Goal {
  /** `X` is generic; every other value is a dedicated uppercase label. */
  readonly label: string;
  readonly position: Position;
}

/**
 * Immutable static board data.
 *
 * `rows` is rectangular. Missing cells from ragged source rows are normalized
 * to walls, matching the behavior of the existing Sokomind puzzle format.
 */
export interface ParsedBoard {
  readonly width: number;
  readonly height: number;
  readonly rows: readonly string[];
  readonly walls: readonly Position[];
  readonly floor: readonly Position[];
  readonly goals: readonly Goal[];
  readonly initialRobot: Position;
  readonly initialBoxes: readonly Box[];
}

/** Dynamic state only. Pair with ParsedBoard when submitting solver work. */
export interface GameSnapshot {
  readonly puzzleId: string;
  readonly robot: Position;
  readonly boxes: readonly Box[];
  readonly moves: number;
  readonly pushes: number;
  readonly solved: boolean;
}

/**
 * One link in the immutable undo chain. Each successful step adds exactly one
 * entry and shares the rest of the chain with the prior session.
 */
export interface GameHistoryEntry {
  readonly snapshot: GameSnapshot;
  readonly previous: GameHistoryEntry | null;
}

/**
 * Persistent undo history.
 *
 * Keeping only a head pointer and length avoids copying every prior snapshot
 * on every move. Consumers should treat the representation as an undo stack;
 * the current session remains the canonical place for counters and state.
 */
export interface GameHistory {
  readonly head: GameHistoryEntry | null;
  readonly length: number;
}

/** Result of applying one direction to dynamic state without session history. */
export interface SnapshotTransition {
  /** The original snapshot for blocked steps, or a new frozen snapshot. */
  readonly snapshot: GameSnapshot;
  readonly moved: boolean;
  readonly pushed: boolean;
  /** The stable id of the pushed box, when `pushed` is true. */
  readonly pushedBoxId?: string;
  /** When a `DeadlockDetector` is supplied, indicates the resulting state is unsolvable. */
  readonly deadlocked?: boolean;
}

/**
 * A session is a persistent value: transitions return a new session and never
 * mutate the old one. `actionLog` records successful steps as U/D/L/R.
 */
export interface GameSession {
  readonly puzzle: PuzzleDefinition;
  readonly board: ParsedBoard;
  readonly snapshot: GameSnapshot;
  readonly history: GameHistory;
  readonly actionLog: string;
  readonly moves: number;
  readonly pushes: number;
  readonly solved: boolean;
}

export type PuzzleValidationCode =
  | "invalid-puzzle"
  | "invalid-metadata"
  | "empty-board"
  | "invalid-row"
  | "unsupported-symbol"
  | "robot-count"
  | "box-goal-mismatch"
  | "box-metadata-mismatch";

export interface PuzzleValidationIssue {
  readonly code: PuzzleValidationCode;
  readonly message: string;
  /** Zero-based row, when the issue belongs to a cell or row. */
  readonly row?: number;
  /** Zero-based column, when the issue belongs to a cell. */
  readonly column?: number;
}

export interface PuzzleValidationResult {
  readonly valid: boolean;
  readonly errors: readonly PuzzleValidationIssue[];
}

export type GameAction =
  | Readonly<{ type: "move"; direction: Direction }>
  | Readonly<{ type: "undo" }>
  | Readonly<{ type: "reset" }>;

/**
 * Optional callback that the core engine invokes after a box push to determine
 * whether the resulting state is unsolvable.  Injected by the caller so the
 * core engine never imports from the solver layer.
 */
export type DeadlockDetector = (
  board: ParsedBoard,
  snapshot: GameSnapshot,
) => boolean;
