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

const MISSING_TABLE_PATTERNS = [
  "no such table", // SQLite
  "does not exist", // PostgreSQL ("relation ... does not exist")
  "SQLITE_ERROR", // D1 / Durable Objects error code
] as const;

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
 */
function* errorChain(error: unknown): Generator<unknown, void, void> {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    yield current;
    current = current instanceof Error ? current.cause : undefined;
  }
}

/**
 * Whether a single chain link is a PostgreSQL `undefined_table` failure,
 * identified by its SQLSTATE rather than a message substring.
 */
function isPostgresUndefinedTable(link: unknown): boolean {
  return (
    typeof link === "object" &&
    link !== null &&
    "code" in link &&
    (link as Readonly<{ code?: unknown }>).code ===
      POSTGRES_UNDEFINED_TABLE_CODE
  );
}

export function isMissingTableError(error: unknown): boolean {
  for (const link of errorChain(error)) {
    if (isPostgresUndefinedTable(link)) return true;
    const message = link instanceof Error ? link.message : String(link);
    if (MISSING_TABLE_PATTERNS.some((pattern) => message.includes(pattern))) {
      return true;
    }
  }
  return false;
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
    const message = link instanceof Error ? link.message : String(link);
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
