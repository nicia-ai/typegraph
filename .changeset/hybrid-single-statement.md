---
"@nicia-ai/typegraph": minor
---

perf: `store.search.hybrid` now runs as a single SQL statement on the built-in backends — both sources, weighted RRF fusion, liveness, and node hydration composed into one round trip (previously two search statements plus an id-hydration fetch, with fusion in JS). Results are identical to the previous path; the saving scales with per-statement cost (serverless drivers, D1/Durable Objects, remote databases). `GraphBackend` gains an optional `hybridSearch` member; backends without it (custom backends, capability profiles without window functions) keep the multi-statement fallback.
