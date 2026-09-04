/**
 * The bundled PostgreSQL lock-statement spelling every write-fence lock site
 * consumes through its resolved plan (`fence.sql.*`) instead of spelling
 * `pg_advisory_xact_lock`, `hashtext(`, `LOCK TABLE`, or
 * `current_setting('transaction_isolation')` itself. The lock-fence inventory
 * test ratchets those tokens out of the lock-site files, including trusted
 * import's table lock, which now resolves the same plan every other lock
 * site does and consumes `fence.sql.lockTables(...)` instead of spelling
 * `LOCK TABLE` itself; only the PostgreSQL profile's extension-DDL lock
 * still spells its own and is outside that ratchet.
 *
 * Built from `SqlFragment` (`../../query/sql-fragment`), not `drizzle-orm`,
 * so this module stays outside the Drizzle zone and is safe to import from
 * portable code that only ever needs PostgreSQL's own SQL shape directly
 * (a raw-connection test fixture, or a session-fact read gated purely on
 * `dialect === "postgres"` rather than on a resolved lock plan).
 *
 * `advisoryLockExpression` / `isolationFactExpression` are exported bare
 * sub-expressions, not members of the `FenceSql` bag: `./postgres-schema-
 * write-fence.ts` needs `drizzle-orm` to reach the schema table, so it
 * cannot live in this module (which imports none), but its fused statement
 * still spells its lock and its isolation read by calling back into these
 * two functions rather than holding a second copy of the tokens.
 *
 * `advisoryLockSingleExpression` is the same kind of bare export for the
 * ONE-argument `pg_advisory_xact_lock(bigint)` form, which occupies a lock
 * space distinct from every namespaced two-argument lock this module builds.
 * The schema-commit fence and the graph-template instantiation statement
 * both take it on `hashtext(graphId)`, so they mutually exclude — calling
 * back into this one function is what keeps that guarantee from drifting
 * into two independently spelled lock calls.
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
 * exported so `buildLockSchemaVersionAndGraphWrite` (a Drizzle-zone module,
 * since it also reaches the schema table) can embed the SAME spelling inside
 * its fused CTE rather than re-deriving it, converting this fragment to
 * Drizzle's own `SQL` at the embedding boundary. `advisoryLock` below wraps
 * this in the standalone-statement form every other lock site consumes.
 */
export function advisoryLockExpression(
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
 * can embed it directly instead of wrapping it in this module's own
 * standalone `SELECT`.
 */
export function advisoryLockSingleExpression(key: string): SqlFragment {
  return sql`pg_advisory_xact_lock(hashtext(${key}))`;
}

function advisoryLock(namespace: string, key: string | number): SqlFragment {
  return sql`SELECT ${advisoryLockExpression(namespace, key)}`;
}

function advisoryLockWithIsolation(
  namespace: string,
  key: string | number,
): SqlFragment {
  return sql`
    SELECT
      ${advisoryLockExpression(namespace, key)},
      ${isolationFactExpression()} AS transaction_isolation
  `;
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
 * `SELECT`/alias around it — exported for the same reason as
 * {@link advisoryLockExpression}: `buildLockSchemaVersionAndGraphWrite`
 * embeds this exact spelling rather than re-deriving it.
 */
export function isolationFactExpression(): SqlFragment {
  return sql`current_setting('transaction_isolation')`;
}

function isolationFact(): SqlFragment {
  return sql`SELECT ${isolationFactExpression()} AS transaction_isolation`;
}

/** The bundled PostgreSQL backend's {@link FenceSql} declaration. */
export const postgresFenceSql: FenceSql = {
  advisoryLock,
  advisoryLockWithIsolation,
  lockTables,
  isolationFact,
};
