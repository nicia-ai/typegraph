---
"@nicia-ai/typegraph": minor
---

PostgreSQL: official postgres-js / Neon support, server-side prepared statements on the fast path, and a `refreshStatistics()` API.

**Four drivers supported.** `createPostgresBackend` has always been driver-agnostic, but only `node-postgres` was covered in CI. This release adds:

- **`drizzle-orm/postgres-js`** — full adapter + integration suite coverage (~250 tests run against both `pg` and `postgres-js` against a real PostgreSQL).
- **`drizzle-orm/neon-serverless`** — `@neondatabase/serverless` Pool over WebSockets. Wiring smoke tests verify driver detection, fast-path routing, Date→string normalization, and capability surface; the shared code paths are exercised by the `pg` integration suite since this driver is pg-Pool-protocol-compatible.
- **`drizzle-orm/neon-http`** — `@neondatabase/serverless` `neon(url)` over HTTP. Auto-detected so `capabilities.transactions` is set to `false` (HTTP can't hold a session); single-statement reads, writes, and migrations work normally. Smoke tests verify the detection and capability override.

Same `createPostgresBackend(db)` entry point regardless of driver.

```typescript
// postgres-js
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
const backend = createPostgresBackend(drizzle(postgres(process.env.DATABASE_URL)));

// Neon serverless (edge runtimes)
import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
const backend = createPostgresBackend(drizzle(new Pool({ connectionString: env.NEON_DATABASE_URL })));
```

**On Neon HTTP vs WebSockets:** both work. The HTTP driver (`drizzle-orm/neon-http`) is best for stateless edge workloads — TypeGraph auto-disables transactions since HTTP can't hold a session, and `store.transaction(...)` falls through to non-transactional sequential execution. Use the WebSocket driver (`drizzle-orm/neon-serverless`) when you need atomic multi-statement writes.

**~6× faster on multi-hop traversals via server-side prepared statements.** The execution adapter now uses `node-postgres`'s named prepared statements transparently — each unique compiled SQL string gets a stable counter-derived statement name (cached by SQL text), so PostgreSQL caches the plan after first execution. Combined with routing `execute()` through the fast path directly (skipping Drizzle's session wrapper), this drops the 3-hop benchmark from ~7.5ms to ~0.8ms median, putting TypeGraph-on-PostgreSQL at parity with Neo4j on every single-query and multi-hop shape we measure.

The change is invisible to callers; existing code keeps working. postgres-js is unchanged (it handles its own preparation internally).

**New `store.refreshStatistics()` / `backend.refreshStatistics()` API.** Call once after a large initial import or bulk backfill. Without fresh stats, the planner can pick suboptimal execution plans — on PostgreSQL this is the difference between a 0.5ms and 5ms forward traversal; on SQLite it's the difference between 0.9ms and 23ms fulltext search. Autovacuum / background statistics catch up eventually, but explicit invocation gives correct latencies immediately.

```typescript
for (const batch of batches) {
  await store.nodes.Document.bulkCreate(batch);
}
await store.refreshStatistics();
```

Implementations: SQLite runs `ANALYZE`; PostgreSQL runs `ANALYZE` on TypeGraph-managed tables only. Costs ~20ms on SQLite, ~80ms on PostgreSQL at the sizes this library is designed for.

**Type surface changes:**

- `GraphBackend` now requires a `refreshStatistics(): Promise<void>` method. `TransactionBackend` still excludes it (statistics refresh isn't meaningful inside a transaction). External `GraphBackend` implementations (uncommon) need to add a no-op or proper implementation.
- `PostgresBackendOptions` adds an optional `capabilities?: Partial<BackendCapabilities>` for users who need to override capability flags (e.g., for custom HTTP-style drivers).
- `PostgresBackendOptions` also adds `prepareStatements?: boolean` (default `true`) and `preparedStatementCacheMax?: number` (default `256`). The prepared-statement name cache is now LRU-bounded so high-cardinality SQL text doesn't grow unbounded in either the Node process or in PostgreSQL's per-session prepared-statement memory. Set `prepareStatements: false` when pooling through pgbouncer in transaction-pool mode.

See [`backend-setup`](https://typegraph.dev/backend-setup#choosing-a-postgresql-driver) for the runtime-to-driver matrix, per-driver setup snippets, and post-bulk-load guidance.
