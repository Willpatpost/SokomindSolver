import type { Direction } from "@/src/core";

export function resolveSwipeDirection(
  deltaX: number,
  deltaY: number,
  threshold: number,
): Direction | null {
  const absX = Math.abs(deltaX);
  const absY = Math.abs(deltaY);
  if (Math.max(absX, absY) < threshold) return null;

  if (absX >= absY) {
    return deltaX > 0 ? "right" : "left";
  }
  return deltaY > 0 ? "down" : "up";
}
