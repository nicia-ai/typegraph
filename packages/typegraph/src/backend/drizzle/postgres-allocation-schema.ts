/**
 * The schema a managed PostgreSQL working-copy allocation lives in.
 *
 * An allocation's relations are created and dropped by different sessions:
 * the manager's `control` provisions and removes them, while the Store on the
 * connected backend creates more of them lazily. Neither may pick the schema
 * from its own `search_path`, so the manager fixes it once, records it in the
 * ledger, and carries it to the connected backend's DDL through the names it
 * hands to `connect`:
 *
 *   names  --createPostgresTables-->  tables  --createPostgresBackend-->  backend
 *
 * Each hop is a lookup by object identity, and the manager refuses a
 * connection whose backend does not carry the schema, so a connection that
 * drops the binding is refused rather than silently unpinned.
 */
import { sql, type SqlFragment } from "../../query/sql-fragment";
import { backendDerivationChain } from "../derive-backend";
import type { GraphBackend } from "../types";

const NAMES_SCHEMA = new WeakMap<object, string>();
const TABLES_SCHEMA = new WeakMap<object, string>();
const BACKEND_SCHEMA = new WeakMap<object, string>();

/** @internal Fix the schema of the allocation that owns these table names. */
export function bindNamesToAllocationSchema(
  names: object,
  schema: string,
): void {
  NAMES_SCHEMA.set(names, schema);
}

/** @internal Carry a bound name map's schema onto the tables built from it. */
export function carryAllocationSchemaToTables(
  names: object,
  tables: object,
): void {
  const schema = NAMES_SCHEMA.get(names);
  if (schema !== undefined) TABLES_SCHEMA.set(tables, schema);
}

/** @internal The schema an allocation's tables are bound to, if any. */
export function allocationSchemaOfTables(tables: object): string | undefined {
  return TABLES_SCHEMA.get(tables);
}

/** @internal Record that a backend runs its DDL in an allocation's schema. */
export function markAllocationSchemaBackend(
  backend: GraphBackend,
  schema: string,
): void {
  BACKEND_SCHEMA.set(backend, schema);
}

/** @internal The allocation schema a backend, or the backend it derives from, is bound to. */
export function allocationSchemaOfBackend(
  backend: GraphBackend,
): string | undefined {
  for (const link of backendDerivationChain(backend)) {
    const schema = BACKEND_SCHEMA.get(link);
    if (schema !== undefined) return schema;
  }
  return undefined;
}

/**
 * Leads the transaction's `search_path` with the allocation schema, so an
 * unqualified `CREATE` in the same transaction lands there and an existing
 * relation is found where it lives. The rest of the path is kept so types and
 * extensions in other schemas still resolve. `is_local` scopes it to the
 * transaction; it must run inside one.
 */
export function allocationSchemaPin(schema: string): SqlFragment {
  return sql`SELECT set_config('search_path', quote_ident(${schema}) || ', ' || current_setting('search_path'), true)`;
}

/**
 * The one owner of "the schema this backend's relations live in", for a
 * catalog read that compares a schema name: the allocation's when the backend
 * is bound to one, else the session's current schema. Bound, a pooled
 * connection's `search_path` cannot make a catalog read look in the wrong
 * place.
 */
export function backendRelationSchema(
  allocationSchema: string | undefined,
): SqlFragment {
  return allocationSchema === undefined ?
      sql`current_schema()`
    : sql`${allocationSchema}`;
}

/**
 * The same decision for a `pg_class` row aliased `c`, read where a bare name
 * resolves through the session's `search_path`. Bound, the row must live in the
 * allocation's schema, whatever the path leads with; unbound, it is whatever
 * the session can see.
 */
export function relationInBackendSchema(
  allocationSchema: string | undefined,
): SqlFragment {
  return allocationSchema === undefined ?
      sql`pg_catalog.pg_table_is_visible(c.oid)`
    : sql`c.relnamespace = (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = ${allocationSchema})`;
}
