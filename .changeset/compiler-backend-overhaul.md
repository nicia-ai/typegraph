---
"@nicia-ai/typegraph": minor
---

Big performance increases, cleaner APIs, prepared queries, and batch collection
APIs.

### Breaking Changes

**Renamed APIs:**
- `selectAggregate()` is now `aggregate()`
- `EdgeTypeNames` / `NodeTypeNames` are now `EdgeKinds` / `NodeKinds` (including getter functions)

**Traversal expansion:** `includeImplyingEdges` replaced with `expand` option supporting four modes: `"none"`, `"implying"`, `"inverse"`, and `"all"` (default: `"inverse"`)

**Recursive traversal:** The chained methods `.maxHops()`, `.minHops()`, `.collectPath()`, and `.withDepth()` are consolidated into a single `recursive()` call with an options object:

```ts
// Before
.traverse("p", "knows", "friend").recursive().maxHops(5).collectPath()

// After
.traverse("p", "knows", "friend").recursive({ maxHops: 5, path: true })
```

New `cyclePolicy: "prevent" | "allow"` option (default: `"prevent"`). Unbounded recursion capped at depth 100; explicit `maxHops` validated up to 1,000.

**Store:** `Store` class is now a type-only export — use `createStore()`. `StoreConfig` replaced by `StoreOptions`.

**Moved to `@nicia-ai/typegraph/schema`:** All schema management APIs (`serializeSchema`, `deserializeSchema`, `initializeSchema`, `ensureSchema`, `migrateSchema`, `computeSchemaDiff`, `getMigrationActions`, `isBackwardsCompatible`, and related types) are now imported from the new `@nicia-ai/typegraph/schema` entry point.

**Removed from main entry:** `KindRegistry`, Result utilities (`ok`/`err`/`isOk`/`isErr`/`unwrap`/`unwrapOr`), date helpers (`encodeDate`/`decodeDate`), validation utilities, and compiler/profiler internals.

### New Features

**Prepared queries** — precompile queries once and execute repeatedly with different bindings at zero recompilation cost:

```ts
const prepared = store.query()
  .from("Person", "p")
  .whereNode("p", (p) => p.name.eq(param("name")))
  .select((ctx) => ctx.p)
  .prepare();

const alice = await prepared.execute({ name: "Alice" });
const bob = await prepared.execute({ name: "Bob" });
```

**Batch collection APIs:**
- `getByIds(ids)` — batched lookup preserving input order, returns `undefined` for missing IDs
- `bulkInsert` — void-returning fire-and-forget ingestion
- `bulkCreate` — multi-row `INSERT ... RETURNING` instead of per-item inserts
- `bulkUpsert` (edges) — batch lookup instead of N+1 sequential calls

**Node `find({ where })`** — filter nodes using the full query predicate system directly from collections.

### Performance

- SQL compiler restructured into plan/passes/emitter pipeline with predicate pre-indexing, column pruning, and single-hop recursive lowering
- Drizzle backend split into modular operations with dialect-driven strategy dispatch
- SQLite prepared statement caching with LRU eviction
- Compilation caching on immutable query builder instances
- Bind-limit-aware batch chunking (SQLite: 999 params, PostgreSQL: 65,535 params)
- Benchmark regression guardrails added to CI for both SQLite and PostgreSQL
