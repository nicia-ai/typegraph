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
import { sql, type SqlFragment } from "@nicia-ai/typegraph";

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
argument — the connection the caller's decision is bound to, never one your
implementation picks for itself. A caller planning outside any transaction
(`branch()`'s fork-revision capture, `staging.ts`'s pruned-diff delta) passes
the root backend it holds. The engine-anchored `base@V` guard's
IN-TRANSACTION re-validation (`assertTargetUnchanged` in `graph-merge/
merge.ts`) is the concrete caller a session-less bag could never serve
correctly: it reads `lineage` off the PINNED TRANSACTION HANDLE and calls
both members WITH that same handle as the session, so the read observes the
transaction's own snapshot rather than a separate connection's possibly
stale view. `requireLineage` refuses with `LINEAGE_UNAVAILABLE` (below) when
the transaction handle carries no `lineage` of its own — there is no
fallback to the root: a `lineage` reachable only through a `deriveBackend`
overlay applied to the already-built root object never reaches a
`transaction()` handle that way, so a profile that wants its `lineage`
honored at commit time must thread it through `EngineProvisioning.lineage`,
which reaches every `transaction()` handle the same way `catalog` does. For
the same reason, never attach one `lineage` to the root object and a
different one to the profile: the plan's anchor is minted from the root's
`lineage` and the commit guard compares it against the handle's, and two
sources' revisions are not comparable — an untouched target would be refused.
Implement `revision`/`changesSince` by running the query ON the `session`
argument (`session.execute`/`session.executeRaw`) — never on a connection
you closed over instead. A `session` is always either the backend that
declared this `lineage` or a `transaction()` handle it built, so nothing
about implementing this member requires opening a connection of your own.

`revision()` must return a token comparable only by equality against another
revision the SAME `lineage` produced — never parsed, ordered, or compared
across two different backends' `lineage`. It reports the engine's revision of
the WHOLE DATABASE, not one graph, which is a stricter (and more useful)
guarantee than the per-graph anchor `revisionTracking` keeps: a caller
re-validating an engine anchor cannot treat a raw revision mismatch as a
divergence the way it does for a per-graph one, because a commit to a
completely unrelated graph on the same engine also bumps this revision — see
`graph-merge/merge.ts`'s `engineAnchorMismatch`, which always confirms a
mismatch through `changesSince` before refusing. `changesSince` must cover
every way a row can change — insert, update, delete, and resurrection after a
delete — deduplicated, and must answer `{ kind: "unbounded" }` rather than
guess whenever it cannot bound the delta for a given revision (an unrecognized
token, or history older than what it retains).

**A revision must identify the database it came from, or the caller anchoring
on it must.** Nothing in `EngineRevision`'s own shape distinguishes a revision
minted by one physical database from a numerically coincidental one minted by
an entirely different database — two independent engines whose counters both
happen to read "r1" are indistinguishable by equality alone. `base-version.ts`
does not trust a raw `lineage.revision()` for this reason: the engine anchor
it mints pairs your revision with the store's own durable per-graph
`typegraph_revision_origins` nonce (`engine:<origin>:<revision>`), the SAME
namespacing the TypeGraph revision anchor already carries, and every
re-validation checks that origin BEFORE ever comparing the bare revision (see
[Lineage and pruned diffs](/graph-merge#lineage-and-pruned-diffs)'s engine
anchor section). If your engine's own revision already carries a durable,
per-database identity of its own (e.g. it is scoped to a specific cluster or
instance and can never collide with another one), `revision()` may fold that
identity into the token itself instead — `base@V`'s pairing still applies on
top, so this is a belt-and-suspenders option, not a requirement. What you must
never do is return a revision whose equality-comparable form could coincide
with another database's, and rely on nothing to disambiguate them.

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

## Refusals you may meet

| Code | When |
| --- | --- |
| `ENGINE_PROFILE_REQUIRES_WRITE_FENCE_DECLARATION` | The profile's resolved capabilities omit `writeFence` — `createSqlBackend` has no write-fence decision to resolve and refuses outright, naming the one capabilities line to add. |
| `WRITE_FENCE_SQL_UNAVAILABLE` | The resolved capabilities declare `mechanism: "advisory"` but the profile's `fenceSql` is missing the member that mechanism/drain combination needs; or `mechanism: "row"` with `drain: "table-lock"` but no `fenceSql.lockTables`. A `"row"` target missing `tableNames.fences` is NOT refused here — it refuses the first time a keyed site actually acquires the fence row. |
| `WRITE_FENCE_DECLARATION_INVALID` | The declared `writeFence` carries an unrecognized `mechanism`, `drain`, or `conflict` string; a `drain` key on a mechanism other than `"advisory"` / `"row"`; a `conflict` key on anything but `"row"`; or `conflict: "commit-time"` on a target whose own `capabilities.execution.interactiveTransactions` is `false` — that value is honored only by the `"optimistic-retry"` execution tier, which never derives without an interactive transaction to replay inside, so accepting it there would silently drop it rather than apply it. `resolveWriteFencePlan` validates the raw value (a plain-JavaScript author is not held to the discriminated-union type) before shaping a plan from it. |
| `CALLER_SERIALIZED_REFUSES_ADOPTION` | `adoptTransaction` was called on a backend whose resolved write-fence plan is `caller-serialized` — an externally owned transaction's lifetime cannot be held by the backend's in-process write-unit queue. |
| `CATALOG_UNAVAILABLE` | A store path that needs the backend's catalog probes (index materialization, the recorded-time schema check, the recorded-time migration's column read) finds `catalog` absent — a profile whose `provisioning.catalog` is unset builds a backend with no `catalog` member at all. |
| `LINEAGE_UNAVAILABLE` | A caller reached `requireLineage` and found `lineage` absent on the backend it asked. Every OUT-OF-TRANSACTION graph-merge caller consults `lineage` through `resolveLineage`, which already falls back to the recorded-relations lineage or to a full comparison rather than hitting this refusal. `assertTargetUnchanged`'s in-transaction re-validation reads the transaction handle's `lineage` ONLY — no fallback to the root — so this fires whenever a `lineage` that anchored the plan (found on the root at plan time) is not ALSO threaded onto the transaction handle that commits it; see "Supplying `lineage`" above for how to thread it correctly. |
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
