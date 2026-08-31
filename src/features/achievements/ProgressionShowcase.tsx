import { useMemo, useState } from "react";
import { PUZZLE_METADATA } from "../../catalog/puzzle-metadata.ts";
import type { ProgressData } from "../../shared/progress.ts";
import { useExperience } from "../experience/use-experience.ts";
import type { AggregateStats } from "../progress/compute-stats.ts";
import {
  ACHIEVEMENTS,
  ACHIEVEMENT_COLLECTIONS,
  getAchievementProgress,
  getRecentAchievementMilestones,
  getUnlockedAchievements,
} from "./achievements.ts";
import {
  getCosmeticStates,
  loadCosmeticPreference,
  saveCosmeticPreference,
} from "./cosmetics.ts";
import styles from "./ProgressionShowcase.module.css";

interface ProgressionShowcaseProps {
  readonly stats: AggregateStats;
  readonly progress: ProgressData;
}

function milestoneDate(isoDate: string): string {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(isoDate));
}

export function ProgressionShowcase({ stats, progress }: ProgressionShowcaseProps) {
  const { preferences } = useExperience();
  const [cosmeticPreference, setCosmeticPreference] = useState(loadCosmeticPreference);
  const unlocked = useMemo(
    () => getUnlockedAchievements(stats, progress),
    [progress, stats],
  );
  const unlockedIds = useMemo(
    () => new Set(unlocked.map(({ id }) => id)),
    [unlocked],
  );
  const milestones = useMemo(
    () => getRecentAchievementMilestones(stats, progress, PUZZLE_METADATA),
    [progress, stats],
  );
  const cosmetics = getCosmeticStates(
    cosmeticPreference,
    preferences.themeFamily,
    stats,
    progress,
  );

  return (
    <section className={styles.showcase} aria-labelledby="progression-title">
      <header className={styles.intro}>
        <div>
          <p className={styles.eyebrow}>Long-term progress</p>
          <h2 id="progression-title">Achievements and keepsakes</h2>
          <p>
            Every requirement is visible and evaluated from your saved solves.
            Rewards never lock puzzles or change board rules.
          </p>
        </div>
        <strong>{unlocked.length}/{ACHIEVEMENTS.length} earned</strong>
      </header>

      <section className={styles.recent} aria-labelledby="recent-milestones-title">
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>Recent milestones</p>
            <h3 id="recent-milestones-title">The path behind you</h3>
          </div>
          <span>Based on saved completion dates</span>
        </div>
        {milestones.length > 0 ? (
          <ol className={styles.milestoneList}>
            {milestones.map((milestone) => (
              <li key={milestone.achievementId}>
                <span className={styles.milestoneMark} aria-hidden="true">✓</span>
                <div>
                  <strong>{milestone.title}</strong>
                  <span>{milestone.collectionTitle} · {milestoneDate(milestone.earnedAt)}</span>
                  <small>{milestone.description}</small>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className={styles.emptyMilestones}>
            Your first solved room will place a milestone here.
          </p>
        )}
      </section>

      <div className={styles.collections}>
        {ACHIEVEMENT_COLLECTIONS.map((collection) => {
          const achievements = ACHIEVEMENTS.filter(
            ({ collectionId }) => collectionId === collection.id,
          );
          const earnedCount = achievements.filter(({ id }) => unlockedIds.has(id)).length;
          return (
            <section key={collection.id} className={styles.collection} aria-labelledby={`collection-${collection.id}`}>
              <header className={styles.collectionHeader}>
                <div>
                  <h3 id={`collection-${collection.id}`}>{collection.title}</h3>
                  <p>{collection.description}</p>
                </div>
                <span>{earnedCount}/{achievements.length}</span>
              </header>
              <ul className={styles.achievementList}>
                {achievements.map((achievement) => {
                  const achievementProgress = getAchievementProgress(
                    achievement,
                    stats,
                    progress,
                  );
                  return (
                    <li key={achievement.id} data-earned={achievementProgress.complete || undefined}>
                      <span className={styles.achievementIcon} aria-hidden="true">
                        {achievementProgress.complete ? "✓" : achievement.icon}
                      </span>
                      <div className={styles.achievementBody}>
                        <div>
                          <strong>{achievement.title}</strong>
                          <span>{achievementProgress.complete ? "Earned" : "In progress"}</span>
                        </div>
                        <p>{achievement.description}</p>
                        <div
                          className={styles.progressTrack}
                          role="progressbar"
                          aria-label={`${achievement.title}: ${achievementProgress.label}`}
                          aria-valuemin={0}
                          aria-valuemax={achievementProgress.target}
                          aria-valuenow={achievementProgress.current}
                        >
                          <span style={{ width: `${(achievementProgress.current / achievementProgress.target) * 100}%` }} />
                        </div>
                        <small>{achievementProgress.label}</small>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>

      <section className={styles.cosmetics} aria-labelledby="cosmetics-title">
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>Board-frame keepsakes</p>
            <h3 id="cosmetics-title">Choose a quiet finishing touch</h3>
          </div>
          <span>Frame and shadow only</span>
        </div>
        <p className={styles.cosmeticNote}>
          These never recolor tiles, goals, crates, the robot, warnings, or focus indicators.
        </p>
        <div className={styles.cosmeticGrid} role="group" aria-label="Board frame cosmetic">
          {cosmetics.map((cosmetic) => {
            const usable = cosmetic.unlocked && cosmetic.compatible;
            const status = !cosmetic.unlocked
              ? cosmetic.requirement
              : !cosmetic.compatible
                ? `Use with ${cosmetic.compatibleThemeFamilies.map((family) => family.replaceAll("-", " ")).join(" or ")}`
                : cosmetic.active
                  ? "Active"
                  : "Available";
            return (
              <button
                key={cosmetic.id}
                type="button"
                className={styles.cosmetic}
                data-cosmetic={cosmetic.id}
                data-active={cosmetic.active || undefined}
                data-locked={!usable || undefined}
                aria-pressed={cosmetic.active}
                disabled={!usable}
                onClick={() => {
                  const next = {
                    version: 1,
                    boardFrame: cosmetic.id,
                  } as const;
                  if (saveCosmeticPreference(next).ok) {
                    setCosmeticPreference(next);
                  }
                }}
              >
                <span className={styles.cosmeticPreview} aria-hidden="true"><span /></span>
                <span className={styles.cosmeticCopy}>
                  <strong>{cosmetic.title}</strong>
                  <small>{cosmetic.description}</small>
                  <em>{status}</em>
                </span>
              </button>
            );
          })}
        </div>
      </section>
    </section>
  );
}
