/**
 * The write-fence capability: how this engine excludes concurrent writers,
 * declared as `capabilities.writeFence`.
 *
 * `resolveWriteFencePlan` is THE one owner of the write-fence decision every
 * lock site used to re-derive from `dialect` inline. A lock site never
 * spells the dialect itself; it resolves a plan and consumes it.
 */
import { ConfigurationError } from "../../errors";
import { type SqlDialect } from "../../query/dialect/types";
import { sql, type SqlFragment } from "../../query/sql-fragment";
import { requireDefined } from "../../utils/presence";
import { type BackendCapabilities } from "../types";

/**
 * The lock-statement spelling a backend supplies alongside its
 * `writeFence` declaration: the two composable, no-`SELECT` expressions a
 * fused statement (a CTE, a data-modifying statement) embeds directly, plus
 * the one relation-lock builder. A backend that declares `writeFence.mechanism:
 * "advisory"` must supply this; one that only serializes writers needs none.
 *
 * This is deliberately the ONLY spelling a backend author writes.
 * {@link resolveFenceStatements} derives the standalone-statement forms
 * (`advisoryLock`, `advisoryLockWithIsolation`, `isolationFact`) from
 * `advisoryLockExpression` / `isolationFactExpression` — a backend never
 * spells both a statement and the expression it wraps separately, so the
 * fused embedding and the standalone statement can never disagree about
 * what they lock or read.
 *
 * `advisoryLockExpression`'s `key` accepts a `number` for the
 * database-scoped locks that key on a constant second argument (`0`) rather
 * than a hashed value — the two-argument `pg_advisory_xact_lock(int4, int4)`
 * overload takes that second argument as a plain integer, never as
 * `hashtext(...)` of one.
 */
export type FenceSql = Readonly<{
  /** A relation lock, e.g. `LOCK TABLE ... IN ... MODE`. */
  lockTables: (
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
   * {@link resolveFenceStatements}'s derived `advisoryLock`, which wraps
   * this in a standalone `SELECT`.
   */
  advisoryLockExpression: (
    namespace: string,
    key: string | number,
  ) => SqlFragment;
  /**
   * The bare session isolation-level read, with no `SELECT`/alias around
   * it — embedded the same way `advisoryLockExpression` is, and wrapped by
   * {@link resolveFenceStatements}'s derived `isolationFact` /
   * `advisoryLockWithIsolation` for every other site.
   */
  isolationFactExpression: () => SqlFragment;
}>;

/**
 * `FenceSql`'s two author-supplied expressions plus the three
 * standalone-statement forms {@link resolveFenceStatements} derives from
 * them — what a `lock` plan's `sql` field actually carries, and what every
 * ordinary lock site consumes.
 */
export type FenceStatements = FenceSql &
  Readonly<{
    /** A keyed lock scoped to the transaction, e.g. `pg_advisory_xact_lock`. */
    advisoryLock: (namespace: string, key: string | number) => SqlFragment;
    /**
     * The same lock plus the session's isolation-level fact, in ONE
     * statement — the "session facts come from the session that enforces
     * them" contract: the fact is read on the exact connection the lock
     * was just taken on.
     */
    advisoryLockWithIsolation: (
      namespace: string,
      key: string | number,
    ) => SqlFragment;
    /** The bare session isolation-level read, with no lock. */
    isolationFact: () => SqlFragment;
  }>;

function advisoryLockStatement(
  fenceSql: FenceSql,
  namespace: string,
  key: string | number,
): SqlFragment {
  return sql`SELECT ${fenceSql.advisoryLockExpression(namespace, key)}`;
}

function advisoryLockWithIsolationStatement(
  fenceSql: FenceSql,
  namespace: string,
  key: string | number,
): SqlFragment {
  return sql`
    SELECT
      ${fenceSql.advisoryLockExpression(namespace, key)},
      ${fenceSql.isolationFactExpression()} AS transaction_isolation
  `;
}

function isolationFactStatement(fenceSql: FenceSql): SqlFragment {
  return sql`SELECT ${fenceSql.isolationFactExpression()} AS transaction_isolation`;
}

/**
 * THE one owner of "wrap a fence expression in its standalone statement
 * form": derives `advisoryLock`, `advisoryLockWithIsolation`, and
 * `isolationFact` from `fenceSql`'s `advisoryLockExpression` /
 * `isolationFactExpression` — the only way to reach those three forms, so a
 * fused embedding and a portable lock site can never spell the lock or the
 * isolation read differently. Called once, by
 * `planFromWriteFenceDeclaration`, when a `lock` plan resolves.
 */
export function resolveFenceStatements(fenceSql: FenceSql): FenceStatements {
  return {
    ...fenceSql,
    advisoryLock: (namespace: string, key: string | number) =>
      advisoryLockStatement(fenceSql, namespace, key),
    advisoryLockWithIsolation: (namespace: string, key: string | number) =>
      advisoryLockWithIsolationStatement(fenceSql, namespace, key),
    isolationFact: () => isolationFactStatement(fenceSql),
  };
}

/**
 * How a backend excludes concurrent writers, and how far a caller that took
 * the lock can drain the resource it protects.
 *
 * `mechanism` is the exclusion primitive: `"advisory"` is a keyed
 * `pg_advisory_xact_lock`-style lock a caller takes explicitly (and needs
 * `fenceSql` to spell); `"engine-serialized"` is the engine's own single
 * writer slot (SQLite); `"caller-serialized"` is a promise the DEPLOYMENT
 * makes rather than the engine or a lock — the backend's own process
 * serializes every write unit it issues (see the in-process queue this
 * mechanism requires) AND no other client writes to the same database while
 * this backend is open. `"row"` (a per-row lock) joins this union in a later
 * release.
 *
 * `drain` is a separate fact, and applies ONLY to `mechanism: "advisory"`:
 * whether a caller that already took the keyed lock can additionally take a
 * relation-wide lock on the resource a table-lock site protects.
 * `"table-lock"` means yes (a `LOCK TABLE`-style statement is available and
 * appropriate); `"quiescent"` means the resource is already exclusive for
 * another reason (e.g. a `caller-serialized` in-process queue layered
 * alongside an advisory lock) so a table-lock site takes NO statement rather
 * than one it does not need; `"none"` means neither — a table-lock site
 * refuses, naming this drain. `"engine-serialized"` and `"caller-serialized"`
 * carry no `drain`: an engine's single writer slot and an in-process
 * serialization promise are each already a stronger exclusion than any
 * `drain` value could add, so there is nothing for the field to say —
 * declaring one alongside either mechanism is refused
 * (`WRITE_FENCE_DECLARATION_INVALID`, `validateWriteFenceDeclaration` below).
 */
export type WriteFenceDeclaration =
  | Readonly<{
      mechanism: "advisory";
      drain: "table-lock" | "quiescent" | "none";
    }>
  | Readonly<{ mechanism: "engine-serialized" }>
  | Readonly<{ mechanism: "caller-serialized" }>;

/**
 * The one member of {@link WriteFenceDeclaration} that carries `drain` —
 * named so a function that only ever runs inside the `mechanism: "advisory"`
 * arm of a resolved declaration (the fence-SQL refusal below) can say so in
 * its own parameter type instead of accepting the full union and re-widening
 * `drain` into "possibly absent".
 */
type AdvisoryWriteFenceDeclaration = Extract<
  WriteFenceDeclaration,
  { mechanism: "advisory" }
>;

/**
 * The decision every lock site consumes, rather than a flag a caller would
 * have to re-derive.
 */
export type WriteFencePlan =
  /**
   * Take the keyed lock, spelled by `sql` — the target's OWN declared
   * spelling: a lock site never hand-writes the statement, it resolves
   * a plan and consumes `sql.<builder>(…)`.
   */
  | Readonly<{
      kind: "lock";
      drain: "table-lock" | "quiescent" | "none";
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
 * capabilities, and — when the resolved declaration's `mechanism` is (or
 * derives) `"advisory"` — the lock-statement spelling that decision
 * requires. Structural on purpose — see the module-private first-party mark
 * below, which is carried out-of-band rather than as a type member.
 */
export type WriteFenceTarget = Readonly<{
  dialect: SqlDialect;
  capabilities: BackendCapabilities;
  fenceSql?: FenceSql | undefined;
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
 * promising a lock this target cannot spell — the phrase each of its two
 * provenances (a direct `writeFence`, or the first-party dialect derivation)
 * fills in differently, so the refusal never states a declaration the
 * target did not actually make.
 */
function describeResolvedAdvisoryDeclaration(
  declaration: AdvisoryWriteFenceDeclaration,
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
 * `FenceSql`'s type keeps all three members required as a set (a caller
 * constructing one under TypeScript can never omit one), so this only ever
 * catches a `fenceSql` built outside that check — a plain JS backend author,
 * or a test target assembled with a cast — supplying an object that is
 * missing (or has stubbed `undefined` over) the one member a resolved
 * mechanism/drain combination actually needs.
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
 * THE refusal for a `lock` decision whose target supplies no spelling — or
 * an incomplete one — to take it with: never defaulted, never silently
 * degraded to `unfenced`. The declaration already promised a real lock
 * exists, so the only honest response to a missing spelling is to say so,
 * naming the exact `fenceSql` member the resolved mechanism/drain
 * combination needed and could not find.
 *
 * The one call site is `planFromWriteFenceDeclaration`, shared by every
 * `resolveWriteFencePlan` arm that can resolve `mechanism: "advisory"` — a
 * declared `writeFence` and the first-party dialect derivation both resolve
 * through it, and each passes its own {@link WriteFenceDeclarationSource} so
 * the message names the declaration the target actually made.
 *
 * @throws {ConfigurationError} always.
 */
function refuseWriteFenceSqlUnavailable(
  dialect: SqlDialect,
  declaration: AdvisoryWriteFenceDeclaration,
  source: WriteFenceDeclarationSource,
  member: keyof FenceSql,
): never {
  throw new ConfigurationError(
    `This backend ${describeResolvedAdvisoryDeclaration(declaration, source, dialect)} ` +
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
  "engine-serialized",
  "caller-serialized",
] as const;

/** {@link validateWriteFenceDeclaration}'s accepted `drain` values. */
const VALID_WRITE_FENCE_DRAINS = ["table-lock", "quiescent", "none"] as const;

/**
 * THE refusal for a `WriteFenceDeclaration` field TypeScript's discriminated
 * union cannot police at runtime — see {@link validateWriteFenceDeclaration}.
 *
 * @throws {ConfigurationError} always.
 */
function refuseInvalidWriteFenceDeclaration(
  field: "mechanism" | "drain",
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
 */
function validateWriteFenceDeclaration(
  declaration: WriteFenceDeclaration,
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
  if (mechanism === "advisory") {
    const drain: string = (declaration as AdvisoryWriteFenceDeclaration).drain;
    if (!(VALID_WRITE_FENCE_DRAINS as readonly string[]).includes(drain)) {
      refuseInvalidWriteFenceDeclaration(
        "drain",
        drain,
        VALID_WRITE_FENCE_DRAINS,
      );
    }
    return;
  }
  if ("drain" in declaration) {
    throw new ConfigurationError(
      "capabilities.writeFence.drain applies only to " +
        `mechanism: "advisory"; "${mechanism}" must not declare a drain.`,
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
  validateWriteFenceDeclaration(declaration);
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
 * and a `lock` plan whose `drain` cannot back the table lock an operation
 * requires refuses too — the declared-advisory-only posture (`drain:
 * "none"`), which T15 exercises as its own matrix row.
 *
 * `engine-serialized` and `caller-serialized` satisfy both `requires`
 * values without consulting `drain`: a writer slot and an in-process,
 * out-of-band serialization promise are each a stronger exclusion than
 * either lock shape, so there is nothing for either `requires` to add.
 *
 * @throws {ConfigurationError} under `unfenced`, and under
 * `kind: "lock" && drain === "none"` when `requires === "drain"`.
 */
export function requireWriteFence(
  plan: WriteFencePlan,
  operation: string,
  requires: "keyed" | "drain",
): Extract<
  WriteFencePlan,
  { kind: "lock" | "engine-serialized" | "caller-serialized" }
> {
  switch (plan.kind) {
    case "lock": {
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
