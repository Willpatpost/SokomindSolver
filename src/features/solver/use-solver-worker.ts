import { useCallback, useEffect, useRef, useState } from "react";
import {
  createSolverWorkerClient,
  type SolverMetadata,
  type SolverRunHandle,
  type SolverWorkerClient,
} from "@/src/solver";
import {
  errorMessage, isAStar, WORKER_STARTUP_TIMEOUT_MS, type SolverSharedState,
} from "./solver-internals";
import type { SolverLogEntry } from "./solver-ui-types";

interface UseSolverWorkerOptions extends SolverSharedState {
  readonly open: boolean;
  readonly appendLog: (msg: string, tone?: SolverLogEntry["tone"], ms?: number) => void;
  readonly resetLog: (entries?: readonly SolverLogEntry[]) => void;
}

export function useSolverWorker({
  open, appendLog, resetLog, setUiPhase, setError, setStatusMessage,
}: UseSolverWorkerOptions) {
  const [workerGeneration, setWorkerGeneration] = useState(0);
  const [solvers, setSolvers] = useState<readonly SolverMetadata[]>([]);
  const [selectedSolverId, setSelectedSolverId] = useState("");
  const clientRef = useRef<SolverWorkerClient | null>(null);
  const runRef = useRef<SolverRunHandle | null>(null);
  const runTokenRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    let active = true, failed = false, startupTimer = 0;
    let client: SolverWorkerClient | null = null;
    let worker: Worker | null = null;

    const fail = (reason: unknown) => {
      console.warn("Sokomind: solver worker failure", reason);
      if (!active || failed) return;
      failed = true;
      window.clearTimeout(startupTimer);
      runTokenRef.current += 1;
      runRef.current = null;
      const msg = errorMessage(reason);
      setUiPhase("error");
      setError(msg);
      setStatusMessage(`Solver unavailable: ${msg}`);
      appendLog(msg, "error");
      client?.dispose();
      if (clientRef.current === client) clientRef.current = null;
    };

    try {
      worker = new Worker(
        new URL("../../solver/solver.worker.ts", import.meta.url),
        { type: "module", name: "sokomind-search" },
      );
      const onWorkerError = (e: ErrorEvent) => fail(e.message || "The solver worker failed to start.");
      const onMessageError = () => fail("The solver worker returned an unreadable message.");
      worker.addEventListener("error", onWorkerError);
      worker.addEventListener("messageerror", onMessageError);

      client = createSolverWorkerClient(worker);
      clientRef.current = client;
      startupTimer = window.setTimeout(
        () => fail("The solver worker did not respond within 5 seconds."),
        WORKER_STARTUP_TIMEOUT_MS,
      );

      void client.discover().then((metadata) => {
        if (!active || failed) return;
        window.clearTimeout(startupTimer);
        if (metadata.length === 0) { fail("No search algorithms were registered in the worker."); return; }
        const discovered = Object.freeze([...metadata]);
        setSolvers(discovered);
        setSelectedSolverId((cur) => {
          if (discovered.some(({ id }) => id === cur)) return cur;
          return discovered.find(({ id }) => id === "sokomind-solver")?.id
            ?? discovered.find(isAStar)?.id ?? discovered[0]?.id ?? "";
        });
        const n = metadata.length;
        setUiPhase("ready");
        setStatusMessage(`${n} search ${n === 1 ? "algorithm is" : "algorithms are"} ready.`);
        appendLog(`Ready with ${n} search ${n === 1 ? "algorithm" : "algorithms"}.`, "success");
      }, fail);

      return () => {
        active = false;
        window.clearTimeout(startupTimer);
        worker?.removeEventListener("error", onWorkerError);
        worker?.removeEventListener("messageerror", onMessageError);
        runTokenRef.current += 1;
        runRef.current?.cancel("Solver controller disposed");
        runRef.current = null;
        client?.dispose();
        if (clientRef.current === client) clientRef.current = null;
      };
    } catch (caught) {
      console.warn("Sokomind: solver worker construction failed", caught);
      fail(caught);
      return () => {
        active = false;
        window.clearTimeout(startupTimer);
        client?.dispose();
        if (clientRef.current === client) clientRef.current = null;
      };
    }
  }, [appendLog, open, workerGeneration, setUiPhase, setError, setStatusMessage]);

  const retryConnection = useCallback(() => {
    setSolvers([]);
    setSelectedSolverId("");
    setError(null);
    resetLog([Object.freeze({
      id: Date.now(), elapsedMs: 0,
      message: "Discovering available search algorithms.", tone: "info" as const,
    })]);
    setUiPhase("loading");
    setStatusMessage("Retrying the solver worker connection.");
    setWorkerGeneration((c) => c + 1);
  }, [resetLog, setError, setUiPhase, setStatusMessage]);

  return { clientRef, solvers, selectedSolverId, setSelectedSolverId, retryConnection, runRef, runTokenRef };
}
