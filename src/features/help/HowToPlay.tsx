import { Modal } from "@/src/shared/ui/Modal";
import styles from "./HowToPlay.module.css";

interface HowToPlayProps {
  open: boolean;
  onClose: () => void;
}

export function HowToPlay({ open, onClose }: HowToPlayProps) {
  return (
    <Modal
      className={styles.modal}
      labelledBy="how-to-play-title"
      mobileSheet
      onClose={onClose}
      open={open}
    >
      <section className={styles.sheet}>
        <div className={styles.heading}>
          <div>
            <p>Field notes</p>
            <h2 id="how-to-play-title">How to play</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close instructions"
            data-autofocus
          >
            Close
          </button>
        </div>

        <p className={styles.intro}>
          Move the keeper through the room and push every box onto its matching
          goal. The hard part is preserving enough space to stand behind the
          next push.
        </p>

        <div className={styles.rules}>
          <article>
            <span className={styles.ruleNumber}>01</span>
            <div>
              <h3>Push, never pull</h3>
              <p>
                Walk with the arrow keys or W A S D. Step into a box to push it
                one square when the space beyond is clear.
              </p>
            </div>
          </article>
          <article>
            <span className={styles.ruleNumber}>02</span>
            <div>
              <h3>Match the marks</h3>
              <p>
                Plain boxes belong on round goals. Lettered boxes must finish
                on the goal carrying the same letter.
              </p>
            </div>
          </article>
          <article>
            <span className={styles.ruleNumber}>03</span>
            <div>
              <h3>Protect your options</h3>
              <p>
                Corners and narrow walls are final. Use undo freely and reset a
                room whenever you want a clean plan.
              </p>
            </div>
          </article>
          <article>
            <span className={styles.ruleNumber}>04</span>
            <div>
              <h3>Set the atmosphere</h3>
              <p>
                Use the sound controls in the header to enable effects, the
                procedural soundtrack, or reduced motion. Your choices stay on
                this device.
              </p>
            </div>
          </article>
        </div>

        <div className={styles.shortcuts}>
          <span><kbd>↑ ↓ ← →</kbd> Move</span>
          <span><kbd>W A S D</kbd> Move</span>
          <span><kbd>U</kbd> Undo</span>
          <span><kbd>H</kbd> Hint</span>
          <span><kbd>R</kbd> Reset</span>
          <span><kbd>[ ]</kbd> Prev / Next puzzle</span>
        </div>

        <button className={styles.primary} type="button" onClick={onClose}>
          Return to the room
        </button>
      </section>
    </Modal>
  );
}
