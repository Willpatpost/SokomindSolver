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

### Fixed

- Exact pattern-database combination counts no longer wrap at 32 bits on large
  valid custom boards, and oversized optional tables safely fall back to the
  remaining admissible heuristics.
