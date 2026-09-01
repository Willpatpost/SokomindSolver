import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSemanticZoneIndex,
  deriveSemanticZones,
} from "../../src/features/generator/v2/semantic-zones.ts";

test("semantic zones partition every final-board floor cell exactly once", () => {
  const rows = [
    "OOOOOOOOO",
    "OR      O",
    "O OOOO OO",
    "O       O",
    "OOOOOOOOO",
  ];
  const grid = rows.map((row) => [...row]);
  const zones = deriveSemanticZones(grid);
  const index = buildSemanticZoneIndex(zones);
  const floorCells = rows.reduce(
    (count, row) => count + [...row].filter((cell) => cell !== "O").length,
    0,
  );

  assert.equal(index.size, floorCells);
  assert.equal(
    zones.zones.reduce((count, zone) => count + zone.cells.length, 0),
    floorCells,
  );
  assert.ok(zones.zones.some((zone) => zone.kind === "room"));
  assert.ok(zones.zones.some((zone) => zone.kind === "doorway" || zone.kind === "corridor"));
});

test("semantic zones are deterministic and use stable kind-local IDs", () => {
  const grid = [
    [..."OOOOOOO"],
    [..."OR X SO"],
    [..."OOOOOOO"],
  ];
  const first = deriveSemanticZones(grid);
  const second = deriveSemanticZones(grid);

  assert.deepEqual(first, second);
  for (const zone of first.zones) {
    assert.match(zone.id, new RegExp(`^${zone.kind}-\\d+$`));
  }
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.zones));
});

test("semantic zones are recomputed from changed final geometry", () => {
  const before = [
    [..."OOOOOOO"],
    [..."OR    O"],
    [..."O     O"],
    [..."OOOOOOO"],
  ];
  const after = before.map((row) => [...row]);
  after[2][3] = "O";

  const beforeMap = deriveSemanticZones(before);
  const afterMap = deriveSemanticZones(after);

  assert.notDeepEqual(beforeMap, afterMap);
  assert.equal(buildSemanticZoneIndex(afterMap).has("2,3"), false);
});
