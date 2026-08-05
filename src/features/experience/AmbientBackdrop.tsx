import styles from "./AmbientBackdrop.module.css";

export interface AmbientBackdropProps {
  readonly className?: string;
}

const MOTES = ["amber", "sage", "paper", "coral", "sage", "amber"] as const;

export function AmbientBackdrop({ className }: AmbientBackdropProps) {
  const backdropClassName = className
    ? `${styles.backdrop} ${className}`
    : styles.backdrop;

  return (
    <div className={backdropClassName} aria-hidden="true">
      <span className={`${styles.halo} ${styles.haloOne}`} />
      <span className={`${styles.halo} ${styles.haloTwo}`} />
      <span className={`${styles.halo} ${styles.haloThree}`} />
      <span className={styles.blueprint} />
      <span className={styles.motes}>
        {MOTES.map((tone, index) => (
          <span data-tone={tone} key={`${tone}-${index}`} />
        ))}
      </span>
    </div>
  );
}
