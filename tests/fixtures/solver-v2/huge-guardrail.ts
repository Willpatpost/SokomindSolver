/** Reviewed deterministic counters enforced by the Grand Hall performance gate. */
export const HUGE_DISCOVERY_GUARDRAIL = Object.freeze({
  moves: 893,
  pushes: 278,
  visited: 1_329,
  generated: 8_425,
  retained: 2_538,
  peakFrontier: 291,
});

/** Reviewed counters for the optional Grand Hall quality rewrite. */
export const HUGE_REWRITE_GUARDRAIL = Object.freeze({
  moves: 789,
  pushes: 270,
  visited: 29_000,
  moveVisited: 4_000,
  moveWindowAdaptiveStop: true,
});
