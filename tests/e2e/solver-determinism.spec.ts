/**
 * Cross-environment determinism test (spec criterion 17).
 *
 * Verifies that the classic A* solver produces bit-identical solutions and
 * metrics when run in Node (the Playwright test runner) vs the browser
 * (via the app's bundled solver worker).
 *
 * The test:
 *  1. Runs the solver in Node by importing the adapter directly.
 *  2. Opens the app in Chromium, discovers the solver worker URL, creates a
 *     dedicated worker, and runs the same puzzle through the worker protocol.
 *  3. Asserts identical action sequences, move/push counts, and deterministic
 *     search counters. Preprocessing wall-clock telemetry is descriptive.
 */
import { expect, test, type Page } from "@playwright/test";
import { createSession, type PuzzleDefinition } from "../../src/core/index.ts";
import type {
  SolverExecutionContext,
  SolverRequest,
  SolverResult,
} from "../../src/solver/contracts.ts";
import { classicAStarSolver } from "../../src/solver/implementations/index.ts";

// ---------------------------------------------------------------------------
// Small puzzles that solve in well under 1 second
// ---------------------------------------------------------------------------

const PUZZLES: readonly PuzzleDefinition[] = [
  {
    id: "det-ultra-tiny",
    title: "First Steps",
    difficulty: "tutorial",
    boxes: 1,
    rows: ["OOOOO", "O R O", "O A O", "O a O", "OOOOO"],
  },
  {
    id: "det-tutorial-push",
    title: "One Push Wonder",
    difficulty: "tutorial",
    boxes: 1,
    rows: ["OOOOO", "O XSO", "O   O", "O R O", "OOOOO"],
  },
  {
    id: "det-two-generic",
    title: "Two generic boxes",
    difficulty: "tutorial",
    boxes: 2,
    rows: [
      "OOOOOOO",
      "O SS  O",
      "O XX  O",
      "O  R  O",
      "O     O",
      "OOOOOOO",
    ],
  },
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deterministic fields we compare across environments. */
interface DeterministicFingerprint {
  readonly status: string;
  readonly steps: readonly { direction: string; kind: string }[];
  readonly moves: number;
  readonly pushes: number;
  readonly expandedStates: number | undefined;
  readonly generatedStates: number | undefined;
  readonly counters: Readonly<Record<string, number>> | undefined;
}

const VOLATILE_TIMING_COUNTERS = new Set([
  "pdbBuildTimeMs",
  "deadlockTableBuildTimeMs",
]);

function deterministicCounters(
  counters: Readonly<Record<string, number>> | undefined,
): Readonly<Record<string, number>> {
  return Object.fromEntries(
    Object.entries(counters ?? {}).filter(
      ([name]) => !VOLATILE_TIMING_COUNTERS.has(name),
    ),
  );
}

function requestFor(puzzle: PuzzleDefinition): SolverRequest {
  const session = createSession(puzzle);
  return {
    board: session.board,
    snapshot: session.snapshot,
    objective: { kind: "moves" },
  };
}

function executionContext(): SolverExecutionContext {
  return {
    signal: new AbortController().signal,
    reportProgress: () => undefined,
    now: () => performance.now(),
  };
}

function fingerprint(result: SolverResult): DeterministicFingerprint {
  if (result.status !== "solved") {
    throw new Error(`Expected solved, got ${result.status}`);
  }
  return {
    status: result.status,
    steps: result.solution.steps.map((s) => ({
      direction: s.direction,
      kind: s.kind,
    })),
    moves: result.solution.moves,
    pushes: result.solution.pushes,
    expandedStates: result.metrics.expandedStates,
    generatedStates: result.metrics.generatedStates,
    counters: result.metrics.counters,
  };
}

async function solveInNode(puzzle: PuzzleDefinition): Promise<DeterministicFingerprint> {
  const request = requestFor(puzzle);
  const result = await classicAStarSolver.solve(request, executionContext());
  return fingerprint(result);
}

/**
 * Discover the solver worker URL by opening the solver dialog and capturing
 * the worker creation event. Returns the absolute URL of the solver worker
 * script.
 */
async function discoverWorkerUrl(page: Page): Promise<string> {
  const solverWorkerPattern = /solver\.worker/u;
  const workerUrlPromise = new Promise<string>((resolve) => {
    page.on("worker", (worker) => {
      const url = worker.url();
      if (solverWorkerPattern.test(url)) {
        resolve(url);
      }
    });
  });

  // Open the solver dialog to trigger worker creation
  await page.getByRole("button", { name: "Open solver laboratory" }).click();
  const dialog = page.getByRole("dialog", { name: "Find a route" });
  await expect(dialog).toBeVisible();

  const workerUrl = await workerUrlPromise;

  // Close the dialog — we only needed to discover the URL.
  // Wait for the original worker to be disposed so it does not interfere.
  await dialog.getByRole("button", { name: "Close solver" }).click();
  await expect(dialog).toBeHidden();
  const solverWorkerAsset = /solver\.worker/u;
  await expect
    .poll(() =>
      page
        .workers()
        .filter((w) => solverWorkerAsset.test(w.url())).length,
    )
    .toBe(0);

  return workerUrl;
}

/**
 * Run the classic A* solver inside the browser by spawning a dedicated
 * solver worker and communicating through the worker protocol. Returns the
 * full SolverResult.
 */
async function solveInBrowser(
  page: Page,
  workerUrl: string,
  puzzle: PuzzleDefinition,
): Promise<DeterministicFingerprint> {
  // Build the SolverRequest in Node (it's JSON-safe) and pass it in
  const request = requestFor(puzzle);
  const serializedRequest = JSON.parse(JSON.stringify(request)) as SolverRequest;

  const result = await page.evaluate<DeterministicFingerprint, { url: string; req: unknown }>(
    async (args) => {
      const PROTOCOL_VERSION = 1;

      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(
          () => reject(new Error("Browser solver timed out after 30 seconds")),
          30_000,
        );

        const worker = new Worker(args.url, {
          type: "module",
          name: "determinism-test",
        });

        worker.onerror = (e) => {
          clearTimeout(timeoutId);
          reject(new Error(`Worker error: ${e.message}`));
        };

        worker.onmessage = (event) => {
          const data = event.data;
          if (data.type === "solver/ready") {
            // Worker is ready — send the solve command
            worker.postMessage({
              protocolVersion: PROTOCOL_VERSION,
              type: "solver/run",
              jobId: "determinism-test-job",
              solverId: "classic-astar",
              request: args.req,
            });
          } else if (data.type === "solver/result") {
            clearTimeout(timeoutId);
            const solverResult = data.result;
            if (solverResult.status !== "solved" || !solverResult.solution) {
              worker.terminate();
              reject(
                new Error(
                  `Browser solver returned status: ${solverResult.status}`,
                ),
              );
              return;
            }
            worker.terminate();
            resolve({
              status: solverResult.status,
              steps: solverResult.solution.steps.map(
                (s: { direction: string; kind: string }) => ({
                  direction: s.direction,
                  kind: s.kind,
                }),
              ),
              moves: solverResult.solution.moves,
              pushes: solverResult.solution.pushes,
              expandedStates: solverResult.metrics.expandedStates,
              generatedStates: solverResult.metrics.generatedStates,
              counters: solverResult.metrics.counters,
            });
          } else if (data.type === "solver/failure") {
            clearTimeout(timeoutId);
            worker.terminate();
            reject(
              new Error(`Browser solver failed: ${data.error?.message}`),
            );
          }
          // Ignore progress events
        };

        // Trigger discovery — the worker will respond with solver/ready
        worker.postMessage({
          protocolVersion: PROTOCOL_VERSION,
          type: "solver/discover",
        });
      });
    },
    { url: workerUrl, req: serializedRequest },
  );

  return result;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("cross-environment determinism (spec criterion 17)", () => {
  // Run only in Chromium — this test verifies Node-vs-browser agreement,
  // not cross-browser layout differences.
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "Cross-environment determinism is tested in Chromium only",
  );

  for (const puzzle of PUZZLES) {
    test(`Node and browser produce identical A* results for "${puzzle.title}"`, async ({
      page,
    }) => {
      // Step 1: Solve in Node
      const nodeResult = await solveInNode(puzzle);
      expect(nodeResult.status).toBe("solved");

      // Step 2: Navigate to the app and discover the solver worker URL
      await page.goto("./#/play/ultra-tiny");
      await expect(
        page.getByRole("heading", { name: "First Steps" }),
      ).toBeVisible();
      const workerUrl = await discoverWorkerUrl(page);

      // Step 3: Solve in the browser via the worker protocol
      const browserResult = await solveInBrowser(page, workerUrl, puzzle);
      expect(browserResult.status).toBe("solved");

      // Step 4: Assert bitwise-identical results
      expect(browserResult.steps).toEqual(nodeResult.steps);
      expect(browserResult.moves).toBe(nodeResult.moves);
      expect(browserResult.pushes).toBe(nodeResult.pushes);
      expect(browserResult.expandedStates).toBe(nodeResult.expandedStates);
      expect(browserResult.generatedStates).toBe(nodeResult.generatedStates);
      expect(deterministicCounters(browserResult.counters)).toEqual(
        deterministicCounters(nodeResult.counters),
      );
    });
  }
});
