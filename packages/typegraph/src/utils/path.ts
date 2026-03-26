/**
 * Path utilities for variable-length traversal results.
 *
 * SQLite doesn't support native arrays, so paths are stored as pipe-delimited
 * strings: "|id1|id2|id3|". PostgreSQL returns native arrays.
 */
import {
  PG_ARRAY_END,
  PG_ARRAY_START,
  PG_PATH_ELEMENT_SEPARATOR,
  SQLITE_PATH_DELIMITER,
} from "../constants";

/**
 * Parses a SQLite path string into an array of node IDs.
 *
 * @param path - Pipe-delimited path string like "|id1|id2|id3|"
 * @returns Array of node IDs like ["id1", "id2", "id3"]
 *
 * @example
 * parseSqlitePath("|abc|def|ghi|") // ["abc", "def", "ghi"]
 * parseSqlitePath("|single|") // ["single"]
 * parseSqlitePath("||") // []
 */
export function parseSqlitePath(path: string): readonly string[] {
  const emptyPath = `${SQLITE_PATH_DELIMITER}${SQLITE_PATH_DELIMITER}`;
  if (!path || path === emptyPath) return [];

  // Remove leading and trailing pipes, then split
  const trimmed = path.slice(1, -1);
  if (trimmed === "") return [];

  return trimmed.split(SQLITE_PATH_DELIMITER);
}

/**
 * Type guard to check if a value is a SQLite path string.
 * SQLite paths start and end with "|".
 */
export function isSqlitePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(SQLITE_PATH_DELIMITER) &&
    value.endsWith(SQLITE_PATH_DELIMITER)
  );
}

/**
 * Normalizes a path value to an array.
 * - If already an array (PostgreSQL native), returns as-is
 * - If a SQLite path string (|id1|id2|), parses it
 * - If a PostgreSQL text array ({id1,id2}), parses it
 * - Otherwise returns empty array
 */
export function normalizePath(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value as string[];
  }
  if (isSqlitePath(value)) {
    return parseSqlitePath(value);
  }
  if (isPostgresTextArray(value)) {
    return parsePostgresTextArray(value);
  }
  return [];
}

/**
 * Type guard for PostgreSQL text array format: {id1,id2,id3}
 */
function isPostgresTextArray(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(PG_ARRAY_START) &&
    value.endsWith(PG_ARRAY_END)
  );
}

/**
 * Parses a PostgreSQL text array string into an array of strings.
 * Input format: {id1,id2,id3} or {} for empty.
 */
function parsePostgresTextArray(value: string): readonly string[] {
  const inner = value.slice(1, -1);
  if (inner === "") return [];
  return inner.split(PG_PATH_ELEMENT_SEPARATOR);
}
