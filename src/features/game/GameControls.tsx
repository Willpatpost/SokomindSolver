import type { Direction } from "@/src/core/model";
import styles from "./GameControls.module.css";

interface GameControlsProps {
  canUndo: boolean;
  undoDepth?: number;
  canHint?: boolean;
  hintThinking?: boolean;
  disabled?: boolean;
  onMove: (direction: Direction) => void;
  onUndo: () => void;
  onUndoN?: (count: number) => void;
  onHint?: () => void;
  onReset: () => void;
}

const MOVE_BUTTONS: ReadonlyArray<{
  direction: Direction;
  label: string;
  glyph: string;
}> = [
  { direction: "up", label: "Move up", glyph: "↑" },
  { direction: "left", label: "Move left", glyph: "←" },
  { direction: "down", label: "Move down", glyph: "↓" },
  { direction: "right", label: "Move right", glyph: "→" },
];

export function GameControls({
  canUndo,
  undoDepth = 0,
  canHint = false,
  hintThinking = false,
  disabled = false,
  onMove,
  onUndo,
  onUndoN,
  onHint,
  onReset,
}: GameControlsProps) {
  return (
    <section className={styles.controls} aria-label="Game controls">
      <div className={styles.controlHeading}>
        <div>
          <p>Movement</p>
          <h2>Plan each push</h2>
        </div>
        <span>Arrows / WASD</span>
      </div>

      <div className={styles.dpad}>
        {MOVE_BUTTONS.map(({ direction, label, glyph }) => (
          <button
            className={styles[direction]}
            type="button"
            aria-label={label}
            disabled={disabled}
            key={direction}
            onClick={() => onMove(direction)}
          >
            {glyph}
          </button>
        ))}
        <span className={styles.center} aria-hidden="true" />
      </div>

      <div className={styles.actions}>
        <button type="button" onClick={onUndo} disabled={disabled || !canUndo}>
          <span>Undo{undoDepth > 0 ? ` (${undoDepth})` : ""}</span>
          <kbd>U</kbd>
        </button>
        {onUndoN && undoDepth >= 5 && (
          <button type="button" onClick={() => onUndoN(5)} disabled={disabled}>
            <span>Undo 5</span>
          </button>
        )}
        {onUndoN && undoDepth >= 10 && (
          <button type="button" onClick={() => onUndoN(Infinity)} disabled={disabled}>
            <span>Undo all</span>
          </button>
        )}
        <button
          type="button"
          className={hintThinking ? styles.thinking : undefined}
          onClick={onHint}
          disabled={disabled || !canHint}
        >
          <span>{hintThinking ? "Thinking…" : "Hint"}</span>
          <kbd>H</kbd>
        </button>
        <button type="button" onClick={onReset} disabled={disabled}>
          <span>Restart</span>
          <kbd>R</kbd>
        </button>
      </div>
    </section>
  );
}
