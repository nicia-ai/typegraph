---
"@nicia-ai/typegraph": minor
---

Vector storage now rides the #135 durable-contribution machinery, so the
runtime never issues DDL on the embedding hot path.

Previously every vector op (`upsertEmbedding` / `deleteEmbedding` /
`vectorSearch` / `createVectorIndex`) lazily ran `CREATE TABLE IF NOT EXISTS`
for its per-`(kind, field)` table on whatever connection it executed on. On a
least-privilege Postgres role (USAGE on `public`, full DML, but no `CREATE`)
this failed with `permission denied for schema public` (SQLSTATE 42501) — even
when the table already existed, because Postgres runs the schema aclcheck before
the `IF NOT EXISTS` short-circuit. The fulltext path already avoided this via
durable markers; vectors now do too.

What changed:

- **Boot (privileged):** `createStoreWithSchema` provisions every embedding
  `(kind, field)` table + a durable contribution marker, enumerated from the
  graph. `evolve()` provisions any embedding fields it introduces. A slot
  already provisioned at a *different* shape (the declared dimension changed)
  is warned about and left untouched — boot stays reachable so
  `store.reembedVectorField()` can recreate it; until then, writes to that
  field fail with a `stale` `StoreNotInitializedError` that points at
  `reembedVectorField`.
- **Runtime writes (DML-only):** `upsertEmbedding` (single and batch) and
  `deleteEmbedding` assert the durable marker with a cached, signature-checked
  SELECT and run DML — never DDL. `createVerifiedStore` verifies vector markers
  at attach, alongside fulltext.
- **Vector reads are not marker-gated:** `store.search.vector`,
  `store.search.hybrid`, and query-builder `.similarTo()` predicates compile to
  SQL against the per-field table directly (searches may override the metric at
  query time, so their slot legitimately differs from the provisioned shape);
  against an un-provisioned database they surface the engine's missing-relation
  error, which `createVerifiedStore` catches at attach.
- `reembedVectorField` re-stamps the marker after recreating storage at a new
  dimension; vector-field reclaim (`materializeRemovals`) clears the marker when
  it drops a table.

**Breaking:** vector ops now require a prior privileged `createStoreWithSchema`
(exactly as fulltext already does). A plain `createStore` + embedding write with
no provisioning step throws `StoreNotInitializedError` instead of lazily
creating the table.

**Migration:** after upgrading, run `createStoreWithSchema(graph, adminBackend)`
once under the schema-owner role. It creates the per-field vector tables +
markers; least-privilege runtimes then assert markers (SELECT) and run vector
DML with zero DDL — no `GRANT CREATE` required.

Consumers that boot manually (raw DDL + the sync `createStore` attach +
`backend.ensureRuntimeContributions`) provision vectors the same way: the new
`resolveGraphVectorSlots(graph)` export enumerates every embedding
`(kind, field)` slot, and `backend.ensureVectorSlotContribution(slot)`
materializes each — the exact step `createStoreWithSchema` performs.
