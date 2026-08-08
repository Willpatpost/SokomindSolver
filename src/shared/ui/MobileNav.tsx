import { useRouter, homeHash, puzzlesHash, statsHash, editorHash } from "@/src/router";
import styles from "./MobileNav.module.css";

const NAV_ITEMS = [
  { label: "Home", hash: homeHash(), page: "home", icon: "⌂" },
  { label: "Puzzles", hash: puzzlesHash(), page: "puzzles", icon: "▦" },
  { label: "Stats", hash: statsHash(), page: "stats", icon: "◔" },
  { label: "Editor", hash: editorHash(), page: "editor", icon: "✎" },
] as const;

const PUZZLE_PAGES = new Set(["puzzles", "puzzles-difficulty", "puzzles-collection"]);

export function MobileNav() {
  const { route, navigate } = useRouter();

  if (route.page === "play") return null;

  return (
    <nav className={styles.nav} aria-label="Main navigation">
      {NAV_ITEMS.map((item) => {
        const active =
          item.page === route.page ||
          (item.page === "puzzles" && PUZZLE_PAGES.has(route.page));
        return (
          <button
            key={item.page}
            type="button"
            className={styles.item}
            data-active={active || undefined}
            onClick={() => navigate(item.hash)}
            aria-current={active ? "page" : undefined}
          >
            <span className={styles.icon} aria-hidden="true">
              {item.icon}
            </span>
            <span className={styles.label}>{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
