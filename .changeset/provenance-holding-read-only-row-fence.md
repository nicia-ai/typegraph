---
"@nicia-ai/typegraph": minor
---

A read-only `provenance.holding(tx)` (in a transaction opened with `accessMode: "read_only"`) on a backend that declares a `row` write fence is now refused with `UnsupportedBackendCapabilityError` (capability `write transaction access`, `accessMode: "read_only"`) before any statement, on SQLite and PostgreSQL alike, and the transaction stays usable. Under a `row` fence the graph write lock the call takes is an upsert of the graph's fence row: SQLite used to run that write inside the read-only Store transaction, and PostgreSQL rejected it with the driver's own error (`25006`). **Behaviour change:** a read-only `holding(tx)` that answered on a SQLite backend declaring a `row` fence now throws; call `holding()`, or `holding(tx)` in a transaction that can write. The bundled backends' default fences (SQLite's writer slot, PostgreSQL's advisory lock) write no row and are unaffected.
