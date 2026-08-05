# Solver integration

The solver package contains five production adapters plus the infrastructure
needed to add more. An algorithm becomes available by implementing
`SolverAdapter` and registering it at the worker composition root.

## Built-in searches

| Adapter | Frontier | Objectives | Guarantee |
| --- | --- | --- | --- |
| `sokomind-solver` | structural/guided portfolio + local rewrite | moves | best replay-verified route within the run budget |
| `classic-dfs` | LIFO stack | moves | deterministic first route |
| `classic-greedy` | stable heuristic heap | moves | deterministic first route |
| `classic-astar` | stable `g + h` heap | moves | minimum moves |
| `classic-ida-star` | iterative deepening `f` contours | moves | minimum moves |

All four classic adapters use the same push-macro graph. A successor consists of
an exact shortest keeper walk followed by one legal push. Search nodes retain the
true post-push keeper cell and a canonical signature that treats boxes with the
same label as interchangeable. Because total movement is the sole objective,
A* and IDA* include the exact keeper cell in state identity and every macro edge
includes its shortest walking distance. DFS and Greedy may collapse equivalent
keeper cells within one reachable region because they promise only a
deterministic first route, not minimum movement.

The A* lower bound is a label-aware minimum-cost assignment. For every matching
box/goal pair, the cost is a reverse-push distance that respects walls and
required support cells while removing all other boxes. The relaxed puzzle
cannot cost more than the real one, so the assignment is admissible:

The move lower bound is `h = P`, because every remaining push is also a move.

Only proven static dead cells and fully blocked 2x2 formations are hard-pruned.
Every candidate route is reconstructed from parent links and independently
replayed through the core before it is returned.

## Sokomind Solver

`sokomind-solver` is the default interactive adapter. It ports the live search
kernel from the earlier Sokomind sites into the typed adapter contract without
bringing their UI or global director into the React application.

The kernel baseline comes from Sokomind. It uses the newer Sokomind assignment
heuristic, which reuses an existing Hungarian matching when calculating linear
conflicts. The newer guessed-region PI-corral prune, same-box tunnel forcing,
default congestion score, and enlarged per-worker memory limits are deliberately
excluded. The older guessed-region PI helper is also disabled as a hard prune;
the exact reachable-region sealed-corral proof remains active.

Large boards first compile a structured-clone-safe prepared board, then give
the reviewed structural plan-macro beam a head start capped at 25 seconds and
70% of any finite remaining time. Explicit expanded- and generated-state limits
similarly reserve at least one state and normally 40% for discovery. If the
structural lane misses or exhausts its share, the remaining budget goes to a
guided push lane with compact forward and reverse frontiers when the browser
has enough CPU and memory. This keeps Grand Hall's low-memory fast path while
ensuring short runs still reach discovery. Smaller boards start directly with
the discovery portfolio. For rooms with at least eight boxes, a web-safe
memory declaration selects a 256-wide direct beam; the explicit 1.5 GiB class
selects 512. On The Exchange, width 256 cut generated successors from roughly
1.2 million to 449,000 and solved in 39 seconds, although compacting transient
successors remains necessary to bring peak process RSS down further.

Bidirectional meeting keys use compact typed box tokens; the adapter decodes
those tokens before finding the robot-only bridge, fixing the obsolete key
parser in the legacy UI director. Record batches now carry exact visited,
generated, frontier, and retained counts. If nested workers are unavailable,
the adapter falls back to the existing cooperative Greedy engine.

The legacy kernel runs in a same-origin nested module worker. The outer solver
worker therefore remains available to terminate the kernel on cancellation,
elapsed-time, state, or estimated-memory limits. Concurrent worker estimates
and retained bidirectional records are added against one run-wide ceiling.
The cutoff uses current retained/frontier/cache/arena/record memory rather
than cumulative generated work or a historical heap peak. Peak values remain
available as diagnostics. Chromium's non-standard process-wide heap sample is
not multiplied across workers. Unlimited runs also have a two-minute
worker-silence watchdog; active progress resets it.

Once discovery finds a verified route of at least 100 moves, one bounded
`solution-window-rewrite` worker canonicalizes walking, reorders compatible
push chains, and searches local bridge windows for fewer total moves. The
50,000-state budget explicitly reserves 25,000 states for move-cost windows;
the previous implementation allowed push-window work to consume that entire
budget first. Runs of at least 90 seconds may perform a second pass. Every
candidate is replayed again, and a timeout or optional-worker failure returns
the already verified incumbent. Results report `optimality: "unknown"` because
this is bounded anytime improvement, not a proof.

The reviewed Grand Hall guardrail uses the same structural and rewrite
settings as the production adapter. Base, mirrored, and rotated discovery
cases replay with identical `1,010 moves / 316 pushes`, `1,843 visited`, and
`13,844 generated` results. The base rewrite is locked at `874 moves /
304 pushes` with 50,000 visited states. A separate production Chrome test
covers the nested-worker and UI path. Run the guardrail explicitly with:

```powershell
npm.cmd run test:solver:huge
```

For corpus measurements, run:

```powershell
npm.cmd run benchmark:solver
npm.cmd run benchmark:solver -- --puzzle=huge --rewrite-passes=2
$env:SOKOMIND_TUNING_JSON='{"topologyWeight":0.8}'
npm.cmd run benchmark:solver -- --puzzle=master-exchange
```

The default corpus contains Grand Hall, both typed master originals, Microban
145/146, and Caleb 022. Multi-puzzle runs launch one child process per case,
emit JSON Lines, and enforce a per-case timeout so heap/RSS figures are not
contaminated by prior puzzles. `SokomindTuningProfile` schema v1 exposes only
soft ordering weights. It cannot change legality, hard pruning, replay
verification, or resource limits, which keeps future AlphaEvolve experiments
behind a stable correctness boundary.

## Contract

A solver receives:

- immutable `ParsedBoard` geometry;
- an exact `GameSnapshot`, which permits solving from the initial or current
  game state;
- the fixed `{ kind: "moves" }` solver objective marker;
- optional resource limits and JSON-safe adapter options;
- an execution context containing an `AbortSignal`, progress callback, and
  monotonic clock.

It returns a `SolverResult`: solved, unsolved, or cancelled. Unexpected defects
are thrown and serialized as `solver/failure` events at a worker boundary.

Register adapters once:

```ts
import { SolverRegistry } from "@/src/solver";
import { mySolver } from "./implementations/my-solver";

export const solverRegistry = new SolverRegistry([mySolver]);
```

Registry IDs are lowercase, URL-safe, stable identifiers. Registration fails
on duplicates; a later implementation never silently replaces an earlier one.

## Worker protocol

The host sends:

- `solver/discover` to request capability metadata;
- `solver/run` with `jobId`, `solverId`, and `SolverRequest`;
- `solver/cancel` with the same `jobId`.

The worker emits:

- `solver/ready` with registered metadata;
- `solver/progress`;
- `solver/result`;
- `solver/failure` for transport, configuration, or implementation errors.

Use `isSolverWorkerCommand()` and `isSolverWorkerEvent()` before dispatch.
Those guards recursively validate the envelope and nested request, geometry,
snapshot, metadata, progress, and result data. The assertion variants expose
structured validation failures. Reject protocol-version mismatches rather than
guessing compatibility.

Maintain one run-scoped cancellation controller per `jobId`. Delete it after a
terminal result or failure. A cancelled job must not emit later progress or
overwrite a newer job's UI state.

`SolverWorkerHost` implements that lifecycle around a registry and worker-side
transport. `SolverWorkerClient` owns main-thread discovery/run/cancel, abort
integration, stale-job suppression, transport cleanup, and result
revalidation. Both use small transport interfaces so their behavior can be
tested without a real browser worker.

The classic engine yields with a macrotask rather than an already-resolved
promise. That gives the worker event loop a chance to receive cancellation
messages during CPU-heavy searches. Progress is emitted at a bounded cadence
with elapsed time, expanded/generated states, live and peak frontier sizes,
deduplication, pruning, heuristic, reachability, depth, and estimated-memory
counters. The dialog keeps only a bounded, throttled status history.
Interactive runs also carry a conservative estimated-memory ceiling so
an unlimited-time search cannot consume the browser tab without bound.

## Hint system

`src/features/game/use-hint-controller.ts` provides a lightweight hint feature
built on top of the solver worker infrastructure. It creates a dedicated worker
lazily on first request and keeps it alive for the duration of the session.

When the player presses H or taps the Hint button (positioned between Undo and
Restart in `GameControls`), the controller submits a move-minimizing A* search
with a 5-second time limit and a 128 MB memory ceiling. If a solution is
found, the first three steps are extracted and animated through the existing
`playSolverSolution` pipeline. The player sees the moves play out on the board
without the full solver dialog opening.

The hint worker follows the same `SolverWorkerClient` lifecycle as the solver
dialog: discovery, run, cancel, and cleanup. Stale-job suppression ensures
that switching puzzles or restarting mid-hint does not apply outdated steps.

## Implementation requirements

- Never mutate the request or retain it in global mutable state.
- Honor declared limits and check cancellation frequently enough for responsive
  shutdown. Do not claim cooperative cancellation otherwise.
- Report monotonic, finite, non-negative metrics. Report `fraction` only when a
  meaningful bound exists.
- Advertise only the move objective and reject obsolete objective payloads at
  the protocol boundary.
- Give heuristic ties a deterministic final ordering. If randomness is useful,
  make the seed an explicit option and report it.
- Use stable box IDs and exact robot positions. In particular, a hard pruning
  proof may not substitute an arbitrary neighbor for the true post-push player
  cell.
- Keep adapter options namespaced and JSON-safe. Validate unknown, missing, and
  out-of-range values at the boundary.
- Verify candidates with `verifySolverSolution()` or
  `assertVerifiedSolverSolution()` before returning `solved`. Verification
  replays `stepSnapshot()`, requires every step to move, checks walk/push kinds,
  counters, objective score, and the final solved state.

## Testing a solver

Each implementation should have:

1. contract tests for metadata, the move objective, limits, and cancellation;
2. legality tests that replay every returned solution through the core;
3. targeted safety tests for every hard pruning rule;
4. deterministic fixture tests with fixed outcomes;
5. benchmark gates recording runtime, expanded states, moves, and pushes
   separately;
6. worker protocol tests for stale progress, duplicate job IDs, cancellation,
   malformed messages, and thrown failures.

Grand Hall should be retained as a quality and performance fixture, but no
single puzzle should determine the architecture or algorithm choice.

## Solver V2

Work in progress. See [`solver-v2-spec.md`](solver-v2-spec.md) for the full
specification and [`solver-v2-progress.md`](solver-v2-progress.md) for sprint
status.
