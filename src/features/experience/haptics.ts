type HapticEvent = "move" | "push" | "goal" | "goal-leave" | "blocked" | "solved";

export function triggerHaptic(kind: HapticEvent): void {
  if (typeof navigator === "undefined" || !navigator.vibrate) return;

  switch (kind) {
    case "push":
    case "goal":
    case "goal-leave":
      navigator.vibrate(10);
      break;
    case "blocked":
      navigator.vibrate([8, 40, 8]);
      break;
    case "solved":
      navigator.vibrate([12, 60, 12, 60, 12]);
      break;
  }
}
