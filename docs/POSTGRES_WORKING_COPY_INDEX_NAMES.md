# Allocation-scoped PostgreSQL graph indexes

Issue #755's table-backed manager currently refuses graphs with declared indexes.
The refusal is necessary even when each copy has distinct table names:
PostgreSQL index names are unique within a schema. The accompanying PostgreSQL
test creates the same declared index on two prefixed tables using the current
runtime DDL. `CREATE INDEX IF NOT EXISTS` reports success for both statements,
but the index exists only on the first table. `createPostgresTables(...,
{ indexes })` also emits the declaration's name for both tables.

## Required name contract

Keep `IndexDeclaration.name` as the graph's **logical** name. Schema
serialization, schema hashes, graph diffs, `MaterializeIndexesEntry.indexName`,
and application-facing errors must continue to use it. A manager-owned
resolver must map `(allocation identity, entity, kind, logical name)` to a
stable **physical** PostgreSQL identifier of at most 63 bytes. Generate it
from the attested allocation prefix and a collision-resistant digest; reject
duplicate resolved names and collisions with the allocated tables' system
indexes before provisioning. The mapping must be reproducible from the ledger
on reopen and must never depend on a process-local counter. Only the manager's
exact backend object and its intentionally derived close wrapper may carry
this allocation binding.

One resolver must decide every physical graph-index name. The relevant consumers are:

| Surface | Current use of the logical name | Required use of the resolved name |
| --- | --- | --- |
| `indexes/ddl.ts` | `CREATE INDEX` for B-tree and GIN-family indexes | DDL identifier, with declaration unchanged |
| `indexes/drizzle.ts` and `createPostgresTables` | Drizzle bootstrap index builders | Builder identifier when an allocation namespace is supplied |
| `store/materialize-indexes.ts` | Catalog preloads, INVALID-leftover checks, cleanup, claim and status keys | The same physical key throughout check, build, record, retry, and drop |
| `graph-merge/namespace-fork.ts` | Resolves copied status rows and replays relational DDL | Resolve source status keys and target DDL against their respective backend bindings |
| PostgreSQL copy manager | Skips source `indexMaterializations` rows | Rebuild all target indexes under resolved names before sealing; fail and clean up on any failed entry |

The status row should use the physical name as its key for a table-backed copy.
This keeps the claim lease, status preload, catalog lookup, and invalid-index
repair on one identity. User-facing results still report the logical
declaration name. `computeIndexSignature` already includes the physical target
table and the canonical declaration; it must continue to detect shape drift
without rewriting the graph schema. Vector indexes remain a separate storage
problem.

## Lifecycle checks before enabling indexes

1. Provision only owned base tables and system indexes. Do not let a caller's
   Drizzle `indexes` extras create graph indexes under global logical names
   during bootstrap. Bind the physical resolver to the actual target backend
   before any TypeGraph materialization call.
2. Clone graph-scoped rows as today, leaving source physical-name
   materialization rows behind. Materialize every declared relational index
   on the target tables before returning or sealing the copy. Treat `failed`
   or `skipped` entries as allocation failure and run the existing abort cleanup.
3. On durable reopen, derive the same resolver from the ledger, verify the
   connected backend's table map and allocation database, and check that any
   recorded index name belongs to the allocated node or edge table. Dropping
   an allocation's tables must remove its physical indexes; the ledger
   remains the authority for recovery.
4. Keep the fixed-schema guard. Later `Store.materializeIndexes()` may retry
   or repair **only** the indexes declared in the attested schema. An
   undeclared logical name must refuse before DDL or status writes. Schema
   evolution and kind removal still refuse until their new physical-storage
   lifecycle is designed.

## Conformance cases

Two live copies of the same graph must each have a distinct physical index on
its own prefixed table and still report the same logical declaration and schema
hash. Cover B-tree and GIN-family declarations, custom or long quoted names,
index name collisions, source indexes already materialized, a fresh target with
no source status row, idempotent retries, interrupted concurrent builds with
INVALID leftovers, durable close/reopen, abort/destroy cleanup, and
namespace-fork replay from a managed copy. Mutation checks should show that
replacing a resolved name with `declaration.name` in either DDL or
catalog/status handling fails a focused test. The default backend and SQLite
paths must retain their existing names and behavior.

Until these surfaces share one resolver and the lifecycle cases pass, the
table-backed manager's graph-index refusal remains in place. A host-level
database fork preserves the source's physical indexes without renaming them,
subject to that host's fork and connection isolation guarantees.
