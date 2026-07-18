---
"@nicia-ai/typegraph": patch
---

Restore graph algorithms on Cloudflare Durable Objects SQLite. The
auto-detected `do-sqlite` profile now marks temporary-table graph analytics as
unsupported, routes shortest-path and reachability algorithms through their
inline fallback, and rejects temporary-table-only algorithms with the existing
typed capability error instead of leaking workerd's `SQLITE_AUTH` failure.
