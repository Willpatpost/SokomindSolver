import { useEffect } from "react";
import type { Direction } from "@/src/core";

const KEY_DIRECTIONS: Readonly<Record<string, Direction>> = {
  ArrowUp: "up",
  w: "up",
  W: "up",
  ArrowDown: "down",
  s: "down",
  S: "down",
  ArrowLeft: "left",
  a: "left",
  A: "left",
  ArrowRight: "right",
  d: "right",
  D: "right",
};

interface GameKeyboardOptions {
  readonly enabled?: boolean;
  readonly onMove: (direction: Direction) => void;
  readonly onUndo: () => void;
  readonly onReset: () => void;
  readonly onHint?: () => void;
  readonly onNextPuzzle?: () => void;
  readonly onPreviousPuzzle?: () => void;
}

export function useGameKeyboard({
  enabled = true,
  onMove,
  onUndo,
  onReset,
  onHint,
  onNextPuzzle,
  onPreviousPuzzle,
}: GameKeyboardOptions) {
  useEffect(() => {
    if (!enabled) return;

    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        target?.closest("input, textarea, select, [contenteditable='true']") ||
        document.querySelector("dialog[open], [role='dialog']")
      ) {
        return;
      }

      const direction = KEY_DIRECTIONS[event.key];
      if (direction) {
        event.preventDefault();
        onMove(direction);
        return;
      }

      if (event.key === "u" || event.key === "U") {
        event.preventDefault();
        onUndo();
      } else if (event.key === "r" || event.key === "R") {
        event.preventDefault();
        onReset();
      } else if ((event.key === "h" || event.key === "H") && onHint) {
        event.preventDefault();
        onHint();
      } else if (event.key === "[" || event.key === "PageUp") {
        event.preventDefault();
        onPreviousPuzzle?.();
      } else if (event.key === "]" || event.key === "PageDown") {
        event.preventDefault();
        onNextPuzzle?.();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, onHint, onMove, onNextPuzzle, onPreviousPuzzle, onReset, onUndo]);
}
