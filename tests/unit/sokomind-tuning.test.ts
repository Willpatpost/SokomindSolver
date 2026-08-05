import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_SOKOMIND_TUNING,
  resolveSokomindTuning,
  sokomindTuningFingerprint,
  sokomindTuningPayload,
} from "../../src/solver/implementations/sokomind-tuning.ts";

describe("Sokomind tuning profile", () => {
  it("resolves a partial profile without changing the versioned defaults", () => {
    const profile = resolveSokomindTuning({ topologyWeight: 1.25 });

    assert.equal(profile.schemaVersion, 2);
    assert.equal(profile.topologyWeight, 1.25);
    assert.equal(
      profile.goalPackingWeight,
      DEFAULT_SOKOMIND_TUNING.goalPackingWeight,
    );
    assert.equal(Object.isFrozen(profile), true);
  });

  it("rejects non-finite, negative, and runaway optimizer values", () => {
    for (const topologyWeight of [Number.NaN, -1, 101]) {
      assert.throws(
        () => resolveSokomindTuning({ topologyWeight }),
        RangeError,
      );
    }
  });

  it("rejects unknown keys and incompatible schema versions", () => {
    assert.throws(
      () =>
        resolveSokomindTuning({
          planMoveWeigth: 0.02,
        } as never),
      /unknown.*planMoveWeigth/i,
    );
    assert.throws(
      () => resolveSokomindTuning({ schemaVersion: 99 } as never),
      /schema version 99/i,
    );
    assert.equal(
      resolveSokomindTuning({ schemaVersion: 1 }).schemaVersion,
      2,
    );
    assert.equal(
      resolveSokomindTuning({ schemaVersion: 2 }).schemaVersion,
      2,
    );
  });

  it("has stable fingerprints and maps heuristicWeight to engine weight", () => {
    const profile = resolveSokomindTuning({ heuristicWeight: 2.5 });
    const payload = sokomindTuningPayload(profile);

    assert.equal(payload.weight, 2.5);
    assert.match(
      sokomindTuningFingerprint(profile),
      /^v2;planMoveWeight=0\.005;heuristicWeight=2\.5;.*rewriteMoveWindowScale=/,
    );
  });

  it("preserves zero-valued weights so optimizers can disable soft terms", () => {
    const profile = resolveSokomindTuning({
      heuristicWeight: 0,
      costWeight: 0,
    });
    const payload = sokomindTuningPayload(profile);

    assert.equal(payload.weight, 0);
    assert.equal(payload.costWeight, 0);
  });
});
