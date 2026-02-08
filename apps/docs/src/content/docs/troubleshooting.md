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
// Option 1: Delete edges first
const edges = await store.edges.worksAt.findFrom(person);
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
store.query()
  .from("Person", "p")
  .traverse("knows", "e")
  .to("Person", "p") // Error! 'p' already used

// Good
store.query()
  .from("Person", "p1")
  .traverse("knows", "e")
  .to("Person", "p2")
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
   const all = await store.query().from("Person", "p").select((c) => c.p).execute();
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

   const nameIndex = defineNodeIndex("Person", ["name"]);
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
import { getPostgresMigrationSQL } from "@nicia-ai/typegraph/postgres";
await pool.query(getPostgresMigrationSQL());

// SQLite
import { getSqliteMigrationSQL } from "@nicia-ai/typegraph/sqlite";
sqlite.exec(getSqliteMigrationSQL());
```

## Semantic Search Issues

### "Extension not found" / "vector type not available"

**Cause:** Vector extension not installed.

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

### "Inner product not supported" (SQLite)

**Cause:** sqlite-vec doesn't support inner product metric.

**Solution:** Use cosine or L2:

```typescript
// Instead of:
d.embedding.similarTo(query, 10, { metric: "inner_product" })

// Use:
d.embedding.similarTo(query, 10, { metric: "cosine" })
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
person?.name;  // string
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
