/**
 * Shared SQL test utilities.
 *
 * Drizzle's SQL objects are composable and store their contents in `queryChunks`.
 * These helpers turn that structure into a readable string for assertions.
 */

type SqlTemplateLike = Readonly<{ queryChunks: readonly unknown[] }>;

/**
 * Extracts a SQL string from a Drizzle SQL template.
 * Inlines parameters/chunks for easier assertion.
 */
export function toSqlString(sqlTemplate: SqlTemplateLike): string {
  const parts: string[] = [];

  for (const chunk of sqlTemplate.queryChunks) {
    if (typeof chunk === "string" || typeof chunk === "number") {
      parts.push(String(chunk));
      continue;
    }

    if (chunk && typeof chunk === "object") {
      if ("value" in chunk) {
        const value = (chunk as { value: unknown }).value;
        if (Array.isArray(value)) {
          parts.push(value.map(String).join(""));
        } else {
          parts.push(String(value));
        }
        continue;
      }

      if ("queryChunks" in chunk) {
        parts.push(toSqlString(chunk as SqlTemplateLike));
        continue;
      }
    }
  }

  return parts.join("");
}
