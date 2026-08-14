import { useCallback, useMemo, useState } from "react";
import type { PuzzleRecord } from "@/src/shared/progress";
import {
  loadRatings,
  saveRating,
  type DifficultyRating,
} from "@/src/shared/puzzle-ratings";
import { PUZZLE_METADATA } from "@/src/catalog/puzzle-metadata";
import { PuzzleMinimap } from "@/src/features/selector/PuzzleMinimap";
import { Modal } from "@/src/shared/ui/Modal";
import { formatTime } from "./timer-math";
import styles from "./CompletionDialog.module.css";

interface CompletionDialogProps {
  readonly open: boolean;
  readonly puzzleId: string;
  readonly title: string;
  readonly boxes: number;
  readonly moves: number;
  readonly pushes: number;
  readonly elapsedTime?: number;
  readonly previousBest?: PuzzleRecord;
  readonly newBest: boolean;
  readonly isOptimalSolution?: boolean;
  readonly nextLabel: string;
  readonly onClose: () => void;
  readonly onReplay?: () => void;
  readonly onNext: () => void;
  readonly onNextUnsolved?: () => void;
}

function bestMessage(
  previous: PuzzleRecord | undefined,
  moves: number,
  newBest: boolean,
): string {
  if (!newBest && previous) {
    const diff = moves - previous.moves;
    if (diff === 0) return "Matched your personal best exactly.";
    return `Your best is ${previous.moves} moves — this attempt used ${diff} more.`;
  }
  if (!previous) return "First clear saved as your personal best.";
  return `New personal best — ${previous.moves - moves} fewer moves.`;
}

function buildShareText(
  title: string,
  moves: number,
  pushes: number,
  elapsedTime: number,
  isOptimal: boolean,
): string {
  const lines = [
    `Sokomind — ${title}`,
    `${moves} moves / ${pushes} pushes`,
  ];
  if (elapsedTime > 0) lines.push(formatTime(elapsedTime));
  if (isOptimal) lines.push("★ Optimal");
  return lines.join("\n");
}

interface EfficiencyGrade {
  readonly letter: string;
  readonly label: string;
  readonly color: string;
}

function efficiencyGrade(moves: number, pushes: number, boxes: number): EfficiencyGrade {
  const pushesPerBox = pushes / Math.max(boxes, 1);
  const ratio = pushes / Math.max(moves, 1);

  if (pushesPerBox <= 2 && ratio >= 0.7) return { letter: "S", label: "Masterful", color: "var(--amber-500)" };
  if (pushesPerBox <= 3 && ratio >= 0.5) return { letter: "A", label: "Excellent", color: "hsl(145 50% 45%)" };
  if (pushesPerBox <= 5 && ratio >= 0.35) return { letter: "B", label: "Solid", color: "var(--blue-500)" };
  if (ratio >= 0.25) return { letter: "C", label: "Fair", color: "var(--sage-600)" };
  return { letter: "D", label: "Exploratory", color: "var(--ink-muted)" };
}

const DIFFICULTY_COLORS: Record<string, string> = {
  tutorial: "var(--sage-500)",
  beginner: "var(--sage-600)",
  intermediate: "var(--blue-500)",
  advanced: "var(--amber-500)",
  expert: "var(--coral-500)",
  master: "var(--ink-700)",
};

const RATING_OPTIONS: ReadonlyArray<{ value: DifficultyRating; label: string }> = [
  { value: "easy", label: "Too easy" },
  { value: "right", label: "Just right" },
  { value: "hard", label: "Too hard" },
];

export function CompletionDialog({
  open,
  puzzleId,
  title,
  boxes,
  moves,
  pushes,
  elapsedTime = 0,
  previousBest,
  newBest,
  isOptimalSolution = false,
  nextLabel,
  onClose,
  onReplay,
  onNext,
  onNextUnsolved,
}: CompletionDialogProps) {
  const [copied, setCopied] = useState(false);
  const existingRating = useMemo(() => loadRatings()[puzzleId], [puzzleId]);
  const [selectedRating, setSelectedRating] = useState<DifficultyRating | undefined>(existingRating);

  const handleRate = useCallback((rating: DifficultyRating) => {
    setSelectedRating(rating);
    saveRating(puzzleId, rating);
  }, [puzzleId]);

  const ratingSummary = useMemo(() => {
    if (!selectedRating) return null;
    const allRatings = loadRatings();
    const meta = PUZZLE_METADATA.find((p) => p.id === puzzleId);
    if (!meta) return null;
    const sameTier = PUZZLE_METADATA.filter((p) => p.difficulty === meta.difficulty);
    const counts = { easy: 0, right: 0, hard: 0, total: 0 };
    for (const p of sameTier) {
      const r = allRatings[p.id];
      if (r) {
        counts[r]++;
        counts.total++;
      }
    }
    if (counts.total < 2) return null;
    return counts;
  }, [selectedRating, puzzleId]);

  const handleShareResult = useCallback(async () => {
    const text = buildShareText(title, moves, pushes, elapsedTime, isOptimalSolution);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may not be available
    }
  }, [title, moves, pushes, elapsedTime, isOptimalSolution]);

  const grade = efficiencyGrade(moves, pushes, boxes);
  const puzzleMeta = useMemo(
    () => PUZZLE_METADATA.find((p) => p.id === puzzleId),
    [puzzleId],
  );
  const difficultyLabel = puzzleMeta
    ? puzzleMeta.difficulty.charAt(0).toUpperCase() + puzzleMeta.difficulty.slice(1)
    : undefined;

  return (
    <Modal
      className={styles.modal}
      describedBy="completion-best"
      labelledBy="completion-title"
      onClose={onClose}
      open={open}
    >
      <section className={styles.completion}>
        <div className={styles.badgeRow}>
          <div className={styles.badge} aria-hidden="true">✓</div>
          {puzzleMeta && (
            <div className={styles.minimapWrap}>
              <PuzzleMinimap
                width={puzzleMeta.width}
                height={puzzleMeta.height}
                boxes={puzzleMeta.boxes}
                puzzleId={puzzleId}
              />
            </div>
          )}
        </div>
        <p className={styles.eyebrow}>
          Room cleared
          {difficultyLabel && (
            <span
              className={styles.difficultyBadge}
              style={{ background: DIFFICULTY_COLORS[puzzleMeta!.difficulty] }}
            >
              {difficultyLabel}
            </span>
          )}
        </p>
        <h2 id="completion-title">{title}</h2>
        <p className={styles.bestMessage} id="completion-best">
          {bestMessage(previousBest, moves, newBest)}
        </p>
        {isOptimalSolution ? (
          <p className={styles.optimalNote}>★ Optimal solution</p>
        ) : null}
        <div className={styles.stats}>
          <span><strong>{moves}</strong> {moves === 1 ? "Move" : "Moves"}</span>
          <span><strong>{pushes}</strong> {pushes === 1 ? "Push" : "Pushes"}</span>
          {elapsedTime > 0 ? (
            <span><strong>{formatTime(elapsedTime)}</strong> Time</span>
          ) : null}
        </div>
        <div className={styles.ratingRow}>
          <span className={styles.gradeLetter} style={{ color: grade.color }}>{grade.letter}</span>
          <span className={styles.ratingValue}>{grade.label}</span>
        </div>
        <div className={styles.difficultyFeedback}>
          <span className={styles.feedbackLabel}>How was the difficulty?</span>
          <div className={styles.feedbackButtons} role="group" aria-label="Rate this puzzle's difficulty">
            {RATING_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={styles.feedbackButton}
                data-selected={selectedRating === opt.value || undefined}
                aria-pressed={selectedRating === opt.value}
                onClick={() => handleRate(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {ratingSummary && (
            <div className={styles.ratingSummary}>
              <span className={styles.ratingSummaryLabel}>
                Your {ratingSummary.total} ratings at this tier:
              </span>
              <div className={styles.ratingBar}>
                {ratingSummary.easy > 0 && (
                  <span
                    className={styles.ratingSegment}
                    data-kind="easy"
                    style={{ flex: ratingSummary.easy }}
                    title={`${ratingSummary.easy} easy`}
                  />
                )}
                {ratingSummary.right > 0 && (
                  <span
                    className={styles.ratingSegment}
                    data-kind="right"
                    style={{ flex: ratingSummary.right }}
                    title={`${ratingSummary.right} right`}
                  />
                )}
                {ratingSummary.hard > 0 && (
                  <span
                    className={styles.ratingSegment}
                    data-kind="hard"
                    style={{ flex: ratingSummary.hard }}
                    title={`${ratingSummary.hard} hard`}
                  />
                )}
              </div>
              <div className={styles.ratingCounts}>
                <span>{ratingSummary.easy} easy</span>
                <span>{ratingSummary.right} right</span>
                <span>{ratingSummary.hard} hard</span>
              </div>
            </div>
          )}
        </div>
        <div className={styles.actions} data-has-replay={onReplay ? "" : undefined}>
          <button type="button" data-autofocus onClick={onClose}>
            Study board
          </button>
          {onReplay ? (
            <button type="button" accessKey="p" onClick={onReplay}>
              Replay
            </button>
          ) : null}
          <button type="button" onClick={onNext}>
            {nextLabel}
          </button>
        </div>
        {onNextUnsolved ? (
          <button
            type="button"
            className={styles.nextUnsolved}
            onClick={onNextUnsolved}
          >
            Skip to next unsolved &#8250;
          </button>
        ) : null}
        <button
          type="button"
          className={styles.shareResult}
          onClick={() => void handleShareResult()}
        >
          {copied ? "Copied!" : "Copy result"}
        </button>
      </section>
    </Modal>
  );
}
