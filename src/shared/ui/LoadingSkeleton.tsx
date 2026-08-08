import styles from "./LoadingSkeleton.module.css";

export function LoadingSkeleton() {
  return (
    <div className={styles.skeleton} aria-busy="true" aria-label="Loading content">
      <div className={styles.container}>
        <div className={styles.header}>
          <div className={`${styles.bone} ${styles.boneSmall}`} />
          <div className={`${styles.bone} ${styles.boneTitle}`} />
        </div>
        <div className={styles.grid}>
          <div className={`${styles.bone} ${styles.boneCard}`} />
          <div className={`${styles.bone} ${styles.boneCard}`} />
          <div className={`${styles.bone} ${styles.boneCard}`} />
        </div>
      </div>
    </div>
  );
}
