/**
 * Path utilities for variable-length traversal results.
 *
 * SQLite doesn't support native arrays, so paths are stored as pipe-delimited
 * strings: "|id1|id2|id3|". PostgreSQL returns native arrays.
 */

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
  if (!path || path === "||") return [];

  // Remove leading and trailing pipes, then split
  const trimmed = path.slice(1, -1);
  if (trimmed === "") return [];

  return trimmed.split("|");
}

/**
 * Type guard to check if a value is a SQLite path string.
 * SQLite paths start and end with "|".
 */
export function isSqlitePath(value: unknown): value is string {
  return (
    typeof value === "string" && value.startsWith("|") && value.endsWith("|")
  );
}

/**
 * Normalizes a path value to an array.
 * - If already an array (PostgreSQL), returns as-is
 * - If a SQLite path string, parses it
 * - Otherwise returns empty array
 */
export function normalizePath(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value as string[];
  }
  if (isSqlitePath(value)) {
    return parseSqlitePath(value);
  }
  return [];
}
