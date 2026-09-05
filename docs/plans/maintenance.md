# Maintenance and refactoring

This plan tracks behavior-preserving cleanup separately from product changes.
The current ownership map is in the [project reference](../PROJECT-REFERENCE.md)
and the [architecture guide](../architecture.md). Keep public APIs, persisted
schemas, puzzle identities, worker protocols, and exact solver behavior stable
unless a separate change explicitly calls for them to change.

## Completed foundation

- Organized documentation into current guides, plans, and historical material,
  with one [documentation index](../README.md).
- Split solver validation into internal modules for common checks,
  board/snapshot consistency, request options, solutions/metrics, and metadata.
  Existing consumers still use `src/solver/validation.ts`.
- Removed confirmed unused private parameters and their arguments. Retained
  unused public argument positions explicitly for compatibility.
- Removed four unused re-export files in editor, generator, solver UI, and
  proof heuristics after checking imports, worker URLs, scripts, tests,
  dynamic loading, and documentation. The underlying implementations remain.
- Enabled TypeScript unused-local and unused-parameter checks in the normal
  typecheck/build path.
- Separated the Sokomind adapter's legacy data conversion and worker-plan
  construction into `src/solver/implementations/sokomind-legacy.ts` and
  `src/solver/implementations/sokomind-plans.ts`. The adapter retains worker
  lifecycle, telemetry, and search-phase coordination; existing public imports
  continue to work. Declaration bodies and budget constants are preserved.

## Next boundaries to review

Work on one responsibility at a time. File length identifies review candidates;
it is not by itself a reason to create more modules.

| Area | Candidate boundary | Evidence required before changing it |
|---|---|---|
| `src/solver/implementations/sokomind-solver.ts` | Telemetry aggregation and worker-phase lifecycle, after the completed legacy-data and plan extraction | Existing adapter/protocol tests, canonical replay, exact counters, and performance gates |
| `src/features/generator/v2/puzzle-forge.ts` | Candidate production, finalist evaluation, and evidence/release decisions | Fixed-seed rows, witnesses, quality decisions, and worker lifecycle tests |
| `src/features/editor-page/EditorPage.tsx` | Draft/import/share orchestration and editor panels | Draft recovery, sharing, keyboard, mobile, and accessibility tests |
| `src/features/play/PlayPage.tsx` | Route loading/recovery and play presentation | Navigation, restoration, playback, and mobile tests |
| `src/shared/idb-storage.ts` | Common transaction lifecycle versus reset-fenced operations | Abort/error reporting, cross-tab writes, and reset race tests |
| `src/solver/search/` | Shared search mechanics only where invariants are actually identical | Oracle/proof tests and deterministic resource counters |

## Removing dead code

Unused locals and private parameters are covered by the compiler. Exported
symbols and files need a separate reference review across the app, tests,
Node scripts, worker URLs, dynamic imports, generated-engine preparation, and
documented extension points. Test-only usage is a reason to inspect a module,
not proof that it can be deleted. Remove an obsolete path together with its
exports, tests that only exercise that path, documentation, and script entries.
Do not replace a real behavioral regression test with a test of file layout.

## Validation and resolved audit findings

Use the [contribution checks](../../CONTRIBUTING.md#validation) for each change.
Keep refactors reviewable: move behavior first, verify it, then simplify it in
a separate step. Search and generator refactors also need their deterministic
and performance gates; unit-test success alone is insufficient evidence.

The September 4 audit findings about progress-import capacity and paused-game
keyboard actions have been addressed:

- Progress import accounts for the retained activity ledger, daily records,
  and completion records. The maximum-retention round-trip regression is in
  `tests/unit/progress-import.test.ts`.
- Paused play disables gameplay shortcuts through `gameplayEnabled`, while
  keeping pause/resume and shortcut help available. The keyboard and swipe
  regression is in `tests/e2e/zen-play.spec.ts`.

Static artifact verification now runs for pull requests as well as
default-branch pushes and manual runs, so delivery budgets, CSP, and asset
manifest checks execute before merge.
