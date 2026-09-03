/**
 * The `pessimisticLocks` capability: whether this engine can serialize
 * concurrent writers, and how.
 *
 * `resolveWriteFencePlan` is THE one owner of the pessimistic-lock decision
 * every lock site used to re-derive from `dialect` inline. A lock site never
 * spells the dialect itself; it resolves a plan and consumes it.
 */
import { ConfigurationError } from "../../errors";
import { type SqlDialect } from "../../query/dialect/types";
import { type SqlFragment } from "../../query/sql-fragment";
import { type BackendCapabilities } from "../types";

/**
 * The lock-statement spelling a backend supplies alongside its
 * `pessimisticLocks` declaration: a small bag of {@link SqlFragment} builders,
 * one per shape a lock site needs. A backend that declares `advisoryLocks:
 * true` must supply this; one that only serializes writers
 * needs none.
 *
 * `advisoryLock`'s `key` accepts a `number` for the database-scoped locks
 * that key on a constant second argument (`0`) rather than a hashed value —
 * the two-argument `pg_advisory_xact_lock` overload takes that second
 * argument as a plain integer, never as `hashtext(...)` of one.
 */
export type FenceSql = Readonly<{
  /** A keyed lock scoped to the transaction, e.g. `pg_advisory_xact_lock`. */
  advisoryLock: (namespace: string, key: string | number) => SqlFragment;
  /**
   * The same lock plus the session's isolation-level fact, in ONE statement
   * — the "session facts come from the session that enforces them" contract:
   * the fact is read on the exact connection the lock was just taken on.
   */
  advisoryLockWithIsolation: (
    namespace: string,
    key: string | number,
  ) => SqlFragment;
  /** A relation lock, e.g. `LOCK TABLE ... IN ... MODE`. */
  lockTables: (
    tables: readonly string[],
    mode: "share" | "share-row-exclusive" | "access-exclusive",
  ) => SqlFragment;
  /** The bare session isolation-level read, with no lock. */
  isolationFact: () => SqlFragment;
}>;

/**
 * The two independent facts a backend can report about concurrent-writer
 * serialization.
 */
export type PessimisticLockCapabilities = Readonly<{
  /** `pg_advisory_xact_lock`-style keyed locks scoped to the transaction. */
  advisoryLocks: boolean;
  /** `LOCK TABLE … IN … MODE`-style relation locks. */
  tableLocks: boolean;
  /**
   * The engine serializes concurrent writers by construction (SQLite's single
   * writer slot). This is what makes "take no lock" CORRECT on SQLite and
   * WRONG on an engine with neither locks nor a slot.
   */
  serializedWriters: boolean;
}>;

/**
 * The decision every lock site consumes, rather than a flag a caller would
 * have to re-derive.
 */
export type WriteFencePlan =
  /**
   * Take the keyed/table lock, spelled by `sql` — the target's OWN declared
   * spelling: a lock site never hand-writes the statement, it resolves
   * a plan and consumes `sql.<builder>(…)`.
   */
  | Readonly<{
      kind: "lock";
      advisoryLocks: true;
      tableLocks: boolean;
      sql: FenceSql;
    }>
  /** No lock needed: the engine serializes writers. */
  | Readonly<{ kind: "engine-serialized" }>
  /** Neither. Every non-degradable fence refuses. */
  | Readonly<{ kind: "unfenced" }>;

/**
 * What `resolveWriteFencePlan` needs: the dialect (for the first-party
 * dialect-derivation arm and for the refusal message), the declared
 * capabilities, and — when `pessimisticLocks.advisoryLocks` is (or derives)
 * `true` — the lock-statement spelling that decision requires.
 * Structural on purpose — see the module-private first-party mark below,
 * which is carried out-of-band rather than as a type member.
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

function deriveFromDialect(dialect: SqlDialect): PessimisticLockCapabilities {
  switch (dialect) {
    case "postgres": {
      return {
        advisoryLocks: true,
        tableLocks: true,
        serializedWriters: false,
      };
    }
    case "sqlite": {
      return {
        advisoryLocks: false,
        tableLocks: false,
        serializedWriters: true,
      };
    }
    default: {
      return dialect satisfies never;
    }
  }
}

/**
 * THE refusal for a `lock` decision whose target supplies no spelling to
 * take it with — never defaulted, never silently degraded to
 * `unfenced`: the declaration already promised a real lock exists, so the
 * only honest response to a missing spelling is to say so.
 *
 * Both call sites are in this module: `planFromLockCapabilities`, shared by
 * `resolveWriteFencePlan`'s declared and first-party-dialect-derived arms.
 *
 * @throws {ConfigurationError} always.
 */
function refuseWriteFenceSqlUnavailable(dialect: SqlDialect): never {
  throw new ConfigurationError(
    "This backend declares `capabilities.pessimisticLocks.advisoryLocks: " +
      "true` but supplies no `fenceSql`, so TypeGraph cannot spell the lock " +
      "statement this fence needs to take.",
    { code: "WRITE_FENCE_SQL_UNAVAILABLE", dialect },
    {
      suggestion:
        dialect === "postgres" ?
          "Supply `fenceSql: postgresFenceSql` (exported from `@nicia-ai/typegraph/adapters/drizzle/postgres`) — the bundled PostgreSQL backend does this automatically — or provide a custom FenceSql matching this engine's lock syntax."
        : "Provide a custom `fenceSql: FenceSql` matching this engine's lock syntax, or declare `pessimisticLocks.advisoryLocks: false`.",
    },
  );
}

/**
 * THE refusal for a session-fact read (no lock plan involved) whose target
 * supplies no `fenceSql` to spell it with. Distinct from
 * {@link refuseWriteFenceSqlUnavailable}: that refusal fires only under a
 * resolved `lock` plan, so its message correctly says the backend "declares
 * `capabilities.pessimisticLocks.advisoryLocks: true`" — a claim that is
 * simply false for a target with no lock plan in play at all (e.g. one
 * declaring `serializedWriters: true` and no advisory locks). A session-fact
 * read is gated on `dialect` alone, not on a resolved plan, so it needs its
 * own refusal naming what it actually needs.
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

function planFromLockCapabilities(
  target: WriteFenceTarget,
  declared: PessimisticLockCapabilities,
): WriteFencePlan {
  if (declared.advisoryLocks) {
    if (target.fenceSql === undefined) {
      refuseWriteFenceSqlUnavailable(target.dialect);
    }
    return {
      kind: "lock",
      advisoryLocks: true,
      tableLocks: declared.tableLocks,
      sql: target.fenceSql,
    };
  }
  // A declared table-locks-only engine (no advisoryLocks, no
  // serializedWriters) resolves `unfenced`: every TypeGraph fence needs
  // either the advisory key or the writer slot, and no lock site here takes
  // a table lock without first having taken the advisory one.
  if (declared.serializedWriters) return { kind: "engine-serialized" };
  return { kind: "unfenced" };
}

/**
 * THE one reader of `capabilities.pessimisticLocks`, and THE one constructor
 * of a {@link WriteFencePlan}.
 *
 * Resolution order:
 *
 * 1. **Declared** — use the declaration. Every first-party backend declares
 *    `pessimisticLocks` (`SQLITE_CAPABILITIES` / `POSTGRES_CAPABILITIES`),
 *    and a custom backend takes this path by writing one line.
 * 2. **Absent, first-party factory** — derive from `dialect`
 *    (`postgres` → `{advisoryLocks:true,tableLocks:true,serializedWriters:false}`,
 *    `sqlite` → `{advisoryLocks:false,tableLocks:false,serializedWriters:true}`),
 *    which is exactly what every lock site used to compute inline. After
 *    A1/A2 land, nothing in-tree reaches this arm — both bundled factories
 *    declare `pessimisticLocks` unconditionally — so it is reachable only
 *    from tests that build a backend object bypassing the factories'
 *    declared capabilities while still carrying the first-party mark.
 * 3. **Absent, anything else** — `unfenced`. Conservative: an undeclared
 *    custom backend is by definition uncertified, and inferring lock support
 *    from `dialect` alone is the unsound inference this capability replaces
 *    (a Doltgres-shaped backend reporting `dialect: "postgres"` need not
 *    honor `pg_advisory_xact_lock`).
 */
export function resolveWriteFencePlan(
  target: WriteFenceTarget,
): WriteFencePlan {
  const declared = target.capabilities.pessimisticLocks;
  if (declared !== undefined) return planFromLockCapabilities(target, declared);
  if (FIRST_PARTY_FACTORY_BACKENDS.has(target)) {
    return planFromLockCapabilities(target, deriveFromDialect(target.dialect));
  }
  return { kind: "unfenced" };
}

/**
 * THE one owner of the literal `pessimisticLocks` declaration line a refusal
 * recommends — printed verbatim by both unfenced refusals below, so the
 * migration guide cannot rot into a pointer (ruling OQ-B).
 */
export function pessimisticLockDeclarationLine(dialect: SqlDialect): string {
  switch (dialect) {
    case "postgres": {
      return "pessimisticLocks: { advisoryLocks: true, tableLocks: true, serializedWriters: false }";
    }
    case "sqlite": {
      return "pessimisticLocks: { advisoryLocks: false, tableLocks: false, serializedWriters: true }";
    }
    default: {
      return dialect satisfies never;
    }
  }
}

/**
 * The shared body of both unfenced-construction refusals below: names both
 * ways `unfenced` is reached (absent, or a present-but-all-false
 * declaration) rather than claiming absence it cannot know, then prints the
 * one line that fixes it, keyed to the dialect the backend reports.
 */
function unfencedRefusalMessage(dialect: SqlDialect, resource: string): string {
  const declaredLine = pessimisticLockDeclarationLine(dialect);
  const otherDialect: SqlDialect =
    dialect === "postgres" ? "sqlite" : "postgres";
  const otherLine = pessimisticLockDeclarationLine(otherDialect);
  const dialectDescription =
    dialect === "postgres" ?
      "an engine that honors `pg_advisory_xact_lock` and `LOCK TABLE`"
    : "an engine with a single writer slot";
  const otherDescription =
    otherDialect === "postgres" ?
      "an engine that honors `pg_advisory_xact_lock` and `LOCK TABLE`"
    : "an engine with a single writer slot";
  return (
    "This backend declares no usable write fence: `capabilities.pessimisticLocks` " +
    "is absent, or declares neither advisory/table locks nor serialized writers, " +
    `so TypeGraph cannot know whether it fences concurrent writers, and ${resource} ` +
    "cannot run unfenced. Add ONE line to the capabilities you pass:\n\n" +
    `  ${declaredLine}\n\n` +
    `(that is the correct declaration for ${dialectDescription}; use\n` +
    `\`${otherLine}\` for ${otherDescription}). If the engine honors ` +
    `neither, this refusal is correct and ${resource} is unavailable on it.`
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
        "Declare `capabilities.pessimisticLocks` on this backend, or construct the store without `identity`.",
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
        "Declare `capabilities.pessimisticLocks` on this backend, or construct the store without `history`/`revisionTracking`.",
    },
  );
}

/**
 * THE refusal for a fence that cannot degrade: `unfenced` always refuses,
 * and a `lock` plan that lacks the table lock an operation requires refuses
 * too — the declared-advisory-only posture, which T15 exercises as its own
 * matrix row.
 *
 * `engine-serialized` satisfies both requirements: the writer slot is the
 * fence, whichever shape of lock the caller would otherwise have taken.
 *
 * @throws {ConfigurationError} under `unfenced`, and under
 * `kind: "lock" && tableLocks === false` when `requires === "table-lock"`.
 */
export function requireWriteFence(
  plan: WriteFencePlan,
  operation: string,
  requires: "advisory-lock" | "table-lock",
): Extract<WriteFencePlan, { kind: "lock" | "engine-serialized" }> {
  switch (plan.kind) {
    case "lock": {
      if (requires === "table-lock" && !plan.tableLocks) {
        throw new ConfigurationError(
          `${operation} requires a table lock, but this backend's ` +
            "pessimisticLocks declaration reports tableLocks: false.",
          {
            code: "WRITE_FENCE_UNAVAILABLE",
            operation,
            requires,
            plan,
          },
          {
            suggestion:
              "Declare `pessimisticLocks.tableLocks: true` on this backend, or avoid this operation.",
          },
        );
      }
      return plan;
    }
    case "engine-serialized": {
      return plan;
    }
    case "unfenced": {
      throw new ConfigurationError(
        `${operation} requires a write fence, but this backend declares no ` +
          "usable write fence (`capabilities.pessimisticLocks` is absent, or " +
          "declares neither advisory/table locks nor serialized writers).",
        { code: "WRITE_FENCE_UNAVAILABLE", operation, requires },
        {
          suggestion:
            "Declare `capabilities.pessimisticLocks` on this backend, matching the engine's real locking support.",
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
