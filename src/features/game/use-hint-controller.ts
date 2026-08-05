import { useCallback, useEffect, useRef, useState } from "react";
import type { GameSession } from "@/src/core/model";
import {
  type SolutionStep,
} from "@/src/solver";
import { hintUnsolvedMessage } from "./hint-messages";
import {
  createHintWorkerConnection,
  HintWorkerTimeoutError,
  type HintWorkerConnection,
} from "./hint-worker-runtime";

const HINT_STEPS = 3;
const HINT_TIME_LIMIT_MS = 5_000;
const HINT_WORKER_STARTUP_TIMEOUT_MS = 5_000;
const HINT_RESULT_TIMEOUT_MS = HINT_TIME_LIMIT_MS + 2_000;
const HINT_MEMORY_LIMIT = 128 * 1024 * 1024;
const HINT_SOLVER_ID = "classic-astar";

export type HintPhase = "idle" | "thinking" | "playing";

interface SolutionFingerprint {
  readonly puzzleId: string;
  readonly actionLog: string;
}

export interface HintController {
  readonly phase: HintPhase;
  readonly canHint: boolean;
  requestHint(): void;
  cancel(): void;
}

interface HintControllerOptions {
  readonly session: GameSession;
  readonly disabled?: boolean;
  readonly onPlaySteps: (
    steps: readonly SolutionStep[],
    fingerprint: SolutionFingerprint,
  ) => void;
  readonly onToast: (message: string) => void;
}

export function useHintController({
  session,
  disabled = false,
  onPlaySteps,
  onToast,
}: HintControllerOptions): HintController {
  const [phase, setPhase] = useState<HintPhase>("idle");
  const connectionRef = useRef<HintWorkerConnection | null>(null);
  const tokenRef = useRef(0);
  const failureCountRef = useRef(0);
  const cooldownUntilRef = useRef(0);

  const canHint = !disabled && !session.solved && phase === "idle";

  const disposeConnection = useCallback(() => {
    const connection = connectionRef.current;
    connectionRef.current = null;
    connection?.dispose();
  }, []);

  const cancel = useCallback(() => {
    tokenRef.current += 1;
    disposeConnection();
    setPhase("idle");
  }, [disposeConnection]);

  const recordFailure = useCallback((error: unknown, message: string) => {
    console.warn("Sokomind: hint worker failure", error);
    failureCountRef.current += 1;
    if (failureCountRef.current >= 3) {
      cooldownUntilRef.current = Date.now() + 30_000;
      onToast("Hints temporarily unavailable.");
    } else {
      onToast(message);
    }
    setPhase("idle");
  }, [onToast]);

  useEffect(
    () => () => {
      tokenRef.current += 1;
      disposeConnection();
    },
    [disposeConnection],
  );

  useEffect(() => {
    if (!disabled) return;
    tokenRef.current += 1;
    disposeConnection();
  }, [disabled, disposeConnection]);

  useEffect(() => {
    failureCountRef.current = 0;
    cooldownUntilRef.current = 0;
  }, [session.puzzle.id]);

  const requestHint = useCallback(() => {
    if (Date.now() < cooldownUntilRef.current) {
      onToast("Hints temporarily unavailable. Try again shortly.");
      return;
    }
    if (session.solved || disabled) return;

    const token = ++tokenRef.current;
    setPhase("thinking");

    const fingerprint: SolutionFingerprint = {
      puzzleId: session.puzzle.id,
      actionLog: session.actionLog,
    };

    const ensureConnection = (): HintWorkerConnection | null => {
      if (connectionRef.current) return connectionRef.current;
      try {
        const worker = new Worker(
          new URL("../../solver/solver.worker.ts", import.meta.url),
          { type: "module", name: "sokomind-hint" },
        );
        const connection = createHintWorkerConnection(worker, {
          startupTimeoutMs: HINT_WORKER_STARTUP_TIMEOUT_MS,
          onFailure: (error) => {
            if (connectionRef.current !== connection) return;
            connectionRef.current = null;
            tokenRef.current += 1;
            recordFailure(
              error,
              error instanceof HintWorkerTimeoutError
                ? "The hint solver did not respond — try again."
                : "The hint solver stopped unexpectedly — try again.",
            );
          },
        });
        connectionRef.current = connection;
        return connection;
      } catch (error) {
        console.warn("Sokomind: hint worker failed to start", error);
        recordFailure(error, "Could not start the hint solver.");
        return null;
      }
    };

    const connection = ensureConnection();
    if (!connection) return;

    void (async () => {
      try {
        await connection.discover();
        if (tokenRef.current !== token) return;

        const handle = connection.client.run(HINT_SOLVER_ID, {
          board: session.board,
          snapshot: session.snapshot,
          objective: { kind: "moves" },
          limits: {
            maxElapsedMs: HINT_TIME_LIMIT_MS,
            maxMemoryBytes: HINT_MEMORY_LIMIT,
          },
        });

        const result = await connection.waitFor(
          handle.result,
          HINT_RESULT_TIMEOUT_MS,
          "The hint worker did not finish the bounded search.",
        );
        if (tokenRef.current !== token) return;

        if (result.status === "solved") {
          failureCountRef.current = 0;
          const hintSteps = result.solution.steps.slice(0, HINT_STEPS);
          setPhase("playing");
          onPlaySteps(hintSteps, fingerprint);
          setTimeout(() => {
            setPhase((current) => current === "playing" ? "idle" : current);
          }, hintSteps.length * 200 + 300);
        } else if (result.status === "unsolved") {
          setPhase("idle");
          onToast(hintUnsolvedMessage(result.reason));
        } else {
          setPhase("idle");
        }
      } catch (error) {
        if (tokenRef.current !== token) return;
        if (connectionRef.current === connection) {
          connectionRef.current = null;
          connection.dispose();
        }
        recordFailure(error, "Hint search failed — try again.");
      }
    })();
  }, [session, disabled, onPlaySteps, onToast, recordFailure]);

  return { phase, canHint, requestHint, cancel };
}
