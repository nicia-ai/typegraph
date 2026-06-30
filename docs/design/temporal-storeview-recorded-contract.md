# Temporal foundation: StoreView + the recorded-time relation contract

*Implementation spec — revised after independent code review and Unit 2
planning (June 17, 2026) that approved the direction, corrected the first
draft's surface claims, and locked the recorded-time capture/read contract.
Supersedes the recorded-time half of the earlier temporal-core design notes,
which this document reworks into the public relation contract below. The
valid-time substrate, the no-log line, and the `/tms` vocabulary boundary are
unchanged.*

Two ratified decisions and the work behind them:

1. **Invert the build order.** Ship a small, complete time-travel *abstraction*
   (`StoreView`) on the already-public valid-time surface first; then re-express
   the (unpushed) recorded-time work as one implementation behind it.
2. **Recorded time is a public relation contract, not a private side-table.** A
   self-contained, SQL:2011-style system-versioned relation. TypeGraph's built-in
   capture is *one populator*; bring-your-own and an inbound external-log
   materializer are equally first-class. One read serves all of them.

North star: **Datomic** (`(d/as-of db t)` → a read-only database value),
**Dolt** (`AS OF`), **SQL:2011** (`FOR SYSTEM_TIME AS OF`). Where those are the
reference we follow them rather than invent vocabulary.

This doc is structured as two implementation specs (Unit 1, Unit 2). Unit 1 has
landed as the StoreView valid-time slice; Unit 2 builds recorded time on that
coordinate seam. The preferred external delivery remains one PR / one release
train by default, while staying independently reviewable enough to split if Unit
2 grows too hard to reason about.

---

## Unit 1 — `StoreView`: a read-only `(mode, asOf)` read context

`StoreView` is a **read-only** facade over a `Store` that pins a temporal
coordinate and routes every supported read through it:

```ts
const past = store.asOf("2026-01-01T00:00:00.000Z"); // valid-time lens
await past.query().from("Person", "p").whereNode("p", ...).select(...).execute();
await past.nodes.Person.getById(id);
await past.edges.knows.findFrom(alice);
past.subgraph(...); past.reachable(...); past.degree(...);
```

### It is an explicit read context, not a default flip

The first draft called this "a thin wrapper over the `defaultTemporalMode`
seam." That was wrong: the seam is **not** uniform.

- The query builder hardcodes its own default (`temporalMode: "current"`,
  `builder.ts`), independent of `graph.defaults`.
- `subgraph()` reads `graph.defaults.temporalMode` directly as its fallback
  (`store/subgraph.ts`).
- Collections apply `options.temporalMode ?? defaultTemporalMode` per call.

So `StoreView` is an explicit context that **injects `(mode, asOf)` into each
surface it hands out** — the query builder it returns is pre-pinned, the
collections it exposes default to the pinned coordinate, `subgraph` /
algorithms receive it explicitly. It is not load-bearing on any single existing
default.

### Supported-surface matrix (Unit 1, valid-time)

Every surface a `StoreView` exposes must *honor* the pin or *refuse* it — never
silently ignore it. Verified current behavior and the required action:

| Surface | Valid-time today | Action in `StoreView` |
| --- | --- | --- |
| `nodes.getById` / `getByIds` | honors via `matchesTemporalMode` | pin, supported |
| `nodes.find` / `count` | honors via `asOf` param / compiler | pin, supported |
| `query(...)` | builder default `"current"`, honors `.temporal()` | inject pin explicitly |
| `subgraph(...)` | honors `options.temporalMode` | inject pin explicitly |
| `reachable` / `canReach` / `shortestPath` | honor via algo context | inject pin explicitly |
| `degree(...)` | honors valid-time filter | inject pin explicitly |
| `edges.findFrom` / `findTo` | honors temporal options | pin, supported |
| `edges.findByEndpoints` | honors temporal options | pin, supported |
| batch/deferred reads | require `store.batch()` context | absent from `StoreView` |
| `store.search` (fulltext/hybrid) | **no temporal surface**; index reflects current state | **out of scope v1:** the view's `search` throws `ConfigurationError` for any non-`current` pin |

Two deliberate calls:

- **`findFrom`/`findTo` come into scope.** They are core edge reads; a pinned
  view that silently ignored the pin on endpoint lookups is a footgun. The fix
  is cheap — edges already carry `valid_from`/`valid_to`; add the options and the
  same `matchesTemporalMode` the `getBy*` reads use.
- **`findByEndpoints` comes into scope with endpoint parity.** It is a public
  read, not write-side get-or-create. Once it accepts the same temporal options
  as `findFrom` / `findTo`, a valid-time view pins it as well.
- **`search` is out of scope, explicitly.** Historical fulltext relevance is a
  separate, harder feature (the index reflects current state). A pinned view's
  `search` therefore *refuses* rather than fakes — the same honesty as the
  `asOfRecorded` reconstructing-surface guard.

### Read-only and bitemporally shaped

- **Read-only by construction.** A time-pinned view is a read perspective;
  mutating "the graph as of last Tuesday" is incoherent. Writes stay on the live
  `Store`. Mirrors Datomic's as-of db value.
- **Pins a structured `ReadCoordinate`.** The valid axis
  (`current` / `asOf` / `includeEnded` / `includeTombstones`) and sibling
  recorded axis live together; recorded time is not a new `TemporalMode` arm. Direct
  `store.asOfRecorded(T)` is diagonal sugar (`valid.asOf = T`,
  `recorded.asOf = T`); `store.asOf(validT).asOfRecorded(recordedT)` is the full
  bitemporal point. Recorded narrowing is one-way: broad `StoreView` can narrow
  to `RecordedStoreView`, but the recorded view has no further `.asOf()` /
  `.asOfRecorded()` escape hatch.

Unit 1 is implemented and verified first: valid-time time-travel with an
explicit, tested surface matrix. In the preferred one-PR path it is an internal
gate/commit slice rather than a separate release; if Unit 2 threatens
reviewability, this is the clean split point.

---

## Unit 2 — Recorded time as a public relation contract (B)

> **Shipped vs. deferred (as of `feat/temporal-recorded`).** The initial release
> implements **built-in capture** with `createStore(graph, backend, { history:
> true })`, the recorded relations + monotonic clock, the `asOfRecorded` /
> `recordedNow` / `withRecordedTransaction` read+write surface, and the
> `RECORDED_MAX` sentinel + canonical-ISO guards. It also ships the minimal
> **external recorded read binding**: `recordedRead: recordedRelation({ schema:
> createSqlSchema({ recordedNodes, recordedEdges }) })`. That binding is
> schema-level only, expects row-compatible recorded node/edge relations, and is
> factory-branded/frozen at runtime; it does not validate per-kind column
> contracts or populate rows. The richer bring-your-own relation contract remains
> deferred: graph/kind-keyed `recordedRelation({...})` contracts, the `recorded:`
> `createStore` option, `validate: "dev"` conformance checks,
> `recordedRelationRegistry`, `store.withRecordedRelation(...)`, and inbound
> external-log materialization. The sections below that reference those richer
> primitives describe intended future contract, not current API. The
> [Decision record](#decision-record) records the target architecture; verify
> against the changeset and `limitations.md` for the released surface.

### The contract

A **self-contained, system-versioned relation** (SQL:2011 `SYSTEM_TIME`
family). Every version of an entity — including the *current* one — is a row
carrying an explicit system-time period:

- **`recorded_from`** — when this version became the record (the prior
  transition instant; equals creation for the first version).
- **`recorded_to`** — when it stopped being the record; the current version's
  `recorded_to` is the **open** sentinel (see below).
- plus the full image (all current-table columns) and the audit columns already
  defined (`op`, `schema_version`, `tx_id`, `meta`).

An `asOfRecorded(recordedT)` read is the standard half-open
period-containment read against the relation alone, composed with the valid-axis
coordinate carried by the view:

```sql
recorded_from <= recordedT AND recordedT < recorded_to
```

Direct `store.asOfRecorded(T)` sets the valid axis to `asOf(T)` as diagonal
convenience. Chained `store.asOf(validT).asOfRecorded(recordedT)` keeps the
existing valid pin and adds `recordedT`.

No live-table dependency, no correlated anti-join.

### Interval invariants (the precondition for dropping the read tiebreak)

Unique containment — and therefore retiring `history_id` from the *read* — holds
**only if** the relation satisfies these per-`(graph_id, kind, id)` invariants.
They are the heart of (B) and must be enforced (by capture) and documented (for
BYO):

1. **No overlap.** No two rows for the same entity have overlapping
   `[recorded_from, recorded_to)` intervals. Built-in capture produces a clean
   chain for ordinary update sequences, but the read contract only needs
   non-overlap; gaps can represent periods where the entity was not on record.
2. **Exactly one open row.** An entity that exists in recorded-current state
   (including a soft-deleted/tombstoned one — the tombstone *is* the current
   version) has exactly one row with `recorded_to = RECORDED_MAX`. A
   hard-deleted-and-not-restored entity has zero open rows (its final version is
   closed at the delete instant).

**Hard delete is *gone*, by design — not an `op="delete"` event.** The
asymmetry in invariant 2 is user-facing, not incidental. A hard delete closes
the entity's final interval — so reconstructing any instant *before* the delete
still shows it — but writes no terminal `op="delete"` row and is therefore not
surfaced by `includeTombstones` at or after the delete. Soft delete is the
mechanism for a deletion that stays visible under `includeTombstones` and is
recoverable; reach for it when the deletion itself must be auditable as an
event. A consumer can still tell *hard-deleted-at-T* from *never-existed* by the
presence of the closed final interval, but the recorded relation deliberately
does not log the hard delete as a discrete event. Emitting an open `op="delete"`
tombstone for a hard delete to "match" soft delete would violate this invariant
(it is a second, perpetual open row), collapse the hard/soft distinction the
live table draws, and break the single-open-row precondition the read contract
relies on to drop the `history_id` tiebreak.

`history_id` survives as the relation's physical PK (row identity for storage),
but the **read** no longer orders or tiebreaks on it — invariants 1–2 make
`recorded_from <= T < recorded_to` single-valued. This is what model A could not
guarantee: A derived `recorded_from` from `updated_at`, which a
soft-delete/restore left stale, so its intervals overlapped on the lower edge and
needed the `recorded_to`-min anti-join + `history_id` tiebreak. B stamps an
explicit `recorded_from` per transition, so the anomaly is gone — *given the
invariants*, which is why they are stated before the read is simplified.

### Recorded commit clock — logical, monotonic, per graph

Built-in capture does **not** use raw `nowIso()` as the recorded commit instant.
Two commits in the same millisecond would otherwise close the prior open row and
open the next row at the same timestamp, creating a zero-width committed version
that the half-open read excludes forever.

Capture therefore allocates recorded commit time from a locked per-graph
high-water row:

```ts
recordedCommit = max(nowIso(), previousRecordedCommit + 1ms);
persistHighWater(recordedCommit);
```

One transaction gets exactly one recorded instant, shared by every touched node
and edge. The allocator is global per graph, not per entity, so a transaction
cannot split into different recorded instants across entities. This makes
recorded time a logical commit clock, Datomic-`t` shaped: under sustained
greater-than-1k separate transactions per second it may drift ahead of wall
clock. That is acceptable because capture is opt-in, bulk import is one
transaction / one instant, and valid-time still uses wall-clock `nowIso()`.

### `recorded_to` open sentinel — decided & verified: far-future constant, not `NULL`

`NULL` makes every predicate and index path conditional (`recorded_to IS NULL OR
T < recorded_to`). A single portable far-future constant keeps the read a plain
range predicate and the index a plain btree:

- **`RECORDED_MAX = "9999-12-31T23:59:59.999Z"`** — one fixed ISO-8601 constant.
  Verified against the actual schema: SQLite stores `valid_*` / `recorded_*` as
  `TEXT` (`schema/sqlite.ts`), Postgres as `TIMESTAMPTZ` (`schema/postgres.ts`);
  PGlite accepted the sentinel as `timestamptz`, indexed it, and the range
  predicate matched only the sentinel row. The constant sorts after every real
  timestamp on both, and is in range for `TIMESTAMPTZ`.
- **Canonical-format constraint (load-bearing for SQLite/BYO).** Text ordering
  only tells the truth for **fixed-width UTC ISO strings**
  (`YYYY-MM-DDTHH:mm:ss.sssZ`). A BYO relation populated with offsets
  (`+02:00`), unpadded fields, or omitted millis would make text comparison
  *lie* on SQLite — the range read would be wrong, silently. The contract
  therefore requires canonical UTC ISO timestamps in text-stored recorded
  columns. (TypeGraph's own writers already emit this form; the constraint binds
  BYO/inbound populators.)
- **Guard:** capture and the binding validator reject any real recorded
  timestamp `>= RECORDED_MAX` (collision) **and** any noncanonical timestamp
  (ordering hazard).

### Naming: `recorded_from` / `recorded_to`, not `valid_recorded_*`

| Axis | Columns | SQL:2011 | Question |
| --- | --- | --- | --- |
| domain / valid | `valid_from` / `valid_to` | `BUSINESS_TIME` | true in the world |
| system / recorded | `recorded_from` / `recorded_to` | `SYSTEM_TIME` | on record |

`asOfRecorded(T)` ≡ `FOR SYSTEM_TIME AS OF T` ≡ Datomic `(d/as-of db t)`.

### Binding & validation contract (distinct from `history: true`)

The earlier A implementation gated `asOfRecorded` on
`backend.history?.isEnabled()` and pointed failure text at
`createStore(..., { history: true })`. Contract (B) needs **two distinct
states**, because the read no longer implies our capture:

- **`recordedRelationBound`** — a relation conforming to the contract is bound
  for these kinds (built-in capture binds the default relation; a BYO/inbound
  caller binds theirs). This is what `asOfRecorded` reads actually require.
- **`captureEnabled`** — TypeGraph's built-in populator is writing the relation
  (today's `history: true`). A subset, not a synonym.

#### The binding API — explicit descriptor is the primitive

Three layers, because binding belongs in the store/schema compile context, not
in mutable backend state:

- **Shipped `recordedRelation({ schema })` — the minimal external read source.**
  It binds row-compatible recorded node/edge relations by table name for
  `asOfRecorded(T)` reconstruction, without enabling TypeGraph capture. The
  descriptor and `SqlSchema` must come from TypeGraph factories, are frozen at
  construction, and are validated again by `createStore`.

  ```ts
  const recordedRead = recordedRelation({
    schema: createSqlSchema({
      recordedNodes: "audit_nodes",
      recordedEdges: "audit_edges",
    }),
  });

  const store = createStore(graph, backend, { recordedRead });
  ```

- **Future richer `recordedRelation({...})` — the graph/kind contract.** A
  constructor over the graph `G` that names, per kind, the concrete relation +
  period/column contract, type-checked against the real node/edge kinds. It is
  evaluated at `createStore` time (the bind happens there), so it carries a
  `define*`-style descriptor name, not the imperative `bind*`. This richer form
  is design intent, not the shipped API.

  ```ts
  const store = createStore(graph, backend, {
    recorded: recordedRelation({
      nodes: { Person: /* table + period/column contract */ },
      edges: { knows:  /* table + period/column contract */ },
      validate: "dev",
    }),
  });
  ```

- **`history: true` — the easy path (sugar).** Enables TypeGraph's built-in
  populator *and* auto-binds its default recorded relation. `history` owns more
  than binding (the `history(id)` audit surface + `prune`), so it stays its own
  option and auto-binds as a consequence, rather than collapsing into `recorded:`.

  ```ts
  const store = createStore(graph, backend, { history: true });
  ```

- **Backend capability — under the hood.** "This backend can compile / validate /
  serve such a binding" — a **bind-time precondition** that fails
  `recordedRelation` / `history: true` early with a clear error on an unsupported
  backend. Never the user-facing "is bound" signal.

Resolved semantics:

- **`asOfRecorded` gates on `recordedRelationBound`, not `captureEnabled`.** The
  compiler uses a kind-keyed `recordedRelationRegistry` lookup in the
  schema/compile context (the way `fulltext` / `uniques` extend `SqlSchema`);
  the error names the missing node/edge kind, not "capture off."
- **No mixed images.** An `asOfRecorded` read touching *any* unbound kind
  **refuses the whole read** with that kind-named error — it never returns a
  recorded image for bound kinds beside the live image for unbound ones. Partial
  binding without this rule is the silent-lie vector the design exists to kill.
- **Immutable at construction.** Binding is fixed when the store is built. The
  only runtime form is `store.withRecordedRelation(...)` returning a **new**
  store (symmetric with `store.asOf(T)` / `StoreView`) — never a mutating method,
  which would make queries-built-before-bind, clones, transactions, and view pins
  order-dependent.
- **Validation default by populator.** Built-in capture maintains invariants
  1–2 by construction → default `off`; BYO/inbound → default `dev`. Same
  validator (invariants 1–2 + `RECORDED_MAX` collision + canonical UTC-ISO
  format). Intra-transaction collapse is capture behavior, not a BYO read
  contract invariant.
- **Double-bind is an error.** A kind bound by both capture and an explicit
  relation fails loudly, not by silent precedence.

### Indexes

- `(graph_id, kind, id, recorded_from, recorded_to)` — entity image at `T` and
  `history(id)`.
- `(graph_id, recorded_to)` — prune.
- `(graph_id, from_id)` / `(graph_id, to_id)` (period-extended) — so
  `asOfRecorded` traversals read the relation's own endpoint indexes, replacing
  A's live-index-residual trick. The relation is fully columned and indexed; it
  is not a skinny side-table.

### Populators — one read, many writers

- **Built-in capture** — reconcile-at-commit, not eager per operation. Capture
  sits at the transaction/write funnel below public collection operations,
  because `importGraph` and batch paths can call backend insert/update/delete
  methods directly. A capture-aware transaction wrapper records a touched set of
  `(entity, kind, id)` as writes flow through backend operations, allocates one
  monotonic recorded commit instant, then flushes once at commit: close any
  existing open relation row at that instant; read the post-transaction live
  image; open one new `[recordedCommit, RECORDED_MAX]` row if a live row remains.
  The `op` is the net transition derived from `(hadOpenRowBefore,
  hasLiveRowAfter)`, not the last raw operation.
- **Intra-transaction collapse** — multiple writes to one entity inside one
  transaction produce one observable transition. Create-then-hardDelete produces
  zero rows because the entity was never observable at any committed recorded
  instant. Create-then-soft-delete leaves one tombstone recorded row, visible
  only when the valid axis includes tombstones. No zero-width intermediate rows
  are persisted.
- **Transaction seams** — `store.transaction(fn)` is the native capture boundary.
  `store.withRecordedTransaction(externalTx, async (tx) => ...)` is the adopted
  external-transaction boundary: capture flushes inside the caller's transaction
  before the caller commits. Plain `store.withTransaction(externalTx)` remains
  valid for non-capture use, but when capture is bound, graph writes through that
  adopted context refuse loudly and point to the callback API because TypeGraph
  has no flush point after returning a context the caller commits.
- **Current tables untouched** — current-mode SQL stays **byte-identical**. The
  extra writes land only on the opt-in relation. This is the bundled populator,
  so `asOfRecorded` works out of the box.
- **Bring-your-own** — a user binds a conforming relation built from their own
  graph data; the validator proves conformance.
- **Inbound materializer** — a consumer drains an *external* log (CDC, Electric,
  an upstream agent runtime's stream) into the relation. The no-log line's
  sanctioned inbound role: we provide the relation and the read; **the log stays
  external** — no offsets, no replay, no stream abstraction in the library.

### Greenfield consequences versus the committed (A) design

- **Current versions are mirrored into the relation as open-interval rows** (so
  a row created before `T` and never updated is *in* the relation; A's
  superseded-only table lacks it). `create` gains one write to the opt-in
  relation — the cost of decoupling.
- **Current tables untouched; `current`-mode byte-identical** — unchanged gate.
- **The read simplifies and the containment anomaly disappears** (per the
  invariants above).
- **The read is relation-first everywhere.** The query compiler, recursive
  traversal compiler, `subgraph`, and graph algorithms use a shared read-source
  resolver that picks live versus recorded node/edge sources and supplies the
  period predicate. No scattered `schema.nodesTable` / `schema.edgesTable`
  swaps.
- **Recorded point reads are first-class.** `getById` / `getByIds` are cheap
  reconstructing reads and route through the same compiler/read-source path,
  preserving live API behavior: input order, duplicate IDs, and chunking.
- **Likely a Postgres perf *improvement*, to be benchmarked, not claimed.** A
  shipped a ~41× full-graph caveat because its correlated covering-interval `NOT
  EXISTS` is not index-served on Postgres; B's plain range predicate on a btree
  is standard. Validate on `asof-recorded-bench` before asserting the caveat is
  lifted.

### Supported-surface matrix (Unit 2, recorded-time)

`asOfRecorded` is a **reconstructing** read; it is supported only where the read
goes through reconstruction, and refused (not faked) elsewhere:

| Surface | Action |
| --- | --- |
| `query(...)`, `subgraph(...)` | supported (contract-relation read) |
| `reachable` / `canReach` / `shortestPath` / `neighbors` | supported |
| `degree(...)` | supported after rework to read the contract relation |
| `nodes.*.getById` / `getByIds` | supported through compiler-backed point reads |
| `edges.*.getById` / `getByIds` | supported through compiler-backed point reads |
| `find` / `count` | refused in v1 (predicate/index semantics are broader than point reads) |
| `edges.findFrom` / `findTo` / `findByEndpoints` | refused in v1 (direct collection endpoint reads stay valid-time-only until explicitly reconstructed) |
| `store.search` | absent from typed recorded view; runtime proxy refuses for JS callers |

The typed surface is narrow and derived from `StoreView` so signatures cannot
drift:

```ts
type RecordedNodeCollection<N> = Pick<
  StoreViewNodeCollection<N>,
  "getById" | "getByIds"
>;

type RecordedEdgeCollection<E, F, T> = Pick<
  StoreViewEdgeCollection<E, F, T>,
  "getById" | "getByIds"
>;

export type RecordedStoreView<G> = Pick<
  StoreView<G>,
  | "query"
  | "subgraph"
  | "reachable"
  | "canReach"
  | "shortestPath"
  | "neighbors"
  | "degree"
  | "mode"
  | "asOf"
> &
  Readonly<{
    asOfRecorded: string;
    nodes: RecordedNodeCollections<G>;
    edges: RecordedEdgeCollections<G>;
  }>;
```

No `.search`, no broad `.nodes.*.find`, no `.edges.*.findFrom`, and no further
`.asOf()` / `.asOfRecorded()` on the recorded view. The proxy remains the
runtime backstop for JS callers.

### Coherence note

For the **built-in capture**, `asOfRecorded(now) ≡ current` holds (open-interval
rows mirror live current state, same writer). For a **BYO / externally
materialized** relation, the relation is *authoritative for recorded-time reads*
and need not coincide with the live tables — the equivalence is then the
populator's invariant, not ours to guarantee. The contract states this.

---

## Test & benchmark gates

The rework must test `StoreView` and `asOfRecorded` across the **full surface
matrix**, including the surfaces A missed:

- **Unit 1 (valid-time), every supported surface:** `getById`, `getByIds`,
  `find`, `count`, `query`, `subgraph`, `reachable`, `shortestPath`, `degree`,
  edge `findFrom` / `findTo` / `findByEndpoints`; plus the
  *intentionally-unsupported* `search` refusal. Read-only enforcement (writes
  rejected on a view).
- **Unit 2 (recorded-time):** the narrow surface under `asOfRecorded`, with
  `degree` and point reads explicitly covered; unsupported direct
  collection/search surfaces are typed absent and refused at runtime for JS
  callers; soft-delete visible before / hidden after; restore reversible; domain
  valid-window untouched across recorded `T`; hardDelete present before/absent
  after incl. a traversal crossing a cascade-captured edge; direct diagonal
  `asOfRecorded(T)` and chained bitemporal `store.asOf(validT).asOfRecorded(rt)`;
  built-in capture `asOfRecorded(now) ≡ current`.
- **Interval invariants as a property test** — random op sequences (incl.
  multi-write-in-one-transaction) assert no overlap, single open row, one net
  transition per `(entity, transaction)`, no zero-width committed rows, and that
  `asOfRecorded(T_step)` equals the logical state at each step without any
  `history_id` tiebreak.
- **Clock allocator** — two committed transactions forced to the same wall-clock
  millisecond get distinct, both-observable recorded instants; every touched
  entity in one transaction shares the same recorded instant.
- **Transaction boundary capture** — `store.transaction(fn)` flushes on commit;
  `store.withRecordedTransaction(externalTx, fn)` flushes inside the adopted
  transaction; capture-bound writes through plain `withTransaction(externalTx)`
  refuse loudly.
- **Write-funnel coverage** — import/bulk paths that bypass `execute*`
  operation helpers still register touched entities and flush one net recorded
  transition at the transaction boundary.
- **BYO conformance** — the validator accepts a hand-built conforming relation
  and rejects overlap, two-open-row, sentinel-collision, and noncanonical
  timestamp violations.
- **Byte-identity** — `current`-mode compiled SQL unchanged with the feature in.
- **Benchmark gate** — (B) vs the recorded (A) numbers on `asof-recorded-bench`
  before any claim about the Postgres profile; numbers documented as honest
  characteristics, not gates that block the ship (per the standing call).

All query-feature tests live in the shared cross-backend suite
(`tests/backends/integration/`), per the backend-parity rule.

---

## Guardrails

1. **Never ship a read with no writer.** Unit 2 bundles the built-in capture
   populator. BYO is the extensibility, not the only path.
2. **A standard schema convention, not a plugin SPI.** Defensible *because it is
   a standard* (SQL:2011 system-versioning) — a documented relation shape + a
   read that targets any conforming relation, like the provenance sidecar and
   graph-merge's `typegraph-internal.ts` seam. No registration/lifecycle API
   beyond the binding entry point until a real third party asks.
3. **The no-log line holds.** History is queried, not replayed; the relation is
   versioned state. Stream-shaped work is the host DB's CDC or an upstream log;
   our role is inbound materialization.
4. **OSS vocabulary.** Neutral terms in core (`recorded`, `asOf`,
   system-versioned, history, view); `belief`/`retraction` stay under `/tms`.

---

## The payoff this sets up (out of scope here)

A read-only `StoreView` is the seam `branch()` / `merge()` will later consume —
they already read the base only through public `Store` methods, so a pinned view
gives **fork-from-T** and **merge-as-of-T** largely for free. Built now as a
seam only; the integration is gated on a real consumer. Likewise the inbound
external-log materializer is enabled by publishing the contract, not built
speculatively.

---

## Decision record

- **(B) over (A): ratified.** Self-contained system-versioned relation is the
  contract; A's composing side-table is demoted. A's only advantage was
  index-preserving read perf, and A failed its own ≤3× gate — the coupling was
  not buying what it cost. B is BYO-able, standard-aligned, simplifies the read,
  and probably improves the Postgres profile.
- **Order: ratified.** Unit 1 (`StoreView`, valid-time) landed first as the
  independently verified coordinate seam. Unit 2 implements recorded time on top
  of it. Preferred external delivery is **one PR / one release** with visible
  internal gates; split into two PRs only if Unit 2 makes the review or rollback
  risk too high.
- **Sentinel: decided & verified** — far-future `RECORDED_MAX =
  "9999-12-31T23:59:59.999Z"`, not `NULL`; confirmed against SQLite `TEXT` /
  Postgres `TIMESTAMPTZ` storage and a PGlite range-read check. Contract requires
  canonical UTC-ISO text timestamps; validator rejects noncanonical + `>=
  RECORDED_MAX`.
- **`StoreView`: decided** — read-only; `findFrom`/`findTo` in scope; `search`
  out of scope (refuses on a non-`current` pin). Endpoint parity also brings
  `findByEndpoints` into the valid-time view surface.
- **Recorded view: decided** — `asOfRecorded` returns a narrow
  `RecordedStoreView`, not the broad `StoreView`. It exposes `query`,
  `subgraph`, `reachable`, `canReach`, `shortestPath`, `degree`, and point
  `getById` / `getByIds` collections only. Direct collection scans, endpoint
  reads, and search are absent from the type and refused at runtime.
- **Bitemporal constructor: decided** — `store.asOfRecorded(T)` is diagonal
  sugar; `store.asOf(validT).asOfRecorded(recordedT)` is full bitemporal; the
  recorded view cannot widen back.
- **Capture collapse: decided** — capture reconciles at commit, persists the net
  transition only, and drops zero-width intermediates. Create-then-hardDelete in
  one transaction leaves zero rows; create-then-soft-delete leaves one tombstone
  row. The net `op` is derived from before/after state.
- **Recorded clock: decided** — built-in capture allocates a monotonic per-graph
  recorded commit timestamp from a locked high-water row. Valid time remains
  wall-clock.
- **External transaction capture: decided** — add
  `store.withRecordedTransaction(externalTx, fn)` for adopted transactions.
  Plain `withTransaction(externalTx)` refuses capture-bound writes because it
  has no commit flush point.
- **Binding API: decided** — explicit `recordedRelation({...})` descriptor is the
  primitive. The shipped form is `recordedRead: recordedRelation({ schema })`, a
  factory-branded schema-level read binding for row-compatible recorded
  relations. The target richer form is a graph/kind-scoped read-trust contract;
  `history: true` is sugar that enables capture + auto-binds; backend capability
  is a bind-time precondition only. Immutable at construction (runtime form
  returns a new store); unbound-kind reads refuse whole; double-bind errors. Name
  is `recordedRelation` over `bindRecordedRelation` because the primitive is a
  pure descriptor evaluated at store construction. Capture and read binding stay
  separate options because capture owns writer/audit/retention behavior, while a
  recorded binding only names a read-trust relation.

### Consequences

- `ReadCoordinate` gains a sibling recorded axis; `recordedAsOf` stays out of
  public `QueryOptions` and flows through an internal read-params shape.
- Query builder state, `QueryAst`, compile options, prepared queries, aggregate
  queries, and union/set-operation paths all carry the recorded coordinate.
- The query compiler, recursive compiler, subgraph, and algorithms use a shared
  read-source resolver instead of scattered table swaps.
- Recorded point reads route through the compiler/read-source path and remap
  results to live `getByIds` ordering/duplicate/chunking behavior.
- Built-in capture adds the monotonic high-water table and commit-boundary
  reconciliation wrappers for store-owned and adopted transactions.
- `/tms` retraction stays a belief-transition populator over the same relation,
  reading current beliefs through the existing `currencyPredicate` seam — no
  change to its contract.
