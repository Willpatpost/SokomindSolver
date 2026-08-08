import { useCallback, useEffect, useState } from "react";
import styles from "./ScrollToTop.module.css";

const THRESHOLD = 400;

export function ScrollToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    function onScroll() {
      setVisible(window.scrollY > THRESHOLD);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const scrollUp = useCallback(() => {
    const prefersReduced =
      document.documentElement.dataset.motion === "reduced" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({
      top: 0,
      behavior: prefersReduced ? "instant" : "smooth",
    });
  }, []);

  if (!visible) return null;

  return (
    <button
      type="button"
      className={styles.button}
      onClick={scrollUp}
      aria-label="Scroll to top"
    >
      <span aria-hidden="true">&uarr;</span>
    </button>
  );
}
