---
"@nicia-ai/typegraph": patch
---

Make in-memory libsql databases safe across transactions, and fail loud on
re-entrant root access. Local `@libsql/client` connections (`file:` paths and
`file::memory:`) now frame transactions with raw `BEGIN IMMEDIATE`/`COMMIT` on
the client's single stable connection instead of `client.transaction()`, which
permanently hands that connection to the transaction and lazily opens a fresh —
for `:memory:`, empty — database afterwards
(tursodatabase/libsql-client-ts#229). Remote Turso connections keep using the
driver's per-stream transactions. Separately, a store-level operation awaited
from inside a `store.transaction` callback on the same SQLite backend (root
store instead of the `tx` context) used to deadlock permanently — the open
transaction holds the backend's serialized execution slot — and is now rejected
with a `ConfigurationError` that points at the transaction-scoped context.
