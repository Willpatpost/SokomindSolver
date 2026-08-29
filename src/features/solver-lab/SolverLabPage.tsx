import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PUZZLE_METADATA, getPuzzleMetadataById } from "../../catalog/puzzle-metadata.ts";
import { loadPuzzleById } from "../../catalog/puzzle-loader.ts";
import {
  createSession,
  isShareableActionLog,
  replayActionLog,
  type GameSession,
  type PuzzleDefinition,
} from "../../core/index.ts";
import { ExperienceControls, useExperience } from "../experience/index.ts";
import { Board } from "../game/Board.tsx";
import {
  buildReplayTrace,
  replayStepDescription,
  replayTraceSession,
  type ReplayTrace,
} from "../replay/replay-comparison.ts";
import {
  formatBytes,
  formatCount,
  formatDuration,
  formatGap,
  formatRate,
  phaseLabel,
  resultSummary,
} from "../solver/solver-format.ts";
import {
  MEMORY_LIMIT_OPTIONS,
  TIME_LIMIT_OPTIONS,
  useSolverController,
} from "../solver/useSolverController.ts";
import {
  homeHash,
  Link,
  playHash,
  solverLabHash,
  useRouter,
} from "../../router/index.ts";
import {
  algorithmLesson,
  buildSearchPopulation,
  compareSolverLabRuns,
  solutionActionLog,
  type SolverLabRunConfiguration,
  type SolverLabRunRecord,
} from "./solver-lab-model.ts";
import { LAB_PLAYBACK_SPEEDS, useLabPlayback } from "./use-lab-playback.ts";
import styles from "./SolverLabPage.module.css";

interface SolverLabPageProps {
  readonly puzzleId: string;
  readonly actionLog?: string;
}

interface LoadedPuzzleState {
  readonly puzzleId: string;
  readonly puzzle?: PuzzleDefinition;
  readonly error?: string;
}

function signed(value: number | undefined, suffix = ""): string {
  if (value === undefined) return "—";
  if (value === 0) return `same${suffix}`;
  return `${value > 0 ? "+" : "−"}${Math.abs(value).toLocaleString()}${suffix}`;
}

function resultLabel(record: SolverLabRunRecord): string {
  const status = record.result.status === "solved"
    ? `${record.result.solution.moves} moves`
    : record.result.status;
  return `${record.configuration.solverName} · ${status}`;
}

function arrowFor(action: string): string {
  return action === "U" ? "↑" : action === "D" ? "↓" : action === "L" ? "←" : "→";
}

export function SolverLabPage({ puzzleId, actionLog }: SolverLabPageProps) {
  const metadata = getPuzzleMetadataById(puzzleId);
  const routeIsValid = metadata !== undefined &&
    (actionLog === undefined || isShareableActionLog(actionLog));
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loaded, setLoaded] = useState<LoadedPuzzleState>({ puzzleId });

  useEffect(() => {
    document.title = "Solver Lab · Sokomind";
  }, []);

  useEffect(() => {
    if (!routeIsValid) return;
    let active = true;
    void loadPuzzleById(puzzleId).then(
      (puzzle) => {
        if (!active) return;
        setLoaded(puzzle
          ? { puzzleId, puzzle }
          : { puzzleId, error: "The selected puzzle board is unavailable." });
      },
      (error: unknown) => {
        if (!active) return;
        setLoaded({
          puzzleId,
          error: error instanceof Error ? error.message : "The puzzle board could not be loaded.",
        });
      },
    );
    return () => {
      active = false;
    };
  }, [loadAttempt, puzzleId, routeIsValid]);

  if (!routeIsValid) {
    return (
      <main className={styles.page}>
        <section className={styles.routeError} role="alert">
          <p className={styles.eyebrow}>Solver Lab</p>
          <h1>That laboratory input is not available</h1>
          <p>Choose a catalog puzzle and begin from a valid saved position.</p>
          <Link href={solverLabHash()}>Open First Steps</Link>
        </section>
      </main>
    );
  }

  if (loaded.puzzleId !== puzzleId || (!loaded.puzzle && !loaded.error)) {
    return (
      <main className={styles.page} aria-busy="true">
        <section className={styles.loading}>
          <p className={styles.eyebrow}>Solver Lab</p>
          <h1>Preparing the workspace</h1>
          <p>Loading {metadata.title} and its exact starting state.</p>
        </section>
      </main>
    );
  }

  if (loaded.error || !loaded.puzzle) {
    return (
      <main className={styles.page}>
        <section className={styles.routeError} role="alert">
          <p className={styles.eyebrow}>Puzzle load failed</p>
          <h1>Couldn&apos;t prepare the Solver Lab</h1>
          <p>{loaded.error}</p>
          <button type="button" onClick={() => {
            setLoaded({ puzzleId });
            setLoadAttempt((value) => value + 1);
          }}>
            Retry loading
          </button>
        </section>
      </main>
    );
  }

  let session: GameSession;
  try {
    session = actionLog ? replayActionLog(loaded.puzzle, actionLog) : createSession(loaded.puzzle);
  } catch {
    return (
      <main className={styles.page}>
        <section className={styles.routeError} role="alert">
          <p className={styles.eyebrow}>Invalid starting state</p>
          <h1>The transferred route cannot be replayed</h1>
          <p>The Lab only accepts positions rebuilt through legal game actions.</p>
          <Link href={solverLabHash(puzzleId)}>Start from the initial position</Link>
        </section>
      </main>
    );
  }

  return <LoadedSolverLab key={`${puzzleId}:${session.actionLog}`} puzzle={loaded.puzzle} session={session} />;
}

function LoadedSolverLab({
  puzzle,
  session,
}: {
  readonly puzzle: PuzzleDefinition;
  readonly session: GameSession;
}) {
  const { navigate } = useRouter();
  const { reducedMotion } = useExperience();
  const solver = useSolverController({ open: true, session });
  const [records, setRecords] = useState<readonly SolverLabRunRecord[]>([]);
  const [watchedId, setWatchedId] = useState("");
  const [leftId, setLeftId] = useState("");
  const [rightId, setRightId] = useState("");
  const activeConfigurationRef = useRef<SolverLabRunConfiguration | null>(null);
  const capturedResultRef = useRef(solver.result);
  const runSequenceRef = useRef(0);

  const lesson = solver.selectedSolver
    ? algorithmLesson(solver.selectedSolver)
    : null;
  const terminalMetrics = solver.result?.metrics;
  const elapsedMs = terminalMetrics?.elapsedMs ?? solver.liveElapsedMs;
  const searchPopulation = buildSearchPopulation(solver.progress, solver.result);
  const populationMax = Math.max(1, ...searchPopulation.map(({ value }) => value));
  const counters = terminalMetrics?.counters ?? solver.progress?.counters;
  const estimatedMemory = counters?.estimatedMemoryBytes;
  const expandedRate = formatRate(solver.expandedStates, elapsedMs);

  const startSearch = useCallback(() => {
    if (!solver.selectedSolver) return;
    activeConfigurationRef.current = Object.freeze({
      solverId: solver.selectedSolver.id,
      solverName: solver.selectedSolver.displayName,
      mode: solver.mode,
      timeLimitMs: solver.timeLimitMs,
      memoryLimitMiB: solver.memoryLimitMiB,
    });
    solver.start();
  }, [solver]);

  useEffect(() => {
    const result = solver.result;
    if (!result || capturedResultRef.current === result) return;
    capturedResultRef.current = result;
    const configuration = activeConfigurationRef.current;
    if (!configuration || !solver.runFingerprint) return;
    let verifiedActionLog: string | undefined;
    const suffix = solutionActionLog(result);
    if (suffix !== undefined) {
      const candidate = `${solver.runFingerprint.actionLog}${suffix}`;
      try {
        const trace = buildReplayTrace(puzzle, candidate);
        if (trace.frames.at(-1)?.solved) verifiedActionLog = candidate;
      } catch {
        // The worker client already verifies results. The Lab independently
        // fails closed if it cannot rebuild display frames through the core.
      }
    }
    const nextRecord: SolverLabRunRecord = Object.freeze({
      id: `lab-run-${++runSequenceRef.current}`,
      puzzleId: puzzle.id,
      actionLog: solver.runFingerprint.actionLog,
      configuration,
      result,
      capturedAt: new Date().toISOString(),
      ...(verifiedActionLog === undefined ? {} : { verifiedActionLog }),
    });
    setRecords((current) => Object.freeze([nextRecord, ...current].slice(0, 6)));
    setWatchedId(nextRecord.id);
  }, [puzzle, solver.result, solver.runFingerprint]);

  const watched = records.find(({ id }) => id === watchedId) ?? records[0];
  const watchedTrace = useMemo<ReplayTrace | null>(() => {
    if (!watched?.verifiedActionLog) return null;
    try {
      return buildReplayTrace(puzzle, watched.verifiedActionLog);
    } catch {
      return null;
    }
  }, [puzzle, watched]);
  const traceStart = watched ? watched.actionLog.length : session.actionLog.length;
  const traceTotal = watchedTrace
    ? Math.max(0, watchedTrace.actionLog.length - traceStart)
    : 0;
  const playback = useLabPlayback(traceTotal, watched?.id ?? "initial");
  const displaySession = watchedTrace
    ? replayTraceSession(watchedTrace, traceStart + playback.step)
    : session;
  const stepDescription = watchedTrace
    ? replayStepDescription(
        watchedTrace,
        traceStart + playback.step,
        watched?.configuration.solverName ?? "Solver route",
      )
    : "Run a search to inspect a verified solution path.";
  const watchedSolutionLog = watched?.result.status === "solved"
    ? solutionActionLog(watched.result) ?? ""
    : "";

  const left = records.find(({ id }) => id === leftId) ?? records[0];
  const right = records.find(({ id }) => id === rightId && id !== left?.id)
    ?? records.find(({ id }) => id !== left?.id);
  const comparison = left && right ? compareSolverLabRuns(left, right) : null;

  const handlePuzzleChange = (nextPuzzleId: string) => {
    solver.cancel("Solver Lab puzzle changed");
    navigate(solverLabHash(nextPuzzleId));
  };

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.topbar}>
          <div className={styles.brandBlock}>
            <Link href={homeHash()} className={styles.back} aria-label="Back to home">←</Link>
            <div>
              <p className={styles.eyebrow}>Optional search workspace</p>
              <h1>Solver Lab</h1>
            </div>
          </div>
          <ExperienceControls />
        </header>

        <section className={styles.intro} aria-labelledby="lab-puzzle-title">
          <div>
            <p className={styles.eyebrow}>Current experiment</p>
            <h2 id="lab-puzzle-title">{puzzle.title}</h2>
            <p>
              Compare how search strategies explore the same legal position.
              Regular play keeps its compact Hint and Solve controls.
            </p>
          </div>
          <div className={styles.puzzleControls}>
            <label>
              <span>Puzzle</span>
              <select
                disabled={solver.running}
                value={puzzle.id}
                onChange={(event) => handlePuzzleChange(event.currentTarget.value)}
              >
                {PUZZLE_METADATA.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.title} · {entry.difficulty}
                  </option>
                ))}
              </select>
            </label>
            <Link href={playHash(puzzle.id, session.actionLog || undefined)}>
              Play this position
            </Link>
            <span>{session.actionLog ? `Transferred after ${session.moves} moves` : "Initial position"}</span>
          </div>
        </section>

        <div className={styles.workspace}>
          <div className={styles.controlColumn}>
            <section className={styles.panel} aria-labelledby="experiment-setup-title">
              <div className={styles.panelHeading}>
                <div>
                  <p className={styles.eyebrow}>Experiment</p>
                  <h2 id="experiment-setup-title">Search setup</h2>
                </div>
                <span data-phase={solver.uiPhase}>{solver.uiPhase}</span>
              </div>

              <div className={styles.fields}>
                <label>
                  <span>Algorithm</span>
                  <select
                    disabled={solver.running || solver.solvers.length === 0}
                    value={solver.selectedSolverId}
                    onChange={(event) => solver.setSelectedSolverId(event.currentTarget.value)}
                  >
                    {solver.solvers.length === 0 ? <option value="">Discovering…</option> : null}
                    {solver.solvers.map((metadata) => (
                      <option value={metadata.id} key={metadata.id}>{metadata.displayName}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Time limit</span>
                  <select
                    disabled={solver.running}
                    value={solver.timeLimitMs}
                    onChange={(event) => solver.setTimeLimitMs(Number(event.currentTarget.value))}
                  >
                    {TIME_LIMIT_OPTIONS.map((option) => (
                      <option value={option.value} key={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Memory limit</span>
                  <select
                    disabled={solver.running}
                    value={solver.memoryLimitMiB}
                    onChange={(event) => solver.setMemoryLimitMiB(Number(event.currentTarget.value))}
                  >
                    {MEMORY_LIMIT_OPTIONS.map((option) => (
                      <option value={option.value} key={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                {solver.selectedSolverId === "sokomind-solver" ? (
                  <label>
                    <span>Search mode</span>
                    <select
                      disabled={solver.running}
                      value={solver.mode}
                      onChange={(event) => solver.setMode(event.currentTarget.value as "fast" | "quality" | "optimal")}
                    >
                      <option value="fast">Fast</option>
                      <option value="quality">Quality</option>
                      <option value="optimal">Optimal</option>
                    </select>
                  </label>
                ) : null}
              </div>

              {solver.selectedSolver && lesson ? (
                <div className={styles.lesson}>
                  <strong>{solver.selectedSolver.displayName}</strong>
                  <p>{lesson.strategy}</p>
                  <dl>
                    <div><dt>Heuristic</dt><dd>{lesson.heuristic}</dd></div>
                    <div><dt>Guarantee</dt><dd>{lesson.guarantee}</dd></div>
                  </dl>
                </div>
              ) : null}

              <div className={styles.runActions}>
                <button
                  type="button"
                  className={styles.run}
                  onClick={startSearch}
                  disabled={solver.running || !solver.selectedSolver || solver.uiPhase === "loading" || solver.uiPhase === "error"}
                >
                  Run search
                </button>
                <button
                  type="button"
                  onClick={() => solver.cancel()}
                  disabled={!solver.running || solver.uiPhase === "cancelling"}
                >
                  {solver.uiPhase === "cancelling" ? "Cancelling…" : "Cancel search"}
                </button>
                {solver.uiPhase === "error" ? (
                  <button type="button" onClick={solver.retryConnection}>Reconnect worker</button>
                ) : null}
              </div>
              <p className={styles.status} role="status" aria-live="polite">
                {solver.statusMessage}
              </p>
              {solver.result ? <p className={styles.resultSummary}>{resultSummary(solver.result)}</p> : null}
            </section>

            <section className={styles.panel} aria-labelledby="state-space-title">
              <div className={styles.panelHeading}>
                <div>
                  <p className={styles.eyebrow}>Live worker telemetry</p>
                  <h2 id="state-space-title">State-space population</h2>
                </div>
                <span>{phaseLabel(solver.progress?.phase)}</span>
              </div>
              <figure className={styles.population}>
                <div className={styles.populationBars}>
                  {searchPopulation.map((metric) => (
                    <div className={styles.populationRow} key={metric.id} data-kind={metric.id}>
                      <div><strong>{metric.label}</strong><span>{formatCount(metric.value)}</span></div>
                      <div className={styles.populationTrack} aria-hidden="true">
                        <span style={{ width: `${Math.max(metric.value > 0 ? 4 : 0, (metric.value / populationMax) * 100)}%` }} />
                      </div>
                      <small>{metric.description}</small>
                    </div>
                  ))}
                </div>
                <figcaption>
                  Counts are periodic snapshots, not a spatial map of every state. “Visited” means expanded; “frontier” means queued.
                </figcaption>
              </figure>
              <dl className={styles.liveMetrics}>
                <div><dt>Elapsed</dt><dd>{formatDuration(elapsedMs)}</dd></div>
                <div><dt>Expansion rate</dt><dd>{expandedRate}</dd></div>
                <div><dt>Peak frontier</dt><dd>{formatCount(solver.peakFrontierSize)}</dd></div>
                <div><dt>Estimated memory</dt><dd>{formatBytes(estimatedMemory)}</dd></div>
                <div><dt>Lower bound</dt><dd>{formatCount(solver.proof?.lowerBound ?? solver.liveProof?.lowerBound)}</dd></div>
                <div><dt>Proof gap</dt><dd>{formatGap(solver.proof?.gap ?? solver.liveProof?.gap)}</dd></div>
              </dl>
            </section>
          </div>

          <section className={`${styles.panel} ${styles.playbackPanel}`} aria-labelledby="solution-path-title">
            <div className={styles.panelHeading}>
              <div>
                <p className={styles.eyebrow}>Replay-verified output</p>
                <h2 id="solution-path-title">Solution path</h2>
              </div>
              <span>{watched ? resultLabel(watched) : "No run selected"}</span>
            </div>
            {records.length > 0 ? (
              <label className={styles.watchSelect}>
                <span>Watch result</span>
                <select value={watched?.id ?? ""} onChange={(event) => setWatchedId(event.currentTarget.value)}>
                  {records.map((record) => <option key={record.id} value={record.id}>{resultLabel(record)}</option>)}
                </select>
              </label>
            ) : null}
            <div className={styles.boardWrap}>
              <Board
                session={displaySession}
                reduceMotion={reducedMotion}
                constrainToViewport
                testId="solver-lab-board"
              />
            </div>
            <p className="sr-only" aria-live="polite">{stepDescription}</p>
            {watchedTrace ? (
              <>
                <div className={styles.pathStrip} aria-label="Solution directions">
                  {watchedSolutionLog.split("").map((action, index) => (
                    <span key={`${index}-${action}`} data-current={playback.step === index + 1 || undefined} data-past={index < playback.step || undefined}>
                      <span aria-hidden="true">{arrowFor(action)}</span>
                      <span className="sr-only">Move {index + 1}: {action}</span>
                    </span>
                  ))}
                </div>
                <input
                  type="range"
                  aria-label="Solution playback position"
                  min={0}
                  max={traceTotal}
                  value={playback.step}
                  onChange={(event) => playback.seek(Number(event.currentTarget.value))}
                />
                <div className={styles.playbackControls}>
                  <button type="button" onClick={playback.first} disabled={playback.step === 0}>First</button>
                  <button type="button" onClick={playback.previous} disabled={playback.step === 0}>Step back</button>
                  <button type="button" className={styles.play} onClick={playback.toggle}>
                    {playback.playing ? "Pause playback" : "Play route"}
                  </button>
                  <button type="button" onClick={playback.next} disabled={playback.step >= traceTotal}>Step forward</button>
                  <button type="button" onClick={playback.last} disabled={playback.step >= traceTotal}>Last</button>
                  <label>
                    <span>Speed</span>
                    <select value={playback.speed} onChange={(event) => playback.setSpeed(Number(event.currentTarget.value))}>
                      {LAB_PLAYBACK_SPEEDS.map((speed) => <option value={speed} key={speed}>{speed}×</option>)}
                    </select>
                  </label>
                </div>
                <p className={styles.playbackStatus} role="status">
                  Move {playback.step} of {traceTotal} · {displaySession.pushes - session.pushes} pushes in this route
                </p>
              </>
            ) : (
              <div className={styles.emptyOutput}>
                <strong>{watched?.result.status === "solved" ? "Display verification unavailable" : "No verified route yet"}</strong>
                <p>Run a solver that returns a solution, then play, pause, seek, or step through the route here.</p>
              </div>
            )}
          </section>
        </div>

        <section className={`${styles.panel} ${styles.comparisonPanel}`} aria-labelledby="comparison-title">
          <div className={styles.panelHeading}>
            <div>
              <p className={styles.eyebrow}>Retained in this workspace</p>
              <h2 id="comparison-title">Side-by-side run comparison</h2>
            </div>
            <span>{records.length} of 6 runs</span>
          </div>
          {records.length >= 2 && left && right && comparison ? (
            <>
              <div className={styles.compareSelectors}>
                <label><span>Left result</span><select value={left.id} onChange={(event) => setLeftId(event.currentTarget.value)}>{records.map((record) => <option value={record.id} key={record.id}>{resultLabel(record)}</option>)}</select></label>
                <label><span>Right result</span><select value={right.id} onChange={(event) => setRightId(event.currentTarget.value)}>{records.filter(({ id }) => id !== left.id).map((record) => <option value={record.id} key={record.id}>{resultLabel(record)}</option>)}</select></label>
              </div>
              <div className={styles.comparisonGrid}>
                {[left, right].map((record) => (
                  <article key={record.id}>
                    <p>{record.configuration.solverName}</p>
                    <h3>{record.result.status === "solved" ? "Route found" : record.result.status}</h3>
                    <dl>
                      <div><dt>Elapsed</dt><dd>{formatDuration(record.result.metrics.elapsedMs)}</dd></div>
                      <div><dt>Expanded</dt><dd>{formatCount(record.result.metrics.expandedStates)}</dd></div>
                      <div><dt>Generated</dt><dd>{formatCount(record.result.metrics.generatedStates)}</dd></div>
                      <div><dt>Moves</dt><dd>{record.result.status === "solved" ? formatCount(record.result.solution.moves) : "—"}</dd></div>
                      <div><dt>Pushes</dt><dd>{record.result.status === "solved" ? formatCount(record.result.solution.pushes) : "—"}</dd></div>
                      <div><dt>Mode</dt><dd>{record.configuration.solverId === "sokomind-solver" ? record.configuration.mode : "Fixed"}</dd></div>
                    </dl>
                  </article>
                ))}
              </div>
              <div className={styles.deltaSummary}>
                <strong>{comparison.sameInput ? "Same puzzle and starting state" : "Inputs differ"}</strong>
                <span>{comparison.sameLimits ? "Limits match" : "Limits or mode differ"}</span>
                <dl>
                  <div><dt>Elapsed Δ</dt><dd>{signed(comparison.elapsedDeltaMs, " ms")}</dd></div>
                  <div><dt>Expanded Δ</dt><dd>{signed(comparison.expandedDelta)}</dd></div>
                  <div><dt>Generated Δ</dt><dd>{signed(comparison.generatedDelta)}</dd></div>
                  <div><dt>Moves Δ</dt><dd>{signed(comparison.moveDelta)}</dd></div>
                  <div><dt>Pushes Δ</dt><dd>{signed(comparison.pushDelta)}</dd></div>
                </dl>
              </div>
            </>
          ) : (
            <div className={styles.emptyComparison}>
              <strong>Run two experiments to compare them</strong>
              <p>Keep the limits fixed and change the algorithm to see how strategy affects work and route quality.</p>
            </div>
          )}
        </section>

        <section className={styles.methodNote} aria-labelledby="metric-method-title">
          <p className={styles.eyebrow}>How to read the Lab</p>
          <h2 id="metric-method-title">Metrics have one definition everywhere</h2>
          <p>
            Expanded is a state removed from the frontier for successor generation. Generated counts produced successors before deduplication. Frontier is the latest queued population, peak frontier is its largest reported size, and estimated memory is the solver&apos;s retained-structure estimate rather than browser process memory. Pushes describe a returned route; every search still minimizes or prioritizes total moves according to its stated guarantee.
          </p>
        </section>
      </div>
    </main>
  );
}
