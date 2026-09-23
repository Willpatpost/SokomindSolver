// The Sokomind engine's classic scripts deliberately share one lexical scope.
// Their original browser worker loaded them in this dependency order with
// importScripts(). The prepare script concatenates them in this order, and the
// unit tests that evaluate the sources in a VM load the same list.
export const SOKOMIND_ENGINE_SOURCE_FILES = Object.freeze([
  "state.js",
  "memo.js",
  "metrics.js",
  "topology.js",
  "board.js",
  "pdb.js",
  "heuristic.js",
  "deadlock.js",
  "analysis.js",
  "push-generation.js",
  "strategic-contract.js",
  "strategic-inference.js",
  "strategic-planning.js",
  "box-rescheduling.js",
  "schedule-trace.js",
  "solver-search.js",
]);
