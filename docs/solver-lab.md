# Solver Lab

Solver Lab is the optional educational workspace at
`#/solver-lab/:puzzleId`. Regular play retains its compact Hint and Solve
experience; the Lab exposes the algorithm choices, telemetry, replay, and
comparison surfaces intended for people studying search.

## Position and experiment contract

The route may include a bounded `play` action log. Sokomind replays that log
through the immutable game core before creating the solver request, so a Lab
experiment always starts from a legal catalog position. “Play this position”
uses the same action log to return to regular play.

Each run records its solver identity, mode, time and memory limits, starting
action log, terminal result, and capture time. The Lab keeps at most six runs
in component memory. Changing the puzzle creates a new workspace; these
temporary research runs are deliberately separate from saved personal-best
routes and summary progress.

## Worker lifecycle and verification

All search runs use the same dedicated module-worker client as the compact
solver dialog. The client assigns a job token to every run, rejects messages
that do not belong to the active job, and terminates or cancels work when the
owner changes or closes. Classic searches also yield between work batches, and
the nested Sokomind engine can be terminated by its outer worker.

Every solved worker result is independently replayed by the client. Before the
Lab displays playback frames, it combines the legal starting action log with
the returned directions and rebuilds the complete trace through the game core.
If either verification fails, the route is not presented as playable.

`Run search` starts computation and `Cancel search` stops it. Pause, step,
seek, and speed controls apply to the verified solution playback, not to the
worker's internal instruction stream. Search progress reports aggregate
counts, so the state-space chart is explicitly a population view rather than a
spatial rendering of every board state.

## Metric definitions

| Metric | Definition |
|---|---|
| Expanded | A state removed from the frontier for successor generation. |
| Generated | Successors produced before duplicate filtering. |
| Visited | The Lab's educational label for expanded states; it is not a second counter. |
| Frontier | The latest reported number of queued states. |
| Peak frontier | The greatest queued-state count reported during the run. |
| Pruned | The sum of reported deadlock-pruned and infeasible-pruned successors. |
| Elapsed | Solver-reported terminal time, or wall time since the active run began while searching. |
| Expansion rate | Expanded states divided by elapsed seconds for the current snapshot. |
| Estimated memory | The solver's estimate for retained search structures, not total browser-process memory. |
| Moves and pushes | Counts obtained from the replay-verified returned route. |
| Lower bound | A proven minimum remaining or solution cost reported by a proof-capable solver. |
| Proof gap | The difference between a known upper bound and lower bound; zero establishes the stated optimum. |

Algorithms differ in guarantees. DFS and Greedy return a first-found route;
A* and IDA* minimize moves when they complete within their limits. Sokomind's
Fast and Quality modes prioritize practical bounded search, while Optimal mode
requests a proof-capable portfolio. The interface states these distinctions
beside the selector rather than implying that every solver uses the same
heuristic or guarantee.

## Accessibility and responsive behavior

All controls remain native buttons, selects, and a labeled range input. Search
status and playback position are announced separately. The count chart retains
text labels and values when animation is disabled, the board receives the
global reduced-motion preference, and the workspace collapses to one column at
narrow widths without requiring horizontal page scrolling.
