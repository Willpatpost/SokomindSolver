import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  extractValidatorSource,
  stripRegistration,
} from "../../scripts/sokomind-engine-artifacts.mjs";

const engineDirectory = new URL(
  "../../src/solver/implementations/sokomind-engine/",
  import.meta.url,
);

describe("Sokomind engine artifact transforms", () => {
  it("rejects a strategic contract without the validator's end marker", () => {
    assert.throws(
      () => extractValidatorSource("function validateStrategicPlanContract(){}\n"),
      /not found/u,
    );
  });

  it("rejects a validator slice without the validator", () => {
    assert.throws(
      () => extractValidatorSource("function other(){}\nfunction evaluateStrategicPlanState(){}\n"),
      /missing validateStrategicPlanContract/u,
    );
  });

  it("slices the checked-in validator artifact from the strategic contract", async () => {
    const contract = await readFile(new URL("source/strategic-contract.js", engineDirectory), "utf8");
    const validator = extractValidatorSource(contract);
    assert.equal(validator.includes("evaluateStrategicPlanState"), false);
    assert.equal(validator.includes("rebaseStrategicPlan"), false);

    const artifact = await readFile(
      new URL("strategic-validation.generated.js", engineDirectory),
      "utf8",
    );
    const body = `${validator}\nexport { validateStrategicPlanContract };\n`;
    assert.ok(artifact.endsWith(body), "artifact is the banner, the validator and its export");
    const banner = artifact.slice(0, artifact.length - body.length);
    assert.match(banner, /^\/\*\n \* GENERATED FILE - DO NOT EDIT DIRECTLY\.\n/u);
    assert.match(banner, /\n \*\/\n$/u);
  });

  it("strips the single-line registration forms", () => {
    const source = [
      "const SokomindMemo = {};",
      'if (typeof globalThis !== "undefined") globalThis.SokomindMemo = SokomindMemo;',
      "globalThis.SokomindHardPruningRules = HARD_PRUNING_RULES;",
      'if (typeof module === "object" && module.exports) module.exports = SokomindMemo;',
    ].join("\n");
    assert.equal(stripRegistration(source, "memo.js"), "const SokomindMemo = {};\n\n\n");
  });

  it("rejects a registration line the patterns do not match", () => {
    assert.throws(
      () => stripRegistration('if (typeof module === "object"\n  && module.exports) module.exports = X;', "x.js"),
      /unstripped registration line in x\.js/u,
    );
  });
});
