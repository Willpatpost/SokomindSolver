import { useEffect, useState } from "react";
import styles from "./NetworkStatus.module.css";

export function NetworkStatus() {
  const [offline, setOffline] = useState(() => !navigator.onLine);

  useEffect(() => {
    const handleOnline = () => setOffline(false);
    const handleOffline = () => setOffline(true);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  if (!offline) return null;

  return (
    <aside className={styles.notice} role="status" aria-live="polite">
      <strong>You&apos;re offline.</strong>{" "}
      Cached puzzles still work; reconnect to load anything new.
    </aside>
  );
}
