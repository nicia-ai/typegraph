---
title: Temporal
description: Time-based queries with temporal()
---

TypeGraph tracks temporal validity for all nodes and edges. Use temporal queries to view the graph
at a point in time, audit changes, or access historical data.

## Temporal Modes

The `temporal()` method controls which versions of data are returned:

| Mode | Description |
|------|-------------|
| `"current"` | Only currently valid data (default behavior) |
| `"asOf"` | Data as it existed at a specific timestamp |
| `"includeEnded"` | All versions, including historical |
| `"includeTombstones"` | All versions, including soft-deleted |

## Current State (Default)

By default, queries return only currently valid, non-deleted data:

```typescript
// Returns only current, non-deleted nodes
const currentPeople = await store
  .query()
  .from("Person", "p")
  .select((ctx) => ctx.p)
  .execute();
```

This is equivalent to:

```typescript
.temporal("current")
```

## Point-in-Time Queries (asOf)

Query the graph as it existed at a specific moment:

```typescript
const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

const pastState = await store
  .query()
  .from("Article", "a")
  .temporal("asOf", yesterday)
  .whereNode("a", (a) => a.id.eq(articleId))
  .select((ctx) => ctx.a)
  .execute();
```

This returns nodes and edges that were valid at the specified timestamp, even if they've since been updated or deleted.

### Use Cases for asOf

- **Auditing**: See what data looked like at a specific time
- **Debugging**: Reproduce issues by querying historical state
- **Compliance**: Generate point-in-time reports
- **Recovery**: Find old values before an erroneous update

```typescript
// What did the user's profile look like last week?
const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

const historicalProfile = await store
  .query()
  .from("User", "u")
  .temporal("asOf", lastWeek)
  .whereNode("u", (u) => u.id.eq(userId))
  .select((ctx) => ctx.u)
  .first();
```

## Shared-Coordinate Views (store.asOf)

`.temporal("asOf", T)` pins a single query. When several reads should share one
temporal coordinate, pin it once with `store.asOf(T)` and reuse the returned
**read-only view** — TypeGraph's as-of database value, in the style of Datomic
`(d/as-of db t)` and SQL:2011 `FOR SYSTEM_TIME AS OF`.

```typescript
const past = store.asOf("2024-01-01T00:00:00.000Z");

// Every read on `past` observes the graph as it was valid at that instant.
const alice = await past.nodes.Person.getById(aliceId);
const jobs = await past.edges.worksAt.findFrom(alice);
const peers = await past.reachable(aliceId, { edges: ["knows"] });
const team = await past.subgraph(aliceId, { edges: ["reportsTo"] });

const names = await past
  .query()
  .from("Person", "p")
  .whereNode("p", (p) => p.department.eq("Engineering"))
  .select((ctx) => ctx.p.name)
  .execute();
```

The view pins the `nodes` / `edges` collections (`getById`, `getByIds`, `find`,
`count`, `findFrom`, `findTo`), `query()`, `subgraph()`, and the graph
algorithms (`reachable`, `canReach`, `shortestPath`, `neighbors`, `degree`).

For the other modes, use `store.view({ mode, asOf })`:

```typescript
// A view over every version, including soft-deleted ones.
const audit = store.view({ mode: "includeTombstones" });
const everyVersion = await audit.nodes.Document.find();
```

A view is **read-only**: writes stay on the live `store`, and a view collection
rejects `create` / `update` / `delete` with a `ConfigurationError`. `search` is
refused on a non-`"current"` view (the fulltext / vector index reflects current
state only). `asOf` must be a canonical UTC ISO-8601 timestamp
(`YYYY-MM-DDTHH:mm:ss.sssZ`).

See the [`store.asOf` / `store.view`
reference](/schemas-stores#temporal-views-storeasof-and-storeview) for the full
surface.

## Recorded Time (Bitemporal)

The modes above query **valid time** — *when a fact was true in the world*
(`validFrom` / `validTo`). Recorded time (also called **system time**) is the
second axis — *when a fact was recorded by TypeGraph*. With the built-in
captured relation, TypeGraph can run **bitemporal graph reads** for
TypeGraph-managed writes: you can ask "what did TypeGraph reconstruct as true,
as of a captured commit instant?" — including seeing values that were later
corrected.

Recorded-time capture is **opt-in** per store, because it writes a history row
for every committed TypeGraph collection change:

```typescript
const store = createStore(graph, backend, { history: true });
```

With `history: true`, every committed TypeGraph node/edge write is captured into
recorded-time relations (`typegraph_recorded_nodes` /
`typegraph_recorded_edges`) stamped with a per-graph monotonic commit instant.
Enable it on a **fresh graph**: there is no backfill, so an entity that already
exists is first recorded the next time it is written through TypeGraph. Capture
requires a transactional backend with statement execution (the built-in SQLite /
PostgreSQL backends).

Advanced hosts can bind an already-populated recorded relation for reads without
using TypeGraph's writer wrapper:

```typescript
import { createSqlSchema, recordedRelation } from "@nicia-ai/typegraph";

const recordedRead = recordedRelation({
  schema: createSqlSchema({
    recordedNodes: "audit_nodes",
    recordedEdges: "audit_edges",
  }),
});

const store = createStore(graph, backend, { recordedRead });
```

That option only supplies the read source for `asOfRecorded(T)` reconstruction.
It does not capture writes, advance TypeGraph's recorded clock, or make
`store.recordedNow()` available. If TypeGraph should own capture, use
`history: true`. `recordedRead` must be created by `recordedRelation({ schema })`
with a `createSqlSchema(...)` schema; the store validates those factory
descriptors at runtime and rejects combining them with `history: true`.

### Reading at a recorded instant

`store.asOfRecorded(T)` reconstructs the graph as TypeGraph recorded it at
instant `T`. `T` is a `RecordedInstant` — a branded canonical timestamp that
originates from `store.recordedNow()` (below) or, for an event time you already
hold, from `asRecordedInstant(...)`:

```typescript
import { asRecordedInstant } from "@nicia-ai/typegraph";

const recorded = store.asOfRecorded(
  asRecordedInstant("2024-06-01T12:00:00.000Z"),
);

const doc = await recorded.nodes.Document.getById(docId);
const cited = await recorded.edges.cites.getByIds(citationIds);
const reachable = await recorded.reachable(docId, { edges: ["cites"] });
```

A raw wall-clock string — `store.asOfRecorded(new Date().toISOString())` — does
**not** type-check, by design. Recorded instants are monotonic and can briefly
run ahead of wall-clock time under bursty writes, so a wall-clock value may sort
*before* the most recent commits and silently omit them. The brand turns that
footgun into a compile error: to pin "as things stand right now"
deterministically, use `store.recordedNow()` (the recorded high-water mark),
then guard the `undefined` case before passing it to `store.asOfRecorded()`.

```typescript
await store.nodes.Document.update(docId, { title: "Revised" });
const checkpoint = await store.recordedNow(); // a stable anchor for this state
if (checkpoint === undefined) throw new Error("expected a recorded checkpoint");
// ...later, however much the graph has changed:
const asOfCheckpoint = store.asOfRecorded(checkpoint);
```

`recordedNow()` is **graph-global**, not scoped to any one caller or write. It is
the single high-water mark for the whole graph, advanced by *every* committed
capture from *any* writer. So a change in `recordedNow()` across two reads means
"something committed to this graph in between" — **not** "the write I just made
landed." Do not use a `recordedNow()` advance as a per-writer "did my write
succeed?" signal: under any concurrent writer to the same graph it both misses
dropped writes (another writer moved the clock) and misfires on no-op writes. To
confirm a specific write committed, observe the write itself (e.g. its return
value, or run it inside `store.transaction(...)` and act on success), not the
global clock.

Direct `store.asOfRecorded(T)` is **diagonal** bitemporal sugar: it reads the
recorded relation as of `T` *and* uses the same `T` for the valid-time axis. To
pin the two axes independently — *what was valid at one instant, as TypeGraph
captured it at another* — chain from a valid-time view:

```typescript
// The state valid on Jan 1, as TypeGraph recorded it on Jun 1
// (e.g. after a correction was entered later).
const corrected = store
  .asOf("2024-01-01T00:00:00.000Z")
  .asOfRecorded(asRecordedInstant("2024-06-01T12:00:00.000Z"));

const asKnownThen = await corrected.nodes.Invoice.getById(invoiceId);
```

`store.view({ mode }).asOfRecorded(T)` composes recorded time with any
valid-time mode — e.g. `includeTombstones` to reconstruct soft-deleted rows at a
recorded instant.

### The recorded view surface

A `RecordedStoreView` is a **narrow, reconstructing** read lens. It exposes only
reads that can be faithfully rebuilt from the recorded relations:

- **Point reads** — `nodes.<Kind>.getById` / `getByIds`, and the edge equivalents
- **`query()`** — a sealed query builder over the recorded relations
- **`subgraph()`** and the graph algorithms — `reachable`, `canReach`,
  `shortestPath`, `degree`

Broad collection reads (`find` / `count` / `findFrom` / …), `search`, and
fulltext / vector predicates are **refused** with a `ConfigurationError` /
`UnsupportedPredicateError`: the fulltext and vector indexes reflect *current*
state only, so they cannot answer a recorded-time question. `T` must be a
canonical UTC ISO-8601 timestamp (`YYYY-MM-DDTHH:mm:ss.sssZ`).

### Writing with history enabled

Capture flushes at transaction commit, so writes must go through the store's
typed collections — use `store.transaction(...)` as usual:

```typescript
await store.transaction(async (tx) => {
  await tx.nodes.Document.create({ title: "Draft" });
});
```

#### Raw SQL under history capture

Raw `tx.sql` is disabled under `history: true` (raw SQL would bypass capture),
and `store.withTransaction(externalTx)` is replaced by the callback form
`store.withRecordedTransaction(externalTx, async (tx) => { ... })`, which gives
capture a flush point before your transaction commits. Out-of-band database
writes and row-returning raw SQL paths are not audited by the built-in capture
wrapper; use TypeGraph collection writes when the recorded relation is the
source of truth.

`store.withTransaction` on a history-enabled store is a **compile error** (the
`externalTx` argument is rejected with a message naming
`withRecordedTransaction`); the runtime guard still throws `ConfigurationError`
if suppressed. Inside `store.transaction(...)`, `tx.sql` is present but throwing:
its static type is `sql?: never`, and `tx.sqlAvailability` reports `"history"`
(or `"revisionTracking"`) so portable code can branch without touching the
throwing handle — see the `tx.sqlAvailability` guidance in
[Cross-Store Transactions](/recipes/).
Both guards carry a branchable `details.code`; see
[Recorded-capture guard codes](/errors/#recorded-capture-guard-codes).

To write your own relational tables atomically with graph writes on a history
store, pass your transaction handle to `withRecordedTransaction` and write your
tables through **that** handle (not `tx.sql`):

```typescript
await db.transaction(async (pgTx) => {
  const { receipt } = await store.withRecordedTransaction(pgTx, async (tx) => {
    await tx.nodes.Document.update(documentId, props); // graph write
  });
  await pgTx.insert(streamCursors).values(cursorRow);   // your own table
}); // one COMMIT / ROLLBACK across both layers
```

`withRecordedTransaction` returns a
[`TransactionOutcome<T>`](/schemas-stores/#transaction-receipts): destructure
`{ result, receipt }`. `receipt.writes` counts the graph writes (drop
detection) and `receipt.recorded` is this transaction's recorded commit instant
— the per-transaction replay anchor. When the callback runs user code that also
bookkeeps, scope a sub-receipt with `tx.measure((scoped) => ...)`: writes through
the `scoped` context are attributed to the sub-receipt, while the surrounding
bookkeeping written through `tx` is not.

This is separate from `recordedRead`: a store created with a `recordedRead`
binding can reconstruct from a relation populated by another system, but
TypeGraph is not responsible for making that relation complete or atomic with
live writes.

#### Write cost: batch under `history: true`

Each **un-batched** write under `history: true` becomes its own transaction —
it allocates a recorded commit instant under a per-graph clock lock and flushes
one history row at commit. So a tight loop of single `create`/`update`/`delete`
calls pays that fixed cost once per call. Wrapping the same writes in one
`store.transaction(...)` allocates **one** recorded instant for the whole batch
and amortizes the overhead to roughly nothing.

Measured per-op latency, identical workload with capture off vs on (history
off → on; N = 400; reproduce with
`pnpm --filter @nicia-ai/typegraph-benchmarks bench:recorded-write`):

| Workload                       | SQLite | PostgreSQL |
| ------------------------------ | -----: | ---------: |
| create — un-batched (per op)   |  ~2.5× |      ~5.5× |
| create — **batched in one txn** |  ~1.5× |      ~1.0× |
| update — un-batched (per op)   |  ~2.8× |      ~6× |
| soft delete — un-batched       |  ~1.7× |      ~1.9× |

The takeaway: capture is opt-in and cheap when you batch. Under `history: true`,
prefer `store.transaction(...)` for bulk writes; a loop of individual
collection writes is the one pattern that pays the per-write multiple. (Stores
created without `history: true` are unaffected — graph writes never touch the
capture path.)

> **Performance.** Recorded reads reconstruct from the history relations rather
> than the live tables, so they are slower than current-state reads — most
> noticeably for full-graph `subgraph` / algorithm reconstructions on
> PostgreSQL. Reach for `asOfRecorded` for audit and point-in-time
> reconstruction, not hot-path reads.

## Including Historical Data (includeEnded)

View all versions, including superseded records:

```typescript
const history = await store
  .query()
  .from("Article", "a")
  .temporal("includeEnded")
  .whereNode("a", (a) => a.id.eq(articleId))
  .orderBy((ctx) => ctx.a.validFrom, "desc")
  .select((ctx) => ({
    title: ctx.a.title,
    validFrom: ctx.a.validFrom,
    validTo: ctx.a.validTo,
    version: ctx.a.version,
  }))
  .execute();

// Result shows all versions:
// [
//   { title: "Final Title", validFrom: "2024-03-01", validTo: undefined, version: 3 },
//   { title: "Draft v2", validFrom: "2024-02-15", validTo: "2024-03-01", version: 2 },
//   { title: "Initial Draft", validFrom: "2024-02-01", validTo: "2024-02-15", version: 1 },
// ]
```

### Audit Trail

Build a complete change history:

```typescript
async function getAuditTrail(nodeId: string) {
  return store
    .query()
    .from("Document", "d")
    .temporal("includeEnded")
    .whereNode("d", (d) => d.id.eq(nodeId))
    .select((ctx) => ({
      version: ctx.d.version,
      title: ctx.d.title,
      status: ctx.d.status,
      validFrom: ctx.d.validFrom,
      validTo: ctx.d.validTo,
      updatedAt: ctx.d.updatedAt,
    }))
    .orderBy("d", "version", "asc")
    .execute();
}
```

## Including Soft-Deleted Data (includeTombstones)

Include records that have been soft-deleted:

```typescript
const allIncludingDeleted = await store
  .query()
  .from("User", "u")
  .temporal("includeTombstones")
  .select((ctx) => ({
    id: ctx.u.id,
    name: ctx.u.name,
    deletedAt: ctx.u.deletedAt,  // Will have a value for deleted records
  }))
  .execute();
```

### Filtering Deleted Records

```typescript
// Find only deleted records
const deletedUsers = await store
  .query()
  .from("User", "u")
  .temporal("includeTombstones")
  .whereNode("u", (u) => u.deletedAt.isNotNull())
  .select((ctx) => ({
    id: ctx.u.id,
    name: ctx.u.name,
    deletedAt: ctx.u.deletedAt,
  }))
  .execute();
```

## Temporal Metadata Fields

When querying with temporal context, these fields are available:

| Field | Type | Description |
|-------|------|-------------|
| `validFrom` | `string \| undefined` | When this version became valid |
| `validTo` | `string \| undefined` | When this version was superseded (undefined if current) |
| `createdAt` | `string` | When the node was first created |
| `updatedAt` | `string` | When this version was written |
| `deletedAt` | `string \| undefined` | Soft-delete timestamp (undefined if not deleted) |
| `version` | `number` | Optimistic concurrency version number |

```typescript
.select((ctx) => ({
  ...ctx.a,                     // All node properties
  validFrom: ctx.a.validFrom,
  validTo: ctx.a.validTo,
  createdAt: ctx.a.createdAt,
  updatedAt: ctx.a.updatedAt,
  deletedAt: ctx.a.deletedAt,
  version: ctx.a.version,
}))
```

## Temporal Traversals

Temporal modes apply to traversals as well:

```typescript
// See who worked at a company last year
const lastYear = new Date("2023-01-01").toISOString();

const pastEmployees = await store
  .query()
  .from("Company", "c")
  .temporal("asOf", lastYear)
  .whereNode("c", (c) => c.name.eq("Acme Corp"))
  .traverse("worksAt", "e", { direction: "in" })
  .to("Person", "p")
  .select((ctx) => ({
    name: ctx.p.name,
    role: ctx.e.role,
  }))
  .execute();
```

`store.subgraph()` and `store.algorithms.*` accept the same `temporalMode`
and `asOf` options, defaulting to `graph.defaults.temporalMode`. See
[Temporal Behavior](/graph-algorithms#temporal-behavior) for the algorithm
surface and [`store.subgraph()` options](/schemas-stores#storesubgraphrootid-options)
for subgraph.

## Real-World Examples

### Version Comparison

Compare two versions of a document:

```typescript
async function compareVersions(docId: string, v1: number, v2: number) {
  const versions = await store
    .query()
    .from("Document", "d")
    .temporal("includeEnded")
    .whereNode("d", (d) => d.id.eq(docId))
    .select((ctx) => ctx.d)
    .execute();

  const version1 = versions.find((v) => v.version === v1);
  const version2 = versions.find((v) => v.version === v2);

  return { version1, version2 };
}
```

### Compliance Reporting

Generate a report as of a specific date:

```typescript
async function generateQuarterlyReport(quarterEnd: string) {
  const activeContracts = await store
    .query()
    .from("Contract", "c")
    .temporal("asOf", quarterEnd)
    .whereNode("c", (c) => c.status.eq("active"))
    .traverse("belongsTo", "e")
    .to("Customer", "cust")
    .select((ctx) => ({
      contractId: ctx.c.id,
      value: ctx.c.value,
      customer: ctx.cust.name,
    }))
    .execute();

  return {
    asOf: quarterEnd,
    totalContracts: activeContracts.length,
    totalValue: activeContracts.reduce((sum, c) => sum + c.value, 0),
    contracts: activeContracts,
  };
}
```

### Undo/Recovery

Find the previous value before an update:

```typescript
async function getPreviousVersion(nodeId: string) {
  const versions = await store
    .query()
    .from("Document", "d")
    .temporal("includeEnded")
    .whereNode("d", (d) => d.id.eq(nodeId))
    .select((ctx) => ctx.d)
    .orderBy("d", "version", "desc")
    .limit(2)
    .execute();

  return {
    current: versions[0],
    previous: versions[1],
  };
}
```

## Next Steps

- [Filter](/queries/filter) - Filtering with predicates
- [Traverse](/queries/traverse) - Graph traversals
- [Execute](/queries/execute) - Running queries
- [Bitemporal Time Travel](/examples/bitemporal-time-travel) - Valid time plus
  recorded time in one runnable example
- [Agent Decision Replay](/examples/agent-decision-replay) - Reconstruct the
  exact graph an agent saw
- [Breach Forensics](/examples/breach-forensics) - Traverse a reconstructed
  access graph at the breach instant
