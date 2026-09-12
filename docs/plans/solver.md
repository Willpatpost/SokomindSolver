# Solver plan

Active solver development goals and constraints. For shipped behavior, see
[Solver status](../solver-status.md). For measurements, see
[Solver benchmarks](../solver-benchmarks.md). Git history preserves the
superseded audit, strategic roadmap, fast-analyzer plan, and quality roadmap.

## Target

Replay-valid Grand Hall solution of at most **650 moves within 3 seconds of
search** (after analysis), independently generated â€” not via post-hoc repair.
Current best: 647 moves via whole-box rescheduling of an existing incumbent.

The 3-second search gate is deferred until the analyzer reliably produces
better routes. Quality and generalization come first, then latency.

## Next step

Adapt the costed scheduling model from `solution-box-reschedule` to evaluate
analyzer-generated **partial schedules** where feasibility must still be
established. A repair requiring a complete incumbent is not pre-search success.

## Open work

### Implemented controls awaiting experimental promotion

- **P1.1 Macro intermediate retention** — implemented as `macroIntermediateQuota`
  (default 0). Controlled quality/generalization evidence is required before enabling.
- **P1.2 Keeper-arrival beam** — implemented as `moveAwareDiscovery` (default 0).
  Production promotion remains conditional on controlled benchmarks.
- **P1.3 First-push walk cost** — implemented as `firstPushWalkWeight` (default 0).
  Remains a soft ordering experiment, not a proof heuristic.
- **P1.4 Reschedule-derived schedule trace** — implemented in repair telemetry and
  `scripts/diagnose-schedule-trace.ts`; use the trace to evaluate partial schedules.

### Delivered P2 implementation

- **P2.1 Reschedule-value predictor** — implemented in
  `src/solver/implementations/sokomind-reschedule-predictor.ts` and used by the
  quality-mode harvesting path. Optimal-mode eligibility is preserved.
- **P2.2 Route diagnosis script** — available through `npm run diagnose:solver-route`.

### Remaining modularization work

- **P2.3 Engine modularization** — review keeper-arrival/Pareto ownership for the
  next behavior-preserving extraction. Existing adapter lifecycle helpers are
  already separate modules; a wholesale engine rewrite remains rejected.

### Pending experiments

- 503 route recoverability trace against the structural planner.
- Reschedule earlier in the pipeline (before full rewrite).
- Joint 2-box repair for highly interacting box pairs.
- Assignment-aware rescheduling for repeated-label boxes.
- Incremental keeper distance caching in discovery.
- Box-work phase penalty (soft ordering, not hard prune).
- Move-aware macro endpoint Pareto scoring.
- Fixed-width direction diversity or walk-to-support ordering with a disabled
  control and broader-corpus checks.

### Unbuilt architecture

- Connect unresolved obligations across a full schedule and scope blocker
  evidence to hypotheses (whole-plan hypothesis solver).
- Incremental schedule repair, broader goal assignment alternatives, and
  deadline-aware global rewriting.
- Proven clearance and space-reservation feasibility.

## Promotion criteria

- Verified move count versus production and prior experiments.
- Declared budgets, environment, and hardware.
- Causal evidence, not just correlation with more effort.
- Full replay verification through the core engine.
- Full success fraction across cold/warm browser runs (10+ reps), not just
  best or median.
- Quality upgrades need quality + generalization + correctness + latency
  evidence before default promotion.
- Experimental configs must not be activated just because their code is tested.

## Rejected and deferred ideas

| Idea | Status | Reason |
|---|---|---|
| Simple branch widening (6/8/10/12/16) | Rejected | Sweeps found no improvement; Grand Hall worsened or exhausted budgets. |
| Local-window allocation ablation | Rejected | No gain found during quality-budget investigation. |
| Wholesale engine rewrite | Rejected | Too risky; extract one primitive at a time. |
| Scalar tuning | Deferred to P3 | Cannot fix missing states; improve candidate retention first. |
| Hard pruning from heuristic deadlock | Rejected | Requires proof-level safety argument + counterexample tests. |
| Machine learning | Deferred | Needs clean fact/task/resource/plan representations first. |
| Increased `strategicAnalysisMs` | Rejected | Goal is better deduction per unit work, not more preprocessing. |
| Persistent learning / reverse workers | Deferred | Until measurements identify a specific need. |
| Persistent resume support | Deferred | Until short-budget path is evaluated. |
| Pair-pattern tables | Deferred | Until profiling shows repeated interaction-cost bottleneck. |
| Reverse lane expansion | Deferred | Only with benchmark evidence; fix meeting-map ownership first. |

## Failed sprints (preserved as controls)

- **Sprint 1 (persistent execution):** Maze improved, Grand Hall regressed.
  Not promoted.
- **Sprint 2 (connected inference):** 952/322 on Grand Hall (worse than
  production 893/278). Expert maze regressed from 107 to 127 moves.
- **Sprint 3 (local approach repair):** Grand Hall exhausted frontier. 61
  choices attempted, 60 failures. Eager enumeration also unsuccessful.
- **Strategic plan execution:** Grand Hall regresses with
  `strategicPlanExecution: true`. 789â†’780 in Node but search-time target not
  reached.

## Invariants

1. Solver output is untrusted input â€” independent replay verification must
   never be bypassed.
2. Bounded discovery must never claim proof. Only completed exact move proof
   sets optimality to proven.
3. Hard prunes require: mathematical safety argument, positive tests,
   counterexample tests, replay-valid results with and without, and controlled
   benchmarks.
4. Three reasoning strengths: `proven` (hard prune), `derived-safe` (hard
   prune with soundness argument), `heuristic` (ranking only, never
   completeness-destroying).
5. Worker budgets are shared, not multiplied by concurrency.
6. Generated engine must remain reproducible from source files.
7. Tuning may affect ordering, never legality.
8. The 626-move human solution is a diagnostic fixture only, never a runtime
   route source.
9. No reference-derived route or puzzle-specific strategy may enter runtime.
10. Timing must be measured separately: analysis vs. search vs. total.
11. Board state is the fundamental search identity; plan metadata joins the
    transposition key only when it changes future admissibility.
12. Same-label box symmetry: use set-valued candidates until identity is forced;
    allow plan repair to rebind interchangeable boxes.
13. Proof records must be versioned/fingerprinted; stale proofs rejected across
    board/solver/feature revisions.
14. A 50,000-state quality budget reaches only 709 moves (budget sensitivity
    baseline).
