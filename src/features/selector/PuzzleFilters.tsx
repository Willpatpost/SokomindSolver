import { useEffect, useRef } from "react";
import type { CompletionFilter } from "./use-puzzle-list-state";
import styles from "./PuzzleSelectorPage.module.css";

export interface PuzzleFiltersProps {
  readonly boxCounts: readonly number[];
  readonly boxFilter: number | null;
  readonly completionFilter: CompletionFilter;
  readonly query: string;
  readonly onBoxFilterChange: (value: number | null) => void;
  readonly onCompletionFilterChange: (value: CompletionFilter) => void;
  readonly onSearchChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
}

export function PuzzleFilters({
  boxCounts,
  boxFilter,
  completionFilter,
  query,
  onBoxFilterChange,
  onCompletionFilterChange,
  onSearchChange,
}: PuzzleFiltersProps) {
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.key !== "/" ||
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        document.querySelector("dialog[open], [role='dialog']")
      ) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) {
        return;
      }
      event.preventDefault();
      searchRef.current?.focus();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className={styles.filters}>
      {boxCounts.length > 1 && (
        <div className={styles.filterGroup} role="group" aria-label="Filter by box count">
          <span className={styles.filterLabel} aria-hidden="true">Boxes</span>
          <button
            type="button"
            className={styles.filterChip}
            data-active={boxFilter === null || undefined}
            aria-pressed={boxFilter === null}
            onClick={() => onBoxFilterChange(null)}
          >
            All
          </button>
          {boxCounts.map((count) => (
            <button
              key={count}
              type="button"
              className={styles.filterChip}
              data-active={boxFilter === count || undefined}
              aria-pressed={boxFilter === count}
              onClick={() => onBoxFilterChange(count)}
            >
              {count}
            </button>
          ))}
        </div>
      )}

      <div className={styles.filterGroup} role="group" aria-label="Filter by completion status">
        <span className={styles.filterLabel} aria-hidden="true">Status</span>
        {(["all", "cleared", "open", "favorites"] as const).map((value) => (
          <button
            key={value}
            type="button"
            className={styles.filterChip}
            data-active={completionFilter === value || undefined}
            aria-pressed={completionFilter === value}
            onClick={() => onCompletionFilterChange(value)}
          >
            {value.charAt(0).toUpperCase() + value.slice(1)}
          </button>
        ))}
      </div>

      <label className={styles.search}>
        <span aria-hidden="true">&#x2315;</span>
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={onSearchChange}
          placeholder="Search (/)"
          aria-label="Search puzzles"
        />
      </label>
    </div>
  );
}
