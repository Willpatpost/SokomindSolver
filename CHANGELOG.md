# Changelog

Notable project changes are recorded here. This project follows the structure
of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and has not yet
published a stable release.

## [Unreleased]

### Added

- MIT licensing plus contributor, security-reporting, and code-ownership
  guidance.
- Source-derived documentation for the exact PDB allocation ceiling and the
  reviewed Grand Hall discovery and rewrite counters.

### Changed

- Current catalog and solver documentation now links to one generated project
  reference instead of duplicating facts that can drift.
- Exact-search tunnel macros are now disabled by default. When enabled they
  only add look-ahead successors and no longer remove the single push.
- Solver versions are now `classic-astar` 2.2.2, `classic-ida-star` 2.2.1 and
  `sokomind-solver` 1.3.0. Sokomind 1.3.0 also marks the earlier Quality
  changes: Quality never dispatches proof and reports unknown optimality,
  requests accept a replay-validated initial solution, and Quality repair runs
  on a parallel task-slot coordinator.
- The optimal-record proof revision is now `exact-moves-tunnel-sound-v1` and
  the storage key is `sokomind.optimal.v7`, so certificates stored under
  earlier revisions are discarded in both storage tiers and older open tabs
  cannot overwrite current ones.
- The IDA* checkpoint schema is now 4, so checkpoints written by the earlier
  kernels restart instead of resuming.

### Fixed

- Exact pattern-database combination counts no longer wrap at 32 bits on large
  valid custom boards, and oversized optional tables safely fall back to the
  remaining admissible heuristics.
- Exact A* and IDA* no longer drop the single push into a tunnel when a tunnel
  macro applies. That prune discarded routes that park a box part-way into a
  tunnel, so both exact kernels and the adapters built on them could report
  non-optimal move counts as proven optima and prove solvable boards
  unsolvable.
- IDA* tunnel-macro children are keyed by the keeper's actual cell instead of
  the box's origin cell, so heuristic-cache and contour transposition entries
  no longer alias a different state.
