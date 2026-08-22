---
"@nicia-ai/typegraph": patch
---

Reduce a successful generated-ID `cardinality: "many"` edge create to one endpoint-validated INSERT on bundled SQLite and PostgreSQL backends, avoiding two endpoint read round trips while preserving portable fallback behavior and typed endpoint diagnostics.
