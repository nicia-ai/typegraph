---
"@nicia-ai/typegraph": patch
---

Translate PostgreSQL read-only and missing-`TEMP` failures at graph-analytics
working-table creation into `UnsupportedBackendCapabilityError`, preserving the
driver error as the cause.
