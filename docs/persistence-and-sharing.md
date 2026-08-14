# Persistence and sharing

Sokomind remains account-free and server-free. Attempts, personal bests, and
experience preferences are stored only in the current browser unless the user
chooses to export or share them.

## Storage records

All keys are namespaced because GitHub project pages under one user domain
share a Web Storage origin:

- `sokomind.session.v1` — current puzzle plus its canonical action log;
- `sokomind.progress.v1` — a versioned synchronization envelope containing the
  best completed route per puzzle plus a schema-v2 local-date daily
  participation ledger and a bounded local-date completion-activity ledger;
- `sokomind.experience.v1` — audio, volume, and motion preferences;
- `sokomind.optimal.v4` — locally proven move records from the corrected
  minimum-move proof pipeline;
- `sokomind.ratings.v1`, `sokomind.favorites.v1`, and
  `sokomind.editor-draft.v1` — device-local preferences and a schema-v2,
  bounded named-draft store;
- `sokomind.editor-draft-recovery.v1` — a quarantined invalid draft that can be
  downloaded or deleted without clearing other data;
- `sokomind.reset.v1` — a retained cross-tab marker for a confirmed full-data
  reset.

Per-puzzle elapsed time uses the tab-private
`sokomind:timer:<puzzle-id>` session-storage namespace. The legacy exact key
`sokomind:timer` remains owned only so a full reset can remove it safely.

The storage adapter classifies unavailable-storage, security, quota, and
unknown failures. A deduplicated warning remains visible while any owned key
cannot be persisted and clears after a later successful write. Earlier storage
schemas remain readable for migration.

Sessions and optimal records are also written to IndexedDB as a
quota-resilient secondary copy. Access to those durable records is checked
against the document's reset generation. Play waits for asynchronous
session hydration before enabling autosave, and it will not apply a late
hydrated record after the user has already moved. If the player navigates away
after moving while that read is still pending, the newer in-memory attempt is
flushed during unmount so the readiness gate cannot lose it. Home also performs
a generation-fenced IndexedDB pointer lookup, so an IDB-only newest attempt
remains discoverable through Continue. Optimal-cache
hydration merges both storage tiers by the lower proven move count. Optimal
payload schemas 1 through 4 are intentionally discarded because they predate
the current proof corrections and cannot be trusted as minimum-move proofs.

Progress writes re-read the latest stored snapshot before mutation. Tabs merge
same-generation records deterministically by move count and stable tie-breakers;
a reset advances the generation so a stale tab cannot resurrect cleared data.
The browser `storage` event propagates completions, imports, and resets without
requiring an account or server.

The error-recovery **Reset saved data** action first advances a durable
IndexedDB generation fence and clears all durable app values in the same
transaction. The new generation is greater than both the retained local marker
and the previous durable fence. A delayed stale write is therefore either
cleared before that transaction commits or observes the newer fence and becomes
a no-op. After the durable phase, one synchronous local phase clears every
enumerated owned key and the owned timer namespace, writes an empty
higher-generation progress tombstone, and publishes the reset marker. Other
active tabs clear their private timers and reload at Home before their mounted
attempt can save stale data again.

Reset markers written before the durable fence existed are migrated as
generation 1. On the next fenced read, any unfenced pre-reset IndexedDB values
are cleared and the durable store is rebased instead of being hydrated. A real
IndexedDB open or transaction failure remains visible in the error boundary
instead of being reported as a successful reset; only browsers that truly lack
IndexedDB skip that secondary clear. Prefix-adjacent and unrelated origin keys
are preserved.

## Exact attempt recovery

The session record never stores trusted coordinates. It stores a puzzle ID and
compact `U`, `D`, `L`, and `R` actions. Recovery resolves the current catalog
puzzle and replays every action through the core transition. An unknown puzzle,
invalid character, excessive log, or blocked action fails closed to a clean
room.

This same replay rule is used for shared solution fragments and solver result
verification. There is only one definition of a legal player transition.

Elapsed time is stored separately in the tab-private, puzzle-keyed timer entry;
it is not cryptographically or structurally bound to a particular action log.
Timer restoration is therefore deferred until session hydration finishes and
occurs only when Sokomind accepts a non-empty saved session for that puzzle.
This includes a session recovered solely from IndexedDB. Fresh puzzle choices
and shared routes clear the puzzle's old timer instead, and no timer decision is
made while asynchronous hydration is still unresolved.

## URLs and browser history

Puzzle routes use a GitHub Pages-safe hash:

```text
#/play/huge
#/play/ultra-tiny?play=D
```

Selecting a puzzle adds a browser-history entry. A Share action includes the
current route when it is at most 2,000 actions; longer attempts share the
puzzle only. Loading an edited or illegal replay still opens the named puzzle
but never trusts the bad state.

## Progress backups

The Progress dialog and Statistics page share the same bounded importer. Files
are limited to 1 MB and 10,000 records, parsed before commit, normalized against
the active catalog, and summarized as added, improved, unchanged, rejected, and
invalid records. MIME type and extension remain picker hints, not trust
boundaries. Imports merge rather than replace; the better record is the one
with fewer moves, and its original completion timestamp is preserved.

Daily participation is keyed by local calendar date and the puzzle assigned on
that date. The daily selection changes at local midnight; calculations use the
local year/month/day tuple so daylight-saving transitions do not create a
23-hour or 25-hour “day.” A lifetime best from another date never clears the
current daily challenge.

Shared editor links open as read-only previews. They do not autosave or replace
any device draft until the player explicitly chooses **Import into editor**
and selects or creates the destination document.

Reset progress writes a new empty synchronization generation after explicit
confirmation. It does not change the current attempt or experience preferences,
editor drafts, favorites, ratings, or solver records, and open tabs converge on
the reset generation. The separate error-recovery full-data reset owns all app
keys and uses stronger confirmation language.
