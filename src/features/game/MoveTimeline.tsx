import { memo } from "react";
import styles from "./MoveTimeline.module.css";

interface MoveTimelineProps {
  readonly actionLog: string;
  readonly moves: number;
  readonly pushes: number;
}

export const MoveTimeline = memo(function MoveTimeline({
  moves,
  pushes,
}: MoveTimelineProps) {
  if (moves === 0) return null;

  const walks = moves - pushes;
  const pushPct = moves > 0 ? (pushes / moves) * 100 : 0;
  const walkPct = 100 - pushPct;

  return (
    <div className={styles.timeline}>
      <div className={styles.bar}>
        {walkPct > 0 && (
          <span
            className={styles.segment}
            data-type="move"
            style={{ width: `${walkPct}%` }}
          />
        )}
        {pushPct > 0 && (
          <span
            className={styles.segment}
            data-type="push"
            style={{ width: `${pushPct}%` }}
          />
        )}
      </div>
      <div className={styles.legend}>
        <div className={styles.legendItems}>
          <span className={styles.legendItem}>
            <span className={styles.legendDot} style={{ background: "var(--blue-500)" }} />
            {walks} walks
          </span>
          <span className={styles.legendItem}>
            <span className={styles.legendDot} style={{ background: "var(--amber-500)" }} />
            {pushes} pushes
          </span>
        </div>
        <span className={styles.ratio}>{Math.round(pushPct)}% pushes</span>
      </div>
    </div>
  );
});
