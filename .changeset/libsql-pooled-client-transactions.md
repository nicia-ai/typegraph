---
"@nicia-ai/typegraph": patch
---

Support `@libsql/client` 0.18 local clients. From 0.18 a local client pools its connections and rolls back any transaction a single `execute()` leaves open, so the raw `BEGIN`/`COMMIT` framing used for local clients failed every transaction with "no transaction is active". `createLibsqlBackend()` now probes whether a local client's `execute()` calls share one session and frames transactions through `client.transaction()` when they do not; clients before 0.18 keep raw `BEGIN`/`COMMIT`.
