import styles from "./BoardSkeleton.module.css";

const CELLS = Array.from({ length: 64 });

export function BoardSkeleton() {
  return (
    <div
      className={styles.skeleton}
      role="status"
      aria-busy="true"
      aria-label="Loading puzzle"
    >
      {CELLS.map((_, i) => (
        <div key={i} className={styles.cell} />
      ))}
    </div>
  );
}
