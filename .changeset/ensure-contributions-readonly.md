---
"@nicia-ai/typegraph": patch
---

Fix `ensureRuntimeContributions` running marker-table DDL on every store
open (#149).

`createStoreWithSchema` → `ensureRuntimeContributions` previously ran the
`typegraph_contribution_materializations` marker DDL
(`ensureMarkerTable()` → `CREATE TABLE IF NOT EXISTS …`) on **every** open
for any graph with runtime contributions (e.g. `searchable()` fields),
even when every contribution was already materialized. The per-materializer
`initializedGraphIds` cache is per-instance, so a deployment that builds a
fresh backend per request (the norm on serverless Postgres) got an empty
cache each time and re-ran the DDL on every open — which intermittently
fails on connections that can't run it (observed on Cloudflare Workers +
the Neon serverless driver) and surfaces as a wrapped `DrizzleQueryError`
rather than a clean `MigrationError`.

`ensureRuntimeContributions` now does a read-only pre-check first, mirroring
the SELECT-only `assertInitialized`: when every runtime contribution is
already materialized (marker present, signature matches, no recorded error)
it returns without `ensureMarkerTable()` / `materializeOne`. A missing
marker table, or any missing/stale/failed contribution, still falls through
to the unchanged privileged first-materialization path. Warm per-request
opens are now DDL-free.

Note: the canonical runtime attach for the least-privilege / per-request
deployment model remains `createVerifiedStore` (zero DDL by construction);
`createStoreWithSchema` also runs bootstrap and auto-migration DDL and is
still intended to run once under a privileged role. This change is
defense-in-depth for the marker DDL specifically.
