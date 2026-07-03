---
"@nicia-ai/typegraph": patch
---

perf: eliminate the PostgreSQL JSONB parse→stringify→parse round trip per row. Backend rows now carry `props` as `RowProps` (JSON text on SQLite, the driver-parsed object on PostgreSQL); consumers normalize at the point of use via the new `rowPropsToObject`/`rowPropsToJsonText` helpers instead of re-serializing in the row mapper and re-parsing downstream.
