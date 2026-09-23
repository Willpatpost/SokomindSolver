import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, it } from "node:test";
import { PUZZLES } from "../../src/catalog/puzzles.ts";
import { SOKOMIND_ENGINE_SOURCE_FILES } from "../../scripts/sokomind-engine-files.mjs";

type Floor = ReadonlySet<string>;

interface TopologyApi {
  articulationPoints(floor: Floor): Set<string>;
  floorNeighbors(position: string, floor: Floor): string[];
  parse(data: { rows: string[] }): { readonly floor: Floor };
}

async function loadTopologyApi(): Promise<TopologyApi> {
  const sourceDirectory = new URL(
    "../../src/solver/implementations/sokomind-engine/source/",
    import.meta.url,
  );
  const sources = [];
  for (const filename of SOKOMIND_ENGINE_SOURCE_FILES) {
    sources.push(await readFile(new URL(filename, sourceDirectory), "utf8"));
  }
  const context = vm.createContext({
    console,
    performance: globalThis.performance,
    structuredClone,
    postMessage: () => {},
  });
  vm.runInContext(`${sources.join("\n")}
    globalThis.__topologyTest = { articulationPoints, floorNeighbors, parse };`, context);
  return (context as unknown as { __topologyTest: TopologyApi }).__topologyTest;
}

// The earlier recursive implementation. Its insertion order is the contract.
function recursiveArticulationPoints(api: TopologyApi, floor: Floor): Set<string> {
  const discovered = new Map<string, number>();
  const low = new Map<string, number>();
  const parent = new Map<string, string>();
  const result = new Set<string>();
  let time = 0;
  const visit = (position: string) => {
    discovered.set(position, ++time);
    low.set(position, time);
    let children = 0;
    for (const next of api.floorNeighbors(position, floor)) {
      if (!discovered.has(next)) {
        parent.set(next, position);
        children++;
        visit(next);
        low.set(position, Math.min(low.get(position)!, low.get(next)!));
        if (!parent.has(position) && children > 1) result.add(position);
        if (parent.has(position) && low.get(next)! >= discovered.get(position)!) result.add(position);
      } else if (next !== parent.get(position)) {
        low.set(position, Math.min(low.get(position)!, discovered.get(next)!));
      }
    }
  };
  for (const position of floor) if (!discovered.has(position)) visit(position);
  return result;
}

function randomFloor(seed: number, height: number, width: number): Set<string> {
  let state = seed;
  const next = () => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    return state / 2 ** 32;
  };
  const floor = new Set<string>();
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      if (next() < 0.62) floor.add(`${y},${x}`);
    }
  }
  return floor;
}

describe("Sokomind engine topology", () => {
  it("finds articulation points in the recursive DFS order", async () => {
    const api = await loadTopologyApi();
    const floors: [string, Floor][] = PUZZLES.map((puzzle) => [
      puzzle.id,
      api.parse({ rows: [...puzzle.rows] }).floor,
    ]);
    for (let seed = 1; seed <= 40; seed++) {
      floors.push([`random ${seed}`, randomFloor(seed, 8 + (seed % 9), 8 + (seed % 13))]);
    }
    let articulations = 0;
    for (const [name, floor] of floors) {
      const expected = [...recursiveArticulationPoints(api, floor)];
      assert.deepEqual([...api.articulationPoints(floor)], expected, name);
      articulations += expected.length;
    }
    assert.ok(articulations > 0);
  });

  it("handles a long corridor and a large open floor without deep recursion", async () => {
    const api = await loadTopologyApi();
    const length = 10_000;
    const corridor = new Set(Array.from({ length }, (_, index) => `1,${index + 1}`));
    const cuts = api.articulationPoints(corridor);
    assert.equal(cuts.size, length - 2);
    assert.equal(cuts.has("1,1"), false);
    assert.equal(cuts.has(`1,${length}`), false);
    assert.equal(cuts.has("1,2") && cuts.has(`1,${length - 1}`), true);

    const open = new Set<string>();
    for (let y = 1; y <= 100; y++) {
      for (let x = 1; x <= 100; x++) open.add(`${y},${x}`);
    }
    assert.equal(api.articulationPoints(open).size, 0);
  });
});
