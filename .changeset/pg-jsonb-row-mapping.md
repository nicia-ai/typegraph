---
"@nicia-ai/typegraph": minor
---

perf: eliminate the PostgreSQL JSONB parse→stringify→parse round trip per row.

**Public backend row contract change:** rows returned by `GraphBackend` read methods now carry `props` as `RowProps = string | Readonly<Record<string, unknown>>` — JSON text on SQLite, the driver-parsed object on PostgreSQL. Code that consumed backend rows directly with `JSON.parse(row.props)` must switch to the new `rowPropsToObject(row.props)` (or `rowPropsToJsonText` when text is required); both helpers and the `RowProps` type are exported from the package root. Store-level APIs (`store.nodes.*`, `store.query()`, search, export) are unaffected — they already return parsed objects.
