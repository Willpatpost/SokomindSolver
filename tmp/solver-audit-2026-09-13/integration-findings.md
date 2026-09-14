# Solver integration audit — 2026-09-13

These findings come from the current checkout. No production files were changed.
Run `node --experimental-strip-types tmp/solver-audit-2026-09-13/integration-repros.ts`
from the repository root. Captured output is in `integration-repros.jsonl`.

## P1 — Explicitly disabled strategic experiments are forced on in quality mode

- Anchor: `src/solver/implementations/sokomind-solver.ts:400-413`.
- Contract: `src/solver/implementations/sokomind-options.ts:7-10` says zero preserves the reviewed planner and execution is independent. The adapter rewrites both fields whenever mode is quality, the puzzle is structural, deterministic is false, and analysis time equals zero.
- Reproduction: an explicit `{mode:"quality", strategicAnalysisMs:0, strategicPlanExecution:false}` becomes an analysis command with `{maxMs:500, inferenceWork:2048}`. The structural plan also receives execution enabled through the rewritten request.
- Impact: callers cannot disable this experiment for an ordinary quality solve; search time/work and strategy change, and control comparisons can silently test the experimental pipeline. `docs/solver-benchmarks.md:533-534` records that its quality gate has not passed and both options remain off by default. `docs/plans/solver.md` records Grand Hall regressions for this feature.
- Improvement: preserve explicit zero/false. Keep the experiments off until the stated quality/generalization/browser promotion gates pass. If automatic selection is desired, represent it as a distinct explicit policy and record the resolved options in result/benchmark metadata.

## P1 — Bidirectional workers bypass the generated-state allowance

- Anchors: `src/solver/implementations/sokomind-plans.ts:281-318` and `src/solver/implementations/sokomind-engine/source/solver-search.js:4054-4105`.
- Plan construction divides expanded work but never supplies a generated limit to either side. The side kernel checks only `maxVisited`; it increments `generated` for successors without any generated cap. The coordinator learns the count from batches/terminal messages, after the work has happened.
- Reproduction: a one-box room with the raw side kernel and `maxGenerated:1` generates 21 successors and reports `cutoff:false`. A real three-worker public Node solve with `maxGeneratedStates:3` returns `limit-reached` with 21 generated and 9 expanded states. The exact amount can vary with worker message scheduling; the violated ceiling is the relevant assertion.
- Impact: finite generated budgets are not shared as promised. This can overspend resources and invalidate budget-matched comparisons, especially on large, branching boards where reports are sparse.
- Improvement: pass disjoint integer generated shares to both side workers and enforce them per generated successor. Include zero and remainder cases and real-worker finite-budget regression cases, alongside the existing mocked tests. Retain the global coordinator check as a backstop.

## P2 — Aggregate cache omits newly registered worker memory

- Anchors: `src/solver/implementations/sokomind-phase-runner.ts:501`, `:603`; `src/solver/implementations/sokomind-run-state.ts:79-84`.
- The initial limit check populates the aggregate cache. Registering a worker reserves a 16 MiB estimate in the registry but does not invalidate that cache. The subsequent startup limit check and progress report still see zero bytes until a worker telemetry message arrives.
- Reproduction: with a 1-byte memory limit, a silent worker is created and receives a search command. A 40 ms elapsed limit ends it; the result reports time limit rather than memory limit, and peak estimated memory remains zero.
- Related audit sites: `retainLegacyRecord()` (`sokomind-run-state.ts:441-456`) also changes the coordinator ledger without invalidating the aggregate. `inspectMeetings()` calls `reachedLimit()` immediately after those writes (`sokomind-phase-runner.ts:397-404`), so the same stale-cache pattern can postpone accounting for the current record batch. Phase reset similarly mutates the ledger outside cache ownership. Only worker-registration behavior is exercised in the saved reproduction.
- Improvement: centralize registry/ledger mutations behind methods that advance an aggregate version, or calculate the small aggregate directly until profiling justifies caching. Test initial registration, each record batch, prepared-board retention, phase release, and silent-worker startup.

## Other observations and priorities

- Preserve existing exact-search incumbent-on-cancellation behavior unless intentionally changing the API: unit tests explicitly require it. A first suspected cancellation defect was withdrawn after checking those tests. Documentation should distinguish the outer worker's cancelled result from direct exact API incumbent preservation.
- Existing `tests/unit/sokomind-solver.test.ts:1184` exercises silent-worker startup memory without an elapsed limit; the broken cache makes it wait for the two-minute silence watchdog. The saved reproduction caps that wait at 40 ms.
- CI already has useful multi-puzzle, parallel proof, Huge, browser matrix, and weekly extended optimum gates. Add narrow integration regressions for these defects instead of creating another broad duplicate suite.
- Before tuning discovery/repair allocation further, restore explicit option control and comparable resource budgets. Then measure effective configuration and analysis/search/harvest/rewrite/proof timings separately, using independent replay verification and matched budget controls.
