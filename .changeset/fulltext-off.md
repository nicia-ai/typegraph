---
"@nicia-ai/typegraph": minor
---

`createPostgresBackend` and `createSqliteBackend` accept `fulltext: false`,
mirroring the existing `vector: false` option. The backend then advertises
no `capabilities.fulltext` and omits the fulltext CRUD/search members
(`upsertFulltext`, `deleteFulltext`, `upsertFulltextBatch`,
`deleteFulltextBatch`, `fulltextSearch`) along with `hybridSearch` and
`fulltextStrategy` instead of stubbing them, and the generated DDL and
runtime contributions never create a fulltext table for that backend.

A fulltext predicate, a `searchable()` field, `store.search.fulltext`, and
hybrid search all refuse with `UnsupportedBackendCapabilityError` (reason
`fulltext_unsupported`) against a fulltext-off backend, instead of compiling
SQL against a table that does not exist. `hardDeleteNode`'s cascade skips
the fulltext delete for such a backend rather than issuing a statement
against a missing table; every other cascade step, and every configuration
that still has a fulltext strategy, is unchanged.

This refusal is not limited to the bundled backends: any `GraphBackend` —
including a third-party one — that omits the optional fulltext members now
refuses a write to a node kind with `searchable()` fields with the same
typed error, rather than silently skipping the fulltext index sync as it
did before.

The read path keys off `capabilities.fulltext` rather than the optional
members: a third-party `GraphBackend` that implements `fulltextSearch` and/or
sets `fulltextStrategy` but never declares `capabilities.fulltext` now has a
fulltext predicate and `store.search.fulltext`/hybrid refuse with
`UnsupportedBackendCapabilityError`, where before they compiled and ran. This
also replaces the `ConfigurationError` those two call sites previously threw
against a backend with no fulltext strategy at all — callers catching on the
old class or error code should switch to `UnsupportedBackendCapabilityError`.

`capabilities.contributions.rebuild` on a fulltext-off backend tracks only
the transactional-fence condition — with no fulltext contribution to fail
the check, that condition is vacuously satisfied — and a `rebuildContribution`
call naming the fulltext contribution on such a backend refuses with a typed
`ContributionRebuildUnsupportedError` instead of running DDL against nothing.

Soft-deleting or hard-deleting a `searchable()` node now succeeds on a
fulltext-off backend instead of refusing: a delete removes data rather than
accepting a write the backend cannot index, and this backend maintains no
fulltext sidecar to issue that removal against, so there is nothing to do.
Only create and update of a `searchable()` kind refuse.

`createLocalSqliteBackend`, `createLocalPgliteBackend`, `createLocalSqliteStore`,
and `createLocalPgliteStore` accept the same `fulltext?: FulltextStrategy | false`
option and forward it to both their installation DDL and the underlying
backend factory, so a batteries-included store can skip the fulltext table
the same way a hand-wired one can.

**Upgrade note:** `fulltext: false` stops creating and maintaining the
fulltext table; it never drops one. On a database that already has fulltext
rows, disabling fulltext leaves them in place and unmaintained — a hard
delete performed while fulltext is off leaves an orphaned row behind in the
fulltext table, because `hardDeleteNode`'s cascade has no active strategy to
build a delete statement from. Re-enabling fulltext later therefore requires
the destructive contribution rebuild, `store.rebuildContribution("fulltext")`
(which drops and recreates the fulltext table), not
`store.search.rebuildFulltext()`: that method pages live nodes to recompute
their content, and a hard-deleted node has no row left for it to page, so it
never revisits — and therefore never clears — the orphan.
