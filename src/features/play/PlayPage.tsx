import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PUZZLE_METADATA,
  getPuzzleMetadataById,
  SOKOMIND_ORIGINALS,
} from "@/src/catalog/puzzle-metadata";
import { loadPuzzleById } from "@/src/catalog/puzzle-loader";
import {
  isShareableActionLog,
  replayActionLog,
  type PuzzleDefinition,
} from "@/src/core";
import { ConfirmDialog } from "@/src/shared/ui/ConfirmDialog";
import { DeadlockDialog } from "@/src/shared/ui/DeadlockDialog";
import { isOptimal, getOptimalRecord } from "@/src/shared/optimal-cache";
import { useFavorites } from "@/src/shared/use-favorites";
import { HowToPlay } from "@/src/features/help/HowToPlay";
import { CelebrationOverlay, ExperienceControls } from "@/src/features/experience";
import { Board } from "@/src/features/game/Board";
import { CompletionDialog } from "@/src/features/game/CompletionDialog";
import { GameSidebar } from "@/src/features/game/GameSidebar";
import { KeyboardShortcuts } from "@/src/features/game/KeyboardShortcuts";
import { MoveNotation } from "@/src/features/game/MoveNotation";
import { MoveTimeline } from "@/src/features/game/MoveTimeline";
import { useSwipeControls } from "@/src/features/game/use-swipe-controls";
import {
  homeHash,
  Link,
  puzzlesHash,
  puzzleDifficultyHash,
  puzzleCollectionHash,
  useRouter,
} from "@/src/router";
import { usePlayController } from "./use-play-controller";
import { PLAYBACK_SPEEDS } from "./use-solver-playback";
import styles from "./PlayPage.module.css";

const SolverDialog = lazy(() =>
  import("@/src/features/solver/SolverDialog").then((m) => ({
    default: m.SolverDialog,
  })),
);
const ProgressDialog = lazy(() =>
  import("@/src/features/progress/ProgressDialog").then((m) => ({
    default: m.ProgressDialog,
  })),
);

function difficultyLabel(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

interface PlayPageProps {
  readonly puzzleId: string;
  readonly actionLog?: string;
  readonly freshAttempt?: boolean;
}

export function PlayPage({ puzzleId, actionLog, freshAttempt }: PlayPageProps) {
  const puzzleExists = getPuzzleMetadataById(puzzleId) !== undefined;
  const sharedRouteIsValid =
    actionLog === undefined || isShareableActionLog(actionLog);

  if (!puzzleExists || !sharedRouteIsValid) {
    return <InvalidPlayRoute />;
  }

  return (
    <LoadedPlayPage
      puzzleId={puzzleId}
      actionLog={actionLog}
      freshAttempt={freshAttempt}
    />
  );
}

function InvalidPlayRoute() {
  const { navigate } = useRouter();

  useEffect(() => {
    navigate(homeHash(), { replace: true });
  }, [navigate]);

  return null;
}

function LoadedPlayPage({ puzzleId, actionLog, freshAttempt }: PlayPageProps) {
  const { puzzlesReturnHash } = useRouter();
  const [puzzle, setPuzzle] = useState<PuzzleDefinition | null>(null);
  const [failure, setFailure] = useState<Error | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    void loadPuzzleById(puzzleId).then(
      (loaded) => {
        if (!active) return;
        if (!loaded) {
          setFailure(new Error(`Puzzle board not found: ${puzzleId}`));
          return;
        }
        setPuzzle(loaded);
      },
      (error: unknown) => {
        if (!active) return;
        setFailure(error instanceof Error ? error : new Error(String(error)));
      },
    );
    return () => {
      active = false;
    };
  }, [puzzleId, loadAttempt]);

  if (failure) {
    return (
      <main className={styles.page}>
        <section className={styles.loadFailure} role="alert">
          <p className={styles.stageEyebrow}>Puzzle unavailable</p>
          <h1>Couldn&apos;t load this puzzle</h1>
          <p>
            {navigator.onLine
              ? "The puzzle file did not load. The connection may have dropped, or a cached file may be out of date."
              : "You are offline and this puzzle is not cached on this device yet."}
          </p>
          <div className={styles.loadFailureActions}>
            <button
              type="button"
              onClick={() => {
                setFailure(null);
                setPuzzle(null);
                setLoadAttempt((value) => value + 1);
              }}
            >
              Retry loading
            </button>
            <Link href={puzzlesReturnHash}>Back to puzzles</Link>
          </div>
          <details>
            <summary>Error details</summary>
            <code>{failure.message}</code>
          </details>
        </section>
      </main>
    );
  }
  if (!puzzle) {
    return (
      <main className={styles.page}>
        <p aria-busy="true" role="status">Loading puzzle…</p>
      </main>
    );
  }

  if (actionLog !== undefined) {
    try {
      replayActionLog(puzzle, actionLog);
    } catch {
      // Semantic validation must happen before the persistence hooks mount; an
      // impossible shared route must never replace the user's saved attempt.
      return <InvalidPlayRoute />;
    }
  }

  return (
    <ValidatedPlayPage
      puzzle={puzzle}
      actionLog={actionLog}
      freshAttempt={freshAttempt}
    />
  );
}

function ValidatedPlayPage({
  puzzle: definition,
  actionLog,
  freshAttempt,
}: {
  readonly puzzle: PuzzleDefinition;
  readonly actionLog?: string;
  readonly freshAttempt?: boolean;
}) {
  const { puzzlesReturnHash } = useRouter();
  const { isFavorite, toggle: toggleFav } = useFavorites();
  const handleToggleFavorite = useCallback(
    () => toggleFav(definition.id),
    [toggleFav, definition.id],
  );
  const game = usePlayController(definition, actionLog, freshAttempt, {
    onToggleFavorite: handleToggleFavorite,
  });
  const { session, progress } = game;
  const boardWrapRef = useRef<HTMLDivElement>(null);
  const stopButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    document.title = `${session.puzzle.title} · Sokomind`;
  }, [session.puzzle.title]);

  const puzzleFavorited = isFavorite(definition.id);

  useEffect(() => {
    if (game.playback.active) {
      stopButtonRef.current?.focus();
    }
  }, [game.playback.active]);

  useSwipeControls(boardWrapRef, {
    enabled: !game.playback.active,
    onSwipe: game.attemptMove,
  });

  useEffect(() => {
    if (window.innerWidth <= 790) {
      document.getElementById("game-stage")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [session.puzzle.id]);

  const { puzzle } = session;
  const best = progress.completed[puzzle.id];

  const collectionProgress = useMemo(() => {
    const col = puzzle.collection ?? SOKOMIND_ORIGINALS;
    const inCollection = PUZZLE_METADATA.filter(
      (p) => p.difficulty === puzzle.difficulty && (p.collection ?? SOKOMIND_ORIGINALS) === col,
    );
    const solved = inCollection.filter((p) => progress.completed[p.id]).length;
    return { solved, total: inCollection.length };
  }, [puzzle.difficulty, puzzle.collection, progress.completed]);

  const currentIsOptimal = best
    ? isOptimal(game.optimalCache, puzzle.id, best.moves)
    : false;

  return (
    <main className={styles.page}>
      <a href="#game-stage" className={styles.skipLink}>Skip to puzzle</a>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <Link href={puzzlesReturnHash} className={styles.backButton} aria-label="Back to puzzles">
            <span aria-hidden="true">&larr;</span>
          </Link>
          <Link href={homeHash()} className={styles.brandSmall} aria-label="Sokomind home">
            <span className={styles.brandMark} aria-hidden="true">
              <span /><span /><span /><span />
            </span>
            <strong>Sokomind</strong>
          </Link>
        </div>

        <div className={styles.headerStats} role="status" aria-label={`${session.moves} moves, ${session.pushes} pushes`}>
          <span aria-hidden="true">{session.moves}m</span>
          <span aria-hidden="true">{session.pushes}p</span>
        </div>

        <div className={styles.headerActions}>
          <ExperienceControls />
          <button
            aria-label={puzzleFavorited ? "Remove from favorites" : "Add to favorites"}
            aria-pressed={puzzleFavorited}
            className={styles.utilityButton}
            data-active={puzzleFavorited || undefined}
            type="button"
            onClick={handleToggleFavorite}
          >
            <span aria-hidden="true">{puzzleFavorited ? "♥" : "♡"}</span>
            <span className={styles.buttonLabel}>Fav</span>
          </button>
          <button
            aria-label="Open progress"
            className={styles.utilityButton}
            type="button"
            onClick={game.openProgress}
          >
            <span aria-hidden="true">%</span>
            <span className={styles.buttonLabel}>Progress</span>
          </button>
          <button
            aria-label="Open solver laboratory"
            className={styles.utilityButton}
            type="button"
            onClick={game.openSolver}
          >
            <span aria-hidden="true">S</span>
            <span className={styles.buttonLabel}>Solve</span>
          </button>
          <button
            aria-label="Share this puzzle and route"
            className={styles.utilityButton}
            type="button"
            onClick={() => void game.handleShare()}
          >
            <span aria-hidden="true">{"\u2197"}</span>
            <span className={styles.buttonLabel}>Share</span>
          </button>
          <button
            aria-label="How to play"
            className={styles.utilityButton}
            type="button"
            onClick={game.openHelp}
          >
            <span aria-hidden="true">?</span>
            <span className={styles.buttonLabel}>Help</span>
          </button>
        </div>
      </header>

      <nav className={styles.breadcrumb}>
        <Link href={puzzlesHash()}>Puzzles</Link>
        <span aria-hidden="true">&rsaquo;</span>
        <Link href={puzzleDifficultyHash(puzzle.difficulty)}>
          {difficultyLabel(puzzle.difficulty)}
        </Link>
        <span aria-hidden="true">&rsaquo;</span>
        <Link href={puzzleCollectionHash(puzzle.difficulty, puzzle.collection ?? SOKOMIND_ORIGINALS)}>
          {puzzle.collection ?? SOKOMIND_ORIGINALS}
        </Link>
        <span aria-hidden="true">&rsaquo;</span>
        <span className={styles.breadcrumbCurrent} aria-current="page">{puzzle.title}</span>
      </nav>

      {collectionProgress.total > 1 && (
        <div
          className={styles.collectionProgress}
          role="progressbar"
          aria-valuenow={collectionProgress.solved}
          aria-valuemin={0}
          aria-valuemax={collectionProgress.total}
          aria-label={`Collection progress: ${collectionProgress.solved} of ${collectionProgress.total} solved`}
          title={`${collectionProgress.solved} of ${collectionProgress.total} solved in this collection`}
        >
          <span style={{ width: `${(collectionProgress.solved / collectionProgress.total) * 100}%` }} />
        </div>
      )}

      <div className={styles.workspace}>
        <section
          className={styles.stage}
          id="game-stage"
          aria-labelledby="puzzle-title"
          tabIndex={-1}
        >
          <div className={styles.stageHeader}>
            <div>
              <p className={styles.stageEyebrow}>
                {difficultyLabel(puzzle.difficulty)} room
              </p>
              <h1 id="puzzle-title">{puzzle.title}</h1>
            </div>
            <div className={styles.levelPosition}>
              Puzzle
              <strong>
                {String(game.puzzleIndex + 1).padStart(2, "0")} / {game.totalPuzzles}
              </strong>
              <div className={styles.levelNav}>
                <button
                  type="button"
                  aria-label="Previous puzzle"
                  disabled={game.puzzleIndex === 0}
                  onClick={game.selectPreviousPuzzle}
                >
                  &larr;
                </button>
                <button
                  type="button"
                  aria-label="Next puzzle"
                  disabled={!game.nextPuzzle}
                  onClick={game.selectNextPuzzle}
                >
                  &rarr;
                </button>
              </div>
            </div>
          </div>

          <div className={styles.boardWrap} ref={boardWrapRef}>
            {game.manualPaused && (
              <div className={styles.pauseOverlay}>
                <div className={styles.pauseContent}>
                  <span className={styles.pauseIcon} aria-hidden="true">⏸</span>
                  <strong>Paused</strong>
                  <button type="button" onClick={game.resumeFromPause}>
                    Resume
                  </button>
                  <span className={styles.pauseHint}>or press P</span>
                </div>
              </div>
            )}
            <Board
              session={session}
              reduceMotion={game.reducedMotion}
              deadlockedBoxIds={game.deadlockedBoxIds}
            />
          </div>

          <p className={styles.mobileMoveCue}>
            Swipe the board to move, or use the controls below.
          </p>

          <MoveNotation actionLog={session.actionLog} moves={session.moves} />
          <MoveTimeline actionLog={session.actionLog} moves={session.moves} pushes={session.pushes} />

          {puzzle.hint ? (
            <div className={styles.hint}>
              <strong>Room note</strong>
              <span>{puzzle.hint}</span>
            </div>
          ) : null}
        </section>

        <GameSidebar
          best={best}
          controlsDisabled={game.playback.active}
          elapsed={game.elapsed}
          isOptimal={currentIsOptimal}
          optimalMoves={getOptimalRecord(game.optimalCache, puzzle.id)?.moves}
          canHint={game.hint.canHint}
          hintThinking={game.hint.phase === "thinking"}
          session={session}
          onMove={game.attemptMove}
          onHint={game.hint.requestHint}
          onReset={game.requestReset}
          onUndo={game.handleUndo}
          onUndoN={game.handleUndoN}
        />
      </div>

      <KeyboardShortcuts open={game.shortcutsOpen} onClose={game.closeShortcuts} />

      <HowToPlay open={game.helpOpen} onClose={game.closeHelp} />

      {game.progressOpen ? (
        <Suspense fallback={null}>
          <ProgressDialog
            open
            progress={progress}
            puzzles={PUZZLE_METADATA}
            onClose={game.closeProgress}
            onImport={game.importProgress}
            onReset={game.resetProgress}
          />
        </Suspense>
      ) : null}

      {game.solverOpen ? (
        <Suspense fallback={null}>
          <SolverDialog
            onClose={game.closeSolver}
            onPlay={game.playSolverSolution}
            onSaveOptimal={game.saveOptimalRecord}
            open
            session={session}
          />
        </Suspense>
      ) : null}

      <ConfirmDialog
        confirmLabel="Restart room"
        destructive
        message={game.resetMessage}
        onClose={game.closeResetConfirm}
        onConfirm={game.performReset}
        open={game.resetConfirmOpen}
        title="Restart this room?"
      />

      <DeadlockDialog
        open={game.deadlockModalOpen}
        onUndo={game.deadlockUndo}
        onRestart={game.deadlockReset}
        onDismiss={game.closeDeadlockModal}
      />

      <CelebrationOverlay
        active={game.completionOpen}
        message={game.completionAnnouncement}
        variant={isOptimal(game.optimalCache, puzzle.id, session.moves) ? "optimal" : "default"}
      />

      <CompletionDialog
        boxes={puzzle.boxes}
        elapsedTime={game.elapsed}
        isOptimalSolution={isOptimal(game.optimalCache, puzzle.id, session.moves)}
        moves={session.moves}
        newBest={game.completionResult.newBest}
        nextLabel={game.nextPuzzle ? "Next room" : "Browse puzzles"}
        onClose={game.closeCompletion}
        onReplay={game.replaySolution}
        onNext={() =>
          game.nextPuzzle
            ? game.selectPuzzle(game.nextPuzzle.id)
            : game.goToPuzzles()
        }
        onNextUnsolved={
          game.nextUnsolvedPuzzle &&
          game.nextUnsolvedPuzzle.id !== game.nextPuzzle?.id
            ? game.selectNextUnsolved
            : undefined
        }
        open={game.completionOpen}
        previousBest={game.completionResult.previousBest}
        puzzleId={puzzle.id}
        pushes={session.pushes}
        title={puzzle.title}
      />

      {game.playback.active ? (
        <div
          className={styles.playbackBar}
          aria-label={`Playing solver route, move ${game.playback.current} of ${game.playback.total}`}
        >
          <span>
            Playing solution
            <strong>
              {game.playback.current} / {game.playback.total}
            </strong>
          </span>
          <div className={styles.playbackSpeedGroup} role="group" aria-label="Playback speed">
            {PLAYBACK_SPEEDS.map((speed) => (
              <button
                key={speed}
                type="button"
                className={styles.playbackSpeedButton}
                aria-pressed={game.playback.speed === speed}
                data-active={game.playback.speed === speed || undefined}
                onClick={() => game.setPlaybackSpeed(speed)}
              >
                {speed}x
              </button>
            ))}
          </div>
          <button ref={stopButtonRef} type="button" onClick={game.stopSolutionPlayback}>
            Stop
          </button>
        </div>
      ) : null}

      {game.toast ? (
        <div className={styles.toast} role="status" aria-live="polite">
          {game.toast}
        </div>
      ) : null}
    </main>
  );
}
