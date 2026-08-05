import { useCallback, useEffect, useRef, useState } from "react";
import { type Direction, type GameSession } from "@/src/core";
import type { SolutionStep } from "@/src/solver";

export interface SolutionFingerprint {
  readonly puzzleId: string;
  readonly actionLog: string;
}

export interface SolutionPlayback {
  readonly active: boolean;
  readonly current: number;
  readonly total: number;
}

const EMPTY_PLAYBACK: SolutionPlayback = Object.freeze({
  active: false,
  current: 0,
  total: 0,
});

interface UseSolverPlaybackOptions {
  readonly sessionRef: { readonly current: GameSession };
  readonly reducedMotion: boolean;
  readonly applyDirection: (direction: Direction) => boolean;
  readonly onToast: (message: string) => void;
}

export function useSolverPlayback({
  sessionRef,
  reducedMotion,
  applyDirection,
  onToast,
}: UseSolverPlaybackOptions) {
  const [playback, setPlayback] = useState<SolutionPlayback>(EMPTY_PLAYBACK);
  const playbackRef = useRef<{
    token: number;
    timer?: number;
    active: boolean;
  }>({ token: 0, active: false });

  useEffect(() => () => {
    playbackRef.current.token += 1;
    if (playbackRef.current.timer !== undefined) {
      window.clearTimeout(playbackRef.current.timer);
    }
  }, []);

  const stopSolutionPlayback = useCallback((announce = false) => {
    const runtime = playbackRef.current;
    const wasActive = runtime.active;
    runtime.token += 1;
    runtime.active = false;
    if (runtime.timer !== undefined) {
      window.clearTimeout(runtime.timer);
      runtime.timer = undefined;
    }
    if (wasActive) {
      setPlayback((current) => ({ ...current, active: false }));
      if (announce) onToast("Solution playback stopped.");
    }
  }, [onToast]);

  const playSolverSolution = useCallback((
    steps: readonly SolutionStep[],
    fingerprint: SolutionFingerprint,
  ) => {
    const current = sessionRef.current;
    if (
      current.puzzle.id !== fingerprint.puzzleId ||
      current.actionLog !== fingerprint.actionLog
    ) {
      onToast("The room changed after this search. Run the solver again.");
      return;
    }

    stopSolutionPlayback();
    if (steps.length === 0) {
      onToast("This room is already solved.");
      return;
    }

    const runtime = playbackRef.current;
    const token = runtime.token + 1;
    runtime.token = token;
    runtime.active = true;
    let expectedActionLog = fingerprint.actionLog;
    setPlayback({ active: true, current: 0, total: steps.length });

    const finish = (currentStep: number, message?: string) => {
      if (playbackRef.current.token !== token) return;
      playbackRef.current.active = false;
      playbackRef.current.timer = undefined;
      setPlayback({
        active: false,
        current: currentStep,
        total: steps.length,
      });
      if (message) onToast(message);
    };

    const advance = (index: number) => {
      if (playbackRef.current.token !== token) return;
      const latest = sessionRef.current;
      if (
        latest.puzzle.id !== fingerprint.puzzleId ||
        latest.actionLog !== expectedActionLog
      ) {
        finish(index, "Playback stopped because the room changed.");
        return;
      }

      if (!applyDirection(steps[index].direction)) {
        finish(index, "Playback stopped on an unexpected blocked move.");
        return;
      }

      expectedActionLog = sessionRef.current.actionLog;
      const completed = index + 1;
      if (completed >= steps.length || sessionRef.current.solved) {
        finish(completed);
        return;
      }

      setPlayback({ active: true, current: completed, total: steps.length });
      playbackRef.current.timer = window.setTimeout(
        () => advance(completed),
        reducedMotion ? 45 : 135,
      );
    };

    runtime.timer = window.setTimeout(
      () => advance(0),
      reducedMotion ? 45 : 180,
    );
  }, [
    applyDirection,
    reducedMotion,
    sessionRef,
    stopSolutionPlayback,
    onToast,
  ]);

  return {
    playback,
    playSolverSolution,
    stopSolutionPlayback,
  };
}
