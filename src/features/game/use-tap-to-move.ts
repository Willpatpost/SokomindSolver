import { useCallback, useEffect, useRef } from "react";
import type { Direction, GameSession } from "@/src/core/model";
import { findWalkPath, cellFromBoardClick } from "./tap-pathfinding";

interface UseTapToMoveOptions {
  readonly sessionRef: { readonly current: GameSession };
  readonly enabled: boolean;
  readonly reducedMotion: boolean;
  readonly applyDirection: (direction: Direction) => void;
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

        const movesBefore = sessionRef.current.moves;
        applyDirection(path[index]);
        if (sessionRef.current.moves === movesBefore) {
          walkTimerRef.current = undefined;
          return;
        }

        const next = index + 1;
        if (next >= path.length || sessionRef.current.solved) {
          walkTimerRef.current = undefined;
          return;
        }

        const delay = reducedMotion ? 30 : 80;
        walkTimerRef.current = window.setTimeout(() => advance(next), delay);
      };

      advance(0);
    },
    [applyDirection, cancelWalk, enabled, reducedMotion, sessionRef],
  );

  return { handleBoardClick, cancelWalk };
}
