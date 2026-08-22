import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

type Box = [number, number, string];

interface MatchingDomains {
  complete: boolean;
  reason: string | null;
  allowedColumnsByRow: number[][];
  finiteEdges: number;
  allowedEdges: number;
}

interface LabelDetail {
  boxIndices: number[];
  targets: string[];
  costs: number[][];
  assignment: { cost: number; matching?: number[] };
  matchingDomains?: MatchingDomains;
}

interface DoorwayPlan {
  tasks: Array<{ direction: "export" | "import"; target: string }>;
  penalty: number;
  proof: {
    complete: boolean;
    finiteEdges: number;
    allowedEdges: number;
    eliminatedEdges: number;
    mandatoryCrossings: number;
    optionalCrossings: number;
    unclassifiedRelations: number;
  };
}

interface AssignmentDetail {
  labels: Map<string, LabelDetail>;
  assignedTargets: Map<number, string>;
  cost: number;
  doorwayPlan?: DoorwayPlan;
}

interface HeuristicApi {
  perfectMatchingDomains(detail: LabelDetail): MatchingDomains;
  doorwayClearanceRequirement(
    exports: Array<{ box: string }>,
    imports: Array<{ box: string }>,
    room: {
      gate: string;
      doorwayLanes: Array<{
        inside: string;
        importPossible: boolean;
        exportPossible: boolean;
      }>;
      depths: Map<string, number>;
    },
  ): {
    minimumExportsBeforeFirstImport: number;
    lateralExportCounts: readonly number[];
    method: string;
    hardPruning: boolean;
  };
  doorwayAllowedImports(
    exportCount: number,
    importCount: number,
    completedExports: number,
    minimumExportsBeforeFirstImport: number,
  ): number;
  assignmentDoorwayPlan(
    boxes: Box[],
    board: {
      discoveryAssignmentMemo: WeakMap<Box[], AssignmentDetail>;
      topology: { rooms: Array<{ cells: Set<string>; gate: string }> };
    },
    discovery: boolean,
  ): DoorwayPlan;
}

function loadSourceHeuristic(): HeuristicApi {
  const source = readFileSync(fileURLToPath(new URL(
    "../../src/solver/implementations/sokomind-engine/source/heuristic.js",
    import.meta.url,
  )), "utf8");
  const sandbox: Record<string, unknown> = {
    pkey: (y: number, x: number) => `${y},${x}`,
  };
  runInContext(source, createContext(sandbox));
  return sandbox.SokomindHeuristic as HeuristicApi;
}

function hallTightDetail(): LabelDetail {
  return {
    boxIndices: [0, 1, 2, 3],
    targets: ["10,0", "10,1", "0,2", "0,3"],
    costs: [
      [0, 0, Infinity, Infinity],
      [0, 0, Infinity, Infinity],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    assignment: { cost: 0, matching: [0, 1, 2, 3, 4] },
  };
}

function permutations(values: number[]): number[][] {
  if (values.length <= 1) return [values];
  return values.flatMap((value, index) =>
    permutations(values.filter((_, candidate) => candidate !== index))
      .map(rest => [value, ...rest]));
}

function doorwayPlanFor(
  heuristic: HeuristicApi,
  boxes: Box[],
  detail: LabelDetail,
  roomCells: string[],
): DoorwayPlan {
  const assignment: AssignmentDetail = {
    labels: new Map([["X", detail]]),
    assignedTargets: new Map(detail.boxIndices.map((boxIndex, row) =>
      [boxIndex, detail.targets[row]])),
    cost: detail.assignment.cost,
  };
  const discoveryAssignmentMemo = new WeakMap<Box[], AssignmentDetail>();
  discoveryAssignmentMemo.set(boxes, assignment);
  return heuristic.assignmentDoorwayPlan(boxes, {
    discoveryAssignmentMemo,
    topology: { rooms: [{ cells: new Set(roomCells), gate: "9,0" }] },
  }, true);
}

describe("Sokomind perfect-matching doorway domains", () => {
  it("matches an exhaustive oracle for every three-by-three feasibility graph", () => {
    const heuristic = loadSourceHeuristic();
    const size = 3;
    const matchings = permutations([0, 1, 2]);
    for (let mask = 0; mask < 1 << (size * size); mask++) {
      const costs = Array.from({ length: size }, (_, row) =>
        Array.from({ length: size }, (_, column) =>
          mask & (1 << (row * size + column)) ? 0 : Infinity));
      const feasible = matchings.filter(matching =>
        matching.every((row, column) => Number.isFinite(costs[row][column])));
      if (!feasible.length) continue;
      const detail: LabelDetail = {
        boxIndices: [0, 1, 2],
        targets: ["g0", "g1", "g2"],
        costs,
        assignment: { cost: 0, matching: [0, ...feasible[0].map(row => row + 1)] },
      };
      const actual = heuristic.perfectMatchingDomains(detail);
      assert.equal(actual.complete, true);
      for (let row = 0; row < size; row++) {
        for (let column = 0; column < size; column++) {
          const expected = feasible.some(matching => matching[column] === row);
          assert.equal(
            actual.allowedColumnsByRow[row].includes(column),
            expected,
            `mask ${mask}, edge ${row}->${column}`,
          );
        }
      }
    }
  });

  it("removes finite edges excluded by a Hall-tight subset and caches the proof", () => {
    const heuristic = loadSourceHeuristic();
    const detail = hallTightDetail();
    const domains = heuristic.perfectMatchingDomains(detail);

    assert.equal(domains.complete, true);
    assert.deepEqual(
      Array.from(domains.allowedColumnsByRow, columns => Array.from(columns)),
      [[0, 1], [0, 1], [2, 3], [2, 3]],
    );
    assert.equal(domains.finiteEdges, 12);
    assert.equal(domains.allowedEdges, 8);
    assert.equal(heuristic.perfectMatchingDomains(detail), domains);
  });

  it("recognizes Grand Hall's four-export doorway-clearance phase", () => {
    const heuristic = loadSourceHeuristic();
    const exports = [2, 4, 6, 8, 10, 12].map(x => ({ box: `12,${x}` }));
    const imports = ["10,6", "10,8", "7,2", "7,12"].map(box => ({ box }));
    const requirement = heuristic.doorwayClearanceRequirement(exports, imports, {
      gate: "10,7",
      doorwayLanes: [{
        inside: "11,7",
        importPossible: true,
        exportPossible: true,
      }],
      depths: new Map(exports.map(task => [task.box, 2])),
    });

    assert.equal(requirement.minimumExportsBeforeFirstImport, 4);
    assert.deepEqual(Array.from(requirement.lateralExportCounts), [3, 3]);
    assert.equal(requirement.method, "shallow-two-sided-barrier");
    assert.equal(requirement.hardPruning, false);
    assert.equal(heuristic.doorwayAllowedImports(6, 4, 3, 4), 0);
    assert.equal(heuristic.doorwayAllowedImports(6, 4, 4, 4), 2);
    assert.equal(heuristic.doorwayAllowedImports(6, 4, 5, 4), 3);
    assert.equal(heuristic.doorwayAllowedImports(6, 4, 6, 4), 4);
  });

  it("emits only certified mandatory room crossings", () => {
    const heuristic = loadSourceHeuristic();
    const boxes: Box[] = [
      [0, 0, "X"],
      [0, 1, "X"],
      [10, 2, "X"],
      [10, 3, "X"],
    ];
    const plan = doorwayPlanFor(
      heuristic,
      boxes,
      hallTightDetail(),
      ["10,0", "10,1", "10,2", "10,3"],
    );

    assert.deepEqual(
      Array.from(plan.tasks, task => [task.direction, task.target]),
      [
        ["import", "10,0"],
        ["import", "10,1"],
        ["export", "0,2"],
        ["export", "0,3"],
      ],
    );
    assert.equal(plan.penalty, 4);
    assert.equal(plan.proof.complete, true);
    assert.equal(plan.proof.eliminatedEdges, 4);
    assert.equal(plan.proof.mandatoryCrossings, 4);
    assert.equal(plan.proof.optionalCrossings, 0);
  });

  it("keeps ambiguous and infeasible domains out of mandatory tasks", () => {
    const heuristic = loadSourceHeuristic();
    const boxes: Box[] = [[10, 0, "X"], [0, 1, "X"]];
    const optionalPlan = doorwayPlanFor(heuristic, boxes, {
      boxIndices: [0, 1],
      targets: ["10,2", "0,3"],
      costs: [[0, 0], [0, 0]],
      assignment: { cost: 0, matching: [0, 1, 2] },
    }, ["10,0", "10,2"]);
    assert.equal(optionalPlan.tasks.length, 0);
    assert.equal(optionalPlan.proof.complete, true);
    assert.equal(optionalPlan.proof.optionalCrossings, 2);

    const infeasiblePlan = doorwayPlanFor(heuristic, boxes, {
      boxIndices: [0, 1],
      targets: ["10,2", "0,3"],
      costs: [[0, Infinity], [Infinity, Infinity]],
      assignment: { cost: Infinity },
    }, ["10,0", "10,2"]);
    assert.equal(infeasiblePlan.tasks.length, 0);
    assert.equal(infeasiblePlan.proof.complete, false);
    assert.equal(infeasiblePlan.proof.unclassifiedRelations, 2);
  });
});
