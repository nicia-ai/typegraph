---
"@nicia-ai/typegraph": minor
---

Harden adapter capability surfaces and document their migrations.

This is source-breaking for adapter code that reads `tx.sql` without first
narrowing `tx.sqlAvailability === "available"`: non-available union arms now
omit `sql` instead of exposing it as an optional `never`/`undefined` property.
The runtime history and revision-tracking guards remain fail-loud for JavaScript
and type-suppressed callers.

Add `openProvenanceStore(targetStore)` as the preferred graph-merge provenance
API while retaining `openProvenanceStore(backend, targetGraphId)` for standalone
inspection tools. On Cloudflare D1 and Durable Object SQLite, ignore only a
recognized `SQLITE_AUTH` rejection of the performance-only `analysis_limit`
PRAGMA and continue with scoped `ANALYZE`; unexpected maintenance failures stay
visible.
