---
"@nicia-ai/typegraph": minor
---

Add a per-search `efSearch` knob for tuning pgvector HNSW recall (#148).

`store.search.vector` and the vector half of `store.search.hybrid` now
accept an optional `efSearch` — the HNSW search frontier
(`hnsw.ef_search`, default 40). pgvector caps a single index scan at
`ef_search` candidates, so the hybrid over-fetch (`vectorK = 4 * limit`
by default) silently under-delivers once `vectorK` climbs past the
session default; the floor is `efSearch >= vectorK` and ~2–4× is the
high-recall target. Being per-search lets one connection pool serve both
a latency-sensitive interactive path and a recall-sensitive batch path.

The Postgres backend applies it transaction-locally
(`SET LOCAL hnsw.ef_search`) around the vector `SELECT`, so it never
leaks to the next query on a pooled connection — `SET LOCAL` issued in
autocommit would roll off with the statement and the next pooled query
would see the session default. Omitting `efSearch` opens no transaction
and preserves today's behavior exactly. Validated as a positive integer
≤ 1000 (pgvector's ceiling).

Scope: pgvector HNSW only. sqlite-vec has no equivalent frontier knob
and treats it as a no-op; transaction-less Postgres drivers
(`drizzle-orm/neon-http`) ignore it with a one-time warning. IVFFlat's
`ivfflat.probes` is a follow-up.
