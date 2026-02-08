/**
 * Query Compiler Module
 *
 * Main entry point for compiling query ASTs to SQL.
 * Re-exports individual compiler modules and provides the main compile functions.
 */

// Re-export sub-modules
export {
  compileAggregateExpr,
  compileFieldColumn,
  compileFieldValue,
  compilePredicateExpression,
  type PredicateCompilerContext,
} from "./predicates";
export {
  createSqlSchema,
  DEFAULT_SQL_SCHEMA,
  type SqlSchema,
  type SqlTableNames,
} from "./schema";
// Note: compileSetOperation is defined below as a wrapper
export {
  compileVariableLengthQuery,
  hasVariableLengthTraversal,
  MAX_RECURSIVE_DEPTH,
} from "./recursive";
export {
  compileTemporalFilter,
  extractTemporalOptions,
  type TemporalFilterOptions,
} from "./temporal";

// Re-export dialect types
export { getDialect, type SqlDialect } from "../dialect";

import { type SQL, sql } from "drizzle-orm";

import { UnsupportedPredicateError } from "../../errors";
import {
  type AggregateExpr,
  type FieldRef,
  type QueryAst,
  type SelectiveField,
  type SetOperation,
  type VectorSimilarityPredicate,
} from "../ast";
import { getDialect, type SqlDialect } from "../dialect";
import { jsonPointer } from "../json-pointer";
import {
  compileFieldValue,
  compilePredicateExpression,
  extractVectorSimilarityPredicates,
  type PredicateCompilerContext,
} from "./predicates";
import {
  compileVariableLengthQuery,
  hasVariableLengthTraversal,
} from "./recursive";
import { DEFAULT_SQL_SCHEMA, type SqlSchema } from "./schema";
import { compileSetOperation as compileSetOp } from "./set-operations";
import { compileTemporalFilter, extractTemporalOptions } from "./temporal";

// ============================================================
// Main Query Compiler
// ============================================================

/**
 * Options for query compilation.
 */
export type CompileQueryOptions = Readonly<{
  /** SQL dialect ("sqlite" or "postgres"). Defaults to "sqlite". */
  dialect?: SqlDialect | undefined;
  /** SQL schema configuration for table names. Defaults to standard names. */
  schema?: SqlSchema | undefined;
}>;

/**
 * Compiles a query AST to SQL.
 *
 * This is the main entry point for query compilation. It dispatches to
 * the appropriate compiler based on the query type (standard, recursive,
 * or set operation).
 *
 * @param ast - The query AST to compile
 * @param graphId - The graph ID for filtering
 * @param options - Compilation options (dialect, schema)
 * @returns Drizzle SQL object ready for execution
 *
 * @example
 * ```typescript
 * const ast = query.toAst();
 * const sql = compileQuery(ast, "my_graph", { dialect: "postgres" });
 * const results = await db.execute(sql);
 * ```
 *
 * @example
 * ```typescript
 * // With custom table names
 * const schema = createSqlSchema({ nodes: "myapp_nodes", edges: "myapp_edges" });
 * const sql = compileQuery(ast, "my_graph", { dialect: "postgres", schema });
 * ```
 */
export function compileQuery(
  ast: QueryAst,
  graphId: string,
  options: CompileQueryOptions | SqlDialect = "sqlite",
): SQL {
  // Support legacy signature: compileQuery(ast, graphId, dialect)
  const options_: CompileQueryOptions =
    typeof options === "string" ? { dialect: options } : options;
  const dialect = options_.dialect ?? "sqlite";
  const schema = options_.schema ?? DEFAULT_SQL_SCHEMA;

  const adapter = getDialect(dialect);
  const ctx: PredicateCompilerContext = {
    dialect: adapter,
    schema,
    compileQuery: (subAst, subGraphId) =>
      compileQuery(subAst as QueryAst, subGraphId, { dialect, schema }),
  };

  // Check for variable-length traversals
  if (hasVariableLengthTraversal(ast)) {
    return compileVariableLengthQuery(ast, graphId, ctx);
  }

  // Standard query compilation
  return compileStandardQuery(ast, graphId, ctx);
}

/**
 * Compiles a set operation (UNION/INTERSECT/EXCEPT) to SQL.
 *
 * @param op - The set operation AST
 * @param graphId - The graph ID for filtering
 * @param options - Compilation options (dialect, schema)
 * @returns Drizzle SQL object
 */
export function compileSetOperation(
  op: SetOperation,
  graphId: string,
  options: CompileQueryOptions | SqlDialect = "sqlite",
): SQL {
  // Support legacy signature: compileSetOperation(op, graphId, dialect)
  const options_: CompileQueryOptions =
    typeof options === "string" ? { dialect: options } : options;
  const dialect = options_.dialect ?? "sqlite";
  const schema = options_.schema ?? DEFAULT_SQL_SCHEMA;

  const adapter = getDialect(dialect);
  return compileSetOp(op, graphId, adapter, schema, (ast, gid) =>
    compileQuery(ast, gid, { dialect, schema }),
  );
}

// ============================================================
// Standard Query Compilation
// ============================================================

function quoteIdentifier(identifier: string): SQL {
  return sql.raw(`"${identifier.replaceAll('"', '""')}"`);
}

/**
 * Compiles a standard (non-recursive) query to SQL using CTEs.
 */
function compileStandardQuery(
  ast: QueryAst,
  graphId: string,
  ctx: PredicateCompilerContext,
): SQL {
  const { dialect } = ctx;

  // Check for vector similarity predicates - they require special handling
  const vectorPredicates = extractVectorSimilarityPredicates(ast.predicates);
  const vectorPredicate = vectorPredicates[0]; // Only support single vector predicate

  if (vectorPredicates.length > 1) {
    throw new UnsupportedPredicateError(
      "Multiple vector similarity predicates in a single query are not supported",
    );
  }

  // Build CTEs
  const ctes: SQL[] = [compileStartCte(ast, graphId, ctx)];

  // Traversal CTEs
  for (let index = 0; index < ast.traversals.length; index++) {
    ctes.push(compileTraversalCte(ast, index, graphId, ctx));
  }

  // Add embeddings CTE if vector similarity is used
  if (vectorPredicate) {
    ctes.push(compileEmbeddingsCte(vectorPredicate, graphId, ctx));
  }

  // Build main SELECT
  const projection = compileProjection(ast, dialect);
  const fromClause = compileFromClause(ast, vectorPredicate);
  const groupBy = compileGroupBy(ast, dialect);
  const having = compileHaving(ast, ctx);

  // Order by distance if vector similarity, otherwise use AST order
  const orderBy =
    vectorPredicate ?
      compileVectorOrderBy(vectorPredicate, ast, dialect)
    : compileOrderBy(ast, dialect);

  // Use vector predicate limit if present and no explicit limit in AST
  const effectiveLimit =
    vectorPredicate && ast.limit === undefined ?
      vectorPredicate.limit
    : ast.limit;
  const limitOffset = compileLimitOffsetWithOverride(
    effectiveLimit,
    ast.offset,
  );

  // Assemble query
  const parts: SQL[] = [
    sql`WITH ${sql.join(ctes, sql`, `)}`,
    sql`SELECT ${projection}`,
    fromClause,
  ];

  if (groupBy) parts.push(groupBy);
  if (having) parts.push(having);
  if (orderBy) parts.push(orderBy);
  if (limitOffset) parts.push(limitOffset);

  return sql.join(parts, sql` `);
}

// ============================================================
// CTE Compilation
// ============================================================

/**
 * Compiles the start CTE for the initial node selection.
 */
function compileStartCte(
  ast: QueryAst,
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
  // Use cteColumnPrefix: "" to generate raw column names (e.g., "props" not "p_props")
  // because CTE WHERE clauses operate on raw table columns before aliasing
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

  return sql`
    cte_${sql.raw(alias)} AS (
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
 * Compiles a traversal CTE for edge+node joins.
 */
function compileTraversalCte(
  ast: QueryAst,
  traversalIndex: number,
  graphId: string,
  ctx: PredicateCompilerContext,
): SQL {
  const traversal = ast.traversals[traversalIndex]!;

  // Determine join condition based on direction
  const joinField = traversal.direction === "out" ? "from_id" : "to_id";
  const targetField = traversal.direction === "out" ? "to_id" : "from_id";

  // Node kind filter
  const nodeKinds = traversal.nodeKinds;
  const nodeKindFilter =
    nodeKinds.length === 1 ?
      sql`n.kind = ${nodeKinds[0]}`
    : sql`n.kind IN (${sql.join(
        nodeKinds.map((k) => sql`${k}`),
        sql`, `,
      )})`;

  // Edge kind filter (supports multiple kinds for ontology expansion)
  const edgeKinds = traversal.edgeKinds;
  const edgeKindFilter =
    edgeKinds.length === 1 ?
      sql`e.kind = ${edgeKinds[0]}`
    : sql`e.kind IN (${sql.join(
        edgeKinds.map((k) => sql`${k}`),
        sql`, `,
      )})`;

  // Temporal filters
  const edgeTemporalFilter = compileTemporalFilter(
    extractTemporalOptions(ast, "e"),
  );
  const nodeTemporalFilter = compileTemporalFilter(
    extractTemporalOptions(ast, "n"),
  );

  // Node predicates for this alias
  // Use cteColumnPrefix: "n" to generate table-qualified column names (e.g., "n.props")
  // because traversal CTE WHERE clauses operate on the joined node table
  const nodeCteContext: PredicateCompilerContext = {
    ...ctx,
    cteColumnPrefix: "n",
  };
  const nodePredicateClauses = ast.predicates
    .filter(
      (p) => p.targetAlias === traversal.nodeAlias && p.targetType !== "edge",
    )
    .map((p) => compilePredicateExpression(p.expression, nodeCteContext));

  // Edge predicates for this traversal's edge alias
  // Use cteColumnPrefix: "e" for edge table columns
  const edgeCteContext: PredicateCompilerContext = {
    ...ctx,
    cteColumnPrefix: "e",
  };
  const edgePredicateClauses = ast.predicates
    .filter(
      (p) => p.targetAlias === traversal.edgeAlias && p.targetType === "edge",
    )
    .map((p) => compilePredicateExpression(p.expression, edgeCteContext));

  const whereClauses = [
    sql`e.graph_id = ${graphId}`,
    edgeKindFilter,
    nodeKindFilter,
    edgeTemporalFilter,
    nodeTemporalFilter,
    ...nodePredicateClauses,
    ...edgePredicateClauses,
  ];

  const previousAlias = traversal.joinFromAlias;
  const edgeAlias = traversal.edgeAlias;
  const nodeAlias = traversal.nodeAlias;

  return sql`
    cte_${sql.raw(nodeAlias)} AS (
      SELECT
        e.id AS ${sql.raw(edgeAlias)}_id,
        e.kind AS ${sql.raw(edgeAlias)}_kind,
        e.from_id AS ${sql.raw(edgeAlias)}_from_id,
        e.to_id AS ${sql.raw(edgeAlias)}_to_id,
        e.props AS ${sql.raw(edgeAlias)}_props,
        e.valid_from AS ${sql.raw(edgeAlias)}_valid_from,
        e.valid_to AS ${sql.raw(edgeAlias)}_valid_to,
        e.created_at AS ${sql.raw(edgeAlias)}_created_at,
        e.updated_at AS ${sql.raw(edgeAlias)}_updated_at,
        e.deleted_at AS ${sql.raw(edgeAlias)}_deleted_at,
        n.id AS ${sql.raw(nodeAlias)}_id,
        n.kind AS ${sql.raw(nodeAlias)}_kind,
        n.props AS ${sql.raw(nodeAlias)}_props,
        n.version AS ${sql.raw(nodeAlias)}_version,
        n.valid_from AS ${sql.raw(nodeAlias)}_valid_from,
        n.valid_to AS ${sql.raw(nodeAlias)}_valid_to,
        n.created_at AS ${sql.raw(nodeAlias)}_created_at,
        n.updated_at AS ${sql.raw(nodeAlias)}_updated_at,
        n.deleted_at AS ${sql.raw(nodeAlias)}_deleted_at,
        cte_${sql.raw(previousAlias)}.${sql.raw(previousAlias)}_id AS ${sql.raw(previousAlias)}_id
      FROM ${ctx.schema.edgesTable} e
      JOIN ${ctx.schema.nodesTable} n ON n.id = e.${sql.raw(targetField)}
      JOIN cte_${sql.raw(previousAlias)} ON cte_${sql.raw(previousAlias)}.${sql.raw(previousAlias)}_id = e.${sql.raw(joinField)}
      WHERE ${sql.join(whereClauses, sql` AND `)}
    )
  `;
}

// ============================================================
// Query Part Compilation
// ============================================================

/**
 * Checks if a source is an aggregate expression.
 */
function isAggregateExpr(
  source: FieldRef | AggregateExpr,
): source is AggregateExpr {
  return "__type" in source && source.__type === "aggregate";
}

/**
 * Compiles a projected source (field ref or aggregate).
 */
function compileProjectedSource(
  field: {
    source: FieldRef | AggregateExpr;
    cteAlias?: string;
  },
  dialect: ReturnType<typeof getDialect>,
): SQL {
  if (isAggregateExpr(field.source)) {
    return compileAggregateExprFromSource(field.source, dialect);
  }
  // Use provided cteAlias if available, otherwise derive from field alias
  const cteAlias = field.cteAlias ?? `cte_${field.source.alias}`;
  return compileFieldValue(
    field.source,
    dialect,
    field.source.valueType,
    cteAlias,
  );
}

/**
 * Compiles an aggregate expression from source.
 *
 * Uses compileFieldValue to properly extract JSON fields with json_extract
 * for numeric aggregates like SUM, AVG, MIN, MAX.
 */
function compileAggregateExprFromSource(
  expr: AggregateExpr,
  dialect: ReturnType<typeof getDialect>,
): SQL {
  const { field } = expr;
  const fn = expr.function;

  switch (fn) {
    case "count": {
      const cteAlias = `cte_${field.alias}`;
      return sql`COUNT(${sql.raw(cteAlias)}.${sql.raw(field.alias)}_id)`;
    }
    case "countDistinct": {
      const cteAlias = `cte_${field.alias}`;
      return sql`COUNT(DISTINCT ${sql.raw(cteAlias)}.${sql.raw(field.alias)}_id)`;
    }
    case "sum":
    case "avg":
    case "min":
    case "max": {
      const cteAlias = `cte_${field.alias}`;
      // Use compileFieldValue to properly extract JSON fields
      const column = compileFieldValue(
        field,
        dialect,
        field.valueType,
        cteAlias,
      );
      return sql`${sql.raw(fn.toUpperCase())}(${column})`;
    }
    default: {
      throw new UnsupportedPredicateError(
        `Unknown aggregate function: ${String(fn)}`,
      );
    }
  }
}

/**
 * Compiles the SELECT projection.
 *
 * If selectiveFields are present, generates optimized SQL that only
 * extracts the specific fields needed, enabling covered index usage.
 */
function compileProjection(
  ast: QueryAst,
  dialect: ReturnType<typeof getDialect>,
): SQL {
  // Check for selective projection first
  if (ast.selectiveFields && ast.selectiveFields.length > 0) {
    return compileSelectiveProjection(ast.selectiveFields, dialect, ast);
  }

  const fields = ast.projection.fields;

  if (fields.length === 0) {
    return sql.raw("*");
  }

  const projectedFields = fields.map((f) => {
    const source = compileProjectedSource(f, dialect);
    // Quote the output name to preserve case in PostgreSQL
    // PostgreSQL converts unquoted identifiers to lowercase
    return sql`${source} AS ${quoteIdentifier(f.outputName)}`;
  });

  return sql.join(projectedFields, sql`, `);
}

/**
 * Compiles selective projection for optimized queries.
 *
 * Generates SQL that only extracts the specific fields needed,
 * rather than fetching the entire props blob. This enables
 * covered index usage when the selected fields are indexed.
 */
function compileSelectiveProjection(
  fields: readonly SelectiveField[],
  dialect: ReturnType<typeof getDialect>,
  ast: QueryAst,
): SQL {
  // Build a mapping from alias to CTE name
  // Start node: alias maps to cte_{alias}
  // Traversal nodes: nodeAlias maps to cte_{nodeAlias}
  // Traversal edges: edgeAlias maps to cte_{nodeAlias} (edge columns are in the traversal CTE)
  const aliasToCte = new Map<string, string>([
    [ast.start.alias, `cte_${ast.start.alias}`],
  ]);

  // Start node

  // Traversals
  for (const traversal of ast.traversals) {
    // Node alias maps to its own CTE
    aliasToCte.set(traversal.nodeAlias, `cte_${traversal.nodeAlias}`);
    // Edge alias maps to the traversal's CTE (which is named after the node)
    aliasToCte.set(traversal.edgeAlias, `cte_${traversal.nodeAlias}`);
  }

  const columns = fields.map((f) => {
    const cteAlias = aliasToCte.get(f.alias) ?? `cte_${f.alias}`;

    if (f.isSystemField) {
      // System fields: direct column reference from CTE
      // Map API field names to database column names
      const dbColumn =
        f.field === "fromId" ? "from_id"
        : f.field === "toId" ? "to_id"
        : f.field.startsWith("meta.") ?
          // Convert camelCase meta fields to snake_case
          // e.g., "meta.validFrom" → "valid_from"
          f.field
            .slice(5)
            .replaceAll(/([A-Z])/g, "_$1")
            .toLowerCase()
        : f.field;

      return sql`${sql.raw(cteAlias)}.${sql.raw(`${f.alias}_${dbColumn}`)} AS ${quoteIdentifier(f.outputName)}`;
    }

    // Props fields: JSON extraction from the props column.
    // Use the dialect adapter to ensure a stable expression text (important for indexes).
    const propsColumn = `${f.alias}_props`;
    const column = sql`${sql.raw(cteAlias)}.${sql.raw(propsColumn)}`;
    const pointer = jsonPointer([f.field]);
    const extracted = compileSelectiveJsonValue(
      dialect,
      column,
      pointer,
      f.valueType,
    );
    return sql`${extracted} AS ${quoteIdentifier(f.outputName)}`;
  });

  return sql.join(columns, sql`, `);
}

function compileSelectiveJsonValue(
  dialect: ReturnType<typeof getDialect>,
  column: SQL,
  pointer: ReturnType<typeof jsonPointer>,
  valueType: SelectiveField["valueType"],
): SQL {
  switch (valueType) {
    case "string": {
      return dialect.jsonExtractText(column, pointer);
    }
    case "number": {
      return dialect.jsonExtractNumber(column, pointer);
    }
    case "boolean": {
      return dialect.jsonExtractBoolean(column, pointer);
    }
    case "date": {
      return dialect.jsonExtractDate(column, pointer);
    }
    case "array":
    case "object":
    case "embedding":
    case "unknown":
    case undefined: {
      return dialect.jsonExtract(column, pointer);
    }
  }
}

/**
 * Compiles the FROM clause with JOINs.
 *
 * The FROM clause starts from the start CTE and joins each traversal CTE.
 * Each traversal CTE contains a column for its join source's ID.
 * If a vector predicate is present, also joins the embeddings CTE.
 */
function compileFromClause(
  ast: QueryAst,
  vectorPredicate?: VectorSimilarityPredicate,
): SQL {
  const startAlias = ast.start.alias;

  // Start from the first CTE (start alias)
  const fromClause = sql`FROM cte_${sql.raw(startAlias)}`;

  const joins: SQL[] = [];

  // Build JOINs for each traversal
  for (const traversal of ast.traversals) {
    const cteAlias = `cte_${traversal.nodeAlias}`;
    const previousAlias = traversal.joinFromAlias;
    const joinType = traversal.optional ? "LEFT JOIN" : "INNER JOIN";
    // Each traversal CTE has a column for the previous alias's ID
    joins.push(
      sql`${sql.raw(joinType)} ${sql.raw(cteAlias)} ON ${sql.raw(cteAlias)}.${sql.raw(previousAlias)}_id = cte_${sql.raw(previousAlias)}.${sql.raw(previousAlias)}_id`,
    );
  }

  // Join embeddings CTE if vector similarity is used
  if (vectorPredicate) {
    const nodeAlias = vectorPredicate.field.alias;
    joins.push(
      sql`INNER JOIN cte_embeddings ON cte_embeddings.node_id = cte_${sql.raw(nodeAlias)}.${sql.raw(nodeAlias)}_id`,
    );
  }

  if (joins.length === 0) {
    return fromClause;
  }

  return sql`${fromClause} ${sql.join(joins, sql` `)}`;
}

/**
 * Compiles ORDER BY clause.
 */
function compileOrderBy(
  ast: QueryAst,
  dialect: ReturnType<typeof getDialect>,
): SQL | undefined {
  if (!ast.orderBy || ast.orderBy.length === 0) {
    return undefined;
  }

  const parts: SQL[] = [];

  for (const o of ast.orderBy) {
    const valueType = o.field.valueType;
    if (valueType === "array" || valueType === "object") {
      throw new UnsupportedPredicateError(
        "Ordering by JSON arrays or objects is not supported",
      );
    }
    const cteAlias = `cte_${o.field.alias}`;
    const field = compileFieldValue(o.field, dialect, valueType, cteAlias);
    const dir = sql.raw(o.direction.toUpperCase());
    const nulls = o.nulls ?? (o.direction === "asc" ? "last" : "first");
    const nullsDir = sql.raw(nulls === "first" ? "DESC" : "ASC");

    // Enforce consistent NULL ordering across dialects (SQLite differs from PostgreSQL by default).
    // We emulate NULLS FIRST/LAST using an `IS NULL` ordering prefix to avoid relying on dialect syntax.
    parts.push(sql`(${field} IS NULL) ${nullsDir}`, sql`${field} ${dir}`);
  }

  return sql`ORDER BY ${sql.join(parts, sql`, `)}`;
}

/**
 * Creates a unique key for a FieldRef to enable deduplication.
 * Includes jsonPointer to distinguish fields that share the same base path (e.g., "props").
 */
function fieldRefKey(field: FieldRef): string {
  const pointer = field.jsonPointer ?? "";
  return `${field.alias}:${field.path.join(".")}:${pointer}`;
}

/**
 * Compiles GROUP BY clause.
 *
 * PostgreSQL requires all non-aggregated SELECT columns to appear in GROUP BY.
 * This function automatically includes:
 * 1. All non-aggregate projected fields from ast.projection (added first to ensure
 *    GROUP BY expressions match SELECT expressions exactly)
 * 2. Any explicit GROUP BY fields from ast.groupBy not already in projection
 *
 * IMPORTANT: Projected fields are added first because:
 * - SELECT uses field refs from selectAggregate which may not have valueType set
 * - Explicit .groupBy() fields have valueType from schema introspection
 * - If GROUP BY uses different valueType than SELECT, PostgreSQL sees different expressions
 * - By preferring projected fields' valueType, GROUP BY matches SELECT exactly
 *
 * Uses compileFieldValue to properly extract JSON fields with json_extract,
 * ensuring GROUP BY operates on the same values as SELECT.
 */
function compileGroupBy(
  ast: QueryAst,
  dialect: ReturnType<typeof getDialect>,
): SQL | undefined {
  if (!ast.groupBy || ast.groupBy.fields.length === 0) {
    return undefined;
  }

  // Collect all fields that need to be in GROUP BY, deduplicating by key
  const seenKeys = new Set<string>();
  const allFields: FieldRef[] = [];

  // Add all non-aggregate projected fields FIRST
  // This ensures GROUP BY expressions use the same valueType as SELECT expressions
  // The field() helper used in selectAggregate doesn't set valueType, while
  // explicit .groupBy() calls set valueType from schema introspection
  for (const projectedField of ast.projection.fields) {
    if (projectedField.source.__type === "field_ref") {
      const key = fieldRefKey(projectedField.source);
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        allFields.push(projectedField.source);
      }
    }
  }

  // Add explicit GROUP BY fields that aren't already in projection
  // These might group by fields not in SELECT (unusual but valid SQL)
  for (const field of ast.groupBy.fields) {
    const key = fieldRefKey(field);
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      allFields.push(field);
    }
  }

  if (allFields.length === 0) {
    return undefined;
  }

  const parts = allFields.map((f) => {
    const cteAlias = `cte_${f.alias}`;
    // Use compileFieldValue to properly extract JSON fields
    return compileFieldValue(f, dialect, f.valueType, cteAlias);
  });

  return sql`GROUP BY ${sql.join(parts, sql`, `)}`;
}

/**
 * Compiles HAVING clause.
 */
function compileHaving(
  ast: QueryAst,
  ctx: PredicateCompilerContext,
): SQL | undefined {
  if (!ast.having) {
    return undefined;
  }

  const condition = compilePredicateExpression(ast.having, ctx);
  return sql`HAVING ${condition}`;
}

// compileLimitOffset removed - replaced by compileLimitOffsetWithOverride

// ============================================================
// Vector Similarity Compilation
// ============================================================

/**
 * Compiles a CTE for embedding similarity search.
 * This CTE selects from the embeddings table with distance calculation.
 */
function compileEmbeddingsCte(
  vectorPredicate: VectorSimilarityPredicate,
  graphId: string,
  ctx: PredicateCompilerContext,
): SQL {
  const { dialect } = ctx;
  const { field, queryEmbedding, metric, minScore } = vectorPredicate;

  // Get the field path from the JSON pointer (e.g., "/embedding")
  // The jsonPointer is already a string like "/embedding"
  const fieldPath =
    field.jsonPointer ? (field.jsonPointer as string)
    : field.path.length > 1 && field.path[0] === "props" ?
      `/${field.path.slice(1).join("/")}`
    : `/${field.path.join("/")}`;

  // Build distance expression
  const distanceExpr = dialect.vectorDistance(
    sql.raw("embedding"),
    queryEmbedding,
    metric,
  );

  // Build WHERE conditions
  const conditions: SQL[] = [
    sql`graph_id = ${graphId}`,
    sql`field_path = ${fieldPath}`,
  ];

  // Add minScore filter if specified
  if (minScore !== undefined) {
    // minScore is similarity (1.0 = identical), convert to distance threshold
    // For cosine: distance = 1 - similarity, so threshold = 1 - minScore
    const threshold = 1 - minScore;
    conditions.push(sql`${distanceExpr} <= ${threshold}`);
  }

  return sql`
    cte_embeddings AS (
      SELECT
        node_id,
        ${distanceExpr} AS distance,
        (1.0 - ${distanceExpr}) AS score
      FROM ${ctx.schema.embeddingsTable}
      WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY ${distanceExpr} ASC
    )
  `;
}

/**
 * Compiles ORDER BY clause for vector similarity queries.
 * Orders by distance first, then any additional ordering from the AST.
 */
function compileVectorOrderBy(
  _vectorPredicate: VectorSimilarityPredicate,
  ast: QueryAst,
  dialect: ReturnType<typeof getDialect>,
): SQL {
  // Primary ordering: distance ascending (closest first)
  const distanceOrder = sql`cte_embeddings.distance ASC`;

  // Secondary ordering from AST
  const additionalOrders: SQL[] = [];
  if (ast.orderBy && ast.orderBy.length > 0) {
    for (const o of ast.orderBy) {
      const valueType = o.field.valueType;
      if (valueType === "array" || valueType === "object") {
        throw new UnsupportedPredicateError(
          "Ordering by JSON arrays or objects is not supported",
        );
      }
      const cteAlias = `cte_${o.field.alias}`;
      const field = compileFieldValue(o.field, dialect, valueType, cteAlias);
      const dir = sql.raw(o.direction.toUpperCase());
      // Use IS NULL emulation for cross-dialect NULL ordering (same as compileOrderBy)
      const nulls = o.nulls ?? (o.direction === "asc" ? "last" : "first");
      const nullsDir = sql.raw(nulls === "first" ? "DESC" : "ASC");
      additionalOrders.push(
        sql`(${field} IS NULL) ${nullsDir}`,
        sql`${field} ${dir}`,
      );
    }
  }

  const allOrders = [distanceOrder, ...additionalOrders];
  return sql`ORDER BY ${sql.join(allOrders, sql`, `)}`;
}

/**
 * Compiles LIMIT and OFFSET with optional limit override.
 */
function compileLimitOffsetWithOverride(
  limit: number | undefined,
  offset: number | undefined,
): SQL | undefined {
  const parts: SQL[] = [];

  if (limit !== undefined) {
    parts.push(sql`LIMIT ${limit}`);
  }
  if (offset !== undefined) {
    parts.push(sql`OFFSET ${offset}`);
  }

  return parts.length > 0 ? sql.join(parts, sql` `) : undefined;
}
