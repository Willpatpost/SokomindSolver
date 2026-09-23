import { useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";

interface ZoomTransform {
  readonly scale: number;
  readonly translateX: number;
  readonly translateY: number;
}

const IDENTITY: ZoomTransform = Object.freeze({
  scale: 1,
  translateX: 0,
  translateY: 0,
});

const MIN_SCALE = 1;
const MAX_SCALE = 3;
// Scales at or below this count as unzoomed and snap back when a gesture ends.
const ZOOM_THRESHOLD = 1.05;
/** Two single-finger touches this close together reset the zoom. */
export const DOUBLE_TAP_WINDOW_MS = 300;

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

function isZoomed(transform: ZoomTransform): boolean {
  return transform.scale > ZOOM_THRESHOLD;
}

function applyTransform(layer: HTMLElement | null, transform: ZoomTransform): void {
  if (!layer) return;
  if (isZoomed(transform)) {
    layer.style.transform =
      `translate(${transform.translateX}px, ${transform.translateY}px) scale(${transform.scale})`;
    layer.style.transformOrigin = "center center";
  } else {
    layer.style.removeProperty("transform");
    layer.style.removeProperty("transform-origin");
  }
}

interface PinchZoomOptions {
  /** Called after a double tap resets the zoom. */
  readonly onDoubleTapReset?: () => void;
}

/**
 * Pinch-to-zoom and one-finger pan on `ref`, shown as a transform on
 * `layerRef`. Gesture frames write the transform to the layer directly, so
 * the page re-renders only when the board enters or leaves zoom. Returns
 * whether the board is zoomed.
 */
export function usePinchZoom(
  ref: RefObject<HTMLElement | null>,
  layerRef: RefObject<HTMLElement | null>,
  { onDoubleTapReset }: PinchZoomOptions = {},
): boolean {
  const [zoomed, setZoomed] = useState(false);
  const transformRef = useRef<ZoomTransform>(IDENTITY);
  const zoomedRef = useRef(false);
  const gestureRef = useRef<{
    startDistance: number;
    startScale: number;
    startX: number;
    startY: number;
    startTx: number;
    startTy: number;
  } | null>(null);
  const lastTapRef = useRef(0);
  const emitDoubleTapReset = useEffectEvent(() => onDoubleTapReset?.());

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const commit = (next: ZoomTransform) => {
      transformRef.current = next;
      applyTransform(layerRef.current, next);
      const nextZoomed = isZoomed(next);
      if (zoomedRef.current !== nextZoomed) {
        zoomedRef.current = nextZoomed;
        setZoomed(nextZoomed);
      }
    };

    const onTouchStart = (e: TouchEvent) => {
      const current = transformRef.current;
      if (e.touches.length === 2) {
        e.preventDefault();
        const a = e.touches[0];
        const b = e.touches[1];
        gestureRef.current = {
          startDistance: pinchDistance(a, b),
          startScale: current.scale,
          startX: (a.clientX + b.clientX) / 2,
          startY: (a.clientY + b.clientY) / 2,
          startTx: current.translateX,
          startTy: current.translateY,
        };
      } else if (e.touches.length === 1) {
        const now = Date.now();
        const doubleTap =
          now - lastTapRef.current < DOUBLE_TAP_WINDOW_MS && isZoomed(current);
        lastTapRef.current = now;
        if (doubleTap) {
          e.preventDefault();
          gestureRef.current = null;
          commit(IDENTITY);
          emitDoubleTapReset();
          return;
        }

        if (isZoomed(current)) {
          gestureRef.current = {
            startDistance: 0,
            startScale: current.scale,
            startX: e.touches[0].clientX,
            startY: e.touches[0].clientY,
            startTx: current.translateX,
            startTy: current.translateY,
          };
        }
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      const gesture = gestureRef.current;
      if (!gesture) return;

      const rect = el.getBoundingClientRect();

      if (e.touches.length === 2 && gesture.startDistance > 0) {
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

        commit({
          scale: newScale,
          translateX: clampTranslation(gesture.startTx + panX, rect.width, newScale),
          translateY: clampTranslation(gesture.startTy + panY, rect.height, newScale),
        });
      } else if (
        e.touches.length === 1 &&
        gesture.startDistance === 0 &&
        isZoomed(transformRef.current)
      ) {
        e.preventDefault();
        const { scale } = transformRef.current;
        const touch = e.touches[0];
        const panX = touch.clientX - gesture.startX;
        const panY = touch.clientY - gesture.startY;

        commit({
          scale,
          translateX: clampTranslation(gesture.startTx + panX, rect.width, scale),
          translateY: clampTranslation(gesture.startTy + panY, rect.height, scale),
        });
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
        if (!isZoomed(transformRef.current)) commit(IDENTITY);
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
  }, [ref, layerRef]);

  return zoomed;
}
