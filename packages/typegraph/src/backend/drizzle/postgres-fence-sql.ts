/**
 * The bundled PostgreSQL lock-statement spelling every write-fence lock site
 * consumes through its resolved plan (`fence.sql.*`) instead of spelling
 * `pg_advisory_xact_lock`, `hashtext(`, `LOCK TABLE`, or
 * `current_setting('transaction_isolation')` itself. The lock-fence inventory
 * test ratchets those tokens out of the lock-site files, including trusted
 * import's table lock and the PostgreSQL profile's extension-DDL lock, both
 * of which now resolve the same plan every other lock site does and consume
 * `fence.sql.lockTables(...)` / `fence.sql.advisoryLock(...)` instead of
 * spelling `LOCK TABLE` / `pg_advisory_xact_lock` themselves — this module is
 * the only one left spelling any of these four tokens.
 *
 * Built from `SqlFragment` (`../../query/sql-fragment`), not `drizzle-orm`,
 * so this module stays outside the Drizzle zone and is safe to import from
 * portable code that only ever needs PostgreSQL's own SQL shape directly
 * (a raw-connection test fixture, or a session-fact read gated purely on
 * `dialect === "postgres"` rather than on a resolved lock plan).
 *
 * `postgresFenceSql` supplies only the two composable expressions and
 * `lockTables` — `FenceSql`'s complete member set. The standalone-statement
 * forms every ordinary lock site actually calls (`advisoryLock`,
 * `advisoryLockWithIsolation`, `isolationFact`) are never spelled here: THE
 * one owner of "wrap this expression in a standalone `SELECT`" is
 * `resolveWriteFencePlan`'s `resolveFenceStatements`
 * (`../capabilities/write-fence.ts`), which derives them from this module's
 * two expressions for every resolved `lock` plan, bundled or custom alike.
 * `./postgres-schema-write-fence.ts` needs `drizzle-orm` to reach the schema
 * table, so it cannot live in this module (which imports none); it instead
 * takes the resolved fence target's own `advisoryLockExpression` /
 * `isolationFactExpression` members as a parameter and calls them directly,
 * converting each to Drizzle's own `SQL` at the embedding boundary — so a
 * derived profile's own `FenceSql` backs that fused statement exactly as it
 * backs every other lock site, never the bundled spelling unconditionally.
 *
 * `advisoryLockSingleExpression` is exported bare, unlike the module's other
 * two expressions: it spells the ONE-argument `pg_advisory_xact_lock(bigint)`
 * form, which occupies a lock space distinct from every namespaced
 * two-argument lock this module builds and is not a `FenceSql` member — the
 * schema-commit fence (`postgres.ts`) and the graph-template instantiation
 * statement (`graph-template-sql.ts`) both import it directly and take it on
 * `hashtext(graphId)`, so they mutually exclude — calling back into this one
 * function is what keeps that guarantee from drifting into two independently
 * spelled lock calls.
 */
import { sql, type SqlFragment } from "../../query/sql-fragment";
import { type FenceSql } from "../capabilities/write-fence";

const LOCK_TABLE_MODE_CLAUSE = {
  share: "SHARE MODE",
  "share-row-exclusive": "SHARE ROW EXCLUSIVE MODE",
  "access-exclusive": "ACCESS EXCLUSIVE MODE",
} as const satisfies Record<
  "share" | "share-row-exclusive" | "access-exclusive",
  string
>;

/**
 * `hashtext($key)` for a string key, or the bare integer literal for the
 * constant `0` the database-scoped DDL locks use — PostgreSQL's two-argument
 * `pg_advisory_xact_lock(int4, int4)` overload takes that second argument as
 * a plain integer, never as a hash of one. Rendered inline rather than bound:
 * every numeric key in this codebase is a hardcoded constant at its call
 * site, never a runtime value, so inlining it is safe and matches the
 * statement text this module's callers rendered before they resolved their
 * spelling through here.
 */
function advisoryLockKeyExpression(key: string | number): SqlFragment {
  return typeof key === "number" ? sql.raw(String(key)) : sql`hashtext(${key})`;
}

/**
 * The bare `pg_advisory_xact_lock(...)` call, with no `SELECT` around it —
 * reachable from outside this module only as `postgresFenceSql`'s
 * `advisoryLockExpression` MEMBER: `postgres-schema-write-fence.ts` composes
 * it off the resolved `FenceSql` it is building a statement for, and
 * `resolveWriteFencePlan`'s `resolveFenceStatements` wraps it in the
 * standalone-statement form (`advisoryLock`) every other lock site consumes
 * — never off this bare function by direct import, so a derived profile's
 * own `FenceSql` backs both forms exactly as the bundled spelling does.
 */
function advisoryLockExpression(
  namespace: string,
  key: string | number,
): SqlFragment {
  return sql`pg_advisory_xact_lock(hashtext(${namespace}), ${advisoryLockKeyExpression(key)})`;
}

/**
 * The bare ONE-argument `pg_advisory_xact_lock(hashtext($key))` call —
 * never route a namespaced lock through this instead of
 * {@link advisoryLockExpression}. PostgreSQL stores the one- and
 * two-argument forms with different `locktag` field4 values, so a bigint
 * key taken here can never collide with any (int4, int4) key the
 * two-argument form produces, however the hashes land. Exported bare, like
 * {@link advisoryLockExpression}, so a caller that must keep this lock
 * co-atomic with a surrounding statement (a data-modifying CTE, for one)
 * can embed it directly instead of wrapping it in a standalone `SELECT`.
 */
export function advisoryLockSingleExpression(key: string): SqlFragment {
  return sql`pg_advisory_xact_lock(hashtext(${key}))`;
}

function lockTables(
  tables: readonly string[],
  mode: "share" | "share-row-exclusive" | "access-exclusive",
): SqlFragment {
  return sql`LOCK TABLE ${sql.join(
    tables.map((table) => sql.identifier(table)),
    sql`, `,
  )} IN ${sql.raw(LOCK_TABLE_MODE_CLAUSE[mode])}`;
}

/**
 * The bare `current_setting('transaction_isolation')` read, with no
 * `SELECT`/alias around it — reachable from outside this module only as
 * `postgresFenceSql`'s `isolationFactExpression` member, for the same
 * reason as {@link advisoryLockExpression}.
 */
function isolationFactExpression(): SqlFragment {
  return sql`current_setting('transaction_isolation')`;
}

/** The bundled PostgreSQL backend's {@link FenceSql} declaration. */
export const postgresFenceSql: FenceSql = {
  lockTables,
  advisoryLockExpression,
  isolationFactExpression,
};
