/**
 * Set Operation Compilation
 *
 * Compiles UNION, INTERSECT, and EXCEPT operations to SQL.
 *
 * For SQLite, special handling is required because:
 * - CTEs (WITH clauses) cannot be wrapped in parentheses
 * - Compound SELECT statements can only have a single WITH clause at the start
 *
 * This module handles these requirements by:
 * - For simple queries (no traversals): Compiling without CTEs, using direct table queries
 * - For complex queries: Merging all CTEs into a single WITH clause with unique prefixes
 */
import { type SQL, sql } from "drizzle-orm";

import {
  type ComposableQuery,
  type FieldRef,
  type ProjectedField,
  type Projection,
  type QueryAst,
  type SetOperation,
} from "../ast";
import { type DialectAdapter } from "../dialect";
import { type JsonPointer, jsonPointer } from "../json-pointer";
import {
  compilePredicateExpression,
  type PredicateCompilerContext,
} from "./predicates";
import { type SqlSchema } from "./schema";
import { compileTemporalFilter, extractTemporalOptions } from "./temporal";

/**
 * Type for the query compiler function.
 */
export type QueryCompilerFunction = (ast: QueryAst, graphId: string) => SQL;

/**
 * Operator mapping for set operations.
 */
const OPERATOR_MAP: Record<string, string> = {
  union: "UNION",
  unionAll: "UNION ALL",
  intersect: "INTERSECT",
  except: "EXCEPT",
};

// ============================================================
// Main Entry Point
// ============================================================

/**
 * Compiles a set operation to SQL.
 *
 * For SQLite, uses a special compilation strategy that avoids wrapping
 * CTEs in parentheses. For other databases, uses the standard approach.
 *
 * @param op - The set operation AST
 * @param graphId - The graph ID
 * @param dialect - The dialect adapter
 * @param schema - SQL schema configuration for table names
 * @param compileQuery - Function to compile regular queries
 * @returns SQL for the set operation
 */
export function compileSetOperation(
  op: SetOperation,
  graphId: string,
  dialect: DialectAdapter,
  schema: SqlSchema,
  compileQuery: QueryCompilerFunction,
): SQL {
  // SQLite requires special handling for CTEs in compound statements
  if (dialect.name === "sqlite") {
    return compileSetOperationForSqlite(op, graphId, dialect, schema);
  }

  // PostgreSQL and others support CTEs in parentheses
  return compileSetOperationStandard(op, graphId, dialect, compileQuery);
}

// ============================================================
// Standard (PostgreSQL) Compilation
// ============================================================

/**
 * Standard set operation compilation for databases that support CTEs in parentheses.
 */
function compileSetOperationStandard(
  op: SetOperation,
  graphId: string,
  dialect: DialectAdapter,
  compileQuery: QueryCompilerFunction,
): SQL {
  const coreSql = compileSetOperationCoreStandard(
    op,
    graphId,
    dialect,
    compileQuery,
  );

  const parts: SQL[] = [coreSql];

  // Handle ORDER BY, LIMIT, OFFSET
  appendOrderByLimitOffset(parts, op, dialect);

  return sql.join(parts, sql` `);
}

/**
 * Compiles the core set operation with parentheses (standard approach).
 */
function compileSetOperationCoreStandard(
  op: SetOperation,
  graphId: string,
  dialect: DialectAdapter,
  compileQuery: QueryCompilerFunction,
): SQL {
  const left = compileComposableQueryStandard(
    op.left,
    graphId,
    dialect,
    compileQuery,
  );
  const right = compileComposableQueryStandard(
    op.right,
    graphId,
    dialect,
    compileQuery,
  );

  const opSql = sql.raw(OPERATOR_MAP[op.operator]!);

  return sql`(${left}) ${opSql} (${right})`;
}

/**
 * Compiles a composable query for standard databases.
 */
function compileComposableQueryStandard(
  query: ComposableQuery,
  graphId: string,
  dialect: DialectAdapter,
  compileQuery: QueryCompilerFunction,
): SQL {
  if ("__type" in query) {
    return compileSetOperationCoreStandard(
      query,
      graphId,
      dialect,
      compileQuery,
    );
  }
  return compileQuery(query, graphId);
}

// ============================================================
// SQLite Compilation
// ============================================================

/**
 * SQLite-specific set operation compilation.
 *
 * SQLite compound SELECT statements cannot have parentheses around
 * queries that include CTEs. This function compiles set operations
 * by merging all CTEs into a single WITH clause at the top.
 *
 * @throws Error if any leaf query contains traversals (not yet supported)
 */
function compileSetOperationForSqlite(
  op: SetOperation,
  graphId: string,
  dialect: DialectAdapter,
  schema: SqlSchema,
): SQL {
  // Collect all leaf queries and assign unique prefixes
  const leaves: { ast: QueryAst; prefix: string }[] = [];
  collectLeafQueries(op, leaves, "q");

  // Validate: SQLite set operations currently only support simple queries
  for (const leaf of leaves) {
    validateSqliteSetOpLeaf(leaf.ast);
  }

  // Build all CTEs with unique prefixes
  const allCtes: SQL[] = [];
  const ctx: PredicateCompilerContext = {
    dialect,
    schema,
    compileQuery: () => sql``, // Not used in CTE compilation
  };

  for (const leaf of leaves) {
    const cte = compilePrefixedStartCte(leaf.ast, leaf.prefix, graphId, ctx);
    allCtes.push(cte);
  }

  // Build SELECT statements for each leaf
  const selectStatements: SQL[] = [];
  for (const leaf of leaves) {
    const select = compilePrefixedSelect(leaf.ast, leaf.prefix, dialect);
    selectStatements.push(select);
  }

  // Build compound SELECT from the set operation structure
  const compoundSelect = buildCompoundSelect(op, leaves, selectStatements);

  // Assemble final query
  const parts: SQL[] = [];

  if (allCtes.length > 0) {
    parts.push(sql`WITH ${sql.join(allCtes, sql`, `)}`);
  }

  parts.push(compoundSelect);

  // Handle ORDER BY, LIMIT, OFFSET
  appendOrderByLimitOffset(parts, op, dialect);

  return sql.join(parts, sql` `);
}

/**
 * Validates that a leaf query is compatible with SQLite set operations.
 * SQLite's compound SELECT has significant limitations compared to PostgreSQL.
 *
 * @throws Error if the query uses unsupported features
 */
function validateSqliteSetOpLeaf(ast: QueryAst): void {
  const unsupported: string[] = [];

  // Traversals require multiple CTEs which SQLite can't handle in compound statements
  if (ast.traversals.length > 0) {
    unsupported.push("traversals");
  }

  // Subqueries (EXISTS/IN) would need CTEs or nested queries
  if (hasSubqueryPredicates(ast)) {
    unsupported.push("EXISTS/IN subqueries");
  }

  // Vector similarity requires the embeddings table join
  if (hasVectorSimilarityPredicates(ast)) {
    unsupported.push("vector similarity predicates");
  }

  // GROUP BY/HAVING would need to be applied to the individual leaf, not the compound result
  if (ast.groupBy !== undefined) {
    unsupported.push("GROUP BY");
  }
  if (ast.having !== undefined) {
    unsupported.push("HAVING");
  }

  // Per-leaf ORDER BY/LIMIT/OFFSET would silently be ignored in compound statements
  // (only the outer ORDER BY/LIMIT/OFFSET apply)
  if (ast.orderBy !== undefined && ast.orderBy.length > 0) {
    unsupported.push(
      "per-query ORDER BY (use set operation's orderBy instead)",
    );
  }
  if (ast.limit !== undefined) {
    unsupported.push("per-query LIMIT (use set operation's limit instead)");
  }
  if (ast.offset !== undefined) {
    unsupported.push("per-query OFFSET (use set operation's offset instead)");
  }

  if (unsupported.length > 0) {
    throw new Error(
      `SQLite set operations (UNION/INTERSECT/EXCEPT) do not support: ${unsupported.join(", ")}. ` +
        "Use PostgreSQL for complex set operations, or refactor to separate queries.",
    );
  }
}

/**
 * Checks if a query AST has vector similarity predicates.
 */
function hasVectorSimilarityPredicates(ast: QueryAst): boolean {
  return ast.predicates.some((predicate) =>
    hasVectorSimilarityInExpression(predicate.expression),
  );
}

/**
 * Recursively checks if a predicate expression contains vector similarity.
 */
function hasVectorSimilarityInExpression(
  expr: QueryAst["predicates"][0]["expression"],
): boolean {
  if ("__type" in expr) {
    switch (expr.__type) {
      case "and":
      case "or": {
        return expr.predicates.some((p) => hasVectorSimilarityInExpression(p));
      }
      case "not": {
        return hasVectorSimilarityInExpression(expr.predicate);
      }
      case "vector_similarity": {
        return true;
      }
      case "exists":
      case "in_subquery":
      case "comparison":
      case "string_op":
      case "null_check":
      case "between":
      case "array_op":
      case "object_op":
      case "aggregate_comparison": {
        return false;
      }
    }
  }
  return false;
}

/**
 * Checks if a query AST has predicates with subqueries (EXISTS/IN with subquery).
 */
function hasSubqueryPredicates(ast: QueryAst): boolean {
  return ast.predicates.some((predicate) =>
    hasSubqueryInExpression(predicate.expression),
  );
}

/**
 * Recursively checks if a predicate expression contains subqueries.
 */
function hasSubqueryInExpression(
  expr: QueryAst["predicates"][0]["expression"],
): boolean {
  if ("__type" in expr) {
    switch (expr.__type) {
      case "and":
      case "or": {
        return expr.predicates.some((p) => hasSubqueryInExpression(p));
      }
      case "not": {
        return hasSubqueryInExpression(expr.predicate);
      }
      case "exists": {
        return true; // EXISTS always has a subquery
      }
      case "in_subquery": {
        return true; // IN with subquery
      }
      // These expression types don't contain subqueries
      case "comparison":
      case "string_op":
      case "null_check":
      case "between":
      case "array_op":
      case "object_op":
      case "aggregate_comparison":
      case "vector_similarity": {
        return false;
      }
    }
  }
  return false;
}

/**
 * Recursively collects all leaf QueryAst nodes from a set operation tree.
 * Assigns unique prefixes to each leaf (q0, q1, q2, etc.).
 */
function collectLeafQueries(
  query: ComposableQuery,
  leaves: { ast: QueryAst; prefix: string }[],
  basePrefix: string,
): void {
  if ("__type" in query) {
    // This is a SetOperation, recurse
    collectLeafQueries(query.left, leaves, basePrefix);
    collectLeafQueries(query.right, leaves, basePrefix);
  } else {
    // This is a QueryAst leaf
    const index = leaves.length;
    leaves.push({ ast: query, prefix: `${basePrefix}${index}` });
  }
}

/**
 * Compiles a CTE for the start node selection with a unique prefix.
 */
function compilePrefixedStartCte(
  ast: QueryAst,
  prefix: string,
  graphId: string,
  ctx: PredicateCompilerContext,
): SQL {
  const alias = ast.start.alias;
  const kinds = ast.start.kinds;

  // Kind filter
  const kindFilter =
    kinds.length === 1 ?
      sql`kind = ${kinds[0]}`
    : sql`kind IN (${sql.join(
        kinds.map((k) => sql`${k}`),
        sql`, `,
      )})`;

  // Temporal filter
  const temporalFilter = compileTemporalFilter(extractTemporalOptions(ast));

  // Node predicates for this alias
  const cteContext: PredicateCompilerContext = { ...ctx, cteColumnPrefix: "" };
  const predicateClauses = ast.predicates
    .filter((p) => p.targetAlias === alias)
    .map((p) => compilePredicateExpression(p.expression, cteContext));

  // Combine all WHERE clauses
  const whereClauses = [
    sql`graph_id = ${graphId}`,
    kindFilter,
    temporalFilter,
    ...predicateClauses,
  ];

  // Use prefixed CTE name: cte_q0_c, cte_q1_c, etc.
  const cteName = `cte_${prefix}_${alias}`;

  return sql`
    ${sql.raw(cteName)} AS (
      SELECT
        id AS ${sql.raw(alias)}_id,
        kind AS ${sql.raw(alias)}_kind,
        props AS ${sql.raw(alias)}_props,
        version AS ${sql.raw(alias)}_version,
        valid_from AS ${sql.raw(alias)}_valid_from,
        valid_to AS ${sql.raw(alias)}_valid_to,
        created_at AS ${sql.raw(alias)}_created_at,
        updated_at AS ${sql.raw(alias)}_updated_at,
        deleted_at AS ${sql.raw(alias)}_deleted_at
      FROM ${ctx.schema.nodesTable}
      WHERE ${sql.join(whereClauses, sql` AND `)}
    )
  `;
}

/**
 * Compiles the SELECT statement for a leaf query using the prefixed CTE.
 */
function compilePrefixedSelect(
  ast: QueryAst,
  prefix: string,
  dialect: DialectAdapter,
): SQL {
  const alias = ast.start.alias;
  const cteName = `cte_${prefix}_${alias}`;
  const fields = ast.projection.fields;

  // Build projection
  let projection: SQL;
  if (fields.length === 0) {
    projection = sql.raw("*");
  } else {
    const projectedFields = fields.map((f) => {
      const source = compileFieldValueForSetOp(
        f.source,
        prefix,
        alias,
        dialect,
      );
      // Quote the output name with proper escaping to preserve case and handle special characters
      return sql`${source} AS ${sql.raw(dialect.quoteIdentifier(f.outputName))}`;
    });
    projection = sql.join(projectedFields, sql`, `);
  }

  return sql`SELECT ${projection} FROM ${sql.raw(cteName)}`;
}

/**
 * Compiles a field value reference for set operation queries.
 */
function compileFieldValueForSetOp(
  source: QueryAst["projection"]["fields"][0]["source"],
  prefix: string,
  alias: string,
  dialect: DialectAdapter,
): SQL {
  if ("__type" in source && source.__type === "aggregate") {
    // Aggregate expressions
    const { field, function: fn } = source;
    const cteName = `cte_${prefix}_${field.alias}`;

    switch (fn) {
      case "count": {
        return sql`COUNT(${sql.raw(cteName)}.${sql.raw(field.alias)}_id)`;
      }
      case "countDistinct": {
        return sql`COUNT(DISTINCT ${sql.raw(cteName)}.${sql.raw(field.alias)}_id)`;
      }
      case "sum":
      case "avg":
      case "min":
      case "max": {
        const column = compileFieldColumnForSetOp(field, prefix, dialect);
        return sql`${sql.raw(fn.toUpperCase())}(${column})`;
      }
      default: {
        throw new Error(`Unknown aggregate function: ${fn as string}`);
      }
    }
  }

  // Field reference
  return compileFieldColumnForSetOp(source, prefix, dialect);
}

/**
 * Compiles a field column reference for set operation queries.
 */
function compileFieldColumnForSetOp(
  field: {
    alias: string;
    path: readonly string[];
    jsonPointer?: JsonPointer | undefined;
    valueType?: string | undefined;
  },
  prefix: string,
  dialect: DialectAdapter,
): SQL {
  const cteName = `cte_${prefix}_${field.alias}`;
  const alias = field.alias;

  // Handle direct column references
  if (field.path.length === 1) {
    const columnName = field.path[0];
    // Map path names to column names
    const columnMap: Record<string, string> = {
      id: "_id",
      kind: "_kind",
      props: "_props",
      version: "_version",
      valid_from: "_valid_from",
      valid_to: "_valid_to",
      created_at: "_created_at",
      updated_at: "_updated_at",
      deleted_at: "_deleted_at",
    };
    const suffix = columnMap[columnName!];
    if (suffix) {
      return sql.raw(`${cteName}.${alias}${suffix}`);
    }
  }

  // JSON field (path starts with "props" and has a json pointer)
  const column = sql.raw(`${cteName}.${alias}_props`);
  const pointer = field.jsonPointer;

  if (!pointer) {
    return column;
  }

  // Use appropriate JSON extraction based on value type
  const valueType = field.valueType;
  if (valueType === "number") {
    return dialect.jsonExtractNumber(column, pointer);
  }
  if (valueType === "boolean") {
    return dialect.jsonExtractBoolean(column, pointer);
  }
  return dialect.jsonExtractText(column, pointer);
}

/**
 * Builds the compound SELECT statement from the set operation structure.
 */
function buildCompoundSelect(
  op: SetOperation,
  leaves: { ast: QueryAst; prefix: string }[],
  selectStatements: SQL[],
): SQL {
  // Build a map from prefix to select statement
  const prefixToSelect = new Map<string, SQL>();
  for (const [index, leaf] of leaves.entries()) {
    prefixToSelect.set(leaf.prefix, selectStatements[index]!);
  }

  // Recursively build compound select
  return buildCompoundSelectRecursive(op, leaves, prefixToSelect);
}

/**
 * Recursively builds compound SELECT with proper operator placement.
 */
function buildCompoundSelectRecursive(
  query: ComposableQuery,
  leaves: { ast: QueryAst; prefix: string }[],
  prefixToSelect: Map<string, SQL>,
): SQL {
  if (!("__type" in query)) {
    // This is a leaf QueryAst - find its prefix and return the SELECT
    const leaf = leaves.find((l) => l.ast === query);
    if (!leaf) {
      throw new Error("Leaf query not found in leaves array");
    }
    return prefixToSelect.get(leaf.prefix)!;
  }

  // This is a SetOperation
  const left = buildCompoundSelectRecursive(query.left, leaves, prefixToSelect);
  const right = buildCompoundSelectRecursive(
    query.right,
    leaves,
    prefixToSelect,
  );
  const opSql = sql.raw(OPERATOR_MAP[query.operator]!);

  return sql`${left} ${opSql} ${right}`;
}

// ============================================================
// Shared Utilities
// ============================================================

/**
 * Gets the leftmost leaf's projection from a set operation.
 * The leftmost leaf defines the output column names for the compound query.
 */
function getLeftmostProjection(op: SetOperation): Projection {
  let current: ComposableQuery = op.left;
  while ("__type" in current) {
    // current is a SetOperation, traverse left
    current = current.left;
  }
  // current is now a QueryAst (the leftmost leaf)
  return current.projection;
}

/**
 * Normalizes a FieldRef to a canonical key for comparison.
 *
 * Handles equivalent representations:
 * - path: ["props", "name"] (no jsonPointer) → "alias:props:/name"
 * - path: ["props"], jsonPointer: "/name" → "alias:props:/name"
 *
 * This matches the normalization logic in compileFieldValue/getFieldPointer.
 */
function normalizeFieldRefKey(field: FieldRef): string {
  // Derive JSON pointer from path if not explicitly set (same logic as predicates.ts getFieldPointer)
  let pointer: JsonPointer | undefined = field.jsonPointer;
  if (
    pointer === undefined &&
    field.path.length > 1 &&
    field.path[0] === "props"
  ) {
    pointer = jsonPointer(field.path.slice(1));
  }

  // Normalize base path: for JSON fields, always use ["props"]
  const basePath =
    field.path.length > 0 && field.path[0] === "props" ?
      "props"
    : field.path.join(".");

  return `${field.alias}:${basePath}:${pointer ?? ""}`;
}

/**
 * Matches a FieldRef from ORDER BY to a ProjectedField in the projection.
 * Returns the matching ProjectedField or undefined if no match.
 *
 * Uses normalized keys to handle equivalent field representations.
 */
function matchFieldToProjection(
  field: FieldRef,
  projection: Projection,
): ProjectedField | undefined {
  const targetKey = normalizeFieldRefKey(field);

  for (const projected of projection.fields) {
    const source = projected.source;

    // Only match against FieldRef sources (not aggregates)
    if (!("__type" in source) || source.__type !== "field_ref") continue;

    // Compare normalized keys
    if (normalizeFieldRefKey(source) === targetKey) {
      return projected;
    }
  }
  return undefined;
}

/**
 * Appends ORDER BY, LIMIT, OFFSET clauses to the parts array.
 *
 * For set operations, ORDER BY must reference output column names from
 * the compound result, not internal CTE columns. This function:
 * 1. Maps each ORDER BY field to its output name from the leftmost projection
 * 2. Uses IS NULL emulation for consistent NULLS FIRST/LAST across dialects
 * 3. Throws a descriptive error if an ORDER BY field isn't in the projection
 */
function appendOrderByLimitOffset(
  parts: SQL[],
  op: SetOperation,
  dialect: DialectAdapter,
): void {
  // Handle ORDER BY if present
  if (op.orderBy && op.orderBy.length > 0) {
    const projection = getLeftmostProjection(op);

    // Check for SELECT * (empty projection) - can't order by named columns
    if (projection.fields.length === 0) {
      throw new Error(
        "Set operation ORDER BY requires explicit field projection. " +
          "SELECT * does not provide stable output column names for ordering. " +
          "Use .select() to specify which fields to project.",
      );
    }

    const orderParts: SQL[] = [];

    for (const o of op.orderBy) {
      const projected = matchFieldToProjection(o.field, projection);

      if (!projected) {
        // Build a descriptive error message
        const fieldDesc =
          o.field.jsonPointer ?
            `${o.field.alias}.props${o.field.jsonPointer}`
          : `${o.field.alias}.${o.field.path.join(".")}`;
        const availableFields = projection.fields
          .map((f) => f.outputName)
          .join(", ");
        throw new Error(
          `Set operation ORDER BY field "${fieldDesc}" is not in the projection. ` +
            `ORDER BY for UNION/INTERSECT/EXCEPT must reference projected columns. ` +
            `Available columns: ${availableFields}`,
        );
      }

      // Use output column name with proper quoting
      const columnRef = sql.raw(dialect.quoteIdentifier(projected.outputName));
      const dir = sql.raw(o.direction.toUpperCase());

      // Handle nulls with IS NULL emulation for cross-dialect consistency
      // Default: ASC → NULLS LAST, DESC → NULLS FIRST
      const nulls = o.nulls ?? (o.direction === "asc" ? "last" : "first");
      const nullsDir = sql.raw(nulls === "first" ? "DESC" : "ASC");

      // Emulate NULLS FIRST/LAST: (col IS NULL) ASC/DESC, col DIR
      orderParts.push(
        sql`(${columnRef} IS NULL) ${nullsDir}`,
        sql`${columnRef} ${dir}`,
      );
    }

    parts.push(sql`ORDER BY ${sql.join(orderParts, sql`, `)}`);
  }

  // Handle LIMIT
  if (op.limit !== undefined) {
    parts.push(sql`LIMIT ${op.limit}`);
  }

  // Handle OFFSET
  if (op.offset !== undefined) {
    parts.push(sql`OFFSET ${op.offset}`);
  }
}
