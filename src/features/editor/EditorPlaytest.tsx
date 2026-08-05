import { useCallback, useEffect, useRef, useState } from "react";
import {
  createSession,
  move,
  reset,
  undo,
  type Direction,
  type GameSession,
  type PuzzleDefinition,
} from "@/src/core";
import { Board } from "@/src/features/game/Board";
import { useExperience } from "@/src/features/experience";
import { useGameKeyboard } from "@/src/features/game/use-game-keyboard";
import { useSwipeControls } from "@/src/features/game/use-swipe-controls";
import styles from "./EditorPlaytest.module.css";

interface EditorPlaytestProps {
  readonly puzzle: PuzzleDefinition;
  readonly onExit: () => void;
}

const MOVEMENT_BUTTONS: ReadonlyArray<{
  readonly direction: Direction;
  readonly label: string;
  readonly glyph: string;
}> = [
  { direction: "up", label: "Move up", glyph: "↑" },
  { direction: "left", label: "Move left", glyph: "←" },
  { direction: "down", label: "Move down", glyph: "↓" },
  { direction: "right", label: "Move right", glyph: "→" },
];

export function EditorPlaytest({ puzzle, onExit }: EditorPlaytestProps) {
  const { reducedMotion } = useExperience();
  const [session, setSession] = useState<GameSession>(() =>
    createSession(puzzle),
  );
  const boardWrapRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const attemptMove = useCallback((direction: Direction) => {
    setSession((current) =>
      current.solved ? current : move(current, direction),
    );
  }, []);
  const handleUndo = useCallback(() => {
    setSession((current) => undo(current));
  }, []);
  const handleReset = useCallback(() => {
    setSession((current) => reset(current));
  }, []);

  useGameKeyboard({
    enabled: true,
    onMove: attemptMove,
    onUndo: handleUndo,
    onReset: handleReset,
  });
  useSwipeControls(boardWrapRef, {
    enabled: !session.solved,
    onSwipe: attemptMove,
  });

  return (
    <section
      className={styles.playtest}
      aria-label={`Playtest ${puzzle.title}`}
    >
      <div className={styles.boardColumn}>
        <div className={styles.playtestHeading}>
          <div>
            <span>Private playtest</span>
            <h2 ref={headingRef} tabIndex={-1}>
              {puzzle.title}
            </h2>
          </div>
          <p>Arrow keys, WASD, swipe, or use the controls.</p>
        </div>

        <div
          className={styles.boardWrap}
          ref={boardWrapRef}
          data-testid="editor-playtest-board"
        >
          <Board session={session} reduceMotion={reducedMotion} />
        </div>
      </div>

      <aside className={styles.controlPanel} aria-label="Playtest controls">
        <div className={styles.stats} aria-label="Playtest counters">
          <div>
            <span>Moves</span>
            <strong data-testid="editor-playtest-moves">{session.moves}</strong>
          </div>
          <div>
            <span>Pushes</span>
            <strong data-testid="editor-playtest-pushes">
              {session.pushes}
            </strong>
          </div>
        </div>

        <p
          className={session.solved ? styles.solved : styles.progress}
          role="status"
          aria-live="polite"
        >
          {session.solved
            ? `Solved in ${session.moves} ${session.moves === 1 ? "move" : "moves"}!`
            : "Playtest in progress"}
        </p>

        <div className={styles.dpad} aria-label="Movement controls">
          {MOVEMENT_BUTTONS.map(({ direction, label, glyph }) => (
            <button
              className={styles[direction]}
              type="button"
              aria-label={label}
              disabled={session.solved}
              key={direction}
              onClick={() => attemptMove(direction)}
            >
              {glyph}
            </button>
          ))}
          <span className={styles.center} aria-hidden="true" />
        </div>

        <div className={styles.actions}>
          <button
            type="button"
            disabled={session.history.length === 0}
            onClick={handleUndo}
          >
            Undo
          </button>
          <button
            type="button"
            disabled={session.moves === 0}
            onClick={handleReset}
          >
            Restart
          </button>
          <button type="button" data-primary onClick={onExit}>
            Back to editor
          </button>
        </div>
      </aside>
    </section>
  );
}
