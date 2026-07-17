---
"@nicia-ai/typegraph": patch
---

Cap SQLite-backed Durable Object statements at Cloudflare's 100-bound-parameter
limit. Structural client detection now makes platform identity authoritative
over stale execution hints, and capability overrides cannot raise the hard
ceiling. Recorded-history capture and every capability-driven SQLite batch path
chunk large writes before workerd rejects the query, while SQLite literal list
predicates use one JSON-bound parameter instead of one bind per element.
