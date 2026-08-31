import type { PuzzleMetadata } from "../../catalog/puzzle-metadata.ts";
import type { ProgressData } from "../../shared/progress.ts";

export interface JourneyChapter {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly concept: string;
  readonly explanation: string;
  readonly prerequisiteChapterIds: readonly string[];
  readonly puzzleIds: readonly string[];
}

export interface JourneyChapterProgress extends JourneyChapter {
  readonly solved: number;
  readonly total: number;
  readonly complete: boolean;
  readonly prerequisitesMet: boolean;
}

export interface JourneyRecommendation {
  readonly puzzleId: string;
  readonly chapterId: string;
  readonly chapterTitle: string;
  readonly concept: string;
  readonly reason: string;
}

export const GUIDED_JOURNEY_CHAPTERS: readonly JourneyChapter[] = Object.freeze([
  Object.freeze({
    id: "push-fundamentals",
    number: 1,
    title: "Push fundamentals",
    concept: "Position before pressure",
    explanation: "Learn to approach a box from the useful side and keep a route behind it before committing to a push.",
    prerequisiteChapterIds: Object.freeze([]),
    puzzleIds: Object.freeze(["ultra-tiny", "tutorial-push", "tiny", "tutorial-around"]),
  }),
  Object.freeze({
    id: "space-and-corners",
    number: 2,
    title: "Space and corners",
    concept: "Protect escape routes",
    explanation: "Read corners, walls, and turning space early so a harmless-looking push does not become permanent.",
    prerequisiteChapterIds: Object.freeze(["push-fundamentals"]),
    puzzleIds: Object.freeze(["beginner-detour", "box-5x5-a", "beginner-three", "beginner-typed-line"]),
  }),
  Object.freeze({
    id: "routes-and-order",
    number: 3,
    title: "Routes and order",
    concept: "Sequence the work",
    explanation: "Coordinate several boxes by opening traffic lanes and solving goals in an order that preserves access.",
    prerequisiteChapterIds: Object.freeze(["space-and-corners"]),
    puzzleIds: Object.freeze(["workshop-1", "classic-1", "theme-kitchen", "garden-2"]),
  }),
  Object.freeze({
    id: "constraint-control",
    number: 4,
    title: "Constraint control",
    concept: "Create room before spending it",
    explanation: "Use staging squares, rotations, and temporary displacement to manage tighter boards without sealing a lane.",
    prerequisiteChapterIds: Object.freeze(["routes-and-order"]),
    puzzleIds: Object.freeze(["medium", "large", "adv-gallery", "theme-parking"]),
  }),
  Object.freeze({
    id: "search-frontiers",
    number: 5,
    title: "Search frontiers",
    concept: "Compare plans, not just pushes",
    explanation: "Tackle branching positions where progress comes from evaluating alternatives and recognizing future deadlocks.",
    prerequisiteChapterIds: Object.freeze(["constraint-control"]),
    puzzleIds: Object.freeze(["open-field", "expert-maze", "huge"]),
  }),
]);

function knownChapterPuzzleIds(
  chapter: JourneyChapter,
  knownPuzzleIds: ReadonlySet<string>,
): readonly string[] {
  return chapter.puzzleIds.filter((puzzleId) => knownPuzzleIds.has(puzzleId));
}

export function getJourneyChapterProgress(
  progress: ProgressData,
  puzzles: readonly Pick<PuzzleMetadata, "id">[],
  chapters: readonly JourneyChapter[] = GUIDED_JOURNEY_CHAPTERS,
): readonly JourneyChapterProgress[] {
  const knownPuzzleIds = new Set(puzzles.map(({ id }) => id));
  const completedChapterIds = new Set<string>();

  return chapters.map((chapter) => {
    const puzzleIds = knownChapterPuzzleIds(chapter, knownPuzzleIds);
    const solved = puzzleIds.filter((puzzleId) => progress.completed[puzzleId]).length;
    const complete = puzzleIds.length > 0 && solved === puzzleIds.length;
    const prerequisitesMet = chapter.prerequisiteChapterIds.every((chapterId) =>
      completedChapterIds.has(chapterId));
    if (complete) completedChapterIds.add(chapter.id);
    return Object.freeze({
      ...chapter,
      puzzleIds,
      solved,
      total: puzzleIds.length,
      complete,
      prerequisitesMet,
    });
  });
}

export function getJourneyRecommendation(
  progress: ProgressData,
  puzzles: readonly PuzzleMetadata[],
  chapters: readonly JourneyChapter[] = GUIDED_JOURNEY_CHAPTERS,
): JourneyRecommendation | null {
  const metadataById = new Map(puzzles.map((puzzle) => [puzzle.id, puzzle] as const));
  const chapterProgress = getJourneyChapterProgress(progress, puzzles, chapters);

  for (const chapter of chapterProgress) {
    const puzzleId = chapter.puzzleIds.find((id) => !progress.completed[id]);
    if (!puzzleId) continue;
    const puzzle = metadataById.get(puzzleId);
    if (!puzzle) continue;
    const position = chapter.puzzleIds.indexOf(puzzleId) + 1;
    const reason = chapter.prerequisitesMet
      ? `${puzzle.title} is the next unsolved room in ${chapter.title} (${position} of ${chapter.total}). It practices ${chapter.concept.toLowerCase()}.`
      : `${puzzle.title} fills an earlier foundation in ${chapter.title}. You may still play any later room at any time.`;
    return Object.freeze({
      puzzleId,
      chapterId: chapter.id,
      chapterTitle: chapter.title,
      concept: chapter.concept,
      reason,
    });
  }

  return null;
}
