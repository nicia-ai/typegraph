/**
 * Recursive CTE Compilation
 *
 * Compiles variable-length path traversals using WITH RECURSIVE.
 * Handles cycle detection and depth limiting using dialect-specific operations.
 */
import { type SQL, sql } from "drizzle-orm";

import { UnsupportedPredicateError } from "../../errors";
import { type QueryAst, type Traversal, type VariableLengthSpec } from "../ast";
import { type DialectAdapter } from "../dialect";
import {
  compileFieldValue,
  compilePredicateExpression,
  type PredicateCompilerContext,
} from "./predicates";
import { compileTemporalFilter, extractTemporalOptions } from "./temporal";

// ============================================================
// Constants
// ============================================================

/**
 * Maximum depth for recursive CTE queries.
 *
 * This limit prevents runaway recursion in variable-length path queries.
 * Even when a user specifies "unlimited" depth (-1), this limit is enforced.
 * The limit of 100 is sufficient for most graph traversal use cases while
 * preventing database resource exhaustion.
 */
export const MAX_RECURSIVE_DEPTH = 100;

// ============================================================
// Types
// ============================================================

/**
 * Traversal with required variable-length spec.
 */
type VariableLengthTraversal = Traversal & {
  variableLength: VariableLengthSpec;
};

// ============================================================
// Main Compiler
// ============================================================

/**
 * Compiles a variable-length query using recursive CTEs.
 *
 * @param ast - The query AST
 * @param graphId - The graph ID
 * @param ctx - Predicate compiler context
 * @returns SQL for the recursive query
 */
export function compileVariableLengthQuery(
  ast: QueryAst,
  graphId: string,
  ctx: PredicateCompilerContext,
): SQL {
  const { dialect } = ctx;

  // Find the variable-length traversal
  const vlTraversal = ast.traversals.find(
    (t): t is VariableLengthTraversal => t.variableLength !== undefined,
  );

  if (!vlTraversal) {
    throw new Error("No variable-length traversal found");
  }

  // Currently we only support a single variable-length traversal
  if (ast.traversals.length > 1) {
    throw new UnsupportedPredicateError(
      "Variable-length traversals with multiple traversals are not yet supported. " +
        "Please use a single variable-length traversal.",
    );
  }

  // Build the recursive CTE
  const recursiveCte = compileRecursiveCte(ast, vlTraversal, graphId, ctx);

  // Build projection
  const projection = compileRecursiveProjection(ast, vlTraversal);

  // Build final SELECT
  const minDepth = vlTraversal.variableLength.minDepth;
  const depthFilter =
    minDepth > 0 ? sql`WHERE depth >= ${minDepth}` : sql.raw("");

  // Order by and limit/offset
  const orderBy = compileRecursiveOrderBy(ast, dialect);
  const limitOffset = compileLimitOffset(ast);

  const parts: SQL[] = [
    sql`WITH RECURSIVE`,
    recursiveCte,
    sql`SELECT ${projection}`,
    sql`FROM recursive_cte`,
    depthFilter,
  ];

  if (orderBy) parts.push(orderBy);
  if (limitOffset) parts.push(limitOffset);

  return sql.join(parts, sql` `);
}

/**
 * Checks if a query contains variable-length traversals.
 */
export function hasVariableLengthTraversal(ast: QueryAst): boolean {
  return ast.traversals.some((t) => t.variableLength !== undefined);
}

// ============================================================
// Recursive CTE Generation
// ============================================================

/**
 * Compiles the recursive CTE for variable-length traversal.
 */
function compileRecursiveCte(
  ast: QueryAst,
  traversal: VariableLengthTraversal,
  graphId: string,
  ctx: PredicateCompilerContext,
): SQL {
  const { dialect } = ctx;
  const startAlias = ast.start.alias;
  const startKinds = ast.start.kinds;
  const nodeAlias = traversal.nodeAlias;
  const edgeKinds = traversal.edgeKinds;
  const nodeKinds = traversal.nodeKinds;
  const direction = traversal.direction;
  const vl = traversal.variableLength;

  // Kind filters
  const startKindFilter = compileKindFilter(startKinds, "n0.kind");
  const edgeKindFilter = compileKindFilter(edgeKinds, "e.kind");
  const nodeKindFilter = compileKindFilter(nodeKinds, "n.kind");

  // Temporal filter
  const temporalFilter = compileTemporalFilter(extractTemporalOptions(ast));

  // Start predicates (with cteColumnPrefix "" for raw n0 columns)
  const startContext = { ...ctx, cteColumnPrefix: "" };
  const startPredicates = compileNodePredicates(ast, startAlias, startContext);

  // Edge predicates (with cteColumnPrefix "e" for e.props)
  const edgeContext = { ...ctx, cteColumnPrefix: "e" };
  const edgePredicates = compileEdgePredicates(
    ast,
    traversal.edgeAlias,
    edgeContext,
  );

  // Target node predicates (with cteColumnPrefix "n" for n.props)
  const targetContext = { ...ctx, cteColumnPrefix: "n" };
  const targetNodePredicates = compileNodePredicates(
    ast,
    nodeAlias,
    targetContext,
  );

  // Edge join conditions based on direction
  const edgeJoinField = direction === "out" ? "from_id" : "to_id";
  const targetField = direction === "out" ? "to_id" : "from_id";

  // Max depth condition - enforce MAX_RECURSIVE_DEPTH even for "unlimited" queries
  const effectiveMaxDepth =
    vl.maxDepth > 0 ?
      Math.min(vl.maxDepth, MAX_RECURSIVE_DEPTH)
    : MAX_RECURSIVE_DEPTH;
  const maxDepthCondition = sql`r.depth < ${effectiveMaxDepth}`;

  // Cycle check using dialect adapter
  const cycleCheck = dialect.cycleCheck(sql.raw("n.id"), sql.raw("r.path"));

  // Initial path using dialect adapter
  const initialPath = dialect.initializePath(sql.raw("n0.id"));

  // Path extension using dialect adapter
  const pathExtension = dialect.extendPath(sql.raw("r.path"), sql.raw("n.id"));

  // Base case WHERE clauses
  const baseWhereClauses = [
    sql`n0.graph_id = ${graphId}`,
    startKindFilter,
    temporalFilter,
    ...startPredicates,
  ];

  // Recursive case WHERE clauses
  const recursiveWhereClauses = [
    sql`e.graph_id = ${graphId}`,
    edgeKindFilter,
    nodeKindFilter,
    maxDepthCondition,
    cycleCheck,
    ...edgePredicates,
    ...targetNodePredicates,
  ];

  return sql`
    recursive_cte AS (
      -- Base case: starting nodes
      SELECT
        n0.id AS ${sql.raw(startAlias)}_id,
        n0.kind AS ${sql.raw(startAlias)}_kind,
        n0.props AS ${sql.raw(startAlias)}_props,
        n0.version AS ${sql.raw(startAlias)}_version,
        n0.valid_from AS ${sql.raw(startAlias)}_valid_from,
        n0.valid_to AS ${sql.raw(startAlias)}_valid_to,
        n0.created_at AS ${sql.raw(startAlias)}_created_at,
        n0.updated_at AS ${sql.raw(startAlias)}_updated_at,
        n0.deleted_at AS ${sql.raw(startAlias)}_deleted_at,
        n0.id AS ${sql.raw(nodeAlias)}_id,
        n0.kind AS ${sql.raw(nodeAlias)}_kind,
        n0.props AS ${sql.raw(nodeAlias)}_props,
        n0.version AS ${sql.raw(nodeAlias)}_version,
        n0.valid_from AS ${sql.raw(nodeAlias)}_valid_from,
        n0.valid_to AS ${sql.raw(nodeAlias)}_valid_to,
        n0.created_at AS ${sql.raw(nodeAlias)}_created_at,
        n0.updated_at AS ${sql.raw(nodeAlias)}_updated_at,
        n0.deleted_at AS ${sql.raw(nodeAlias)}_deleted_at,
        0 AS depth,
        ${initialPath} AS path
      FROM ${ctx.schema.nodesTable} n0
      WHERE ${sql.join(baseWhereClauses, sql` AND `)}

      UNION ALL

      -- Recursive case: follow edges
      SELECT
        r.${sql.raw(startAlias)}_id,
        r.${sql.raw(startAlias)}_kind,
        r.${sql.raw(startAlias)}_props,
        r.${sql.raw(startAlias)}_version,
        r.${sql.raw(startAlias)}_valid_from,
        r.${sql.raw(startAlias)}_valid_to,
        r.${sql.raw(startAlias)}_created_at,
        r.${sql.raw(startAlias)}_updated_at,
        r.${sql.raw(startAlias)}_deleted_at,
        n.id AS ${sql.raw(nodeAlias)}_id,
        n.kind AS ${sql.raw(nodeAlias)}_kind,
        n.props AS ${sql.raw(nodeAlias)}_props,
        n.version AS ${sql.raw(nodeAlias)}_version,
        n.valid_from AS ${sql.raw(nodeAlias)}_valid_from,
        n.valid_to AS ${sql.raw(nodeAlias)}_valid_to,
        n.created_at AS ${sql.raw(nodeAlias)}_created_at,
        n.updated_at AS ${sql.raw(nodeAlias)}_updated_at,
        n.deleted_at AS ${sql.raw(nodeAlias)}_deleted_at,
        r.depth + 1 AS depth,
        ${pathExtension} AS path
      FROM recursive_cte r
      JOIN ${ctx.schema.edgesTable} e ON e.${sql.raw(edgeJoinField)} = r.${sql.raw(nodeAlias)}_id
      JOIN ${ctx.schema.nodesTable} n ON n.id = e.${sql.raw(targetField)}
      WHERE ${sql.join(recursiveWhereClauses, sql` AND `)}
    )
  `;
}

// ============================================================
// Helper Functions
// ============================================================

/**
 * Compiles a kind filter for IN clause.
 */
function compileKindFilter(kinds: readonly string[], columnExpr: string): SQL {
  if (kinds.length === 1) {
    return sql`${sql.raw(columnExpr)} = ${kinds[0]}`;
  }
  return sql`${sql.raw(columnExpr)} IN (${sql.join(
    kinds.map((k) => sql`${k}`),
    sql`, `,
  )})`;
}

/**
 * Compiles node predicates for a specific alias.
 * Filters by alias and excludes edge predicates (targetType !== "edge").
 */
function compileNodePredicates(
  ast: QueryAst,
  alias: string,
  ctx: PredicateCompilerContext,
): SQL[] {
  return ast.predicates
    .filter((p) => p.targetAlias === alias && p.targetType !== "edge")
    .map((p) => compilePredicateExpression(p.expression, ctx));
}

/**
 * Compiles edge predicates for a specific edge alias.
 * Filters by alias and only includes edge predicates (targetType === "edge").
 */
function compileEdgePredicates(
  ast: QueryAst,
  edgeAlias: string,
  ctx: PredicateCompilerContext,
): SQL[] {
  return ast.predicates
    .filter((p) => p.targetAlias === edgeAlias && p.targetType === "edge")
    .map((p) => compilePredicateExpression(p.expression, ctx));
}

/**
 * Compiles projection for recursive query results.
 */
function compileRecursiveProjection(
  ast: QueryAst,
  traversal: VariableLengthTraversal,
): SQL {
  const startAlias = ast.start.alias;
  const nodeAlias = traversal.nodeAlias;
  const vl = traversal.variableLength;

  const fields: SQL[] = [
    // Start alias fields with metadata
    sql`${sql.raw(startAlias)}_id`,
    sql`${sql.raw(startAlias)}_kind`,
    sql`${sql.raw(startAlias)}_props`,
    sql`${sql.raw(startAlias)}_version`,
    sql`${sql.raw(startAlias)}_valid_from`,
    sql`${sql.raw(startAlias)}_valid_to`,
    sql`${sql.raw(startAlias)}_created_at`,
    sql`${sql.raw(startAlias)}_updated_at`,
    sql`${sql.raw(startAlias)}_deleted_at`,
    // Node alias fields with metadata
    sql`${sql.raw(nodeAlias)}_id`,
    sql`${sql.raw(nodeAlias)}_kind`,
    sql`${sql.raw(nodeAlias)}_props`,
    sql`${sql.raw(nodeAlias)}_version`,
    sql`${sql.raw(nodeAlias)}_valid_from`,
    sql`${sql.raw(nodeAlias)}_valid_to`,
    sql`${sql.raw(nodeAlias)}_created_at`,
    sql`${sql.raw(nodeAlias)}_updated_at`,
    sql`${sql.raw(nodeAlias)}_deleted_at`,
  ];

  // Always include depth with the alias
  const depthAlias = vl.depthAlias ?? `${nodeAlias}_depth`;
  fields.push(sql`depth AS ${sql.raw(depthAlias)}`);

  // Include path if requested
  if (vl.collectPath) {
    const pathAlias = vl.pathAlias ?? `${nodeAlias}_path`;
    fields.push(sql`path AS ${sql.raw(pathAlias)}`);
  }

  return sql.join(fields, sql`, `);
}

/**
 * Compiles ORDER BY for recursive query.
 */
function compileRecursiveOrderBy(
  ast: QueryAst,
  dialect: DialectAdapter,
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
    // For recursive queries, field refs are direct column names
    const field = compileFieldValue(o.field, dialect, valueType);
    const dir = sql.raw(o.direction.toUpperCase());
    const nulls = o.nulls ?? (o.direction === "asc" ? "last" : "first");
    const nullsDir = sql.raw(nulls === "first" ? "DESC" : "ASC");

    parts.push(sql`(${field} IS NULL) ${nullsDir}`, sql`${field} ${dir}`);
  }

  return sql`ORDER BY ${sql.join(parts, sql`, `)}`;
}

/**
 * Compiles LIMIT and OFFSET clauses.
 */
function compileLimitOffset(ast: QueryAst): SQL | undefined {
  const parts: SQL[] = [];

  if (ast.limit !== undefined) {
    parts.push(sql`LIMIT ${ast.limit}`);
  }
  if (ast.offset !== undefined) {
    parts.push(sql`OFFSET ${ast.offset}`);
  }

  return parts.length > 0 ? sql.join(parts, sql` `) : undefined;
}
