import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  move,
  reset,
  undo,
  undoN,
  type Direction,
  type PuzzleDefinition,
} from "@/src/core";
import { decodeActionLog } from "@/src/core/action-log";
import type { SolutionStep } from "@/src/solver";
import { toLocalDateKey } from "@/src/shared/progress";
import {
  hydrateOptimalCacheFromIDB,
  loadOptimalCache,
  mergeOptimalCaches,
  parseOptimalCache,
  saveOptimalCache,
  setOptimalRecord,
  type OptimalRecord,
} from "@/src/shared/optimal-cache";
import { STORAGE_KEYS } from "@/src/shared/storage";
import {
  useExperience,
  type AudioCue,
} from "@/src/features/experience";
import { detectDeadlock, findPushedBox } from "@/src/solver/deadlock-bridge";
import { classifyMove } from "@/src/features/game/game-feedback";
import { useGameKeyboard } from "@/src/features/game/use-game-keyboard";
import { useHintController } from "@/src/features/game/use-hint-controller";
import { useTimer } from "@/src/features/game/use-timer";
import { PUZZLE_METADATA } from "@/src/catalog/puzzle-metadata";
import { computeStats, getDailyPuzzleId } from "@/src/features/progress/compute-stats";
import { getNewlyUnlockedAchievements } from "@/src/features/achievements/achievements";
import { usePersistedPlay, type CompletionRecordUpdate } from "./use-persisted-play";
import { puzzlesHash, useRouter } from "@/src/router";
import { useSharing } from "./use-sharing";
import { useSolverPlayback } from "./use-solver-playback";
import { usePuzzleNavigation } from "./use-puzzle-navigation";

const EMPTY_BOX_SET: ReadonlySet<string> = new Set<string>();

const FEEDBACK_CUES: Readonly<Record<ReturnType<typeof classifyMove>, AudioCue>> = {
  blocked: "blocked",
  move: "step",
  push: "push",
  goal: "goal-enter",
  "goal-leave": "goal-leave",
  solved: "solve",
};

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

interface PlayControllerOptions {
  readonly onToggleFavorite?: () => boolean;
}

export function usePlayController(
  puzzle: PuzzleDefinition,
  actionLog?: string,
  freshAttempt = false,
  options: PlayControllerOptions = {},
) {
  const { playCue, reducedMotion } = useExperience();
  const { navigate } = useRouter();
  const [toast, setToast] = useState<string | null>(null);
  const handleSessionRestored = useCallback((moves: number) => {
    setToast(`Restored ${countLabel(moves, "saved move")}.`);
  }, []);
  const {
    session,
    sessionRestored,
    sessionPersistenceReady,
    sessionRef,
    progress,
    commitSession,
    recordSolvedSession,
    importProgress,
    resetProgress,
  } = usePersistedPlay(
    puzzle,
    actionLog,
    handleSessionRestored,
    freshAttempt,
  );
  const [helpOpen, setHelpOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [manualPaused, setManualPaused] = useState(false);
  const [progressOpen, setProgressOpen] = useState(false);
  const [resetConfirmPuzzleId, setResetConfirmPuzzleId] =
    useState<string | null>(null);
  const [completionPuzzleId, setCompletionPuzzleId] =
    useState<string | null>(null);
  const [completionResult, setCompletionResult] =
    useState<CompletionRecordUpdate>({
      newBest: false,
      previousProgress: progress,
      progress,
    });
  const [solverPuzzleId, setSolverPuzzleId] = useState<string | null>(null);
  const [optimalCache, setOptimalCache] = useState(loadOptimalCache);
  const [deadlockedBoxIds, setDeadlockedBoxIds] = useState<ReadonlySet<string>>(
    EMPTY_BOX_SET,
  );
  const hintCancelRef = useRef<() => void>(() => {});
  const resetConfirmOpen = resetConfirmPuzzleId === session.puzzle.id;
  const completionOpen = completionPuzzleId === session.puzzle.id;
  const solverOpen = solverPuzzleId === session.puzzle.id;

  const completedIds = useMemo(
    () => new Set(Object.keys(progress.completed)),
    [progress.completed],
  );

  useEffect(() => {
    let active = true;
    void hydrateOptimalCacheFromIDB(loadOptimalCache()).then((hydrated) => {
      if (!active) return;
      setOptimalCache((current) => {
        const merged = mergeOptimalCaches(current, hydrated);
        return merged === current ? current : saveOptimalCache(merged).cache;
      });
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEYS.optimal) return;
      const incoming = parseOptimalCache(event.newValue);
      if (event.newValue === null) {
        setOptimalCache(incoming);
        return;
      }
      setOptimalCache((current) => {
        const merged = mergeOptimalCaches(incoming, current);
        return merged === incoming ? incoming : saveOptimalCache(merged).cache;
      });
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const duration = toast.length > 40 ? 3200 : 2200;
    const t = window.setTimeout(() => setToast(null), duration);
    return () => window.clearTimeout(t);
  }, [toast]);

  // --- Game move logic ---

  const elapsedRef = useRef(0);

  const applyDirection = useCallback((direction: Direction): boolean => {
    const current = sessionRef.current;
    if (current.solved) return false;

    const next = move(current, direction);
    const feedback = classifyMove(current, next);
    void playCue(FEEDBACK_CUES[feedback]);
    if (feedback === "blocked") {
      setToast("That route is blocked.");
      return false;
    }

    commitSession(next);
    if (feedback === "solved") {
      setDeadlockedBoxIds(EMPTY_BOX_SET);
      const completedAt = new Date();
      const isDaily = getDailyPuzzleId(PUZZLE_METADATA, completedAt) === next.puzzle.id;
      const result = recordSolvedSession(
        next,
        elapsedRef.current,
        isDaily
          ? { dateKey: toLocalDateKey(completedAt), completedAt }
          : undefined,
      );
      const preSolveStats = computeStats(result.previousProgress, PUZZLE_METADATA);
      setCompletionResult(result);
      setCompletionPuzzleId(next.puzzle.id);
      const postSolveStats = computeStats(result.progress, PUZZLE_METADATA);
      const newAchievements = getNewlyUnlockedAchievements(
        preSolveStats,
        result.previousProgress,
        postSolveStats,
        result.progress,
      );
      if (newAchievements.length > 0) {
        const names = newAchievements.map((a) => a.title).join(", ");
        setTimeout(() => setToast(`Achievement unlocked: ${names}`), 1200);
      }
    } else if (feedback === "push" || feedback === "goal" || feedback === "goal-leave") {
      const pushed = findPushedBox(current.snapshot.boxes, next.snapshot.boxes);
      const result = detectDeadlock(next.board, next.snapshot, pushed?.id);
      if (result.isDeadlocked) {
        setDeadlockedBoxIds(new Set(result.deadlockedBoxIds));
        setToast("That box looks stuck — you may need to undo.");
        void playCue("blocked");
      } else {
        setDeadlockedBoxIds(EMPTY_BOX_SET);
      }
    } else {
      setDeadlockedBoxIds(EMPTY_BOX_SET);
    }
    return true;
  }, [commitSession, playCue, recordSolvedSession, sessionRef]);

  // --- Solver playback (delegated) ---

  const {
    playback,
    playSolverSolution: playSolverSolutionRaw,
    stopSolutionPlayback,
    setPlaybackSpeed,
  } = useSolverPlayback({
    sessionRef,
    reducedMotion,
    applyDirection,
    onToast: setToast,
  });

  // Wrap playSolverSolution to also close the solver dialog
  const playSolverSolution = useCallback(
    (...args: Parameters<typeof playSolverSolutionRaw>) => {
      setSolverPuzzleId(null);
      playSolverSolutionRaw(...args);
    },
    [playSolverSolutionRaw],
  );

  const timerPaused =
    !sessionPersistenceReady ||
    session.solved ||
    completionOpen ||
    resetConfirmOpen ||
    solverOpen ||
    helpOpen ||
    progressOpen ||
    manualPaused ||
    playback.active ||
    session.moves === 0;
  const timer = useTimer({
    paused: timerPaused,
    persistKey: `sokomind:timer:${session.puzzle.id}`,
    restorePersisted: sessionRestored,
    persistenceReady: sessionPersistenceReady,
  });
  useEffect(() => {
    elapsedRef.current = timer.elapsed;
  });
  const timerResetRef = useRef(timer.reset);
  useEffect(() => {
    timerResetRef.current = timer.reset;
  }, [timer.reset]);

  const replaySolution = useCallback(() => {
    const current = sessionRef.current;
    if (!current.solved || current.actionLog.length === 0) return;

    const al = current.actionLog;
    const pid = current.puzzle.id;

    const initial = reset(current);
    commitSession(initial);
    setCompletionPuzzleId(null);
    setDeadlockedBoxIds(EMPTY_BOX_SET);
    timerResetRef.current();

    if (sessionRef.current.moves !== 0) {
      setToast("Reset did not complete — cannot replay.");
      return;
    }

    const directions = decodeActionLog(al);
    const steps: readonly SolutionStep[] = directions.map((d) => ({
      direction: d,
      kind: "walk" as const,
    }));
    const fingerprint = { puzzleId: pid, actionLog: "" };
    playSolverSolutionRaw(steps, fingerprint);
  }, [commitSession, playSolverSolutionRaw, sessionRef]);

  // --- Move actions ---

  const attemptMove = useCallback((direction: Direction) => {
    stopSolutionPlayback();
    applyDirection(direction);
  }, [applyDirection, stopSolutionPlayback]);

  const handleUndo = useCallback(() => {
    stopSolutionPlayback();
    setCompletionPuzzleId(null);
    setDeadlockedBoxIds(EMPTY_BOX_SET);
    const current = sessionRef.current;
    const previous = undo(current);
    if (previous === current) {
      setToast("No move to undo yet.");
      void playCue("blocked");
      return;
    }
    commitSession(previous);
    void playCue("undo");
  }, [commitSession, playCue, sessionRef, stopSolutionPlayback]);

  const handleUndoN = useCallback((count: number) => {
    stopSolutionPlayback();
    setCompletionPuzzleId(null);
    setDeadlockedBoxIds(EMPTY_BOX_SET);
    const current = sessionRef.current;
    const result = undoN(current, count);
    if (result === current) {
      setToast("No move to undo yet.");
      void playCue("blocked");
      return;
    }
    commitSession(result);
    void playCue("undo");
    setToast(`Undid ${current.moves - result.moves} moves.`);
  }, [commitSession, playCue, sessionRef, stopSolutionPlayback]);

  const performReset = useCallback(() => {
    hintCancelRef.current();
    stopSolutionPlayback();
    setCompletionPuzzleId(null);
    setDeadlockedBoxIds(EMPTY_BOX_SET);
    commitSession(reset(sessionRef.current));
    timerResetRef.current();
    setToast("Room restarted.");
    void playCue("reset");
  }, [commitSession, playCue, sessionRef, stopSolutionPlayback]);

  const requestReset = useCallback(() => {
    hintCancelRef.current();
    if (sessionRef.current.moves === 0) {
      performReset();
    } else {
      setResetConfirmPuzzleId(sessionRef.current.puzzle.id);
    }
  }, [performReset, sessionRef]);

  // --- Puzzle navigation (delegated) ---

  const onBeforeNavigate = useCallback(() => {
    stopSolutionPlayback();
    setCompletionPuzzleId(null);
    setDeadlockedBoxIds(EMPTY_BOX_SET);
    setResetConfirmPuzzleId(null);
    setSolverPuzzleId(null);
    timerResetRef.current();
  }, [stopSolutionPlayback]);

  const {
    puzzleIndex,
    totalPuzzles,
    nextPuzzle,
    nextUnsolvedPuzzle,
    selectPuzzle,
    selectPreviousPuzzle,
    selectNextPuzzle,
  } = usePuzzleNavigation(session.puzzle.id, onBeforeNavigate, completedIds);

  // --- Sharing (delegated) ---

  const { share: handleShare } = useSharing(session, setToast);

  // --- Optimal cache ---

  const handleSaveOptimal = useCallback((
    pid: string,
    record: OptimalRecord,
  ) => {
    setOptimalCache((current) => {
      const next = setOptimalRecord(current, pid, record);
      return saveOptimalCache(next).cache;
    });
  }, []);

  // --- Hints ---

  const hint = useHintController({
    session,
    disabled: playback.active || solverOpen,
    onPlaySteps: playSolverSolution,
    onToast: setToast,
  });
  useEffect(() => {
    hintCancelRef.current = hint.cancel;
    return () => {
      hintCancelRef.current = () => {};
    };
  }, [hint.cancel]);

  // --- Keyboard ---

  const selectNextUnsolved = useCallback(() => {
    if (nextUnsolvedPuzzle) selectPuzzle(nextUnsolvedPuzzle.id);
  }, [nextUnsolvedPuzzle, selectPuzzle]);

  useGameKeyboard({
    enabled: !playback.active,
    onMove: attemptMove,
    onUndo: handleUndo,
    onReset: requestReset,
    onHint: hint.requestHint,
    onNextPuzzle: selectNextPuzzle,
    onPreviousPuzzle: selectPreviousPuzzle,
    onNextUnsolved: nextUnsolvedPuzzle ? selectNextUnsolved : undefined,
    onShowShortcuts: () => setShortcutsOpen((v) => !v),
    onPause: () => {
      if (!session.solved && session.moves > 0) setManualPaused((v) => !v);
    },
    onToggleFavorite: options.onToggleFavorite
      ? () => {
          const nowFavorited = options.onToggleFavorite!();
          setToast(nowFavorited ? "Added to favorites." : "Removed from favorites.");
        }
      : undefined,
  });

  return {
    session,
    progress,
    completedIds,
    deadlockedBoxIds,
    elapsed: timer.elapsed,
    hint,
    reducedMotion,
    toast,
    showToast: setToast,
    helpOpen,
    progressOpen,
    solverOpen,
    resetConfirmOpen,
    completionOpen,
    completionResult,
    playback,
    attemptMove,
    handleUndo,
    handleUndoN,
    performReset,
    requestReset,
    selectPuzzle,
    importProgress,
    resetProgress,
    handleShare,
    playSolverSolution,
    replaySolution,
    stopSolutionPlayback: () => stopSolutionPlayback(true),
    setPlaybackSpeed,
    openHelp: () => {
      stopSolutionPlayback();
      hint.cancel();
      setHelpOpen(true);
    },
    closeHelp: () => setHelpOpen(false),
    openProgress: () => {
      stopSolutionPlayback();
      hint.cancel();
      setProgressOpen(true);
    },
    closeProgress: () => setProgressOpen(false),
    openSolver: () => {
      stopSolutionPlayback();
      hint.cancel();
      setSolverPuzzleId(session.puzzle.id);
    },
    closeSolver: () => setSolverPuzzleId(null),
    closeResetConfirm: () => setResetConfirmPuzzleId(null),
    closeCompletion: () => setCompletionPuzzleId(null),
    goToPuzzles: () => {
      setCompletionPuzzleId(null);
      navigate(puzzlesHash());
    },
    optimalCache,
    saveOptimalRecord: handleSaveOptimal,
    shortcutsOpen,
    closeShortcuts: () => setShortcutsOpen(false),
    manualPaused,
    togglePause: () => {
      if (!session.solved && session.moves > 0) setManualPaused((v) => !v);
    },
    resumeFromPause: () => setManualPaused(false),
    completionAnnouncement: `${session.puzzle.title} solved in ${countLabel(session.moves, "move")} and ${countLabel(session.pushes, "push")}.`,
    resetMessage: `Restarting removes ${countLabel(session.moves, "move")} in this attempt. Your completed personal best is not affected.`,
    totalPuzzles,
    puzzleIndex,
    nextPuzzle,
    nextUnsolvedPuzzle,
    selectNextUnsolved,
    selectPreviousPuzzle,
    selectNextPuzzle,
  } as const;
}
