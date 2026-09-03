# Identity maintenance lock-order audit

Identity work follows the order in
`packages/typegraph/src/store/operations/write-transaction.ts`: schema-version
fence, graph-write lock when required, identity lock, row work, then recorded
clock. An optional earlier lock may be omitted; acquiring it **after** the
identity lock is not an exemption. Re-entering an already-held lock on the same
transaction does not change its acquisition order.

## Maintenance callers

The five `lockIdentityGraph` calls in `identity/service-maintenance.ts` have
these owners:

| Helper | Production callers | Fence and disposition |
| --- | --- | --- |
| `rebuildIdentityClosureForContext` | `Store.rebuildIdentityClosure` | The Store opens `runInWriteTransaction`, which validates the Store's schema version before the helper takes the identity lock. History/revision settings determine whether a graph-write lock is also required. The derived-only rebuild never advances content revision. |
| `rebuildIdentityClosureForContext` | `identitySchemaCommitPreflight` | The backend's schema commit owns the schema fence; the preflight acquires graph-write, then identity, before rebuilding. The rebuild's identity acquisition is reentrant. |
| `rebuildIdentityClosureForContext` | `prepareStoreWithSchema`'s derived-relation repair callback | The callback opens or adopts a write transaction and fences the schema version used to build its registry. This applies both to an existing relation needing repair and to atomic CREATE+FILL under `schemaWriteTransaction`. It takes identity only after that version check. |
| `validateIdentityForContext` | Startup validation through `Store.validateIdentity` | Read-only exception: an independent transaction takes identity, reads ledger/nodes/closure/separation, and returns. It never acquires schema, graph-write, DDL, or recorded-clock locks, and never repairs. It can report a contradiction against a stale caller registry; it cannot persist one. |
| `assertAffectedIdentityClassesConsistent` | Both merge appliers through the Store runtime port | Uses the merge's already-fenced transaction. The rebuild-and-recheck stays in that transaction and does not enter another write frame. |
| `foldIdentityForCreatedNodes` | Node create/batch/upsert/resurrection and interchange import | Node operations and import acquire their write fences and identity lock before row work. The fold re-enters identity on that same target. |
| `detachIdentityForNode` | Node soft/hard delete, including delete cascades | Uses the node operation's already-fenced target and re-enters identity; assertion endings and closure repair remain inside the delete transaction. |

`withRecordedIdentityMutationTarget` does not acquire a later graph-write lock:
it unwraps the existing capture binding and records touches. Its raw target is
in the same transaction. Derived closure/separation rewrites do not themselves
write the recorded assertion clock.

`removeIdentityKindsForContext` has no separate bare-lock path. Its
`runIdentityMutation` owner enters `runInWriteTransaction` before identity.
`Store.removeKinds` invokes it inside the schema-commit transaction.

## Schema-transition callers

`identitySchemaCommitPreflight` is derived by schema initialization, schema
migration/ensure, and Store evolution. `identityKindCascadePreflight` is derived
by schema migration when identity is disabled but retained assertions still
reference removed kinds. Both run inside `commitSchemaVersionWithPreflight`:
the backend acquires its schema-commit fence before invoking the preflight,
and the preflight takes graph-write before identity. A custom implementation
must honor that backend contract.

When derived-relation DDL is required, its database-wide identity-DDL lock is
inside the schema-commit fence and outside graph-write/identity locks. Startup
CREATE+FILL uses the same ordering under `schemaWriteTransaction`; its repair
callback checks the previously observed schema version before identity work.
No identity maintenance helper acquires the DDL lock or another graph's schema
fence while holding identity.

## Defect found and repaired

A bare identity lock serialized startup repair against other identity writers
but did not bind the repair's registry to the schema it would overwrite:

1. An opener reads schema version 1 with same-id folding enabled and finds a
   missing or unfilled separation relation.
2. Another opener migrates to version 2 with folding disabled, committing an
   unfolded closure.
3. The old opener enters repair after that migration and rebuilds the closure
   using version 1's folding rule.

The result was a durable folded closure under a schema that disabled folding,
even if the stale opener failed later. A transaction alone does not prevent
this ordering, including on SQLite. The startup callback now uses the shared
schema-version write fence and refuses with `StaleVersionError` before identity
mutation if the migration won.

`identity-maintenance-schema-race.test.ts` schedules the migration between
startup inspection and the repair transaction for both existing and missing
separation relations, using the same cases on SQLite and PostgreSQL. It checks the typed refusal and the committed closure.
Removing the startup write-frame fence makes the regression fail.

Existing `write-plan-statement-order.test.ts` covers node, import, identity
assertion and public rebuild ordering. `identity-separation-upgrade-heal.test.ts`
covers successful repair, refused migrations and atomic provisioning.
`identity-adopted-transaction.test.ts` covers the separate SQLite DEFERRED-frame
limitation: a stale writer-slot upgrade is refused and must be retried in a new
transaction. This audit does not change that contract.
