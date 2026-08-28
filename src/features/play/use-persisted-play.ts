import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  createSession,
  isShareableActionLog,
  replayActionLog,
  type GameSession,
  type PuzzleDefinition,
} from "@/src/core";
import {
  recordDailyCompletion,
  recordCompletion,
  type ProgressData,
  type PuzzleRecord,
} from "@/src/shared/progress";
import {
  promoteVerifiedPersonalBestRoute,
  verifyPersonalBestRoute,
} from "@/src/shared/personal-best-routes";
import {
  createProgressWriterId,
  loadProgressSyncSnapshot,
  parseProgressSyncSnapshot,
  persistProgressImport,
  persistProgressReset,
  persistProgressUpdate,
  reconcileProgressSnapshots,
  writeProgressSyncSnapshot,
  type ProgressSyncSnapshot,
} from "@/src/shared/progress-sync";
import {
  DOCUMENT_APP_RESET_GENERATION,
  STORAGE_KEYS,
  loadAppResetGeneration,
} from "@/src/shared/storage";
import {
  hydrateSessionFromIDB,
  loadSession,
  saveSession,
  type RestoredSession,
} from "@/src/shared/session-persistence";

export interface CompletionRecordUpdate {
  readonly previousBest?: PuzzleRecord;
  readonly previousProgress: ProgressData;
  readonly progress: ProgressData;
}

export interface DailySolveContext {
  readonly dateKey: string;
  readonly completedAt: Date;
}

function createInitialSession(
  puzzle: PuzzleDefinition,
  actionLog?: string,
  freshAttempt = false,
): {
  readonly session: GameSession;
  readonly restored: boolean;
  readonly persisted: RestoredSession | null;
} {
  if (actionLog !== undefined) {
    if (!isShareableActionLog(actionLog)) {
      throw new Error("Cannot replay an invalid or oversized shared route.");
    }
    return {
      session: replayActionLog(puzzle, actionLog),
      restored: false,
      persisted: null,
    };
  }

  if (freshAttempt) {
    return {
      session: createSession(puzzle),
      restored: false,
      persisted: null,
    };
  }

  const stored = loadSession((puzzleId) =>
    puzzleId === puzzle.id ? puzzle : undefined);
  if (stored && stored.session.puzzle.id === puzzle.id) {
    return {
      session: stored.session,
      restored: stored.resumed,
      persisted: stored,
    };
  }

  return {
    session: createSession(puzzle),
    restored: false,
    persisted: null,
  };
}

export function usePersistedPlay(
  puzzle: PuzzleDefinition,
  actionLog?: string,
  onSessionRestored?: (moves: number) => void,
  freshAttempt = false,
) {
  const [initialSession] = useState(() =>
    createInitialSession(puzzle, actionLog, freshAttempt));
  const [session, setSession] = useState<GameSession>(initialSession.session);
  const [sessionRestored, setSessionRestored] = useState(
    initialSession.restored,
  );
  const [sessionPersistenceReady, setSessionPersistenceReady] = useState(
    actionLog !== undefined || freshAttempt,
  );
  const [writerId] = useState(createProgressWriterId);
  const [initialProgressSnapshot] = useState(loadProgressSyncSnapshot);
  const progressSyncRef = useRef(initialProgressSnapshot);
  const [progress, setProgress] = useState<ProgressData>(
    initialProgressSnapshot.progress,
  );
  const sessionRef = useRef(session);
  const sessionMutationRef = useRef(0);
  const initializedRef = useRef(false);
  const restoredAnnouncementRef = useRef(false);

  const commitSession = useCallback((next: GameSession) => {
    sessionMutationRef.current += 1;
    sessionRef.current = next;
    setSession(next);
    // A move made before IDB hydration settles chooses the visible attempt.
    // Make it persistable immediately and let the pending read decline to
    // replace it via the mutation counter.
    setSessionPersistenceReady(true);
  }, []);

  const commitProgressSnapshot = useCallback((next: ProgressSyncSnapshot) => {
    progressSyncRef.current = next;
    setProgress(next.progress);
  }, []);

  useLayoutEffect(() => {
    if (freshAttempt && actionLog === undefined) {
      // Persist before paint. Route identity changes remount the play page, and
      // WebKit can otherwise navigate back before a passive autosave replaces
      // the attempt belonging to the puzzle that was just left.
      saveSession(initialSession.session);
    }
  }, [actionLog, freshAttempt, initialSession]);

  useEffect(() => {
    let active = true;
    const next = initializedRef.current
      ? createInitialSession(puzzle, actionLog, freshAttempt)
      : initialSession;
    if (initializedRef.current) {
      commitSession(next.session);
      setSessionRestored(next.restored);
    }
    initializedRef.current = true;

    if (actionLog !== undefined) {
      setSessionPersistenceReady(true);
      return;
    }

    if (freshAttempt) {
      setSessionPersistenceReady(true);
      return;
    }

    setSessionPersistenceReady(false);
    const mutationAtStart = sessionMutationRef.current;
    void hydrateSessionFromIDB(
      (puzzleId) => puzzleId === puzzle.id ? puzzle : undefined,
      next.persisted,
    ).then((hydrated) => {
      if (!active) return;
      if (
        sessionMutationRef.current === mutationAtStart &&
        hydrated &&
        hydrated.session.puzzle.id === puzzle.id &&
        hydrated.session.actionLog !== next.session.actionLog
      ) {
        commitSession(hydrated.session);
        setSessionRestored(hydrated.resumed);
      }
      setSessionPersistenceReady(true);
    });

    return () => {
      active = false;
      if (
        sessionMutationRef.current !== mutationAtStart &&
        sessionRef.current.puzzle.id === puzzle.id &&
        loadAppResetGeneration() === DOCUMENT_APP_RESET_GENERATION
      ) {
        // A user can move while a slow IDB read is pending. Flush that newer
        // in-memory attempt when navigating away; otherwise the readiness gate
        // suppresses autosave and the move disappears on unmount.
        saveSession(sessionRef.current);
      }
    };
  }, [puzzle, actionLog, commitSession, freshAttempt, initialSession]);

  useEffect(() => {
    if (
      !restoredAnnouncementRef.current &&
      sessionRestored &&
      session.actionLog.length > 0
    ) {
      restoredAnnouncementRef.current = true;
      onSessionRestored?.(session.moves);
    }
  }, [onSessionRestored, session.actionLog.length, session.moves, sessionRestored]);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = `${session.puzzle.title} · Sokomind`;
    return () => {
      document.title = previousTitle;
    };
  }, [session.puzzle.title]);

  useEffect(() => {
    if (!sessionPersistenceReady || session.puzzle.id !== puzzle.id) return;
    saveSession(session);
  }, [puzzle.id, session, sessionPersistenceReady]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      const current = progressSyncRef.current;
      if (event.key !== STORAGE_KEYS.progress || !current) return;

      if (event.newValue === null) {
        const reset = persistProgressReset(current, writerId);
        commitProgressSnapshot(reset.snapshot);
        return;
      }

      const incoming = parseProgressSyncSnapshot(event.newValue);
      if (!incoming) return;

      const reconciliation = reconcileProgressSnapshots(
        current,
        incoming,
        writerId,
      );
      commitProgressSnapshot(reconciliation.snapshot);
      if (reconciliation.shouldPersist) {
        writeProgressSyncSnapshot(reconciliation.snapshot);
      }
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [commitProgressSnapshot, writerId]);

  const recordSolvedSession = useCallback(
    (
      solved: GameSession,
      elapsedMs?: number,
      daily?: DailySolveContext,
    ): CompletionRecordUpdate => {
      const current = progressSyncRef.current ?? loadProgressSyncSnapshot();
      const completedAt = daily?.completedAt ?? new Date();
      const verifiedRoute = verifyPersonalBestRoute(solved.puzzle, {
        actionLog: solved.actionLog,
        moves: solved.moves,
        pushes: solved.pushes,
        elapsedMs,
        completedAt: completedAt.toISOString(),
      });
      const update = persistProgressUpdate(
        current,
        writerId,
        (stored) => {
          if (!verifiedRoute) return stored;
          const completed = recordCompletion(
            stored,
            solved.puzzle.id,
            solved.moves,
            solved.pushes,
            elapsedMs,
            completedAt,
          );
          return daily
            ? recordDailyCompletion(
                completed,
                solved.puzzle.id,
                daily.completedAt,
                daily.dateKey,
              )
            : completed;
        },
      );
      commitProgressSnapshot(update.snapshot);
      const previousBest = update.previous.completed[solved.puzzle.id];
      if (
        verifiedRoute &&
        (!previousBest || verifiedRoute.moves < previousBest.moves)
      ) {
        // Route storage is intentionally asynchronous. Summary progress and
        // play remain available even when IndexedDB is missing or quota-bound.
        void promoteVerifiedPersonalBestRoute(solved.puzzle, verifiedRoute);
      }
      return Object.freeze({
        previousBest,
        previousProgress: update.previous,
        progress: update.snapshot.progress,
      });
    },
    [commitProgressSnapshot, writerId],
  );

  const importProgress = useCallback((imported: ProgressData) => {
    const current = progressSyncRef.current ?? loadProgressSyncSnapshot();
    const update = persistProgressImport(
      current,
      writerId,
      imported,
    );
    if (update.result.ok) commitProgressSnapshot(update.snapshot);
    return update;
  }, [commitProgressSnapshot, writerId]);

  const resetProgress = useCallback(() => {
    const current = progressSyncRef.current ?? loadProgressSyncSnapshot();
    const update = persistProgressReset(current, writerId);
    if (update.result.ok) commitProgressSnapshot(update.snapshot);
    return update;
  }, [commitProgressSnapshot, writerId]);

  return {
    session,
    sessionRestored,
    sessionPersistenceReady,
    sessionRef,
    progress,
    commitSession,
    recordSolvedSession,
    importProgress,
    resetProgress,
  } as const;
}
