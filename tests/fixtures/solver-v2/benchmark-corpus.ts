/**
 * Snapshotted puzzle rows for the Solver V2 benchmark corpus.
 *
 * Row arrays are frozen inline so benchmarks remain reproducible even if the
 * catalog changes. Mirror and rotate helpers produce Grand Hall variants at
 * runtime, matching the production performance-test pattern.
 */

import { createHash } from "node:crypto";

export type BenchmarkFixtureGroup =
  | "primary-v2"
  | "legacy-regression"
  | "supplemental";

export interface BenchmarkFixture {
  readonly fixtureId: string;
  readonly catalogId: string | null;
  readonly fixtureGroup: BenchmarkFixtureGroup;
  readonly aliases?: readonly string[];
  readonly boxes: number;
  readonly floorCount: number;
  readonly width: number;
  readonly height: number;
  readonly rows: readonly string[];
}

export function computeBoardHash(rows: readonly string[]): string {
  return createHash("sha256").update(rows.join("\n")).digest("hex").slice(0, 16);
}

function freeze(fixture: BenchmarkFixture): BenchmarkFixture {
  return Object.freeze({ ...fixture, rows: Object.freeze([...fixture.rows]) });
}

export function mirrorRows(rows: readonly string[]): readonly string[] {
  return Object.freeze(rows.map((row) => [...row].reverse().join("")));
}

export function rotateRows(rows: readonly string[]): readonly string[] {
  return Object.freeze(
    [...rows].reverse().map((row) => [...row].reverse().join("")),
  );
}

// ---------------------------------------------------------------------------
// Canonical catalog snapshots
// ---------------------------------------------------------------------------

export const ULTRA_TINY = freeze({
  fixtureId: "ultra-tiny",
  catalogId: "ultra-tiny",
  fixtureGroup: "legacy-regression",
  boxes: 1, floorCount: 9, width: 5, height: 5,
  rows: ["OOOOO", "O R O", "O A O", "O a O", "OOOOO"],
});

export const TINY = freeze({
  fixtureId: "tiny",
  catalogId: "tiny",
  fixtureGroup: "legacy-regression",
  boxes: 2, floorCount: 14, width: 6, height: 6,
  rows: ["OOOOOO", "O R  O", "O XO O", "OO A O", "OSa  O", "OOOOOO"],
});

export const TUTORIAL_PUSH = freeze({
  fixtureId: "tutorial-push",
  catalogId: "tutorial-push",
  fixtureGroup: "legacy-regression",
  boxes: 1, floorCount: 9, width: 5, height: 5,
  rows: ["OOOOO", "O XSO", "O   O", "O R O", "OOOOO"],
});

export const TUTORIAL_CORNER = freeze({
  fixtureId: "tutorial-corner",
  catalogId: "tutorial-corner",
  fixtureGroup: "legacy-regression",
  boxes: 1, floorCount: 16, width: 6, height: 6,
  rows: ["OOOOOO", "O    O", "O RX O", "O  S O", "O    O", "OOOOOO"],
});

export const TUTORIAL_AROUND = freeze({
  fixtureId: "tutorial-around",
  catalogId: "tutorial-around",
  fixtureGroup: "legacy-regression",
  boxes: 1, floorCount: 12, width: 7, height: 5,
  rows: ["OOOOOOO", "OR    O", "OOOOX O", "O   S O", "OOOOOOO"],
});

export const BEGINNER_THREE = freeze({
  fixtureId: "beginner-three",
  catalogId: "beginner-three",
  fixtureGroup: "legacy-regression",
  boxes: 3, floorCount: 22, width: 8, height: 6,
  rows: ["OOOOOOOO", "O R    O", "O XXXO O", "O SSSO O", "O      O", "OOOOOOOO"],
});

export const BEGINNER_DETOUR = freeze({
  fixtureId: "beginner-detour",
  catalogId: "beginner-detour",
  fixtureGroup: "legacy-regression",
  boxes: 2, floorCount: 21, width: 8, height: 6,
  rows: ["OOOOOOOO", "OR     O", "OOOO X O", "OS   X O", "OS     O", "OOOOOOOO"],
});

export const BEGINNER_TYPED_LINE = freeze({
  fixtureId: "beginner-typed-line",
  catalogId: "beginner-typed-line",
  fixtureGroup: "primary-v2",
  boxes: 3, floorCount: 28, width: 9, height: 6,
  rows: ["OOOOOOOOO", "Oc b a  O", "O       O", "O A B C O", "O   R   O", "OOOOOOOOO"],
});

export const GARDEN_1 = freeze({
  fixtureId: "garden-1",
  catalogId: "garden-1",
  fixtureGroup: "primary-v2",
  boxes: 3, floorCount: 28, width: 9, height: 6,
  rows: ["OOOOOOOOO", "O   R   O", "O A B C O", "O       O", "O a b c O", "OOOOOOOOO"],
});

export const BOX_5X5_A = freeze({
  fixtureId: "box-5x5-a",
  catalogId: "box-5x5-a",
  fixtureGroup: "legacy-regression",
  boxes: 2, floorCount: 9, width: 5, height: 5,
  rows: ["OOOOO", "OSX O", "O XRO", "O  SO", "OOOOO"],
});

export const MEDIUM = freeze({
  fixtureId: "medium",
  catalogId: "medium",
  fixtureGroup: "primary-v2",
  boxes: 8, floorCount: 25, width: 7, height: 7,
  rows: ["OOOOOOO", "Oa   bO", "O AXB O", "O XRX O", "OSCXDSO", "OcS SdO", "OOOOOOO"],
});

export const INTER_ROOMS = freeze({
  fixtureId: "inter-rooms",
  catalogId: "inter-rooms",
  fixtureGroup: "primary-v2",
  boxes: 4, floorCount: 30, width: 11, height: 6,
  rows: ["OOOOOOOOOOO", "O    O    O", "O RX   XS O", "O XO O OX O", "OSSO   OS O", "OOOOOOOOOOO"],
});

export const CORRIDOR_2 = freeze({
  fixtureId: "corridor-2",
  catalogId: "corridor-2",
  fixtureGroup: "primary-v2",
  boxes: 3, floorCount: 50, width: 11, height: 9,
  rows: ["OOOOOOOOOOO", "O S O     O", "O   O X   O", "O     R   O", "O   O X   O", "O S O     O", "OOOOO X   O", "OOOOOO  S O", "OOOOOOOOOOO"],
});

export const GARDEN_2 = freeze({
  fixtureId: "garden-2",
  catalogId: "garden-2",
  fixtureGroup: "primary-v2",
  boxes: 2, floorCount: 46, width: 11, height: 9,
  rows: ["OOOOOOOOOOO", "O    R    O", "O OOO OOO O", "O A     B O", "O OOO OOO O", "O  b   a  O", "O OO O OO O", "O         O", "OOOOOOOOOOO"],
});

export const WORKSHOP_1 = freeze({
  fixtureId: "workshop-1",
  catalogId: "workshop-1",
  fixtureGroup: "legacy-regression",
  boxes: 3, floorCount: 28, width: 7, height: 8,
  rows: ["OOOOOOO", "O   R O", "O OXO O", "O X   O", "OSX   O", "OS    O", "OS    O", "OOOOOOO"],
});

export const CLASSIC_1 = freeze({
  fixtureId: "classic-1",
  catalogId: "classic-1",
  fixtureGroup: "legacy-regression",
  boxes: 3, floorCount: 26, width: 7, height: 8,
  rows: ["OOOOOOO", "O     O", "O OXO O", "O  X  O", "OO X OO", "O  R  O", "O SSS O", "OOOOOOO"],
});

export const THEME_KITCHEN = freeze({
  fixtureId: "theme-kitchen",
  catalogId: "theme-kitchen",
  fixtureGroup: "legacy-regression",
  boxes: 3, floorCount: 36, width: 9, height: 8,
  rows: ["OOOOOOOOO", "O R     O", "O  OOO  O", "O X O X O", "O  O    O", "O  O  X O", "O SSS   O", "OOOOOOOOO"],
});

export const LARGE = freeze({
  fixtureId: "large",
  catalogId: "large",
  fixtureGroup: "primary-v2",
  boxes: 6, floorCount: 36, width: 10, height: 10,
  rows: ["OOOOOOOOOO", "OOOOOOOSSO", "OOOOO  abO", "OOOOO XSSO", "OOOOOO  OO", "OR     OOO", "OO A X X O", "OO BXO O O", "OO   O   O", "OOOOOOOOOO"],
});

export const ADV_ROTARY = freeze({
  fixtureId: "adv-rotary",
  catalogId: "adv-rotary",
  fixtureGroup: "primary-v2",
  boxes: 2, floorCount: 25, width: 11, height: 6,
  rows: ["OOOOOOOOOOO", "OOa  ROOOOO", "OO  OO  bOO", "O A    B  O", "O   OO    O", "OOOOOOOOOOO"],
});

export const ADV_FOUR_COLOR = freeze({
  fixtureId: "adv-four-color",
  catalogId: "adv-four-color",
  fixtureGroup: "primary-v2",
  boxes: 4, floorCount: 49, width: 9, height: 9,
  rows: ["OOOOOOOOO", "Ob     cO", "O       O", "O  C  D O", "O   R   O", "O  A  B O", "O       O", "Od     aO", "OOOOOOOOO"],
});

export const ADV_GALLERY = freeze({
  fixtureId: "adv-gallery",
  catalogId: "adv-gallery",
  fixtureGroup: "primary-v2",
  boxes: 4, floorCount: 50, width: 10, height: 10,
  rows: ["OOOOOOOOOO", "O R      O", "O OOOOOO O", "O O    O O", "O X SS X O", "O O    O O", "O OXOOXO O", "O        O", "O   SS   O", "OOOOOOOOOO"],
});

export const BOX_7X7 = freeze({
  fixtureId: "box-7x7",
  catalogId: "box-7x7",
  fixtureGroup: "primary-v2",
  boxes: 4, floorCount: 24, width: 7, height: 7,
  rows: ["OOOOOOO", "OS   SO", "O  X  O", "O XRXOO", "O  X  O", "OS   SO", "OOOOOOO"],
});

export const SYM_DIAMOND = freeze({
  fixtureId: "sym-diamond",
  catalogId: "sym-diamond",
  fixtureGroup: "primary-v2",
  boxes: 3, floorCount: 41, width: 11, height: 11,
  rows: ["OOOOOOOOOOO", "OOOOO OOOOO", "OOOO   OOOO", "OOO  S  OOO", "OO  XRX  OO", "O    X    O", "OO   S   OO", "OOO  S  OOO", "OOOO   OOOO", "OOOOO OOOOO", "OOOOOOOOOOO"],
});

export const THEME_LIBRARY = freeze({
  fixtureId: "theme-library",
  catalogId: "theme-library",
  fixtureGroup: "primary-v2",
  boxes: 4, floorCount: 46, width: 11, height: 8,
  rows: ["OOOOOOOOOOO", "OaaO R ObbO", "O  O   O  O", "O  OO OO  O", "O   A B   O", "O  A   B  O", "O         O", "OOOOOOOOOOO"],
});

export const THEME_PARKING = freeze({
  fixtureId: "theme-parking",
  catalogId: "theme-parking",
  fixtureGroup: "primary-v2",
  boxes: 5, floorCount: 52, width: 11, height: 9,
  rows: ["OOOOOOOOOOO", "O   R     O", "O A B C   O", "O  OOOOO  O", "O    X  X O", "O  OOOOO  O", "O a b c   O", "O      SSOO", "OOOOOOOOOOO"],
});

export const OPEN_FIELD = freeze({
  fixtureId: "open-field",
  catalogId: "open-field",
  fixtureGroup: "primary-v2",
  boxes: 10, floorCount: 324, width: 20, height: 20,
  rows: [
    "OOOOOOOOOOOOOOOOOOOO",
    "OSX                O",
    "OS  X              O",
    "OS                 O",
    "OS                 O",
    "OS                 O",
    "OS                 O",
    "OS                 O",
    "OS                 O",
    "OS                 O",
    "OX        R        O",
    "O   X              O",
    "OX                 O",
    "O   X              O",
    "OX                 O",
    "O   X              O",
    "OX                 O",
    "O   X              O",
    "OS                 O",
    "OOOOOOOOOOOOOOOOOOOO",
  ],
});

export const HUGE = freeze({
  fixtureId: "v2-17box-handdesigned",
  catalogId: "huge",
  fixtureGroup: "primary-v2",
  aliases: ["huge", "grand-hall"],
  boxes: 17, floorCount: 127, width: 15, height: 15,
  rows: [
    "OOOOOOOOOOOOOOO",
    "OaSS   S   SSbO",
    "OSCS  OOO  SDSO",
    "OX X  OOO  X XO",
    "O     OOO     O",
    "OOOO   X   OOOO",
    "O      O      O",
    "O G hOOOOOH g O",
    "O      O      O",
    "OOO         OOO",
    "OOO   X X   OOO",
    "OOOOOOOROOOOOOO",
    "O B X X X X A O",
    "O Sc       dS O",
    "OOOOOOOOOOOOOOO",
  ],
});

export const EXPERT_MAZE = freeze({
  fixtureId: "expert-maze",
  catalogId: "expert-maze",
  fixtureGroup: "primary-v2",
  boxes: 5, floorCount: 66, width: 12, height: 11,
  rows: [
    "OOOOOOOOOOOO",
    "O R  O     O",
    "OOO  O OOO O",
    "O X  O O S O",
    "O OO   O   O",
    "O O  OOOO  O",
    "O   XO  X  O",
    "OOOO OS    O",
    "O  X    OO O",
    "O SSS X    O",
    "OOOOOOOOOOOO",
  ],
});

export const EXPERT_TETRIS = freeze({
  fixtureId: "expert-tetris",
  catalogId: "expert-tetris",
  fixtureGroup: "primary-v2",
  boxes: 6, floorCount: 39, width: 9, height: 9,
  rows: ["OOOOOOOOO", "O   R   O", "O  X X  O", "OOX   XOO", "OO     OO", "OO X X OO", "OOSSSSSOO", "OO  S  OO", "OOOOOOOOO"],
});

export const THEME_MUSEUM = freeze({
  fixtureId: "theme-museum",
  catalogId: "theme-museum",
  fixtureGroup: "primary-v2",
  boxes: 6, floorCount: 82, width: 13, height: 10,
  rows: [
    "OOOOOOOOOOOOO",
    "O     R     O",
    "O  A  B  C  O",
    "O  O  O  O  O",
    "O           O",
    "O  O  O  O  O",
    "O  A  B  C  O",
    "O           O",
    "O aa bb cc  O",
    "OOOOOOOOOOOOO",
  ],
});

export const MASTER_EXCHANGE = freeze({
  fixtureId: "master-exchange",
  catalogId: "master-exchange",
  fixtureGroup: "primary-v2",
  boxes: 8, floorCount: 91, width: 13, height: 11,
  rows: [
    "OOOOOOOOOOOOO",
    "OaaO  R  OccO",
    "O  O     O  O",
    "O   C   A   O",
    "O   C   A   O",
    "O           O",
    "O   B   D   O",
    "O   B   D   O",
    "O  O     O  O",
    "OddO     ObbO",
    "OOOOOOOOOOOOO",
  ],
});

export const MASTER_TYPED_GRID = freeze({
  fixtureId: "master-typed-grid",
  catalogId: "master-typed-grid",
  fixtureGroup: "primary-v2",
  boxes: 8, floorCount: 99, width: 13, height: 11,
  rows: [
    "OOOOOOOOOOOOO",
    "O           O",
    "O  B  D  A  O",
    "O           O",
    "O  C  A  B  O",
    "O     R     O",
    "O  D  C     O",
    "O           O",
    "O  aa bb    O",
    "O  cc dd    O",
    "OOOOOOOOOOOOO",
  ],
});

// ---------------------------------------------------------------------------
// Spec §20.1 supplemental fixtures (items 6–16)
// ---------------------------------------------------------------------------

// Microban 145 (David W. Skinner) — compact 3-box generic puzzle with
// indirect push paths that stress basic search ordering.
export const V2_MICROBAN_145 = freeze({
  fixtureId: "v2-microban-145",
  catalogId: null,
  fixtureGroup: "supplemental",
  boxes: 3, floorCount: 19, width: 6, height: 7,
  rows: [
    "OOOOOO",
    "O    O",
    "O XX O",
    "O  X O",
    "O R  O",
    "OSSSOO",
    "OOOOOO",
  ],
});

// Microban 146 (David W. Skinner) — compact 3-box puzzle requiring
// boxes to navigate through a narrow central gap.
export const V2_MICROBAN_146 = freeze({
  fixtureId: "v2-microban-146",
  catalogId: null,
  fixtureGroup: "supplemental",
  boxes: 3, floorCount: 23, width: 7, height: 8,
  rows: [
    "OOOOOOO",
    "OS R SO",
    "O  XX O",
    "OO O OO",
    "O     O",
    "OO X OO",
    "OO S OO",
    "OOOOOOO",
  ],
});

// Caleb 022 — 4-box puzzle with room partitions and a corridor;
// exercises the solver's room-decomposition and macro-push logic.
export const V2_CALEB_022 = freeze({
  fixtureId: "v2-caleb-022",
  catalogId: null,
  fixtureGroup: "supplemental",
  boxes: 4, floorCount: 31, width: 8, height: 8,
  rows: [
    "OOOOOOOO",
    "O R    O",
    "O  OX  O",
    "O    X O",
    "OOX  OOO",
    "OSS    O",
    "OSS X OO",
    "OOOOOOOO",
  ],
});

// Solved-box-must-move-first — the optimal solution pushes a box through
// its own goal, then later returns it.  Regression guard for solvers that
// prune "already-solved" boxes from the search.
export const V2_SOLVED_BOX_MUST_MOVE = freeze({
  fixtureId: "v2-solved-box-must-move",
  catalogId: null,
  fixtureGroup: "supplemental",
  boxes: 2, floorCount: 24, width: 7, height: 7,
  rows: [
    "OOOOOOO",
    "O     O",
    "OOS R O",
    "O X   O",
    "O X   O",
    "O S   O",
    "OOOOOOO",
  ],
});

// Assignment-infeasible state — a solvable puzzle that contains tempting
// pushes (box into a corner) which produce assignment-infeasible deadlocks.
// The solver's assignment heuristic must return infinity for those states.
export const V2_ASSIGNMENT_INFEASIBLE = freeze({
  fixtureId: "v2-assignment-infeasible",
  catalogId: null,
  fixtureGroup: "supplemental",
  boxes: 2, floorCount: 23, width: 7, height: 7,
  rows: [
    "OOOOOOO",
    "O   R O",
    "O X   O",
    "OOO   O",
    "O S X O",
    "O S   O",
    "OOOOOOO",
  ],
});

// Sealed-corral proof — pushing boxes into the narrow doorway seals goals
// below in an unreachable corral.  Tests corral-based dead-state detection.
export const V2_SEALED_CORRAL = freeze({
  fixtureId: "v2-sealed-corral",
  catalogId: null,
  fixtureGroup: "supplemental",
  boxes: 2, floorCount: 21, width: 7, height: 7,
  rows: [
    "OOOOOOO",
    "O R   O",
    "O X X O",
    "OOO OOO",
    "O  S  O",
    "O  S  O",
    "OOOOOOO",
  ],
});

// Wide multi-entry room — a large room on the right connected to small
// left-side alcoves through three separate doorways.  Exercises room
// analysis, macro-push generation, and multi-entry handling.
export const V2_WIDE_MULTI_ENTRY = freeze({
  fixtureId: "v2-wide-multi-entry",
  catalogId: null,
  fixtureGroup: "supplemental",
  boxes: 3, floorCount: 63, width: 13, height: 9,
  rows: [
    "OOOOOOOOOOOOO",
    "O    O      O",
    "OR X   S    O",
    "O    OOOOO OO",
    "O  X   S    O",
    "O    OOOOO OO",
    "O  X   S    O",
    "O    O      O",
    "OOOOOOOOOOOOO",
  ],
});

// Loop-heavy — pillar grid creates many independent floor-graph cycles.
// Stresses reachability flood performance and duplicate-state detection
// in the presence of a high branching factor.
export const V2_LOOP_HEAVY = freeze({
  fixtureId: "v2-loop-heavy",
  catalogId: null,
  fixtureGroup: "supplemental",
  boxes: 2, floorCount: 79, width: 13, height: 11,
  rows: [
    "OOOOOOOOOOOOO",
    "O   R       O",
    "O O O O O O O",
    "O     X     O",
    "O O O O O O O",
    "O           O",
    "O O O O O O O",
    "O     X     O",
    "O O O O O O O",
    "O  S     S  O",
    "OOOOOOOOOOOOO",
  ],
});

// 27-box memory stress test — large warehouse with 27 boxes in the upper
// half and 27 goals in the lower half.  Not expected to solve within
// time limits; exists to measure peak memory and state-encoding capacity.
export const V2_27BOX_MEMORY = freeze({
  fixtureId: "v2-27box-memory",
  catalogId: null,
  fixtureGroup: "supplemental",
  aliases: ["memory-stress"],
  boxes: 27, floorCount: 285, width: 21, height: 17,
  rows: [
    "OOOOOOOOOOOOOOOOOOOOO",
    "O X X X X X X       O",
    "O  X X X X X X      O",
    "O X X X X X         O",
    "O  X X X X X        O",
    "O X X X X X         O",
    "O                   O",
    "O                   O",
    "O         R         O",
    "O                   O",
    "O                   O",
    "O       S S S S S   O",
    "O      S S S S S    O",
    "O       S S S S S   O",
    "O      S S S S S S  O",
    "O       S S S S S S O",
    "OOOOOOOOOOOOOOOOOOOOO",
  ],
});

// ---------------------------------------------------------------------------
// Grand Hall variants (computed at runtime from HUGE rows)
// ---------------------------------------------------------------------------

export const HUGE_MIRRORED = freeze({
  fixtureId: "v2-17box-mirrored",
  catalogId: null,
  fixtureGroup: "primary-v2",
  aliases: ["huge-mirrored"],
  boxes: HUGE.boxes,
  floorCount: HUGE.floorCount,
  width: HUGE.width,
  height: HUGE.height,
  rows: mirrorRows(HUGE.rows),
});

export const HUGE_ROTATED = freeze({
  fixtureId: "v2-17box-rotated",
  catalogId: null,
  fixtureGroup: "primary-v2",
  aliases: ["huge-rotated"],
  boxes: HUGE.boxes,
  floorCount: HUGE.floorCount,
  width: HUGE.width,
  height: HUGE.height,
  rows: rotateRows(HUGE.rows),
});

// Grand Hall IS the 17-box hand-designed fixture (spec §20.1 item 17).
// Canonical V2 ID: "v2-17box-handdesigned". Aliases: "huge", "grand-hall".
export const V2_17BOX_HANDDESIGNED = HUGE;

// ---------------------------------------------------------------------------
// Full corpus with eligibility metadata
// ---------------------------------------------------------------------------

export const BENCHMARK_CORPUS: readonly BenchmarkFixture[] = Object.freeze([
  ULTRA_TINY,
  TINY,
  TUTORIAL_PUSH,
  TUTORIAL_CORNER,
  TUTORIAL_AROUND,
  BEGINNER_THREE,
  BEGINNER_DETOUR,
  BEGINNER_TYPED_LINE,
  GARDEN_1,
  BOX_5X5_A,
  MEDIUM,
  INTER_ROOMS,
  CORRIDOR_2,
  GARDEN_2,
  WORKSHOP_1,
  CLASSIC_1,
  THEME_KITCHEN,
  LARGE,
  ADV_ROTARY,
  ADV_FOUR_COLOR,
  ADV_GALLERY,
  BOX_7X7,
  SYM_DIAMOND,
  THEME_LIBRARY,
  THEME_PARKING,
  OPEN_FIELD,
  HUGE,
  EXPERT_MAZE,
  EXPERT_TETRIS,
  THEME_MUSEUM,
  MASTER_EXCHANGE,
  MASTER_TYPED_GRID,
  HUGE_MIRRORED,
  HUGE_ROTATED,
  V2_MICROBAN_145,
  V2_MICROBAN_146,
  V2_CALEB_022,
  V2_SOLVED_BOX_MUST_MOVE,
  V2_ASSIGNMENT_INFEASIBLE,
  V2_SEALED_CORRAL,
  V2_WIDE_MULTI_ENTRY,
  V2_LOOP_HEAVY,
  V2_27BOX_MEMORY,
]);

export const BENCHMARK_FIXTURE_BY_ID: Readonly<
  Record<string, BenchmarkFixture>
> = Object.freeze(
  Object.fromEntries(
    BENCHMARK_CORPUS.flatMap((f) => {
      const entries: [string, BenchmarkFixture][] = [[f.fixtureId, f]];
      if (f.aliases) {
        for (const alias of f.aliases) entries.push([alias, f]);
      }
      return entries;
    }),
  ),
);

export function isClassicEligible(fixture: BenchmarkFixture): boolean {
  return fixture.boxes <= 8 && fixture.floorCount <= 96;
}
