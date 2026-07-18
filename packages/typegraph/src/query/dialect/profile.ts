import { type SqlDialect } from "./types";

export type SqlDialectProfile = Readonly<{
  bindValue: (value: unknown) => unknown;
  booleanLiteralString: (value: boolean) => string;
  placeholder: (index: number) => string;
}>;

const SQL_DIALECT_PROFILES = {
  postgres: {
    bindValue: (value: unknown) => value,
    booleanLiteralString: (value: boolean) => (value ? "TRUE" : "FALSE"),
    placeholder: (index: number) => `$${index}`,
  },
  sqlite: {
    bindValue: (value: unknown) =>
      typeof value === "boolean" ?
        value ? 1
        : 0
      : value,
    booleanLiteralString: (value: boolean) => (value ? "1" : "0"),
    placeholder: () => "?",
  },
} satisfies Record<SqlDialect, SqlDialectProfile>;

const SQL_STRING_LITERAL_RENDERERS = {
  postgres: (value: string) => {
    if (value.includes("\\")) {
      return `E'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
    }
    return `'${value.replaceAll("'", "''")}'`;
  },
  sqlite: (value: string) => `'${value.replaceAll("'", "''")}'`,
} satisfies Record<SqlDialect, (value: string) => string>;

/** Returns the primitive rendering and binding rules for a SQL dialect. */
export function getSqlDialectProfile(dialect: SqlDialect): SqlDialectProfile {
  return SQL_DIALECT_PROFILES[dialect];
}

/** Maps a JavaScript value to the representation expected by a SQL driver. */
export function bindSqlValue(value: unknown, dialect: SqlDialect): unknown {
  if (value instanceof Date) return value.toISOString();
  return getSqlDialectProfile(dialect).bindValue(value);
}

/** Renders one SQL string literal using the dialect's escaping rules. */
export function inlineSqlStringLiteral(
  value: string,
  dialect: SqlDialect,
): string {
  return SQL_STRING_LITERAL_RENDERERS[dialect](value);
}
