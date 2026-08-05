---
"@nicia-ai/typegraph": patch
---

Translate PostgreSQL read-only and missing-`TEMP` failures during graph
analytics into `UnsupportedBackendCapabilityError`, preserving the driver error
as the cause. Both refusal points are covered: a standby that rejects the
read-write working-table transaction, and a role that cannot create the
temporary table inside it.
