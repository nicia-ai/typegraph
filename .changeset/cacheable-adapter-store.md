---
"@nicia-ai/typegraph": minor
---

Make verified adapter stores reusable across connections so serverless/edge
deployments that open a fresh database connection per request can verify once
per isolate instead of paying a schema-reconcile round-trip on every request.

`AdapterStore` now exposes `reconciledSchema`, an opaque snapshot of a store's
reconciled (compile-time + runtime-committed) graph and committed schema
version. Pass it to a synchronous `createAdapterStore(graph, backend,
{ reconciled })` — which issues **zero** database queries and still validates
reads and writes against runtime-committed kinds — or call
`store.withBackend(freshBackend)` to rebind an already-verified store onto a new
connection with no re-verify (the store's connection is captured immutably, so
this returns a new equivalent store rather than mutating in place). The new
`getCommittedSchemaVersion(backend, graphId)` reads the committed version with a
single indexed SELECT, the cheap cross-isolate probe for detecting when another
process committed a schema change and the cached snapshot must be refreshed.
