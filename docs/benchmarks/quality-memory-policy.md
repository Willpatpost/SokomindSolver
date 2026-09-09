# Quality rescheduling: work budgets and live memory

The September 2026 resource-policy proposal remains applicable: `improveIncumbent`
used an extra 20,000-state cap through 384 MiB and 35,000 through 768 MiB,
irrespective of the work allocation already available to whole-box repair.

The retained change removes that extra cap **only for quality-mode whole-box
rescheduling**. The configured/default improvement work budget, its division
between phases, and the remaining global expanded/generated/time limits still
apply. The memory-scaled default improvement work allowance remains unchanged;
this change does not make the state budget unlimited. Local windows keep their
existing conservative policy. Fast mode and optimal-mode allocations are unchanged.

## Safety inspection

`runPhase` supplies the worker's memory share after coordinator/prepared-board
reserves and division by concurrent workers. `fixedOrderBoxReschedule` reserves
tables, scratch/replay storage, and a conservative per-generated-node allowance
for the current attempt, then checks the estimate before retaining successors.
Temporary table dimensions are independently bounded. Its counters accumulate
expanded/generated work across attempts while retained-memory accounting resets
for each attempt. The coordinator also checks live worker memory, global work,
and deadlines before accepting a result. Published improvements still require
independent core replay and must arrive before the shared cutoff.

These are estimated-memory safeguards, not a hard RSS or JavaScript-heap bound.
The pre-existing sampling cadence, allocation estimates, and cutoff semantics
are unchanged. No safety claim depends on filling the user's memory allowance.

Regression controls exercise work allocation at all three requested memory
classes, unchanged optimal-mode allocation, a real engine memory cutoff with
generous work limits, and retention of a replayed publication when coordinator
memory accounting stops the worker. Existing time/state/generated/cancellation
and invalid-publication tests remain in place.

## Public Grand Hall results

These measurements run the real public Node adapter with fresh engine workers,
not isolated rescheduling or a reference-fed search. Settings are quality mode,
deterministic discovery, one incumbent, no harvesting, hardware concurrency two,
45 seconds, 200,000 expanded states, and 2,000,000 generated states. Only the
requested memory limit differs. Each returned solution independently replays.
The diagnostic JSON records limits, options, phase payloads/results/publications,
engine/adapter SHA-256 fingerprints, full returned route, and metrics.

| Memory allowance | Policy | Moves / pushes | Expanded | Peak estimated bytes | Elapsed seconds | Stop sequence |
| --- | --- | --- | --- | --- | --- | --- |
| 384 MiB | Before | 713 / 248 | 37,334 | 73,254,518 | 35.120 | Repair state cap; proof completion label* |
| 384 MiB | Hybrid | 673 / 242 | 78,134 | 73,254,518 | 34.571 | Repair work allocation; proof completion label* |
| 768 MiB | Before | 693 / 248 | 61,334 | 87,078,518 | 36.303 | Repair state cap; proof completion label* |
| 768 MiB | Hybrid | 573 / 248 | 154,934 | 87,078,518 | 36.453 | Repair work allocation; proof completion label* |
| 1536 MiB | Before | 520 / 242 | 200,000 | 123,457,142 | 14.905 | Global expanded-state limit |
| 1536 MiB | Hybrid | 520 / 242 | 200,000 | 123,457,142 | 14.832 | Global expanded-state limit |

Overall peaks are 69.86, 83.04, and 117.74 MiB. No measured run reaches its
memory, generated-state, or global elapsed limit. Stop sequences are derived
from the recorded phase budgets/counters and returned proof metadata; the public
solved result does not expose a single stop-reason field. Elapsed time is one
sample per configuration, including the public proof handoff. It is descriptive,
not evidence of a speedup. Some validation work overlapped the after measurements.

At 384 MiB repair expands 60,800 states instead of 20,000; at 768 MiB it expands
128,600 instead of 35,000. Its own peak estimate rises from 37,168,933 to
38,816,293 bytes and from 38,084,773 to 41,556,015 bytes respectively. The overall
peak is dominated by another phase. More cumulative work need not mean more
simultaneously retained memory. At 1536 MiB the work allocation and all public
deterministic totals are unchanged (including 746,911 generated states).

This is a useful quality improvement, but it does not substantially increase
overall peak memory utilization. It removes an artificial work restriction;
it does not deliberately retain unnecessary states to fill memory. The remaining
work-allocation policy would require a separate measured experiment to change.

Evidence: [384 before](quality-memory-384-before.json),
[384 hybrid](quality-memory-384-after.json),
[768 before](quality-memory-768-before.json),
[768 hybrid](quality-memory-768-after.json),
[1536 before](quality-memory-1536-before.json),
[1536 hybrid](quality-memory-1536-after.json).

Reproduce the hybrid results from the repository root:

```powershell
foreach ($mib in 384,768,1536) {
  npm.cmd run diagnose:quality-budget -- --memory-mib=$mib --output=docs/benchmarks/quality-memory-$mib-after.json
}
```

The before files were captured before the resource-policy edit. Running current
code reproduces the hybrid policy, not the before policy. No route, fixture ID,
box label, or benchmark measurement enters production ordering.

## Pre-existing proof-label inconsistency

*At 384 and 768 MiB, both before and hybrid runs return an `optimal` proof and
`proven` solution label after only one proof expansion. Those claims conflict
with shorter independently replayed Grand Hall routes, including the 520/242
public result above. They must not be interpreted as valid optimality evidence.
The route replay checks establish legality and completion only. The raw results
preserve the inconsistent labels for investigation; they are not rewritten by
the diagnostic. This resource-policy change does not modify exact search,
proof handoff, or proof-result acceptance. Investigating this inconsistency is a
separate correctness priority, even if existing frozen-optimum regressions pass.

## Validation

Passed all 2,385 unit tests and all three coverage gates; typecheck, lint,
generated-engine/catalog consistency, documentation validation, build and nine
static checks; 33 frozen-optimum cases and parallel proof; four multi-puzzle
guardrails; Huge in base/mirrored/rotated orientations; and nine focused browser
worker tests across Chromium, Firefox, and WebKit. The complete application
browser suite was not rerun. Frozen-optimum success does not resolve the
Grand Hall proof-label inconsistency described above.
