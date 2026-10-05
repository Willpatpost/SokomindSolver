import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parsePuzzleRows } from "../../src/core/index.ts";
import {
  addLinearConflictCandidates,
  createExactHeuristicEvaluator,
  DisjointExtraSelector,
} from "../../src/solver/search/additive-extras.ts";
import { compileSearchBoard } from "../../src/solver/search/compiled-board.ts";
import {
  createExactSearchFeatureTelemetry,
  resolveExactSearchFeatures,
} from "../../src/solver/search/exact-search-features.ts";
import { createExactStateCodec } from "../../src/solver/search/exact-state.ts";
import {
  AssignmentHeuristic,
  minimumManhattanWalkToPotentialPush,
} from "../../src/solver/search/heuristic.ts";
import { InteractionBoostEvaluator } from "../../src/solver/search/interaction-boost.ts";
import { toDenseBoxes, type DenseBox } from "../../src/solver/search/model.ts";
import { PdbHeuristicEvaluator } from "../../src/solver/search/pdb-heuristic.ts";
import { createZobristTable } from "../../src/solver/search/zobrist-state.ts";
import { createFuzzRng, generateFuzzBoard, type FuzzRng } from "../support/exact-fuzz.ts";
import { allReachableStateCosts } from "../support/exact-solver-oracle.ts";

interface Instance {
  readonly surplus: readonly number[];
  readonly candidates: readonly { readonly labels: readonly number[]; readonly value: number }[];
}

/** Total surplus plus the best sum of (value - surplus) over disjoint candidates. */
function bruteForce({ surplus, candidates }: Instance): number {
  let best = 0;
  for (let subset = 0; subset < 1 << candidates.length; subset++) {
    let used = 0;
    let gain = 0;
    let disjoint = true;
    for (let c = 0; c < candidates.length && disjoint; c++) {
      if (!(subset & (1 << c))) continue;
      gain += candidates[c].value;
      for (const label of candidates[c].labels) {
        if (used & (1 << label)) disjoint = false;
        used |= 1 << label;
        gain -= surplus[label];
      }
    }
    if (disjoint && gain > best) best = gain;
  }
  return surplus.reduce((sum, value) => sum + value, 0) + best;
}

function load(selector: DisjointExtraSelector, rng: FuzzRng, { surplus, candidates }: Instance): void {
  selector.reset();
  surplus.forEach((value, label) => {
    // A label may get its surplus in parts (one per PDB partition), or only
    // appear in candidates.
    if (value === 0 && rng.chance(0.5)) return;
    const part = rng.int(0, value);
    selector.addSurplus(`L${label}`, part);
    selector.addSurplus(`L${label}`, value - part);
  });
  for (const { labels, value } of candidates) {
    selector.addCandidate(labels.map((label) => `L${label}`), value);
  }
}

describe("label-disjoint extra selection", () => {
  it("equals the best disjoint sum for up to 20 labels", () => {
    const rng = createFuzzRng(33);
    const selector = new DisjointExtraSelector();
    for (let trial = 0; trial < 500; trial++) {
      const labelCount = rng.int(1, 8);
      const instance: Instance = {
        surplus: Array.from({ length: labelCount }, () => (rng.chance(0.5) ? rng.int(1, 4) : 0)),
        candidates: Array.from({ length: rng.int(0, 9) }, () => {
          const labels = [...Array(labelCount).keys()].filter(() => rng.chance(0.3));
          if (labels.length === 0) labels.push(rng.int(0, labelCount - 1));
          return { labels, value: rng.int(0, 8) };
        }),
      };
      load(selector, rng, instance);
      assert.equal(selector.best(), bruteForce(instance), JSON.stringify(instance));
    }
  });

  it("stays within the best disjoint sum above 20 labels", () => {
    const rng = createFuzzRng(34);
    const selector = new DisjointExtraSelector();
    for (let trial = 0; trial < 40; trial++) {
      // Every candidate keeps a positive weight and the first eight cover all
      // 24 labels, so the greedy fallback runs.
      const surplus = Array.from({ length: 24 }, (): number => (rng.chance(0.2) ? 1 : 0));
      const candidates = [
        ...Array.from({ length: 8 }, (_, c) => ({ labels: [3 * c, 3 * c + 1, 3 * c + 2], value: rng.int(4, 8) })),
        ...Array.from({ length: 4 }, () => ({
          labels: [...new Set([rng.int(0, 23), rng.int(0, 23), rng.int(0, 23)])],
          value: rng.int(4, 8),
        })),
      ];
      const instance = { surplus, candidates };
      load(selector, rng, instance);
      const best = selector.best();
      assert.ok(best >= surplus.reduce((sum, value) => sum + value, 0));
      assert.ok(best <= bruteForce(instance), JSON.stringify(instance));
    }
  });

  it("counts a connected group of linear-conflict pairs at 2 per pair", () => {
    // B is in a row pair with A and a column pair with C. No two pairs are
    // disjoint, but the pushes of the group still add.
    const selector = new DisjointExtraSelector();
    addLinearConflictCandidates(selector, ["A", "B", "B", "C", "D", "E"]);
    assert.equal(selector.best(), 6);
    selector.reset();
    selector.addSurplus("B", 3);
    addLinearConflictCandidates(selector, ["A", "B", "B", "C", "D", "E"]);
    assert.equal(selector.best(), 6);
  });
});

describe("shared exact heuristic admissibility", () => {
  it("never exceeds the pushes or moves left on fuzz boards", () => {
    let boards = 0;
    let states = 0;
    let raises = 0;
    for (let i = 0; i < 20_000 && boards < 41; i++) {
      // Seed 7777 (four typed boxes) is the only one of the first 40,000
      // seeds whose states get an additive raise, so it always runs first.
      // Small boards fill the rest.
      const seed = i === 0 ? 7777 : i;
      const fuzz = generateFuzzBoard(seed);
      // A label's PDB surplus needs two of its boxes, and a raise needs
      // parts on disjoint labels, so take boards with at least three boxes.
      if (!fuzz || fuzz.labelMode === "all-x" || fuzz.boxCount < 3) continue;
      const parsed = parsePuzzleRows([...fuzz.rows]);
      const board = compileSearchBoard(parsed);
      let stateBound = 1;
      for (let k = 0; k <= fuzz.boxCount; k++) stateBound *= board.cellCount - k;
      if (i > 0 && stateBound > 60_000) continue;
      boards += 1;

      const labels = [...board.goalCellsByLabel.keys()].sort();
      const codec = createExactStateCodec(board.cellCount, labels);
      const packBoxKey = (boxes: readonly DenseBox[]) => codec.packBoxTokens(codec.tokensFromBoxes(boxes));
      const heuristic = new AssignmentHeuristic(board, { packBoxKey });
      const telemetry = createExactSearchFeatureTelemetry();
      const evaluator = createExactHeuristicEvaluator({
        features: resolveExactSearchFeatures(),
        heuristic,
        zobristTable: createZobristTable(board.cellCount, labels.length),
        boostEvaluator: new InteractionBoostEvaluator(board, board.topology),
        pdbEvaluator: new PdbHeuristicEvaluator(board),
        goalCutEvaluator: null,
        perimeterTable: null,
        componentPdbCollection: null,
        moveCostPdbCollection: null,
        telemetry,
        counters: { secondaryCutoffs: 0, interactionBoostTotal: 0 },
      });
      const lcOnly = new DisjointExtraSelector();
      const pairs: string[] = [];
      const robot = board.cellAt(parsed.initialRobot.row, parsed.initialRobot.column);
      const initialBoxes = toDenseBoxes(board, parsed.initialBoxes);
      for (const state of allReachableStateCosts(board, robot, initialBoxes).values()) {
        if (state.exactMoves === null || state.exactPushes === null) continue;
        states += 1;
        const tokens = codec.tokensFromBoxes(state.boxes);
        const boxKey = codec.packBoxTokens(tokens);
        const h = (walk: number) => evaluator.evaluate(
          heuristic.evaluate(state.boxes), walk, state.boxes, tokens, state.robot, boxKey, 0, Infinity,
        );
        const where = `seed ${seed}, robot ${state.robot}, boxes ${JSON.stringify(state.boxes)}`;
        const pushes = h(0);
        assert.ok(pushes <= state.exactPushes, `${where}: h ${pushes} > ${state.exactPushes} pushes`);
        const moves = h(minimumManhattanWalkToPotentialPush(board, state.robot, state.boxes));
        assert.ok(moves <= state.exactMoves, `${where}: h ${moves} > ${state.exactMoves} moves`);

        // Linear conflict alone selects exactly its own total.
        pairs.length = 0;
        const lc = heuristic.lastLinearConflict(state.boxes, pairs);
        lcOnly.reset();
        addLinearConflictCandidates(lcOnly, pairs);
        assert.equal(lcOnly.best(), lc, where);
      }
      raises += telemetry.additiveExtraRaises;
    }
    assert.ok(boards >= 8, `${boards} boards`);
    assert.ok(raises > 0, `no additive raise in ${states} states on ${boards} boards`);
  });
});
