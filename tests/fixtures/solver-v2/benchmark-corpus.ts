/**
 * Snapshotted puzzle rows for the Solver V2 benchmark corpus.
 *
 * Row arrays are frozen inline so benchmarks remain reproducible even if the
 * catalog changes. Mirror and rotate helpers produce Grand Hall variants at
 * runtime, matching the production performance-test pattern.
 */

export interface BenchmarkFixture {
  readonly fixtureId: string;
  readonly catalogId: string | null;
  readonly boxes: number;
  readonly floorCount: number;
  readonly width: number;
  readonly height: number;
  readonly rows: readonly string[];
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
  boxes: 1, floorCount: 9, width: 5, height: 5,
  rows: ["OOOOO", "O R O", "O A O", "O a O", "OOOOO"],
});

export const TINY = freeze({
  fixtureId: "tiny",
  catalogId: "tiny",
  boxes: 2, floorCount: 14, width: 6, height: 6,
  rows: ["OOOOOO", "O R  O", "O XO O", "OO A O", "OSa  O", "OOOOOO"],
});

export const TUTORIAL_PUSH = freeze({
  fixtureId: "tutorial-push",
  catalogId: "tutorial-push",
  boxes: 1, floorCount: 9, width: 5, height: 5,
  rows: ["OOOOO", "O XSO", "O   O", "O R O", "OOOOO"],
});

export const TUTORIAL_CORNER = freeze({
  fixtureId: "tutorial-corner",
  catalogId: "tutorial-corner",
  boxes: 1, floorCount: 16, width: 6, height: 6,
  rows: ["OOOOOO", "O    O", "O RX O", "O  S O", "O    O", "OOOOOO"],
});

export const TUTORIAL_AROUND = freeze({
  fixtureId: "tutorial-around",
  catalogId: "tutorial-around",
  boxes: 1, floorCount: 12, width: 7, height: 5,
  rows: ["OOOOOOO", "OR    O", "OOOOX O", "O   S O", "OOOOOOO"],
});

export const BEGINNER_THREE = freeze({
  fixtureId: "beginner-three",
  catalogId: "beginner-three",
  boxes: 3, floorCount: 22, width: 8, height: 6,
  rows: ["OOOOOOOO", "O R    O", "O XXXO O", "O SSSO O", "O      O", "OOOOOOOO"],
});

export const BEGINNER_DETOUR = freeze({
  fixtureId: "beginner-detour",
  catalogId: "beginner-detour",
  boxes: 2, floorCount: 21, width: 8, height: 6,
  rows: ["OOOOOOOO", "OR     O", "OOOO X O", "OS   X O", "OS     O", "OOOOOOOO"],
});

export const BEGINNER_TYPED_LINE = freeze({
  fixtureId: "beginner-typed-line",
  catalogId: "beginner-typed-line",
  boxes: 3, floorCount: 28, width: 9, height: 6,
  rows: ["OOOOOOOOO", "Oc b a  O", "O       O", "O A B C O", "O   R   O", "OOOOOOOOO"],
});

export const GARDEN_1 = freeze({
  fixtureId: "garden-1",
  catalogId: "garden-1",
  boxes: 3, floorCount: 28, width: 9, height: 6,
  rows: ["OOOOOOOOO", "O   R   O", "O A B C O", "O       O", "O a b c O", "OOOOOOOOO"],
});

export const BOX_5X5_A = freeze({
  fixtureId: "box-5x5-a",
  catalogId: "box-5x5-a",
  boxes: 2, floorCount: 9, width: 5, height: 5,
  rows: ["OOOOO", "OSX O", "O XRO", "O  SO", "OOOOO"],
});

export const MEDIUM = freeze({
  fixtureId: "medium",
  catalogId: "medium",
  boxes: 8, floorCount: 25, width: 7, height: 7,
  rows: ["OOOOOOO", "Oa   bO", "O AXB O", "O XRX O", "OSCXDSO", "OcS SdO", "OOOOOOO"],
});

export const INTER_ROOMS = freeze({
  fixtureId: "inter-rooms",
  catalogId: "inter-rooms",
  boxes: 4, floorCount: 30, width: 11, height: 6,
  rows: ["OOOOOOOOOOO", "O    O    O", "O RX   XS O", "O XO O OX O", "OSSO   OS O", "OOOOOOOOOOO"],
});

export const CORRIDOR_2 = freeze({
  fixtureId: "corridor-2",
  catalogId: "corridor-2",
  boxes: 3, floorCount: 50, width: 11, height: 9,
  rows: ["OOOOOOOOOOO", "O S O     O", "O   O X   O", "O     R   O", "O   O X   O", "O S O     O", "OOOOO X   O", "OOOOOO  S O", "OOOOOOOOOOO"],
});

export const GARDEN_2 = freeze({
  fixtureId: "garden-2",
  catalogId: "garden-2",
  boxes: 2, floorCount: 46, width: 11, height: 9,
  rows: ["OOOOOOOOOOO", "O    R    O", "O OOO OOO O", "O A     B O", "O OOO OOO O", "O  b   a  O", "O OO O OO O", "O         O", "OOOOOOOOOOO"],
});

export const WORKSHOP_1 = freeze({
  fixtureId: "workshop-1",
  catalogId: "workshop-1",
  boxes: 3, floorCount: 28, width: 7, height: 8,
  rows: ["OOOOOOO", "O   R O", "O OXO O", "O X   O", "OSX   O", "OS    O", "OS    O", "OOOOOOO"],
});

export const CLASSIC_1 = freeze({
  fixtureId: "classic-1",
  catalogId: "classic-1",
  boxes: 3, floorCount: 26, width: 7, height: 8,
  rows: ["OOOOOOO", "O     O", "O OXO O", "O  X  O", "OO X OO", "O  R  O", "O SSS O", "OOOOOOO"],
});

export const THEME_KITCHEN = freeze({
  fixtureId: "theme-kitchen",
  catalogId: "theme-kitchen",
  boxes: 3, floorCount: 36, width: 9, height: 8,
  rows: ["OOOOOOOOO", "O R     O", "O  OOO  O", "O X O X O", "O  O    O", "O  O  X O", "O SSS   O", "OOOOOOOOO"],
});

export const LARGE = freeze({
  fixtureId: "large",
  catalogId: "large",
  boxes: 6, floorCount: 36, width: 10, height: 10,
  rows: ["OOOOOOOOOO", "OOOOOOOSSO", "OOOOO  abO", "OOOOO XSSO", "OOOOOO  OO", "OR     OOO", "OO A X X O", "OO BXO O O", "OO   O   O", "OOOOOOOOOO"],
});

export const ADV_ROTARY = freeze({
  fixtureId: "adv-rotary",
  catalogId: "adv-rotary",
  boxes: 2, floorCount: 25, width: 11, height: 6,
  rows: ["OOOOOOOOOOO", "OOa  ROOOOO", "OO  OO  bOO", "O A    B  O", "O   OO    O", "OOOOOOOOOOO"],
});

export const ADV_FOUR_COLOR = freeze({
  fixtureId: "adv-four-color",
  catalogId: "adv-four-color",
  boxes: 4, floorCount: 49, width: 9, height: 9,
  rows: ["OOOOOOOOO", "Ob     cO", "O       O", "O  C  D O", "O   R   O", "O  A  B O", "O       O", "Od     aO", "OOOOOOOOO"],
});

export const ADV_GALLERY = freeze({
  fixtureId: "adv-gallery",
  catalogId: "adv-gallery",
  boxes: 4, floorCount: 50, width: 10, height: 10,
  rows: ["OOOOOOOOOO", "O R      O", "O OOOOOO O", "O O    O O", "O X SS X O", "O O    O O", "O OXOOXO O", "O        O", "O   SS   O", "OOOOOOOOOO"],
});

export const BOX_7X7 = freeze({
  fixtureId: "box-7x7",
  catalogId: "box-7x7",
  boxes: 4, floorCount: 24, width: 7, height: 7,
  rows: ["OOOOOOO", "OS   SO", "O  X  O", "O XRXOO", "O  X  O", "OS   SO", "OOOOOOO"],
});

export const SYM_DIAMOND = freeze({
  fixtureId: "sym-diamond",
  catalogId: "sym-diamond",
  boxes: 3, floorCount: 41, width: 11, height: 11,
  rows: ["OOOOOOOOOOO", "OOOOO OOOOO", "OOOO   OOOO", "OOO  S  OOO", "OO  XRX  OO", "O    X    O", "OO   S   OO", "OOO  S  OOO", "OOOO   OOOO", "OOOOO OOOOO", "OOOOOOOOOOO"],
});

export const THEME_LIBRARY = freeze({
  fixtureId: "theme-library",
  catalogId: "theme-library",
  boxes: 4, floorCount: 46, width: 11, height: 8,
  rows: ["OOOOOOOOOOO", "OaaO R ObbO", "O  O   O  O", "O  OO OO  O", "O   A B   O", "O  A   B  O", "O         O", "OOOOOOOOOOO"],
});

export const THEME_PARKING = freeze({
  fixtureId: "theme-parking",
  catalogId: "theme-parking",
  boxes: 5, floorCount: 52, width: 11, height: 9,
  rows: ["OOOOOOOOOOO", "O   R     O", "O A B C   O", "O  OOOOO  O", "O    X  X O", "O  OOOOO  O", "O a b c   O", "O      SSOO", "OOOOOOOOOOO"],
});

export const OPEN_FIELD = freeze({
  fixtureId: "open-field",
  catalogId: "open-field",
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
  fixtureId: "huge",
  catalogId: "huge",
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
  boxes: 6, floorCount: 39, width: 9, height: 9,
  rows: ["OOOOOOOOO", "O   R   O", "O  X X  O", "OOX   XOO", "OO     OO", "OO X X OO", "OOSSSSSOO", "OO  S  OO", "OOOOOOOOO"],
});

export const THEME_MUSEUM = freeze({
  fixtureId: "theme-museum",
  catalogId: "theme-museum",
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
// Grand Hall variants (computed at runtime from HUGE rows)
// ---------------------------------------------------------------------------

export const HUGE_MIRRORED = freeze({
  fixtureId: "huge-mirrored",
  catalogId: null,
  boxes: HUGE.boxes,
  floorCount: HUGE.floorCount,
  width: HUGE.width,
  height: HUGE.height,
  rows: mirrorRows(HUGE.rows),
});

export const HUGE_ROTATED = freeze({
  fixtureId: "huge-rotated",
  catalogId: null,
  boxes: HUGE.boxes,
  floorCount: HUGE.floorCount,
  width: HUGE.width,
  height: HUGE.height,
  rows: rotateRows(HUGE.rows),
});

// ---------------------------------------------------------------------------
// 17-box hand-designed fixture from spec §20.1
// (Identical to HUGE — Grand Hall IS the 17-box fixture)
// ---------------------------------------------------------------------------

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
]);

export const BENCHMARK_FIXTURE_BY_ID: Readonly<
  Record<string, BenchmarkFixture>
> = Object.freeze(
  Object.fromEntries(BENCHMARK_CORPUS.map((f) => [f.fixtureId, f])),
);

export function isClassicEligible(fixture: BenchmarkFixture): boolean {
  return fixture.boxes <= 8 && fixture.floorCount <= 96;
}
