import { useEffect, useState } from "react";
import type { Direction } from "@/src/core/model";
import styles from "./GameControls.module.css";

function HintThinkingLabel() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = performance.now();
    const id = setInterval(() => {
      setElapsed(Math.floor((performance.now() - start) / 1000));
    }, 250);
    return () => clearInterval(id);
  }, []);
  return <>Thinking{elapsed > 0 ? ` ${elapsed}s` : ""}…</>;
}

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
  variant?: "full" | "compact";
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
  variant = "full",
}: GameControlsProps) {
  return (
    <section
      className={styles.controls}
      aria-label="Game controls"
      data-variant={variant}
    >
      {variant === "full" ? (
        <div className={styles.controlHeading}>
          <div>
            <p>Movement</p>
            <h2>Plan each push</h2>
          </div>
          <span>Arrows / WASD</span>
        </div>
      ) : null}

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
        {variant === "full" && onUndoN && undoDepth >= 5 && (
          <button type="button" onClick={() => onUndoN(5)} disabled={disabled}>
            <span>Undo 5</span>
          </button>
        )}
        {variant === "full" && onUndoN && undoDepth >= 10 && (
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
          <span>{hintThinking ? <HintThinkingLabel /> : "Hint"}</span>
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
