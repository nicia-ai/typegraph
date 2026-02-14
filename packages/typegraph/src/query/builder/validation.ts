/**
 * SQL Identifier Validation
 *
 * Validates aliases and identifiers to prevent SQL injection.
 */
import { ValidationError } from "../../errors";
import { type PredicateExpression } from "../ast";

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

  if (alias.toLowerCase().startsWith("cte_")) {
    throw new ValidationError(
      `Invalid alias "${alias}": aliases starting with "cte_" are reserved for internal use`,
      {
        issues: [
          {
            path: "alias",
            message: `"${alias}" conflicts with internal CTE naming`,
          },
        ],
      },
      {
        suggestion: `Choose an alias that does not start with "cte_".`,
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

function throwInvalidVectorPredicatePlacement(path: string): never {
  throw new ValidationError(
    "Vector similarity predicates cannot be nested under OR or NOT. " +
      "Use top-level AND combinations instead.",
    {
      issues: [
        {
          path,
          message:
            "Vector similarity predicates are only supported at top-level " +
            "or inside AND groups.",
        },
      ],
    },
    {
      suggestion:
        "Rewrite the predicate to keep vector similarity at top-level " +
        "or combine with additional filters using AND.",
    },
  );
}

function validateVectorPredicateExpression(
  expression: PredicateExpression,
  inDisallowedBranch: boolean,
  path: string,
): void {
  switch (expression.__type) {
    case "vector_similarity": {
      if (inDisallowedBranch) {
        throwInvalidVectorPredicatePlacement(path);
      }
      return;
    }
    case "and": {
      for (const [
        predicateIndex,
        predicate,
      ] of expression.predicates.entries()) {
        validateVectorPredicateExpression(
          predicate,
          inDisallowedBranch,
          `${path}.predicates[${predicateIndex}]`,
        );
      }
      return;
    }
    case "or": {
      for (const [
        predicateIndex,
        predicate,
      ] of expression.predicates.entries()) {
        validateVectorPredicateExpression(
          predicate,
          true,
          `${path}.predicates[${predicateIndex}]`,
        );
      }
      return;
    }
    case "not": {
      validateVectorPredicateExpression(
        expression.predicate,
        true,
        `${path}.predicate`,
      );
      return;
    }
    case "comparison":
    case "string_op":
    case "null_check":
    case "between":
    case "array_op":
    case "object_op":
    case "aggregate_comparison":
    case "exists":
    case "in_subquery": {
      return;
    }
  }
}

export function validateVectorPredicatePlacement(
  predicates: readonly { expression: PredicateExpression }[],
): void {
  for (const [predicateIndex, predicate] of predicates.entries()) {
    validateVectorPredicateExpression(
      predicate.expression,
      false,
      `predicates[${predicateIndex}].expression`,
    );
  }
}
