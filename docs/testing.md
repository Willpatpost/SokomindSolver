# Testing

Sokomind uses Node's built-in `node:test` runner for deterministic domain and
preference tests. The production artifact receives a second pass after Vite
builds it.

Run every repository gate before merging:

```sh
npm run typecheck
npm run lint
npm run lint:docs
npm run audit
npm test
npm run test:coverage
npm run test:browser
npm run test:solver:proof-regressions
npm run test:solver:multi
npm run test:solver:huge
```

## Test layers

### Unit

`tests/unit` covers:

- puzzle parsing and validation;
- immutable game transitions, undo, and reset;
- all catalog definitions and metadata corrections;
- transition-to-feedback classification;
- canonical action logs, structural-sharing undo, and exact replay;
- defensive progress, attempt, route, and preference parsing;
- strict solver payload validation, solution verification, worker
  cancellation, cleanup, and stale-job suppression;
- deterministic DFS, Greedy, A*, and IDA* results, resource limits, progress
  counters, admissible assignment bounds, and safe deadlock pruning;
- independent step-state oracle comparisons for A*/IDA* move optimality and
  exhaustive tiny-board admissibility checks.

Round 2 and 3 additions:

- `deadlock-bridge.test.ts` — verifies corner and 2x2 deadlock detection
  through the game-layer bridge, including the `WeakMap` board cache;
- `trail-positions.test.ts` — checks extraction of unique trailing positions
  from the undo history linked list;
- `format-time.test.ts` — covers M:SS and H:MM:SS formatting edge cases;
- `move-notation.test.ts` — tests arrow glyph mapping, truncation with
  ellipsis, and empty-log handling.

These tests do not start a browser, server, or worker.

### Static artifact

`tests/static-build.test.mjs` reads `dist/index.html` and its emitted assets. It
checks that:

- required metadata and the application mount point exist;
- local scripts and styles are relative rather than rooted at `/`;
- every referenced local asset exists inside `dist/`;
- `.nojekyll`, the favicon, and social image are copied;
- the client bundle contains the playable application;
- no Cloudflare or server-build coupling remains;
- cold-route eager dependency closures, associated styles, and the first Play
  board payload stay within reviewed gzip budgets;
- the Home dependency closure does not include board payloads;
- generated board shards are runtime-classified and each remains below its
  reviewed gzip budget.

This test is the GitHub Pages portability guard.

### Browser and accessibility

`tests/e2e` runs Playwright against the built artifact at `/Sokomind/`. It
covers solving, exact reload recovery, undo, guarded reset, cross-tab progress
updates, modal input isolation, explicit and system motion policies, Grand Hall
deep links, 50-row catalog pagination, mobile Help/selector access, control
ordering, completion feedback, worker discovery, solver cancellation, and
verified solution playback. A service-worker project exercises runtime cache
fill, offline direct Play, navigation-404 safety, paired worker/manifest
generation replacement, and rejection of a cross-build manifest while the
known-good cache remains active.
Axe scans representative light/dark views and solver controls against WCAG
A/AA rules.

`tests/critical-route-behaviors.json` is the required behavior matrix for Home,
Selector, Play, Editor, and Stats. Its unit gate verifies that every entry still
names a direct executable `test`/`it` declaration. Skipped, todo, suite, hook,
and dynamically inferred names cannot satisfy the matrix. This keeps route
behavior visible even though Playwright coverage is not merged into the Node
line-coverage report.

The dedicated `minimum-width-chrome` project runs the narrow-layout contract at
320 x 568 pixels. It checks Home settings, all Play actions and guidance,
semantic mobile navigation, explicit offline state, and the editor starter/tool
flow without horizontal overflow. Desktop projects exclude that file so the
same assertions are not multiplied across unrelated viewports.

The cross-platform runner owns the preview server directly so Windows and CI
both shut down cleanly. Prefer roles and visible labels over implementation
selectors.

### Dependency security

`npm run audit` fails on high or critical advisories. GitHub Actions runs it
after the clean lockfile install, while Dependabot checks npm and workflow
dependencies each week. Review advisories before using forceful or
major-version automated fixes.

### Coverage and performance gates

`npm run test:coverage` enforces three independent non-regression gates. The
`c8 --all` pass includes every TypeScript and TSX source file, including files
that no test imports, with 60% line/statement, 80% function, and 78% branch
floors. A focused typed-source pass keeps a higher floor for code
exercised by the unit suite, while the generated-engine pass prevents aggregate
gains from hiding a drop at the vendored boundary.

`test:solver:known` runs production exact A* against every ordinary entry in
the frozen optimum manifest; `test:solver:parallel` independently exercises
the production two-worker inter-rooms proof path. They form
`test:solver:proof-regressions` in pull-request and default-branch CI. The much
slower `test:solver:known:extended` fixture runs in the scheduled/manual
Extended Solver Proof workflow.

`test:solver:multi` covers representative difficulty tiers;
`test:solver:huge` separately gates Grand Hall discovery, rewrite, orientation
parity, replay validity, and total wall-clock budgets. Each synchronous solver
case runs in a child process that the parent can terminate at its deadline, so
an event-loop-blocking regression cannot hang CI indefinitely.

### Solver quality

Record elapsed time, expanded/generated states, moves, pushes, solver version,
seed, retained memory, peak RSS, tuning fingerprint, and resource limits.
`npm.cmd run benchmark:solver` runs each hard/master case in a fresh process
and emits JSON Lines suitable for optimizer datasets. Grand Hall is an
important fixture, but no single puzzle should determine solver architecture.

Optimality tests use a separate step-by-step Dijkstra oracle on compact
fixtures; they do not reuse push macros, solver state keys, or heuristic code.
The A* assignment bound is also checked exhaustively across every two-box and
keeper placement on a tiny board. Every returned route is replayed through the
immutable core before it can reach the UI.

Exact preprocessing is part of the same elapsed and memory budget as search.
Cutoff tests therefore cover pattern databases and deadlock tables as well as
frontier expansion, and require retained preprocessing memory/counters to
remain visible in terminal metrics.

## Required invariants

- Every catalog definition validates and has a unique ID.
- Declared box counts match board rows.
- Core operations never mutate prior sessions.
- A blocked move returns the same session.
- A push preserves the box's stable ID and exact keeper position.
- Undo and reset restore exact snapshots.
- Action logs and persistent history remain aligned.
- Transition feedback distinguishes steps, pushes, placements, and solves.
- Invalid stored data returns safe defaults.
- Duplicate solver IDs fail instead of replacing an adapter.
- Invalid solver payloads and unverifiable solutions never cross the worker
  boundary as trusted results.
- A* never reports a cost below an independently computed exact optimum.
- Cancellation and every configured resource limit return terminal metrics.
- Built asset paths work beneath a GitHub project-page subdirectory.

Every bug fix should begin with the smallest deterministic fixture that exposes
the defect. Avoid large internal snapshots; assert public behavior and compact
domain values.
