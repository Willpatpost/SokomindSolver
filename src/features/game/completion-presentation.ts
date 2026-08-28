import type { PuzzleRecord } from "@/src/shared/progress";

export type CompletionMilestoneKind =
  | "optimal-clear"
  | "collection-complete"
  | "first-clear"
  | "move-best"
  | "push-improvement";

export type CompletionCelebration = "default" | "personal-best" | "optimal";

export interface CompletionMilestone {
  readonly kind: CompletionMilestoneKind;
  readonly label: string;
  readonly detail: string;
}

export interface CompletionPresentation {
  readonly eyebrow: string;
  readonly summary: string;
  readonly celebration: CompletionCelebration;
  readonly isOptimal: boolean;
  readonly movesDelta?: number;
  readonly pushesDelta?: number;
  readonly milestones: readonly CompletionMilestone[];
}

export interface CompletionPresentationInput {
  readonly moves: number;
  readonly pushes: number;
  readonly previousBest?: PuzzleRecord;
  readonly isOptimal?: boolean;
  /** Set only when this clear crossed the final unsolved collection item. */
  readonly completedCollection?: string;
}

function countDifference(value: number, singular: string): string {
  return `${value} ${singular}${value === 1 ? "" : "s"}`;
}

function routeSummary(
  previousBest: PuzzleRecord | undefined,
  moves: number,
): string {
  if (!previousBest) return "First clear saved as your personal best.";
  const movesDelta = moves - previousBest.moves;
  if (movesDelta < 0) {
    return `New personal best — ${countDifference(-movesDelta, "move")} fewer.`;
  }
  if (movesDelta === 0) return "Matched your personal best exactly.";
  return `Personal best: ${previousBest.moves} moves. This route used ${countDifference(movesDelta, "move")} more.`;
}

/** Build an accurate, presentation-only summary for a completed route. */
export function createCompletionPresentation({
  moves,
  pushes,
  previousBest,
  isOptimal = false,
  completedCollection,
}: CompletionPresentationInput): CompletionPresentation {
  const movesDelta = previousBest ? moves - previousBest.moves : undefined;
  const pushesDelta = previousBest ? pushes - previousBest.pushes : undefined;
  const milestones: CompletionMilestone[] = [];

  if (isOptimal) {
    milestones.push({
      kind: "optimal-clear",
      label: "Verified optimum",
      detail: `Matched the known optimum in ${countDifference(moves, "move")}.`,
    });
  }

  if (completedCollection) {
    milestones.push({
      kind: "collection-complete",
      label: "Collection complete",
      detail: `Cleared every room in ${completedCollection}.`,
    });
  }

  if (!previousBest) {
    milestones.push({
      kind: "first-clear",
      label: "First clear",
      detail: "A personal-best route is now on record.",
    });
  } else if (movesDelta !== undefined && movesDelta < 0) {
    milestones.push({
      kind: "move-best",
      label: "Move record",
      detail: `${countDifference(-movesDelta, "move")} fewer than your previous best.`,
    });
  }

  // Progress currently retains the fewest-move route. Only call this a saved
  // push improvement when the new route is also eligible for persistence.
  if (
    movesDelta !== undefined &&
    movesDelta < 0 &&
    pushesDelta !== undefined &&
    pushesDelta < 0
  ) {
    milestones.push({
      kind: "push-improvement",
      label: "Push improvement",
      detail: `${countDifference(-pushesDelta, "push")} fewer than your previous saved route.`,
    });
  }

  const celebration: CompletionCelebration = isOptimal
    ? "optimal"
    : milestones.length > 0
      ? "personal-best"
      : "default";
  const eyebrow = isOptimal
    ? "Optimal solution"
    : completedCollection
      ? "Collection complete"
      : milestones.length > 0
        ? "Personal milestone"
        : "Room cleared";

  return Object.freeze({
    eyebrow,
    summary: routeSummary(previousBest, moves),
    celebration,
    isOptimal,
    movesDelta,
    pushesDelta,
    milestones: Object.freeze(milestones),
  });
}
