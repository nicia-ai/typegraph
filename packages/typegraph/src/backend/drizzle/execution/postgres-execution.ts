import { type SQL } from "drizzle-orm";
import { type PgDatabase, type PgQueryResultHKT } from "drizzle-orm/pg-core";

import {
  type CompiledSqlQuery,
  compileQueryWithDialect,
  type PreparedSqlStatement,
  type SqlExecutionAdapter,
} from "./types";

/**
 * Edge-safe: this module is loaded on Cloudflare Workers / Vercel Edge
 * via `@neondatabase/serverless`, so it must not statically import any
 * `node:*` module. Use only platform-neutral primitives.
 */

type PgQueryResult = Readonly<{
  rows: readonly unknown[];
}>;

/**
 * The wire-protocol-shaped client the fast path calls. Both the wrapped
 * node-postgres and postgres-js clients normalize to this signature; what
 * differs is whether the underlying driver gets a server-side prepared
 * statement (node-postgres path) or relies on its own internal preparation
 * (postgres-js).
 */
type PgQueryClient = Readonly<{
  query: (sqlText: string, params: readonly unknown[]) => Promise<PgQueryResult>;
}>;

/**
 * Minimal shape of the node-postgres / @neondatabase/serverless client
 * we rely on. Both accept either positional `query(text, values)`
 * (unnamed) or the configuration-object form `query({name, text, values})`
 * which uses a server-side prepared statement keyed by `name`.
 */
type NodePgQueryConfig = Readonly<{
  name: string;
  text: string;
  values: readonly unknown[];
}>;

type NodePgClient = Readonly<{
  query: ((
    sqlText: string,
    params?: readonly unknown[],
  ) => Promise<PgQueryResult>) &
    ((config: NodePgQueryConfig) => Promise<PgQueryResult>);
}>;

/**
 * Minimal shape of the postgres-js tagged-template `Sql` client we rely on
 * for the raw fast path. `unsafe(sqlText, params)` is postgres-js's
 * parameterized-raw-SQL entry point and resolves to a row array.
 */
type PostgresJsClient = ((...args: readonly unknown[]) => unknown) &
  Readonly<{
    unsafe: (
      sqlText: string,
      params?: readonly unknown[],
    ) => PromiseLike<readonly unknown[]>;
  }>;

type PgClientCarrier = Readonly<{
  $client?: unknown;
}>;

export type AnyPgDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export type PostgresExecutionAdapter = SqlExecutionAdapter;

function hasFunctionProperty<K extends string>(
  value: unknown,
  property: K,
): value is Readonly<Record<K, (...args: readonly unknown[]) => unknown>> {
  if (value === undefined || value === null) {
    return false;
  }
  const candidate = value as Readonly<Record<K, unknown>>;
  return typeof candidate[property] === "function";
}

function isPgNativeClient(candidate: unknown): candidate is NodePgClient {
  // pg `Pool` / `Client` and @neondatabase/serverless `Pool` / `Client`
  // are object instances with a `.query` method. We require non-callable
  // here so we don't accidentally swallow the postgres-js or neon-http
  // tagged-template clients (both callable, both also expose `.query`).
  return typeof candidate === "object" && hasFunctionProperty(candidate, "query");
}

function isPostgresJsClient(candidate: unknown): candidate is PostgresJsClient {
  // postgres-js's tagged-template Sql is callable, has `.unsafe` (raw
  // parameterized executor), and has `.begin` (transaction starter).
  // Neon HTTP is also callable + has `.unsafe`, but that `.unsafe` is a
  // fragment builder rather than a query executor, so we discriminate
  // on `.begin` (postgres-js only).
  return (
    typeof candidate === "function" &&
    hasFunctionProperty(candidate, "unsafe") &&
    hasFunctionProperty(candidate, "begin")
  );
}

/**
 * @neondatabase/serverless's `neon(url)` HTTP-only tagged-template
 * function. Distinguishing markers vs postgres-js: `.transaction`
 * (an HTTP-batch transaction submitter) instead of `.begin`. Its
 * `.query`/`.unsafe` methods have different signatures from pg's, so
 * the fast path can't drive them safely — Drizzle's neon-http session
 * handles them correctly via the `db.execute` slow path.
 *
 * Exported so the backend factory can auto-disable the `transactions`
 * capability when this driver is detected (HTTP can't hold a session,
 * so multi-statement transactions are not available regardless).
 */
export function isNeonHttpClient(db: AnyPgDatabase): boolean {
  const candidate = (db as PgClientCarrier).$client;
  return (
    typeof candidate === "function" &&
    hasFunctionProperty(candidate, "transaction") &&
    !hasFunctionProperty(candidate, "begin")
  );
}

/**
 * Module-scope cache mapping each unique SQL text to a stable
 * prepared-statement name. PostgreSQL only requires statement names to
 * be unique per session, so a monotonic counter is sufficient — and
 * avoids depending on a hash primitive (`node:crypto` doesn't exist on
 * Cloudflare Workers, Web Crypto's digest is async). Cache size is
 * bounded by the number of distinct compiled SQL strings the
 * application emits, typically dozens.
 */
const STATEMENT_NAME_CACHE = new Map<string, string>();

function statementNameFor(sqlText: string): string {
  const cached = STATEMENT_NAME_CACHE.get(sqlText);
  if (cached !== undefined) return cached;
  const name = `tg_${STATEMENT_NAME_CACHE.size}`;
  STATEMENT_NAME_CACHE.set(sqlText, name);
  return name;
}

/**
 * Walks a row and replaces any `Date` instance with its ISO-string
 * equivalent. Used to normalize node-postgres / neon-serverless output
 * when we bypass Drizzle's session: pg's default type parsers return
 * `Date` objects for `timestamptz` / `timestamp` / `date` columns, but
 * TypeGraph's row contract everywhere downstream is "timestamps come
 * back as ISO strings." Drizzle's session installs a per-query type
 * override that does the same thing; this is the dependency-free,
 * edge-safe equivalent.
 *
 * O(columns × rows) — negligible for the row counts TypeGraph queries
 * return (typical: 1–100 rows × 5–30 columns).
 */
function normalizeRow(row: unknown): unknown {
  if (row === null || typeof row !== "object") return row;
  let mutated: Record<string, unknown> | undefined;
  for (const key of Object.keys(row)) {
    const value = (row as Record<string, unknown>)[key];
    if (value instanceof Date) {
      mutated ??= { ...(row as Record<string, unknown>) };
      mutated[key] = value.toISOString();
    }
  }
  return mutated ?? row;
}

function normalizeRows(
  rows: readonly unknown[],
): readonly unknown[] {
  // Single-pass scan; only allocate a new array if any row contained a
  // Date that needed normalizing. Most rows on most queries don't.
  let mutated: unknown[] | undefined;
  for (let index = 0; index < rows.length; index += 1) {
    const original = rows[index];
    const normalized = normalizeRow(original);
    if (normalized !== original) {
      mutated ??= [...rows] as unknown[];
      mutated[index] = normalized;
    }
  }
  return mutated ?? rows;
}

/**
 * Wraps a node-postgres / neon-serverless client so every call goes
 * through a server-side prepared statement keyed by a stable name. The
 * first call on each connection parses + plans + executes; subsequent
 * calls with the same statement name reuse the cached plan and skip
 * both parse and plan phases. Measurable on multi-CTE TypeGraph
 * queries: 3-hop drops from ~7-12ms (parse + plan + execute every call)
 * to ~0.8ms median (execute only).
 *
 * Returned rows are normalized so that `Date` objects from default pg
 * type parsers become ISO strings, matching the row shape Drizzle's
 * session would produce. Without this, `ctx.<alias>.meta.createdAt`
 * style accessors in the SELECT-result path return Date instances,
 * breaking user code that expects strings.
 */
function wrapNodePgClient(client: NodePgClient): PgQueryClient {
  return {
    async query(
      sqlText: string,
      params: readonly unknown[],
    ): Promise<PgQueryResult> {
      const result = await client.query({
        name: statementNameFor(sqlText),
        text: sqlText,
        values: params,
      });
      return { rows: normalizeRows(result.rows) };
    },
  };
}

function adaptPostgresJsClient(sql: PostgresJsClient): PgQueryClient {
  return {
    async query(
      sqlText: string,
      params: readonly unknown[],
    ): Promise<PgQueryResult> {
      // postgres-js handles its own statement preparation internally
      // (controlled by the `prepare` connection option, default true),
      // so we don't need to name statements here ourselves.
      const rows = await sql.unsafe(sqlText, params);
      return { rows };
    },
  };
}

/**
 * Resolves a Drizzle-wrapped PostgreSQL client to a uniform `{query}` shape
 * that the fast path can call. Supports:
 *
 * - `drizzle-orm/node-postgres` (pg Pool / Client) — wrapped to use
 *   server-side prepared statements with stable counter-derived names
 *   keyed by the SQL text (see `statementNameFor`)
 * - `drizzle-orm/neon-serverless` (@neondatabase/serverless Pool) —
 *   pg-Pool-compatible, takes the same wrapper as node-postgres
 * - `drizzle-orm/postgres-js` (postgres-js tagged-template Sql) — adapted
 *   via `.unsafe(sql, params)`. Safe because Drizzle installs transparent
 *   parsers on the same client instance at `drizzle()` time, so direct
 *   calls and Drizzle-routed calls produce identical row shapes.
 *
 * Returns `undefined` for `drizzle-orm/neon-http` and any other driver we
 * don't recognize; callers fall back to `db.execute(sql)`, which goes
 * through the Drizzle session and is always correct (just without the
 * server-side prepared-statement perf win).
 */
function resolvePgClient(db: AnyPgDatabase): PgQueryClient | undefined {
  // Order matters: neon-http and postgres-js are both callable + have
  // `.unsafe`, but neon-http's `.unsafe` is a fragment builder (not a
  // query executor) and its `.query` doesn't accept the {name, text,
  // values} config form. Skip the fast path entirely for neon-http and
  // let Drizzle's session route the call.
  if (isNeonHttpClient(db)) {
    return undefined;
  }
  const client = (db as PgClientCarrier).$client;
  if (isPgNativeClient(client)) {
    return wrapNodePgClient(client);
  }
  if (isPostgresJsClient(client)) {
    return adaptPostgresJsClient(client);
  }
  return undefined;
}

/**
 * Normalizes the result shape of `db.execute(sql)` across drivers.
 *
 * - `drizzle-orm/node-postgres` / `drizzle-orm/neon-serverless` return a
 *   pg-style `{ rows, rowCount, ... }` object.
 * - `drizzle-orm/postgres-js` returns the raw postgres-js result, which is
 *   a plain array of rows (with extra non-enumerable properties like
 *   `count` / `command`).
 *
 * The backend contract is "a row array." Normalize here so every caller
 * downstream can assume the same shape.
 */
async function executeDrizzleQuery<TRow>(
  db: AnyPgDatabase,
  query: SQL,
): Promise<readonly TRow[]> {
  const result = await db.execute(query);
  if (Array.isArray(result)) {
    return result as readonly TRow[];
  }
  return (result as Readonly<{ rows: readonly TRow[] }>).rows;
}

function createPgPreparedStatement(
  pgClient: PgQueryClient,
  sqlText: string,
): PreparedSqlStatement {
  return {
    async execute<TRow>(params: readonly unknown[]): Promise<readonly TRow[]> {
      const result = await pgClient.query(sqlText, params);
      return result.rows as readonly TRow[];
    },
  };
}

export function createPostgresExecutionAdapter(
  db: AnyPgDatabase,
): PostgresExecutionAdapter {
  const pgClient = resolvePgClient(db);

  function compile(query: SQL): CompiledSqlQuery {
    return compileQueryWithDialect(db, query, "PostgreSQL");
  }

  if (pgClient === undefined) {
    return {
      compile,
      async execute<TRow>(query: SQL): Promise<readonly TRow[]> {
        return executeDrizzleQuery<TRow>(db, query);
      },
    };
  }

  const pgQueryClient = pgClient;

  async function executeCompiled<TRow>(
    compiledQuery: CompiledSqlQuery,
  ): Promise<readonly TRow[]> {
    const result = await pgQueryClient.query(
      compiledQuery.sql,
      compiledQuery.params,
    );
    return result.rows as readonly TRow[];
  }

  return {
    compile,
    async execute<TRow>(query: SQL): Promise<readonly TRow[]> {
      // Fast path: compile via Drizzle's dialect, then execute through
      // the wrapped client directly. Bypasses Drizzle's session
      // overhead (logging spans, plan-cache bookkeeping for typed
      // queries we don't use), and on node-postgres this also enables
      // the server-side prepared-statement path because the wrapped
      // client assigns each unique SQL a stable statement name.
      const compiled = compile(query);
      return executeCompiled<TRow>(compiled);
    },
    executeCompiled,
    prepare(sqlText: string): PreparedSqlStatement {
      return createPgPreparedStatement(pgQueryClient, sqlText);
    },
  };
}
