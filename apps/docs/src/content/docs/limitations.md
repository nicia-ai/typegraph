---
title: Limitations
description: Known constraints and backend-specific limitations
---

This page documents TypeGraph's known limitations and constraints.

## Backends Without Atomic Transactions

Some runtimes cannot hold a multi-statement database session and therefore
cannot offer atomic transactions:

- **Cloudflare D1** — the D1 binding has no interactive transaction
  primitive (`D1Database.batch(...)` is transactional but batch-only).
- **`drizzle-orm/neon-http`** — Neon's HTTP driver issues each statement as
  an independent request; there is no session to bind a transaction to.

Cloudflare **Durable Objects** SQLite is *not* in this list: a store backed
by `drizzle(ctx.storage)` is auto-detected as `transactionMode: "do-sqlite"`,
reports `capabilities.execution.interactiveTransactions: true`, and is fully atomic. An
`AdapterStore` created from that backend also exposes the adapter-only
`store.withTransaction` and `tx.sql` surfaces. See
[Backend Setup](/backend-setup#cloudflare-durable-objects-sqlite).

These backends report `capabilities.execution.interactiveTransactions: false`. Read-only
`store.batch(...)` still runs, but each query may use an independent connection
and observe a different database snapshot. (Whether the queries nonetheless
reuse one connection is up to the adapter — the no-transaction path hands each
query the same backend object.) Note this is a difference of degree, not of
kind: on PostgreSQL, `batch()`'s implicit transaction runs at the default
read-committed isolation, so queries there can also observe interleaved commits.

Write behavior depends on how the Store was constructed. A schema-managed Store
fails closed for writes that need the transaction-scoped schema or constraint
fence, but eligible plain node batches and `cardinality: "many"` edges can use
the authoritative one-statement command. A raw `createStore()` /
`createAdapterStore()` without a reconciled snapshot still has no interactive
transaction boundary. `store.transaction(fn)` refuses with a typed capability
error rather than pretending to provide rollback; direct backend writes remain
raw. Eligible operations that use a certified atomic SQL program can still be
available on these roots, but that transport guarantee is separate from the
interactive transaction capability.

These backends cannot honor the `isolationLevel` option on
`store.transaction(...)`; the method refuses before invoking its callback, so
the collection-read snapshot recipe documented elsewhere does not apply here.

```typescript
// On a raw D1 / neon-http Store, this refuses before the callback runs.
await store.transaction(async (tx) => {
  await tx.nodes.Person.create({ name: "Alice" });
});
```

**If you require atomicity or schema-version fencing, branch on the capability:**

```typescript
if (store.capabilities.execution.interactiveTransactions) {
  await store.transaction(async (tx) => {
    /* atomic */
  });
} else {
  // Use independent operations, or a supported certified atomic operation.
  const person = await store.nodes.Person.create({ name: "Alice" });
  const company = await store.nodes.Company.create({ name: "Acme" });
  await store.edges.worksAt.create(person, company, { role: "Engineer" });
}
```

If you need atomic writes from an edge runtime, use
`drizzle-orm/neon-serverless` (WebSocket-backed Pool) instead of
`drizzle-orm/neon-http`.

### Four kinds of write atomicity

TypeGraph distinguishes an interactive transaction, a static adapter batch, a
certified atomic SQL program, and an authoritative one-statement command. `store.transaction(...)` is the
interactive Store API: it pins a session and groups the callback's operations.
A static batch is adapter-internal (such as D1 `batch()` or a multi-row
insert); it is not a public Store transaction and cannot make arbitrary Store
calls atomic. A certified atomic SQL program is a closed ordered statement
sequence whose transport preserves result slots and parameters and rolls back
primary and sidecar writes when a later statement fails. An authoritative command is a single `commands.execute` write
whose database statement returns the decision it made. It can provide a safe
transactionless create/found path only when the backend has a durable arbiter.

Operational Identity, single-edge claim/cardinality enforcement, and any
undeclared dynamic `matchOn` convergence that may write still require an
interactive transaction and fail closed on a backend that cannot provide one.
An all-live `ifExists: "return"` endpoint batch is read-only and can return
from its set-oriented root read without a transaction. Eligible
direct edge batches on bundled roots are the narrow exception: their closed
native program carries the claim sidecars inside one atomic exchange. A
declared edge `matchIdentity` persists
a canonical endpoint/property key and has a unique database arbiter; eligible
root `getOrCreateByEndpoints` calls can therefore use the authoritative
one-statement command. The durable identity does not make unrelated Store
operations, claims, or history/revision side effects transactionless.

## libsql Single-Connection Transactions

For local `@libsql/client` connections (`file:` paths and `file::memory:`),
`createLibsqlBackend` frames transactions with raw `BEGIN IMMEDIATE`/`COMMIT`
statements on the client's single stable connection. It deliberately avoids
`client.transaction()`, which hands the client's connection to the transaction
and lazily opens a new one afterwards — for an in-memory database that new
connection is a fresh, empty database
([tursodatabase/libsql-client-ts#229](https://github.com/tursodatabase/libsql-client-ts/issues/229)).
In-memory databases therefore work for all operations, including transactions.
Remote Turso connections (`libsql://`, `http(s)://`) run each transaction on
its own stream via the driver.

The trade-off of a single connection: a store-level operation awaited from
**inside** a `store.transaction` callback (on the root store, rather than the
`tx` context) can never run — the open transaction occupies the backend's
serialized execution slot until it completes — so the backend rejects it with
a `ConfigurationError` instead of deadlocking.

```typescript
// ✅ In-memory works, including transactions
const client = createClient({ url: "file::memory:" });

// ❌ Root-store access inside a transaction callback throws
await store.transaction(async (tx) => {
  await store.nodes.Person.find(); // ConfigurationError — use tx.nodes
  await tx.nodes.Person.find(); // ✅ transaction-scoped access
});
```

## Recursive Traversal Depth

Variable-length traversals use two caps:

1. Unbounded traversals (no `maxHops` option) are capped at 10 hops.
2. Explicit `maxHops` values are validated up to 1000 hops (`maxHops: >1000` throws).
3. Cycle prevention is on by default. To skip cycle checks for speed, opt into
   `cyclePolicy: "allow"` (which may revisit nodes across hops).

This prevents runaway queries while still supporting deep, intentionally bounded traversals.

```typescript
// Implicitly limited to 10 hops
store
  .query()
  .from("Person", "p")
  .traverse("reportsTo", "e")
  .recursive()
  .to("Person", "manager");

// Explicit limits up to 1000 are honored
store
  .query()
  .from("Person", "p")
  .traverse("reportsTo", "e")
  .recursive({ maxHops: 200 }) // honored
  .to("Person", "manager");

// Explicit limits above 1000 throw
store
  .query()
  .from("Person", "p")
  .traverse("reportsTo", "e")
  .recursive({ maxHops: 2000 }) // throws
  .to("Person", "manager");
```

The unbounded-traversal limit is defined as `MAX_RECURSIVE_DEPTH`:

```typescript
import { MAX_RECURSIVE_DEPTH } from "@nicia-ai/typegraph";
// MAX_RECURSIVE_DEPTH = 10
```

## Connection Management

Managed Store factories own their local SQLite or PGlite connection, and their
`store.close()` method releases it. The local backend factories
`createLocalSqliteBackend` and `createLocalPgliteBackend` likewise expose an
owned backend whose `close()` releases its resources.

Bring-your-own adapter factories leave connection ownership with you. For
`createSqliteBackend`, `createPostgresBackend`, and `createLibsqlBackend`, you
are responsible for:

1. **Creating and configuring** the database connection
2. **Implementing connection pooling** for production use
3. **Closing connections** when done

```typescript
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createSqliteBackend, generateSqliteMigrationSQL } from "@nicia-ai/typegraph/adapters/drizzle/sqlite";

// You manage the connection
const sqlite = new Database("app.db");
sqlite.exec(generateSqliteMigrationSQL());
const db = drizzle(sqlite);

const backend = createSqliteBackend(db);
const store = createStore(graph, backend);

// You close the connection
sqlite.close();
```

For production deployments, use connection pooling:

```typescript
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { createPostgresBackend } from "@nicia-ai/typegraph/adapters/drizzle/postgres";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20, // Maximum connections
});

const db = drizzle(pool);
const backend = createPostgresBackend(db);
```

In the bring-your-own example above, `store.close()` leaves the supplied driver
open. Close that driver or pool through its own API.

## Predicate Serialization

Where predicates in unique constraints cannot be serialized. If you use schema
serialization for versioning or migration, predicates are stored as
`"[predicate]"` and cannot be reconstructed.

```typescript
// This predicate works at runtime...
unique({
  name: "email_unique_when_active",
  fields: ["email"],
  where: (props) => props.status.isNotNull(),
});

// ...but serializes as:
// { "where": "[predicate]" }
```

**Workaround:** For full schema serialization support, avoid predicates in unique constraints.
Use application-level validation instead.

## Vector Search Backend Requirements

Vector and hybrid search work across all primary backends via a pluggable
`VectorStrategy`. Each backend advertises its capabilities through
`backend.capabilities.vector` (`{ supported, metrics, indexTypes, maxDimensions }`):

| Backend | Requirement | Metrics |
|---------|-------------|---------|
| PostgreSQL | pgvector extension (HNSW / IVFFlat) | cosine, l2, inner_product |
| SQLite | sqlite-vec extension (`vec0` KNN) | cosine, l2 |
| libSQL / Turso | built-in native engine (DiskANN); nothing to load | cosine, l2 |
| D1 | Not supported | — |

Note that `inner_product` is PostgreSQL-only — sqlite-vec and libSQL support
cosine and l2 only.

Using vector predicates on unsupported backends throws `UnsupportedPredicateError`:

```typescript
try {
  await store
    .query()
    .from("Document", "d")
    .whereNode("d", (d) => d.embedding.similarTo(queryVector, 10))
    .execute();
} catch (error) {
  if (error instanceof UnsupportedPredicateError) {
    // Vector search not available on this backend
  }
}
```

## Query Builder Type Inference

Complex query chains may occasionally require explicit type annotations when TypeScript cannot
infer the full type. This is rare but can occur with deeply nested selects or unions.

```typescript
// If type inference fails, add explicit type
const results = await store
  .query()
  .from("Person", "p")
  .select((ctx) => ({
    name: ctx.p.name as string,  // Explicit annotation
  }))
  .execute();
```

## Bulk Operation Limits

Bulk operations (`bulkCreate`, `bulkInsert`, `bulkUpsertById`, `bulkDelete`) have practical limits based on your database:

| Database | Recommended Batch Size |
|----------|----------------------|
| SQLite | 500-1000 items |
| PostgreSQL | 1000-5000 items |

For larger datasets, batch your operations:

```typescript
const BATCH_SIZE = 1000;

for (let i = 0; i < items.length; i += BATCH_SIZE) {
  const batch = items.slice(i, i + BATCH_SIZE);
  await store.nodes.Person.bulkCreate(batch);
}
```

### Native node bulk eligibility

Bundled Neon HTTP, Cloudflare D1, and libSQL roots can use one schema-fenced
native atomic exchange for plain schema-managed `nodes.bulkInsert()` and
`nodes.bulkCreate()` calls when the node has no claims, Operational Identity,
history, revision, or projections. If any batch member has a claim, every
claimed member must have exactly one `unique` constraint whose scope is the
literal `kind`, every input ID must be generated, and the backend's
claimed-member budget must accommodate the batch. Claim-free kinds may
participate in that generated-ID batch. IDs may otherwise be generated,
caller-supplied, or mixed only for the wholly claim-free shape, and
`bulkCreate()` returns rows in input order. This is an internal optimization,
not a general Store batch API. A
caller-supplied or mixed ID in a claimed batch, multiple unique constraints,
non-kind uniqueness scope, disjointness, projected or identity-enabled nodes,
history/revision tracking, missing schema-fence support, and other unsupported
shapes fail closed to the existing transaction or fallback behavior.

The transport inventory for the supported libSQL root records one client
`batch` submission and zero client `execute` calls for both generated-ID
claim-free batches and generated-ID batches with one same-kind uniqueness
claim. This is a measured submission count, not a wall-clock RTT benchmark;
fallback paths are intentionally not assigned a latency claim.

Direct `edges.bulkInsert()` and `edges.bulkCreate()` calls on those same roots
use one schema-fenced native exchange when history and revision capture are
disabled. Declared durable match identities and `one`, `unique`, or
`oneActive` cardinality are maintained inside that exchange; any endpoint,
identity, or cardinality refusal rolls the whole call back. Transaction-scoped
stores, derived backends, custom backends without the corresponding exact-root
semantic registration, and dynamic get-or-create convergence retain the
interactive path.

Direct edge `bulkDelete()` calls use the same exact-root exchange and refuse a
foreign-kind ID atomically. Plain node `bulkDelete()` qualifies when no unique,
disjointness, identity, projection, history, revision, cascade, or disconnect
work is owed; the program enforces `restrict` against live connected edges in
SQL. Other delete shapes retain their transaction path. `bulkUpsertById()`
remains a resolved mutation set because it must read and schema-validate a
database preimage before its writes are known. Bundled serverless roots can
submit an eligible distinct-ID, live-row resolved set as one native exchange
after that read. Update-only sets use a guarded update; sets containing both
fresh creates and updates include a terminal database assertion that rolls the
whole exchange back when any guarded postimage is absent. Repeated IDs,
resurrections, temporal changes, sidecars (including durable edge match
identity), history/revision capture, and caller transactions use the interactive
path. On D1's 100-parameter budget the native ceiling is 17 total node mutations
or 6 total edge mutations; larger batches return to the interactive path rather
than splitting the all-or-nothing guard across autocommit statements.

Eligible singleton `update()` and `delete()` calls reuse those same registered
families. Plain node updates, unconstrained non-durable-identity edge updates,
all direct edge deletes, and plain restricted node deletes remain two-exchange
operations—one authoritative read/gate and one atomic mutation—because
TypeGraph must validate merged update properties and must preserve the rule
that a missing delete fires no operation hooks. This removes explicit
transaction transport from the eligible shape; it does not turn sidecar,
temporal, captured, derived-backend, or caller-transaction writes into
autocommit operations.

### One `bulkUpsertById` batch cannot hand a constrained value between rows

`bulkUpsertById` applies items in order for the purpose of deciding each row's
final props, but it groups the writes: every create in the batch runs before
every update. A batch where one item **releases** a constrained value and a later
item **claims** it therefore fails, where the same operations applied one at a
time succeed.

- Nodes: releasing and re-claiming a `unique` constraint value in one batch
  throws `UniquenessError` — the claiming create is checked while the releasing
  row still reserves the value.
- Edges: ending the lone `oneActive` edge from a source while creating its
  replacement throws `CardinalityError`, for the same reason.

Bulk semantics are set-like, not scripted — a batch states the rows you want,
not an order to reach them in — so this is a stated limitation rather than a
pending fix. It always surfaces as a typed error, never as a dropped write.
Split the handoff across two batches (release, then claim), or apply the
conflicting items one at a time — as sequential `upsertById` calls for nodes,
and as `update` then `create` for edges, which have no single-item upsert. See
[Data Sync](/data-sync#one-batch-cannot-hand-a-unique-value-from-one-row-to-another)
for the worked example.

## Graph Analytics Limits

TypeGraph ships focused algorithms on `store.algorithms.*` — shortest path
(weighted and unweighted), reachability, k-hop neighborhoods, degree, exact
weakly connected components, deterministic label propagation, and
global/personalized PageRank. See
[Graph Algorithms](/graph-algorithms) for the full API.

The following heavier analytics are **not** provided:

- Modularity-optimizing community detection such as Leiden or Louvain
- Centrality measures beyond degree (betweenness, closeness, eigenvector)
- Strongly connected components
- Topological sort
- Graph partitioning

For these use cases, export your data via `.query().traverse()` or
`store.subgraph()` and use a specialized library such as
[graphology](https://graphology.github.io/) in memory, or move to a
dedicated graph database.

## Single Database Deployment

TypeGraph is designed for single-database deployments. It does not support:

- Distributed storage across multiple databases
- Sharding
- Cross-database queries
- Replication coordination

For distributed graph workloads, consider a dedicated graph database.

## Temporal Query Limitations

Temporal queries (`asOf`, `includeEnded`) work correctly but have some constraints:

- Point-in-time queries cannot be combined with streaming (`.stream()`)
- `validFrom` defaults to the record's own creation timestamp when omitted, so `asOf` queries
  work out of the box; an end boundary still requires an explicit `validTo` — an open `validTo`
  means "still valid". A record written with a `validTo` at or before its own creation instant
  is "born already ended" and stores no lower bound instead, so it reads back at every `asOf`
  before that end
- Rows an **older library version** stored with a backwards window
  (`valid_from > valid_to`) are readable at no coordinate, and upgrading does not rewrite
  them. Making them observable is an explicit operator action: run
  `repairInvertedValidityWindows({ relations: "live-and-recorded", mode: "apply" })` while
  writers are stopped, then re-baseline any outstanding merge branches. See
  [Repairing inverted validity windows](/schema-management#repairing-inverted-validity-windows)
- Clock skew between application servers can affect temporal accuracy

### Recorded / system time (`history: true`)

Recorded-time capture (`createStore(graph, backend, { history: true })`) and
`store.asOfRecorded(T)` add a second temporal axis with these constraints. Use
`createAdapterStore(..., { history: true })` instead when the application must
adopt a caller-owned transaction:

- **Opt-in, no backfill.** Capture only sees changes committed after it is
  enabled; an entity that already exists is first recorded the next time it is
  written. Enable it on a fresh graph for complete history.
- **TypeGraph-write capture.** Built-in capture records TypeGraph collection
  writes only. Out-of-band database writes and row-returning raw SQL paths are
  not captured into the recorded relations.
- **Reconstructing reads only.** A recorded view exposes point reads
  (`getById` / `getByIds`), bounded deterministic `scan()` pages, `query()`,
  `subgraph()`, and the graph algorithms. Broad filtered collection reads
  (`find` / `count` / `findFrom`), `search`, and fulltext / vector predicates are
  refused — those indexes reflect current state and cannot answer a
  recorded-time query.
- **Transactional backend required.** Capture needs a backend with atomic
  transactions and statement execution — the built-in SQLite / PostgreSQL
  backends qualify. A custom backend must implement `executeStatement` (optional
  on the `GraphBackend` interface, but required once `history: true` is set) or
  enabling capture throws a `ConfigurationError` at write time. On an
  `AdapterHistoryStore`, raw `tx.sql` is disabled under `history: true`; adopt
  external transactions with `store.withRecordedTransaction(...)` instead of
  `store.withTransaction(...)` (which is a compile error on a history store).
- **Reconstruction cost.** Recorded reads rebuild from the history relations and
  are slower than live reads, most noticeably for full-graph subgraph /
  algorithm reconstructions on PostgreSQL.
- **PostgreSQL capture requires `READ COMMITTED`.** Every captured commit
  advances a single recorded-clock row for the graph. TypeGraph refuses
  PostgreSQL `REPEATABLE READ` / `SERIALIZABLE` history-capture transactions
  because snapshot isolation cannot safely allocate that per-graph recorded
  clock inside the captured transaction. Omit the transaction isolation option,
  or set it to `read_committed`.
- **Recorded anchors are per graph.** Each captured transaction advances a
  fixed-width logical revision and pairs it with a non-decreasing physical
  wall-time high-water mark. TypeGraph does not provide a cross-graph recorded
  anchor. See
  [Logical revision and physical time](/queries/temporal#logical-revision-and-physical-time).
- **The preview schema needs an offline migration.** Timestamp-only anchors and
  PostgreSQL recorded relations using `timestamptz` predate numeric recorded
  revisions and the `r1:<revision>:<timestamp>` API encoding. Run
  `migrateLegacyRecordedTime()` while writers are stopped, then use
  `migrateRecordedAnchor()` for checkpoints held outside TypeGraph. See
  [Migrating preview recorded time](/schema-management#migrating-preview-recorded-time).

## Schema Migration Constraints

Automatic migrations (`createStoreWithSchema`) only handle additive changes:

| Change Type | Auto-Migrated |
|-------------|---------------|
| Add new node type | Yes |
| Add new edge type | Yes |
| Add optional property | Yes |
| Add required property | No |
| Remove property | No |
| Rename type | No |
| Change property type | No |

Breaking changes throw `MigrationError` and require manual migration.
