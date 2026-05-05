---
"@nicia-ai/typegraph": minor
---

Replace the unwrapped `insertSchema` + `setActiveSchema` two-step migration flow with a single atomic `commitSchemaVersion` backend primitive (plus `setActiveVersion` for rollback). Fixes the orphan-row bug where a crash between insert and activate left the system wedged at the next `ensureSchema` call.

**The bug.** `migrateSchema` called `backend.insertSchema(v=N+1, isActive=false)` then `backend.setActiveSchema(N+1)` as two independent operations with no surrounding transaction. A crash in between left an inactive `v=N+1` row that nothing referenced; the next migration attempt computed the same `newVersion=N+1` and hit a primary-key violation, requiring manual operator cleanup. Closes #104.

**New primitives:**

```typescript
backend.commitSchemaVersion({
  graphId,
  expected: { kind: "initial" } | { kind: "active"; version: N },
  version: N + 1,
  schemaHash,
  schemaDoc,
});

backend.setActiveVersion({ graphId, expected, version });
```

`commitSchemaVersion` inserts and activates as one transactional unit with optimistic compare-and-swap on the currently-active version, idempotency on same-hash retry (orphan reactivation), and explicit conflict detection. The CAS guard takes a tagged-union `expected` rather than a magic `version: 0` sentinel — initial commits have materially different semantics from successor commits and the type system reflects that.

**New error types** (both extend `TypeGraphError`):

- `StaleVersionError` — thrown when the caller's `expected` active version doesn't match what the database has. Includes `details.actual` so the caller knows what to refetch. Recovery: re-read with `getActiveSchema(graphId)` and retry against the new baseline.
- `SchemaContentConflictError` — thrown when a row already exists at the target version with a different `schemaHash`. This is a content disagreement (two writers committed different schemas at the same version), not a stale-read race; recovery requires operator intervention, not retry.

**Storage-layer invariant.** Adds a partial unique index `(graph_id) WHERE is_active = TRUE` on `typegraph_schema_versions`. Defense in depth: the database will refuse a corrupt "two active rows on one graph" state regardless of the application path that produced it.

**Non-transactional backends refuse the primitive.** On Cloudflare D1, Cloudflare Durable Objects, `drizzle-orm/neon-http`, and any SQLite backend configured with `transactionMode: "none"`, `commitSchemaVersion` and `setActiveVersion` throw `ConfigurationError`. The orphan-row crash window cannot be eliminated without atomicity, so silent best-effort degradation would re-introduce the exact bug this primitive fixes. Run schema migrations from a process with a transactional driver; the edge worker can keep using its non-transactional driver for reads and ordinary writes once the schema is established.

**Locking.**

- SQLite: `BEGIN IMMEDIATE` (sync paths) or Drizzle's `behavior: "immediate"` (async paths) acquires a reserved write lock at the start of the transaction so the read-then-write CAS sequence is serialized.
- Postgres: `pg_advisory_xact_lock(hashtext(graphId))` serializes commits per-graph, covering both the "active row exists" and "initial commit" cases under one mechanism.

**Breaking changes for backend implementers.** `insertSchema` and `setActiveSchema` are removed from the `GraphBackend` interface; custom backend implementations must implement `commitSchemaVersion` and `setActiveVersion` instead. Callers using the public `initializeSchema`, `migrateSchema`, and `rollbackSchema` helpers from `@nicia-ai/typegraph/schema` need no changes — these now route through the new primitives transparently.

Existing deployments need to add the partial unique index when they upgrade. `bootstrapTables` regenerates the full DDL set (idempotent; existing tables are unchanged); manually-managed schemas should run an additional `CREATE UNIQUE INDEX IF NOT EXISTS typegraph_schema_versions_one_active_per_graph_idx ON typegraph_schema_versions (graph_id) WHERE is_active = TRUE;` for Postgres or the equivalent `WHERE is_active = 1` for SQLite. Existing data that has only ever maintained one active row per graph will satisfy the constraint — the application path has always done so by convention; the index just makes the invariant structural.
