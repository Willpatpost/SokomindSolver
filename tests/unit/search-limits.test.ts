import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createSession,
  type PuzzleDefinition,
} from "../../src/core/index.ts";
import type {
  SolverExecutionContext,
  SolverLimits,
  SolverProgress,
  SolverRequest,
  SolverResult,
} from "../../src/solver/contracts.ts";
import {
  classicAStarSolver,
} from "../../src/solver/implementations/index.ts";

const ONE_PUSH: PuzzleDefinition = {
  id: "one-push",
  title: "One push",
  difficulty: "tutorial",
  boxes: 1,
  rows: ["OOOOO", "ORXSO", "OOOOO"],
};

function request(limits?: SolverLimits): SolverRequest {
  const session = createSession(ONE_PUSH);
  return {
    board: session.board,
    snapshot: session.snapshot,
    objective: { kind: "moves" },
    ...(limits === undefined ? {} : { limits }),
  };
}

function context(
  signal = new AbortController().signal,
  reportProgress: (progress: SolverProgress) => void = () => undefined,
  now: () => number = () => performance.now(),
): SolverExecutionContext {
  return { signal, reportProgress, now };
}

function limited(result: SolverResult): void {
  assert.equal(result.status, "unsolved");
  if (result.status !== "unsolved") return;
  assert.equal(result.reason, "limit-reached");
}

describe("classic search control plane", () => {
  it("enforces elapsed, expanded, generated, and estimated-memory limits", async () => {
    const cases: readonly {
      readonly limits: SolverLimits;
      readonly detail: RegExp;
    }[] = [
      { limits: { maxElapsedMs: 0 }, detail: /elapsed/i },
      { limits: { maxExpandedStates: 0 }, detail: /expanded/i },
      { limits: { maxGeneratedStates: 0 }, detail: /generated/i },
      { limits: { maxMemoryBytes: 1 }, detail: /memory/i },
    ];

    for (const fixture of cases) {
      const result = await classicAStarSolver.solve(
        request(fixture.limits),
        context(),
      );
      limited(result);
      if (result.status !== "unsolved") continue;
      assert.match(result.detail ?? "", fixture.detail);
      assert.ok((result.metrics.expandedStates ?? 0) >= 0);
      assert.ok((result.metrics.generatedStates ?? 0) >= 0);
      assert.ok((result.metrics.peakFrontierSize ?? 0) >= 0);
    }
  });

  it("honors cancellation before work and after preparing the search", async () => {
    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort("cancel before solve");
    const before = await classicAStarSolver.solve(
      request(),
      context(alreadyCancelled.signal),
    );
    assert.equal(before.status, "cancelled");
    assert.equal(before.metrics.expandedStates, 0);

    const duringSearch = new AbortController();
    const phases: string[] = [];
    const during = await classicAStarSolver.solve(
      request(),
      context(duringSearch.signal, (progress) => {
        phases.push(progress.phase);
        if (progress.phase === "searching") {
          duringSearch.abort("cancel after preparation");
        }
      }),
    );
    assert.equal(during.status, "cancelled");
    assert.deepEqual(phases, ["preparing", "searching"]);
    assert.equal(during.metrics.counters?.uniqueStates, 1);
    assert.equal(during.metrics.counters?.retainedStates, 1);
    assert.ok((during.metrics.counters?.estimatedMemoryBytes ?? 0) > 0);
  });

  it("reports preparing, searching, and verifying with complete counters", async () => {
    const updates: SolverProgress[] = [];
    const result = await classicAStarSolver.solve(
      request(),
      context(undefined, (progress) => updates.push(progress)),
    );
    assert.equal(result.status, "solved");
    assert.deepEqual(
      updates.map(({ phase }) => phase),
      ["preparing", "searching", "verifying"],
    );

    let previousExpanded = 0;
    let previousGenerated = 0;
    for (const update of updates) {
      const expanded = update.expandedStates ?? 0;
      const generated = update.generatedStates ?? 0;
      assert.ok(expanded >= previousExpanded);
      assert.ok(generated >= previousGenerated);
      previousExpanded = expanded;
      previousGenerated = generated;
    }

    const counters = result.metrics.counters;
    for (const key of [
      "uniqueStates",
      "retainedStates",
      "duplicateStates",
      "deadlockPrunes",
      "infeasiblePrunes",
      "reopens",
      "reachabilityFloods",
      "heuristicCalls",
      "heuristicCacheHits",
      "frontierSize",
      "maxDepth",
      "estimatedMemoryBytes",
    ]) {
      assert.equal(typeof counters?.[key], "number", `missing ${key}`);
      assert.ok((counters?.[key] ?? -1) >= 0, `negative ${key}`);
    }
  });

  it("allows a generated goal to finish at the generated-state ceiling", async () => {
    const result = await classicAStarSolver.solve(
      request({ maxGeneratedStates: 1 }),
      context(),
    );
    assert.equal(result.status, "solved");
    assert.equal(result.metrics.generatedStates, 1);
  });
});
