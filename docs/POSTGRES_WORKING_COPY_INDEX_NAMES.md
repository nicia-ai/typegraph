# Allocation-scoped PostgreSQL graph indexes

PostgreSQL index names are unique within a schema, even when two working
copies use distinct tables. The accompanying collision test proves that
issuing default `CREATE INDEX IF NOT EXISTS` DDL for the same declaration on
two prefixed tables reports success twice but creates only the first index.
The table-backed manager therefore binds distinct physical names to each
allocation. Ordinary backends retain their existing logical names.

## Name contract

`IndexDeclaration.name` remains the graph's logical name. Schema
serialization, schema hashes, graph diffs, `MaterializeIndexesEntry.indexName`,
and application-facing errors continue to use it. The manager maps the
allocation prefix and `(entity, kind, logical name)` to a stable physical
PostgreSQL identifier. It uses a digest, checks the 63-byte identifier limit,
and rejects duplicate resolved names and system-index collisions before
provisioning. Reopen recomputes the map from the allocation ID and attested
graph. The manager binds it only to the exact provisioned, fixed-schema, and
managed-close backend objects that may materialize the copy's indexes.

| Surface | Ordinary backend | Managed copy |
| --- | --- | --- |
| `indexes/ddl.ts` | Logical declaration name | Physical DDL identifier; declaration unchanged |
| `indexes/drizzle.ts` and `createPostgresTables` | Logical bootstrap builder name | Optional physical builder name when supplied |
| `store/materialize-indexes.ts` | Logical catalog and status key | One physical key through lookup, build, claim, retry, and repair |
| PostgreSQL copy manager | No allocation | Builds all declared relational indexes before sealing and aborts on failure |

The status row uses the physical name as its key for a table-backed copy. The
claim lease, status preload, catalog lookup, and repair therefore use one
identity. `computeIndexSignature` still hashes the physical target table and
canonical declaration, so a schema change cannot be hidden by renaming an
index. Vector indexes remain a separate storage concern.

## Lifecycle boundaries

1. The allocator provisions its owned base tables and system indexes. It
   suppresses a connected backend's bootstrap DDL, so Drizzle graph-index
   extras cannot introduce globally named indexes on the private tables.
2. The clone leaves source materialization rows behind. It materializes every
   declared relational index on the target. Any `failed` or `skipped` entry
   aborts allocation and removes its owned tables.
3. Durable reopen rebinds the same map to a fresh backend after checking its
   table bindings and database ownership token. `materializeIndexes()` can
   repair an absent or invalid index under the existing claim protocol.
4. The fixed-schema guard still refuses evolution and kind removal. The copy
   may retry only indexes declared in its fixed graph. Destroy drops the
   owned tables and their indexes together.

The PostgreSQL suite covers two copies of one graph, B-tree and GIN
declarations, long and quoted logical names, source indexes already
materialized, fresh-manager durable reopen, idempotent retry, repair after a
physical index is dropped, independent destroy, ephemeral cleanup, and failed
DDL cleanup. The default PostgreSQL backend and SQLite retain their existing
names. Namespace-fork preparation still requires default table bindings; it
does not accept a table-backed copy as its source or target. Vector tables and
indexes remain outside this allocation-scoped relational-index contract.
