import { useId } from "react";
import { Modal } from "./Modal";
import styles from "./DeadlockDialog.module.css";

interface DeadlockDialogProps {
  readonly open: boolean;
  readonly onUndo: () => void;
  readonly onRestart: () => void;
  readonly onDismiss: () => void;
}

export function DeadlockDialog({
  open,
  onUndo,
  onRestart,
  onDismiss,
}: DeadlockDialogProps) {
  const titleId = useId();
  const messageId = useId();

  return (
    <Modal
      className={styles.modal}
      describedBy={messageId}
      labelledBy={titleId}
      onClose={onDismiss}
      open={open}
    >
      <section className={styles.card}>
        <p className={styles.eyebrow}>Deadlock detected</p>
        <h2 id={titleId}>Puzzle unsolvable</h2>
        <p className={styles.message} id={messageId}>
          A box is permanently stuck and cannot reach its goal. The puzzle
          cannot be solved from this position.
        </p>
        <div className={styles.actions}>
          <button type="button" onClick={onDismiss}>
            Keep playing
          </button>
          <button type="button" onClick={onRestart}>
            Restart room
          </button>
          <button type="button" data-autofocus onClick={onUndo}>
            Undo last move
          </button>
        </div>
      </section>
    </Modal>
  );
}
