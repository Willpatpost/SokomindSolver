# Documentation

Start with the [project reference](PROJECT-REFERENCE.md) for module ownership,
contracts, and source-checked facts. Executable source and tests take precedence
over prose. Plans describe proposed work; archived documents preserve history.

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
| Solver behavior and proof safeguards | [Solver status](solver-v2-progress.md) |
| Solver performance measurement | [Benchmarking](solver-v2-benchmarks.md) |
| Solver Lab UI | [Solver Lab](solver-lab.md) |
| Generator implementation and release work | [All-tier progress](generator-all-tier-progress.md) |
| Generator measurement and workers | [Generator performance](generator-performance.md) |
| Generator evidence and acceptance rules | [Solution-story contract](generator-solution-story-contract.md) |
| Generator sample verification and limitations | [Quality verification](generator-phase-8-verification.md) |

## Plans

These documents can contain incomplete work and dated measurements. Check the
current guides and executable gates before implementing a proposal.

- [Maintenance and refactoring](plans/maintenance.md)
- [UI/UX delivery roadmap](plans/ui-ux.md)
- [Solver discovery proposals](plans/solver-discovery.md)
- [Generator roadmap](plans/generator.md)
- [Generator quality pipeline](plans/generator-quality.md)
- [Generator implementation checklist](plans/generator-checklist.md)

## Historical references

Archived material is retained for its decisions, rejected approaches, or
measurements. It is not the source of current setup or implementation guidance.

- [Original Solver V2 specification](archive/solver-v2-spec.md)
- [Pre-reset generator baseline](archive/generator-phase-0-baseline.md)
- [August 11 audit](archive/AUG11AUDIT.MD)
- [August 11 improvement roadmap](archive/AUG11IMPROVEMENTS.MD)
- [Earlier solver improvement roadmap](archive/SokomindSolver_Improvement_Roadmap.md)
- [Earlier generator roadmap](archive/Sokomind_Puzzle_Generation_V2_Roadmap.md)
- [Earlier generator implementation plan](archive/PUZZLE_GENERATOR_V2_IMPLEMENTATION_PLAN.md)
- [Generator quality handoff](archive/SOKOMIND_GENERATOR_V2_QUALITY_PASS_IMPLEMENTATION_HANDOFF.md)
- [Historical project notes](archive/sokomind-project-memory.md)

## Keeping the documentation useful

Extend the guide that owns a topic before adding another document. Keep plans
under `docs/plans/` while their work is still relevant; move superseded plans
and dated evidence under `docs/archive/`. Update links and this index in the
same change. Run `npm.cmd run lint:docs` to validate references and generated
project facts. Keep source-derived values in the project reference rather than
copying them into new summaries.
