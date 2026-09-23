// Text transforms the prepare script applies to the vendored engine sources.
// They throw instead of emitting a silently wrong artifact, because --check
// compares against the output of these same transforms.

const VALIDATOR_END = "\nfunction evaluateStrategicPlanState";

// The vendored sources retain their old classic-script test exports. The
// generated ESM has explicit exports and should neither expose CommonJS
// globals nor publish debugging namespaces on the worker.
export function stripRegistration(source, file) {
  const stripped = source
    .replace(/^if \(typeof module === "object" && module\.exports\).*$/gmu, "")
    .replace(/^if \(typeof globalThis !== "undefined"\) globalThis\.Sokomind.*$/gmu, "")
    .replace(/^globalThis\.SokomindHardPruningRules.*$/gmu, "");
  // These tokens appear only on the registration lines, so any left over
  // means a line no longer matches the patterns above.
  if (/module\.exports|globalThis\.Sokomind/u.test(stripped)) {
    throw new Error(`prepare-sokomind-engine: unstripped registration line in ${file}`);
  }
  return stripped;
}

// The standalone validator is everything in strategic-contract.js before the
// state evaluator, which needs engine globals.
export function extractValidatorSource(contractSource) {
  const validatorEnd = contractSource.indexOf(VALIDATOR_END);
  if (validatorEnd < 0) {
    throw new Error(
      `prepare-sokomind-engine: ${JSON.stringify(VALIDATOR_END.trim())} not found in strategic-contract.js; update the validator slice`,
    );
  }
  const validatorSource = contractSource.slice(0, validatorEnd);
  if (!validatorSource.includes("function validateStrategicPlanContract(")) {
    throw new Error("prepare-sokomind-engine: validator source missing validateStrategicPlanContract");
  }
  return validatorSource;
}
