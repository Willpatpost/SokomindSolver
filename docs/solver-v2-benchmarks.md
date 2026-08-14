# Solver V2 Benchmarking

Last reconciled: August 14, 2026

The V2 harness measures production solver paths and controlled exact-search
feature variants. Its JSON is evidence, not a substitute for replay and proof.

## Quick start

Run a small production smoke capture:

```text
npm.cmd run benchmark:solver:v2 -- --fixture=ultra-tiny --profile=sokomind-fast --runs=1 --warmup=0
```

Run the full configured matrix with five isolated samples per pair:

```text
npm.cmd run benchmark:solver:v2 -- --runs=5 --warmup=0 --save=tests/fixtures/solver-v2/baseline-v3-YYYYMMDD.json
```

The default matrix is large. It includes every eligible fixture/profile pair
and may take hours on proof-heavy fixtures.

## Production profiles

| Profile | Production path | Deterministic | Eligibility |
|---|---|---:|---|
| `sokomind-fast` | Node Sokomind adapter, fast mode | Yes for benchmark | All fixtures |
| `sokomind-quality` | Node Sokomind adapter, harvest + rewrite | Yes for benchmark | All fixtures |
| `sokomind-optimal-astar` | Node Sokomind adapter + A* proof | Yes | Classic-eligible |
| `sokomind-optimal-ida` | Node Sokomind adapter + IDA* proof | Yes | Classic-eligible |
| `classic-astar` | Exact move A* adapter | Yes | Classic-eligible |
| `classic-ida-star` | Exact move IDA* adapter | Yes | Classic-eligible |

Classic eligibility is at most eight boxes and at most 96 floor cells. The
frozen corpus currently has 43 fixtures, 37 of which are classic-eligible. The
complete matrix contains 234 eligible fixture/profile pairs.

Every request receives the same immutable limits object recorded in its sample.
Classic proof profiles use 60 seconds, 500,000 expanded states, 5,000,000
generated states, and 512 MiB. General Sokomind profiles use 180 seconds,
500,000 expanded states, 5,000,000 generated states, and 768 MiB.

## Methodology

Each timed sample runs in a new child process. This provides clean process
memory boundaries and cold-start measurements. A preflight requested with
`--warmup=N` also runs in a disposable process; the artifact labels it
`untimed-cold-preflight` and does not claim that it warms a later V8 isolate.

For each fixture/profile group the harness retains:

- every raw sample;
- minimum, median, maximum, and median absolute deviation for elapsed time;
- before/after RSS and `process.resourceUsage().maxRSS` peak RSS;
- solver metrics and all counters;
- replay result, proof bounds, and known-optimum comparison;
- exact limits and mode settings;
- solver, corpus, tuning, board, Git commit, and dirty-worktree identity.

Deterministic samples must agree on status, solution/proof outcome, expanded
states, and generated states. A disagreement rejects the group rather than
silently selecting a median record. Milliseconds are descriptive across
machines; they are not a correctness gate.

## Controlled feature A/B runs

Use `--compare-feature` with exact profiles:

```text
npm.cmd run benchmark:solver:v2 -- --fixture=inter-rooms --profile=classic-astar --profile=classic-ida-star --compare-feature=patternDatabase --runs=5 --warmup=0
```

Accepted names are:

- `incrementalAssignment`
- `linearConflict`
- `interactionBoost`
- `patternDatabase`
- `forcedPushMacros`
- `piCorralPruning`
- `patternDeadlockPruning`
- `deadlockTablePruning`
- `goalCommitmentPruning`

The harness creates a matched control and `without:<feature>` variant. Every
other feature, board, solver, limit, and deterministic setting stays identical.
It refuses Sokomind discovery profiles for this mode because those profiles do
not expose the exact-kernel vector directly.

A pair is valid only when both sides replay and prove the expected optimum and
the disabled side reports zero exercise for the selected mechanism. A benefit
classification additionally requires a nonzero control-side exercise counter.
Results are classified as improvement, regression, mixed, no effect,
inconclusive/not exercised, or invalid correctness. Expanded/generated deltas
are deterministic; timing uses the sample median. Median elapsed and peak RSS
receive explicit qualification thresholds. A material regression in either is
a resource veto: it prevents an apparent state-count reduction from being
accepted as an uncomplicated improvement, and conflicting directions are
reported as mixed evidence.

The current `inter-rooms` PDB smoke results were replay-valid and proven on
both sides, with identical work: A* expanded 312 and generated 1,433 states,
while IDA* expanded 2,705 and generated 12,640. Both fixture/algorithm pairs
classify as no effect for PDB; neither justifies an efficiency claim.

## Schema 3

Top-level fields include environment identity, methodology, profile definitions,
corpus/tuning fingerprints, partial/full coverage, promotability, raw result
groups, and optional A/B comparisons.

`promotableBaseline` is true only when:

- the full 43-fixture/default-profile matrix was requested;
- every eligible pair is present exactly once as a sample group;
- all groups are deterministic and accepted;
- at least five timed samples were captured per group;
- Git resolved a full commit identity and the worktree was clean; and
- the run is not a feature-ablation capture.

Partial smoke runs remain useful evidence but cannot be mislabeled as full
baselines.

## Artifact policy

`tests/fixtures/solver-v2/baseline-v0.json` is a historical schema-2 artifact.
It covers only the older subset and older solver versions. Keep it immutable.

Use a new versioned filename for each reviewed capture. Existing files are not
overwritten unless the operator deliberately passes `--force`:

```text
npm.cmd run benchmark:solver:v2 -- --save=tests/fixtures/solver-v2/baseline-v3-20260811.json
```

The SLURM wrapper includes the job ID and UTC timestamp in its output filename.

## Memory smoke test

The separate classic A* memory runner now consumes the flat corpus correctly:

```text
npm.cmd run benchmark:solver:memory -- --fixture=ultra-tiny
```

It is a focused diagnostic, not the schema-3 baseline format. Prefer the V2
harness when comparing production profiles or feature vectors.

## Exit behavior

- Exit 0: every requested deterministic sample group was accepted.
- Exit 1: argument, child protocol, or artifact-write failure.
- Exit 2: the capture completed, but one or more sample groups failed
  correctness or consistency acceptance.

JSON is emitted even for rejected completed captures so the failure remains
inspectable.
