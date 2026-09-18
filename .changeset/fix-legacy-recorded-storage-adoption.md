---
"@nicia-ai/typegraph": patch
---

Fix upgrades from legacy databases that lack recorded-node or recorded-edge tables. Version-3 base-schema adoption now creates these tables and their structural indexes before installing changed-since indexes on SQLite and PostgreSQL, preserving existing data and custom table names. Failed upgrades left at base-schema version 2 can retry through normal adoption without an explicit `bootstrapTables()` workaround.
