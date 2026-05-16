/**
 * Cross-dialect detection of "this relation does not exist yet" errors.
 *
 * Shared so the schema bootstrap (`loadActiveSchemaWithBootstrap`) and
 * the durable contribution-materialization gate (#135) agree on what a
 * missing-table failure looks like, and — critically — so neither one
 * swallows a genuine system fault (connection/permission/driver error)
 * as a benign "not bootstrapped yet".
 */

const MISSING_TABLE_PATTERNS = [
  "no such table", // SQLite
  "does not exist", // PostgreSQL ("relation ... does not exist")
  "SQLITE_ERROR", // D1 / Durable Objects error code
] as const;

export function isMissingTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return MISSING_TABLE_PATTERNS.some((pattern) => message.includes(pattern));
}
