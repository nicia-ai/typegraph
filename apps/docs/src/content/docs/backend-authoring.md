---
title: Authoring an engine profile
description: Derive a variant of a bundled SQL engine profile, what building one from scratch still requires, and the write and delete port contracts a custom backend implements
---

[Backend Setup](/backend-setup) covers using the two bundled backends.
This page is for adapting one: changing a lock spelling, loosening a
declared capability, or swapping the resource-audit verdict without
hand-copying every other field a profile carries. A backend written by hand
implements the store's write and delete ports directly; their contracts are
in [Write and delete port contracts](#write-and-delete-port-contracts).

## Stability

The backend authoring surface is not covered by semver. Everything exported
from `@nicia-ai/typegraph/backend` and
`@nicia-ai/typegraph/adapters/drizzle/engine` (the backend, dialect,
SQL-fragment, fulltext and vector strategy contracts, engine profiles and
their derivation) may change in any release, including a patch release,
without a deprecation period. The release notes list such changes, but they
are not breaking changes in the semver sense.

The supported backends are the first-party ones: the bundled SQLite backends
(better-sqlite3, libSQL, and any Drizzle SQLite driver through
`createSqliteBackend`) and PostgreSQL backends (any Drizzle Postgres driver
through `createPostgresBackend`, and PGlite). A backend you build or derive
yourself is yours to keep working across upgrades: pin the TypeGraph version
it was written against and re-run its tests before taking a new release.

The application API is covered by semver as usual. It is the package root,
`@nicia-ai/typegraph`, and these subpaths: `/store`, `/query`, `/errors`,
`/identity`, `/maintenance`, `/core`, `/schema`, `/indexes`,
`/graph-extension`, `/graph-merge`, `/interchange`, `/profiler`,
`/provenance`, `/sqlite/local`, `/postgres/pglite`, `/adapters/drizzle/sqlite`,
`/adapters/drizzle/sqlite/local`, `/adapters/drizzle/sqlite/libsql`,
`/adapters/drizzle/postgres`, `/adapters/drizzle/postgres/working-copy`,
`/adapters/drizzle/postgres/pglite` and `/adapters/drizzle/indexes`. The
authoring entrypoints, `/backend` and `/adapters/drizzle/engine`, are not part
of it. Using a first-party backend through the application API never depends
on the authoring surface staying stable.

## What a profile is

A `SqlEngineProfile` is the data and dialect closures one SQL engine
contributes before any backend object exists: dialect tokens, the
execution adapter, transaction framing, DDL provisioning, strategies,
capability declarations, and an opaque `assembly` wrapping the
operation-backend builder. `createSqlBackend` is the one factory that
turns a profile into a `GraphBackend`, and it owns everything that is the
same for every engine:

- **Capability derivation** — running the shared capability tail
  (atomic-batch detection, vector/fulltext capability shape,
  contribution-rebuild support) over the profile's own
  `declaredCapabilities`.
- **Fence resolution** — building the one write-fence target for the
  whole backend and resolving its plan once, so every lock site and every
  transaction-scoped handle agrees on the same decision.
- **Member assembly** — resolving the profile's `assembly` into its
  operation-backend builder and late-member factory, then assembling the
  mirrored member groups (contribution, identity, graph-template,
  base-schema, index-materialization, kind-removal, schema-version).
- **Marks** — auditing the backend's resource shape and applying the
  trust marks (root-autocommit eligibility, schema-fenced-insert
  eligibility, first-party standing) that gate optimizations elsewhere.

`createPostgresBackend` and `createSqliteBackend` are each `createSqlBackend`
applied to a profile the bundled builders produce.

## The derivation path

```typescript
import {
  buildPostgresEngineProfile,
  createSqlBackend,
  deriveEngineProfile,
} from "@nicia-ai/typegraph/adapters/drizzle/engine";

const baseProfile = buildPostgresEngineProfile(db, options);

const derivedProfile = deriveEngineProfile(baseProfile, {
  // one or more of the derivable fields below
});

const backend = createSqlBackend(derivedProfile);
```

`buildPostgresEngineProfile` and `buildSqliteEngineProfile` are the
derivation base: they build a real profile against a real connection,
exactly the way `createPostgresBackend` / `createSqliteBackend` do
internally. `deriveEngineProfile(base, overrides)` returns a fresh
profile — `{...base, ...overrides}` — with `overrides` restricted to the
fields listed below. `createSqlBackend` then assembles a backend from
the result through the exact same path a bundled profile takes.

If your own module re-exports a derived profile as an inferred-typed
`const`, give it an explicit `SqlEngineProfile<TTx>` annotation — the
opaque `assembly` field's internal brand is not itself exported, so
`tsc` cannot name it in a declaration file it has to infer.

## What you can override

Each field below is read directly off the profile object (or off the
`assembly`-derived context) by exactly one place in `createSqlBackend`,
with the one carve-out below — so overriding it changes the whole backend
consistently.

| Field | What overriding it changes |
| --- | --- |
| `declaredCapabilities` | The capabilities `finalizeEngineCapabilities` derives the rest of the backend's advertised capabilities from — for example, declaring `writeFence` differently changes which write-fence plan resolves. |
| `fenceSql` | The lock-statement spelling the resolved fence plan carries; pass `undefined` to remove it entirely (see [Removing `fenceSql`](#removing-fencesql) below). |
| `resourceAudit` | The serialized-resource verdict `createSqlBackend` records before the backend escapes. |
| `autocommit` | Whether a single statement outside an explicit transaction is durable — gates the root-autocommit mark. |
| `contributionRuntime` | Deps for the contribution-marker member group. |
| `identityRuntime` | Deps for the identity / recorded-relation member group. |
| `graphTemplateRuntime` | Deps for the graph-template member group. |
| `baseSchemaRuntime` | Deps for the base-schema lifecycle member group. |
| `indexMaterializationRuntime` | Deps for the index-materializations member group. |
| `kindRemovalRuntime` | Deps for the kind-removals member group. |
| `close` | The backend's `close` member. |

`DERIVABLE_ENGINE_PROFILE_KEYS` (exported alongside `DerivableEngineProfileKey`
and `DerivableEngineProfileOverrides<TTx>`) is the exact set above, as an
`as const` array.

### Base-schema adoption DDL (`baseSchemaRuntime`)

`baseSchemaRuntime` carries the DDL each numbered base-schema adoption step
runs (see [Upgrading deployment-wide base
storage](/backend-setup/#upgrading-deployment-wide-base-storage)). Members a
release added after profiles already existed are optional, so a profile written
before them still constructs; the adoption step that needs a missing member is
where its absence is an error. Version 9 reads three of them:

| Member | What it holds |
| --- | --- |
| `ensureRecordedAnchorRetentionStorage` | An async function taking `clockProvisioned: boolean` that makes the recorded clock relation carry its nullable `anchor_retention` column. It creates the relation first when `clockProvisioned` is `false` (offline adoption never ran the generated DDL) and only adds the column when it is missing. |
| `identityTransitionsTableDdl` | The identity transition log's idempotent `CREATE TABLE`, followed by its `CREATE INDEX` statements, in run order. |
| `identityTransitionRetentionTableDdl` | The retention watermark relation's idempotent `CREATE TABLE`. |

Render the two DDL members from your dialect's own DDL generators over the
profile's table bindings, as the bundled profiles do, so a custom table name
reaches the statements, and implement the retention function against the same
recorded-clock binding. A derived profile that leaves `baseSchemaRuntime` alone
keeps the bundled members; one that replaces it must carry all three over. When
any is absent, version-9 adoption refuses with a `ConfigurationError` whose
`details.missingDependencies` names every missing member (all three, for a
profile that supplies none) and `details.adoptionVersion` is `9`; the check runs
before any half of the step, so nothing is created or stamped and adoption
retries from version 8 once the profile supplies them. Bootstrapping a database
whose recorded clock already exists needs only
`ensureRecordedAnchorRetentionStorage` and refuses the same way naming just that
member. A profile whose adoption-step registry
stops below the current version fails to construct with
`CompilerInvariantError` ("adoption registry must end at the current version").

### The adapter-backed carve-out

`declaredCapabilities` and `resourceAudit` are otherwise freely derivable,
but `deriveEngineProfile` refuses an override that would change three of
their sub-fields — `declaredCapabilities.maxBindParameters`,
`declaredCapabilities.execution.interactiveTransactions`, and
`resourceAudit.kind` — away from the base profile's own value, naming the
sub-field (`ENGINE_PROFILE_OVERRIDE_UNSUPPORTED`). This check runs against
any base profile, PostgreSQL or SQLite, but it exists for the bundled
PostgreSQL builder: `buildPostgresEngineProfile` reads those exact three
sub-values to compute its execution adapter's own options before the
profile object exists, baking a copy of each into `profile.execution`,
which is not itself derivable. Deriving from a SQLite base refuses the same
override even though `buildSqliteEngineProfile`'s operation backend reads
`maxBindParameters` off the resolved capabilities directly and would honor
a changed value — the check does not distinguish the two dialects. Every
other sub-field on both objects — `writeFence`,
`windowFunctions`, `clearValidTo`, `returning`, `claims`, `graphAnalytics`,
`resourceAudit`'s `resource` / `identityLeaseResource`, and so on — stays
freely derivable.

## What you cannot override

Every other field is refused for one of these reasons: most are captured by
more than the profile's head alone, so overriding only the head would leave
`buildOperations`, `lateMembers`, or a member group they build reading the
value the base builder closed over; `dialect` and `assembly` are refused for
different reasons of their own (see the table).

| Field | Why it's refused |
| --- | --- |
| `dialect` | The operation backend literal hardcodes it. |
| `tableNames` | Captured by `buildOperations` and every transaction handle. |
| `execution` | Captured by `buildOperations` and every transaction handle. |
| `strategy` | Captured by `buildOperations` and every transaction handle. |
| `fulltext` | Captured by `buildOperations` and every transaction handle. |
| `vector` | Captured by `buildOperations` and every transaction handle. |
| `provisioning` | `ensureTable`, `catalog`, and `lineage` are all captured by migrations and transaction handles. |
| `assembly` | Opaque and bundled-only; a derived profile carries the base's `assembly` forward by reference, so it resolves to the identical `buildOperations` / `lateMembers` pair the base builder closed over. |

An override naming any of these throws `ConfigurationError` with code
`ENGINE_PROFILE_OVERRIDE_UNSUPPORTED`, naming the key, whether or not the
type would have allowed it — the check runs against the overrides
object's own keys at runtime, not only its declared type.

These refusals are `deriveEngineProfile`'s contract, not `createSqlBackend`'s.
A profile spread by hand (`{ ...base, execution: mine }`) carries the base's
`assembly` by reference, so `createSqlBackend` accepts it and applies the
override to some members while others keep the builder's value — exactly the
split the refusal exists to prevent. Derive through `deriveEngineProfile`.

## Worked example: a custom advisory-lock spelling

An engine that spells its advisory lock differently from the bundled
`pg_advisory_xact_lock(hashtext($namespace), hashtext($key))` form —
hashing one concatenated string instead of two separate arguments —
derives a `FenceSql` and passes it as an override:

```typescript
import {
  buildPostgresEngineProfile,
  createSqlBackend,
  deriveEngineProfile,
} from "@nicia-ai/typegraph/adapters/drizzle/engine";
import { postgresFenceSql } from "@nicia-ai/typegraph/adapters/drizzle/postgres";
import type { FenceSql } from "@nicia-ai/typegraph/backend";
import { sql, type SqlFragment } from "@nicia-ai/typegraph/backend";

function customAdvisoryLockExpression(
  namespace: string,
  key: string | number,
): SqlFragment {
  const keyText = typeof key === "number" ? String(key) : key;
  return sql`pg_advisory_xact_lock(hashtext(${namespace} || ':' || ${keyText}))`;
}

const customFenceSql: FenceSql = {
  advisoryLockExpression: customAdvisoryLockExpression,
  lockTables: postgresFenceSql.lockTables,
  isolationFactExpression: postgresFenceSql.isolationFactExpression,
};

const baseProfile = buildPostgresEngineProfile(db, options);
const derivedProfile = deriveEngineProfile(baseProfile, {
  fenceSql: customFenceSql,
});

const backend = createSqlBackend(derivedProfile);
```

`advisoryLockExpression` is the custom spelling here; `lockTables` and
`isolationFactExpression` are the bundled PostgreSQL builders, reused
because this example leaves them unchanged — a custom `FenceSql` need not
replace every member. TypeGraph derives the standalone-statement forms
every lock site actually calls (`acquireKeyed`, `acquireKeyedWithIsolation`,
`isolationFact`) from these two expressions, so `customFenceSql` never
spells a statement and its expression separately — the two cannot disagree
about what they lock or read. This is the same `customAdvisoryLockExpression`
pinned by `tests/engine-profile-derivation.test.ts` against a real
PostgreSQL connection, trimmed of the `customLockTables` /
`customIsolationFactExpression` coverage this example doesn't need.

Every write-fence lock site now spells its lock through `customFenceSql`
instead of the bundled one — including the recorded graph-write fence, which
fuses its lock into its own CTE (`buildLockSchemaVersionAndGraphWrite`) but
reads `advisoryLockExpression` / `isolationFactExpression` off the resolved
fence target rather than a hardcoded bundled spelling, so this derivation
reaches it too. The ONE exception, not reachable through `fenceSql`, is the
schema-commit fence (`acquireSchemaWriteFence` in `postgres.ts`): it emits a
standalone, single-argument `pg_advisory_xact_lock` call through
`advisoryLockSingleExpression`, baked directly into
`buildPostgresEngineProfile`'s closure. It deliberately occupies a different
lock space from every two-argument lock `fenceSql` spells, so it is not an
oversight `fenceSql` could close even if it were derivable — reaching it
needs a from-scratch profile (see
[What is not derivable yet](#what-is-not-derivable-yet)). The graph-template
instantiation statement is a different, already-reachable case: it is the
`instantiateStatement` member of `graphTemplateRuntime`, one of the fields
this same derivation can override (see the table above).

## Worked example: a portable `row`-mechanism fence

An engine with no advisory-lock primitive at all — a PostgreSQL-wire engine
with no working `pg_advisory_xact_lock` — declares `mechanism: "row"`
instead. TypeGraph spells the keyed acquisition itself against the
never-dropped fences relation, so this derivation needs no
`advisoryLockExpression` at all — only the declared mechanism and its two
facts, `drain` and `conflict`:

```typescript
const derivedProfile = deriveEngineProfile(baseProfile, {
  declaredCapabilities: {
    ...baseProfile.declaredCapabilities,
    writeFence: {
      mechanism: "row",
      drain: "quiescent",
      conflict: "commit-time",
    },
  },
});

const backend = createSqlBackend(derivedProfile);
```

`conflict` states which of the two ways this engine resolves two writers of
one fence row: `"wait"` for a lock-based engine (the second acquirer's
statement blocks, exactly like `"advisory"`); `"commit-time"` for an
optimistic-concurrency engine, where both acquirers proceed and the loser's
COMMIT fails. Declaring `"commit-time"` on an interactive backend (as here)
derives `capabilities.execution.unitOfWork: "optimistic-retry"` — every
store-owned write this backend opens now replays a real commit-time conflict
as a whole unit, up to `OPTIMISTIC_RETRY_ATTEMPTS` (3) attempts, rather than
surfacing the raw driver error on the first one. `drain: "quiescent"` is the
simplest legal drain when nothing else needs a real table lock; pass
`fenceSql.lockTables` and declare `drain: "table-lock"` instead when this
engine has one. A `fenceSql.isolationFactExpression`, if this engine's wire
protocol supports reading it, rides the SAME acquisition statement — pass
`postgresFenceSql.isolationFactExpression` (or a custom one) as `fenceSql` to
keep recorded capture and match-key convergence trusting a real fact instead
of failing closed on an unknown one.

### Declaring a `serializationFailure` classifier

`isSerializationFailure` (the one predicate every retry owner consults)
recognizes PostgreSQL's own `40001` / `40P01` SQLSTATEs and their fixed
driver-message fallback. An engine whose commit-conflict shape is something
else entirely — a custom error class, a different code — declares
`execution.serializationFailure` so the SAME predicate recognizes it instead
of falling through to a raw, unretried failure:

```typescript
const profile = buildPostgresEngineProfile(db, options);
const backend = createSqlBackend({
  ...profile,
  execution: {
    ...profile.execution,
    serializationFailure: (error) =>
      error instanceof Error && error.message.includes("CONFLICT_ON_COMMIT"),
  },
});
```

This is deliberately NOT a `deriveEngineProfile` override: `execution` is
captured by `buildOperations` and every transaction handle (see
[What you cannot override](#what-you-cannot-override) below), so
`deriveEngineProfile` refuses it like every other field in that table.
Hand-spreading `execution` this way is safe for reading
`serializationFailure` itself, because `createSqlBackend` is the only reader
of `profile.execution.serializationFailure` — it registers the classifier
against the exact backend object it is about to return, once, at
construction — while every other `execution` member (`compile`, `execute`,
`runExclusive`, and so on) rides forward as the SAME function reference the
base builder closed over, spread unchanged. `createSqlBackend` consults the
registered classifier for `isSerializationFailure` calls that pass this
backend (or one of its transactions) as `target`; every store-owned unit
routed through `runRetriedUnit`, and `store.transaction`'s own retry, already
does.

That safety is narrow, and it does not extend to the profile object itself.
`{...profile, execution: {...}}` is a plain object literal — a different
object from the one `buildPostgresEngineProfile` returned — so
`isFirstPartyProfile` no longer recognizes it. `createSqlBackend` gates
every `markFirstPartyFactory` call on that check, so a hand-spread profile
loses standing to two optimizations, silently and with no functional
difference to catch in testing: the dialect-derivation write-fence fallback
(moot here, since the spread profile still carries `writeFence` declared)
and the lazy schema-fence lease
(`withTransactionSchemaFenceLease`, `src/store/operations/write-transaction.ts`),
which falls back to the conservative per-call fence instead. Accept that
trade for a one-off `serializationFailure` override; a backend meant to keep
first-party standing declares `serializationFailure` inside the builder
function that constructs `profile` in the first place, rather than spreading
the finished object afterward.

## Removing `fenceSql`

`fenceSql` is the one field a derived profile can clear: pass
`fenceSql: undefined` to drop the bundled spelling entirely. That alone
is not enough to reach a working profile — `createSqlBackend` still
resolves a write-fence plan eagerly, and a profile whose resolved
`writeFence.mechanism` is still `"advisory"` with no `fenceSql` refuses
with `WRITE_FENCE_SQL_UNAVAILABLE`. Pair it with a `declaredCapabilities`
override that stops claiming `"advisory"` (for example, declaring
`writeFence: { mechanism: "engine-serialized" }`
instead — no `drain` key: that field applies only to `mechanism: "advisory"`)
to actually resolve an `engine-serialized` plan that needs no
lock spelling at all.

## Supplying `lineage`

`EngineProvisioning.lineage` forwards onto the assembled backend's optional
`lineage` member unchanged, exactly like `provisioning.catalog` forwards onto
`catalog`. Neither bundled profile sets it: `buildPostgresEngineProfile` and
`buildSqliteEngineProfile` both leave it `undefined`, so a store built on a
bundled backend derives its `lineage` from its own recorded relations when
`history: true` is on, and has none otherwise (see
[Lineage and pruned diffs](/graph-merge#lineage-and-pruned-diffs)). An engine
whose storage layer already tracks a whole-database revision and can answer
"what changed in this graph since revision R" more cheaply than a full scan
supplies `lineage` directly.

Both `revision` and `changesSince` take a **session** as their first
argument. Run each read on that session (`session.execute` or
`session.executeRaw`); a connection captured by the strategy may see a
different snapshot. A caller planning outside a transaction passes the root
backend. A backend that also needs lineage inside transactions must thread
it through `EngineProvisioning.lineage` so transaction handles expose the
same capability.

`revision()` returns an opaque token comparable only with revisions from the
same lineage source. `changesSince()` must report every changed node and edge
key, including inserts, updates, deletes, and resurrection. Return
`{ kind: "unbounded" }` when the delta cannot be bounded. TypeGraph uses
lineage to prune branch diffs when it has a TypeGraph-owned revision anchor;
for stores without revision tracking, `base@V` uses a complete content
fingerprint regardless of engine lineage. That fingerprint covers current
identity assertions and is recomputed inside the target commit transaction.
Previously minted `engine:` base tokens are retired.

Test a new `lineage` against `tests/backends/integration/lineage-conformance.ts`'s
`registerLineageConformanceIntegrationTests` (registered per-dialect through
`createIntegrationTestSuite`, or called directly against your own backend,
via `{ getStore: () => ({ backend }) }`). It registers two describes: only
"lineage: recorded-relations conformance" is portable — it drives every case
through `resolveLineage`, the same path a real caller takes, and is the case
the bundled recorded-relations derivation passes: after N writes,
`changesSince(r0)` is exactly the touched keys, `changesSince(rN)` is empty, a
hard delete after a revision reports the deleted key once, and an unrecognized
revision is `unbounded`. "lineage: capture-completeness evidence" is
TypeGraph-specific — it exercises `recordedRelationsLineage` directly (the
per-revision evidence a bare engine revision has no equivalent gap for); an
engine profile's own suite should run against the conformance describe only
and skip the other.

## Supplying `recordedTime`

`EngineProvisioning.recordedTime` declares an engine that tracks recorded
(system) time itself, rather than through TypeGraph's own capture relations
and clock — a backend that declares it must also declare `lineage`
(engine-native history keeps no recorded relations for TypeGraph to derive a
change delta from; `createSqlBackend` refuses `recordedTime` without a
co-declared `lineage` with `ENGINE_PROFILE_RECORDED_TIME_REQUIRES_LINEAGE`).
`EngineRecordedTimeMembers` has two members, `source` and `revisionNow`, both
`this: void`.

`source(table, revision)` names the table expression `table` (`"nodes"` |
`"edges"` | `"identityAssertions"`) reads its recorded rows from, AS OF
`revision` — the engine's own temporal-table syntax, with the interval
already folded in (a system-time `AS OF` clause, or equivalent). It replaces
what a TypeGraph-relation-backed source spells as two members: the recorded
relation itself (`recordedNodesTable`/`recordedEdgesTable`) and a separate
`recorded_from <= r AND r < recorded_to` interval predicate. Because
`source`'s own expression already scopes every row to exactly one revision,
there is nothing left for a predicate to narrow — every recorded read this
member backs compiles with no interval clause at all. `revision` is an
opaque `{ revision, recordedAt }` pair minted by your own `revisionNow`
below; never parse `revision.revision` as a number; embed it in the AS OF
expression as an opaque token. `table` is never called with
`"identityAssertions"` today — a recorded identity read (`Store.
identityAtCoordinate` at a past instant, and the query compiler's historical
identity traversal) is refused outright under engine-native ownership before
any read compiles, so your implementation must still accept the shared
union without that arm ever running.

`revisionNow(session)` is called on two different kinds of session, and must
answer differently for each:

- **On a root backend** (`store.recordedNow()`, `store.revisionNow()`): the
  engine's current COMMITTED revision.
- **On an open `transaction()` handle** (both places `TransactionReceipt.recorded`
  is stamped, called before that transaction's own COMMIT): the revision at
  which THIS transaction's writes will become visible once it commits — the
  engine's pending/next revision for that session, not the last one committed
  before it opened. TypeGraph stamps this still-uncommitted value straight
  into the receipt it hands back to the caller once the transaction succeeds.

An engine that can only name its last-COMMITTED revision, never its own
pending one from inside an open transaction, cannot implement `recordedTime`:
stamping the last-committed value into a receipt would describe the state
*before* the write the receipt is reporting on, and there is no correct
point after COMMIT to read the right value from without reopening the race
`recordedTime` exists to close.

Declaring `recordedTime` changes what `history: true` means on your profile.
TypeGraph's own recorded relations, clock, and write-fence-gated clock
allocation are never engaged; `revisionTracking: true` is refused whether or
not `history: true` is also requested
(`ENGINE_NATIVE_REVISION_TRACKING_UNSUPPORTED` — there is no
TypeGraph clock for it to advance, and the engine's own revision is only
ever available under `history: true`); a `recordedRead` external binding is
refused (`ENGINE_NATIVE_RECORDED_READ_UNSUPPORTED` — there is no TypeGraph
recorded relation for one to populate); and `migrateLegacyRecordedTime`
refuses outright (`ENGINE_NATIVE_MIGRATE_RECORDED_TIME_UNSUPPORTED` — it
rewrites TypeGraph's own recorded relations, which your backend does not
have). `RecordedInstant` anchors from a `recordedTime`-declaring store use
the `e1:<opaque engine revision>:<ISO instant>` form rather than TypeGraph's
`r2:<graph origin>:<namespace digest>:<16-digit revision>:<ISO instant>` form; `asOfRecorded` refuses an
anchor minted under the other ownership form with
`RECORDED_INSTANT_OWNERSHIP_MISMATCH`. See [Engine-native recorded
time](/queries/temporal#engine-native-recorded-time) for the full reader
contract.

## Refusals you may meet

| Code | When |
| --- | --- |
| `ENGINE_PROFILE_REQUIRES_WRITE_FENCE_DECLARATION` | The profile's resolved capabilities omit `writeFence` — `createSqlBackend` has no write-fence decision to resolve and refuses outright, naming the one capabilities line to add. |
| `WRITE_FENCE_SQL_UNAVAILABLE` | The resolved capabilities declare `mechanism: "advisory"` but the profile's `fenceSql` is missing the member that mechanism/drain combination needs; or `mechanism: "row"` with `drain: "table-lock"` but no `fenceSql.lockTables`. A `"row"` target missing `tableNames.fences` is NOT refused here — it refuses the first time a keyed site actually acquires the fence row. |
| `WRITE_FENCE_DECLARATION_INVALID` | The declared `writeFence` carries an unrecognized `mechanism`, `drain`, or `conflict` string; a `drain` key on a mechanism other than `"advisory"` / `"row"`; a `conflict` key on anything but `"row"`; or `conflict: "commit-time"` on a target whose own `capabilities.execution.interactiveTransactions` is `false` — that value is honored only by the `"optimistic-retry"` execution tier, which never derives without an interactive transaction to replay inside, so accepting it there would silently drop it rather than apply it. `resolveWriteFencePlan` validates the raw value (a plain-JavaScript author is not held to the discriminated-union type) before shaping a plan from it. |
| `CALLER_SERIALIZED_REFUSES_ADOPTION` | `adoptTransaction` was called on a backend whose resolved write-fence plan is `caller-serialized` — an externally owned transaction's lifetime cannot be held by the backend's in-process write-unit queue. |
| `CATALOG_UNAVAILABLE` | A store path that needs the backend's catalog probes (index materialization, the recorded-time schema check, the recorded-time migration's column read) finds `catalog` absent — a profile whose `provisioning.catalog` is unset builds a backend with no `catalog` member at all. |
| `LINEAGE_UNAVAILABLE` | A caller reached `requireLineage` and found `lineage` absent on the backend it asked. Every OUT-OF-TRANSACTION graph-merge caller consults `lineage` through `resolveLineage`, which already falls back to the recorded-relations lineage or to a full comparison rather than hitting this refusal. `assertTargetUnchanged`'s in-transaction re-validation reads the transaction handle's `lineage` ONLY — no fallback to the root — so this fires whenever a `lineage` that anchored the plan (found on the root at plan time) is not ALSO threaded onto the transaction handle that commits it; see "Supplying `lineage`" above for how to thread it correctly. |
| `ENGINE_PROFILE_RECORDED_TIME_REQUIRES_LINEAGE` | The profile declares `recordedTime` without also declaring `lineage` — engine-native history keeps no recorded relations of its own for TypeGraph to derive a graph-merge change delta from, so the engine's own `lineage` is the only source for one. Raised at `createSqlBackend` construction, naming both members. |
| `RECORDED_TIME_UNAVAILABLE` | A caller reached `requireRecordedTime` and found `recordedTime` absent on the backend it asked. Store construction under `history: true` and the shared `recordedNow()`/`revisionNow()`/receipt-stamping read are the only callers today, both reached only once `recordedTimeOwnership` has already resolved to `"engine-native"`, so this is defense-in-depth rather than a reachable misconfiguration on a bundled backend. |
| `ENGINE_NATIVE_REVISION_TRACKING_UNSUPPORTED` | A store was constructed with `revisionTracking: true` against a backend that declares `recordedTime`, whether or not `history: true` was also requested — engine-native has no TypeGraph clock for `revisionTracking` to advance on its own. |
| `ENGINE_NATIVE_RECORDED_READ_UNSUPPORTED` | A store was constructed with an external `recordedRead` binding against a backend that declares `recordedTime` — there is no TypeGraph recorded relation for one to populate; engine-native's own recorded reads are sourced from `recordedTime.source` instead. |
| `ENGINE_NATIVE_RECORDED_IDENTITY_UNSUPPORTED` | `Store.identityAtCoordinate` at a past recorded instant, or the query compiler's historical identity traversal, was reached under engine-native recorded time — identity history reads TypeGraph's own recorded relations directly, which an engine-native backend does not populate. |
| `ENGINE_NATIVE_MIGRATE_RECORDED_TIME_UNSUPPORTED` | `migrateLegacyRecordedTime` was called against a backend that declares `recordedTime` — the migration rewrites TypeGraph's own recorded relations, which an engine-native backend does not have. |
| `RECORDED_INSTANT_OWNERSHIP_MISMATCH` | `asOfRecorded(instant)` was called with an instant minted under the OTHER recorded-time ownership form — an `r2:` instant against an engine-native store, or an `e1:` instant against a TypeGraph-owned one. |
| `ENGINE_PROFILE_OVERRIDE_UNSUPPORTED` | `deriveEngineProfile`'s `overrides` names a key outside the derivable set, or one of the three adapter-backed sub-fields with a changed value (see [the carve-out](#the-adapter-backed-carve-out)). |
| `ENGINE_ASSEMBLY_UNRECOGNIZED` | The profile's `assembly` is not a value `assembleEngine` produced — a profile built by hand rather than obtained from a bundled builder (optionally adapted with `deriveEngineProfile`). |

## What non-first-party costs

First-party standing is bound to the exact profile object one of the two
bundled builders returned, not to a field — a derived profile is a new
object neither builder ever saw, so it never carries that standing
forward, even when every field is copied from a first-party profile
unchanged. That costs a derived profile's backend two things:

- **No dialect-derivation fallback.** `resolveWriteFencePlan`'s fallback
  for a profile with no `writeFence` declared is sound only for the two
  bundled dialects, so it never applies to a
  derived profile regardless — irrelevant in practice as long as
  `declaredCapabilities` is kept, since both bundled declarations already
  carry a write-fence declaration explicitly.
- **No lazy per-transaction schema-fence lease.** The lease
  `store/operations/write-transaction.ts` takes out under
  `isFirstPartyFactory` is closed to a derived profile's backend; each
  managed write takes its own fence instead.

Every gate `createSqlBackend` runs — the write-fence-declaration refusal, the
`mechanism: "advisory"` without `fenceSql` refusal, the schema-fenced-insert
and autocommit marks — still applies to a derived profile exactly as it does
to a bundled one.

A bundled profile object is frozen once its builder returns it: mutating a
field on that exact object throws, rather than silently drifting the
profile away from what first-party standing was granted to.
`deriveEngineProfile` is unaffected — it spreads `base`'s fields into a
new object literal, which does not freeze.

## What is not derivable yet

Building a profile from scratch — rather than deriving a variant of a
bundled one — needs an execution adapter, an operation strategy, and an
operation-backend assembly, none of which is exported today.
`SqlEngineProfile.assembly` is opaque, and its only constructor,
`assembleEngine`, is exported from no entrypoint: it is authoring a new
engine, not deriving a variant of an existing profile, and waits on a
future exported assembly constructor. Until then, derivation from a
bundled builder — changing a lock spelling, a capability declaration, a
resource-audit verdict, or a runtime dependency bag — is the supported
way to adapt a profile.

## Write and delete port contracts

The sections above derive a profile. A `GraphBackend` you write by hand, or
decorate through `deriveBackend`, implements the store's ports directly. This
reference covers the write and delete members: what each must do and return,
what the store does with that value, and what the store does when an optional
member is absent. It does not cover the schema, materialization, contribution
or search members.

The types are exported from the authoring entrypoint only:

```typescript
import type {
  GraphBackend,
  HardDeleteNodesBatchResult,
  TransactionBackend,
} from "@nicia-ai/typegraph/backend";
```

That entrypoint is not covered by semver (see [Stability](#stability)). Pin
the version a hand-written backend was written against and re-check these
contracts before upgrading.

### How the store calls a write member

- **The write frame.** Every store write runs in one frame. On a backend whose
  `capabilities.execution.interactiveTransactions` is `true`, the store opens a
  transaction (or joins the caller's `store.transaction`) and calls the members
  on its `TransactionBackend`. On a backend without interactive transactions,
  it calls them one at a time on the root backend, with no atomicity across
  them, and refuses a write that enforces a declared constraint with
  `CONSTRAINT_WRITE_FENCE_UNSUPPORTED`. No member below has to be atomic on its
  own. A member that runs several statements, such as `hardDeleteNode`, must
  order them so that a failure part-way through leaves a state a retry can
  finish.
- **Absent means undefined.** For an optional member the store checks whether
  it is defined, on the target it is about to call and for some members also
  on the root backend, and uses the fallback below when it is not. Members
  gated by a capability are the exception, noted where they appear. Leave a
  member you do not implement undefined. A member that throws "not
  implemented" is a failure, not an absence.
- **Receiver-free.** Every member is called detached (`this: void`). Close over
  state rather than reading `this`.
- **Error shapes the store reads.** An insert that collides on a node or edge
  id must throw `DatabaseOperationError` with `operation: "insert"`, `entity`
  set to `"node"` or `"edge"`, `reason: "duplicate_key"` and the attempted
  rows in `attempted`. The store turns only that shape into its already-exists
  error and rethrows anything else unchanged. An `updateNode` or `updateEdge`
  that matches no row must throw `DatabaseOperationError` with
  `operation: "update"` and `reason: "no_row_returned"`. The store's retry and
  re-read logic keys on that shape.

### Node writes

| Member | Optional | Must do and return | Store use, and fallback when absent |
| --- | --- | --- | --- |
| `insertNode` | Required | Insert one node row and return it. | The returned row becomes the created node. It is also the fallback for every optional insert member below. |
| `insertNodeIfAbsent` | Optional | Insert only when the `(kind, id)` slot is empty. Return the row, or `undefined` when the slot was occupied, without raising a database error and with the transaction still usable. | Used by a single create with a caller-supplied id and no uniqueness or disjointness claims. On `undefined` the store reads the row: a live row is an already-exists error, a tombstone is resurrected through `updateNode`. Absent: `getNode`, then `insertNode`. |
| `insertNodeWithSchemaFence`, `insertNodeIfAbsentWithSchemaFence` | Optional | As `insertNode` / `insertNodeIfAbsent`, with the active-schema fence taken inside the same INSERT. `undefined` is ambiguous (stale schema or occupied id), and the store diagnoses it. | Used only on a backend carrying the schema-fenced-insert mark. Only the bundled factories and `createSqlBackend` grant that mark, so a hand-written backend never reaches these members. Otherwise the store takes the schema fence itself, then does the ordinary insert. |
| `insertNodeNoReturn` | Optional | Insert one node row, returning nothing. | Absent: `insertNode`, with the row discarded. |
| `insertNodesBatch` | Optional | Insert many node rows, returning nothing. | Absent: one `insertNodeNoReturn` (or `insertNode`) per row, in input order. |
| `insertNodesBatchReturning` | Optional | Insert many node rows and return them. | Rows are matched by `(kind, id)`, so order does not matter. A missing row is an error. Absent: one `insertNode` per row. |
| `updateNode` | Required | Update the `(kind, id)` row and return its after-image. Apply `expectedValidFrom` when it is present: a mismatch matches no row. | The returned row is the after-image the store syncs sidecars from. A miss must be the `no_row_returned` error above. |
| `updateResolvedNodesBatch` | Optional | Update a resolved set all-or-nothing behind its version gate. Return every updated row, or `[]` when the gate refused. | Rows are matched by id and checked against the entries. `[]` makes the store recover row by row through `updateNode`; a partial count is a `ConfigurationError`. Absent: the per-row path. |
| `previewNodeSetUpdate`, `updateNodeSet` | Optional, together | `previewNodeSetUpdate` is the locked dry-run: read every live row the selection (`updateWhere` or `compareAndSet`, with its `expected` predicates) names, lock it as an UPDATE would, write nothing, and return each row's `id`, `version`, after-image `props` computed in SQL, and an opaque `rowToken` naming the exact stored row. `updateNodeSet` applies the patch to exactly the `rows` (id and token) it is given, all or nothing: when any token no longer names its live stored row, write no row and return none. Compare the token on the row the write itself updates, not only in a prior read: an engine that re-evaluates a waiting row after a concurrent commit must find the new version not matching. Return `{ affectedCount, rows }` with the after-images. | The dry-run's after-images drive validation, which runs before `updateNodeSet`; the written `rows` drive the sidecar and claim rebuild; `affectedCount` is returned to the caller. No row written for a non-empty key set is reported as `DatabaseOperationError` (`no_row_returned`). Absent: `updateWhere()` and compare-and-set refuse with `SET_UPDATE_UNSUPPORTED` / `COMPARE_AND_SET_UNSUPPORTED`. They also need interactive transactions. |
| `upsertHeterogeneousNodes` | Optional | Upsert plain caller-id nodes across kinds behind the stated schema fence. Return one row per entry, in entry order. | Read positionally. A row count different from the entry count is `HETEROGENEOUS_NODE_BATCH_STALE_SCHEMA`. Absent: `tx.writeNodeUpsertBatch()` refuses with `UnsupportedBackendCapabilityError`. |
| `deleteNode` | Required | Tombstone one node row, returning nothing. | The store then removes the node's uniqueness entries, embeddings and fulltext row itself, through the sidecar members below. |
| `lockNodes` | Required | Read and lock rows; see [Node-row locks](/backend-setup#node-row-locks-locknodes). | Rows are matched by id. |

### Edge writes

| Member | Optional | Must do and return | Store use, and fallback when absent |
| --- | --- | --- | --- |
| `commands` | Required | Execute `node.create`, `edge.create` and `edge.converge-create`, or return `unsupported` naming the dimensions not applied; see [Authoritative command sessions](/backend-setup#authoritative-command-sessions). | `unsupported` means no SQL ran. The store re-enters its portable path, except a durable match-identity convergence, which refuses with `DURABLE_EDGE_MATCH_IDENTITY_COMMAND_UNSUPPORTED`. |
| `insertEdge` | Required | Insert one edge row and return it. | The returned row becomes the created edge. A duplicate id must be the `duplicate_key` error above. |
| `insertEdgeNoReturn` | Optional | Insert one edge row, returning nothing. | Absent: `insertEdge`. |
| `insertEdgesBatch` | Optional | Insert many edge rows, returning nothing. | Absent: one `insertEdgeNoReturn` (or `insertEdge`) per row, in input order. |
| `insertEdgesBatchReturning` | Optional | Insert many edge rows and return them. | Absent: one `insertEdge` per row, in input order. |
| `insertEdgesDurableBatchReturning` | Optional | Insert rows that all carry `matchIdentity`. Leave a row that loses an identity conflict out of the result instead of throwing. | Rows are matched by id. An id that was not attempted is an invariant error. A bulk create turns any omitted row into `EdgeMatchIdentityConflictError`, and import turns it into a per-row error. Absent: the store decides and creates row by row. |
| `updateEdge` | Required | Update one row and return it. Apply every stated predicate (`kind`, endpoints, `expectedValidFrom`, `expectedValidTo`). Match no row when a predicate fails. | A miss must be the `no_row_returned` error above. The store re-reads the row to tell a moved row from a removed one. |
| `deleteEdge` | Required | Tombstone one edge row, asserting `kind` when given. An already-tombstoned row is a no-op. | Return value ignored. |

### Hard deletes and the delete-time read

| Member | Optional | Must do and return | Store use, and fallback when absent |
| --- | --- | --- | --- |
| `hardDeleteEdge` | Required | Permanently remove one edge row, asserting `kind` when given. Resolve `true` when the statement removed the row, `false` when it matched none (the id is absent, or the row no longer carries the asserted kind). | The store releases the edge's cardinality claims (`purgeEdgeClaims`) only on `true`. A concurrent writer may have committed a different edge under the same id, so releasing on `false` would strip that edge's claims. |
| `hardDeleteEdgesBatch` | Optional | `hardDeleteEdge` for a set of ids under one optional asserted kind. Resolve the ids of the rows it removed, in any order, and never an id whose row it left in place. | Claims are released for exactly the returned ids. Absent: one `hardDeleteEdge` per id, collecting the ids that resolved `true`. |
| `deleteEdgesBatch` | Optional | `deleteEdge` for a set of ids: the same per-row semantics, including the optional asserted kind and idempotence on tombstoned rows. | Used by batch soft deletes and the node delete cascade, which asserts no kind because it removes every connected edge. Absent: one `deleteEdge` per id. |
| `hardDeleteNode` | Required | Permanently remove one node and what it owns: its uniqueness entries, its fulltext row, and every incident edge (either endpoint, any edge kind, live or tombstoned), then the node row last. When `params.releaseEdgeClaims` is `true`, also drop the claim rows held by exactly the edge rows this call removed (the ids its edge delete reports), before the node row, and run no claim statement when it removed no edge. Returns nothing. | The store judges `onDelete` and removes the edges that verdict names first, releasing their claims. It sets `releaseEdgeClaims` exactly when the backend holds claims (its claims bundle resolves supported), so a backend without the claim relation is never asked to name it. The edges left for this call (tombstoned ones, and a composition edge the store leaves to its part's own delete) have their claims released only here: a backend that skips it leaves orphaned claim rows, which never refuse a write but are never reclaimed. After this call the store deletes the node's embeddings through the vector members, because the backend cannot address the per-field vector storage. |
| `hardDeleteNodesBatch` | Optional | `hardDeleteNode` for listed ids of one `kind`, never touching another kind's rows: uniqueness entries, fulltext rows and incident edges first (and, when `params.releaseEdgeClaims` is `true`, the removed edges' claim rows, as `hardDeleteNode` drops them), then the node rows. Resolve `{ removedNodeIds, removedEdgeIds }`: exactly the node rows the delete matched, and every edge row it removed. Neither list may name a row left in place. | Used by bulk `hardDelete` for nodes that need no composition cascade and no identity detach (those take the single path). Embeddings are deleted for `removedNodeIds` only. A history- or revision-capturing store records the removed nodes and edges from the two lists rather than reading connected edges first. Absent: one `hardDeleteNode` per id, in order, in the same frame. |
| `findEdgesConnectedToNodes` | Optional | Read every live (not tombstoned) edge, of any edge kind, with either endpoint among `nodeIds` of `nodeKind`, each edge once, in any order. It must be kind-blind: `onDelete: "restrict"` is judged against every stored edge, including kinds the current graph no longer declares. | Read inside the delete's frame, after the node rows are locked, to plan a bulk hard delete. The store groups rows by endpoint itself. Absent: one `findEdgesConnectedTo` per node. |

### Uniqueness entries

| Member | Optional | Must do and return | Store use, and fallback when absent |
| --- | --- | --- | --- |
| `insertUnique` | Required | Reserve one key. Throw `UniquenessError` when a different live owner (another `(concreteKind, nodeId)`) holds it. In the bundled backends the same owner, or a tombstoned holder, takes the row over. | The store issues the reservation before the row it gates, maps a `UniquenessError` to its own error (for example `DisjointError`), and releases the reservation with `deleteUnique` if the row write fails. |
| `insertUniqueBatch` | Optional | `insertUnique` for many entries, with the same conflict semantics. The store never passes two entries with the same key on the same axis and constraint. | Absent: one `insertUnique` per entry. `updateWhere()` on a constrained kind and resolved writes need it, and refuse with `SET_UPDATE_UNIQUENESS_UNSUPPORTED` / `RESOLVED_NODE_UNIQUENESS_UNSUPPORTED`. |
| `deleteUnique` | Required | Release an owner's live entry for one constraint and key: across every axis when `nodeKind` is absent, or only that axis when it is present. The bundled backends tombstone the entry. | Return value ignored. |
| `checkUnique` | Required | Return the entry at the axis, or `undefined`. Include tombstoned entries only when `includeDeleted` is set. | Cached and overlaid with the write's pending claims. |
| `checkUniqueBatch` | Optional | Return the entries found for the listed keys. A missing key means absent. | Rows are matched by key, so order does not matter. Absent: one `checkUnique` per key. Set updates and resolved writes need it. |
| `hardDeleteUniquesByNodeIds` | Optional | Permanently remove every entry the listed nodes own. | No fallback. Set updates and resolved writes need it, and refuse as `insertUniqueBatch` does when it is unavailable. |
| `hardDeleteUniquesByConcreteKind` | Optional by type | Permanently remove every entry owned by nodes of one concrete kind, at whatever axis. | One of the four members `constraintClaims` requires (next table). The store does not call it today: kind removal compiles the same statement itself. |

### Edge cardinality claims

The edge cardinality claim members are gated by the `constraintClaims`
capability, not by member presence. `claimEdgeCardinality`,
`claimEdgeCardinalityBatch`, `purgeEdgeClaims` and
`hardDeleteUniquesByConcreteKind` must be all present when it is `true` and
all absent when it is not. Any other combination is refused with
`CONSTRAINT_CLAIM_SURFACE_MISMATCH`. Without the capability, no claim is
written and the graph's write fence is the only fence for a declared
cardinality.

| Member | Optional | Must do and return | Store use, and fallback when absent |
| --- | --- | --- | --- |
| `claimEdgeCardinality` | With the capability | Take the claim on one axis: create-or-lock, then a takeover only when the committed holder is no longer an edge the axis and key describe. Return the outcome. | Issued before the edge row, in the same frame. `refused` becomes `CardinalityError` or `CompositionError` naming the holder. |
| `claimEdgeCardinalityBatch` | With the capability | `claimEdgeCardinality` for many entries. Return one outcome per entry, by position. The store never passes two entries with the same conflict target. | The store sorts the entries and reads the outcomes positionally, so return exactly one per entry, in order. |
| `claimEdgeCardinalityGuarded` | Optional | As `claimEdgeCardinality`, and also refuse when a live edge with no claim already matches the axis. | Used only with the capability and for a kind with one constrained axis, and the store then skips its separate cardinality probe. Absent: the probe, then `claimEdgeCardinality`. |
| `purgeEdgeClaims` | With the capability | Drop the claim rows the named edges hold. Housekeeping only: a claim whose holder is gone is taken over in place anyway. On an engine with row locks, lock the rows in claim-target order (code point on axis, then key, the order every claim write takes them in) before deleting them, across every statement of one call (a call whose ids span several statements locks all its rows first), and skip a row a concurrent writer took over while you waited: an unordered delete can deadlock against an edge create that holds one of the same rows. The node hard-delete cascades release claims the same way. | Called only with ids a hard delete reported removed (see `hardDeleteEdge`). Return value ignored. The store calls it only for edges it removed through the edge hard-delete members; `hardDeleteNode` and `hardDeleteNodesBatch` release the claims of the edges they remove themselves. |

### Embedding and fulltext rows

| Member | Optional | Must do and return | Store use, and fallback when absent |
| --- | --- | --- | --- |
| `upsertEmbedding`, `deleteEmbedding` | Optional | Insert or replace, or delete, one node's vector in the slot the params describe. `deleteEmbedding` must succeed when no vector (or no slot storage) exists yet. | Called after the node write. If either is absent, embedding sync is skipped silently: no refusal for a schema with `embedding()` fields. `updateWhere()` on such a kind refuses with `SET_UPDATE_VECTOR_UNSUPPORTED` unless all four embedding members exist. |
| `upsertEmbeddingBatch`, `deleteEmbeddingBatch` | Optional | Batched forms for one slot. Duplicate node ids in an upsert batch are last-write-wins. | Absent: one `upsertEmbedding` / `deleteEmbedding` per node. |
| `upsertFulltext`, `deleteFulltext` | Optional | Insert or replace, or delete, one node's fulltext row. | Fulltext availability is `capabilities.fulltext`. Without it, a write to a kind with `searchable()` fields refuses with `UnsupportedBackendCapabilityError`. With it, a missing member is a `ConfigurationError` naming it. A hard delete never calls these: `hardDeleteNode` and `hardDeleteNodesBatch` remove the fulltext row themselves. |
| `upsertFulltextBatch`, `deleteFulltextBatch` | Optional | Batched forms. Duplicate node ids in an upsert batch are last-write-wins. | Absent: one `upsertFulltext` / `deleteFulltext` per node. |

### Clearing a graph

`clearGraph(graphId)` is required. It must hard-delete every row the graph owns
in the backend's relations: nodes, edges, uniqueness entries, edge claims,
fulltext rows, schema versions, and the graph's bookkeeping rows. The bundled
implementation removes uniqueness entries and edge claims before the nodes and
edges. It does not clear embeddings. `Store.clear()` resets each declared
embedding field's vector storage afterwards, outside the transaction, and only
when the backend has a `vectorStrategy` and `executeDdl`.

`Store.clear()` runs the clear inside a transaction when the backend has
interactive transactions, and directly on the root backend otherwise. The
optional `clearGraphPreservingContributionMaterializations` does the same
while keeping contribution markers. `Store.clear()` uses it when present unless
`preserveContributionMaterializations: false` is passed. When it is absent, an
explicit `preserveContributionMaterializations: true` is refused with
`UNSUPPORTED_BACKEND_CAPABILITY` before anything is deleted.
