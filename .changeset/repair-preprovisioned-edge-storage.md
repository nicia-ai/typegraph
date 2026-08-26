---
"@nicia-ai/typegraph": patch
---

Version deployment-wide base storage independently of per-graph schemas. A privileged `createStoreWithSchema` or `createAdapterStoreWithSchema` open now adopts the graph-template table and durable edge match-identity storage once, then stamps base-schema version 1; later warm opens perform only a marker read. This repairs externally provisioned 0.51 databases even when their graph schema is unchanged. Zero-DDL verified and graph-template runtime paths fail early with `BaseSchemaMigrationError` until the privileged adoption or published consumer migration has run, while plain edge writes classify legacy missing-column failures as `EDGE_MATCH_IDENTITY_STORAGE_UNAVAILABLE` instead of leaking driver errors.
