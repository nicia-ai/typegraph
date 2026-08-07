---
title: Troubleshooting
description: Solutions to common issues and frequently asked questions
---

This guide covers common issues and their solutions when working with TypeGraph.

## Installation Issues

### "Cannot find module '@nicia-ai/typegraph'"

**Cause:** Package not installed or using wrong package name.

**Solution:**

```bash
npm install @nicia-ai/typegraph zod drizzle-orm
```

### "better-sqlite3 compilation failed"

**Cause:** Native module compilation requires build tools.

**Solutions:**

**macOS:**

```bash
xcode-select --install
```

**Ubuntu/Debian:**

```bash
sudo apt-get install build-essential python3
```

**Windows:**

```bash
npm install --global windows-build-tools
```

**Alternative:** Use `sql.js` for pure JavaScript SQLite (no compilation needed).

### "Module not found: drizzle-orm/better-sqlite3"

**Cause:** Drizzle ORM subpath exports require specific import syntax.

**Solution:** Ensure correct imports:

```typescript
// Correct
import { drizzle } from "drizzle-orm/better-sqlite3";

// Incorrect
import { drizzle } from "drizzle-orm";
```

## Schema Definition Errors

### "Node schema contains reserved property names"

**Cause:** Using reserved keys (`id`, `kind`, `meta`) in your Zod schema.

**Solution:** Rename your properties:

```typescript
// Bad - 'id' is reserved
const User = defineNode("User", {
  schema: z.object({
    id: z.string(), // Error!
    name: z.string(),
  }),
});

// Good - use a different name
const User = defineNode("User", {
  schema: z.object({
    externalId: z.string(),
    name: z.string(),
  }),
});
```

TypeGraph automatically provides `id`, `kind`, and `meta` on all nodes.

### "Edge type already has constraints defined"

**Cause:** Defining `from`/`to` constraints on both the edge type and graph registration.

**Solution:** Define constraints in one place only:

```typescript
// Option 1: On the edge type (reusable across graphs)
const worksAt = defineEdge("worksAt", {
  from: [Person],
  to: [Company],
});

const graph = defineGraph({
  edges: {
    worksAt: { type: worksAt }, // No from/to here
  },
});

// Option 2: On the graph (flexible per-graph)
const worksAt = defineEdge("worksAt");

const graph = defineGraph({
  edges: {
    worksAt: { type: worksAt, from: [Person], to: [Company] },
  },
});
```

## Runtime Errors

### ValidationError: "Invalid input"

**Cause:** Data doesn't match the Zod schema.

**Solution:** Check the error details for specific issues:

```typescript
try {
  await store.nodes.Person.create({ name: "" });
} catch (error) {
  if (error instanceof ValidationError) {
    console.log(error.details.issues); // Zod issues array
  }
}
```

### NodeNotFoundError

**Cause:** Attempting to read/update/delete a non-existent node.

**Solution:** Check if the node exists first or handle the error:

```typescript
const node = await store.nodes.Person.getById(someId);
if (!node) {
  // Handle missing node
}

// Or use error handling
try {
  await store.nodes.Person.update(someId, { name: "New" });
} catch (error) {
  if (error instanceof NodeNotFoundError) {
    console.log(`Node ${error.details.id} not found`);
  }
}
```

### RestrictedDeleteError

**Cause:** Attempting to delete a node that has edges, with `onDelete: "restrict"` (the default).

**Solution:** Either delete the edges first or use a different delete behavior:

```typescript
// Option 1: Delete edges first. Include ended-but-not-deleted edges if you
// are cleaning up historical validity windows too.
const edges = await store.edges.worksAt.findFrom(person, {
  temporalMode: "includeEnded",
});
for (const edge of edges) {
  await store.edges.worksAt.delete(edge.id);
}
await store.nodes.Person.delete(person.id);

// Option 2: Use cascade delete in schema
const graph = defineGraph({
  nodes: {
    Person: { type: Person, onDelete: "cascade" },
  },
});
```

### DisjointError

**Cause:** Creating a node with an ID that's already used by a disjoint type.

**Solution:** Ensure IDs are unique across disjoint types or don't use explicit IDs:

```typescript
// If Person and Organization are disjoint:
// Bad - same ID for different types
await store.nodes.Person.create({ name: "Alice" }, { id: "entity-1" });
await store.nodes.Organization.create({ name: "Acme" }, { id: "entity-1" }); // Error!

// Good - let TypeGraph generate unique IDs
await store.nodes.Person.create({ name: "Alice" });
await store.nodes.Organization.create({ name: "Acme" });
```

## Query Issues

### "Alias 'x' is already in use"

**Cause:** Using the same alias twice in a query.

**Solution:** Use unique aliases:

```typescript
// Bad
store.query().from("Person", "p").traverse("knows", "e").to("Person", "p"); // Error! 'p' already used

// Good
store.query().from("Person", "p1").traverse("knows", "e").to("Person", "p2");
```

### Empty results when expecting data

**Causes and solutions:**

1. **Type mismatch:** Ensure you're querying the correct node type

   ```typescript
   // Check the node type name matches exactly
   .from("Person", "p") // Must match defineNode("Person", ...)
   ```

2. **Missing includeSubClasses:** When querying a superclass

   ```typescript
   .from("Content", "c", { includeSubClasses: true })
   ```

3. **Strict predicate:** Check your filters aren't too restrictive

   ```typescript
   // Debug by removing filters temporarily
   const all = await store
     .query()
     .from("Person", "p")
     .select((c) => c.p)
     .execute();
   console.log(all.length); // How many total?
   ```

### Slow queries

**Solutions:**

1. **Use the query profiler:**

   ```typescript
   import { QueryProfiler } from "@nicia-ai/typegraph/profiler";

   const profiler = new QueryProfiler();
   profiler.attachToStore(store);

   // Run your queries...

   const report = profiler.getReport();
   console.log(report.recommendations);
   ```

2. **Add indexes** based on profiler recommendations:

   ```typescript
   import { defineNodeIndex } from "@nicia-ai/typegraph/indexes";

   const nameIndex = defineNodeIndex(Person, { fields: ["name"] });
   ```

3. **Limit results:**

   ```typescript
   .limit(100)
   // Or use pagination
   .paginate({ first: 20 })
   ```

## Database Connection Issues

### "Database is locked" (SQLite)

**Cause:** Multiple processes accessing the same SQLite file without WAL mode.

**Solution:** Enable WAL mode:

```typescript
const sqlite = new Database("myapp.db");
sqlite.pragma("journal_mode = WAL");
```

### Connection pool exhausted (PostgreSQL)

**Cause:** Too many concurrent connections.

**Solution:** Configure pool limits:

```typescript
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20, // Adjust based on your needs
  idleTimeoutMillis: 30000,
});
```

### "relation 'typegraph_nodes' does not exist"

**Cause:** Migration not run.

**Solution:** Run the migration SQL:

```typescript
// PostgreSQL
import { generatePostgresMigrationSQL } from "@nicia-ai/typegraph/adapters/drizzle/postgres";
await pool.query(generatePostgresMigrationSQL());

// SQLite
import { generateSqliteMigrationSQL } from "@nicia-ai/typegraph/adapters/drizzle/sqlite";
sqlite.exec(generateSqliteMigrationSQL());
```

### "permission denied" / cannot create relation on boot

**Cause:** `createStoreWithSchema()` runs DDL on every cold boot
(bootstrap, safe auto-migrations, and the contribution-marker
`CREATE TABLE IF NOT EXISTS`). If it runs under a least-privilege,
DML-only database role, that DDL fails with a permission error.

**Solution:** Run schema/DDL changes as a privileged one-time migration
step, then attach at runtime with the zero-DDL
`createVerifiedStore()` (or `createStore()`) under the least-privilege
role. See
[Database roles & least privilege](/backend-setup#database-roles--least-privilege).

### `MigrationError` from `createVerifiedStore` / `assertSchemaCurrent`

**Cause:** The runtime is using a code graph whose schema is ahead of
the database. The least-privilege runtime cannot migrate — by design,
it fails fast so requests don't run against a stale schema.

**Solution:** Run `createStoreWithSchema(graph, adminBackend)` under
the privileged role before promoting the new runtime build (apply any
generated migration SQL first if you manage DDL externally), then
restart the runtime. The thrown `MigrationError.message` includes the
diff summary and migration actions to apply.

### `ConfigurationError`: "no schema has been initialized"

**Cause:** A verifying attach (`createVerifiedStore` /
`assertSchemaCurrent`) ran before any privileged
`createStoreWithSchema()` boot — the database has no `schema_versions`
row (or no typegraph tables at all). The runtime deliberately refuses
to bootstrap under a least-privilege role. **Note:** running only the
generated migration SQL is not sufficient — it creates the tables but
does not write the schema row or contribution markers.

**Solution:** Run `createStoreWithSchema(graph, adminBackend)` once
under the privileged role. If you manage DDL externally with
drizzle-kit / `generatePostgresMigrationSQL()` /
`generateSqliteMigrationSQL()`, apply that first, then still run
`createStoreWithSchema()` to commit the schema row and contribution
markers. See
[Database roles & least privilege](/backend-setup#database-roles--least-privilege).

### `StoreNotInitializedError` on the first operation

**Cause:** The store was created with `createStore()` (a zero-I/O attach
that never materializes runtime storage) against a database that no
`createStoreWithSchema()` boot has initialized — commonly the runtime
started before the privileged migration step ran, or the wrong role/
database is configured. This covers fulltext operations and **embedding
writes**: a `store.nodes.*.create({ embedding })` (or embedding
update/delete) against an un-provisioned per-`(kind, field)` table throws
here rather than lazily issuing `CREATE TABLE` on the hot path. Vector
*reads* — `store.search.vector`, `store.search.hybrid`, and a
query-builder `.similarTo()` predicate — compile straight to SQL against
the per-field table, so they surface the engine's own missing-relation
error instead (`no such table: tg_vec_…` on SQLite, `relation … does not
exist` on Postgres) — same cause, same solution.
`createVerifiedStore()` catches every one of these cases at boot rather
than at the first hot-path operation.

A **`stale`** variant of this error on a vector field means something
different: the storage exists but was provisioned at a different shape —
typically the field's declared dimension changed after the table was
created. Boot deliberately leaves such a slot untouched (with a console
warning); run `store.reembedVectorField(kind, fieldPath)` to recreate the
storage at the new shape and re-embed.

**Solution:** Run `createStoreWithSchema(graph, adminBackend)` once
under the privileged role before the runtime attaches (it writes the
contribution markers that `createStore` / `createVerifiedStore` only
check), and prefer `createVerifiedStore()` over bare `createStore()` so
drift fails fast. See
[Database roles & least privilege](/backend-setup#database-roles--least-privilege).

### `SCHEMA_WRITE_FENCE_UNSUPPORTED` on the first managed write

**Cause:** The Store carries committed schema metadata (for example, it came
from `createStoreWithSchema`, `createVerifiedStore`, an adapter equivalent, or a
cached `{ reconciled }` snapshot), but its backend cannot run transactions or
does not implement the schema-write fence. Common examples are Cloudflare D1,
`drizzle-orm/neon-http`, and incomplete custom backends. The attach can still
succeed for reads; writes fail closed rather than racing a schema change.

**Solution:** Use a transactional backend (`neon-serverless`, regular
PostgreSQL, SQLite with transactions, or Durable Objects SQLite). If raw,
unfenced writes are an explicit application decision, construct the Store with
`createStore()` / `createAdapterStore()` without `{ reconciled }` and quiesce
writers yourself around schema changes.

### The store opens clean but a fulltext or vector read fails

**Cause:** The durable contribution marker still says `initialized`
while the physical table it names is gone — a partial restore, a
hand-run `DROP`, or a schema-scoped restore that missed the
strategy-owned tables. Nothing on the open path probes the catalog:
boot and the runtime asserts short-circuit on a per-instance signature
cache and then on the marker row alone, which keeps the hot path free
of catalog round trips. The cost is that this database opens
completely clean and fails at the first read of the affected slot.

**Diagnosis:** `store.verifyContributions()` reports detected drift or a
recorded failed attempt among contributions currently expected by the active
graph and backend strategies. Each entry carries `owner`, `logicalName`,
`physicalName`, a `state`, and — for vector slots — `kind` and
`fieldPath`. When the marker recorded an error against its last
attempt, `lastError` carries it: `state` tells you which repair to run,
`lastError` tells you why it broke, which is often a different
question. The call is read-only — one existence query per contribution
table, no DDL and no writes — so it is safe on a live store under a
least-privilege role. It is deliberately **not** a boot step; call it
from a health check or an operator script.

**Solution:** Run `repairContributions()` on a Store backed by the privileged
DDL-capable connection:

```typescript
const result = await adminStore.repairContributions();

for (const entry of result.results) {
  if (entry.status === "failed") {
    console.error(entry.diagnostic, entry.error);
  }
  if (entry.status === "requires-rebuild") {
    console.warn("manual rebuild required", entry.diagnostic);
  }
}
```

The method performs its own fresh audit and resolves contribution declarations
from the committed graph and the active backend strategies. It never accepts a
diagnostic, physical table name, or DDL from the caller. A Store opened before
another writer evolved the graph catches up before enumerating vector slots
instead of repairing from its stale in-memory graph snapshot.

| `state` | Result | Data behavior |
| --- | --- | --- |
| `missing-marker` | `repaired` or `failed` | Runs idempotent DDL and re-stamps the marker; existing rows are preserved |
| `failed-materialization` | `repaired` or `failed` | Retries the current idempotent contribution DDL |
| `orphaned-marker` | `requires-rebuild` | The table and its data are already gone |
| `stale` | `requires-rebuild` | The stored physical shape does not match the current declaration |

`remaining` is a fresh post-repair diagnostic pass. An empty `remaining` array
means no current declaration remains unhealthy after the pass. Once it is
empty, a second call is idempotent and returns no results.

For a vector `requires-rebuild` entry, use
`reembedVectorField(kind, fieldPath, { embed })`. It drops and recreates the
slot, so pass an `embed` callback or the field comes back with zero embeddings.
For a fulltext `requires-rebuild` entry, use
`rebuildContribution("fulltext")` — the third rung of the ladder, described
below. Do not hand-edit the marker or run backend-owned DDL directly.

`repairContributions()` intentionally does not use the public diagnostic as an
instruction list and does not force marker writes. A warm backend re-reads the
marker, and the normal signature guard still refuses to bless stale storage.

**An empty result does not mean everything was checked.** The diagnostic
enumerates only current declarations. It ignores retired marker rows and treats
an expected contribution with neither marker nor table as never attempted, so
`[]` is not proof of initialization. A backend that cannot probe its own catalog
throws `ConfigurationError` rather than reporting a clean bill of health, but
vector slots on a backend without vector support are skipped silently and
correctly — that backend never materialized them, so reporting them would be a
false positive on every store it opens. For a readiness check, first attach with
`createVerifiedStore()` to establish schema and marker initialization, then run
this diagnostic. Also assert `backend.capabilities.vector?.supported` when
embedding storage is required rather than treating an empty array as proof that
it is intact.

### Contribution health: probe, repair, rebuild

The three contribution maintenance operations form one escalation ladder.
Each rung does strictly more, and costs strictly more, than the one below
it. Start at the top of this table and stop as soon as the projection is
`ready`.

| Rung | Call | Writes | Use when |
| --- | --- | --- | --- |
| 1. Probe | `store.probeContributions()` | Nothing | You want to know whether search is coherent right now. Safe on a read path, on a replica, and under a least-privilege role |
| 2. Repair | `store.repairContributions()` | Marker rows and idempotent `CREATE ... IF NOT EXISTS` | The probe reports `degraded` and `verifyContributions()` says `missing-marker` or `failed-materialization` — storage is intact and only the bookkeeping is wrong |
| 3. Rebuild | `store.rebuildContribution("fulltext")` | **Deletes and refills this graph's rows**; drops and recreates the shared storage only when no other graph has rows in it | `verifyContributions()` says `stale` or `orphaned-marker`, which repair reports as `requires-rebuild` |

**Rung 1 — the read-only probe.** One entry per search projection the
graph declares, so a caller can decide whether to issue a query without
running a write operation first:

```typescript
const health = await store.probeContributions();

for (const entry of health.entries) {
  if (entry.state !== "ready") {
    console.warn(`${entry.contribution} search is ${entry.state}`, entry.detail);
  }
}
```

`entries` is empty when there is nothing to assess — a graph with no
`searchable()` or `embedding()` fields, or a backend with no contribution
machinery. It is never empty because a check was skipped: a backend that
provisions contributions but cannot probe its catalog throws
`ConfigurationError`, and declares the gap as
`capabilities.contributions.probe === false`. Route on `state`; `detail`
is a human-readable summary and not a stable format, so call
`verifyContributions()` for the structured per-table findings behind it.

`graphRevision` stamps the durable revision the assessment was taken at,
placing the probe in the graph's committed history. It is graph-global
like the clock it reads: an advance between two probes means something
committed in between, not that a particular caller's write landed. It is
absent unless the Store is revision-tracked (`revisionTracking: true` or
`history: true`) and a tracked write has already anchored the clock. A
store with no revision clock has no revision to stamp, and substituting a
wall-clock timestamp or the schema version would be a weaker guarantee
wearing the name of a stronger one — the schema version in particular does
not advance on data writes, so it could not order anything.

`state: "building"` is reserved. No shipped path publishes it; the
destructive rebuild is atomic, so a concurrent probe observes the state
before or after it and never a partial one. Treat it as "not `ready`".

**Rung 3 — the destructive rebuild.** A `stale` fulltext contribution
means the table exists at the shape a *previous* `createDdl` produced. The
ordinary ensure path cannot fix it: its `CREATE ... IF NOT EXISTS` no-ops
against the existing table, and re-stamping the marker there would leave
it blessing storage whose shape is wrong — precisely what the drift guard
exists to prevent. Only a drop makes the recreate meaningful, so the drop
is its own named operation rather than a flag on the ensure path:

```typescript
const result = await adminStore.rebuildContribution("fulltext");
// { rebuilt: ["typegraph_node_fulltext"], processed, repopulated, skipped }
```

**Opening a Store to run it.** A `stale` contribution makes
`createStoreWithSchema()` refuse: its boot step materializes runtime
contributions, and the drift guard will not run the current DDL against a
table provisioned at another shape. That refusal is deliberate and
persistent — it repeats on every restart until the shape is fixed, and it
leaves the `stale` verdict intact rather than downgrading it to a state
whose repair would bless the wrong shape. Reach the rebuild from a Store
opened without that boot step, which `createStore()` and
`createVerifiedStore()` are (they run no DDL by contract):

```typescript
const adminStore = createStore(graph, backend);
await adminStore.probeContributions(); // degraded, detail names `stale`
await adminStore.rebuildContribution("fulltext");
// createStoreWithSchema() now opens normally again.
```

**The rebuild is scoped to the graph you call it on.** The fulltext
projection is one physical table holding every graph's rows keyed by
`graph_id`, so the default teardown is the same
`DELETE ... WHERE graph_id` that `clear()` issues — this graph's index
content and nothing else — followed by the current `createDdl`, a refill
from this graph's node rows, and the marker stamp, all in one transaction
under the same per-graph fence as a schema commit. An interrupted rebuild
therefore rolls back to the state it started from rather than leaving
storage attested but empty.

It escalates to dropping and recreating that shared table only when the
table holds no other graph's rows — the case where the drop takes nothing
with it. That escalation is the one repair for storage provisioned at a
shape the current DDL no longer produces, and because the DDL it issues is
database-global it runs under a database-scoped advisory lock
(`typegraph:contribution-ddl`; a no-op on SQLite, whose fence already holds
the single writer slot) rather than only the per-graph fence.

**When the shared table is in use by another graph, a `stale` rebuild
refuses.** Only recreating the storage repairs a `stale` shape, so if that
storage still holds rows belonging to other graphs the call throws
`ContributionRebuildUnsupportedError` with
`reason: "shared-storage-in-use"` rather than destroying content it cannot
reconstruct — those rows are derived from other graphs' nodes through their
own schemas — or re-stamping this graph's marker over a physical shape
nothing verified. `details.otherGraphIds` names the graphs that are in the
way. The sanctioned repair is a maintenance window with every graph on that
database offline: drop the table out of band, then run
`store.rebuildContribution("fulltext")` once per graph, each run recreating
the table from the current DDL and refilling that graph's own rows.

What a rebuild costs, and why it is still the right trade: the transaction
is held for the whole refill, and on PostgreSQL a `DROP TABLE` takes an
`ACCESS EXCLUSIVE` lock the rebuild keeps until commit. That blocks more
than searches — every write to a kind with `searchable()` fields
maintains the same table, so those block too. On SQLite the rebuild holds
the write lock for the same span, so concurrent writers wait out their
busy timeout and then fail. Run it in a maintenance window on a large
graph.
When the storage *shape* is fine and only the content is stale — a field
gained `searchable()` after data was written, or a `language` changed —
`store.search.rebuildFulltext()` is the incremental, resumable pass that
transacts per page instead.

Nothing is permanently lost for the graph you rebuild: its searchable text
is derived from node properties TypeGraph already stores. Other graphs on
the same database are not in reach either — their rows are kept by the
graph-scoped delete, and the drop that would take them never runs (a
`stale` shape that could only be repaired by that drop refuses instead).
Nodes whose stored `props` cannot be read as an object are counted in
`skipped` and are absent from the rebuilt index;
`store.search.rebuildFulltext()` reports their ids individually.

**Vector contributions cannot be rebuilt, and the call refuses rather
than trying.** `rebuildContribution("vector")` always throws
`ContributionRebuildUnsupportedError` with
`reason: "vector-source-unavailable"`. TypeGraph stores the vectors
callers supply and never the inputs that produced them, so the embeddings
exist only in the storage a rebuild would drop — dropping anyway would
destroy them and hand back storage that looks healthy and returns
nothing. `reembedVectorField(kind, fieldPath, { embed })` is the
sanctioned destructive path for vector storage precisely because it takes
the callback that can regenerate what the drop discards.

The same typed error covers two wiring gaps, and both refuse before
anything is dropped: `reason: "no-drop-ddl"` when the active fulltext
strategy declares no `dropDdl` on its contribution, and
`reason: "no-schema-fence"` when the backend exposes no
`schemaWriteTransaction` to make the sequence atomic (the HTTP-only
PostgreSQL drivers, and SQLite with transactions disabled). Both are
declared ahead of time as `capabilities.contributions.rebuild === false`.

## Semantic Search Issues

### "Extension not found" / "vector type not available"

**Cause:** Vector extension not installed. Only applies to PostgreSQL
(pgvector) and SQLite (sqlite-vec). libSQL / Turso has a built-in
native vector engine — there is nothing to load and it is wired
automatically by `createLibsqlBackend`.

**PostgreSQL:**

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

**SQLite:**

```typescript
import * as sqliteVec from "sqlite-vec";
sqliteVec.load(sqlite); // Must be called before creating backend
```

### "Dimension mismatch"

**Cause:** Query embedding has different dimension than stored embeddings.

**Solution:** Use consistent embedding dimensions:

```typescript
// Schema defines 1536 dimensions
const Document = defineNode("Document", {
  schema: z.object({
    embedding: embedding(1536),
  }),
});

// Query embedding must also be 1536
const queryEmbedding = await generateEmbedding(text);
console.log(queryEmbedding.length); // Should be 1536
```

### "Inner product not supported" (SQLite / libSQL)

**Cause:** `inner_product` is PostgreSQL-only. Neither sqlite-vec nor
libSQL support the inner product metric (cosine and l2 only). Check
`backend.capabilities.vector.metrics` for the active backend.

**Solution:** Use cosine or L2:

```typescript
// Instead of:
d.embedding.similarTo(query, 10, { metric: "inner_product" });

// Use:
d.embedding.similarTo(query, 10, { metric: "cosine" });
```

## TypeScript Issues

### "Property 'x' does not exist on type"

**Cause:** Accessing a property not defined in your schema.

**Solution:** Ensure the property is in your Zod schema:

```typescript
const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    email: z.string().optional(),
  }),
});

// Now both properties are available with correct types
const person = await store.nodes.Person.getById(id);
person?.name; // string
person?.email; // string | undefined
```

### Type inference not working in select

**Cause:** Complex generic inference limitations.

**Solution:** Use explicit typing or simplify:

```typescript
// If inference fails, be explicit
.select((ctx) => ({
  name: ctx.p.name as string,
  company: ctx.c.name as string,
}))
```

## Still Having Issues?

1. **Check the [Limitations](/limitations)** page for known constraints
2. **Review [Architecture](/architecture)** to understand how TypeGraph works
3. **Search [GitHub Issues](https://github.com/nicia-ai/typegraph/issues)** for similar problems
4. **Open a new issue** with a minimal reproduction case
