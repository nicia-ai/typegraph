/**
 * SQL Identifier Validation
 *
 * Validates aliases and identifiers to prevent SQL injection.
 */
import { ValidationError } from "../../errors";

/**
 * Pattern for valid SQL identifiers (aliases).
 * Must start with a letter or underscore, followed by letters, digits, or underscores.
 * Maximum length of 63 characters (PostgreSQL limit).
 */
const SQL_IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

/**
 * Reserved SQL keywords that cannot be used as aliases.
 */
const SQL_RESERVED_KEYWORDS = new Set([
  "select",
  "from",
  "where",
  "and",
  "or",
  "not",
  "in",
  "is",
  "null",
  "true",
  "false",
  "as",
  "on",
  "join",
  "left",
  "right",
  "inner",
  "outer",
  "cross",
  "full",
  "group",
  "by",
  "having",
  "order",
  "asc",
  "desc",
  "limit",
  "offset",
  "union",
  "intersect",
  "except",
  "all",
  "distinct",
  "case",
  "when",
  "then",
  "else",
  "end",
  "exists",
  "between",
  "like",
  "ilike",
  "insert",
  "update",
  "delete",
  "create",
  "drop",
  "alter",
  "table",
  "index",
  "view",
  "with",
  "recursive",
]);

/**
 * Validates that an alias is a safe SQL identifier.
 *
 * @param alias - The alias to validate
 * @throws ValidationError if the alias is not a valid SQL identifier
 */
export function validateSqlIdentifier(alias: string): void {
  if (!SQL_IDENTIFIER_PATTERN.test(alias)) {
    throw new ValidationError(
      `Invalid alias "${alias}": must start with a letter or underscore, ` +
        `contain only letters, digits, and underscores, and be at most 63 characters`,
      {
        issues: [
          {
            path: "alias",
            message: `"${alias}" is not a valid SQL identifier`,
          },
        ],
      },
      {
        suggestion: `Use a simple identifier like "p", "e", "node1", or "my_alias".`,
      },
    );
  }

  if (SQL_RESERVED_KEYWORDS.has(alias.toLowerCase())) {
    throw new ValidationError(
      `Invalid alias "${alias}": "${alias}" is a reserved SQL keyword`,
      {
        issues: [
          { path: "alias", message: `"${alias}" is a reserved SQL keyword` },
        ],
      },
      {
        suggestion: `Choose a different alias. Reserved words like SELECT, FROM, WHERE cannot be used.`,
      },
    );
  }
}
