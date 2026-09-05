---
title: Authoring an engine profile
description: Derive a variant of a bundled SQL engine profile, and what building one from scratch still requires
---

[Backend Setup](/backend-setup) covers using the two bundled backends.
This page is for adapting one: changing a lock spelling, loosening a
declared capability, or swapping the resource-audit verdict without
hand-copying every other field a profile carries.

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
| `declaredCapabilities` | The capabilities `finalizeEngineCapabilities` derives the rest of the backend's advertised capabilities from — for example, declaring `pessimisticLocks` differently changes which write-fence plan resolves. |
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
other sub-field on both objects — `pessimisticLocks`, `windowFunctions`,
`clearValidTo`, `returning`, `claims`, `graphAnalytics`, `resourceAudit`'s
`resource` / `identityLeaseResource`, and so on — stays freely derivable.

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
| `provisioning` | `ensureTable` and `catalog` are captured by migrations and transaction handles. |
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
import { sql, type SqlFragment } from "@nicia-ai/typegraph";

function customAdvisoryLockExpression(
  namespace: string,
  key: string | number,
): SqlFragment {
  const keyText = typeof key === "number" ? String(key) : key;
  return sql`pg_advisory_xact_lock(hashtext(${namespace} || ':' || ${keyText}))`;
}

function customAdvisoryLock(
  namespace: string,
  key: string | number,
): SqlFragment {
  return sql`SELECT ${customAdvisoryLockExpression(namespace, key)}`;
}

function customAdvisoryLockWithIsolation(
  namespace: string,
  key: string | number,
): SqlFragment {
  return sql`
    SELECT
      ${customAdvisoryLockExpression(namespace, key)},
      current_setting('transaction_isolation') AS transaction_isolation
  `;
}

const customFenceSql: FenceSql = {
  advisoryLock: customAdvisoryLock,
  advisoryLockWithIsolation: customAdvisoryLockWithIsolation,
  lockTables: postgresFenceSql.lockTables,
  isolationFact: postgresFenceSql.isolationFact,
  advisoryLockExpression: customAdvisoryLockExpression,
  isolationFactExpression: postgresFenceSql.isolationFactExpression,
};

const baseProfile = buildPostgresEngineProfile(db, options);
const derivedProfile = deriveEngineProfile(baseProfile, {
  fenceSql: customFenceSql,
});

const backend = createSqlBackend(derivedProfile);
```

`advisoryLock`, `advisoryLockWithIsolation`, and the composable
`advisoryLockExpression` are the custom spelling here; `lockTables`,
`isolationFact`, and `isolationFactExpression` are the bundled PostgreSQL
builders, reused because this example leaves them unchanged — a custom
`FenceSql` need not replace every member. This is the same
`customAdvisoryLock` / `customAdvisoryLockWithIsolation` pair pinned by
`tests/engine-profile-derivation.test.ts` against a real PostgreSQL
connection, trimmed of the `customLockTables` / `customIsolationFact`
coverage this example doesn't need.

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

## Removing `fenceSql`

`fenceSql` is the one field a derived profile can clear: pass
`fenceSql: undefined` to drop the bundled spelling entirely. That alone
is not enough to reach a working profile — `createSqlBackend` still
resolves a write-fence plan eagerly, and a profile whose
`declaredCapabilities.pessimisticLocks.advisoryLocks` is still `true`
with no `fenceSql` refuses with `WRITE_FENCE_SQL_UNAVAILABLE`. Pair it
with a `declaredCapabilities` override that stops claiming
`advisoryLocks` (for example, declaring `serializedWriters: true`
instead) to actually resolve an `engine-serialized` plan that needs no
lock spelling at all.

## Refusals you may meet

| Code | When |
| --- | --- |
| `ENGINE_PROFILE_REQUIRES_WRITE_FENCE_DECLARATION` | The profile's resolved capabilities omit `pessimisticLocks` entirely — `createSqlBackend` has no write-fence decision to resolve and refuses outright, naming the one capabilities line to add. |
| `WRITE_FENCE_SQL_UNAVAILABLE` | The resolved capabilities declare `pessimisticLocks.advisoryLocks: true` but the profile supplies no `fenceSql` to spell the lock with. |
| `CATALOG_UNAVAILABLE` | A store path that needs the backend's catalog probes (index materialization, the recorded-time schema check, the recorded-time migration's column read) finds `catalog` absent — a profile whose `provisioning.catalog` is unset builds a backend with no `catalog` member at all. |
| `ENGINE_PROFILE_OVERRIDE_UNSUPPORTED` | `deriveEngineProfile`'s `overrides` names a key outside the derivable set, or one of the three adapter-backed sub-fields with a changed value (see [the carve-out](#the-adapter-backed-carve-out)). |
| `ENGINE_ASSEMBLY_UNRECOGNIZED` | The profile's `assembly` is not a value `assembleEngine` produced — a profile built by hand rather than obtained from a bundled builder (optionally adapted with `deriveEngineProfile`). |

## What non-first-party costs

First-party standing is bound to the exact profile object one of the two
bundled builders returned, not to a field — a derived profile is a new
object neither builder ever saw, so it never carries that standing
forward, even when every field is copied from a first-party profile
unchanged. That costs a derived profile's backend two things:

- **No dialect-derivation fallback.** `resolveWriteFencePlan`'s fallback
  for a profile with no `pessimisticLocks` declaration is sound only for
  the two bundled dialects, so it never applies to a derived profile
  regardless — irrelevant in practice as long as `declaredCapabilities`
  is kept, since both bundled declarations already carry
  `pessimisticLocks` explicitly.
- **No lazy per-transaction schema-fence lease.** The lease
  `store/operations/write-transaction.ts` takes out under
  `isFirstPartyFactory` is closed to a derived profile's backend; each
  managed write takes its own fence instead.

Every gate `createSqlBackend` runs — the `pessimisticLocks` refusal, the
`advisoryLocks` without `fenceSql` refusal, the schema-fenced-insert and
autocommit marks — still applies to a derived profile exactly as it does
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
