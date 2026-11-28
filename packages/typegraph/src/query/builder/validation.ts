/**
 * SQL Identifier Validation
 *
 * Validates aliases and identifiers to prevent SQL injection.
 */
import {
  ConfigurationError,
  UnsupportedPredicateError,
  ValidationError,
} from "../../errors";
import {
  type FulltextMatchPredicate,
  type HybridFusionOptions,
  type PredicateExpression,
  type SortDirection,
  type VectorSimilarityPredicate,
} from "../ast";
import {
  isReservedSqlName,
  refuseReservedOutputKeys,
  reservedAliasRefusal,
} from "../compiler/sql-name-registry";
import type { PaginateOptions, QueryBuilderState } from "./types";

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
 * Validates that an alias is a safe SQL identifier outside the names the
 * library reserves: `cte_` (the prefix of every alias CTE) and `__tg` (see
 * {@link isReservedSqlName}), in any letter case.
 *
 * The reserved namespace is checked first, so an alias in it is refused with
 * the same code (`SQL_IDENTIFIER_COLLISION`) whether or not it is otherwise
 * a valid identifier, as it is where a query AST is compiled.
 *
 * @param alias - The alias to validate
 * @throws ValidationError if the alias is not a valid SQL identifier
 */
export function validateSqlIdentifier(alias: string): void {
  if (isReservedSqlName(alias)) throw reservedAliasRefusal(alias);

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
    case "tuple_comparison":
    case "string_op":
    case "null_check":
    case "between":
    case "array_op":
    case "object_op":
    case "database_expression_predicate":
    case "aggregate_comparison":
    case "exists":
    case "in_subquery":
    case "vector_similarity":
    case "fulltext_match":
    case "relevance_comparison": {
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

/** One owner for non-negative SQL result bounds on every builder. */
export function validateQueryRange(
  value: number,
  option: "limit" | "offset",
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError(`${option} must be a non-negative safe integer`, {
      issues: [
        { path: option, message: `Invalid ${option}: ${String(value)}` },
      ],
    });
  }
}

/**
 * Whether a builder has a source. An unstarted builder carries `""` as its
 * source alias and no source kinds; that placeholder names no alias.
 */
export function hasQuerySource(state: QueryBuilderState): boolean {
  return state.startAlias !== "";
}

/** Validates the alias namespace and references once for every builder stage. */
export function validateQueryState(state: QueryBuilderState): void {
  if (!hasQuerySource(state)) return;
  const aliases = new Set<string>();
  const nodes = new Set<string>();
  const edges = new Set<string>();
  function addAlias(alias: string): void {
    validateSqlIdentifier(alias);
    if (aliases.has(alias))
      throw new ValidationError(`Query alias "${alias}" is already in use`, {
        issues: [
          {
            path: "alias",
            message: "Aliases must be unique across nodes, edges, and paths",
          },
        ],
      });
    aliases.add(alias);
  }
  addAlias(state.startAlias);
  nodes.add(state.startAlias);
  // A state handed to a public constructor skips the project() and
  // aggregate() checks; hidden columns are named beside these keys.
  refuseReservedOutputKeys(state.projection.map((field) => field.outputName));
  for (const traversal of state.traversals) {
    if (!nodes.has(traversal.joinFromAlias))
      throw new ValidationError(
        `Unknown traversal source alias "${traversal.joinFromAlias}"`,
        {
          issues: [
            { path: "from", message: "Expected an existing node alias" },
          ],
        },
      );
    addAlias(traversal.edgeAlias);
    edges.add(traversal.edgeAlias);
    addAlias(traversal.nodeAlias);
    nodes.add(traversal.nodeAlias);
    for (const alias of [
      traversal.variableLength?.depthAlias,
      traversal.variableLength?.pathAlias,
    ]) {
      if (alias !== undefined) addAlias(alias);
    }
  }
  for (const predicate of state.predicates) {
    const expected = predicate.targetType === "edge" ? edges : nodes;
    if (!expected.has(predicate.targetAlias))
      throw new ValidationError(
        `Unknown predicate alias "${predicate.targetAlias}"`,
        {
          issues: [
            {
              path: "alias",
              message:
                "Expected an existing alias of the requested entity type",
            },
          ],
        },
      );
  }
  for (const order of state.orderBy) {
    if (order.field.__type === "database_expression") continue;
    if (!nodes.has(order.field.alias) && !edges.has(order.field.alias))
      throw new ValidationError(`Unknown order alias "${order.field.alias}"`, {
        issues: [
          {
            path: "orderBy",
            message: "Expected an existing node or edge alias",
          },
        ],
      });
  }
}

export function validateQuerySource(
  state: QueryBuilderState,
  starting: boolean,
): void {
  if (starting === hasQuerySource(state)) {
    throw new ValidationError(
      starting ?
        "A query can have only one source; start a new query instead."
      : "Start the query with from() or fromDynamic() first.",
      {
        issues: [
          {
            path: "from",
            message: starting ? "Source already defined" : "Source required",
          },
        ],
      },
    );
  }
}

export function validateTraversalOptions(
  direction: string,
  expansion: string,
): void {
  if (direction !== "in" && direction !== "out")
    throw new ValidationError(`Invalid traversal direction: ${direction}`, {
      issues: [{ path: "direction", message: "Use in or out" }],
    });
  if (!["none", "implying", "inverse", "all"].includes(expansion))
    throw new ValidationError(`Invalid traversal expansion: ${expansion}`, {
      issues: [
        { path: "expand", message: "Use none, implying, inverse, or all" },
      ],
    });
}

/** The surfaces that page a query with a keyset cursor. */
export type CursorPaginationSurface = "paginate" | "page" | "stream";

/**
 * Refuses keyset pagination over a query with a recursive traversal.
 *
 * A keyset cursor must identify the row it follows. A recursive traversal
 * fans one start node out into rows that have no single edge to extend the
 * start node's keys with, so the cursor can only name the start node. The next
 * page then resumes strictly after that node and loses every row of it not yet
 * returned. A `recursive({ maxHops: 1 })` step is refused too: the compiler's
 * lowering of that shape to a fixed hop is an engine detail the cursor does
 * not see. `parts()` / `wholes()` with `maxHops: 1` and neither `depth` nor
 * `path` are different: the builder emits a fixed step, never a recursive one,
 * so this refusal does not apply and the cursor carries that step's edge key
 * like any `traverse()`.
 *
 * Every pagination surface calls this before building or executing anything, so
 * the refusal is the same on every backend and costs no statement.
 */
export function refuseRecursivePagination(
  state: QueryBuilderState,
  surface: CursorPaginationSurface,
): void {
  if (
    !state.traversals.some(
      (traversal) => traversal.variableLength !== undefined,
    )
  )
    return;
  throw new ConfigurationError(
    `${surface}() cannot page a query with a recursive traversal (recursive(), parts() or wholes()): ` +
      "a cursor cannot position itself inside the rows one start node fans out into, " +
      "so the rows past a page boundary would be silently dropped.",
    { code: "RECURSIVE_PAGINATION_UNSUPPORTED", operation: surface },
    {
      suggestion:
        "Read the walk with execute() and an explicit limit() or recursive({ maxHops }), " +
        "or page the start nodes in a query without the recursive traversal and run the recursive walk for each page.",
    },
  );
}

/** Cursor pagination owns its bounds; conflicting or invalid options must not be ignored. */
export function validatePaginationOptions(
  state: QueryBuilderState,
  options: PaginateOptions,
  surface: Exclude<CursorPaginationSurface, "stream">,
): void {
  refuseRecursivePagination(state, surface);
  if (state.limit !== undefined || state.offset !== undefined) {
    throw new ValidationError(
      "Cursor pagination cannot honor query limit/offset; use first/after or last/before instead.",
      { issues: [{ path: "paginate", message: "Conflicting result bounds" }] },
    );
  }
  const forward = options.first !== undefined || options.after !== undefined;
  const backward = options.last !== undefined || options.before !== undefined;
  if (forward && backward)
    throw new ValidationError(
      "Use either first/after or last/before, not both pagination directions.",
      { issues: [{ path: "paginate", message: "Conflicting directions" }] },
    );
  for (const key of ["first", "last"] as const) {
    const value = options[key];
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) ||
        value < 1 ||
        value >= Number.MAX_SAFE_INTEGER)
    ) {
      throw new ValidationError(
        `${key} must be a positive safe integer with room for a lookahead row`,
        { issues: [{ path: key, message: "Invalid page size" }] },
      );
    }
  }
  for (const key of ["after", "before"] as const) {
    if (options[key]?.length === 0)
      throw new ValidationError("Pagination cursors must not be empty", {
        issues: [{ path: key, message: "Empty cursor" }],
      });
  }
}

export function validateSortDirection(
  value: unknown,
): asserts value is SortDirection {
  if (value !== "asc" && value !== "desc")
    throw new ConfigurationError("Invalid order direction.");
}

/**
 * The first `.similarTo()` or `$fulltext.matches()` predicate anywhere in
 * `expression`, at any depth of AND, OR and NOT; `undefined` when it has
 * none. A subquery's own predicates are not searched: its statement applies
 * them.
 */
function findRelevancePredicate(
  expression: PredicateExpression,
): VectorSimilarityPredicate | FulltextMatchPredicate | undefined {
  switch (expression.__type) {
    case "vector_similarity":
    case "fulltext_match": {
      return expression;
    }
    case "and":
    case "or": {
      for (const child of expression.predicates) {
        const found = findRelevancePredicate(child);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    case "not": {
      return findRelevancePredicate(expression.predicate);
    }
    case "comparison":
    case "tuple_comparison":
    case "string_op":
    case "null_check":
    case "between":
    case "array_op":
    case "object_op":
    case "database_expression_predicate":
    case "aggregate_comparison":
    case "exists":
    case "in_subquery":
    case "relevance_comparison": {
      return undefined;
    }
  }
}

/**
 * A builder position that accepts a predicate expression but cannot apply a
 * relevance predicate: a `having()` group filter, or a `whereEdge()` match
 * constraint on an edge alias.
 */
export type RelevancePredicatePlacement = "having" | "edge_predicate";

const RELEVANCE_PLACEMENT_DESCRIPTIONS: Readonly<
  Record<RelevancePredicatePlacement, string>
> = {
  having: "in having()",
  edge_predicate: "in a whereEdge() predicate",
};

/**
 * Refuses a `.similarTo()` or `$fulltext.matches()` predicate in a builder
 * position other than a node alias's `whereNode()` match constraint.
 *
 * Those predicates are not row filters: the standard statement extracts the
 * ones in its node match constraints and applies them through a relevance
 * join (a top-k candidate set and a relevance order). Anywhere else nothing
 * applies them: a group filter compiled the predicate to a constant-true term,
 * so `NOT` of it removed every group, and an edge alias has no relevance
 * join. The builder method refuses it before any SQL exists.
 *
 * @throws UnsupportedPredicateError with `details.reason` naming the
 *   placement and `details.predicate` / `details.alias` naming the predicate.
 */
export function refuseMisplacedRelevancePredicate(
  expression: PredicateExpression,
  placement: RelevancePredicatePlacement,
): void {
  const relevancePredicate = findRelevancePredicate(expression);
  if (relevancePredicate === undefined) return;
  const operation =
    relevancePredicate.__type === "fulltext_match" ?
      "$fulltext.matches()"
    : "similarTo()";
  const alias = relevancePredicate.field.alias;
  throw new UnsupportedPredicateError(
    `${operation} on alias "${alias}" is not supported ${RELEVANCE_PLACEMENT_DESCRIPTIONS[placement]}: ` +
      "a relevance predicate is applied only as a whereNode() match constraint on a node alias.",
    { predicate: relevancePredicate.__type, alias, reason: placement },
    {
      suggestion:
        "Move the predicate into whereNode() on the node alias it searches, at top level or inside an AND.",
    },
  );
}
