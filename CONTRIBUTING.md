# Contributing to Sokomind

Thanks for helping improve Sokomind. Small fixes can go directly to a pull
request; discuss changes that alter puzzle rules, persistent data, solver
contracts, or user-facing behavior in an issue first so their compatibility
requirements are clear.

## Development setup

Use a supported Node.js version from `package.json`, then install the locked
dependencies and start Vite:

```powershell
npm.cmd ci
npm.cmd run dev
```

Keep changes focused, add tests for changed behavior, and avoid committing
generated build output or local benchmark artifacts.

Typechecking rejects unused locals and parameters. Remove unused private
arguments and their call-site values together. Keep an unused public argument
only when its position is needed for compatibility, and prefix its name with
an underscore to make that choice explicit. An exported symbol is not proven
dead just because the compiler accepts it: check app, worker, script, test,
and documented entry points before removing it.

Keep current guidance in `docs/`, proposed work in `docs/plans/`, and historical
evidence in `docs/archive/`. Update the [documentation index](docs/README.md)
when adding or moving a guide. Preserve useful decision history without
presenting old plans as current implementation instructions.

## Validation

Before opening a pull request, run the checks relevant to the change. The full
local baseline is:

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run lint:docs
npm.cmd run test:coverage
npm.cmd run build
npm.cmd run test:static
npm.cmd run test:solver:multi
npm.cmd run test:solver:proof-regressions
```

Run `npm.cmd run test:solver:huge` for changes that can affect the production
solver's discovery or rewrite behavior. Browser or accessibility changes also
require `npm.cmd run test:browser`.

## Repository-specific rules

- Treat `src/core/` as the sole owner of puzzle rules and replay behavior.
- Replay-verify every solver route before exposing or persisting it.
- Preserve collision-free state identity and admissible lower bounds for exact
  proof paths.
- Edit the generated engine under
  `src/solver/implementations/sokomind-engine/source/`, then run
  `npm.cmd run prepare:sokomind-solver`; never edit `engine.generated.js`
  directly.
- Run `npm.cmd run prepare:catalog` after an intentional catalog-source change.
- Run `npm.cmd run prepare:project-reference` after changing a source-derived
  fact shown in `docs/PROJECT-REFERENCE.md`.

The [living project reference](docs/PROJECT-REFERENCE.md) describes ownership,
contracts, and the validation ladder in more detail.

## Pull requests

Explain the user-visible outcome, notable design decisions, and commands used
to verify the change. Call out any check that could not be run. Keep unrelated
formatting or refactoring out of the same pull request so the behavioral diff
remains reviewable.
