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
  readonly onNextUnsolved?: () => void;
  readonly onShowShortcuts?: () => void;
  readonly onPause?: () => void;
  readonly onToggleFavorite?: () => void;
  readonly onToggleZen?: () => void;
}

export function useGameKeyboard({
  enabled = true,
  onMove,
  onUndo,
  onReset,
  onHint,
  onNextPuzzle,
  onPreviousPuzzle,
  onNextUnsolved,
  onShowShortcuts,
  onPause,
  onToggleFavorite,
  onToggleZen,
}: GameKeyboardOptions) {
  useEffect(() => {
    if (!enabled) return;

    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (event.defaultPrevented) return;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (document.querySelector("dialog[open], [role='dialog']")) return;

      if ((event.ctrlKey || event.metaKey) && event.key === "z") {
        event.preventDefault();
        onUndo();
        return;
      }

      if (event.altKey || event.ctrlKey || event.metaKey) return;

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
      } else if (event.key === "?") {
        event.preventDefault();
        onShowShortcuts?.();
      } else if ((event.key === "p" || event.key === "P") && onPause) {
        event.preventDefault();
        onPause();
      } else if ((event.key === "n" || event.key === "N") && onNextUnsolved) {
        event.preventDefault();
        onNextUnsolved();
      } else if ((event.key === "f" || event.key === "F") && !event.shiftKey && onToggleFavorite) {
        event.preventDefault();
        onToggleFavorite();
      } else if ((event.key === "z" || event.key === "Z") && !event.shiftKey && onToggleZen) {
        event.preventDefault();
        onToggleZen();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, onHint, onMove, onNextPuzzle, onNextUnsolved, onPause, onPreviousPuzzle, onReset, onShowShortcuts, onToggleFavorite, onToggleZen, onUndo]);
}
