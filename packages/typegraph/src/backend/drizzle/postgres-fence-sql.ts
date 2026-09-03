/**
 * The bundled PostgreSQL lock-statement spelling every write-fence lock site
 * consumes through its resolved plan (`fence.sql.*`) instead of spelling
 * `pg_advisory_xact_lock`, `hashtext(`, `LOCK TABLE`, or
 * `current_setting('transaction_isolation')` itself. The lock-fence inventory
 * test ratchets those tokens out of the lock-site files; the PostgreSQL
 * profile's extension-DDL lock, the trusted-import table lock, and the
 * graph-template instantiation statement still spell their own and are
 * outside that ratchet.
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
 * cannot live in this Drizzle-free module itself, but its fused statement
 * still spells its lock and its isolation read by calling back into these
 * two functions rather than holding a second copy of the tokens.
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
