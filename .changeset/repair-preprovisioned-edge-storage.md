---
"@nicia-ai/typegraph": patch
---

Adopt the 0.52 edge match-identity columns, pair constraint, and unique index whenever a bundled database is opened through the privileged `createStoreWithSchema` or `createAdapterStoreWithSchema` path. Pre-provisioned 0.51 base tables now upgrade even when the graph schema is unchanged and does not declare `matchIdentity`, preventing the first 0.52 edge write from failing with a missing-column database error. Zero-DDL runtime factories remain unchanged.
