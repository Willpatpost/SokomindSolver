import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export interface ZoomState {
  readonly scale: number;
  readonly translateX: number;
  readonly translateY: number;
  readonly zoomed: boolean;
}

const IDENTITY: ZoomState = Object.freeze({
  scale: 1,
  translateX: 0,
  translateY: 0,
  zoomed: false,
});

const MIN_SCALE = 1;
const MAX_SCALE = 3;

function clampTranslation(
  translate: number,
  dimension: number,
  scale: number,
): number {
  const overflow = (dimension * (scale - 1)) / 2;
  return Math.max(-overflow, Math.min(overflow, translate));
}

function pinchDistance(a: Touch, b: Touch): number {
  const dx = a.clientX - b.clientX;
  const dy = a.clientY - b.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

export function usePinchZoom(ref: RefObject<HTMLElement | null>): ZoomState {
  const [zoom, setZoom] = useState<ZoomState>(IDENTITY);
  const gestureRef = useRef<{
    startDistance: number;
    startScale: number;
    startX: number;
    startY: number;
    startTx: number;
    startTy: number;
  } | null>(null);
  const lastTapRef = useRef(0);

  const resetZoom = useCallback(() => setZoom(IDENTITY), []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const a = e.touches[0];
        const b = e.touches[1];
        gestureRef.current = {
          startDistance: pinchDistance(a, b),
          startScale: zoom.scale,
          startX: (a.clientX + b.clientX) / 2,
          startY: (a.clientY + b.clientY) / 2,
          startTx: zoom.translateX,
          startTy: zoom.translateY,
        };
      } else if (e.touches.length === 1) {
        const now = Date.now();
        if (now - lastTapRef.current < 300 && zoom.zoomed) {
          e.preventDefault();
          resetZoom();
        }
        lastTapRef.current = now;

        if (zoom.zoomed) {
          gestureRef.current = {
            startDistance: 0,
            startScale: zoom.scale,
            startX: e.touches[0].clientX,
            startY: e.touches[0].clientY,
            startTx: zoom.translateX,
            startTy: zoom.translateY,
          };
        }
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      const gesture = gestureRef.current;
      if (!gesture) return;

      const rect = el.getBoundingClientRect();

      if (e.touches.length === 2) {
        e.preventDefault();
        const a = e.touches[0];
        const b = e.touches[1];
        const currentDistance = pinchDistance(a, b);
        const ratio = currentDistance / gesture.startDistance;
        const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, gesture.startScale * ratio));

        const midX = (a.clientX + b.clientX) / 2;
        const midY = (a.clientY + b.clientY) / 2;
        const panX = midX - gesture.startX;
        const panY = midY - gesture.startY;

        setZoom({
          scale: newScale,
          translateX: clampTranslation(gesture.startTx + panX, rect.width, newScale),
          translateY: clampTranslation(gesture.startTy + panY, rect.height, newScale),
          zoomed: newScale > 1.05,
        });
      } else if (e.touches.length === 1 && zoom.zoomed && gesture.startDistance === 0) {
        e.preventDefault();
        const touch = e.touches[0];
        const panX = touch.clientX - gesture.startX;
        const panY = touch.clientY - gesture.startY;

        setZoom((prev) => ({
          ...prev,
          translateX: clampTranslation(gesture.startTx + panX, rect.width, prev.scale),
          translateY: clampTranslation(gesture.startTy + panY, rect.height, prev.scale),
        }));
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) {
        if (gestureRef.current && gestureRef.current.startDistance > 0) {
          gestureRef.current = null;
        }
      }
      if (e.touches.length === 0) {
        gestureRef.current = null;
        setZoom((prev) =>
          prev.scale <= 1.05
            ? IDENTITY
            : prev,
        );
      }
    };

    el.addEventListener("touchstart", onTouchStart, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchEnd, { passive: true });

    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [ref, zoom.scale, zoom.translateX, zoom.translateY, zoom.zoomed, resetZoom]);

  return zoom;
}
