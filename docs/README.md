# Documentation

Start with the [project reference](PROJECT-REFERENCE.md) for module ownership,
contracts, and source-checked facts. Executable source and tests take precedence
over prose. Git history preserves superseded plans and dated reports.

## Current guides

| Topic | Guide |
|---|---|
| Architecture and module boundaries | [Architecture](architecture.md) |
| Development and verification | [Contributing](../CONTRIBUTING.md), [Testing](testing.md) |
| Deployment and offline delivery | [GitHub Pages](deployment.md) |
| Puzzle rules and catalog format | [Puzzle format](puzzle-format.md) |
| Persistence and portable progress | [Persistence and sharing](persistence-and-sharing.md) |
| Themes, audio, motion, and Zen play | [Experience](experience.md) |
| Solver contracts and adapters | [Solver integration](solver-integration.md) |
| Solver behavior and proof safeguards | [Solver status](solver-status.md) |
| Solver performance and experiment history | [Solver benchmarks](solver-benchmarks.md) |
| Solver Lab UI | [Solver Lab](solver-lab.md) |
| Generator measurements, qualification, and workers | [Generator benchmarks](generator-benchmarks.md) |
| Generator evidence and acceptance rules | [Solution-story contract](generator-solution-story-contract.md) |

## Plans

Only active, unimplemented work belongs here. Completed delivery plans are
removed after current contracts and useful measurements have been consolidated.

- [Maintenance and refactoring](plans/maintenance.md)
- [UI/UX delivery roadmap](plans/ui-ux.md)

## Keeping the documentation useful

Extend the guide that owns a topic before adding another document. Keep plans
under `docs/plans/` only while their work is still relevant. Consolidate useful
measurements into the owning benchmark guide, then rely on Git history for the
superseded source document. Update links and this index in the same change. Run
`npm.cmd run lint:docs` to validate references and generated project facts.
