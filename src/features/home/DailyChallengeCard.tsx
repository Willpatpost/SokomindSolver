import type { DailyChallengeView } from "../progress/daily-challenge.ts";
import styles from "./DailyChallengeCard.module.css";

interface DailyChallengeCardProps {
  readonly view: DailyChallengeView;
  readonly onPlay: (puzzleId: string) => void;
  readonly onBrowse: () => void;
}

export function DailyChallengeCard({
  view,
  onPlay,
  onBrowse,
}: DailyChallengeCardProps) {
  return (
    <section className={styles.card} data-state={view.state} aria-labelledby="daily-title">
      <div className={styles.topline}>
        <span>Daily challenge · {view.dateLabel}</span>
        <span>{view.streak > 0 ? `${view.streak}-day run` : "Local midnight reset"}</span>
      </div>
      <div className={styles.main}>
        <div>
          <h2 id="daily-title">{view.puzzle?.title ?? "Daily room unavailable"}</h2>
          <p>{view.framing}</p>
        </div>
        {view.puzzle ? (
          <button type="button" onClick={() => onPlay(view.puzzle!.id)}>
            {view.state === "completed" ? "Replay today" : view.state === "recovery" ? "Start fresh" : "Play today"}
          </button>
        ) : (
          <button type="button" onClick={onBrowse}>Browse catalog</button>
        )}
      </div>
      {view.history.length > 0 ? (
        <ol className={styles.history} aria-label="Seven-day daily challenge history">
          {view.history.map((day) => (
            <li key={day.dateKey} data-outcome={day.outcome}>
              <span className={styles.dot} aria-hidden="true">
                {day.outcome === "completed" ? "✓" : day.outcome === "today" ? "•" : ""}
              </span>
              <span>{day.shortLabel}</span>
              <span className={styles.srOnly}>
                {day.puzzleTitle ? `, ${day.puzzleTitle}` : ""}, {day.outcome}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
