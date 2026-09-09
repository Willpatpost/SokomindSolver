# Structural planner route recoverability

## Grand Hall finding — September 9, 2026

The reviewed **503-move / 236-push** route loses its opening push during the
structural planner's first-push selection. The push is generated, but ranks
**21st of 27**. Eight first pushes are selected and none moves that physical box.
This is observed before macro generation, transposition checks, or beam selection
can consider that opening.

The canonical orientation for this run is identity. The opening is
`G:7,2:Right` (label, zero-based row/column, direction), with a ranking score of
65.35. These coordinates describe the diagnostic result; no production policy
uses this label, position, puzzle ID, or route.

The selected alternatives were:

```text
H:7,10:Down   C:2,2:Down   D:2,12:Down   X:3,1:Up
X:3,13:Up    X:12,6:Right X:12,8:Left   H:7,10:Up
```

The control and observed searches both returned the same **893-move / 278-push**
solution, with exactly **1,329 visited, 8,425 generated, 2,538 retained**, and
**291 peak frontier**. The observer did not change the route or those counters.
As a positive control, tracing the planner's own solution reached all 278 pushes
and identified the solved candidate. Both traces processed 33,286 events without
reaching the diagnostic event limit.

- [Improved-route trace and provenance](grand-hall-planner-recoverability.json)
- [Planner-route positive control](grand-hall-planner-positive-control.json)

This identifies the earliest observed loss of this particular reference opening.
It does not establish that every 503-class solution uses that opening, that the
reference is optimal, or that selecting it would suffice to find a better route.
The next useful experiment is a general first-push/box-agenda diversity policy
with an enabled/disabled control and representative corpus measurements.

## Reproduce

The diagnostic uses the same typed structural plan and default tuning as the
fast lane. It runs synchronously in a Node VM with a 120-second hard limit per
search. It does not benchmark public-adapter scheduling or browser latency.

```sh
npm run prepare:sokomind-solver
npm run diagnose:planner-route -- --fixture=huge --route-file=docs/benchmarks/grand-hall-route-diagnosis.json --route-name=rewrite --reschedule=true --output=planner-trace.json
npm run diagnose:planner-route -- --fixture=huge --output=planner-control.json
```

With a route file, plain text must contain a U/D/L/R action log; JSON must contain
a `routes` array and a matching `--route-name`. The optional rescheduling step
uses 300,000 expanded states, 2,000,000 generated states, and 25,000 ms. In this
measurement it transforms the saved 789-move rewrite into 503/236. The resulting
reference is independently replayed. Without a route file, the unobserved planner
result becomes the reference, providing a positive control for catalog fixtures
that the bounded structural lane solves.

The reference never enters either search payload. The offline harness loads the
generated engine into a private VM and temporarily attaches a read-only observer
to the internal planner. Neither the generated module exports nor the browser
worker/request options expose this observer. It returns no ranking or pruning
decisions, and normal solving does not allocate event objects.

The harness records source commit, source/harness hashes, exact payload, reference
provenance, and both results. It requires equal paths and deterministic work counts
between the control and observed runs, and independently replays both solutions.
Wall-clock timing under observation is not a performance claim.

## What the trace means

Matching uses physical-box order, labels, exact keeper position, and equal push
depth. Repeated-label boxes are not silently interchanged. Walking paths may
differ between pushes. A macro can skip intermediate retained endpoints, but its
entire push sequence must replay through the canonical core and match the
reference's intervening push states to count as a compatible extension.

The observer reports generated/ranked/selected first pushes, returned macro
endpoints, selected macro successors, explicit outer pruning reasons, candidate
sets, beam preselection, region eligibility, keeper-arrival limits, and retained
or solved states. The report retains bounded summaries rather than search objects.
`furthestRetainedPush` includes the root and a matching solved candidate.

Limitations are explicit:

- This is state recoverability at equal push depth, not proof that every earlier
  push in a retained state's ancestry followed the reference. Alternative paths
  can rejoin a reference state.
- Macro **internal** expansion, deduplication, and endpoint rejection are not
  individually instrumented. A missing returned endpoint is classified as
  `macro-generation-or-endpoint-selection`, not blamed on a particular guard.
- A first push absent from `pushNeighbors` may have been rejected by its internal
  deadlock checks. The trace does not equate that with an illegal core move.
- Explicit rejections are recorded alongside candidate/beam stages; a truncated
  search can stop before a stage is observed. Missing bookkeeping is not proof
  of unsolvability or unsafe pruning.
- At 200,000 observed events, classification becomes `trace-limit`. Reference
  action logs are capped at 100,000 moves. VM timeouts fail the diagnostic rather
  than reporting a misleading completed trace.

Unit controls cover canonical orientation, repeated-box identity, macro prefix
matching, selection/filter/pruning/beam classifications, malformed references,
event limits, and restoration of the VM wrapper after an observer error.

Validation passed 2,377 unit tests and all three coverage gates; typecheck, lint,
generated-engine/documentation checks, build/static checks; Huge/multi-puzzle
guardrails; 33 frozen-optimum cases and parallel proof; and the nine focused
strategic worker cases across Chromium, Firefox, and WebKit. The complete
application browser suite was not rerun for this diagnostic-only change.
