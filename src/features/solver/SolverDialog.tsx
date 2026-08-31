import { useMemo, useRef, useState } from "react";
import type { GameSession } from "@/src/core";
import type { SolutionStep } from "@/src/solver";
import type { OptimalRecord } from "@/src/shared/optimal-cache";
import { Modal } from "@/src/shared/ui/Modal";
import {
  formatBytes,
  formatCount,
  formatDuration,
  formatGap,
  formatProofAlgorithm,
  formatRate,
  phaseLabel,
  resultSummary,
} from "./solver-format";
import {
  MEMORY_LIMIT_OPTIONS,
  TIME_LIMIT_OPTIONS,
  useSolverController,
} from "./useSolverController";
import type { SolverRunFingerprint } from "./solver-ui-types";
import { Link, solverLabHash } from "@/src/router";
import styles from "./SolverDialog.module.css";

export interface SolverDialogProps {
  readonly open: boolean;
  readonly session: GameSession;
  readonly onClose: () => void;
  readonly onPlay: (
    steps: readonly SolutionStep[],
    fingerprint: SolverRunFingerprint,
  ) => void;
  readonly onSaveOptimal?: (
    record: OptimalRecord,
  ) => Promise<boolean>;
}

export function SolverDialog({
  open,
  session,
  onClose,
  onPlay,
  onSaveOptimal,
}: SolverDialogProps) {
  const [optimalSaveStatus, setOptimalSaveStatus] = useState<
    "idle" | "saving" | "saved" | "failed"
  >("idle");
  const optimalSaveAttemptRef = useRef(0);
  const solver = useSolverController({ open, session });
  const terminalMetrics = solver.result?.metrics;
  const elapsedMs = terminalMetrics?.elapsedMs ?? solver.liveElapsedMs;
  const rate = formatRate(solver.expandedStates, elapsedMs);
  const solvedResult =
    solver.result?.status === "solved" ? solver.result : null;
  const canSaveGlobalOptimal =
    solvedResult?.solution.optimality === "proven" &&
    solver.runFingerprint?.actionLog === "";
  const prunedStates =
    (solver.counters?.deadlockPrunes ?? 0) +
    (solver.counters?.infeasiblePrunes ?? 0);

  const srAnnouncement = useMemo(() => {
    switch (solver.uiPhase) {
      case "running":
        return "Solver started";
      case "solved":
        if (solvedResult) {
          return `Solution found: ${solvedResult.solution.moves} moves, ${solvedResult.solution.pushes} pushes`;
        }
        return "Solution found";
      case "unsolved":
        return "Solver timed out";
      case "cancelled":
        return "Solver cancelled";
      default:
        return "";
    }
  }, [solver.uiPhase, solvedResult]);

  const handleClose = () => {
    solver.cancel("Solver dialog closed");
    optimalSaveAttemptRef.current += 1;
    setOptimalSaveStatus("idle");
    onClose();
  };

  const handlePlay = () => {
    if (!solvedResult || !solver.runFingerprint || !solver.canPlay) return;
    onPlay(solvedResult.solution.steps, solver.runFingerprint);
    onClose();
  };

  return (
    <Modal
      className={styles.modal}
      labelledBy="solver-dialog-title"
      describedBy="solver-dialog-description"
      mobileSheet
      onClose={handleClose}
      open={open}
    >
      <section
        className={styles.dialog}
        aria-busy={solver.running || undefined}
      >
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>Search laboratory</p>
            <h2 id="solver-dialog-title">Find a route</h2>
            <p id="solver-dialog-description">
              Search from the exact position currently shown on the board.
            </p>
          </div>
          <button
            aria-label="Close solver"
            className={styles.close}
            onClick={handleClose}
            type="button"
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {srAnnouncement}
        </div>

        <div className={styles.content}>
          <div className={styles.setupColumn}>
            <section className={styles.card} aria-labelledby="search-setup-title">
              <div className={styles.sectionHeading}>
                <div>
                  <p>Configuration</p>
                  <h3 id="search-setup-title">Search setup</h3>
                </div>
                <span data-state={solver.uiPhase}>{solver.uiPhase}</span>
              </div>

              <details className={styles.advancedSettings}>
                <summary>
                  <span>Advanced settings</span>
                  <small>Algorithm, limits, and search mode</small>
                </summary>
                <div className={styles.advancedContent}>
                  <div className={styles.fields}>
                <label>
                  <span>Algorithm</span>
                  <select
                    disabled={solver.running || solver.solvers.length === 0}
                    onChange={(event) =>
                      solver.setSelectedSolverId(event.currentTarget.value)
                    }
                    value={solver.selectedSolverId}
                  >
                    {solver.solvers.length === 0 ? (
                      <option value="">Discovering solvers…</option>
                    ) : null}
                    {solver.solvers.map((metadata) => (
                      <option key={metadata.id} value={metadata.id}>
                        {metadata.displayName}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  <span>Time limit</span>
                  <select
                    disabled={solver.running}
                    onChange={(event) =>
                      solver.setTimeLimitMs(Number(event.currentTarget.value))
                    }
                    value={solver.timeLimitMs}
                  >
                    {TIME_LIMIT_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  <span>Memory limit</span>
                  <select
                    disabled={solver.running}
                    onChange={(event) =>
                      solver.setMemoryLimitMiB(Number(event.currentTarget.value))
                    }
                    value={solver.memoryLimitMiB}
                  >
                    {MEMORY_LIMIT_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                {solver.selectedSolverId === "sokomind-solver" ? (
                <label>
                  <span>Mode</span>
                  <select
                    disabled={solver.running}
                    onChange={(event) =>
                      solver.setMode(
                        event.currentTarget.value as
                          | "fast"
                          | "quality"
                          | "optimal",
                      )
                    }
                    value={solver.mode}
                  >
                    <option value="fast">Fast</option>
                    <option value="quality">Quality</option>
                    <option value="optimal">Optimal</option>
                  </select>
                </label>
                ) : null}
                  </div>

              {solver.selectedSolver ? (
                <p className={styles.description}>
                  {solver.selectedSolver.description}
                </p>
              ) : null}

                  <p className={styles.note}>
                    All searches evaluate routes by total movement. A* and IDA*
                    prove a minimum; the other searches return their best verified
                    route. Pushes remain statistics, not an objective.
                  </p>
                </div>
              </details>

              <div className={styles.primaryActions}>
                <button
                  className={styles.start}
                  disabled={
                    solver.running ||
                    !solver.selectedSolver ||
                    solver.uiPhase === "loading" ||
                    solver.uiPhase === "error"
                  }
                  onClick={solver.start}
                  type="button"
                >
                  Start search
                </button>
                <button
                  className={styles.cancel}
                  disabled={!solver.running || solver.uiPhase === "cancelling"}
                  onClick={() => solver.cancel()}
                  type="button"
                >
                  {solver.uiPhase === "cancelling"
                    ? "Cancelling…"
                    : "Cancel"}
                </button>
                <Link
                  className={styles.labLink}
                  href={solverLabHash(session.puzzle.id, session.actionLog || undefined)}
                  onClick={handleClose}
                >
                  Open full Solver Lab
                </Link>
              </div>

              {solver.uiPhase === "error" ? (
                <button
                  className={styles.retry}
                  onClick={solver.retryConnection}
                  type="button"
                >
                  Retry worker connection
                </button>
              ) : null}
            </section>

            <section className={styles.card} aria-labelledby="metrics-title">
              <div className={styles.sectionHeading}>
                <div>
                  <p>Telemetry</p>
                  <h3 id="metrics-title">Live metrics</h3>
                </div>
                <span>{phaseLabel(solver.progress?.phase)}</span>
              </div>

              <dl className={styles.metrics}>
                <div>
                  <dt>Elapsed</dt>
                  <dd>{formatDuration(elapsedMs)}</dd>
                </div>
                <div>
                  <dt>Expanded</dt>
                  <dd>{formatCount(solver.expandedStates)}</dd>
                </div>
                <div>
                  <dt>Generated</dt>
                  <dd>{formatCount(solver.generatedStates)}</dd>
                </div>
                <div>
                  <dt>Frontier</dt>
                  <dd>{formatCount(solver.frontierSize)}</dd>
                </div>
                <div>
                  <dt>Peak frontier</dt>
                  <dd>{formatCount(solver.peakFrontierSize)}</dd>
                </div>
                <div>
                  <dt>Expansion rate</dt>
                  <dd>{rate}</dd>
                </div>
              </dl>

              {solver.progress?.fraction !== undefined ? (
                <div className={styles.progressWrap}>
                  <progress
                    aria-label="Search progress"
                    max={1}
                    value={solver.progress.fraction}
                  />
                  <span>
                    {Math.round(solver.progress.fraction * 100)}%
                  </span>
                </div>
              ) : null}

              <p
                className={styles.liveStatus}
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                {solver.statusMessage}
              </p>
              {solver.progress?.detail ? (
                <p className={styles.detail}>{solver.progress.detail}</p>
              ) : null}

              {solver.counters ? (
                <details className={styles.diagnostics}>
                  <summary>Search diagnostics</summary>
                  <dl>
                    <div>
                      <dt>Unique states</dt>
                      <dd>{formatCount(solver.counters.uniqueStates)}</dd>
                    </div>
                    <div>
                      <dt>Duplicates</dt>
                      <dd>{formatCount(solver.counters.duplicateStates)}</dd>
                    </div>
                    <div>
                      <dt>Pruned</dt>
                      <dd>{formatCount(prunedStates)}</dd>
                    </div>
                    <div>
                      <dt>Heuristic calls</dt>
                      <dd>{formatCount(solver.counters.heuristicCalls)}</dd>
                    </div>
                    <div>
                      <dt>Reachability scans</dt>
                      <dd>{formatCount(solver.counters.reachabilityFloods)}</dd>
                    </div>
                    <div>
                      <dt>Estimated memory</dt>
                      <dd>
                        {formatBytes(solver.counters.estimatedMemoryBytes)}
                      </dd>
                    </div>
                    {solver.proof || solver.liveProof ? (
                      <>
                        <div>
                          <dt>Lower bound</dt>
                          <dd>
                            {formatCount(
                              solver.proof?.lowerBound ??
                                solver.liveProof?.lowerBound,
                            )}
                          </dd>
                        </div>
                        <div>
                          <dt>Upper bound</dt>
                          <dd>
                            {formatCount(
                              solver.proof?.upperBound ??
                                solver.liveProof?.upperBound,
                            )}
                          </dd>
                        </div>
                        <div>
                          <dt>Gap</dt>
                          <dd>
                            {formatGap(
                              solver.proof?.gap ?? solver.liveProof?.gap,
                            )}
                          </dd>
                        </div>
                        {solver.proof?.algorithm ? (
                          <div>
                            <dt>Proof algorithm</dt>
                            <dd>
                              {formatProofAlgorithm(solver.proof.algorithm)}
                            </dd>
                          </div>
                        ) : null}
                      </>
                    ) : null}
                  </dl>
                </details>
              ) : null}
            </section>

            {solver.result ? (
              <section
                className={styles.result}
                data-status={solver.result.status}
                aria-labelledby="solver-result-title"
              >
                <div>
                  <p>Search result</p>
                  <h3 id="solver-result-title">
                    {solver.result.status === "solved"
                      ? "Route found"
                      : solver.result.status === "cancelled"
                        ? "Search stopped"
                        : "No route returned"}
                  </h3>
                </div>
                <p>{resultSummary(solver.result)}</p>
                {solvedResult && solver.resultSolver ? (
                  <p className={styles.foundBy}>
                    Found by {solver.resultSolver.displayName}.
                  </p>
                ) : null}

                {solvedResult ? (
                  <>
                    <dl className={styles.solutionMetrics}>
                      <div>
                        <dt>Moves</dt>
                        <dd>{formatCount(solvedResult.solution.moves)}</dd>
                      </div>
                      <div>
                        <dt>Pushes</dt>
                        <dd>{formatCount(solvedResult.solution.pushes)}</dd>
                      </div>
                      <div>
                        <dt>Guarantee</dt>
                        <dd>
                          {solver.proof?.kind === "optimal"
                            ? "Proven optimal"
                            : solver.proof?.kind === "bounded"
                              ? `Best found (gap: ${formatGap(solver.proof.gap)})`
                              : solver.proof?.kind === "unsolvable"
                                ? "Proven unsolvable"
                                : solver.resultSolver?.capabilities.quality ===
                                    "bounded"
                                  ? "Best found"
                                  : "First found"}
                        </dd>
                      </div>
                    </dl>
                    {canSaveGlobalOptimal && onSaveOptimal ? (
                      <>
                        <button
                          className={styles.play}
                          disabled={
                            optimalSaveStatus === "saving" ||
                            optimalSaveStatus === "saved"
                          }
                          onClick={async () => {
                            const attempt =
                              optimalSaveAttemptRef.current + 1;
                            optimalSaveAttemptRef.current = attempt;
                            setOptimalSaveStatus("saving");
                            const saved = await onSaveOptimal({
                              moves: solvedResult.solution.moves,
                              pushes: solvedResult.solution.pushes,
                            }).catch(() => false);
                            if (optimalSaveAttemptRef.current === attempt) {
                              setOptimalSaveStatus(
                                saved ? "saved" : "failed",
                              );
                            }
                          }}
                          type="button"
                        >
                          {optimalSaveStatus === "saving"
                            ? "Saving optimal…"
                            : optimalSaveStatus === "saved"
                              ? "Optimal saved ★"
                              : optimalSaveStatus === "failed"
                                ? "Retry saving optimal"
                                : "Save as proven optimal"}
                        </button>
                        {optimalSaveStatus === "failed" ? (
                          <p className={styles.note} role="status">
                            The optimal proof is available for this session,
                            but browser storage could not save it.
                          </p>
                        ) : null}
                      </>
                    ) : null}
                    {solvedResult.solution.optimality === "proven" &&
                    !canSaveGlobalOptimal ? (
                      <p className={styles.note}>
                        This route is optimal from the current position. Start
                        from the puzzle&apos;s initial position to save a
                        global optimal record.
                      </p>
                    ) : null}
                    <button
                      className={styles.play}
                      disabled={!solver.canPlay}
                      onClick={handlePlay}
                      type="button"
                    >
                      Play solution
                    </button>
                    {!solver.canPlay ? (
                      <p className={styles.stale}>
                        The board changed after this search. Run it again to
                        play a verified route.
                      </p>
                    ) : null}
                  </>
                ) : null}
              </section>
            ) : null}
          </div>

          <section className={styles.logCard} aria-labelledby="solver-log-title">
            <div className={styles.sectionHeading}>
              <div>
                <p>Timeline</p>
                <h3 id="solver-log-title">Status log</h3>
              </div>
              <span>{solver.logEntries.length} entries</span>
            </div>

            <ol className={styles.log}>
              {solver.logEntries.map((entry) => (
                <li data-tone={entry.tone} key={entry.id}>
                  <time>{formatDuration(entry.elapsedMs)}</time>
                  <span>{entry.message}</span>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </section>
    </Modal>
  );
}
