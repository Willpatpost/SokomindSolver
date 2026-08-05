# Sokomind engine provenance

This directory contains the search kernel used by the **Sokomind Solver**
adapter.

The baseline modules were ported from `Sokomind/src`. `heuristic.js` comes
from the newer `Sokomind/src` implementation because it reuses the existing
Hungarian assignment when calculating linear conflicts instead of solving the
same assignment twice.

The following newer changes are intentionally excluded:

- the PI-corral sealed-state prune, because it inferred the keeper region from
  an arbitrary adjacent cell rather than the exact post-push keeper position;
- same-box tunnel collapsing, because it can skip a required stop or an
  interleaving push by another box;
- default congestion scoring, because it changed Grand Hall's deterministic
  route and expanded-state count without a correctness or performance win;
- enlarged per-worker caches and worker caps, because the website enforces one
  aggregate browser memory budget.

The older PI-corral helper is also disabled as a hard prune. The engine retains
the separate sealed-corral check that receives the exact reachable keeper
region.

The vendored `solver-search.js` has one integration-only protocol change:
bidirectional record batches include visited, generated, frontier, retained,
and peak-frontier telemetry. Its structural plan lane also accepts a generated
state cap so the adapter can reserve a run-wide budget for discovery. Search
order and successor generation below that cap are unchanged.

The source files use the legacy classic-script layout: declarations span files
and must share one lexical scope. `scripts/prepare-sokomind-engine.mjs`
concatenates the required live modules into `engine.generated.js`, which Vite
then packages as a same-origin module worker. The generated file is checked in
so type checking and editor navigation do not depend on a sibling repository.
Large-board analysis also produces the legacy prepared-board seed, which is
structured-cloned to search workers and rehydrated with worker-local mutable
caches.
