import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseSokomindOptions,
} from "../../src/solver/implementations/sokomind-options.ts";

describe("parseSokomindOptions experimentalOperators", () => {
  it("defaults to empty array", () => {
    const result = parseSokomindOptions({});
    assert.deepEqual([...result.experimentalOperators], []);
  });

  it("accepts valid operators", () => {
    const result = parseSokomindOptions({
      experimentalOperators: ["two-box", "goal-reassignment"],
    });
    assert.deepEqual([...result.experimentalOperators], ["two-box", "goal-reassignment"]);
  });

  it("accepts all four operators", () => {
    const result = parseSokomindOptions({
      experimentalOperators: ["two-box", "goal-reassignment", "dependency-window", "perturb-and-repair"],
    });
    assert.equal(result.experimentalOperators.length, 4);
  });

  it("rejects unknown operator", () => {
    assert.throws(
      () => parseSokomindOptions({ experimentalOperators: ["bogus"] }),
      /experimentalOperators entry must be/,
    );
  });

  it("rejects duplicate operator", () => {
    assert.throws(
      () => parseSokomindOptions({ experimentalOperators: ["two-box", "two-box"] }),
      /duplicate experimentalOperators/,
    );
  });

  it("rejects non-array", () => {
    assert.throws(
      () => parseSokomindOptions({ experimentalOperators: "two-box" }),
      /must be an array/,
    );
  });

  it("accepts empty array", () => {
    const result = parseSokomindOptions({ experimentalOperators: [] });
    assert.equal(result.experimentalOperators.length, 0);
  });

  it("result is frozen", () => {
    const result = parseSokomindOptions({
      experimentalOperators: ["two-box"],
    });
    assert.ok(Object.isFrozen(result.experimentalOperators));
  });
});
