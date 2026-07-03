---
title: Indexes
description: Define and create indexes for TypeGraph queries
---

TypeGraph stores node and edge properties in a JSON `props` column. When you filter or order by
JSON properties at scale, you typically need **expression indexes** on those JSON paths.

TypeGraph includes built-in indexes for common access patterns (lookups by ID, edge traversals,
temporal filtering), but application-specific indexes are up to you.

The `@nicia-ai/typegraph/indexes` entrypoint provides:

- **Type-safe index definitions** for node and edge schemas
- **Dialect-specific DDL generation** for PostgreSQL and SQLite
- **Drizzle schema integration** so drizzle-kit can generate migrations
- **Profiler integration** so recommendations account for indexes you already have

## Quick Start (Drizzle / drizzle-kit)

Define your indexes once and pass them into the Drizzle schema factories:

```ts
import { defineEdge, defineNode } from "@nicia-ai/typegraph";
import { createPostgresTables } from "@nicia-ai/typegraph/postgres";
import { andWhere, defineEdgeIndex, defineNodeIndex } from "@nicia-ai/typegraph/indexes";
import { z } from "zod";

const Person = defineNode("Person", {
  schema: z.object({
    email: z.string().email(),
    name: z.string(),
    isActive: z.boolean().optional(),
  }),
});

const worksAt = defineEdge("worksAt", {
  schema: z.object({
    role: z.string(),
  }),
});

export const personEmail = defineNodeIndex(Person, {
  fields: ["email"],
  unique: true,
  coveringFields: ["name"],
  where: (w) => andWhere(w.deletedAt.isNull(), w.isActive.eq(true)),
});

export const worksAtRoleOut = defineEdgeIndex(worksAt, {
  fields: ["role"],
  direction: "out",
  where: (w) => w.deletedAt.isNull(),
});

// drizzle-kit will include these indexes in generated migrations
export const typegraphTables = createPostgresTables({}, {
  indexes: [personEmail, worksAtRoleOut],
});
```

For SQLite, use `createSqliteTables`:

```ts
import { createSqliteTables } from "@nicia-ai/typegraph/sqlite";

export const typegraphTables = createSqliteTables({}, {
  indexes: [personEmail, worksAtRoleOut],
});
```

## Node Indexes

`defineNodeIndex(nodeType, config)` creates an index definition for node properties.

**Key options:**

- `fields`: JSON property paths used for filtering/ordering (B-tree expression keys).
- `coveringFields`: additional properties frequently selected with the same filters. These become
  additional index keys to enable index-only reads when combined with smart select.
- `unique`: create a unique index.
- `scope`: prefixes index keys with TypeGraph system columns (default is `"graphAndKind"`).
- `where`: partial index predicate (portable DSL, compiled per dialect).

:::note[Covering fields vs PostgreSQL INCLUDE]
TypeGraph properties live inside `props`, so indexes are built on expressions. PostgreSQL `INCLUDE`
does not support expressions, so `coveringFields` are implemented as additional index keys rather
than an `INCLUDE (...)` clause.

Because `coveringFields` become index keys, they:

- Increase index size (more key data)
- Affect index ordering (can help `ORDER BY`, but changes sort/range behavior)
- Must be maintained on writes like any other key

:::

### Nested JSON Paths

For top-level properties, use the field name:

```ts
defineNodeIndex(Person, { fields: ["email"] });
```

For nested properties inside `props`, use a JSON pointer:

```ts
defineNodeIndex(Person, { fields: ["/metadata/priority"] });
```

You can also pass pointer segments:

```ts
defineNodeIndex(Person, { fields: [["metadata", "priority"] as const] });
```

### Index Scope

Index `scope` controls which TypeGraph system columns are prefixed ahead of your JSON keys:

- `"graphAndKind"` (default): prefixes with `(graph_id, kind)` to match most TypeGraph queries.
- `"graph"`: prefixes with `graph_id` only (rare; useful for cross-kind queries within a graph).
- `"none"`: no system prefix (rare; usually only correct for global queries).

## Edge Indexes

`defineEdgeIndex(edgeType, config)` works the same way as node indexes, with one extra option:

- `direction`: `"out" | "in" | "none"` (default `"none"`). When set, the index keys are prefixed
  with the join key used by traversal queries (`from_id` for `"out"`, `to_id` for `"in"`).

This makes it easy to create indexes that match `.traverse()` patterns.

**When to use `direction`:**

- `"out"`: optimize outbound traversals that join on `from_id` (start node → edges).
- `"in"`: optimize inbound traversals that join on `to_id` (end node → edges).
- `"none"`: for edge queries not anchored by a traversal join key (less common).

## Partial Indexes (WHERE)

Use `where` to create partial indexes with a small, typed predicate DSL.

System columns are available (e.g. `deletedAt`, `createdAt`, `fromId`), as well as your schema
properties (e.g. `email`, `role`).

```ts
import { andWhere, defineNodeIndex } from "@nicia-ai/typegraph/indexes";

const activeEmail = defineNodeIndex(Person, {
  fields: ["email"],
  where: (w) => andWhere(w.deletedAt.isNull(), w.isActive.eq(true)),
});
```

## Covering Indexes

To maximize the benefit of [smart select optimization](/performance/overview#smart-select),
create indexes that include both the filter columns and selected columns. This enables index-only
scans where the database satisfies the entire query from the index.

```ts
// Index covers email filter AND name selection
const personEmailWithName = defineNodeIndex(Person, {
  fields: ["email"],
  coveringFields: ["name"],
  where: (w) => w.deletedAt.isNull(),
});
```

**Generated PostgreSQL:**

```sql
CREATE INDEX idx_person_email_name ON typegraph_nodes
  (graph_id, kind, ((props #>> ARRAY['email'])), ((props #>> ARRAY['name'])))
  WHERE deleted_at IS NULL;
```

**Generated SQLite:**

```sql
CREATE INDEX idx_person_email_name ON typegraph_nodes
  (graph_id, kind, json_extract(props, '$.email'), json_extract(props, '$.name'))
  WHERE deleted_at IS NULL;
```

## Batched Index Lookup (`bulkFindByIndex`)

`store.nodes.<Kind>.bulkFindByIndex(indexName, items, options?)` takes many in-memory records and
returns the live nodes that share each record's declared **index key** — batched candidate retrieval
for import reconciliation, dedup-candidate discovery, and joining incoming records against the graph
by a declared composite key.

```ts
const candidates = await store.nodes.Person.bulkFindByIndex("person_active_name", [
  { props: { isActive: true, name: "Ana" } },
  { props: { name: "Bo" } }, // missing isActive → matches stored null
]);
// readonly Node<Person>[][] — one bucket per input, ordered by node id
```

Semantics:

- **One bucket per input**, in input order; empty input returns `[]`. The index may be non-unique, so
  each bucket is a (possibly empty) array — this is candidate retrieval, not a uniqueness guarantee.
  For unique lookups prefer `bulkFindByConstraint` (backed by the uniqueness side-table).
- TypeGraph computes the lookup key from **`index.fields` only** (JSON-pointer extraction, reusing the
  index's own extraction expressions). `coveringFields` are not part of the key.
- The index's partial `where` is applied in SQL to **stored** rows only; probes carry index-field
  values, nothing else. Only the indexed fields are validated — full records are not required.
- A missing/`undefined` indexed field matches stored `NULL` (null-safe equality). Live,
  non-soft-deleted nodes only.
- `options.limitPerInput` caps each bucket (ordered by node id); unbounded by default — no silent
  truncation. A non-positive value throws `ValidationError`. An unknown index name throws
  `NodeIndexNotFoundError`. A non-scalar probe value throws `ValidationError`. On backends that
  support SQL window functions the cap is applied in-database (`ROW_NUMBER()`); on backends without
  them (`capabilities.windowFunctions: false`) it degrades to an in-memory cap after fetching the
  matching ids — same result, but it transfers all matching ids for low-selectivity keys.
- **Key field types:** string, number, and boolean keys are supported. **Date-typed key fields are
  not** — they throw `ConfigurationError`, because SQLite compares stored ISO text byte-wise while
  PostgreSQL compares `timestamptz` instants, so the same instant in different ISO forms would match
  on one backend but not the other. Use a string-encoded key, or `store.query(...).where(...)` for
  date predicates.

The lookup is correct whether or not the physical index has been materialized; materialize it (see
below) for the query planner to actually use it. Null-safe predicates may be less reliably
index-accelerated than plain equality.

## Choosing the Right Index Type

TypeGraph's `defineNodeIndex` / `defineEdgeIndex` generate **B-tree expression indexes** — the right
choice for scalar equality, range, and ordering queries. But JSON properties can also hold arrays
and objects, which need different index strategies.

| Data shape | Query pattern | Index type | TypeGraph utility? |
|------------|--------------|------------|-------------------|
| Scalar (`string`, `number`, `boolean`) | `eq()`, `gt()`, `in()`, `orderBy()` | B-tree expression | Yes — `defineNodeIndex` |
| Array of scalars | `contains()`, `containsAll()`, `containsAny()` | GIN (PostgreSQL) | No — use raw SQL |
| Nested object | `hasKey()`, `pathEquals()`, `pathContains()` | GIN or B-tree expression | Partially — B-tree on specific paths |

### B-tree expression indexes (scalar properties)

Best for equality, range, sorting, and prefix matching on individual JSON fields. This is what
`defineNodeIndex` and `defineEdgeIndex` generate.

```ts
// Good for: .whereNode("p", (p) => p.email.eq("..."))
defineNodeIndex(Person, { fields: ["email"] });

// Good for: .orderBy("p", "createdScore", "desc")
defineNodeIndex(Person, { fields: ["createdScore"] });
```

### GIN indexes (array containment — PostgreSQL only)

TypeGraph compiles array predicates to PostgreSQL's JSONB containment operator over the field's
extraction expression — `(props #> ARRAY['tags']) @> $1`. Declare a containment index with
`method: "gin"` and TypeGraph emits the matching **expression GIN** (`jsonb_path_ops`):

```typescript
const personTags = defineNodeIndex(Person, {
  fields: ["tags"],
  method: "gin",
});
// materialized via store.materializeIndexes():
// CREATE INDEX ... USING GIN (("props" #> ARRAY['tags']) jsonb_path_ops);
```

The index accelerates all containment predicates on that field:

```typescript
// contains: does the tags array include "typescript"?
.whereNode("p", (p) => p.tags.contains("typescript"))

// containsAll: does it include BOTH "typescript" AND "graphql"?
.whereNode("p", (p) => p.tags.containsAll(["typescript", "graphql"]))

// containsAny: does it include "typescript" OR "graphql"?
.whereNode("p", (p) => p.tags.containsAny(["typescript", "graphql"]))
```

:::caution[Whole-column `GIN (props)` does not work]
PostgreSQL matches expression indexes structurally. A whole-column
`CREATE INDEX ... USING GIN (props)` serves `props @> …` — **not** the
per-field `(props #> ARRAY['tags']) @> …` expressions TypeGraph compiles,
so such an index is never used. Declare `method: "gin"` per field (or
hand-write the same expression form) instead.
:::

:::note[SQLite]
SQLite has no GIN equivalent; `materializeIndexes()` reports gin/trigram
declarations as `skipped` there. Array containment on SQLite uses
`json_each()` scans, which can't be indexed.
:::

### Trigram indexes (substring and case-insensitive matching — PostgreSQL only)

`contains` / `startsWith` / `endsWith` / `ilike` on string fields compile to
`ILIKE` on PostgreSQL, which a B-tree can never serve for infix patterns.
Declare `method: "trigram"` and TypeGraph emits an expression GIN with
`gin_trgm_ops` (installing the `pg_trgm` extension on first
materialization):

```typescript
const personName = defineNodeIndex(Person, {
  fields: ["name"],
  method: "trigram",
});
// CREATE INDEX ... USING GIN (("props" #>> ARRAY['name']) gin_trgm_ops);

.whereNode("p", (p) => p.name.contains("smith"))   // served by the index
.whereNode("p", (p) => p.name.ilike("%SMITH%"))    // also served
```

On SQLite these declarations are `skipped` — SQLite's substring-search
story is [FTS5 fulltext](/search/fulltext) via `searchable()` fields.

GIN-family methods take exactly one field and don't support `unique`,
`coveringFields`, or `where`; the query's `graph_id` / `kind` filters apply
as residual conditions over the index's candidate rows.

### Combining B-tree and GIN

For kinds where you filter on both scalar fields (equality, range) and array or substring
predicates, declare both index types:

```typescript
const personEmail = defineNodeIndex(Person, { fields: ["email"] });
const personTags = defineNodeIndex(Person, { fields: ["tags"], method: "gin" });
```

PostgreSQL's query planner can use both indexes together via a BitmapAnd scan when a query filters
on both a scalar field and an array field.

## Generating SQL (No drizzle-kit)

If you manage migrations yourself, generate DDL snippets:

```ts
import { generateIndexDDL } from "@nicia-ai/typegraph/indexes";

const sql = generateIndexDDL(personEmail, "postgres");
// → CREATE INDEX ...;
```

## Verifying Index Usage

Use `EXPLAIN ANALYZE` to verify your indexes are being used:

```sql
-- PostgreSQL
EXPLAIN ANALYZE SELECT props #>> ARRAY['email'], props #>> ARRAY['name']
FROM typegraph_nodes
WHERE graph_id = 'my_graph'
  AND kind = 'Person'
  AND deleted_at IS NULL
  AND (props #>> ARRAY['email']) = 'alice@example.com';

-- SQLite
EXPLAIN QUERY PLAN SELECT json_extract(props, '$.email'), json_extract(props, '$.name')
FROM typegraph_nodes
WHERE graph_id = 'my_graph'
  AND kind = 'Person'
  AND deleted_at IS NULL
  AND json_extract(props, '$.email') = 'alice@example.com';
```

Look for "Index Scan" or "Index Only Scan" (PostgreSQL) or "USING INDEX" (SQLite) in the output.

## Profiler Integration

Pass your existing indexes to the [Query Profiler](/performance/profiler) so recommendations
focus on what you *don't* have:

```ts
import { QueryProfiler } from "@nicia-ai/typegraph/profiler";
import { toDeclaredIndexes } from "@nicia-ai/typegraph/indexes";

const profiler = new QueryProfiler({
  declaredIndexes: toDeclaredIndexes([personEmail, worksAtRoleOut]),
});
```

## Limitations

- `defineNodeIndex` / `defineEdgeIndex` generate B-tree expression indexes for **scalar** properties
  (`string`, `number`, `boolean`, `Date`). For array containment queries, create
  [GIN indexes](#gin-indexes-array-containment--postgresql-only) manually.
- GIN indexes are PostgreSQL-only. SQLite has no equivalent for JSON containment acceleration.
- Embedding fields live in per-`(graphId, kind, field)` vector tables (`tg_vec_*`) and are indexed
  through `store.materializeIndexes()` (pgvector builds an HNSW / IVFFlat ANN index; sqlite-vec and
  libSQL report `skipped`/build their own). See [Semantic Search](/semantic-search).

## Next Steps

- [Performance Overview](/performance/overview) — Best practices, N+1 prevention, batch patterns
- [Query Profiler](/performance/profiler) — Automatic index recommendations
