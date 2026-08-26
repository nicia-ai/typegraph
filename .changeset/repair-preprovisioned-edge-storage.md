---
"@nicia-ai/typegraph": minor
---

Existing databases must be opened once through privileged `createStoreWithSchema` / `createAdapterStoreWithSchema`, or receive the published base-schema migration, before zero-DDL verified and graph-template runtime paths are used. Those paths now fail early with `BaseSchemaMigrationError` until deployment-wide base storage is stamped at version 1.

Version deployment-wide base storage independently of per-graph schemas. A privileged open adopts the graph-template table and durable edge match-identity storage once, then stamps the marker; later warm opens perform only one marker read. This repairs externally provisioned 0.51 databases even when their graph schema is unchanged. Plain edge writes also classify legacy missing-column failures as `EDGE_MATCH_IDENTITY_STORAGE_UNAVAILABLE` instead of leaking driver errors.

Fresh SQLite and PostgreSQL installation SQL now publishes the current base-schema marker as its final statement, so zero-DDL verified stores and graph-template APIs can attach immediately after applying TypeGraph's generated migration. Concurrent adoption accepts a marker already advanced beyond the step it completed and never downgrades it.
