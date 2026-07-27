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

### The store opens clean but a fulltext or vector read fails

**Cause:** The durable contribution marker still says `initialized`
while the physical table it names is gone — a partial restore, a
hand-run `DROP`, or a schema-scoped restore that missed the
strategy-owned tables. Nothing on the open path probes the catalog:
boot and the runtime asserts short-circuit on a per-instance signature
cache and then on the marker row alone, which keeps the hot path free
of catalog round trips. The cost is that this database opens
completely clean and fails at the first read of the affected slot.

**Diagnosis:** `store.verifyContributions()` returns an empty array on
a healthy database. Each entry carries `owner`, `logicalName`,
`physicalName`, a `state`, and — for vector slots — `kind` and
`fieldPath`. When the marker recorded an error against its last
attempt, `lastError` carries it: `state` tells you which repair to run,
`lastError` tells you why it broke, which is often a different
question. The call is read-only — one existence query per contribution
table, no DDL and no writes — so it is safe on a live store under a
least-privilege role. It is deliberately **not** a boot step; call it
from a health check or an operator script.

**Solution: the repair depends on the state, and picking the wrong one
can destroy data.** There is no single loop that repairs every entry.

### Repairing a vector slot

Entries with `kind` and `fieldPath` set are embedding slots.

| `state` | Repair | Embeddings |
| --- | --- | --- |
| `missing-marker` | `ensureVectorSlotContribution(slot, { force: true })` | **Preserved** |
| `failed-materialization` | `ensureVectorSlotContribution(slot, { force: true })` | None existed |
| `orphaned-marker` | `reembedVectorField(kind, fieldPath, { embed })` | Already lost with the table |
| `stale` | `reembedVectorField(kind, fieldPath, { embed })` | **Destroyed — repopulation required** |

The distinction matters. `reembedVectorField` drops and recreates
storage; without an `embed` callback it returns with **zero
embeddings**. For `missing-marker` the table is intact and only the
marker is not, so reaching for `reembedVectorField` there would destroy
perfectly good vectors to fix a bookkeeping problem. Use the
force-ensure instead — its DDL is `CREATE ... IF NOT EXISTS` and never
drops, so it re-stamps the marker and leaves every row in place:

```typescript
import { resolveGraphVectorSlots } from "@nicia-ai/typegraph";

const slots = resolveGraphVectorSlots(store.graph);

for (const entry of await store.verifyContributions()) {
  if (entry.kind === undefined || entry.fieldPath === undefined) continue;

  if (entry.state === "missing-marker" || entry.state === "failed-materialization") {
    // Non-destructive: re-stamps the marker, leaves storage untouched.
    const slot = slots.find(
      (candidate) =>
        candidate.nodeKind === entry.kind &&
        candidate.fieldPath === entry.fieldPath,
    );
    if (slot) await adminBackend.ensureVectorSlotContribution?.(slot, { force: true });
  } else {
    // orphaned-marker / stale: storage must be rebuilt. Pass `embed` or
    // the field comes back empty and every vector query silently
    // returns nothing.
    await store.reembedVectorField(entry.kind, entry.fieldPath, {
      embed: async (nodes) => new Map(/* recompute vectors here */),
    });
  }
}
```

For `stale` the destruction is unavoidable rather than accidental: the
stored vectors were written at a different dimension and are invalid
under the new one, so they must be recomputed, not converted.

### Repairing fulltext

`ensureRuntimeContributions` does **not** force, and a fresh backend is
not sufficient on its own. It short-circuits twice — once on a
per-instance signature cache, and again if the durable marker row alone
looks healthy. A fresh instance clears only the first. What repairs
what:

| `state` | Repair |
| --- | --- |
| `missing-marker`, `failed-materialization` | `ensureRuntimeContributions(graphId)` from a **fresh** privileged backend |
| `orphaned-marker` | Re-run the contribution's own `createDdl` (below) |
| `stale` | No supported automated repair — see the warning below |

For `missing-marker` and `failed-materialization` the marker does not
attest the contribution, so the ensure falls through and runs the DDL.
Use a new backend instance: on the warm one whose marker the diagnostic
just flagged, the per-instance cache returns early and the repair
silently never runs.

For `orphaned-marker` the marker still says `initialized`, so the
ensure returns before any DDL no matter how fresh the backend is.
Recreate the table from the declaration instead — the statements are
idempotent, so this is safe to run against a table that turns out to
still exist:

```typescript
const fulltextTable = adminBackend.tableNames.fulltext;
for (const contribution of adminBackend.fulltextStrategy.ownedTables(fulltextTable)) {
  for (const ddl of contribution.createDdl) {
    await adminBackend.executeDdl?.(ddl);
  }
}
```

:::caution[`stale` fulltext has no supported repair path today]
A `stale` fulltext contribution — the marker records a prior success at
a different signature, which a library upgrade that changes the
fulltext DDL can produce — cannot currently be repaired through the
public API. Recreating the table does not help: the marker still
carries the old signature, and re-stamping it is not exposed.

Do **not** reach for `ensureRuntimeContributions` here. It throws on
the drift guard, and on its way out it records the failure against the
marker — which changes what the diagnostic reports next time from
`stale` to `missing-marker`, with the drift-guard message in
`lastError`. The underlying problem is unchanged; only its description
moved. If you hit this, please open an issue with the reported
`owner` / `logicalName` / `signature` rather than hand-editing the
marker table.
:::

**An empty result does not mean everything was checked.** A backend
that cannot probe its own catalog throws `ConfigurationError` rather
than reporting a clean bill of health, but vector slots on a backend
without vector support are skipped silently and correctly — that
backend never materialized them, so there is nothing to compare, and
reporting them would be a false positive on every store it opens. The
return type cannot distinguish "checked and healthy" from "did not
check", so `(await store.verifyContributions()).length === 0` reads
identically in both cases. If you are building a health check on this,
assert `backend.capabilities.vector?.supported` separately rather than
treating an empty array as proof that embedding storage is intact.

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
