import type { ReactNode } from "react";
import {
  Link,
  useRouter,
  homeHash,
  puzzlesHash,
  statsHash,
  editorHash,
  solverLabHash,
} from "@/src/router";
import styles from "@/src/shared/ui/MobileNav.module.css";

function NavIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const HomeIcon = () => (
  <NavIcon>
    <path d="M3 8.5 10 3l7 5.5V16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" />
  </NavIcon>
);

const PuzzlesIcon = () => (
  <NavIcon>
    <rect x="3" y="3" width="6" height="6" rx="1" />
    <rect x="11" y="3" width="6" height="6" rx="1" />
    <rect x="3" y="11" width="6" height="6" rx="1" />
    <rect x="11" y="11" width="6" height="6" rx="1" />
  </NavIcon>
);

const StatsIcon = () => (
  <NavIcon>
    <rect x="3" y="10" width="3" height="7" rx="0.5" />
    <rect x="8.5" y="6" width="3" height="11" rx="0.5" />
    <rect x="14" y="3" width="3" height="14" rx="0.5" />
  </NavIcon>
);

const LabIcon = () => (
  <NavIcon>
    <path d="M7 3v5l-4 7a1 1 0 0 0 .87 1.5h12.26A1 1 0 0 0 17 15l-4-7V3" />
    <line x1="5" y1="3" x2="15" y2="3" />
  </NavIcon>
);

const EditorIcon = () => (
  <NavIcon>
    <path d="M13.5 3.5l3 3L7 16H4v-3Z" />
  </NavIcon>
);

const NAV_ITEMS: readonly { label: string; hash: string; page: string; icon: () => ReactNode }[] = [
  { label: "Home", hash: homeHash(), page: "home", icon: HomeIcon },
  { label: "Puzzles", hash: puzzlesHash(), page: "puzzles", icon: PuzzlesIcon },
  { label: "Stats", hash: statsHash(), page: "stats", icon: StatsIcon },
  { label: "Lab", hash: solverLabHash(), page: "solver-lab", icon: LabIcon },
  { label: "Editor", hash: editorHash(), page: "editor", icon: EditorIcon },
];

const PUZZLE_PAGES = new Set([
  "puzzles",
  "puzzles-difficulty",
  "puzzles-collection",
]);

export function MobileNav() {
  const { route } = useRouter();
  if (route.page === "play") return null;

  return (
    <nav className={styles.nav} aria-label="Main navigation">
      {NAV_ITEMS.map((item) => {
        const active = item.page === route.page ||
          (item.page === "puzzles" && PUZZLE_PAGES.has(route.page));
        return (
          <Link
            key={item.page}
            href={item.hash}
            className={styles.item}
            data-active={active || undefined}
            aria-current={active ? "page" : undefined}
          >
            <span className={styles.icon} aria-hidden="true">{item.icon()}</span>
            <span className={styles.label}>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
