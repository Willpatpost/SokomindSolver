# Sokomind cleanup review

Reviewed at commit `2b6ff7ae0e0cbf19092db205c2a165ce3ad4a2e9`, September 11, 2026. This is a removal and consolidation assessment. No project files were deleted or modified.

## Recommendation

The largest cleanup opportunity is historical research material and overlapping solver plans. Keep a small set of current guides, one active solver plan, and the evidence that still supports a live test or a current engineering decision. Use Git history for superseded narratives and raw experiment captures.

The inventory covers **all 744 tracked files**: 347 under source, 239 under tests, 77 under docs, 46 scripts, 6 result logs, 8 public assets, 5 GitHub files, and 16 root files. There are **33 Markdown documents**, including root and engine documentation. See the [complete per-file inventory](C:/Users/Willp/.codex/visualizations/2026/09/11/01a090b5-5328-7343-b8c2-25b5abec7c4b/cleanup-inventory.md) or [machine-readable inventory](C:/Users/Willp/.codex/visualizations/2026/09/11/01a090b5-5328-7343-b8c2-25b5abec7c4b/cleanup-inventory.json).

Priority order:

1. Replace four overlapping solver audits/plans, totaling **6,518 lines**, with one short active plan and the existing current guides.
2. Remove **19 exactly duplicated benchmark artifacts** after repairing their summary pointers and output script.
3. Remove the six historical P1 raw logs after preserving a compact result summary and provenance. They occupy **41,881,486 bytes**, or **79.8% of tracked working-file bytes**.
4. Remove the small confirmed unused symbols and obsolete tools listed below.
5. Retire or relocate isolated solver prototypes while preserving tests that validate the actual engine.

Deleting tracked logs reduces checkout size and clutter. It does not erase existing Git history or automatically reduce a full historical clone by the same amount. No history rewrite is needed for this cleanup.

## Documentation: remove or consolidate

| Existing file | Decision | What must survive |
|---|---|---|
| `docs/solver-quality-roadmap.md` — 253 lines | Remove after consolidation | Explicitly superseded by the fast-analyzer plan. Retain unique product acceptance wording in the new plan. |
| `docs/fast-strategic-analyzer-plan.md` — 462 lines | Remove after consolidation | Its own introduction defers sequencing to the strategic roadmap. Preserve timing semantics, failed sprint conclusions, and remaining work. |
| `docs/SOKOMIND_SOLVER_STRATEGIC_ROADMAP.md` — 2,800 lines | Replace with a short active plan | Preserve unresolved strategic goals and evidence-first acceptance rules. Remove the repeated architecture catalog, pseudocode proposals, and completed stages from everyday documentation. |
| `docs/SOKOMIND-SOLVER-AUDIT.md` — 3,003 lines | Remove after extracting remaining work | A snapshot audit followed by implementation diaries. Current repair, proof, memory, and trace follow-ups already have dedicated owners. Extract actionable unfinished items; keep snapshot history in Git. |
| `docs/p1-tuning-experiments.md` | Merge into `docs/solver-benchmarks.md`, then remove | Recent negative/mixed A/B findings remain useful: default-disabled settings, exact overrides, commit, hardware, sample policy, and fingerprint limitation. |
| `docs/benchmarks/grand-hall-diagnosis.md` | Merge conclusions into benchmark guide, then remove | Consequential divergence findings, uncertainty, and the diagnostic command. |
| `docs/benchmarks/grand-hall-route-accounting.md` | Remove generated report after consolidation | Keep replayable route data and the tool that computes accounting. Large snapshot tables do not need a second maintained narrative. |
| `docs/benchmarks/planner-branch-diversity.md` | Merge negative result into benchmark guide, then remove | Preserve the fact that simple branch widening regressed; retain compact outcome table and experiment limits. |

Create **`docs/plans/solver.md`**, roughly 100–150 lines, as the only active solver roadmap. It should state current shipped behavior by link, the next evidence-supported experiment, unresolved requirements, promotion criteria, and explicitly rejected/deferred ideas. The outstanding analyzer/partial-schedule work is not complete merely because whole-route rescheduling works. Preserve that distinction.

Preserve the original quality-versus-latency intent: separate analysis, downstream search, and total costs; improve quality and generalize before promoting defaults; reference routes remain offline diagnostic inputs; timeouts do not prove impossibility. Replace obsolete baseline prose with links to the current evidence owners.

Do not build a second `docs/archive/` full of the same documents. The removed snapshots are already tracked in Git. Record the cleanup commit as their retrieval point if needed.

## Documentation: keep, but shorten

- **`docs/plans/maintenance.md`:** retain active boundaries and removal rules. Delete the completed-foundation list and resolved September 4 audit diary. Current contracts and tests already preserve those results.
- **`docs/solver-benchmarks.md`:** retain commands, schema, methodology, accepted/rejected results, and artifact policy. Remove the stale September 5 next-step roadmap; it recommends work that later reports describe as implemented. A benchmark guide should not compete with the active plan.
- **`docs/generator-benchmarks.md`:** retain current qualification, release decisions, fixed-seed samples, and worker scaling. Collapse the long rejected V2 prototype history into its conclusions and provenance.
- **`docs/benchmarks/grand-hall-rescheduling.md`:** retain current algorithm, eligibility, publication/cutoff behavior, best public versus isolated results, and reproduction. Collapse the 647-era chronology and label-sweep diary.
- **`docs/benchmarks/quality-memory-policy.md`:** retain the policy and the invalid-proof warning. Its safety rationale still explains current behavior; old measurements can be summarized without repeating every follow-up.
- **`docs/architecture.md` and `docs/solver-integration.md`:** retain their distinct architecture/API roles, but link to storage, status, and benchmark owners instead of maintaining duplicate detail.
- **`CHANGELOG.md`:** keep a short release-facing summary. Avoid using it as another task log.

## Documentation that still earns its place

Keep the root README, contributor guide, engineering instructions, security policy, license, documentation index, and source-checked project reference. Keep deployment, puzzle format, persistence/sharing, experience, testing, solver status, solver integration, Solver Lab, and generator contract guides.

Keep **`docs/plans/ui-ux.md`**: it already contains unimplemented creator intelligence and online-readiness work rather than the completed UI sprint diary. Those are product decisions, not dead documentation.

Keep **`docs/generator-solution-story-contract.md`**: phase-numbered sections describe active evidence and acceptance rules. A historical-looking title or phase label is not sufficient reason to remove a live contract.

Keep the engine README and **`docs/benchmarks/planner-route-recoverability.md`**: both explain specialized active maintenance/diagnostic workflows.

## Data and benchmark artifacts

### Exact duplicates: remove 19 files

Every field from these files is already embedded in `docs/benchmarks/grand-hall-rescheduling-summary.json`. This was checked by comparing parsed field values, not inferred from similar names:

- `grand-hall-reschedule-discovery-H.json`
- `grand-hall-reschedule-rewrite-{A,B,C,D,G,H}.json`
- `grand-hall-reschedule-pass1-{A,B,C,D,G,H}.json`
- `grand-hall-reschedule-pass2-{A,B,C,D,G,H}.json`

All are under `docs/benchmarks/`. Together they are only 26,929 bytes, but removing 19 duplicate files is a substantial navigation improvement.

Before deleting them, change the retained summary's `bestArtifact`/sample links to identify embedded samples, or clearly retain old paths only as historical provenance. Update `scripts/benchmark-box-rescheduling.mjs` so ordinary reruns use a result directory rather than recreating the retired document files. Its prototype uses per-file inputs as part of a sweep; retained reproduction must still work.

The separate mirror-H and rotate-H files have no incoming repository references. Fold their orientation-control facts into the summary, then remove those two as well. They were not among the 19 proven exact duplicates.

### Raw logs: remove after retaining the result

The six tracked `results/p1.{1,2,3}-{control,treatment}.jsonl` files are historical captures, with no application or test reader. Preserve a compact machine-readable aggregate alongside the benchmark guide: fixture/profile outcome, moves/pushes, meaningful deterministic work, sample timing summary, exact environment override, commit, and methodology. Keep the warning that the recorded tuning fingerprint did not encode the environment override.

After preserving that information, remove the raw captures from the current tree and use Git history if a sample-level reanalysis is needed. Establish one ignored directory for future scratch captures; keep deliberately reviewed regression fixtures tracked.

### Documentation files that are really test fixtures

Do not delete these during a documentation sweep:

| Artifact | Executable consumer |
|---|---|
| `docs/benchmarks/grand-hall-route-diagnosis.json` | `tests/e2e/strategic-analyzer.spec.ts` and several offline diagnostics |
| `docs/benchmarks/quality-memory-384-after.json` | `tests/unit/grand-hall-proof-safety.test.ts` |
| `docs/benchmarks/quality-memory-1536-after.json` | `tests/unit/grand-hall-proof-safety.test.ts` |

Prefer extracting the minimum replayable inputs into `tests/fixtures/solver-v2/`, preserving provenance, and updating readers. Only then can the surrounding bulky historical reports be pruned.

Other benchmark JSON remains evidence until its owning narrative and diagnostic inputs are consolidated. An output filename in a script is not necessarily an input dependency; the inventory distinguishes the directly verified test inputs above.

Two additional historical fixture candidates:

- **`tests/fixtures/solver-v2/baseline-v0.json`:** historical schema 2, with no executable reader found. Retire through Git history if it no longer supports comparisons; remove the policy reference and update the source generator for the project-reference sentence at the same time.
- **`tests/fixtures/generator/v1-generated-benchmark.json`:** read only by old existence/schema/disjoint-ID assertions in `catalog-generation.test.ts`. It does not currently drive a solution-quality comparison. Retire with those specific assertions when shortening rejected generator history. Preserve the current handcrafted and qualification fixtures.

## Confirmed unused symbols

These have no repository consumer after checking aliases, imports/re-exports, text references, workers, scripts, tests, and documentation:

| Symbol | Location | Cleanup |
|---|---|---|
| `PuzzleDifficulty` | [core/model.ts:21](C:/Users/Willp/Code/GitHub/Sokomind/SokomindSolver/src/core/model.ts:21) | Remove unused core alias and core barrel export. Keep the separately defined, actively used catalog alias. |
| `PuzzleId` | [catalog/puzzles.ts:198](C:/Users/Willp/Code/GitHub/Sokomind/SokomindSolver/src/catalog/puzzles.ts:198) | Remove unused alias. |
| `SolverPlaybackRequest` | [useSolverController.ts:159](C:/Users/Willp/Code/GitHub/Sokomind/SokomindSolver/src/features/solver/useSolverController.ts:159) | Remove unused type and imports used only by it. Actual playback has its own live contract. |
| `stateKey` | [search/engine.ts:129](C:/Users/Willp/Code/GitHub/Sokomind/SokomindSolver/src/solver/search/engine.ts:129) | Remove obsolete string-key helper. Actual state identity uses other implementations. |
| `classifyDifficultyFromMetrics` | [difficulty-model.ts:156](C:/Users/Willp/Code/GitHub/Sokomind/SokomindSolver/src/features/generator/v2/difficulty-model.ts:156) | Remove unused wrapper and generator barrel export; keep the active profile/classification implementation. |
| `PDB_MAX_K` | [engine/source/pdb.js:5](C:/Users/Willp/Code/GitHub/Sokomind/SokomindSolver/src/solver/implementations/sokomind-engine/source/pdb.js:5) | Remove unused constant from source and regenerate. |

The initial AST scan also flagged `runWorkerPool`, but a text pass found a real consumer inside a generated child-process script in `tests/unit/forge-pool.test.ts`. It is not completely unreferenced. Likewise, declaration files can hide the actual consumers of generated JavaScript exports from a naive symbol scan. Do not remove `search`, `bidirectionalSide`, or legacy debug namespaces based on that output.

## Source modules used only by tests or a standalone experiment

All seven below are under `src/solver/search/`. None is reached by the application or ordinary scripts through the inspected graph; their specific remaining consumers were checked manually.

| Module | Actual use | Decision |
|---|---|---|
| `bounded-pareto-map.ts` | Dedicated unit tests | Remove duplicate typed implementation after redirecting invariants to the live JavaScript class in engine source. |
| `keeper-arrival-map.ts` | Dedicated unit tests | Same treatment. The identically named class in `engine/source/solver-search.js` remains active. |
| `goal-macros.ts` | Dedicated prototype tests | Retire the disconnected goal-ordering prototype. Keep the exact `inter-rooms` regression that prevents reintroduction of the unsound prune. |
| `safe-staging.ts` | Dedicated unit tests | Unintegrated research. Remove unless it is explicitly needed by the consolidated active solver plan. |
| `analyzer-diagnostics.ts` | Unit tests and `push-block-reorder.ts` | Retire or relocate with the push-block experiment. |
| `push-block-reorder.ts` | Unit tests and `tests/performance/push-block-reorder-benchmark.ts` | A manually runnable experiment, not a shipped optimizer. If retained, place it and its harness under a clearly documented research area. |
| `sealed-corral.ts` | Dedicated tests and PI-corral comparison tests | Move the comparison implementation into test support or redirect tests. Keep the live JavaScript sealed-corral implementation and proof-safety regressions. |

These are different cases: duplicate implementations, disconnected prototypes, a working manual experiment, and test reference code. Removing them all with one blanket rule would either lose useful validation or mislabel research as dead code.

Secondary simplification candidates are the test-only `QueueFrontier` class, obsolete `classifyMove` wrapper, `sessionReducer`, unused full-catalog filtering convenience exports, and unfenced IndexedDB convenience methods. Migrate retained behavioral tests to live APIs before removing those wrappers. Keep oracle helpers such as `compareNumberTuples` and reference heuristic implementations where they support independent solver checks; move them to test support if appropriate.

## Obsolete or redundant tools

- **`scripts/prepare-imported-puzzles.ts`: remove.** It labels itself one-time, reads an external extracted collection, and writes `imported-puzzles.json`, which is absent from and unused by the current catalog.
- **`scripts/validate-catalog.ts`: remove.** It has no package/CI caller, duplicates the maintained catalog checks, and hardcodes an obsolete additional 19 canonical puzzles. Retain `check:catalog` and actual catalog invariants.
- **`scripts/solver-hpc/worker.ts`: remove candidate.** No repository parent constructs it. The active HPC array runner calls `solve-sokomind.ts` using a child process instead. This conclusion covers repository consumers, not an unknown external launcher.
- **`tests/support/sprint2-baseline.ts` and `sprint2-benchmark.ts`: retire.** They are standalone early measurement scripts, not imported test helpers. The maintained V2 benchmark harness owns this work now; retain any useful unique fixture in its corpus.

Keep the actual HPC array runner, aggregation tool, benchmark driver, and SLURM launchers. They are intentional external entry points. Consolidate the two root-level SLURM scripts under the existing HPC scripts directory if reorganizing, updating relative project-root resolution and documentation.

The older Grand Hall probe/report scripts can be retired together with their completed experiment workflow if the generalized route/quality diagnostics cover the retained need. They are not all dead today: some read retained route data and reproduce evidence. The per-file inventory therefore conservatively retains them rather than pretending no package command means no use.

## Keep these systems and generated files

The current application, workers, catalog source, active generator pipeline, exact solvers, replay verification, source generators, and CI are necessary. The generators and some diagnostics use very broad export barrels; that makes file reachability conservative, not a reason to delete entire generator modules.

Keep `engine.generated.js`, its declarations, strategic validation artifacts, and their source modules under the current build contract. `test:unit` checks generated output before running; removing checked-in generated files would require changing the workflow. Keep generated metadata and puzzle shards: Vite glob loading and build preparation make them live even without direct imports.

Keep the lockfile, lint/typecheck/build configuration, public PWA assets, `.nojekyll`, licensing, security, and ownership files. No dependency removal is established by this review.

Local ignored output can be regenerated: `dist/`, `coverage/`, `test-results/`, and any `playwright-report/`. Removing `node_modules/` only forces a reinstall and does not clean the repository. **Do not sweep `review-catalog/` indiscriminately**: it is an ignored review workspace that may contain human acceptance decisions.

## Suggested implementation sequence

1. Consolidate docs and preserve unresolved decisions. Repair the documentation index and all incoming links in the same change.
2. Consolidate artifact summaries, update reproduction output locations and fixture readers, then remove duplicates and retired raw captures.
3. Remove the six unused symbols and obsolete tools in a small code-cleanup change.
4. Handle duplicate/test-only solver modules separately, retargeting tests to production or explicit reference helpers. Keep active proof regressions.
5. Run lint, typecheck, generated-source checks, docs validation, unit tests, build, and static tests. For generated engine or solver changes, also run Huge, multi-puzzle, proof, and relevant browser gates. Evaluate test coverage after redirecting tests; do not lower thresholds to conceal lost validation.

## Method and limits

Used a complete Git-tracked inventory, TypeScript AST import/export and symbol-reference analysis, worker/dynamic-string searches, package/CI entry points, generation scripts, direct fixture readers, and manual inspection of the candidate groups. The 19 duplicate artifacts were compared field-for-field. Byte totals come from current tracked working files.

This is not a claim that every exported helper or every line of legacy JavaScript has been proven necessary. Barrel exports, test-generated programs, external CLI launchers, and dynamically constructed paths need semantic review; highlighted false positives were resolved before recommendations. Unproven cases remain retained or explicitly classified as research/test support.

No cleanup mutations or new test runs were needed for this assessment. The preceding audit established a passing build/test baseline on this same commit; implementation must rerun the relevant gates after actual removals.
