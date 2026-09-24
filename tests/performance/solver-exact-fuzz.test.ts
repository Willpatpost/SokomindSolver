/**
 * Long seeded differential fuzz of the exact move engines (ACTION-ITEMS P8.8):
 * `npm run test:solver:fuzz`. The unit suite runs a fixed 100-board slice
 * (tests/unit/solver-exact-fuzz.test.ts).
 *
 * - SOKOMIND_FUZZ_SEED: first seed (default 1000000).
 * - SOKOMIND_FUZZ_BOARDS: board count (default 100000; the time budget
 *   normally ends the run first).
 * - SOKOMIND_FUZZ_MINUTES: time budget; no new board starts after it
 *   (default 10).
 * - SOKOMIND_FUZZ_ALL_VARIANTS=1: every variant, the opt-in ones included, on
 *   both engines for every board.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FUZZ_ENGINES,
  FUZZ_OPT_IN_VARIANTS,
  FUZZ_VARIANTS,
  crossFuzzRunPlans,
  formatFuzzFailure,
  runFuzzCampaign,
  summarizeFuzzCampaign,
  type FuzzRunPlan,
} from "../support/exact-fuzz.ts";

function positiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const FIRST_SEED = Math.floor(positiveEnv("SOKOMIND_FUZZ_SEED", 1_000_000));
const BOARDS = Math.floor(positiveEnv("SOKOMIND_FUZZ_BOARDS", 100_000));
const MINUTES = positiveEnv("SOKOMIND_FUZZ_MINUTES", 10);
const ALL_VARIANTS = process.env.SOKOMIND_FUZZ_ALL_VARIANTS === "1";

const EXTRA_VARIANTS = [...FUZZ_VARIANTS.slice(1), ...FUZZ_OPT_IN_VARIANTS];
const ALL_PLANS = crossFuzzRunPlans(FUZZ_ENGINES, [...FUZZ_VARIANTS, ...FUZZ_OPT_IN_VARIANTS]);

/**
 * Default features and two rotating extra variants, each on both engines: six
 * runs per board, and every extra variant once every seven boards.
 */
function plansForBoard(boardIndex: number): readonly FuzzRunPlan[] {
  if (ALL_VARIANTS) return ALL_PLANS;
  const first = (2 * boardIndex) % EXTRA_VARIANTS.length;
  return crossFuzzRunPlans(FUZZ_ENGINES, [
    FUZZ_VARIANTS[0],
    EXTRA_VARIANTS[first],
    EXTRA_VARIANTS[(first + 1) % EXTRA_VARIANTS.length],
  ]);
}

describe("exact move engine differential fuzz", () => {
  it(
    `finds no soundness failures from seed ${FIRST_SEED} within ${MINUTES} minutes`,
    { timeout: (MINUTES + 10) * 60_000 },
    async () => {
      const report = await runFuzzCampaign({
        firstSeed: FIRST_SEED,
        boards: BOARDS,
        deadline: performance.now() + MINUTES * 60_000,
        plansForBoard,
        // A time limit makes results machine-dependent; a limit result is
        // still only a bound, so it can never fail the run.
        limits: { maxExpandedStates: 200_000, maxElapsedMs: 10_000 },
        oracleMaxStates: 400_000,
        crossCheckMaxStates: 20_000,
        crossCheckLimit: 200,
        minimizeFailures: true,
        onFailure: (failure) => console.info(formatFuzzFailure(failure)),
      });
      const summary = summarizeFuzzCampaign(report);
      console.info(`exact fuzz: ${summary}`);
      console.info(`exact fuzz runs by variant: ${JSON.stringify(report.runsByVariant)}`);
      assert.deepEqual(report.failures.map(formatFuzzFailure), [], summary);
      assert.deepEqual(report.crossCheckMismatches, [], summary);
      assert.equal(report.reversePullUnsolvable, 0, summary);
      assert.ok(report.boards > 0, summary);
    },
  );
});
