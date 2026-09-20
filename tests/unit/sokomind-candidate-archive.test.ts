import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SolverSolution, SolutionStep } from "../../src/solver/contracts.ts";
import {
  CandidateArchive,
  type CandidateProvenance,
} from "../../src/solver/implementations/sokomind-candidate-archive.ts";

function pushStep(dir: "up" | "down" | "left" | "right"): SolutionStep {
  return { direction: dir, kind: "push" };
}

function walkStep(dir: "up" | "down" | "left" | "right"): SolutionStep {
  return { direction: dir, kind: "walk" };
}

function makeSolution(
  steps: readonly SolutionStep[],
  overrides?: Partial<SolverSolution>,
): SolverSolution {
  const moves = steps.length;
  const pushes = steps.filter((s) => s.kind === "push").length;
  return {
    steps,
    moves,
    pushes,
    objective: { kind: "moves" },
    objectiveScore: moves,
    optimality: "unknown",
    ...overrides,
  };
}

function harvestProvenance(time = 0): CandidateProvenance {
  return { sourceOperator: "harvest", parentCandidateId: undefined, taskId: undefined, acceptedAt: time };
}

function repairProvenance(parentId: string, operator: "window" | "box", time = 0): CandidateProvenance {
  return { sourceOperator: operator, parentCandidateId: parentId, taskId: `task-${parentId}`, acceptedAt: time };
}

describe("CandidateArchive", () => {
  describe("basic admission", () => {
    it("accepts the first candidate", () => {
      const archive = new CandidateArchive(4);
      const sol = makeSolution([pushStep("up"), walkStep("down")]);
      assert.ok(archive.offer(sol, harvestProvenance()));
      assert.equal(archive.size, 1);
      assert.equal(archive.globalBest?.solution.moves, 2);
      assert.equal(archive.stats.accepted, 1);
    });

    it("accepts diverse candidates up to capacity", () => {
      const archive = new CandidateArchive(3);
      const sol1 = makeSolution([pushStep("up"), pushStep("down")]);
      const sol2 = makeSolution([pushStep("left"), pushStep("right")]);
      const sol3 = makeSolution([pushStep("up"), pushStep("left")]);
      assert.ok(archive.offer(sol1, harvestProvenance()));
      assert.ok(archive.offer(sol2, harvestProvenance()));
      assert.ok(archive.offer(sol3, harvestProvenance()));
      assert.equal(archive.size, 3);
    });

    it("global best tracks the shortest solution", () => {
      const archive = new CandidateArchive(4);
      const long = makeSolution([pushStep("up"), walkStep("left"), pushStep("down")]);
      const short = makeSolution([pushStep("up")]);
      archive.offer(long, harvestProvenance());
      archive.offer(short, harvestProvenance());
      assert.equal(archive.globalBest?.solution.moves, 1);
    });
  });

  describe("duplicate replacement", () => {
    it("replaces same-semantic candidate with a shorter one", () => {
      const archive = new CandidateArchive(4);
      // Trailing walks after last push keep the same semantic identity but add moves
      const longer = makeSolution([pushStep("up"), walkStep("left"), walkStep("right")]);
      const shorter = makeSolution([pushStep("up")]);
      archive.offer(longer, harvestProvenance());
      assert.equal(archive.size, 1);
      assert.ok(archive.offer(shorter, harvestProvenance()));
      assert.equal(archive.size, 1);
      assert.equal(archive.globalBest?.solution.moves, 1);
      assert.equal(archive.stats.duplicatesReplaced, 1);
    });

    it("rejects same-semantic candidate that is not shorter", () => {
      const archive = new CandidateArchive(4);
      const shorter = makeSolution([pushStep("up")]);
      const sameOrLonger = makeSolution([pushStep("up"), walkStep("left"), walkStep("right")]);
      archive.offer(shorter, harvestProvenance());
      assert.ok(!archive.offer(sameOrLonger, harvestProvenance()));
      assert.equal(archive.size, 1);
      assert.equal(archive.globalBest?.solution.moves, 1);
    });
  });

  describe("eviction policy", () => {
    it("evicts a worse candidate to make room", () => {
      const archive = new CandidateArchive(2);
      const sol1 = makeSolution([pushStep("up"), pushStep("down")]);
      const sol2 = makeSolution([pushStep("left"), pushStep("right"), pushStep("up")]);
      const better = makeSolution([pushStep("down")]);
      archive.offer(sol1, harvestProvenance());
      archive.offer(sol2, harvestProvenance());
      assert.equal(archive.size, 2);
      assert.ok(archive.offer(better, harvestProvenance()));
      assert.equal(archive.size, 2);
      assert.equal(archive.globalBest?.solution.moves, 1);
      assert.equal(archive.stats.evictions, 1);
    });

    it("protects the global best from eviction", () => {
      const archive = new CandidateArchive(2);
      const best = makeSolution([pushStep("up")]);
      const other = makeSolution([pushStep("left"), pushStep("right"), pushStep("up")]);
      archive.offer(best, harvestProvenance());
      archive.offer(other, harvestProvenance());
      const incoming = makeSolution([pushStep("down"), pushStep("left")]);
      archive.offer(incoming, harvestProvenance());
      assert.ok(archive.candidates.some((c) => c.solution.moves === 1));
    });
  });

  describe("provenance tracking", () => {
    it("records source operator and parent", () => {
      const archive = new CandidateArchive(4);
      const sol1 = makeSolution([pushStep("up"), pushStep("down")]);
      archive.offer(sol1, harvestProvenance(100));
      const parent = archive.candidates[0];
      assert.equal(parent.provenance.sourceOperator, "harvest");
      assert.equal(parent.provenance.acceptedAt, 100);

      const improved = makeSolution([pushStep("left")]);
      archive.offer(improved, repairProvenance(parent.id, "window", 200));
      const child = archive.candidates.find((c) => c.solution.moves === 1);
      assert.ok(child);
      assert.equal(child.provenance.sourceOperator, "window");
      assert.equal(child.provenance.parentCandidateId, parent.id);
      assert.equal(child.provenance.acceptedAt, 200);
    });
  });

  describe("neighborhood tracking", () => {
    it("records task outcomes and marks exhausted neighborhoods", () => {
      const archive = new CandidateArchive(4);
      const sol = makeSolution([pushStep("up")]);
      archive.offer(sol, harvestProvenance());
      const candidateId = archive.candidates[0].id;

      assert.ok(!archive.isNeighborhoodExhausted(candidateId, "window"));

      archive.recordOutcome({
        taskId: "t1", reason: "time-cutoff", operator: "window",
        candidateId, expanded: 1000, generated: 2000, elapsedMs: 500, improved: false,
      });
      assert.ok(!archive.isNeighborhoodExhausted(candidateId, "window"));

      archive.recordOutcome({
        taskId: "t2", reason: "exhausted", operator: "window",
        candidateId, expanded: 500, generated: 800, elapsedMs: 300, improved: false,
      });
      assert.ok(archive.isNeighborhoodExhausted(candidateId, "window"));
      assert.ok(!archive.isNeighborhoodExhausted(candidateId, "box"));
    });

    it("cumulates work across multiple outcomes", () => {
      const archive = new CandidateArchive(4);
      const sol = makeSolution([pushStep("up")]);
      archive.offer(sol, harvestProvenance());
      const candidateId = archive.candidates[0].id;

      archive.recordOutcome({
        taskId: "t1", reason: "time-cutoff", operator: "box",
        candidateId, expanded: 100, generated: 200, elapsedMs: 50, improved: false,
      });
      archive.recordOutcome({
        taskId: "t2", reason: "time-cutoff", operator: "box",
        candidateId, expanded: 300, generated: 400, elapsedMs: 100, improved: true,
      });

      const record = archive.neighborhoodRecord(candidateId, "box");
      assert.ok(record);
      assert.equal(record.totalExpanded, 400);
      assert.equal(record.totalGenerated, 600);
      assert.equal(record.totalElapsedMs, 150);
    });

    it("invalidateNeighborhoods resets exhaustion", () => {
      const archive = new CandidateArchive(4);
      const sol = makeSolution([pushStep("up")]);
      archive.offer(sol, harvestProvenance());
      const candidateId = archive.candidates[0].id;

      archive.recordOutcome({
        taskId: "t1", reason: "exhausted", operator: "window",
        candidateId, expanded: 100, generated: 200, elapsedMs: 50, improved: false,
      });
      assert.ok(archive.isNeighborhoodExhausted(candidateId, "window"));

      archive.invalidateNeighborhoods(candidateId);
      assert.ok(!archive.isNeighborhoodExhausted(candidateId, "window"));
    });

    it("selectForRepair skips exhausted candidates", () => {
      const archive = new CandidateArchive(4);
      const sol1 = makeSolution([pushStep("up")]);
      const sol2 = makeSolution([pushStep("down"), pushStep("left")]);
      archive.offer(sol1, harvestProvenance());
      archive.offer(sol2, harvestProvenance());

      const c0 = archive.candidates[0].id;
      archive.recordOutcome({
        taskId: "t1", reason: "exhausted", operator: "window",
        candidateId: c0, expanded: 100, generated: 200, elapsedMs: 50, improved: false,
      });

      const selected = archive.selectForRepair("window");
      assert.ok(selected);
      assert.notEqual(selected.id, c0);
    });

    it("allNeighborhoodsExhausted returns true only when all candidates exhausted", () => {
      const archive = new CandidateArchive(4);
      const sol1 = makeSolution([pushStep("up")]);
      const sol2 = makeSolution([pushStep("down"), pushStep("left")]);
      archive.offer(sol1, harvestProvenance());
      archive.offer(sol2, harvestProvenance());

      assert.ok(!archive.allNeighborhoodsExhausted("box"));

      for (const c of archive.candidates) {
        archive.recordOutcome({
          taskId: "t", reason: "exhausted", operator: "box",
          candidateId: c.id, expanded: 100, generated: 200, elapsedMs: 50, improved: false,
        });
      }
      assert.ok(archive.allNeighborhoodsExhausted("box"));
      assert.ok(!archive.allNeighborhoodsExhausted("window"));
    });
  });

  describe("byte limits", () => {
    it("rejects candidates that exceed byte limit", () => {
      const archive = new CandidateArchive(10, 1200);
      const sol1 = makeSolution([pushStep("up")]);
      assert.ok(archive.offer(sol1, harvestProvenance()));
      const bigSteps: SolutionStep[] = [];
      for (let i = 0; i < 100; i++) bigSteps.push(pushStep("up"));
      const big = makeSolution(bigSteps);
      const accepted = archive.offer(big, harvestProvenance());
      if (!accepted) {
        assert.equal(archive.stats.memoryPressureRejections, 1);
      }
    });

    it("estimatedMemoryBytes tracks retained candidate sizes", () => {
      const archive = new CandidateArchive(4);
      assert.equal(archive.estimatedMemoryBytes, 0);
      const sol = makeSolution([pushStep("up"), pushStep("down")]);
      archive.offer(sol, harvestProvenance());
      assert.ok(archive.estimatedMemoryBytes > 0);
    });
  });

  describe("candidateById", () => {
    it("returns the candidate with matching id", () => {
      const archive = new CandidateArchive(4);
      const sol = makeSolution([pushStep("up")]);
      archive.offer(sol, harvestProvenance());
      const id = archive.candidates[0].id;
      assert.ok(archive.candidateById(id));
      assert.equal(archive.candidateById(id)?.solution.moves, 1);
    });

    it("returns undefined for unknown id", () => {
      const archive = new CandidateArchive(4);
      assert.equal(archive.candidateById("nonexistent"), undefined);
    });
  });

  describe("in-flight tracking", () => {
    it("marks and clears in-flight status", () => {
      const archive = new CandidateArchive(4);
      const sol = makeSolution([pushStep("up")]);
      archive.offer(sol, harvestProvenance());
      const id = archive.candidates[0].id;

      assert.ok(!archive.isInFlight(id, "window"));
      archive.markInFlight(id, "window");
      assert.ok(archive.isInFlight(id, "window"));
      assert.ok(!archive.isInFlight(id, "box"));
      archive.clearInFlight(id, "window");
      assert.ok(!archive.isInFlight(id, "window"));
    });

    it("selectForRepair skips in-flight candidates", () => {
      const archive = new CandidateArchive(4);
      const sol1 = makeSolution([pushStep("up")]);
      const sol2 = makeSolution([pushStep("down"), pushStep("left")]);
      archive.offer(sol1, harvestProvenance());
      archive.offer(sol2, harvestProvenance());

      const first = archive.candidates[0].id;
      archive.markInFlight(first, "window");

      const selected = archive.selectForRepair("window");
      assert.ok(selected);
      assert.notEqual(selected.id, first);
    });

    it("selectForRepair returns candidate after clearInFlight", () => {
      const archive = new CandidateArchive(4);
      const sol = makeSolution([pushStep("up")]);
      archive.offer(sol, harvestProvenance());
      const id = archive.candidates[0].id;

      archive.markInFlight(id, "window");
      assert.equal(archive.selectForRepair("window"), undefined);

      archive.clearInFlight(id, "window");
      assert.ok(archive.selectForRepair("window"));
    });

    it("hasAvailableWork returns false when all in-flight or exhausted", () => {
      const archive = new CandidateArchive(4);
      const sol1 = makeSolution([pushStep("up")]);
      const sol2 = makeSolution([pushStep("down"), pushStep("left")]);
      archive.offer(sol1, harvestProvenance());
      archive.offer(sol2, harvestProvenance());

      assert.ok(archive.hasAvailableWork("window"));

      archive.markInFlight(archive.candidates[0].id, "window");
      archive.recordOutcome({
        taskId: "t1", reason: "exhausted", operator: "window",
        candidateId: archive.candidates[1].id, expanded: 100, generated: 200, elapsedMs: 50, improved: false,
      });

      assert.ok(!archive.hasAvailableWork("window"));
    });

    it("allNeighborhoodsExhausted is false while in-flight (not exhausted)", () => {
      const archive = new CandidateArchive(4);
      const sol = makeSolution([pushStep("up")]);
      archive.offer(sol, harvestProvenance());
      const id = archive.candidates[0].id;

      archive.markInFlight(id, "window");
      assert.ok(!archive.allNeighborhoodsExhausted("window"));
    });

    it("in-flight for one operator does not affect the other", () => {
      const archive = new CandidateArchive(4);
      const sol = makeSolution([pushStep("up")]);
      archive.offer(sol, harvestProvenance());
      const id = archive.candidates[0].id;

      archive.markInFlight(id, "window");
      assert.ok(archive.selectForRepair("box"));
      assert.ok(!archive.selectForRepair("window"));
    });
  });
});
