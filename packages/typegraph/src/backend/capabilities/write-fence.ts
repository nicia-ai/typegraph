/**
 * The write-fence capability: how this engine excludes concurrent writers,
 * declared as `capabilities.writeFence`.
 *
 * `resolveWriteFencePlan` is THE one owner of the write-fence decision every
 * lock site used to re-derive from `dialect` inline. A lock site never
 * spells the dialect itself; it resolves a plan and consumes it.
 */
import { ConfigurationError } from "../../errors";
import { type SqlTableNames } from "../../query/compiler/schema";
import { type SqlDialect } from "../../query/dialect/types";
import { sql, type SqlFragment } from "../../query/sql-fragment";
import { requireDefined } from "../../utils/presence";
import { type BackendCapabilities } from "../types";

/**
 * The lock-statement spelling a backend supplies alongside its
 * `writeFence` declaration.
 *
 * `advisory` needs `advisoryLockExpression` and `isolationFactExpression`
 * (required by that mechanism's own construction-time check below); `row`
 * needs neither — TypeGraph spells its acquire statement itself from the
 * fences relation — but MAY supply `isolationFactExpression` so recorded
 * capture and match-key convergence can still read the session fact off the
 * same acquisition (absent, they fail closed on an unknown fact, as they do
 * today). `lockTables` is needed by either mechanism only when its
 * declaration's `drain` is `"table-lock"`. Every member therefore stays
 * optional in the type; {@link planFromWriteFenceDeclaration} is what
 * refuses construction when the RESOLVED mechanism/drain combination needed
 * a member this object does not supply.
 *
 * This is deliberately the ONLY spelling a backend author writes.
 * {@link resolveFenceStatements} derives the standalone-statement forms
 * (`acquireKeyed`, `acquireKeyedWithIsolation`, `isolationFact`) from these
 * expressions — a backend never spells both a statement and the expression
 * it wraps separately, so the fused embedding and the standalone statement
 * can never disagree about what they lock or read.
 *
 * `advisoryLockExpression`'s `key` accepts a `number` for the
 * database-scoped locks that key on a constant second argument (`0`) rather
 * than a hashed value — the two-argument `pg_advisory_xact_lock(int4, int4)`
 * overload takes that second argument as a plain integer, never as
 * `hashtext(...)` of one.
 */
export type FenceSql = Readonly<{
  /** A relation lock, e.g. `LOCK TABLE ... IN ... MODE`. */
  lockTables?: (
    tables: readonly string[],
    mode: "share" | "share-row-exclusive" | "access-exclusive",
  ) => SqlFragment;
  /**
   * The bare lock expression, with no `SELECT` around it. A statement that
   * must take the lock INSIDE a larger query it composes itself embeds this
   * directly — PostgreSQL's fused schema + graph-write fence
   * (`postgres-schema-write-fence.ts`) is the one site that needs this: it
   * reaches the schema table, so it cannot be built from a standalone
   * statement. Every other lock site consumes
   * {@link resolveFenceStatements}'s derived `acquireKeyed`, which wraps
   * this in a standalone `SELECT`. Absent for a `row`-mechanism target,
   * which has no lock expression to embed.
   */
  advisoryLockExpression?: (
    namespace: string,
    key: string | number,
  ) => SqlFragment;
  /**
   * The bare session isolation-level read, with no `SELECT`/alias around
   * it — embedded the same way `advisoryLockExpression` is, and wrapped by
   * {@link resolveFenceStatements}'s derived `isolationFact` /
   * `acquireKeyedWithIsolation` for every other site.
   */
  isolationFactExpression?: () => SqlFragment;
}>;

/**
 * `FenceSql`'s author-supplied expressions plus the three
 * mechanism-neutral standalone-statement forms {@link resolveFenceStatements}
 * derives from them — what a `lock` or `row` plan's `sql` field actually
 * carries, and what every ordinary lock site consumes. A site never asks
 * which mechanism produced its `sql`; it calls `acquireKeyed`,
 * `acquireKeyedWithIsolation`, or `isolationFact` exactly the same way
 * either way.
 */
export type FenceStatements = FenceSql &
  Readonly<{
    /**
     * A keyed exclusion, scoped to the transaction: `pg_advisory_xact_lock`
     * under `advisory`, an `INSERT ... ON CONFLICT ... DO UPDATE ...
     * RETURNING` against the fences relation under `row`.
     */
    acquireKeyed: (namespace: string, key: string | number) => SqlFragment;
    /**
     * The same acquisition plus the session's isolation-level fact, in ONE
     * statement — the "session facts come from the session that enforces
     * them" contract: the fact is read on the exact connection the
     * acquisition was just taken on. Under `row` with no
     * `isolationFactExpression` supplied, the acquisition still runs and
     * returns its generation; the isolation fact is simply absent from the
     * row, which the consumers already read as "unknown" and fail closed on.
     */
    acquireKeyedWithIsolation: (
      namespace: string,
      key: string | number,
    ) => SqlFragment;
    /**
     * The bare session isolation-level read, with no acquisition. Yields no
     * row when the target supplies no `isolationFactExpression` — the same
     * "unknown fact" shape a real read produces for a value this fence
     * cannot classify.
     */
    isolationFact: () => SqlFragment;
  }>;

function advisoryAcquireKeyedStatement(
  advisoryLockExpression: NonNullable<FenceSql["advisoryLockExpression"]>,
  namespace: string,
  key: string | number,
): SqlFragment {
  return sql`SELECT ${advisoryLockExpression(namespace, key)}`;
}

function advisoryAcquireKeyedWithIsolationStatement(
  advisoryLockExpression: NonNullable<FenceSql["advisoryLockExpression"]>,
  isolationFactExpression: NonNullable<FenceSql["isolationFactExpression"]>,
  namespace: string,
  key: string | number,
): SqlFragment {
  return sql`
    SELECT
      ${advisoryLockExpression(namespace, key)},
      ${isolationFactExpression()} AS transaction_isolation
  `;
}

/**
 * The composite key every `row`-mechanism acquisition writes: the existing
 * advisory namespace and key, joined verbatim, so the lock-order and
 * namespace-per-position invariants every keyed site already relies on
 * carry over unchanged to the fences relation.
 */
function fenceRowKey(namespace: string, key: string | number): string {
  return `${namespace}:${key}`;
}

/**
 * The portable acquisition statement every `row`-mechanism keyed site
 * shares: an UPSERT that always advances the row's own stored generation
 * (never the literal `1` this statement inserts), so two acquirers of the
 * same key always observe a strictly increasing sequence regardless of
 * which one the engine admits first. `isolationFactExpression`, when
 * supplied, rides the same `RETURNING` clause the generation does, so the
 * fact is read on the exact statement that took the row.
 */
function fenceRowAcquireStatement(
  fencesTable: SqlFragment,
  namespace: string,
  key: string | number,
  isolationFactExpression?: FenceSql["isolationFactExpression"],
): SqlFragment {
  const isolationColumn =
    isolationFactExpression === undefined ?
      sql``
    : sql`, ${isolationFactExpression()} AS transaction_isolation`;
  return sql`
    INSERT INTO ${fencesTable} (key, generation)
    VALUES (${fenceRowKey(namespace, key)}, 1)
    ON CONFLICT (key) DO UPDATE SET generation = ${fencesTable}.generation + 1
    RETURNING generation${isolationColumn}
  `;
}

/**
 * The bare session isolation-level read shared by both mechanisms: wraps
 * `isolationFactExpression` in a standalone `SELECT` when the target
 * supplies one, and otherwise a statement that yields no row — the same
 * "unknown fact" shape {@link normalizeGraphCommandIsolation}-style readers
 * already treat a missing column as, so a target with no expression fails
 * closed exactly as it does today rather than needing a new case.
 */
function isolationFactStatement(
  isolationFactExpression?: FenceSql["isolationFactExpression"],
): SqlFragment {
  return isolationFactExpression === undefined ?
      sql`SELECT NULL AS transaction_isolation WHERE 1 = 0`
    : sql`SELECT ${isolationFactExpression()} AS transaction_isolation`;
}

/**
 * Which derivation {@link resolveFenceStatements} applies — an explicit
 * discriminant, never inferred from what `fenceSql` happens to contain: the
 * BUNDLED PostgreSQL factory always supplies the full `postgresFenceSql`
 * (including `advisoryLockExpression`) as its profile's `fenceSql`
 * REGARDLESS of which mechanism a derived profile declares (a test deriving
 * `writeFence.mechanism: "row"` from the bundled factory does not thereby
 * swap out `fenceSql`), so the SHAPE of `fenceSql` alone cannot say which
 * mechanism resolved. Defaults to `"advisory"` when omitted: both external
 * callers of {@link resolveFenceStatements} outside `planFromWriteFenceDeclaration`
 * (`clock.ts`'s bundled-spelling renderers, `guards.ts`'s dialect-gated
 * isolation read, gated on `dialect` alone, never on a resolved mechanism)
 * only ever want the advisory derivation or call `isolationFact()` — which
 * renders identically under either derivation — so the default costs them
 * nothing.
 */
type FenceStatementsStyle =
  | Readonly<{ mechanism: "advisory" }>
  | Readonly<{ mechanism: "row"; fencesTableName?: string | undefined }>;

const ADVISORY_FENCE_STATEMENTS_STYLE: FenceStatementsStyle = {
  mechanism: "advisory",
};

/**
 * THE one owner of "wrap a fence's acquire/isolation expressions in their
 * standalone statement forms": derives `acquireKeyed`,
 * `acquireKeyedWithIsolation`, and `isolationFact` — the only way to reach
 * those three forms, so a fused embedding and a portable lock site can
 * never spell the lock or the isolation read differently. Called by
 * `planFromWriteFenceDeclaration` once per resolved `lock` or `row` plan
 * (passing its own resolved {@link FenceStatementsStyle} explicitly), and
 * directly by the two callers described on that type for a target's own
 * standalone statements without resolving a full plan.
 */
export function resolveFenceStatements(
  fenceSql: FenceSql,
  style: FenceStatementsStyle = ADVISORY_FENCE_STATEMENTS_STYLE,
): FenceStatements {
  const { isolationFactExpression } = fenceSql;
  if (style.mechanism === "advisory") {
    // Resolved lazily, inside the two acquisition closures below, rather
    // than eagerly here: `guards.ts`'s session-fact read calls this with the
    // default (`"advisory"`) style regardless of which mechanism the target
    // actually declared, wanting only `isolationFact()` — a `row` target
    // that supplies `isolationFactExpression` but no `advisoryLockExpression`
    // must still get a rendered fact read from that call, not a `TypeError`
    // for a member `isolationFact()` never needed. `isolationFact()` itself
    // never requires either expression: it renders identically to the `row`
    // derivation's own `isolationFactStatement` call, the "costs them
    // nothing" default the module doc above promises.
    function requiredAdvisoryLockExpression(): NonNullable<
      FenceSql["advisoryLockExpression"]
    > {
      return requireDefined(
        fenceSql.advisoryLockExpression,
        "resolveFenceStatements: an advisory fenceSql's advisoryLockExpression was validated present above",
      );
    }
    function requiredIsolationFactExpression(): NonNullable<
      FenceSql["isolationFactExpression"]
    > {
      return requireDefined(
        isolationFactExpression,
        "resolveFenceStatements: an advisory fenceSql's isolationFactExpression was validated present above",
      );
    }
    return {
      ...fenceSql,
      acquireKeyed: (namespace: string, key: string | number) =>
        advisoryAcquireKeyedStatement(
          requiredAdvisoryLockExpression(),
          namespace,
          key,
        ),
      acquireKeyedWithIsolation: (namespace: string, key: string | number) =>
        advisoryAcquireKeyedWithIsolationStatement(
          requiredAdvisoryLockExpression(),
          requiredIsolationFactExpression(),
          namespace,
          key,
        ),
      isolationFact: () => isolationFactStatement(isolationFactExpression),
    };
  }
  // Resolved lazily, inside the two closures below, rather than eagerly
  // here: a `row` plan is shaped for EVERY resolved declaration, including
  // one a purely drain-side site (J4, J6, J18) resolves without ever
  // calling `acquireKeyed`/`acquireKeyedWithIsolation` — such a site must
  // not refuse over a fences table name it never needed. The refusal below
  // therefore fires the first time one of those two is actually CALLED, not
  // when this function returns — `WriteFenceTarget.tableNames`' own doc
  // names this same deferral.
  const { fencesTableName } = style;
  function requiredFencesTable(): SqlFragment {
    if (fencesTableName === undefined) {
      throw new ConfigurationError(
        "This row-mechanism write fence has no fences table name " +
          "(`tableNames.fences`), so TypeGraph cannot spell the fence-row " +
          "acquisition.",
        { code: "WRITE_FENCE_SQL_UNAVAILABLE" },
        {
          suggestion:
            "Supply `tableNames.fences` on this backend (the bundled SQLite/PostgreSQL backends default it to `typegraph_fences`).",
        },
      );
    }
    return sql.identifier(fencesTableName);
  }
  return {
    ...fenceSql,
    acquireKeyed: (namespace: string, key: string | number) =>
      fenceRowAcquireStatement(requiredFencesTable(), namespace, key),
    acquireKeyedWithIsolation: (namespace: string, key: string | number) =>
      fenceRowAcquireStatement(
        requiredFencesTable(),
        namespace,
        key,
        isolationFactExpression,
      ),
    isolationFact: () => isolationFactStatement(isolationFactExpression),
  };
}

/**
 * How a backend excludes concurrent writers, and how far a caller that took
 * the lock can drain the resource it protects.
 *
 * `mechanism` is the exclusion primitive: `"advisory"` is a keyed
 * `pg_advisory_xact_lock`-style lock a caller takes explicitly (and needs
 * `fenceSql` to spell); `"row"` is a keyed exclusion spelled by TypeGraph
 * itself against a never-dropped relation of fence rows, for an engine with
 * no advisory-lock primitive; `"engine-serialized"` is the engine's own
 * single writer slot (SQLite); `"caller-serialized"` is a promise the
 * DEPLOYMENT makes rather than the engine or a lock — the backend's own
 * process serializes every write unit it issues (see the in-process queue
 * this mechanism requires) AND no other client writes to the same database
 * while this backend is open.
 *
 * `drain` is a separate fact, and applies ONLY to `mechanism: "advisory"` or
 * `"row"`: whether a caller that already took the keyed exclusion can
 * additionally take a relation-wide lock on the resource a table-lock site
 * protects. `"table-lock"` means yes (a `LOCK TABLE`-style statement is
 * available and appropriate); `"quiescent"` means the resource is already
 * exclusive for another reason (e.g. a `caller-serialized` in-process queue
 * layered alongside an advisory lock) so a table-lock site takes NO
 * statement rather than one it does not need; `"none"` means neither — a
 * table-lock site refuses, naming this drain. `"engine-serialized"` and
 * `"caller-serialized"` carry no `drain`: an engine's single writer slot and
 * an in-process serialization promise are each already a stronger exclusion
 * than any `drain` value could add, so there is nothing for the field to say
 * — declaring one alongside either mechanism is refused
 * (`WRITE_FENCE_DECLARATION_INVALID`, `validateWriteFenceDeclaration` below).
 *
 * `conflict` applies ONLY to `mechanism: "row"`: the engine fact for two
 * writers of one fence row. `"wait"` is a lock-based engine — the second
 * acquirer's statement blocks until the first commits, exactly like an
 * advisory lock. `"commit-time"` is an optimistic-concurrency engine — both
 * acquirers proceed and the loser's COMMIT fails, so correctness comes from
 * the unit owner retrying it, never from waiting; the retry can only run
 * inside an interactive transaction it replays, so `"commit-time"` requires
 * `capabilities.execution.interactiveTransactions: true` and is refused on a
 * backend that declares it `false` — the tier `commit-time` needs would
 * silently never derive otherwise (`WRITE_FENCE_DECLARATION_INVALID`,
 * `validateWriteFenceDeclaration` below). Declaring `conflict` on any other
 * mechanism is refused the same way an out-of-place `drain` is.
 */
export type WriteFenceDeclaration =
  | Readonly<{
      mechanism: "advisory";
      drain: "table-lock" | "quiescent" | "none";
    }>
  | Readonly<{
      mechanism: "row";
      drain: "table-lock" | "quiescent" | "none";
      conflict: "wait" | "commit-time";
    }>
  | Readonly<{ mechanism: "engine-serialized" }>
  | Readonly<{ mechanism: "caller-serialized" }>;

/**
 * The two members of {@link WriteFenceDeclaration} that carry `drain` —
 * named so a function that runs for either a resolved `"advisory"` or
 * `"row"` declaration (the fence-SQL refusal below) can say so in its own
 * parameter type instead of accepting the full union and re-widening
 * `drain` into "possibly absent".
 */
type DrainCarryingWriteFenceDeclaration = Extract<
  WriteFenceDeclaration,
  { mechanism: "advisory" | "row" }
>;

/**
 * The decision every lock site consumes, rather than a flag a caller would
 * have to re-derive.
 */
export type WriteFencePlan =
  /**
   * Take the keyed advisory lock, spelled by `sql` — the target's OWN
   * declared spelling: a lock site never hand-writes the statement, it
   * resolves a plan and consumes `sql.<builder>(…)`.
   */
  | Readonly<{
      kind: "lock";
      drain: "table-lock" | "quiescent" | "none";
      sql: FenceStatements;
    }>
  /**
   * Take the keyed exclusion against the fences relation, spelled by `sql` —
   * mechanism-neutral: a keyed site calls the exact same `sql.acquireKeyed`/
   * `sql.acquireKeyedWithIsolation` a `lock` plan's site calls. `conflict`
   * is the one fact a `row` site (and the tier deriving `optimistic-retry`)
   * reads that a `lock` site never needs, because an advisory engine only
   * ever waits.
   */
  | Readonly<{
      kind: "row";
      drain: "table-lock" | "quiescent" | "none";
      conflict: "wait" | "commit-time";
      sql: FenceStatements;
    }>
  /** No lock needed: the engine serializes writers. */
  | Readonly<{ kind: "engine-serialized" }>
  /**
   * No lock needed: the deployment itself promises no concurrent writer
   * exists — this backend's own process serializes every write unit it
   * issues, and no other client writes to the database while it is open.
   */
  | Readonly<{ kind: "caller-serialized" }>
  /** Neither. Every non-degradable fence refuses: `capabilities.writeFence` is absent. */
  | Readonly<{ kind: "unfenced" }>;

/**
 * What `resolveWriteFencePlan` needs: the dialect (for the first-party
 * dialect-derivation arm and for the refusal message), the declared
 * capabilities, the lock-statement spelling a resolved `"advisory"` or
 * `"row"` mechanism requires, and — for `"row"` — the resolved table names
 * carrying the physical name of the fences relation
 * `resolveFenceStatements` spells its acquisition against. Structural on
 * purpose — see the module-private first-party mark below, which is
 * carried out-of-band rather than as a type member. `GraphBackend`'s own
 * `tableNames` field already satisfies this structurally, so every lock
 * site that calls `resolveWriteFencePlan(target)` with the backend itself —
 * narrowed to whatever `Pick<GraphBackend, ...>` that site declares — reads
 * the SAME resolved fences table name a `row`-mechanism backend was built
 * with, with no separate field to keep in sync.
 */
export type WriteFenceTarget = Readonly<{
  dialect: SqlDialect;
  capabilities: BackendCapabilities;
  fenceSql?: FenceSql | undefined;
  /**
   * Read only when the resolved mechanism is `"row"` — specifically
   * `tableNames.fences`. Typed as the same optional-field `SqlTableNames`
   * `GraphBackend.tableNames` declares (rather than the fully resolved
   * `ResolvedSqlTableNames`) so every existing lock site that passes the
   * backend itself as this target — narrowed to whatever `Pick<GraphBackend,
   * ...>` that site declares — stays structurally assignable with no
   * changes; a target whose `tableNames.fences` is genuinely absent refuses
   * the first time a keyed site actually acquires the fence row instead
   * (`resolveFenceStatements`'s `requiredFencesTable`, called lazily so a
   * purely drain-side site that never acquires never refuses over a name it
   * never needed).
   */
  tableNames?: SqlTableNames | undefined;
}>;

/**
 * Marks a backend (or a small fence-target object built alongside one) as
 * produced by `createSqliteBackend` / `createPostgresBackend`, so
 * `resolveWriteFencePlan`'s dialect-derivation arm — correct only for a
 * factory backend, unsound for anything else (M-5) — is reachable only from
 * them.
 *
 * A `WeakSet<object>` keyed by object identity, not a `unique symbol`
 * property: `deriveBackend` returns a `Proxy` whose `set` trap writes
 * through to a possibly-frozen base, so a symbol property written at
 * construction is not guaranteed to survive every derivation the same way a
 * side-table entry does, and a `WeakSet` is unforgeable by a custom
 * backend in a way a plain property is not. Module-private and NOT
 * barrelled: nothing outside this module and `derive-backend.ts` may mark or
 * carry the mark.
 */
const FIRST_PARTY_FACTORY_BACKENDS = new WeakSet<object>();

/**
 * The two first-party factories call this on the backend object they are
 * about to return (or on a small fence-target object built alongside one),
 * before it escapes the factory body.
 *
 * @internal
 */
export function markFirstPartyFactory<T extends object>(target: T): T {
  FIRST_PARTY_FACTORY_BACKENDS.add(target);
  return target;
}

/**
 * Whether `target` came from one of TypeGraph's bundled backend factories.
 *
 * This stays an out-of-band, unforgeable fact for the same reason as
 * {@link markFirstPartyFactory}: an arbitrary backend that happens to report
 * the same dialect cannot thereby opt into an optimization whose transaction
 * lifetime TypeGraph has not audited.
 *
 * @internal
 */
export function isFirstPartyFactory(target: object): boolean {
  return FIRST_PARTY_FACTORY_BACKENDS.has(target);
}

/**
 * Carries the first-party mark from a source object onto one derived from
 * it, so a factory backend projected or decorated for a transaction still
 * resolves the SAME plan its source would — a lost mark would otherwise
 * answer "dialect-derived" at one call site and "unfenced" at another for
 * the same underlying backend.
 *
 * `src/backend/derive-backend.ts` is the only module allowed to call this,
 * alongside its call to `carryBackendResourceAudit`.
 *
 * @internal
 */
export function carryFirstPartyFactoryMark(
  derived: object,
  base: object,
): void {
  if (FIRST_PARTY_FACTORY_BACKENDS.has(base)) {
    FIRST_PARTY_FACTORY_BACKENDS.add(derived);
  }
}

/**
 * The bundled-profile objects `buildSqliteEngineProfile` and
 * `buildPostgresEngineProfile` returned, keyed by object identity rather
 * than a field. Module-private for the same reason
 * `FIRST_PARTY_FACTORY_BACKENDS` is: `registerFirstPartyProfile` grants
 * standing to the ONE object each builder returns, so a copy, spread, or
 * otherwise derived profile is a new object this set has never seen and is
 * never first-party — no field on it could carry the standing forward the
 * way a spread carries every other key.
 */
const FIRST_PARTY_PROFILES = new WeakSet<object>();

/**
 * The `SqlEngineProfile` fields `registerFirstPartyProfile` freezes beyond
 * the profile object itself — read through this narrow structural shape
 * rather than `SqlEngineProfile` itself, so this module (below
 * `create-sql-backend.ts` and `./profile` in the dependency order) need not
 * import the profile type to reach them.
 */
type ProfileTrustBearingBags = Readonly<{
  declaredCapabilities?: object;
  resourceAudit?: object;
  autocommit?: object;
  tableNames?: object;
  fenceSql?: object;
}>;

/**
 * Registers `profile` as first-party and returns the SAME object, frozen —
 * a builder writes `const profile: SqlEngineProfile<...> = {...}; return
 * registerFirstPartyProfile(profile);` and hands its caller back exactly the
 * object this set now recognizes. Called once each by
 * `buildSqliteEngineProfile` and `buildPostgresEngineProfile` on the exact
 * object they return. Not exported from `src/backend/index.ts` or the
 * `adapters/drizzle/engine` entrypoint, so nothing outside this module can
 * grant a profile first-party standing — a profile assembled anywhere else,
 * including one built by spreading a bundled profile's fields into a new
 * object literal, is a different object and is never registered.
 *
 * The `Object.freeze` on `profile` itself binds its own fields — a caller
 * cannot replace `profile.resourceAudit` with a different object — but that
 * alone leaves every sub-object still mutable in place. That matters because
 * `deriveEngineProfile` builds a derived profile as `{...base, ...overrides}`:
 * any field `overrides` does not name is the SAME sub-object `base` holds,
 * not a copy, so `derived.resourceAudit.kind = "serialized"` would otherwise
 * mutate `base.resourceAudit` directly, behind the override validation that
 * only ever sees `overrides`. So this also freezes the bags a derived
 * profile shares with `base` by reference: `resourceAudit`, `autocommit`,
 * `tableNames`, `fenceSql`, and `declaredCapabilities` — their OWN fields,
 * not what those fields point to. `declaredCapabilities` arrives already
 * sealed: each builder passes its declaration through
 * `sealCapabilityDeclaration` (`./declarations`), the one owner of "clone,
 * then deep-freeze", so the bag is immutable all the way down and never
 * aliases an object the caller supplied as an override. `resourceAudit
 * .resource` and `identityLeaseResource` stay reachable and mutable: those
 * are the driver's own connection handles, not data TypeGraph owns, and
 * freezing the `resourceAudit` object itself already blocks swapping which
 * handle it names. `fenceSql`'s own functions stay reachable and mutable
 * too — this freeze binds only the CONTAINER, so a derived profile can
 * still be constructed with a fresh `fenceSql` override, but it blocks a
 * caller from reassigning `derived.fenceSql.advisoryLockExpression` (or any
 * other member) in place, which would otherwise silently rewrite the
 * spelling `base.fenceSql` hands back too. Every other profile field is a
 * closure this module has no business freezing (`execution`, `provisioning`,
 * the six `*Runtime` bags, `assembly`).
 *
 * `deriveEngineProfile` itself is unaffected beyond this: it reads `base`'s
 * fields and spreads them into a NEW object literal, which spreading a
 * frozen source object does not freeze — a caller who overrides
 * `declaredCapabilities` with a fresh literal gets back a profile whose
 * `declaredCapabilities` is that fresh, unfrozen object, exactly as before.
 *
 * @internal
 */
export function registerFirstPartyProfile<T extends object>(profile: T): T {
  FIRST_PARTY_PROFILES.add(profile);
  const bags = profile as ProfileTrustBearingBags;
  if (bags.declaredCapabilities !== undefined) {
    Object.freeze(bags.declaredCapabilities);
  }
  if (bags.resourceAudit !== undefined) Object.freeze(bags.resourceAudit);
  if (bags.autocommit !== undefined) Object.freeze(bags.autocommit);
  if (bags.tableNames !== undefined) Object.freeze(bags.tableNames);
  if (bags.fenceSql !== undefined) Object.freeze(bags.fenceSql);
  return Object.freeze(profile);
}

/**
 * Whether `profile` is an object {@link registerFirstPartyProfile} has
 * actually registered.
 *
 * `createSqlBackend` calls this once per assembly and uses the result to
 * gate every `markFirstPartyFactory` call it makes — on the backend it
 * returns and on the one fence target it builds. A profile this module
 * never registered leaves both unmarked, which in turn keeps two things
 * closed to it: `resolveWriteFencePlan`'s dialect-derivation fallback
 * (sound only for the two bundled dialects) and the lazy schema-fence
 * lease `src/store/operations/write-transaction.ts` takes out under
 * `isFirstPartyFactory`.
 *
 * @internal
 */
export function isFirstPartyProfile(profile: object): boolean {
  return FIRST_PARTY_PROFILES.has(profile);
}

/**
 * The write-fence declaration a first-party (bundled-factory) target derives
 * when its `capabilities` name no `writeFence` — exactly what every lock
 * site used to compute inline from `dialect` before this capability
 * existed. `writeFenceDeclarationLine` formats this same derivation as the
 * migration-guide literal a refusal prints, so the derivation and the
 * printed suggestion can never disagree.
 */
function deriveFromDialect(dialect: SqlDialect): WriteFenceDeclaration {
  switch (dialect) {
    case "postgres": {
      return { mechanism: "advisory", drain: "table-lock" };
    }
    case "sqlite": {
      return { mechanism: "engine-serialized" };
    }
    default: {
      return dialect satisfies never;
    }
  }
}

/**
 * Which declaration style {@link planFromWriteFenceDeclaration} resolved its
 * `WriteFenceDeclaration` from — carried only so
 * {@link refuseWriteFenceSqlUnavailable} can name the declaration the target
 * ACTUALLY made, rather than assuming a shape unconditionally.
 *
 * - `"writeFence"` — the target declared `capabilities.writeFence` directly.
 * - `"dialect"` — `writeFence` is absent; a first-party factory target's
 *   `mechanism` came from {@link deriveFromDialect}.
 */
type WriteFenceDeclarationSource = "writeFence" | "dialect";

/**
 * Names the declaration {@link refuseWriteFenceSqlUnavailable} blames for
 * promising a keyed exclusion this target cannot spell — the phrase each of
 * its two provenances (a direct `writeFence`, or the first-party dialect
 * derivation) fills in differently, so the refusal never states a
 * declaration the target did not actually make. The first-party dialect
 * derivation never resolves `mechanism: "row"` (only a bundled factory's
 * OWN `advisory`/`engine-serialized` split, {@link deriveFromDialect}), so
 * its phrase always describes an advisory lock; a directly declared `row`
 * still reads correctly through `formatWriteFenceDeclaration`.
 */
function describeResolvedDrainCarryingDeclaration(
  declaration: DrainCarryingWriteFenceDeclaration,
  source: WriteFenceDeclarationSource,
  dialect: SqlDialect,
): string {
  switch (source) {
    case "writeFence": {
      return `declares \`capabilities.${formatWriteFenceDeclaration(declaration)}\``;
    }
    case "dialect": {
      return `resolves an advisory-lock write fence from its \`${dialect}\` dialect`;
    }
    default: {
      return source satisfies never;
    }
  }
}

/**
 * Whether `fenceSql` actually supplies `member` as a callable — the runtime
 * check behind {@link refuseWriteFenceSqlUnavailable}'s per-member refusal.
 * `FenceSql`'s members are each optional on the type (a `row`-mechanism
 * target genuinely need not supply `advisoryLockExpression`, for one), so
 * this is the one place that turns "does this resolved mechanism/drain
 * combination actually have what it needs?" into a yes/no a caller can
 * refuse on — for BOTH a hand-built `fenceSql` missing a member its
 * declaration promised, and a mechanism that simply never needed the member
 * in the first place.
 */
function fenceSqlMemberPresent(
  fenceSql: FenceSql | undefined,
  member: keyof FenceSql,
): boolean {
  return typeof fenceSql?.[member] === "function";
}

/**
 * What TypeGraph cannot spell without `member` — the phrase
 * {@link refuseWriteFenceSqlUnavailable} interpolates into its message so a
 * caller reads which statement is missing, not just that "something" is.
 */
function fenceSqlMemberPurpose(member: keyof FenceSql): string {
  switch (member) {
    case "advisoryLockExpression": {
      return "advisory-lock statement this fence needs to take";
    }
    case "isolationFactExpression": {
      return "session isolation-level read this fence needs to take";
    }
    case "lockTables": {
      return 'table-lock statement its drain: "table-lock" declaration needs to take';
    }
    default: {
      return member satisfies never;
    }
  }
}

/**
 * THE refusal for a `lock` or `row` decision whose target supplies no
 * spelling — or an incomplete one — to take it with: never defaulted, never
 * silently degraded to `unfenced`. The declaration already promised a real
 * keyed exclusion exists, so the only honest response to a missing spelling
 * is to say so, naming the exact `fenceSql` member the resolved
 * mechanism/drain combination needed and could not find.
 *
 * The one call site is `planFromWriteFenceDeclaration`, shared by every
 * `resolveWriteFencePlan` arm that can resolve `mechanism: "advisory"` or
 * `"row"` — a declared `writeFence` and the first-party dialect derivation
 * both resolve through it, and each passes its own
 * {@link WriteFenceDeclarationSource} so the message names the declaration
 * the target actually made.
 *
 * @throws {ConfigurationError} always.
 */
function refuseWriteFenceSqlUnavailable(
  dialect: SqlDialect,
  declaration: DrainCarryingWriteFenceDeclaration,
  source: WriteFenceDeclarationSource,
  member: keyof FenceSql,
): never {
  throw new ConfigurationError(
    `This backend ${describeResolvedDrainCarryingDeclaration(declaration, source, dialect)} ` +
      `but its \`fenceSql\` is missing \`${member}\`, so TypeGraph cannot ` +
      `spell the ${fenceSqlMemberPurpose(member)}.`,
    {
      code: "WRITE_FENCE_SQL_UNAVAILABLE",
      dialect,
      member,
      drain: declaration.drain,
    },
    {
      suggestion:
        dialect === "postgres" ?
          "Supply `fenceSql: postgresFenceSql` (exported from `@nicia-ai/typegraph/adapters/drizzle/postgres`) — the bundled PostgreSQL backend does this automatically — or provide a custom FenceSql matching this engine's lock syntax."
        : 'Provide a custom `fenceSql: FenceSql` matching this engine\'s lock syntax, or declare `writeFence.mechanism: "engine-serialized"` instead.',
    },
  );
}

/**
 * THE refusal for a session-fact read (no lock plan involved) whose target
 * supplies no `fenceSql` to spell it with. Distinct from
 * {@link refuseWriteFenceSqlUnavailable}: that refusal fires only under a
 * resolved `lock` plan, so it can name the declaration that actually
 * resolved to `mechanism: "advisory"` — a claim that makes no sense for a
 * target with no lock plan in play at all (e.g. one declaring `mechanism:
 * "engine-serialized"`). A session-fact read is gated on `dialect` alone,
 * not on a resolved plan, so it needs its own refusal naming what it
 * actually needs.
 *
 * @throws {ConfigurationError} always.
 */
export function refuseFenceSqlSessionFactUnavailable(
  dialect: SqlDialect,
): never {
  throw new ConfigurationError(
    `This ${dialect}-dialect backend supplies no \`fenceSql\`, so TypeGraph ` +
      "cannot spell the session isolation-level read recorded capture requires.",
    { code: "WRITE_FENCE_SQL_UNAVAILABLE", dialect },
    {
      suggestion:
        dialect === "postgres" ?
          "Supply `fenceSql: postgresFenceSql` (exported from `@nicia-ai/typegraph/adapters/drizzle/postgres`) — the bundled PostgreSQL backend does this automatically — or provide a custom FenceSql matching this engine's lock syntax."
        : "Provide a custom `fenceSql: FenceSql` matching this engine's lock syntax.",
    },
  );
}

/** {@link validateWriteFenceDeclaration}'s accepted `mechanism` values. */
const VALID_WRITE_FENCE_MECHANISMS = [
  "advisory",
  "row",
  "engine-serialized",
  "caller-serialized",
] as const;

/** {@link validateWriteFenceDeclaration}'s accepted `drain` values. */
const VALID_WRITE_FENCE_DRAINS = ["table-lock", "quiescent", "none"] as const;

/**
 * {@link validateWriteFenceDeclaration}'s accepted `conflict` values —
 * `mechanism: "row"` only.
 */
const VALID_WRITE_FENCE_CONFLICTS = ["wait", "commit-time"] as const;

/**
 * THE refusal for a `WriteFenceDeclaration` field TypeScript's discriminated
 * union cannot police at runtime — see {@link validateWriteFenceDeclaration}.
 *
 * @throws {ConfigurationError} always.
 */
function refuseInvalidWriteFenceDeclaration(
  field: "mechanism" | "drain" | "conflict",
  value: unknown,
  accepted: readonly string[],
): never {
  throw new ConfigurationError(
    `capabilities.writeFence.${field} is invalid: ${JSON.stringify(value)}. ` +
      `Accepted values are ${accepted.map((accepted) => `"${accepted}"`).join(", ")}.`,
    { code: "WRITE_FENCE_DECLARATION_INVALID", field, value, accepted },
    {
      suggestion: `Declare capabilities.writeFence.${field} as one of the accepted values.`,
    },
  );
}

/**
 * THE one validator of a raw `WriteFenceDeclaration` value, run before
 * {@link planFromWriteFenceDeclaration} shapes a plan from it.
 *
 * TypeScript's discriminated union only holds a caller who goes through the
 * type checker — a plain-JavaScript backend author, or a value round-tripped
 * through JSON/config, can supply any string for `mechanism` or `drain`, or
 * attach a `drain` to a serialized mechanism that accepts none. Every one of
 * those is refused HERE, before a plan is shaped, for two reasons a
 * downstream `default` arm cannot provide on its own: an invalid `drain`
 * must never fall through to behaving like `"quiescent"` (a table-lock site
 * would then silently take no lock instead of refusing), and an invalid
 * `mechanism` must never reach a switch's `default` arm, which — unlike this
 * validator — has no reason to believe the value it was handed is one of the
 * cases it already exhausted, and `x satisfies never` is a compile-time
 * assertion only: at runtime it would return the invalid string as though it
 * were a resolved plan.
 *
 * `interactiveTransactions` is the target's OWN `capabilities.execution`
 * fact (never re-derived here), checked only against `conflict:
 * "commit-time"`: that value is honored solely by the `optimistic-retry`
 * execution tier replaying a unit inside an interactive transaction, and
 * `finalizeEngineCapabilities` derives that tier only when
 * `interactiveTransactions` is `true` — declaring `"commit-time"` on a
 * backend that reports `false` would otherwise be accepted here and then
 * silently dropped downstream (the loser would fail with no retry). An
 * accepted declaration is applied or refused; it is never ignored.
 */
function validateWriteFenceDeclaration(
  declaration: WriteFenceDeclaration,
  interactiveTransactions: boolean,
): void {
  const mechanism: string = declaration.mechanism;
  if (
    !(VALID_WRITE_FENCE_MECHANISMS as readonly string[]).includes(mechanism)
  ) {
    refuseInvalidWriteFenceDeclaration(
      "mechanism",
      mechanism,
      VALID_WRITE_FENCE_MECHANISMS,
    );
  }
  if (mechanism === "advisory" || mechanism === "row") {
    const drain: string = (declaration as DrainCarryingWriteFenceDeclaration)
      .drain;
    if (!(VALID_WRITE_FENCE_DRAINS as readonly string[]).includes(drain)) {
      refuseInvalidWriteFenceDeclaration(
        "drain",
        drain,
        VALID_WRITE_FENCE_DRAINS,
      );
    }
    if (mechanism === "row") {
      const conflict: string = (
        declaration as Extract<WriteFenceDeclaration, { mechanism: "row" }>
      ).conflict;
      if (
        !(VALID_WRITE_FENCE_CONFLICTS as readonly string[]).includes(conflict)
      ) {
        refuseInvalidWriteFenceDeclaration(
          "conflict",
          conflict,
          VALID_WRITE_FENCE_CONFLICTS,
        );
      }
      if (conflict === "commit-time" && !interactiveTransactions) {
        throw new ConfigurationError(
          'capabilities.writeFence.conflict: "commit-time" requires ' +
            "capabilities.execution.interactiveTransactions: true — the " +
            '"optimistic-retry" execution tier that replays a commit-time ' +
            "loser only derives on an interactive backend; on a " +
            "non-interactive one the declaration would be accepted and then " +
            "silently dropped, leaving the loser's write fail with no retry.",
          {
            code: "WRITE_FENCE_DECLARATION_INVALID",
            field: "conflict",
            mechanism,
            conflict,
          },
          {
            suggestion:
              'Declare capabilities.execution.interactiveTransactions: true, or declare conflict: "wait" instead.',
          },
        );
      }
      return;
    }
    // mechanism === "advisory": `conflict` is a `row`-only fact (the engine
    // behavior of two writers of ONE fence row), which an advisory lock
    // never has — a caller declaring it here is refused the same way a
    // stray `drain` on a serialized mechanism is, below.
    if ("conflict" in declaration) {
      throw new ConfigurationError(
        'capabilities.writeFence.conflict applies only to mechanism: "row"; ' +
          '"advisory" must not declare a conflict.',
        {
          code: "WRITE_FENCE_DECLARATION_INVALID",
          field: "conflict",
          mechanism,
        },
        {
          suggestion:
            'Remove conflict from this writeFence declaration — mechanism: "advisory" needs none.',
        },
      );
    }
    return;
  }
  if ("drain" in declaration) {
    throw new ConfigurationError(
      "capabilities.writeFence.drain applies only to " +
        `mechanism: "advisory" or "row"; "${mechanism}" must not declare a drain.`,
      {
        code: "WRITE_FENCE_DECLARATION_INVALID",
        field: "drain",
        mechanism,
      },
      {
        suggestion: `Remove drain from this writeFence declaration — mechanism: "${mechanism}" needs none.`,
      },
    );
  }
  if ("conflict" in declaration) {
    throw new ConfigurationError(
      "capabilities.writeFence.conflict applies only to " +
        `mechanism: "row"; "${mechanism}" must not declare a conflict.`,
      {
        code: "WRITE_FENCE_DECLARATION_INVALID",
        field: "conflict",
        mechanism,
      },
      {
        suggestion: `Remove conflict from this writeFence declaration — mechanism: "${mechanism}" needs none.`,
      },
    );
  }
}

/**
 * THE one constructor of a {@link WriteFencePlan} from an already-resolved
 * {@link WriteFenceDeclaration}, regardless of which declaration style
 * produced it (`capabilities.writeFence` directly, or the first-party
 * dialect derivation). One owner means both provenances resolve to the
 * identical plan shape.
 *
 * `source` names which of those two provenances `declaration` came from —
 * threaded only to {@link refuseWriteFenceSqlUnavailable}, so a missing
 * `fenceSql` is blamed on the declaration the target actually made.
 */
function planFromWriteFenceDeclaration(
  target: WriteFenceTarget,
  declaration: WriteFenceDeclaration,
  source: WriteFenceDeclarationSource,
): WriteFencePlan {
  validateWriteFenceDeclaration(
    declaration,
    target.capabilities.execution.interactiveTransactions,
  );
  switch (declaration.mechanism) {
    case "advisory": {
      if (!fenceSqlMemberPresent(target.fenceSql, "advisoryLockExpression")) {
        refuseWriteFenceSqlUnavailable(
          target.dialect,
          declaration,
          source,
          "advisoryLockExpression",
        );
      }
      if (!fenceSqlMemberPresent(target.fenceSql, "isolationFactExpression")) {
        refuseWriteFenceSqlUnavailable(
          target.dialect,
          declaration,
          source,
          "isolationFactExpression",
        );
      }
      if (
        declaration.drain === "table-lock" &&
        !fenceSqlMemberPresent(target.fenceSql, "lockTables")
      ) {
        refuseWriteFenceSqlUnavailable(
          target.dialect,
          declaration,
          source,
          "lockTables",
        );
      }
      return {
        kind: "lock",
        drain: declaration.drain,
        sql: resolveFenceStatements(
          requireDefined(
            target.fenceSql,
            "resolveWriteFencePlan: fenceSql was validated present above",
          ),
        ),
      };
    }
    case "row": {
      if (
        declaration.drain === "table-lock" &&
        !fenceSqlMemberPresent(target.fenceSql, "lockTables")
      ) {
        refuseWriteFenceSqlUnavailable(
          target.dialect,
          declaration,
          source,
          "lockTables",
        );
      }
      return {
        kind: "row",
        drain: declaration.drain,
        conflict: declaration.conflict,
        // `target.fenceSql` may be entirely absent for a `row` target that
        // declares no isolation read and no table-lock drain — `FenceSql`'s
        // members are all optional, so `{}` is itself a valid (empty) one.
        // `mechanism: "row"` is passed explicitly, never inferred from
        // `fenceSql`'s shape: the bundled PostgreSQL factory's `fenceSql` is
        // the same `postgresFenceSql` object (advisoryLockExpression
        // included) regardless of which mechanism this declaration names.
        sql: resolveFenceStatements(target.fenceSql ?? {}, {
          mechanism: "row",
          fencesTableName: target.tableNames?.fences,
        }),
      };
    }
    case "engine-serialized": {
      return { kind: "engine-serialized" };
    }
    case "caller-serialized": {
      return { kind: "caller-serialized" };
    }
    default: {
      // Unreachable for a TypeScript-typed caller (exhaustive above) and for
      // any runtime value too: `validateWriteFenceDeclaration` already
      // refused an unrecognized `mechanism` before this switch ran. Refuses
      // rather than returning `declaration.mechanism satisfies never` —
      // which, for an actual invalid string reaching here, would hand that
      // string back as though it were a resolved `WriteFencePlan`.
      return refuseInvalidWriteFenceDeclaration(
        "mechanism",
        (declaration as WriteFenceDeclaration).mechanism,
        VALID_WRITE_FENCE_MECHANISMS,
      );
    }
  }
}

/**
 * THE one reader of `capabilities.writeFence`, and THE one constructor of a
 * {@link WriteFencePlan}.
 *
 * Resolution order:
 *
 * 1. **`writeFence` declared** — resolve it directly through
 *    {@link planFromWriteFenceDeclaration}.
 * 2. **Undeclared, first-party factory** — derive from `dialect`
 *    ({@link deriveFromDialect}), which is exactly what every lock site used
 *    to compute inline. Both bundled factories declare `writeFence`
 *    unconditionally, so nothing in-tree reaches this arm; it is reachable
 *    only from tests that build a backend object bypassing the factories'
 *    declared capabilities while still carrying the first-party mark.
 * 3. **Undeclared, anything else** — `unfenced`. Conservative: an
 *    undeclared custom backend is by definition uncertified, and inferring
 *    lock support from `dialect` alone is the unsound inference this
 *    capability replaces (a PostgreSQL-wire backend reporting `dialect:
 *    "postgres"` need not honor `pg_advisory_xact_lock`).
 */
export function resolveWriteFencePlan(
  target: WriteFenceTarget,
): WriteFencePlan {
  const { writeFence } = target.capabilities;
  if (writeFence !== undefined) {
    return planFromWriteFenceDeclaration(target, writeFence, "writeFence");
  }
  if (FIRST_PARTY_FACTORY_BACKENDS.has(target)) {
    return planFromWriteFenceDeclaration(
      target,
      deriveFromDialect(target.dialect),
      "dialect",
    );
  }
  return { kind: "unfenced" };
}

/**
 * Formats a {@link WriteFenceDeclaration} exactly as a caller would write it
 * under `capabilities.writeFence`.
 */
function formatWriteFenceDeclaration(
  declaration: WriteFenceDeclaration,
): string {
  switch (declaration.mechanism) {
    case "advisory": {
      return `writeFence: { mechanism: "advisory", drain: "${declaration.drain}" }`;
    }
    case "row": {
      return (
        `writeFence: { mechanism: "row", drain: "${declaration.drain}", ` +
        `conflict: "${declaration.conflict}" }`
      );
    }
    case "engine-serialized": {
      return 'writeFence: { mechanism: "engine-serialized" }';
    }
    case "caller-serialized": {
      return 'writeFence: { mechanism: "caller-serialized" }';
    }
    default: {
      return refuseInvalidWriteFenceDeclaration(
        "mechanism",
        (declaration as WriteFenceDeclaration).mechanism,
        VALID_WRITE_FENCE_MECHANISMS,
      );
    }
  }
}

/**
 * THE one owner of the literal declaration line a refusal recommends —
 * printed verbatim by both unfenced refusals below and by
 * `createSqlBackend`'s own construction-time gate, so the migration guide
 * cannot rot into a pointer (ruling OQ-B).
 */
export function writeFenceDeclarationLine(
  dialect: SqlDialect,
  indent = "",
): string {
  const line = formatWriteFenceDeclaration(deriveFromDialect(dialect));
  return `${indent}${line}`;
}

/**
 * The shared body of both unfenced-construction refusals below: `undeclared`
 * is the only way `resolveWriteFencePlan` ever reaches `unfenced` now that
 * `writeFence` is the sole declaration, so this states that fact plainly and
 * prints the fix, keyed to the dialect the backend reports.
 */
function unfencedRefusalMessage(dialect: SqlDialect, resource: string): string {
  return (
    "This backend declares no usable write fence: `capabilities.writeFence` " +
    `is absent, so TypeGraph cannot know whether it fences concurrent ` +
    `writers, and ${resource} cannot run unfenced. Declare it:\n\n` +
    `${writeFenceDeclarationLine(dialect, "  ")}\n`
  );
}

/**
 * THE refusal for Operational Identity constructed against an `unfenced`
 * backend. §5.3.1 (J9b).
 *
 * @throws {ConfigurationError} always.
 */
export function refuseUnfencedOperationalIdentity(dialect: SqlDialect): never {
  throw new ConfigurationError(
    unfencedRefusalMessage(dialect, "Operational Identity"),
    { code: "IDENTITY_REQUIRES_WRITE_FENCE", dialect },
    {
      suggestion:
        "Declare `capabilities.writeFence` on this backend, or construct the store without `identity`.",
    },
  );
}

/**
 * THE refusal for TypeGraph-owned recorded-clock allocation (`history` /
 * `revisionTracking`) constructed against an `unfenced` backend that owns
 * its own recorded-time relations. §5.3.1 (J9a).
 *
 * @throws {ConfigurationError} always.
 */
export function refuseUnfencedClockAllocation(dialect: SqlDialect): never {
  throw new ConfigurationError(
    unfencedRefusalMessage(
      dialect,
      "TypeGraph's recorded-time clock allocation",
    ),
    { code: "RECORDED_CLOCK_REQUIRES_WRITE_FENCE", dialect },
    {
      suggestion:
        "Declare `capabilities.writeFence` on this backend, or construct the store without `history`/`revisionTracking`.",
    },
  );
}

/**
 * THE refusal for a fence that cannot degrade: `unfenced` always refuses,
 * and a `lock` or `row` plan whose `drain` cannot back the table lock an
 * operation requires refuses too — the declared-advisory-only (or
 * declared-row-only) posture (`drain: "none"`), which T15 exercises as its
 * own matrix row.
 *
 * `engine-serialized` and `caller-serialized` satisfy both `requires`
 * values without consulting `drain`: a writer slot and an in-process,
 * out-of-band serialization promise are each a stronger exclusion than
 * either lock shape, so there is nothing for either `requires` to add.
 *
 * @throws {ConfigurationError} under `unfenced`, and under
 * `(kind: "lock" | "row") && drain === "none"` when `requires === "drain"`.
 */
export function requireWriteFence(
  plan: WriteFencePlan,
  operation: string,
  requires: "keyed" | "drain",
): Extract<
  WriteFencePlan,
  { kind: "lock" | "row" | "engine-serialized" | "caller-serialized" }
> {
  switch (plan.kind) {
    case "lock":
    case "row": {
      if (requires === "drain" && plan.drain === "none") {
        throw new ConfigurationError(
          `${operation} requires a table lock, but this backend's write-fence ` +
            'declaration reports drain: "none".',
          {
            code: "WRITE_FENCE_UNAVAILABLE",
            operation,
            requires,
            plan,
          },
          {
            suggestion:
              'Declare `writeFence.drain: "table-lock"` on this backend, or avoid this operation.',
          },
        );
      }
      return plan;
    }
    case "engine-serialized": {
      return plan;
    }
    case "caller-serialized": {
      return plan;
    }
    case "unfenced": {
      throw new ConfigurationError(
        `${operation} requires a write fence, but this backend declares no ` +
          "usable write fence (`capabilities.writeFence` is absent).",
        {
          code: "WRITE_FENCE_UNAVAILABLE",
          operation,
          requires,
        },
        {
          suggestion:
            "Declare `capabilities.writeFence` on this backend, matching the engine's real locking support.",
        },
      );
    }
    default: {
      plan satisfies never;
      throw new ConfigurationError(
        `${operation} could not resolve a write-fence plan.`,
        { code: "WRITE_FENCE_UNAVAILABLE", operation, requires },
      );
    }
  }
}

/**
 * THE one accessor for `fence.sql.lockTables` at a drain site — never
 * re-spelled per site. Call only after checking `fence.drain ===
 * "table-lock"` (TypeScript cannot narrow a resolved `lock`/`row` fence's
 * type on that check alone, since `drain` is not `WriteFencePlan`'s
 * discriminant): `lockTables` is guaranteed present at that point,
 * regardless of which mechanism resolved — `planFromWriteFenceDeclaration`
 * already refused construction of a `table-lock` declaration whose target
 * supplies no `lockTables` ({@link refuseWriteFenceSqlUnavailable}). This
 * `requireDefined` only turns that already-established runtime guarantee
 * into the type narrowing TypeScript cannot infer on its own —
 * `FenceStatements` inherits `lockTables?` from `FenceSql`, since an
 * `advisory`/`row` target with `drain !== "table-lock"` genuinely need not
 * supply one.
 */
export function requireFenceLockTables(
  fence: Extract<WriteFencePlan, { kind: "lock" | "row" }>,
  operation: string,
): NonNullable<FenceSql["lockTables"]> {
  return requireDefined(
    fence.sql.lockTables,
    `${operation}: lockTables was validated present by the resolved drain: "table-lock" plan`,
  );
}
