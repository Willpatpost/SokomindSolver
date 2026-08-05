import { useSyncExternalStore } from "react";
import { persistenceHealth } from "../persistence-health";
import styles from "./PersistenceWarning.module.css";

export function PersistenceWarning() {
  const health = useSyncExternalStore(
    persistenceHealth.subscribe,
    persistenceHealth.getSnapshot,
    persistenceHealth.getSnapshot,
  );
  if (health.failures.length === 0) return null;

  return (
    <aside
      className={styles.warning}
      data-testid="persistence-warning"
      role="status"
      aria-live="polite"
    >
      <strong>Changes are not being saved</strong>
      <span>
        Keep this tab open and check your browser&apos;s storage or privacy
        settings. Sokomind will retry when your data changes again.
      </span>
    </aside>
  );
}
