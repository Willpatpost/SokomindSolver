# Structural first-push branch allowance experiment

The recoverability trace identified first-push selection as the first loss of
the reviewed 503/236 Grand Hall route. This experiment widens the existing
distinct-box selection policy through `planBoxBranches`, without introducing
reference-dependent selection or changing production defaults.

Reproduce from the repository root:

```powershell
npm.cmd run benchmark:planner-branches -- docs/benchmarks/planner-branch-sweep.json
npm.cmd run diagnose:planner-route -- --fixture=huge --branches=16 --route-file=docs/benchmarks/grand-hall-route-diagnosis.json --route-name=rewrite --reschedule=true --output=docs/benchmarks/grand-hall-planner-branches-16.json
```

The sweep uses five fixtures and allowances 6, 8, 10, 12, and 16. Each run
receives a fresh VM and the same structural planner budgets. The allowance
controls distinct-box selection and also increases total selected directions;
this is a breadth ablation, not a fixed-width diversity policy. Macro generation
and downstream beam selection remain unchanged. Every returned route is replayed
through the core verifier. These are isolated structural-lane results, not public
adapter quality results or optimality proofs.

The first four fixtures retain their original route lengths at every tested
allowance: beginner-three 7 moves, classic-1 45, adv-gallery 31, and expert-maze
231. Expert-maze generates 1,619 states at six branches, 1,739 at eight, and
1,749 at ten or more. The other three fixtures have unchanged deterministic work.

Grand Hall results:

| Branch allowance | Moves / pushes | Expanded | Generated |
| --- | --- | --- | --- |
| 6 (default) | 893 / 278 | 1,329 | 8,425 |
| 8 | 1,116 / 292 | 2,072 | 19,352 |
| 10 | No solution found | 5,021 | 55,100 |
| 12 | No solution found | 5,002 | 57,534 |
| 16 | No solution found | 5,014 | 60,000 |

Allowances ten and twelve end with `plan-frontier-exhausted`; sixteen reaches
the generated-state budget. Estimated engine peak memory rises from 22,795,259
bytes at the default to 25,245,947 at eight and roughly 40 million at ten or more.
See [the complete sweep](planner-branch-sweep.json).

The [sixteen-branch trace](grand-hall-planner-branches-16.json) still excludes
the reference's opening direction, `G:7,2:Right`, ranked 21 of 27. Its 18 selected
directions include `G:7,2:Down`. Merely representing the physical box therefore
does not preserve the reference's first action. These coordinates describe the
diagnostic result only; no production policy reads them.

Observed and unobserved searches have identical paths (both absent), expanded,
generated, retained, and peak-frontier counts. The observer reaches its 200,000
event cap and reports `trace-limit`. The root selection was recorded before
truncation; the report must not be used to infer complete later-search
recoverability or absence. No timeout occurred in the completed sweep or trace.

Widening is not accepted as a production default. A bounded beam is not
monotonic in this allowance: new macro candidates can displace previously useful
states. This experiment does not rule out a fixed-width diversity rule or a
different box-agenda representation.

The JSON records full payloads, replayable action logs, expanded/generated and
retained counts, frontier peaks, engine memory estimates, and timing. Timing is
one descriptive sample per setting, with other validation work running during
some samples; it cannot establish a speedup. Browser heap samples are unavailable
in this Node VM, and engine estimates are not measured process memory.

The diagnostic accepts `--branches=2` through `--branches=16`; omission uses the
current tuning default. With `--route-file`, an unsolved control can still be
traced and compared against the observed search's deterministic outcome. Without
an external reference, the control must solve to supply the positive-control
route. Invalid returned routes and mismatched observed/control results fail the
diagnostic.

Validation for this follow-up: all 2,377 unit tests, typecheck, lint, documentation
checks, and whitespace checks passed. No production search or worker code was
changed by this experiment; browser and performance guardrails from the preceding
trace implementation were not rerun here.
