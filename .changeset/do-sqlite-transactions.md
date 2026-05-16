---
"@nicia-ai/typegraph": minor
---

Transactional writes for Cloudflare Durable Objects SQLite (`do-sqlite`)
(#140).

A store backed by `drizzle(ctx.storage)` previously fell back to
non-transactional behavior, so TypeGraph mutations could not be composed
atomically with a product's own relational ledger tables (e.g.
`document_versions`, `change_events`) inside a Durable Object.

**What ships (additive — no breaking changes):**

- New SQLite `transactionMode: "do-sqlite"`, **auto-detected** for
  `drizzle(ctx.storage)`. Such backends now advertise
  `capabilities.transactions: true`.

- `store.transaction(async (tx) => …)` and the caller-owned
  `store.withTransaction(db)` shape both work on Durable Objects. TypeGraph
  delegates to the async storage runner `ctx.storage.transaction(async …)`
  (surfaced by Drizzle as `db.$client.transaction`), which rolls back SQL
  writes across `await`. Drizzle's own `db.transaction()` on DO is
  `ctx.storage.transactionSync` and cannot span an `await`, so it is
  deliberately not used. There is no Drizzle transaction handle on DO — the
  storage transaction is ambient on the object — so the tx-scoped backend
  binds the outer `db`.

  ```ts
  await ctx.storage.transaction(async () => {
    const txStore = store.withTransaction(db);
    await txStore.nodes.Document.update(documentId, props);
    await db.insert(documentVersions).values(versionRow);
    await db.insert(changeEvents).values(eventRow);
  }); // one storage-transaction COMMIT / ROLLBACK across both layers
  ```

- A latent detection bug is fixed: drizzle's Durable Objects session class is
  `SQLiteDOSession` (not the previously-checked `SQLiteDurableObjectSession`),
  so a real `drizzle(ctx.storage)` store was misclassified.

- New `TransactionContext.sql` — the raw Drizzle handle bound to the same
  transaction — for graph-owned cross-store writes across **all**
  transactional backends (Postgres, libsql, better-sqlite3, do-sqlite):

  ```ts
  await store.transaction(async (tx) => {
    await tx.nodes.Document.update(documentId, props);
    await tx.sql.insert(documentVersions).values(versionRow);
    await tx.sql.insert(changeEvents).values(eventRow);
  });
  ```

  This is the graph-owned counterpart of `store.withTransaction` (where the
  caller owns the boundary). On Postgres/libsql it is a correctness
  requirement — the outer `db` would write on a different connection and
  escape the transaction. `tx.sql` is `undefined` only on the
  non-transactional fallback. Its static type is the `AdoptedTransaction`
  union; cast to your concrete Drizzle database type at the call site.

**Guarantees.** Building on #135, no schema/bootstrap/fulltext DDL ever runs
inside the business transaction: `bootstrapTables` and the durable
materialization marker run outside any storage transaction, while the
schema-version commit uses the `do-sqlite` runner (data only). Boot the parent
store via `createStoreWithSchema` once at object startup.

**Out of scope.** Cloudflare D1 stays `transactionMode: "none"`:
`D1Database.batch(...)` is transactional but not an interactive runner. A
batch-only D1 mode is tracked separately.
