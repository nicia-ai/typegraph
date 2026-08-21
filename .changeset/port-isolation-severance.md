---
"@nicia-ai/typegraph": minor
---

Portable entrypoints no longer reach Drizzle through recorded-time migration, claim comparison, or removal-statement builders. This completes the separation that lets consumers use the ten portable entrypoints without installing `drizzle-orm`; source and packaged-output checks now prevent those imports from returning.

Custom backends that need to migrate the timestamp-only recorded-time preview schema must implement the new optional `GraphBackend.recordedTableDdl(tableNames)` member. It returns backend-owned table and index DDL for the temporary and final recorded-relation names. A migration that reaches the legacy rewrite without this member throws `UnsupportedBackendCapabilityError` with `details.capability: "recordedTableDdl"` instead of importing Drizzle or crashing. See [Migrating Preview Recorded Time](https://typegraph.dev/schema-management#migrating-preview-recorded-time).
