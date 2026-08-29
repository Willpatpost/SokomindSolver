import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import type { PuzzleDefinition } from "../../core/model.ts";
import {
  loadPersonalBestRoutes,
  type SavedPersonalBestRoute,
} from "../../shared/personal-best-routes.ts";
import { Modal } from "../../shared/ui/Modal.tsx";
import { useExperience } from "../experience/index.ts";
import { Board } from "../game/Board.tsx";
import { formatTime } from "../game/timer-math.ts";
import {
  buildReplayTrace,
  compareReplayTraces,
  replayStepDescription,
  replayTraceSession,
  type ReplayTrace,
} from "./replay-comparison.ts";
import styles from "./ReplayComparisonDialog.module.css";

export interface CurrentReplayRoute {
  readonly actionLog: string;
  readonly moves: number;
  readonly pushes: number;
  readonly elapsedMs?: number;
}

interface ReplayComparisonDialogProps {
  readonly open: boolean;
  readonly puzzle: PuzzleDefinition;
  readonly currentRoute?: CurrentReplayRoute;
  readonly onClose: () => void;
}

interface ReplayOption {
  readonly id: string;
  readonly label: string;
  readonly actionLog: string;
  readonly moves: number;
  readonly pushes: number;
  readonly elapsedMs?: number;
  readonly completedAt?: string;
  readonly trace: ReplayTrace;
}

interface LoadedRoutes {
  readonly puzzleId: string;
  readonly status: "loading" | "ready" | "missing" | "stale" | "corrupt" | "unavailable";
  readonly routes: readonly SavedPersonalBestRoute[];
}

type TimelineStyle = CSSProperties & { "--marker-position": string };

function validCurrentOption(
  puzzle: PuzzleDefinition,
  currentRoute: CurrentReplayRoute | undefined,
): ReplayOption | undefined {
  if (!currentRoute) return undefined;
  try {
    const trace = buildReplayTrace(puzzle, currentRoute.actionLog);
    const final = trace.frames.at(-1)!;
    if (
      !final.solved ||
      final.moves !== currentRoute.moves ||
      final.pushes !== currentRoute.pushes
    ) {
      return undefined;
    }
    return Object.freeze({
      id: "current",
      label: "Current solve",
      ...currentRoute,
      trace,
    });
  } catch {
    return undefined;
  }
}

function savedOption(
  puzzle: PuzzleDefinition,
  route: SavedPersonalBestRoute,
  index: number,
): ReplayOption {
  return Object.freeze({
    id: route.routeId,
    label: index === 0 ? "Personal best" : `Earlier best ${index}`,
    actionLog: route.actionLog,
    moves: route.moves,
    pushes: route.pushes,
    ...(route.elapsedMs === undefined ? {} : { elapsedMs: route.elapsedMs }),
    completedAt: route.completedAt,
    trace: buildReplayTrace(puzzle, route.actionLog),
  });
}

function optionMeta(option: ReplayOption): string {
  const parts = [
    `${option.moves} ${option.moves === 1 ? "move" : "moves"}`,
    `${option.pushes} ${option.pushes === 1 ? "push" : "pushes"}`,
  ];
  if (option.elapsedMs) parts.push(formatTime(option.elapsedMs));
  return parts.join(" · ");
}

export function ReplayComparisonDialog({
  open,
  puzzle,
  currentRoute,
  onClose,
}: ReplayComparisonDialogProps) {
  const { reducedMotion } = useExperience();
  const [loaded, setLoaded] = useState<LoadedRoutes>({
    puzzleId: "",
    status: "loading",
    routes: [],
  });
  const [primaryId, setPrimaryId] = useState("");
  const [referenceId, setReferenceId] = useState("");
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [ghostEnabled, setGhostEnabled] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void loadPersonalBestRoutes(puzzle).then((read) => {
      if (cancelled) return;
      setLoaded({
        puzzleId: puzzle.id,
        status: read.status,
        routes: read.routes,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [open, puzzle]);

  const options = useMemo(() => {
    const result: ReplayOption[] = [];
    const current = validCurrentOption(puzzle, currentRoute);
    if (current) result.push(current);
    if (loaded.puzzleId === puzzle.id) {
      loaded.routes.forEach((route, index) => {
        if (result.some((option) => option.actionLog === route.actionLog)) return;
        try {
          result.push(savedOption(puzzle, route, index));
        } catch {
          // The repository already verifies on read; fail closed if the puzzle
          // changes between that read and this render.
        }
      });
    }
    return Object.freeze(result);
  }, [currentRoute, loaded, puzzle]);

  const primary = options.find((option) => option.id === primaryId) ?? options[0];
  const selectedReference = options.find((option) => option.id === referenceId);
  const reference = selectedReference && selectedReference.id !== primary?.id
    ? selectedReference
    : options.find((option) => option.id !== primary?.id);
  const maxStep = primary?.actionLog.length ?? 0;
  const safeStep = Math.min(step, maxStep);
  const primaryFrame = primary
    ? replayTraceSession(primary.trace, safeStep)
    : undefined;
  const referenceStep = reference
    ? Math.min(safeStep, reference.actionLog.length)
    : 0;
  const referenceFrame = reference?.trace.frames[referenceStep];
  const comparison = useMemo(
    () => primary && reference
      ? compareReplayTraces(primary.trace, reference.trace)
      : undefined,
    [primary, reference],
  );

  useEffect(() => {
    if (!open || !playing || !primary || safeStep >= maxStep) return;
    const timer = window.setTimeout(() => {
      const next = Math.min(safeStep + 1, maxStep);
      setStep(next);
      if (next >= maxStep) setPlaying(false);
    }, Math.round(520 / speed));
    return () => window.clearTimeout(timer);
  }, [maxStep, open, playing, primary, safeStep, speed]);

  function selectPrimary(id: string) {
    setPrimaryId(id);
    if (id === reference?.id) {
      setReferenceId(options.find((option) => option.id !== id)?.id ?? "");
    }
    setStep(0);
    setPlaying(false);
  }

  function selectReference(id: string) {
    setReferenceId(id);
    setStep(0);
    setPlaying(false);
  }

  function close() {
    setPlaying(false);
    onClose();
  }

  function handleShortcuts(event: KeyboardEvent<HTMLElement>) {
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLButtonElement
    ) {
      return;
    }
    if (event.key === " ") {
      event.preventDefault();
      setPlaying((value) => !value && safeStep < maxStep);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      setPlaying(false);
      setStep((value) => Math.max(0, value - 1));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setPlaying(false);
      setStep((value) => Math.min(maxStep, value + 1));
    }
  }

  const currentDescription = primary
    ? replayStepDescription(primary.trace, safeStep, primary.label)
    : "No replay selected.";
  const loadStatus = loaded.puzzleId === puzzle.id ? loaded.status : "loading";

  return (
    <Modal
      className={styles.modal}
      describedBy="replay-description"
      labelledBy="replay-title"
      onClose={close}
      open={open}
    >
      <section className={styles.dialog} onKeyDown={handleShortcuts}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>Replay study</p>
            <h2 id="replay-title">{puzzle.title}</h2>
            <p id="replay-description">
              Watch a verified route, seek to any move, and compare where two attempts separate.
            </p>
          </div>
          <button type="button" className={styles.close} aria-label="Close replay study" onClick={close}>
            &times;
          </button>
        </header>

        {loadStatus === "loading" && options.length === 0 ? (
          <p className={styles.state} role="status">Loading verified replays…</p>
        ) : options.length === 0 ? (
          <div className={styles.state} role="status">
            <strong>No verified replay is available.</strong>
            <span>Your summary record is safe. Complete this puzzle again to save a replay.</span>
          </div>
        ) : primary && primaryFrame ? (
          <>
            <div className={styles.routeSelectors}>
              <label>
                <span>Watch</span>
                <select value={primary.id} onChange={(event) => selectPrimary(event.target.value)}>
                  {options.map((option) => (
                    <option value={option.id} key={option.id}>{option.label} — {option.moves} moves</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Compare with</span>
                <select
                  disabled={options.length < 2}
                  value={reference?.id ?? ""}
                  onChange={(event) => selectReference(event.target.value)}
                >
                  {options.filter((option) => option.id !== primary.id).map((option) => (
                    <option value={option.id} key={option.id}>{option.label} — {option.moves} moves</option>
                  ))}
                  {options.length < 2 ? <option value="">No earlier best</option> : null}
                </select>
              </label>
            </div>

            <div className={styles.replayStage}>
              <Board
                ghostSnapshot={ghostEnabled ? referenceFrame : null}
                reduceMotion={reducedMotion}
                session={primaryFrame}
                testId="replay-board"
              />
            </div>

            <div className={styles.timeline}>
              <div className={styles.timelineHeading}>
                <strong>Move {safeStep} / {maxStep}</strong>
                <span>{optionMeta(primary)}</span>
              </div>
              <div className={styles.rangeWrap}>
                <input
                  aria-label={`Replay position, move ${safeStep} of ${maxStep}`}
                  max={maxStep}
                  min={0}
                  onChange={(event) => {
                    setPlaying(false);
                    setStep(Number(event.target.value));
                  }}
                  type="range"
                  value={safeStep}
                />
                {comparison?.markers.map((marker) => (
                  <button
                    type="button"
                    className={styles.marker}
                    data-kind={marker.kind}
                    key={`${marker.kind}-${marker.step}`}
                    onClick={() => {
                      setPlaying(false);
                      setStep(Math.min(marker.step, maxStep));
                    }}
                    style={{
                      "--marker-position": `${maxStep === 0 ? 0 : (marker.step / maxStep) * 100}%`,
                    } as TimelineStyle}
                    title={marker.label}
                    aria-label={marker.label}
                  >
                    {marker.symbol}
                  </button>
                ))}
              </div>
              <div className={styles.controls} aria-label="Replay controls">
                <button type="button" onClick={() => { setPlaying(false); setStep(0); }} aria-label="Go to replay start">|&larr;</button>
                <button type="button" onClick={() => { setPlaying(false); setStep((value) => Math.max(0, value - 1)); }} aria-label="Previous replay move">&larr;</button>
                <button
                  type="button"
                  className={styles.play}
                  data-autofocus
                  disabled={maxStep === 0}
                  onClick={() => {
                    if (safeStep >= maxStep) setStep(0);
                    setPlaying((value) => !value);
                  }}
                  aria-label={playing ? "Pause replay" : "Play replay"}
                >
                  {playing ? "Pause" : "Play"}
                </button>
                <button type="button" onClick={() => { setPlaying(false); setStep((value) => Math.min(maxStep, value + 1)); }} aria-label="Next replay move">&rarr;</button>
                <button type="button" onClick={() => { setPlaying(false); setStep(maxStep); }} aria-label="Go to replay end">&rarr;|</button>
                <label className={styles.speed}>
                  <span>Speed</span>
                  <select aria-label="Replay speed" value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>
                    <option value={0.5}>0.5×</option>
                    <option value={1}>1×</option>
                    <option value={2}>2×</option>
                    <option value={4}>4×</option>
                  </select>
                </label>
              </div>
            </div>

            <div className={styles.comparisonPanel}>
              <div className={styles.comparisonHeading}>
                <h3>Route comparison</h3>
                <label className={styles.ghostToggle}>
                  <input
                    type="checkbox"
                    checked={ghostEnabled}
                    disabled={!reference}
                    onChange={(event) => setGhostEnabled(event.target.checked)}
                  />
                  <span>Show comparison ghost</span>
                </label>
              </div>
              {comparison && reference ? (
                <>
                  <p className={styles.summary}>{comparison.summary}</p>
                  <p className={styles.referenceMeta}>{reference.label}: {optionMeta(reference)}</p>
                  {comparison.markers.length > 0 ? (
                    <ul className={styles.markerLegend}>
                      {comparison.markers.map((marker) => (
                        <li key={`legend-${marker.kind}-${marker.step}`}>
                          <span data-kind={marker.kind}>{marker.symbol}</span>
                          {marker.label}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className={styles.identical}>No divergence markers — these routes are identical.</p>
                  )}
                </>
              ) : (
                <p className={styles.summary}>Save another improved personal best to compare two routes.</p>
              )}
              {reducedMotion ? (
                <p className={styles.motionNote}>Reduced motion is on. Frames update instantly; the text below describes every position.</p>
              ) : null}
              <p className={styles.stepDescription} role="status" aria-live="polite">
                {currentDescription}
                {reference && referenceFrame
                  ? ` Comparison keeper at row ${referenceFrame.robot.row + 1}, column ${referenceFrame.robot.column + 1}.`
                  : ""}
              </p>
            </div>

            <p className={styles.keyboardHelp}>
              Keyboard: focus the timeline for native arrow, Home, and End seeking. Outside a control, use Space to play or pause and Left/Right to step.
            </p>
          </>
        ) : null}
      </section>
    </Modal>
  );
}
