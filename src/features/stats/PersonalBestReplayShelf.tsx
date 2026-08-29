import { useEffect, useMemo, useState } from "react";
import { loadPuzzleById } from "../../catalog/puzzle-loader.ts";
import type { PuzzleDefinition } from "../../core/model.ts";
import {
  loadPersonalBestRouteIndex,
  loadPersonalBestRoutes,
  type SavedPersonalBestRoute,
} from "../../shared/personal-best-routes.ts";
import type { ProgressData } from "../../shared/progress.ts";
import { ReplayComparisonDialog } from "../replay/ReplayComparisonDialog.tsx";
import styles from "./PersonalBestReplayShelf.module.css";

interface PersonalBestReplayShelfProps {
  readonly progress: ProgressData;
  readonly className?: string;
}

interface ReplayShelfItem {
  readonly puzzle: PuzzleDefinition;
  readonly routes: readonly SavedPersonalBestRoute[];
}

interface ReplayShelfState {
  readonly signature: string;
  readonly status: "loading" | "ready" | "unavailable";
  readonly items: readonly ReplayShelfItem[];
}

function formatSavedDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

export function PersonalBestReplayShelf({
  progress,
  className,
}: PersonalBestReplayShelfProps) {
  const recentPuzzleIds = useMemo(
    () => Object.entries(progress.completed)
      .sort(([, first], [, second]) =>
        second.completedAt.localeCompare(first.completedAt))
      .map(([puzzleId]) => puzzleId),
    [progress.completed],
  );
  const signature = recentPuzzleIds.join("\n");
  const [state, setState] = useState<ReplayShelfState>({
    signature: "",
    status: "loading",
    items: [],
  });
  const [selectedPuzzle, setSelectedPuzzle] = useState<PuzzleDefinition | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const index = await loadPersonalBestRouteIndex();
      const available = new Set(index.puzzleIds);
      const items: ReplayShelfItem[] = [];
      for (const puzzleId of recentPuzzleIds) {
        if (!available.has(puzzleId)) continue;
        try {
          const puzzle = await loadPuzzleById(puzzleId);
          if (!puzzle) continue;
          const read = await loadPersonalBestRoutes(puzzle);
          if (read.status !== "ready" || read.routes.length === 0) continue;
          items.push(Object.freeze({ puzzle, routes: read.routes }));
          if (items.length >= 6) break;
        } catch {
          // Continue to the next indexed puzzle; one failed shard or stale
          // route must not hide other verified replays.
        }
      }
      if (cancelled) return;
      setState({
        signature,
        status: index.status === "unavailable" ? "unavailable" : "ready",
        items: Object.freeze(items),
      });
    })().catch(() => {
      if (!cancelled) setState({ signature, status: "unavailable", items: [] });
    });
    return () => {
      cancelled = true;
    };
  }, [recentPuzzleIds, signature]);

  const currentState = state.signature === signature
    ? state
    : { signature, status: "loading" as const, items: [] };
  const rootClass = className ? `${className} ${styles.shelf}` : styles.shelf;

  return (
    <section className={rootClass} aria-labelledby="personal-best-replays-title">
      <div className={styles.heading}>
        <div>
          <p className={styles.label}>Improvement lab</p>
          <h2 id="personal-best-replays-title">Personal-best replays</h2>
        </div>
        <span>{currentState.items.length} ready</span>
      </div>
      {currentState.status === "loading" ? (
        <p className={styles.state} role="status">Finding recent verified routes…</p>
      ) : currentState.status === "unavailable" ? (
        <p className={styles.state} role="status">
          Replay storage is unavailable. Your summary statistics still work normally.
        </p>
      ) : currentState.items.length === 0 ? (
        <p className={styles.state}>
          No recent replay routes are available yet. Summary records remain safe; complete a room again to capture its route.
        </p>
      ) : (
        <ul className={styles.list}>
          {currentState.items.map(({ puzzle, routes }) => {
            const best = routes[0]!;
            return (
              <li key={puzzle.id}>
                <div>
                  <strong>{puzzle.title}</strong>
                  <span>
                    {best.moves} moves · {best.pushes} pushes · {routes.length} {routes.length === 1 ? "route" : "routes"}
                  </span>
                  <small>Saved {formatSavedDate(best.completedAt)}</small>
                </div>
                <button type="button" onClick={() => setSelectedPuzzle(puzzle)}>
                  Study replay
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {selectedPuzzle ? (
        <ReplayComparisonDialog
          onClose={() => setSelectedPuzzle(null)}
          open
          puzzle={selectedPuzzle}
        />
      ) : null}
    </section>
  );
}
