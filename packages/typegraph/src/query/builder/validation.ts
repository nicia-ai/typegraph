/**
 * SQL Identifier Validation
 *
 * Validates aliases and identifiers to prevent SQL injection.
 */
import { ValidationError } from "../../errors";
import { type HybridFusionOptions, type PredicateExpression } from "../ast";

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

/**
 * Walks a predicate expression and rejects placement under OR/NOT for
 * structural predicates (vector / fulltext) — those rewrite the query
 * shape and are incompatible with disjunction or negation. Both
 * predicate kinds use this same machinery; the `match` callback selects
 * which one is being validated.
 */
function validateStructuralPredicatePlacement(
  expression: PredicateExpression,
  matchType: "vector_similarity" | "fulltext_match",
  buildError: (path: string) => never,
  inDisallowedBranch: boolean,
  path: string,
): void {
  if (expression.__type === matchType) {
    if (inDisallowedBranch) buildError(path);
    return;
  }
  switch (expression.__type) {
    case "and": {
      for (const [index, child] of expression.predicates.entries()) {
        validateStructuralPredicatePlacement(
          child,
          matchType,
          buildError,
          inDisallowedBranch,
          `${path}.predicates[${index}]`,
        );
      }
      return;
    }
    case "or": {
      for (const [index, child] of expression.predicates.entries()) {
        validateStructuralPredicatePlacement(
          child,
          matchType,
          buildError,
          true,
          `${path}.predicates[${index}]`,
        );
      }
      return;
    }
    case "not": {
      validateStructuralPredicatePlacement(
        expression.predicate,
        matchType,
        buildError,
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
    case "in_subquery":
    case "vector_similarity":
    case "fulltext_match": {
      return;
    }
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

function throwInvalidFulltextPredicatePlacement(path: string): never {
  throw new ValidationError(
    "Fulltext match predicates (.matches()) cannot be nested under OR or NOT. " +
      "Use top-level AND combinations instead.",
    {
      issues: [
        {
          path,
          message:
            "Fulltext match predicates are only supported at top-level " +
            "or inside AND groups.",
        },
      ],
    },
    {
      suggestion:
        "Restructure your query so the fulltext match appears at the top level " +
        "of a whereNode() or inside an .and() combination.",
    },
  );
}

export function validateVectorPredicatePlacement(
  predicates: readonly { expression: PredicateExpression }[],
): void {
  for (const [index, predicate] of predicates.entries()) {
    validateStructuralPredicatePlacement(
      predicate.expression,
      "vector_similarity",
      throwInvalidVectorPredicatePlacement,
      false,
      `predicates[${index}].expression`,
    );
  }
}

export function validateFulltextPredicatePlacement(
  predicates: readonly { expression: PredicateExpression }[],
): void {
  for (const [index, predicate] of predicates.entries()) {
    validateStructuralPredicatePlacement(
      predicate.expression,
      "fulltext_match",
      throwInvalidFulltextPredicatePlacement,
      false,
      `predicates[${index}].expression`,
    );
  }
}

/**
 * Validates fusion options shared by `QueryBuilder.fuseWith()` and
 * `store.search.hybrid({ fusion })`. Rejects unsupported methods, and
 * non-finite / non-positive k, and negative / non-finite weights.
 */
export function validateHybridFusionOptions(
  options: HybridFusionOptions,
): void {
  // Cast through string to survive callers that bypass the TS type
  // (e.g. user-supplied JSON on the store.search.hybrid path).
  const method = options.method as string | undefined;
  if (method !== undefined && method !== "rrf") {
    throw new ValidationError(`Unsupported fusion method: ${method}`, {
      issues: [{ path: "fusion.method", message: `Only "rrf" is supported.` }],
    });
  }
  const { k } = options;
  if (k !== undefined && (!Number.isFinite(k) || k <= 0)) {
    throw new ValidationError(
      `Fusion k must be a positive finite number, got: ${String(k)}`,
      {
        issues: [{ path: "fusion.k", message: "Must be a positive number." }],
      },
    );
  }
  const weights = options.weights;
  if (weights !== undefined) {
    for (const key of ["vector", "fulltext"] as const) {
      const weight = weights[key];
      if (weight !== undefined && (!Number.isFinite(weight) || weight < 0)) {
        throw new ValidationError(
          `Fusion weight for "${key}" must be a non-negative finite number, got: ${String(weight)}`,
          {
            issues: [
              {
                path: `fusion.weights.${key}`,
                message: "Must be a non-negative number.",
              },
            ],
          },
        );
      }
    }
  }
}
