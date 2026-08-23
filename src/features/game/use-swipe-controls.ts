import { useEffect, type RefObject } from "react";
import type { Direction } from "@/src/core";
import { resolveSwipeDirection } from "./swipe-direction";

interface UseSwipeControlsOptions {
  readonly enabled: boolean;
  readonly onSwipe: (direction: Direction) => void;
  readonly threshold?: number;
}

export function useSwipeControls(
  ref: RefObject<HTMLElement | null>,
  options: UseSwipeControlsOptions,
): void {
  const { enabled, onSwipe, threshold = 30 } = options;

  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;

    let startX = 0;
    let startY = 0;
    let tracking = false;

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        tracking = false;
        return;
      }
      const touch = event.touches[0];
      startX = touch.clientX;
      startY = touch.clientY;
      tracking = true;
    };

    const onTouchMove = (event: TouchEvent) => {
      if (!tracking) return;
      if (event.touches.length !== 1) {
        tracking = false;
        return;
      }
      const touch = event.touches[0];
      const dx = Math.abs(touch.clientX - startX);
      const dy = Math.abs(touch.clientY - startY);
      if (dx > 10 || dy > 10) {
        event.preventDefault();
      }
    };

    const onTouchEnd = (event: TouchEvent) => {
      if (!tracking) return;
      tracking = false;
      const touch = event.changedTouches[0];
      if (!touch) return;
      const direction = resolveSwipeDirection(
        touch.clientX - startX,
        touch.clientY - startY,
        threshold,
      );
      if (direction) onSwipe(direction);
    };

    const onTouchCancel = () => {
      tracking = false;
    };

    element.addEventListener("touchstart", onTouchStart, { passive: true });
    element.addEventListener("touchmove", onTouchMove, { passive: false });
    element.addEventListener("touchend", onTouchEnd, { passive: true });
    element.addEventListener("touchcancel", onTouchCancel, { passive: true });

    return () => {
      element.removeEventListener("touchstart", onTouchStart);
      element.removeEventListener("touchmove", onTouchMove);
      element.removeEventListener("touchend", onTouchEnd);
      element.removeEventListener("touchcancel", onTouchCancel);
    };
  }, [ref, enabled, onSwipe, threshold]);
}
