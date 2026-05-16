---
"@nicia-ai/typegraph": minor
---

Cross-store atomicity: share one transaction across the TypeGraph store and an
external Drizzle connection (#134).

Applications that persist into the same database through two layers — Drizzle
for relational rows and TypeGraph for graph nodes/edges — previously had no way
to make a write that spans both layers all-or-nothing. `store.transaction()`
and `db.transaction()` each opened a *separate* transaction on a *separate*
connection, so a failure between the two writes left either a stray relational
row or a committed graph node with a dangling foreign reference.

**What ships (additive — no breaking changes):**

- New `Store.withTransaction(externalTx): TransactionContext<G>`. The caller
  owns the transaction; `store.withTransaction(sqlTx)` returns a
  transaction-scoped `{ nodes, edges }` bound to that *exact* connection, so
  both layers commit or roll back together. It is driver-agnostic; how you
  open the transaction is not.

  Async drivers (node-postgres, `neon-serverless` Pool, libsql):

  ```ts
  await db.transaction(async (sqlTx) => {
    const connector = await createConnectorRow(sqlTx, input); // Drizzle
    const txStore = store.withTransaction(sqlTx);
    await txStore.nodes.ArtifactSource.create({                // TypeGraph
      connectorId: connector.id,
    });
  }); // one COMMIT / ROLLBACK
  ```

  Synchronous `better-sqlite3` cannot use `db.transaction(async …)` (its
  driver rejects an `async` callback); open the transaction with explicit
  `BEGIN`/`COMMIT`/`ROLLBACK` instead and pass the connection to
  `withTransaction`. See the "Cross-Store Transactions" recipe for both
  shapes.

- New optional `GraphBackend.adoptTransaction(externalTx)` member, implemented
  by the Drizzle Postgres and SQLite backends, plus the new `AdoptedTransaction`
  type.

**Guarantees.** The adopted context reuses the parent store's already-resolved
schema: it runs no `createStoreWithSchema` / `evolve` / `migrateSchema` and
emits **no DDL inside the caller's business transaction**. Building on #135,
fulltext operations assert the durable materialization marker (a cached
`SELECT`, never DDL) and throw `StoreNotInitializedError` on a
missing/stale/failed marker rather than migrating mid-transaction — so boot the
parent store via `createStoreWithSchema` once at startup. When the backend
cannot provide real rollback (`backend.capabilities.transactions === false`:
`drizzle-orm/neon-http`, Cloudflare D1, SQLite `transactionMode: "none"`),
`withTransaction` throws `ConfigurationError` rather than silently degrading —
a non-atomic fallback is safe for graph-only writes but dangerous for
cross-store flows, where the caller's relational write *would* still commit.
