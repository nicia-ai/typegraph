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

    throw new Error(
      `toSqlString: unexpected chunk type: ${typeof chunk} (${JSON.stringify(chunk)})`,
    );
  }

  return parts.join("");
}

/**
 * Extracts a SQL string and parameter values from a Drizzle SQL template.
 * Supports both SQLite (?) and PostgreSQL ($1, $2, ...) placeholder styles.
 */
export function toSqlWithParams(
  sqlTemplate: SqlTemplateLike,
  dialect: "sqlite" | "postgres" = "sqlite",
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  let parameterIndex = 1;

  function flatten(object: unknown): string {
    if (
      typeof object === "object" &&
      object !== null &&
      "value" in object &&
      Array.isArray((object as { value: unknown }).value)
    ) {
      return (object as { value: string[] }).value.join("");
    }

    if (
      typeof object === "object" &&
      object !== null &&
      "queryChunks" in object &&
      Array.isArray((object as { queryChunks: unknown[] }).queryChunks)
    ) {
      return (object as { queryChunks: unknown[] }).queryChunks
        .map((c) => flatten(c))
        .join("");
    }

    params.push(object);
    return dialect === "postgres" ? `$${parameterIndex++}` : "?";
  }

  const sqlString = flatten(sqlTemplate);
  return { sql: sqlString, params };
}
