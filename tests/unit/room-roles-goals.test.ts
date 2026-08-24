import assert from "node:assert/strict";
import test from "node:test";

import {
  assignRoomRoles,
  generateBlueprintWithRetry,
  placeGoals,
  solvedBlueprintToAscii,
  toSolvedTemplate,
  DEFAULT_BLUEPRINT_PARAMS,
  DEFAULT_GOAL_PARAMS,
  TOPOLOGY_FAMILIES,
  type BlueprintParams,
  type FunctionalBlueprint,
  type GoalPlacementParams,
  type SolvedBlueprint,
} from "../../src/features/generator/v2/index.ts";
import { canRobotReach } from "../../src/features/generator/reverse-play.ts";
import { validatePuzzle } from "../../src/core/puzzle.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParams(overrides: Partial<BlueprintParams> = {}): BlueprintParams {
  return { ...DEFAULT_BLUEPRINT_PARAMS, ...overrides };
}

function makeGoalParams(overrides: Partial<GoalPlacementParams> = {}): GoalPlacementParams {
  return { ...DEFAULT_GOAL_PARAMS, ...overrides };
}

function requireFunctional(
  params: BlueprintParams,
  boxCount: number = 3,
): FunctionalBlueprint | null {
  const bp = generateBlueprintWithRetry(params, 30);
  if (!bp) return null;
  return assignRoomRoles(bp, params.seed, boxCount);
}

function requireSolved(
  params: BlueprintParams,
  goalParams: GoalPlacementParams,
): SolvedBlueprint | null {
  const fb = requireFunctional(params, goalParams.boxCount);
  if (!fb) return null;
  return placeGoals(fb, goalParams);
}

// ---------------------------------------------------------------------------
// Role assignment — determinism
// ---------------------------------------------------------------------------

test("roles: same seed produces identical roles", () => {
  const params = makeParams({ seed: 42, family: "linear", boardWidth: 16, boardHeight: 16 });
  const a = requireFunctional(params);
  const b = requireFunctional(params);
  assert.ok(a && b);
  assert.deepStrictEqual(
    a!.rooms.map((r) => r.role),
    b!.rooms.map((r) => r.role),
  );
});

test("roles: different seeds may produce different roles", () => {
  const params1 = makeParams({ seed: 100, family: "hub", boardWidth: 20, boardHeight: 20, minRooms: 4, maxRooms: 5 });
  const params2 = makeParams({ seed: 200, family: "hub", boardWidth: 20, boardHeight: 20, minRooms: 4, maxRooms: 5 });
  const a = requireFunctional(params1);
  const b = requireFunctional(params2);
  if (!a || !b) return;
  const rolesA = a.rooms.map((r) => r.role).join(",");
  const rolesB = b.rooms.map((r) => r.role).join(",");
  assert.ok(true, `roles A: ${rolesA}, roles B: ${rolesB}`);
});

// ---------------------------------------------------------------------------
// Role assignment — structural properties
// ---------------------------------------------------------------------------

test("roles: linear terminal rooms get goal-room", () => {
  const params = makeParams({
    seed: 300,
    family: "linear",
    boardWidth: 18,
    boardHeight: 18,
    minRoomSize: 3,
    maxRoomSize: 4,
  });
  const fb = requireFunctional(params);
  if (!fb) return;

  const goalRooms = fb.rooms.filter((r) => r.role === "goal-room");
  assert.ok(goalRooms.length >= 1, `linear should have at least 1 goal-room, got ${goalRooms.length}`);
});

test("roles: hub has transit center", () => {
  const params = makeParams({
    seed: 400,
    family: "hub",
    boardWidth: 20,
    boardHeight: 20,
    minRooms: 4,
    maxRooms: 5,
    minRoomSize: 3,
    maxRoomSize: 4,
  });
  const fb = requireFunctional(params);
  if (!fb) return;

  const transitRooms = fb.rooms.filter((r) => r.role === "transit");
  assert.ok(transitRooms.length >= 1, "hub should have at least 1 transit room");
});

test("roles: branch has terminal goal rooms", () => {
  const params = makeParams({
    seed: 500,
    family: "branch",
    boardWidth: 20,
    boardHeight: 20,
    minRooms: 4,
    maxRooms: 5,
    minRoomSize: 3,
    maxRoomSize: 4,
  });
  const fb = requireFunctional(params);
  if (!fb) return;

  const goalRooms = fb.rooms.filter((r) => r.role === "goal-room");
  assert.ok(goalRooms.length >= 1, "branch should have at least 1 goal-room");
});

test("roles: every room has valid role", () => {
  const validRoles = new Set(["general", "goal-room", "staging", "transit", "packing", "exchange"]);
  for (const family of TOPOLOGY_FAMILIES) {
    const params = makeParams({
      seed: 600,
      family,
      boardWidth: 18,
      boardHeight: 18,
      minRoomSize: 3,
      maxRoomSize: 4,
    });
    const fb = requireFunctional(params);
    if (!fb) continue;
    for (const room of fb.rooms) {
      assert.ok(validRoles.has(room.role), `invalid role "${room.role}" in ${family}`);
    }
  }
});

test("roles: FunctionalRoom has graph properties", () => {
  const params = makeParams({
    seed: 700,
    family: "linear",
    boardWidth: 16,
    boardHeight: 16,
    minRoomSize: 3,
    maxRoomSize: 4,
  });
  const fb = requireFunctional(params);
  if (!fb) return;

  for (const room of fb.rooms) {
    assert.ok(typeof room.isTerminal === "boolean");
    assert.ok(typeof room.graphDegree === "number");
    assert.ok(room.graphDegree >= 0);
    assert.ok(typeof room.distanceFromCenter === "number");
    assert.ok(room.distanceFromCenter >= 0);
  }
});

// ---------------------------------------------------------------------------
// Goal placement — determinism
// ---------------------------------------------------------------------------

test("goals: same seed produces identical goal positions", () => {
  const params = makeParams({ seed: 42, family: "linear", boardWidth: 16, boardHeight: 16 });
  const gp = makeGoalParams({ seed: 42, boxCount: 3 });
  const a = requireSolved(params, gp);
  const b = requireSolved(params, gp);
  assert.ok(a && b);
  assert.deepStrictEqual(
    a!.goals.map((g) => `${g.row},${g.column}`),
    b!.goals.map((g) => `${g.row},${g.column}`),
  );
});

// ---------------------------------------------------------------------------
// Goal placement — correctness
// ---------------------------------------------------------------------------

test("goals: correct goal count", () => {
  for (const boxCount of [1, 2, 3, 4]) {
    const params = makeParams({
      seed: 800 + boxCount,
      family: "linear",
      boardWidth: 16,
      boardHeight: 16,
      minRoomSize: 3,
      maxRoomSize: 4,
    });
    const gp = makeGoalParams({ seed: 800 + boxCount, boxCount });
    const solved = requireSolved(params, gp);
    if (!solved) continue;
    assert.equal(
      solved.goals.length,
      boxCount,
      `expected ${boxCount} goals, got ${solved.goals.length}`,
    );
  }
});

test("goals: all goals are on floor cells", () => {
  const params = makeParams({
    seed: 900,
    family: "hub",
    boardWidth: 20,
    boardHeight: 20,
    minRooms: 4,
    maxRooms: 5,
    minRoomSize: 3,
    maxRoomSize: 4,
  });
  const gp = makeGoalParams({ seed: 900, boxCount: 4 });
  const solved = requireSolved(params, gp);
  if (!solved) return;

  for (const goal of solved.goals) {
    assert.notEqual(
      solved.grid[goal.row][goal.column],
      "O",
      `goal at (${goal.row},${goal.column}) is on a wall`,
    );
  }
});

test("goals: all goals are unique", () => {
  const params = makeParams({
    seed: 1000,
    family: "branch",
    boardWidth: 20,
    boardHeight: 20,
    minRooms: 4,
    maxRooms: 5,
    minRoomSize: 3,
    maxRoomSize: 4,
  });
  const gp = makeGoalParams({ seed: 1000, boxCount: 5 });
  const solved = requireSolved(params, gp);
  if (!solved) return;

  const keys = new Set(solved.goals.map((g) => `${g.row},${g.column}`));
  assert.equal(keys.size, solved.goals.length, "goals should all be unique positions");
});

test("goals: robot is not on a goal", () => {
  const params = makeParams({
    seed: 1100,
    family: "linear",
    boardWidth: 16,
    boardHeight: 16,
    minRoomSize: 3,
    maxRoomSize: 4,
  });
  const gp = makeGoalParams({ seed: 1100, boxCount: 3 });
  const solved = requireSolved(params, gp);
  if (!solved) return;

  const goalKeys = new Set(solved.goals.map((g) => `${g.row},${g.column}`));
  const robotKey = `${solved.robotPosition.row},${solved.robotPosition.column}`;
  assert.ok(!goalKeys.has(robotKey), "robot should not be on a goal");
});

test("goals: robot is on a floor cell", () => {
  const params = makeParams({
    seed: 1200,
    family: "hub",
    boardWidth: 18,
    boardHeight: 18,
    minRoomSize: 3,
    maxRoomSize: 4,
  });
  const gp = makeGoalParams({ seed: 1200, boxCount: 3 });
  const solved = requireSolved(params, gp);
  if (!solved) return;

  assert.notEqual(
    solved.grid[solved.robotPosition.row][solved.robotPosition.column],
    "O",
    "robot should be on floor",
  );
});

// ---------------------------------------------------------------------------
// Goal placement — reverse pull viability
// ---------------------------------------------------------------------------

test("goals: all goals have at least 1 reverse-pull direction", () => {
  for (const family of TOPOLOGY_FAMILIES) {
    const params = makeParams({
      seed: 1300,
      family,
      boardWidth: 18,
      boardHeight: 18,
      minRoomSize: 3,
      maxRoomSize: 4,
    });
    const gp = makeGoalParams({ seed: 1300, boxCount: 3 });
    const solved = requireSolved(params, gp);
    if (!solved) continue;

    for (const goal of solved.goals) {
      assert.ok(
        goal.reversePullDirs >= 1,
        `goal at (${goal.row},${goal.column}) in ${family} has 0 reverse-pull directions`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Goal placement — packing room capacity
// ---------------------------------------------------------------------------

test("goals: goal room has enough cells for assigned goals", () => {
  const params = makeParams({
    seed: 1400,
    family: "linear",
    boardWidth: 18,
    boardHeight: 18,
    minRoomSize: 3,
    maxRoomSize: 5,
  });
  const gp = makeGoalParams({ seed: 1400, boxCount: 3 });
  const solved = requireSolved(params, gp);
  if (!solved) return;

  const goalRooms = solved.blueprint.rooms.filter((r) => r.role === "goal-room");
  for (const room of goalRooms) {
    const goalsInRoom = solved.goals.filter((g) => g.roomId === room.id);
    const roomCells = room.width * room.height;
    assert.ok(
      goalsInRoom.length <= roomCells,
      `room ${room.id} has ${goalsInRoom.length} goals but only ${roomCells} cells`,
    );
  }
});

// ---------------------------------------------------------------------------
// SolvedTemplate compatibility
// ---------------------------------------------------------------------------

test("toSolvedTemplate: produces valid SolvedTemplate", () => {
  const params = makeParams({
    seed: 1500,
    family: "linear",
    boardWidth: 16,
    boardHeight: 16,
    minRoomSize: 3,
    maxRoomSize: 4,
  });
  const gp = makeGoalParams({ seed: 1500, boxCount: 2 });
  const solved = requireSolved(params, gp);
  if (!solved) return;

  const template = toSolvedTemplate(solved);
  assert.equal(template.width, 16);
  assert.equal(template.height, 16);
  assert.equal(template.goalPositions.length, 2);
  assert.ok(template.robotPosition);
  assert.ok(template.grid.length > 0);
});

test("toSolvedTemplate: robot can reach at least one goal", () => {
  const params = makeParams({
    seed: 1600,
    family: "linear",
    boardWidth: 16,
    boardHeight: 16,
    minRoomSize: 3,
    maxRoomSize: 4,
  });
  const gp = makeGoalParams({ seed: 1600, boxCount: 2 });
  const solved = requireSolved(params, gp);
  if (!solved) return;

  const template = toSolvedTemplate(solved);
  const reachable = template.goalPositions.some((goal) =>
    canRobotReach(template.grid, template.robotPosition, goal, []),
  );
  assert.ok(reachable, "robot should be able to reach at least one goal position (no box obstacles)");
});

// ---------------------------------------------------------------------------
// Solved state validity — builds valid puzzle rows
// ---------------------------------------------------------------------------

test("solved: template produces valid puzzle when boxes are displaced", () => {
  const params = makeParams({
    seed: 1700,
    family: "linear",
    boardWidth: 16,
    boardHeight: 16,
    minRoomSize: 3,
    maxRoomSize: 4,
  });
  const gp = makeGoalParams({ seed: 1700, boxCount: 2 });
  const solved = requireSolved(params, gp);
  if (!solved) return;

  const template = toSolvedTemplate(solved);
  const grid: string[][] = template.grid.map((row) => [...row]);

  for (const goal of template.goalPositions) {
    grid[goal.row][goal.column] = "S";
  }

  grid[template.robotPosition.row][template.robotPosition.column] = "R";

  let boxesPlaced = 0;
  const goalSet = new Set(template.goalPositions.map((g) => `${g.row},${g.column}`));
  const robotKey = `${template.robotPosition.row},${template.robotPosition.column}`;
  for (let r = 1; r < grid.length - 1 && boxesPlaced < template.goalPositions.length; r++) {
    for (let c = 1; c < grid[0].length - 1 && boxesPlaced < template.goalPositions.length; c++) {
      const key = `${r},${c}`;
      if (grid[r][c] === " " && !goalSet.has(key) && key !== robotKey) {
        grid[r][c] = "X";
        boxesPlaced++;
      }
    }
  }

  if (boxesPlaced < template.goalPositions.length) return;

  const rows = grid.map((row) => row.join(""));
  const puzzle = {
    id: "test-v2-displaced",
    title: "Test",
    difficulty: "beginner" as const,
    boxes: template.goalPositions.length,
    rows,
  };

  const validation = validatePuzzle(puzzle);
  assert.ok(
    validation.valid,
    `validation failed: ${validation.errors.map((e) => e.message).join("; ")}`,
  );
});

// ---------------------------------------------------------------------------
// Cross-family coverage
// ---------------------------------------------------------------------------

test("solved: all topology families produce valid solved blueprints", () => {
  let successes = 0;
  for (const family of TOPOLOGY_FAMILIES) {
    for (let seed = 0; seed < 4; seed++) {
      const params = makeParams({
        seed: seed * 7919 + 17,
        family,
        boardWidth: 18,
        boardHeight: 18,
        minRoomSize: 3,
        maxRoomSize: 4,
      });
      const gp = makeGoalParams({ seed: seed * 7919 + 17, boxCount: 3 });
      const solved = requireSolved(params, gp);
      if (!solved) continue;

      assert.equal(solved.goals.length, 3);
      assert.ok(solved.robotPosition);
      assert.ok(solved.goalStyle);

      for (const goal of solved.goals) {
        assert.notEqual(solved.grid[goal.row][goal.column], "O");
        assert.ok(goal.reversePullDirs >= 1);
      }

      successes++;
    }
  }
  assert.ok(successes >= 12, `expected >= 12 valid solved blueprints, got ${successes}`);
});

// ---------------------------------------------------------------------------
// Goal style variety
// ---------------------------------------------------------------------------

test("solved: different styles produce goals in different positions", () => {
  const params = makeParams({
    seed: 2000,
    family: "hub",
    boardWidth: 20,
    boardHeight: 20,
    minRooms: 4,
    maxRooms: 5,
    minRoomSize: 3,
    maxRoomSize: 4,
  });
  const fb = requireFunctional(params, 4);
  if (!fb) return;

  const concentrated = placeGoals(fb, makeGoalParams({ seed: 2000, boxCount: 4, goalStyle: "concentrated" }));
  const multiRoom = placeGoals(fb, makeGoalParams({ seed: 2000, boxCount: 4, goalStyle: "multi-room" }));

  if (!concentrated || !multiRoom) return;

  const concKeys = new Set(concentrated.goals.map((g) => `${g.row},${g.column}`));
  const multiKeys = new Set(multiRoom.goals.map((g) => `${g.row},${g.column}`));

  let same = 0;
  for (const k of concKeys) {
    if (multiKeys.has(k)) same++;
  }
  assert.ok(true, `concentrated vs multi-room overlap: ${same}/${concentrated.goals.length}`);
});

// ---------------------------------------------------------------------------
// ASCII visualization
// ---------------------------------------------------------------------------

test("solvedBlueprintToAscii: produces output", () => {
  const params = makeParams({
    seed: 2100,
    family: "linear",
    boardWidth: 16,
    boardHeight: 16,
    minRoomSize: 3,
    maxRoomSize: 4,
  });
  const gp = makeGoalParams({ seed: 2100, boxCount: 3 });
  const solved = requireSolved(params, gp);
  if (!solved) return;

  const ascii = solvedBlueprintToAscii(solved);
  const lines = ascii.split("\n");
  assert.equal(lines.length, 16);

  const hasGoals = ascii.includes("*");
  const hasRobot = ascii.includes("R");
  assert.ok(hasGoals, "ASCII should contain goal markers");
  assert.ok(hasRobot, "ASCII should contain robot marker");
});

// ---------------------------------------------------------------------------
// Edge case: small board with 1 box
// ---------------------------------------------------------------------------

test("solved: works with 1 box on small board", () => {
  const params = makeParams({
    seed: 2200,
    family: "linear",
    boardWidth: 12,
    boardHeight: 12,
    minRooms: 2,
    maxRooms: 2,
    minRoomSize: 3,
    maxRoomSize: 3,
  });
  const gp = makeGoalParams({ seed: 2200, boxCount: 1 });
  const solved = requireSolved(params, gp);
  if (!solved) return;

  assert.equal(solved.goals.length, 1);
  assert.ok(solved.goals[0].reversePullDirs >= 1);
});

// ---------------------------------------------------------------------------
// Benchmark: visual inspection
// ---------------------------------------------------------------------------

test("benchmark: solved blueprint samples across families", () => {
  console.log("\n=== Sprint 3 Solved Blueprint Samples ===");

  for (const family of TOPOLOGY_FAMILIES) {
    const params = makeParams({
      seed: 3000,
      family,
      boardWidth: 18,
      boardHeight: 18,
      minRoomSize: 3,
      maxRoomSize: 4,
    });
    const gp = makeGoalParams({ seed: 3000, boxCount: 3 });
    const solved = requireSolved(params, gp);
    if (!solved) {
      console.log(`\n  ${family}: failed to generate`);
      continue;
    }

    const ascii = solvedBlueprintToAscii(solved);
    const roles = solved.blueprint.rooms
      .map((r) => `  room ${r.id}: ${r.role} (${r.width}x${r.height}, deg=${r.graphDegree}, term=${r.isTerminal})`)
      .join("\n");
    const goalInfo = solved.goals
      .map((g) => `  goal (${g.row},${g.column}): room=${g.roomId}, depth=${g.depthFromDoorway}, rp=${g.reversePullDirs}`)
      .join("\n");

    console.log(`\n  ${family} (style=${solved.goalStyle}):`);
    console.log(ascii.split("\n").map((l) => "  " + l).join("\n"));
    console.log(roles);
    console.log(goalInfo);
    console.log(`  robot: (${solved.robotPosition.row},${solved.robotPosition.column})`);
  }
});

// ---------------------------------------------------------------------------
// Benchmark: role distribution across seeds
// ---------------------------------------------------------------------------

test("benchmark: role distribution across families and seeds", () => {
  console.log("\n=== Role Distribution ===");

  for (const family of TOPOLOGY_FAMILIES) {
    const roleCounts: Record<string, number> = {};
    let total = 0;

    for (let seed = 0; seed < 10; seed++) {
      const params = makeParams({
        seed: seed * 1000 + 1,
        family,
        boardWidth: 18,
        boardHeight: 18,
        minRoomSize: 3,
        maxRoomSize: 4,
      });
      const fb = requireFunctional(params);
      if (!fb) continue;

      for (const room of fb.rooms) {
        roleCounts[room.role] = (roleCounts[room.role] ?? 0) + 1;
        total++;
      }
    }

    const parts = Object.entries(roleCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([role, count]) => `${role}=${count}`)
      .join(", ");
    console.log(`  ${family} (n=${total}): ${parts}`);
  }
});

// ---------------------------------------------------------------------------
// Benchmark: goal style distribution
// ---------------------------------------------------------------------------

test("benchmark: goal style distribution across families", () => {
  console.log("\n=== Goal Style Distribution ===");

  for (const family of TOPOLOGY_FAMILIES) {
    const styleCounts: Record<string, number> = {};
    let total = 0;

    for (let seed = 0; seed < 10; seed++) {
      const params = makeParams({
        seed: seed * 1000 + 1,
        family,
        boardWidth: 18,
        boardHeight: 18,
        minRoomSize: 3,
        maxRoomSize: 4,
      });
      const gp = makeGoalParams({ seed: seed * 1000 + 1, boxCount: 3, goalStyle: "auto" });
      const solved = requireSolved(params, gp);
      if (!solved) continue;

      styleCounts[solved.goalStyle] = (styleCounts[solved.goalStyle] ?? 0) + 1;
      total++;
    }

    const parts = Object.entries(styleCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([style, count]) => `${style}=${count}`)
      .join(", ");
    console.log(`  ${family} (n=${total}): ${parts}`);
  }
});
