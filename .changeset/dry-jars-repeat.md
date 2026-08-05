---
"@nicia-ai/typegraph": minor
---

Add a database-level contradiction backstop for Operational Identity.

A `different` assertion and a `same` assertion that would place both of its
endpoints in one identity class are a contradiction, and until now only
application code stood between such a write and a committed graph: the
plan-time simulation and the identity applier's validation both decide by
reading state and comparing, so a bug in either commits the contradiction
silently.

Identity now also maintains a derived **separation relation** — one row per
pair of identity classes a current `different` assertion holds apart, keyed by
the two class keys under a `CHECK (class_key_low < class_key_high)`
constraint. Every transaction that fuses two classes relabels the affected
separation rows in the same statement batch, so fusing two separated classes
relabels both sides of their shared row to one key and the database aborts the
transaction. A write that reached the ledger through a path that skipped
identity validation can no longer commit a contradictory graph; it fails with
the new typed `IdentitySeparationViolationError`.

The relation is derived and requires no application changes: it is maintained
wherever the identity closure is (assert, retract, fold, delete, merge,
import, rebuild), `rebuildIdentityClosure(store)` recomputes it from the
assertion ledger, and store-open identity validation checks it against that
recomputation.

Upgrading an existing identity-enabled database needs no manual step. A store
opened with `createStoreWithSchema` / `createAdapterStoreWithSchema` creates
the new `typegraph_identity_separation` relation through the same idempotent
identity DDL path as the other identity relations and recomputes it from the
ledger once, before anything reads it. A missing assertion ledger or closure
relation is still refused as data loss.

Custom backend authors: the resolved table-name types (`ResolvedSqlTableNames`,
`SqliteTableNames`, `PostgresTableNames`) and the `ensureIdentityTables`
parameter each gained a required `identitySeparation` entry, so an
implementation that builds one of those objects needs the new name added. Code
that only reads `backend.tableNames`, or that passes a partial name override to
`createSqliteTables` / `createPostgresTables` / `createSqlSchema`, is
unaffected — an omitted name still resolves to the default
`typegraph_identity_separation`.
