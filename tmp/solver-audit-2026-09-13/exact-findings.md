# Exact solver audit - 2026-09-13

Scope: exact A*/IDA*, forced/tunnel successors, proof envelopes, proof-cache versioning, checkpoint boundaries. Read docs/plans/solver.md and docs/solver-status.md. Production files unchanged. Findings below use live source and executable reproductions.

## P1 - Forced A* children bypass the global frontier and certify a suboptimal route

Location: src/solver/search/exact-move-astar.ts:1077 stores a forced child in forcedNextIndex; :835-855 selects it before the heap and assigns its f-value as the lower bound; :903-908 immediately certifies a goal after assigning U=nodeMoves. The unconditional L>=U exit at :857-860 also assumes the selected node is the global minimum.

Reproduction rows:

```text
OOOOOOO
OO    O
O    RO
O  XSXO
O   OSO
OOOOOOO
```

`node --experimental-strip-types tmp/audit-forced-variants.ts`

Results on base, horizontal mirror, and 180-degree rotation:

| Solver | Moves / pushes | Claimed proof | Verification |
| --- | --- | --- | --- |
| Public classicAStarSolver.solve, defaults | 9 / 2 | optimal, lower=upper=9 | replay valid, isSolverResult true, collectProofIssues empty |
| Exact A*, only forcedPushMacros disabled | 7 / 2 | optimal, lower=upper=7 | replay valid |
| Exact IDA*, defaults | 7 / 2 | optimal, lower=upper=7 | replay valid |
| Independent core stepSnapshot BFS oracle | 7 / 2 | exhaustive | 109 explored states base; 108 mirror/rotation |

The bad A* result returns with six frontier nodes still retained. The seven-move base route is D(push), U, L, L, L, D, R(push). The bad route solves the left box first and uses nine moves.

Impact: a legal route and a structurally consistent envelope can establish a false UI/persisted optimum. Independent replay proves legality only, so the validation boundary correctly accepts the envelope shape and cannot detect this algorithmic defect. A* proof use by Sokomind is direct at src/solver/implementations/sokomind-proof.ts:204.

Recommendation: retain the forced-successor generation shortcut but enqueue the resulting node through the same global priority queue, or prove a correct alternative that accounts for the heap minimum in every goal, lower-bound and upper-ceiling exit. Share all successor retention/budget checks. Add this fixture and symmetry variants to independent oracle tests, including a suboptimal incumbent and cutoff during a forced branch. Existing forced-push tests at tests/unit/exact-move-astar.test.ts:619 onward do not create this competing-frontier case.

Proof invalidation: bump CURRENT_OPTIMAL_PROOF_REVISION at src/shared/optimal-cache.ts:15. Existing cache records contain only moves/pushes and cannot selectively preserve IDA certificates, so invalidate the existing global revision. A new STORAGE_KEYS.optimal key (src/shared/storage.ts:12) also isolates corrected caches from older live tabs. Bump classic A* version (src/solver/implementations/classic-solvers.ts:72) and Sokomind version (:352 in sokomind-solver.ts). An A*-only ordering fix does not intrinsically invalidate independently exhausted IDA contours; IDA version/schema 3 need not change for this defect alone.

Raw evidence: tmp/solver-audit-2026-09-13/exact-forced-variants.jsonl. A second focused run supplies replay-valid incumbents: an 11-move incumbent still returns the false proven 9-move result; a 9-move incumbent happens to return the correct 7 because the equal-cost forced goal is pruned. Command: node --experimental-strip-types tmp/audit-forced-incumbent.ts; raw: tmp/solver-audit-2026-09-13/exact-forced-incumbent.jsonl.

## P2 - Forced A* successor path bypasses estimated-memory enforcement

Location: src/solver/search/exact-move-astar.ts:1058-1077 allocates and retains a forced child without the projected-memory checks used by ordinary/tunnel successors. The outer loop checks elapsed limits, but memoryLimitReached is called only during preparation (:675). Initial arena allocation at :729 also occurs after that preparation check.

`node --experimental-strip-types tmp/audit-forced-memory.ts`

Rows: ['OOOOOOOOOO', 'ORX    S O', 'OOOOOOOOOO']; maxMemoryBytes=20000.

- Default A*: status solved, 5 moves, 5 forced-push applications, estimatedMemoryBytes=171248 (8.56 times the configured estimate budget).
- Disable only forcedPushMacros: status unsolved, reason limit-reached, detail Estimated solver memory limit reached. Its reported estimate is already 170032, showing the initial arena chunk also escaped the pre-allocation check.

Recommendation: account for actual next arena capacity before root/child allocation, enforce the check in one shared retention helper across ordinary, forced and tunnel successors, and preserve an already verified incumbent with bounded metadata on cutoff. This is an estimated-memory contract violation, not a claim about measured process RSS.

Raw evidence: tmp/solver-audit-2026-09-13/exact-forced-memory.jsonl.

## Additional bounded review observations

- PI-corral hard pruning remains disabled even under explicit overrides (exact-search-features.ts). Goal commitments only freeze statically immovable goal boxes. Tunnel lookahead retains the ordinary successor. These existing proof safeguards should remain.
- IDA contour dominance remains local to a contour. No current IDA wrong-optimum result was found in this review; three independent-oracle variants above returned the correct optimum.
- The checkpoint compatibility helper validates solver and codec versions, but no production caller uses validateCheckpointCompatibility; runIdaStarSearch only directly validates schema, board identity, objective and incumbent replay. Consider enforcing the full compatibility contract at its direct resume boundary before future persistent-resume promotion. This is a code-review hardening observation, not a demonstrated production false proof in this audit.
- Linear-conflict tests named admissibility currently assert nonnegative/even/finite values rather than comparing the combined heuristic to an independent oracle (tests/unit/linear-conflict.test.ts:140-162). Expand true oracle coverage before promoting heuristic changes. No linear-conflict counterexample is claimed here.
- docs/solver-status.md says every exact feature defaults on while its following text and source correctly keep PI-corral pruning off; align the overview.

## Evidence limits

The audit proves the forced A* counterexample and memory-contract violation above. It does not establish that all exact heuristics/deadlocks are sound on all boards, and no full browser matrix or heavy benchmark was run by this sub-audit. Timing values in scratch output are incidental and must not be used for performance conclusions.

