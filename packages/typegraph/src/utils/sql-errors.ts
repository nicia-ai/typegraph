/**
 * Cross-dialect detection of "this relation does not exist yet" errors.
 *
 * Shared so the schema bootstrap (`loadActiveSchemaWithBootstrap`) and
 * the durable contribution-materialization gate (#135) agree on what a
 * missing-table failure looks like, and — critically — so neither one
 * swallows a genuine system fault (connection/permission/driver error)
 * as a benign "not bootstrapped yet".
 *
 * Detection walks the error's `cause` chain because Drizzle (>= the
 * `DrizzleQueryError` era, drizzle-orm ≥ 0.36) wraps every failure from a
 * query-builder call (`db.select()`, `db.insert()`, …): the wrapper's
 * `.message` becomes the failed query text and the real driver error —
 * which carries both the missing-relation text and the SQLSTATE — is
 * preserved on `.cause`. node-postgres / postgres-js nest the pg error
 * one link deep; better-sqlite3 throws it unwrapped; raw `client.query()`
 * fast paths surface it directly. Walking the chain makes the check
 * wrapper- and driver-agnostic instead of only matching the outermost
 * `.message`, which on Postgres is just the SQL string.
 */

import { ConfigurationError } from "../errors";

const SQLITE_MISSING_TABLE_PATTERN = "no such table";
const SQLITE_GENERIC_ERROR_CODE = "SQLITE_ERROR";
const DRIZZLE_QUERY_ERROR_PREFIX = "Failed query:";
const POSTGRES_UNDEFINED_RELATION_PATTERN =
  /\b(?:relation|table)\s+"[^"]+"\s+does not exist\b/i;

/**
 * SQLSTATE for PostgreSQL `undefined_table`. Preferred over the
 * human-readable message: it is locale-independent (the "... does not
 * exist" text is translated under a non-English `lc_messages`) and is
 * preserved on the underlying driver error even when Drizzle overwrites
 * `.message` with the query text.
 */
const POSTGRES_UNDEFINED_TABLE_CODE = "42P01";

/**
 * Yields an error and each error reachable by following `.cause`,
 * outermost first. `seen` guards the pathological cyclic-cause case so a
 * self-referential chain can't spin forever.
 *
 * The walk intentionally follows `.cause` through *non-`Error`* links, not just
 * `Error` instances: postgres-js surfaces its driver error as a plain object
 * (message + SQLSTATE `code`) on a Drizzle wrapper's `.cause`, so stopping at
 * the first non-`Error` link would miss it (see the postgres-js test). A plain
 * object is classified by its locale-independent SQLSTATE alone
 * ({@link isPostgresUndefinedTable}); the looser SQLite message substring is
 * consulted only for `Error` instances and raw strings
 * ({@link missingTableMessage}), so an unrelated object in a cause chain that
 * merely mentions one of those phrases is not mistaken for a missing table.
 */
function* errorChain(error: unknown): Generator<unknown, void, void> {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    yield current;
    current =
      canReadProperty(current) ? Reflect.get(current, "cause") : undefined;
  }
}

function canReadProperty(value: unknown): value is object {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  );
}

/**
 * Whether a single chain link is a PostgreSQL `undefined_table` failure,
 * identified by its SQLSTATE rather than a message substring.
 */
function isPostgresUndefinedTable(link: unknown): boolean {
  return (
    canReadProperty(link) &&
    Reflect.get(link, "code") === POSTGRES_UNDEFINED_TABLE_CODE
  );
}

function messageProperty(link: unknown): string | undefined {
  if (typeof link === "string") return link;
  if (link instanceof Error) return link.message;
  const message =
    canReadProperty(link) ?
      (Reflect.get(link, "message") as unknown)
    : undefined;
  return typeof message === "string" ? message : undefined;
}

function errorMessage(link: unknown): string {
  return messageProperty(link) ?? String(link);
}

/**
 * The message a SQLite missing-table substring match may be tested against — but
 * only for `Error` instances and raw `string` links, never an arbitrary plain
 * object.
 *
 * Generic "does not exist" is deliberately not substring-matched: PostgreSQL uses
 * that phrase for undefined columns, functions, types, and relations. PostgreSQL
 * missing tables are classified by SQLSTATE 42P01 when available, or by the
 * narrower driver-message shape `relation/table "..." does not exist` when a
 * bring-your-own driver omits SQLSTATE. SQLite does not expose a portable
 * SQLSTATE here, so the narrow "no such table" engine message is still accepted.
 */
function missingTableMessage(link: unknown): string | undefined {
  return typeof link === "string" || link instanceof Error ?
      messageProperty(link)
    : undefined;
}

function sqliteErrorCode(link: unknown): unknown {
  if (!canReadProperty(link)) return undefined;
  return Reflect.get(link, "code");
}

/**
 * Cloudflare D1 / Durable Objects may surface a missing-table failure as the
 * generic SQLite code with no detail. Accept the bare marker, but do not
 * substring-match detailed `SQLITE_ERROR: ...` failures: those include syntax
 * errors and bind-limit faults that must stay loud.
 */
function isBareSqliteErrorMarker(link: unknown): boolean {
  const message = messageProperty(link);
  if (message === SQLITE_GENERIC_ERROR_CODE) return true;
  if (sqliteErrorCode(link) !== SQLITE_GENERIC_ERROR_CODE) return false;
  return (
    message === undefined ||
    message === SQLITE_GENERIC_ERROR_CODE ||
    message.includes(SQLITE_MISSING_TABLE_PATTERN)
  );
}

function isPostgresUndefinedRelationMessage(link: unknown): boolean {
  const message = errorMessage(link);
  if (message.startsWith(DRIZZLE_QUERY_ERROR_PREFIX)) return false;
  return POSTGRES_UNDEFINED_RELATION_PATTERN.test(message);
}

export function isMissingTableError(error: unknown): boolean {
  // SQLSTATE 42P01 is locale-independent and structural, so it is honored on
  // *every* link — including a plain driver-error object reached only by walking
  // through a non-`Error` `.cause` (postgres-js).
  //
  // The SQLite message substring is honored only while every prior link in the
  // chain was an `Error` (or the top-level string) — the reach of the
  // pre-broadening walk, which stopped at the first non-`Error` `.cause`.
  let everyPriorLinkWasError = true;
  for (const link of errorChain(error)) {
    if (isPostgresUndefinedTable(link)) return true;
    if (isPostgresUndefinedRelationMessage(link)) return true;
    if (isBareSqliteErrorMarker(link)) return true;
    if (everyPriorLinkWasError) {
      const message = missingTableMessage(link);
      if (message?.includes(SQLITE_MISSING_TABLE_PATTERN) === true) {
        return true;
      }
    }
    if (!(link instanceof Error)) everyPriorLinkWasError = false;
  }
  return false;
}

function historyMissingRecordedRelationsError(
  details: Record<string, unknown>,
  cause: unknown,
): ConfigurationError {
  return new ConfigurationError(
    "history: true requires the recorded-time relations to exist, but a recorded relation is missing.",
    details,
    {
      cause,
      suggestion:
        "Create the recorded-time relations (typegraph_recorded_nodes, typegraph_recorded_edges, typegraph_recorded_clock) — e.g. re-run the generated migration SQL — on this database before enabling history capture.",
    },
  );
}

/**
 * Converts missing recorded-relation failures into the actionable precondition
 * error used by construction-time history checks. Capture paths use this after
 * the live write has already succeeded inside the same transaction; recorded
 * read paths use it when query/schema swapping reaches a recorded table that
 * has not been materialized yet.
 */
export async function withRecordedRelationsPrecondition<T>(
  promise: Promise<T>,
  details: Record<string, unknown>,
): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
    throw historyMissingRecordedRelationsError(
      { ...details, code: "RECORDED_RELATIONS_MISSING" },
      error,
    );
  }
}

/**
 * Engine "vector dimension mismatch" message shapes. pgvector:
 * `expected 384 dimensions, not 512`; libSQL / sqlite-vec surface a similar
 * `expected N … got/not M`. The first capture is the dimension the *stored*
 * column expects; the optional second is the dimension that was *attempted*.
 */
const DIMENSION_MISMATCH_PATTERN =
  /expected (\d+) dimensions(?:[,\s]+(?:not|got|but got|but)\s*(\d+))?/i;

/**
 * Parses an engine vector-dimension-mismatch error into `{ expected, actual }`
 * by walking the `.cause` chain (drivers wrap the real error). `expected` is
 * the stored column's dimension; `actual` (when the message includes it) is the
 * attempted vector's dimension. Returns `undefined` for unrelated errors.
 */
export function parseDimensionMismatch(
  error: unknown,
): { expected: number; actual: number | undefined } | undefined {
  for (const link of errorChain(error)) {
    const message = errorMessage(link);
    const match = DIMENSION_MISMATCH_PATTERN.exec(message);
    if (match) {
      return {
        expected: Number(match[1]),
        actual: match[2] === undefined ? undefined : Number(match[2]),
      };
    }
  }
  return undefined;
}
