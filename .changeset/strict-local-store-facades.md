---
"@nicia-ai/typegraph": patch
---

Add declaration-isolated `core`, `sqlite/local-store`, and
`postgres/pglite-store` entrypoints for strict local database consumers. The
shared typed CRUD facade preserves schema-derived node, edge, endpoint, and
property types without loading unused Drizzle dialect declarations or requiring
unrelated database drivers.
