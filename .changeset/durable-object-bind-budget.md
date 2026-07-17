---
"@nicia-ai/typegraph": patch
---

Cap SQLite-backed Durable Object statements at Cloudflare's 100-bound-parameter
limit. The resolved `do-sqlite` execution profile now advertises the platform
ceiling, so recorded-history capture and every capability-driven SQLite batch
path chunk large writes before workerd rejects the query.
