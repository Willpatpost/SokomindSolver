import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {test} from "node:test";
import vm from "node:vm";

test("selected goal approaches require the actual final push and preserve alternatives", async () => {
  const source = await readFile(new URL("../../src/solver/implementations/sokomind-engine/engine.generated.js", import.meta.url), "utf8");
  const context = vm.createContext({performance, postMessage: () => {}});
  const result = vm.runInContext(source.replace(/export \{[^}]+\};\s*$/, "") + `
    (() => {
      const board = parse({rows: ["OOOOOOO", "O R   O", "O X S O", "O     O", "O     O", "OOOOOOO"]});
      const start = {robot: [1,2], boxes: [[2,2,"X"]]};
      const options = {taskExpanded: 2000, taskPushes: 30, taskResults: 1,
        maxExpanded: 6000, maxGenerated: 48000, pathLimit: 512};
      return ["2,3", "3,4", "2,5"].map(finalPredecessor => {
        const budget = {expanded: 0, generated: 0, groupWidenings: 0, deadline: performance.now() + 5000,
          distanceTables: new Map(), distanceCacheHits: 0, distanceEntries: 0, taskObstructions: new Map()};
        const task = {id: "goal", kind: "commit-goal", boxIndex: 0, participants: [0],
          destinations: new Set(["2,4"]), finalPredecessor};
        return simulateStrategicTask(start, task, board, budget, options).map(endpoint => ({
          last: endpoint.path.at(-1), robot: endpoint.robot, boxes: endpoint.boxes}));
      });
    })()
  `, context) as Array<Array<{last: string; robot: number[]; boxes: unknown[]}>>;
  assert.equal(result[0][0]?.last, "Right");
  assert.equal(result[1][0]?.last, "Up");
  // The westward final push would require keeper support inside the wall.
  assert.equal(result[2].length, 0);
});
