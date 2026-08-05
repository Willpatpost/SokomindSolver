import type { PuzzleRecord } from "@/src/shared/progress";
import { Modal } from "@/src/shared/ui/Modal";
import { formatTime } from "./timer-math";
import styles from "./CompletionDialog.module.css";

interface CompletionDialogProps {
  readonly open: boolean;
  readonly title: string;
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
}

function bestMessage(
  previous: PuzzleRecord | undefined,
  moves: number,
  newBest: boolean,
): string {
  if (!newBest) return "Your existing personal best still stands.";
  if (!previous) return "First clear saved as your personal best.";
  return `New personal best — ${previous.moves - moves} fewer moves.`;
}

export function CompletionDialog({
  open,
  title,
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
}: CompletionDialogProps) {
  return (
    <Modal
      className={styles.modal}
      describedBy="completion-best"
      labelledBy="completion-title"
      onClose={onClose}
      open={open}
    >
      <section className={styles.completion}>
        <div className={styles.badge} aria-hidden="true">✓</div>
        <p className={styles.eyebrow}>Room cleared</p>
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
      </section>
    </Modal>
  );
}
