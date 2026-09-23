import { useCallback, useEffect, useRef } from "react";
import type { Direction, GameSession } from "@/src/core/model";
import { findWalkPath, cellFromBoardClick } from "./tap-pathfinding";

interface UseTapToMoveOptions {
  readonly sessionRef: { readonly current: GameSession };
  readonly enabled: boolean;
  readonly reducedMotion: boolean;
  /** Returns whether the keeper moved. */
  readonly applyDirection: (direction: Direction) => boolean;
}

export function useTapToMove({
  sessionRef,
  enabled,
  reducedMotion,
  applyDirection,
}: UseTapToMoveOptions) {
  const walkTokenRef = useRef(0);
  const walkTimerRef = useRef<number | undefined>(undefined);

  const cancelWalk = useCallback(() => {
    walkTokenRef.current += 1;
    if (walkTimerRef.current !== undefined) {
      window.clearTimeout(walkTimerRef.current);
      walkTimerRef.current = undefined;
    }
  }, []);

  useEffect(() => () => cancelWalk(), [cancelWalk]);

  // Each step uses the latest mover, so a walk sees input being disabled
  // (a dialog opening, a solve) instead of the one captured at click time.
  const applyDirectionRef = useRef(applyDirection);
  useEffect(() => {
    applyDirectionRef.current = applyDirection;
  }, [applyDirection]);

  useEffect(() => {
    if (!enabled) cancelWalk();
  }, [cancelWalk, enabled]);

  const handleBoardClick = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      if (!enabled) return;

      const target = event.target as HTMLElement;
      if (target.closest("button, a, [role='button']")) return;

      const boardElement = (event.currentTarget as HTMLElement).querySelector<HTMLElement>(
        "[data-testid='game-board']",
      );
      if (!boardElement) return;

      const session = sessionRef.current;
      if (session.solved) return;

      const cell = cellFromBoardClick(
        event,
        boardElement,
        session.board.width,
        session.board.height,
      );
      if (!cell) return;

      const path = findWalkPath(session, cell);
      if (!path || path.length === 0) return;

      cancelWalk();
      const token = ++walkTokenRef.current;

      const advance = (index: number) => {
        if (walkTokenRef.current !== token) return;
        if (index >= path.length) {
          walkTimerRef.current = undefined;
          return;
        }

        // The session ref only catches up after React re-renders, so the
        // mover's own result decides whether the walk continues.
        if (!applyDirectionRef.current(path[index])) {
          walkTimerRef.current = undefined;
          return;
        }

        const next = index + 1;
        if (next >= path.length) {
          walkTimerRef.current = undefined;
          return;
        }

        const delay = reducedMotion ? 30 : 80;
        walkTimerRef.current = window.setTimeout(() => advance(next), delay);
      };

      advance(0);
    },
    [cancelWalk, enabled, reducedMotion, sessionRef],
  );

  return { handleBoardClick, cancelWalk };
}
