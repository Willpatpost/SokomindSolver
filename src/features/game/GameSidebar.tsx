import { memo } from "react";
import type { Direction, GameSession } from "@/src/core";
import type { PuzzleRecord } from "@/src/shared/progress";
import { formatTime } from "./timer-math";
import { GameControls } from "./GameControls";
import styles from "./GameSidebar.module.css";

interface GameSidebarProps {
  readonly session: GameSession;
  readonly best?: PuzzleRecord;
  readonly controlsDisabled?: boolean;
  readonly isOptimal?: boolean;
  readonly canHint?: boolean;
  readonly hintThinking?: boolean;
  readonly elapsed?: number;
  readonly onMove: (direction: Direction) => void;
  readonly onUndo: () => void;
  readonly onHint?: () => void;
  readonly onReset: () => void;
}

export const GameSidebar = memo(function GameSidebar({
  session,
  best,
  controlsDisabled = false,
  isOptimal = false,
  canHint = false,
  hintThinking = false,
  elapsed = 0,
  onMove,
  onUndo,
  onHint,
  onReset,
}: GameSidebarProps) {
  const { puzzle } = session;

  return (
    <aside className={styles.rightRail} aria-label="Current game details">
      <GameControls
        canUndo={session.history.length > 0}
        undoDepth={session.history.length}
        canHint={canHint}
        hintThinking={hintThinking}
        disabled={controlsDisabled}
        onMove={onMove}
        onUndo={onUndo}
        onHint={onHint}
        onReset={onReset}
      />

      <section className={styles.scoreCard}>
        <div className={styles.scoreHeading}>
          <p>Current route</p>
          <span>{puzzle.boxes} {puzzle.boxes === 1 ? "box" : "boxes"}</span>
        </div>
        {elapsed > 0 ? (
          <div className={styles.timer} data-testid="elapsed-time">
            {formatTime(elapsed)}
          </div>
        ) : null}
        <div className={styles.stats}>
          <div className={styles.stat}>
            <strong data-testid="moves-count">{session.moves}</strong>
            <span>Moves</span>
            {best && session.moves > 0 ? (
              <small
                className={styles.delta}
                data-pace={session.moves <= best.moves ? "ahead" : "behind"}
              >
                {session.moves >= best.moves ? "+" : ""}
                {session.moves - best.moves}
              </small>
            ) : null}
          </div>
          <div className={styles.stat}>
            <strong data-testid="pushes-count">{session.pushes}</strong>
            <span>Pushes</span>
            {best && session.pushes > 0 ? (
              <small
                className={styles.delta}
                data-pace={session.pushes <= best.pushes ? "ahead" : "behind"}
              >
                {session.pushes >= best.pushes ? "+" : ""}
                {session.pushes - best.pushes}
              </small>
            ) : null}
          </div>
        </div>
        <div className={styles.best}>
          <span>Personal best{isOptimal ? " ★" : ""}</span>
          <strong>
            {best ? `${best.pushes} pushes · ${best.moves} moves` : "Not cleared"}
          </strong>
        </div>
        {isOptimal ? (
          <div className={styles.optimalBadge}>Optimal</div>
        ) : null}
      </section>

      <section className={styles.legend} aria-label="Board legend">
        <h2>Reading the room</h2>
        <div className={styles.legendItems}>
          <div className={styles.legendItem}>
            <span className={styles.legendMark}>×</span>
            <span>Box — push onto a goal</span>
          </div>
          <div className={styles.legendItem}>
            <span className={styles.legendMark} data-type="goal">A</span>
            <span>Goal — match its letter</span>
          </div>
          <div className={styles.legendItem}>
            <span className={styles.legendMark} data-type="keeper">••</span>
            <span>Keeper — that&apos;s you</span>
          </div>
        </div>
      </section>
    </aside>
  );
});
