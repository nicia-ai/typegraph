# F1a design note: recorded-time history capture (versioned state, no log)

*June 10, 2026. Status: **ratified** — same day the no-log line was adopted
(see below). Supersedes [temporal-f0-mutation-log.md](./temporal-f0-mutation-log.md):
the F0 mutation log is dissolved; its audit value ships here as columns on
history rows. Decisions D1–D7 and the gate numbers are final; benchmarks run
against these numbers, not the other way around.*

---

## The no-log line (ratified June 10, 2026)

> TypeGraph maintains **versioned state, never an event log**: recorded time
> lives on rows as intervals; history is queried, not replayed. No stream
> abstraction, no offsets, no replay API — internally or publicly. Anything
> stream-shaped belongs to the host database's CDC (WAL / logical
> replication / session extension) or an upstream runtime's log (e.g.
> Electric Durable Streams).

Why this line is load-bearing: F1b's as-of-recorded read gate forces an
indexed history relation in *any* design — a log would have been additional
surface deriving the same relation. The log's unique deliverables all have
cheaper substitutes: op/tx/meta audit columns live on history rows;
schema-binding is a stamped column (better than log marker entries — no
wall-clock joins); branch-diff anchors use recorded timestamps or stay
enumerate-and-compare; outbound change streaming is the database's own CDC
(on Postgres, Electric can sync the typegraph tables directly — the adapter
exists without us shipping one).

The line's precise scope: it bans the **event-log abstraction**, not tables
that record the past. History side-tables are versioned state — without
them F1 is unimplementable as a library over vanilla SQLite/Postgres (the E
spike killed in-table row versioning at ~2× read cost; neither engine has
native system versioning usable from a library).

## Scope and ship test

Opt-in recorded-time history for node and edge mutations, captured in the
same transaction, with a typed per-entity history read surface and a
retention API. Complete on its own (the sqlite-history / `temporal_tables`
use case: "show me every version of this row, with when/what/why"), no
query-compiler changes — `temporal("asOfRecorded")` is **F1b**, a separate
slice with its own gates.

Out of scope: derived side-tables (fulltext, embeddings, uniques) — they
are maintained from base rows and are never historized; schema evolution —
already on its own timeline (`typegraph_schema_versions`); any read-path
change.

## The capture contract

System-versioning shape (SQL:2011 family). Current tables are **untouched**
— no new columns, current-mode reads stay byte-identical by construction.
Both current tables already carry what the contract needs:
`updated_at` is "when this version became current" (`= created_at` at
creation), plus `version`, `deleted_at` (`src/backend/drizzle/schema/sqlite.ts:93-140`,
`postgres.ts` mirror).

On every mutation of an existing row at time T, write **exactly one history
row containing the complete pre-image** (all columns: props, valid_from/to,
created_at, updated_at, deleted_at, version) with:

- `recorded_from` = pre-image's `updated_at` (when that version became
  current)
- `recorded_to` = T (when it stopped)
- `op` = what ended it: `update | delete | restore | hardDelete`
  (`restore` = update with `clearDeleted: true`, the upsert-revive path,
  `src/backend/types.ts:200-201`)
- `schema_version`, `tx_id`, `meta` (audit columns, below)

`create` writes no history row — the current row is the record of the open
interval. Reconstruction invariant (the checkpoint law, tested as a
property): for any T, the image of `(kind, id)` as of recorded time T is
the history row whose `[recorded_from, recorded_to)` contains T, else the
current row if `updated_at <= T` — with `deleted_at` interpreted by F1b's
read algebra (a tombstoned current row was last *believed* until its
`deleted_at`; its pre-tombstone image is in history because `delete`
captures it). `hardDelete` keeps prior history rows and captures the final
image, so hard-deleted entities remain visible to history reads — this is
precisely what today's soft delete cannot do (`deleted_at` hides rows from
*all* history, `src/query/compiler/temporal.ts:71`).

Capture mechanism — no application-level read of the pre-image:
`INSERT INTO <history> SELECT ..., <op>, <T> FROM <current> WHERE <pk>`
immediately before the mutation, same transaction. On Postgres the pair can
be one statement (data-modifying CTE: all CTEs see the same snapshot, so
the capture reads the pre-image); on SQLite it is two statements inside the
transaction (D4).

## Decisions (carried and revised from the F0 note)

### D1 — Capture lives in the backend core (unchanged; mechanism-independent)

Inside `createCommonOperationBackend`
(`src/backend/drizzle/operation-backend-core.ts:184`): one shared
implementation, both dialects, and it covers **all** callers — the
operations layer, batches, upserts, hard-delete cascades, and crucially
`src/interchange/import.ts:286,300,464,476`, which bypasses the operations
layer. Per-dialect SQL shape is sanctioned here (`operationStrategy` is
already per-dialect); the `src/query` parity rule is not in play.

### D2 — Pre-image capture (revised from F0's after-image)

F0's after-image rationale was log-specific (self-contained replay
entries). System versioning's native shape is pre-image + open current row,
which yields identical reconstruction power with one fewer write on create.
The pre-image is captured by `INSERT … SELECT`, never round-tripped through
the application.

### D3 — Opt-in at store creation (unchanged)

`createStore(graph, backend, { history: true })` (exact option name
finalized in implementation; neutral vocabulary — not `audit`, not
`belief`). Off by default: a general-purpose library must not double write
volume silently, and off = zero overhead **by construction** (no capture
statements are emitted at all; compiled-statement snapshot tests assert
byte-identical SQL).

### D4 — Atomicity guaranteed where transactions exist, declared where not (unchanged)

Invariant: a history row commits iff its mutation commits.

- Explicit/adopted transactions: capture rides the pinned connection. Free.
- Implicit single ops: Postgres — one statement via data-modifying CTE;
  SQLite — the execution seam gains a `runMany`-style member executing the
  pair inside a driver-level transaction (the one new internal seam).
- `capabilities.transactions === false` (D1/neon-http):
  `capabilities.history: "atomic" | "best-effort"` — best-effort ordered
  *capture first, mutation second* (a crash can record a version-end that
  didn't happen? No — capture-first records a pre-image whose interval end
  is T; if the mutation then never lands, history claims a transition that
  didn't occur. Mutation-first instead: a crash loses a history row but
  never fabricates a transition. **Best-effort order = mutation first,
  capture second**: missing history, never phantom history.) Documented in
  the parity matrix with a test asserting the exact declared behavior.

### D5 — `schema_version` stamped on every history row (revised: no markers)

Sourced from the backend core's cached active version (invalidated by its
own `commitSchemaVersion`; cache seeded via the existing
`readActiveVersion`, `operation-backend-core.ts:191-197`). No marker
entries — there is nothing to mark; F2 binds via the stamped column, and
stamping *current* rows is an F2 design question, not F1a's.

### D6 — Read, retention, and audit-metadata surface (reworked)

- `store.nodes.<Kind>.history(id)` / `store.edges.<kind>.history(id)` →
  typed versions, descending `recorded_to`, each carrying
  `{ image, recordedFrom, recordedTo, op, schemaVersion, txId, meta }`.
  This **is** the audit surface; there is no separate log API.
- `store.history.prune({ before })` → drops history rows with
  `recorded_to < before`. Append-forever is a footgun for bulk-ingest
  users; consequences documented.
- `tx_id`: store-generated id (one per transaction / implicit op) so
  multi-row transitions group; an opaque string, not an offset.
- `meta`: nullable JSON populated from `store.transaction(fn, { meta })`
  and a per-op escape hatch — the "who/why" column any CRUD audit needs.
- No subscriptions, no tailing API, no export beyond `history()` — per the
  line. Cross-entity "what changed since T" queries are F1b territory if
  demanded; not v1 surface.

### D7 — Direction D detaches (unchanged in substance)

Branch-diff acceleration ("changed rows since anchor" from history
intervals, anchor captured inside the serializable merge transaction) is an
optional later merge optimization. Enumerate-and-compare remains the
shipped mechanism. Direction A (audit log) is dissolved — F1a *is* its
value, log-free.

## Table sketch

`typegraph_node_history` / `typegraph_edge_history` (names via
`backend.tableNames`, both dialects):

- All columns of the corresponding current table (the pre-image), plus:
- `recorded_from`, `recorded_to` (timestamp; text in SQLite, consistent
  with peers), `op`, `schema_version`, `tx_id`, `meta` (nullable JSON)
- Surrogate autoincrement PK — an implementation detail for row identity
  (same-timestamp transitions in one transaction), **never exposed in the
  read API**; user-visible ordering is `(recorded_from, recorded_to,
  version)`. This is not an offset and grants no replay semantics.

Indexes: `(graph_id, kind, id, recorded_to)` for `history(id)`;
`(graph_id, recorded_to)` for `prune`. DDL joins `ensureSchema` exactly as
`typegraph_kind_removals` / `typegraph_contribution_materializations` did.

## Pre-registered gates (final)

Benchmarked in `packages/benchmarks`, E-spike shapes (50k nodes / 200k
edges) + a bulk-ingest shape, both dialects, history ON vs OFF:

1. **History off:** byte-identical compiled statements (snapshot-tested),
   zero overhead by construction.
2. **History on, single-op writes:** p50 latency overhead ≤ **15%**.
3. **History on, bulk ingest:** wall-clock overhead ≤ **30%** (capture
   statements batched with data statements; ceiling, not target).
4. **Read path:** untouched by construction.

Kill criterion: if (2) or (3) fails on either dialect after the CTE/batch
mechanics are in place, F1a does not ship and the design returns here —
recorded, same as the E spike. There is no fallback slice under the no-log
line; that is accepted.

## Benchmark results (measured June 10, 2026)

Run via `packages/benchmarks` (`src/history-capture-bench.ts`), history ON vs
OFF. SQLite uses the repo-conventional in-memory `:memory:` connection
(`src/backend.ts`); Postgres is node-postgres against a real server; PGlite is
the in-process WASM engine. Single-op figures are p50; bulk is wall-clock for a
re-ingest-as-update pass (`bulkUpsertById` over existing ids — `bulkInsert` /
`bulkCreate` write no history, so a fresh insert measures zero capture cost).

| Dialect | Seed | update p50 off→on | delete p50 off→on | bulk wall off→on |
| --- | --- | --- | --- | --- |
| SQLite (better-sqlite3, in-mem) | 150k / 275k | 0.041→0.074 ms (+82.9%) | 0.085→0.110 ms (+29.2%) | 1158.8→1788.0 ms (+54.3%) |
| Postgres (node-postgres, real) | 60k / 110k | 0.4→0.3 ms (−15.9%) | 0.6→0.6 ms (−6.7%) | 4636.6→4804.2 ms (+3.6%) |
| PGlite (in-process WASM) | 30k / 55k | 0.320→0.392 ms (+22.5%) | 0.545→0.600 ms (+10.2%) | 1859.2→2127.0 ms (+14.4%) |

Gate verdicts (≤15% single-op p50, ≤30% bulk):

| Dialect | update ≤15% | delete ≤15% | bulk ≤30% |
| --- | --- | --- | --- |
| Postgres | PASS (−15.9%) | PASS (−6.7%) | PASS (+3.6%) |
| PGlite | **FAIL** (+22.5%) | PASS (+10.2%) | PASS (+14.4%) |
| SQLite (in-mem) | **FAIL** (+82.9%) | **FAIL** (+29.2%) | **FAIL** (+54.3%) |

### Kill criterion tripped — F1a does not ship as gated

Per the kill criterion, a single-op or bulk gate failing on **either** dialect
means F1a does not ship and the design returns here. **Real Postgres passes
every gate cleanly** — the data-modifying CTE folds capture into the mutation's
round-trip at ~0 added latency (the negative single-op numbers are run-to-run
noise). **In-memory SQLite fails all three, and this is a genuine cost of the
ratified mechanism, not a bug:** D4's atomic SQLite capture is `BEGIN;
INSERT…SELECT (capture); UPDATE/DELETE (mutation); COMMIT` — three statements
added to a one-statement op. The *absolute* overhead is tiny (update +33 µs,
delete +25 µs), but in-memory SQLite's single-op baseline is 40–85 µs, so a
fixed extra statement is a >15% relative add *by construction*. PGlite (a
higher-latency WASM-Postgres baseline) sits between: delete and bulk pass,
update misses at +22.5%.

The mechanism is correctly and minimally implemented; it cannot be made cheaper
without either (a) abandoning the ratified app-issued `INSERT…SELECT` for a
SQLite trigger — which cannot carry the app-supplied audit columns (`op`,
`recorded_to`, `tx_id`, `meta`) and would change a ratified decision — or
(b) weakening D4's atomicity by dropping the transaction framing. Both are out
of bounds, so the implementation stops here and records, per the discipline
that adjudicated the E spike.

**Open question for adjudication (deliberately not decided here, to avoid
tuning the gate):** the ≤15% single-op gate was set without pinning the SQLite
latency baseline; the repo's benchmark convention is in-memory `:memory:`,
where any second statement exceeds 15% on a sub-100 µs op. A file-based / WAL
SQLite deployment — the realistic regime where write-capture overhead actually
matters — has a higher baseline under which the same fixed ~25–33 µs would
likely fall under the gate. Whether the gate should be evaluated against
in-memory SQLite (current result: FAIL), a file-based baseline (likely PASS),
reframed as an absolute-overhead bound, or whether F1a simply holds, is a
calibration call for the gate's author. The full implementation (capture,
store surface, cross-backend + property + snapshot + capability tests, docs,
benchmark) is complete and green on functional tests; only this latency gate is
open.

## Test plan

- Cross-backend integration group (`tests/backends/integration/`,
  registered via `createIntegrationTestSuite`): every mutation of an
  existing row writes exactly one history row with correct op taxonomy
  (incl. upsert-revive → `restore`); creates write none; rolled-back
  transactions write none; import writes are captured; `history(id)`
  content/order; `prune`; `meta` and `tx_id` propagation; hard-delete
  leaves history intact.
- **Checkpoint-equivalence property test** (fast-check, both dialects):
  random op sequence; after each step snapshot the store's logical state;
  at the end, reconstruct state per the capture contract at each step's
  timestamp and assert equality. This replaces F0's replay law and is the
  net that catches any unlogged write path.
- Capability tests: non-transactional backends assert declared
  `capabilities.history` semantics.
- Parity-matrix row in `backend-setup.md`.

## OSS guardrail check

Vocabulary is neutral throughout (`history`, `recorded`, `versions`,
`prune`); the general-value case is system-versioned history for
SQLite/Postgres as a library — a SQL:2011-class capability neither engine
offers natively to libraries. Agent framing (belief, retraction) stays
under `/tms`, which gates on **F1b**, not F1a.
