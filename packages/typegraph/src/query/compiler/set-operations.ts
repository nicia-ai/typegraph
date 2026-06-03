/**
 * Set Operation Compilation
 *
 * Compiles UNION, INTERSECT, and EXCEPT operations to SQL.
 *
 * Both dialects compile each leaf with the full query compiler and combine
 * the results with the requested operator. The only dialect-specific concern
 * is how each operand is wrapped so the compound statement stays valid:
 *
 * - PostgreSQL allows a complete SELECT (including its own WITH clause) to be
 *   parenthesized as a compound operand: `(SELECT ...) UNION (SELECT ...)`.
 * - SQLite forbids parentheses around compound operands, but it does allow a
 *   `WITH` clause inside a FROM-subquery, so each operand is wrapped as
 *   `SELECT * FROM (SELECT ...)`. This keeps every leaf's CTEs (traversals,
 *   vector/fulltext joins, recursive expansions) scoped to its own subquery
 *   and lets per-leaf ORDER BY/LIMIT/OFFSET live inside the wrap.
 *
 * Nested set operations are wrapped the same way, which preserves the AST's
 * grouping regardless of the dialect's native compound-operator associativity.
 */
import { type SQL, sql } from "drizzle-orm";

import {
  CompilerInvariantError,
  UnsupportedPredicateError,
} from "../../errors";
import type { SetOperationType } from "../ast";
import {
  type ComposableQuery,
  type FieldRef,
  type ProjectedField,
  type Projection,
  type QueryAst,
  type SetOperation,
} from "../ast";
import { type DialectAdapter, type VectorStrategy } from "../dialect";
import { type JsonPointer, jsonPointer } from "../json-pointer";
import { emitSetOperationQuerySql } from "./emitter";
import { runCompilerPass } from "./passes";
import { type LogicalPlan, lowerSetOperationToLogicalPlan } from "./plan";

/**
 * Type for the query compiler function.
 */
export type QueryCompilerFunction = (ast: QueryAst, graphId: string) => SQL;

/**
 * Operator mapping for set operations.
 */
const OPERATOR_MAP: Record<SetOperationType, string> = {
  union: "UNION",
  unionAll: "UNION ALL",
  intersect: "INTERSECT",
  except: "EXCEPT",
};

type SetOperationPassState = Readonly<{
  dialect: DialectAdapter;
  graphId: string;
  logicalPlan: LogicalPlan | undefined;
  op: SetOperation;
}>;

function runSetOperationPassPipeline(
  op: SetOperation,
  graphId: string,
  dialect: DialectAdapter,
  vectorStrategy: VectorStrategy | undefined,
): SetOperationPassState {
  let state: SetOperationPassState = {
    dialect,
    graphId,
    logicalPlan: undefined,
    op,
  };

  const logicalPlanPass = runCompilerPass(state, {
    name: "logical_plan",
    execute(currentState): LogicalPlan {
      return lowerSetOperationToLogicalPlan({
        dialect: currentState.dialect.name,
        graphId: currentState.graphId,
        op: currentState.op,
        ...(vectorStrategy === undefined ? {} : { vectorStrategy }),
      });
    },
    update(currentState, logicalPlan): SetOperationPassState {
      return {
        ...currentState,
        logicalPlan,
      };
    },
  });
  state = logicalPlanPass.state;

  return state;
}

// ============================================================
// Main Entry Point
// ============================================================

/**
 * Compiles a set operation to SQL.
 *
 * Each leaf is compiled by the full query compiler, so set operations support
 * exactly the same query features as standalone queries (traversals, EXISTS/IN
 * subqueries, vector/fulltext predicates, GROUP BY/HAVING, and per-leaf
 * ORDER BY/LIMIT/OFFSET) on every dialect.
 *
 * @param op - The set operation AST
 * @param graphId - The graph ID
 * @param dialect - The dialect adapter
 * @param compileQuery - Function to compile regular (leaf) queries
 * @param vectorStrategy - The backend-configured vector strategy, if any, used
 *   to validate leaf vector predicates against the strategy's metric set
 * @returns SQL for the set operation
 */
export function compileSetOperation(
  op: SetOperation,
  graphId: string,
  dialect: DialectAdapter,
  compileQuery: QueryCompilerFunction,
  vectorStrategy?: VectorStrategy,
): SQL {
  const passState = runSetOperationPassPipeline(
    op,
    graphId,
    dialect,
    vectorStrategy,
  );
  const { logicalPlan } = passState;
  if (logicalPlan === undefined) {
    throw new CompilerInvariantError(
      "Logical plan pass did not initialize plan state",
    );
  }

  const coreSql = compileSetOperationCore(op, graphId, compileQuery, dialect);

  const suffixClauses = buildSetOperationSuffixClauses(op, dialect);
  return emitSetOperationQuerySql({
    baseQuery: coreSql,
    logicalPlan,
    ...(suffixClauses.length === 0 ? {} : { suffixClauses }),
  });
}

/**
 * Compiles a set operation node into a compound SELECT by wrapping each side
 * with the dialect's operand wrapper and joining them with the operator.
 */
function compileSetOperationCore(
  op: SetOperation,
  graphId: string,
  compileQuery: QueryCompilerFunction,
  dialect: DialectAdapter,
): SQL {
  const left = compileComposableQuery(op.left, graphId, compileQuery, dialect);
  const right = compileComposableQuery(
    op.right,
    graphId,
    compileQuery,
    dialect,
  );

  const opSql = sql.raw(OPERATOR_MAP[op.operator]);

  return sql`${dialect.wrapSetOperationOperand(left)} ${opSql} ${dialect.wrapSetOperationOperand(right)}`;
}

/**
 * Compiles a composable query operand. Leaves are compiled by the full query
 * compiler; nested set operations recurse into a complete compound SELECT
 * (including their own ORDER BY/LIMIT/OFFSET) before the parent wraps them.
 */
function compileComposableQuery(
  query: ComposableQuery,
  graphId: string,
  compileQuery: QueryCompilerFunction,
  dialect: DialectAdapter,
): SQL {
  if ("__type" in query) {
    return compileSetOperationCompound(query, graphId, compileQuery, dialect);
  }
  return compileQuery(query, graphId);
}

/**
 * Compiles a set operation into a complete compound SELECT, including its own
 * ORDER BY/LIMIT/OFFSET suffix clauses. Used for nested operands: a nested
 * compound carries suffix clauses that belong inside the operand, not on the
 * outer statement. The top-level entry (compileSetOperation) layers the
 * logical-plan emitter invariant on top of these same core + suffix clauses.
 */
function compileSetOperationCompound(
  op: SetOperation,
  graphId: string,
  compileQuery: QueryCompilerFunction,
  dialect: DialectAdapter,
): SQL {
  const core = compileSetOperationCore(op, graphId, compileQuery, dialect);
  const suffixClauses = buildSetOperationSuffixClauses(op, dialect);
  if (suffixClauses.length === 0) return core;
  return sql.join([core, ...suffixClauses], sql` `);
}

// ============================================================
// Suffix Clauses (ORDER BY / LIMIT / OFFSET)
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
 * Builds ORDER BY, LIMIT, OFFSET clauses for set operations.
 *
 * For set operations, ORDER BY must reference output column names from
 * the compound result, not internal CTE columns. This function:
 * 1. Maps each ORDER BY field to its output name from the leftmost projection
 * 2. Uses IS NULL emulation for consistent NULLS FIRST/LAST across dialects
 * 3. Throws a descriptive error if an ORDER BY field isn't in the projection
 */
function buildSetOperationSuffixClauses(
  op: SetOperation,
  dialect: DialectAdapter,
): SQL[] {
  const clauses: SQL[] = [];

  // Handle ORDER BY if present
  if (op.orderBy && op.orderBy.length > 0) {
    const projection = getLeftmostProjection(op);

    // Check for SELECT * (empty projection) - can't order by named columns
    if (projection.fields.length === 0) {
      throw new UnsupportedPredicateError(
        "Set operation ORDER BY requires explicit field projection. " +
          "SELECT * does not provide stable output column names for ordering. " +
          "Use .select() to specify which fields to project.",
      );
    }

    const orderParts: SQL[] = [];

    for (const orderSpec of op.orderBy) {
      const projected = matchFieldToProjection(orderSpec.field, projection);

      if (!projected) {
        // Build a descriptive error message
        const fieldDesc =
          orderSpec.field.jsonPointer ?
            `${orderSpec.field.alias}.props${orderSpec.field.jsonPointer}`
          : `${orderSpec.field.alias}.${orderSpec.field.path.join(".")}`;
        const availableFields = projection.fields
          .map((f) => f.outputName)
          .join(", ");
        throw new UnsupportedPredicateError(
          `Set operation ORDER BY field "${fieldDesc}" is not in the projection. ` +
            `ORDER BY for UNION/INTERSECT/EXCEPT must reference projected columns. ` +
            `Available columns: ${availableFields}`,
        );
      }

      // Use output column name with proper quoting
      const columnRef = sql.raw(dialect.quoteIdentifier(projected.outputName));
      const dir = sql.raw(orderSpec.direction.toUpperCase());

      // Handle nulls with IS NULL emulation for cross-dialect consistency
      // Default: ASC → NULLS LAST, DESC → NULLS FIRST
      const nulls =
        orderSpec.nulls ?? (orderSpec.direction === "asc" ? "last" : "first");
      const nullsDir = sql.raw(nulls === "first" ? "DESC" : "ASC");

      // Emulate NULLS FIRST/LAST: (col IS NULL) ASC/DESC, col DIR
      orderParts.push(
        sql`(${columnRef} IS NULL) ${nullsDir}`,
        sql`${columnRef} ${dir}`,
      );
    }

    clauses.push(sql`ORDER BY ${sql.join(orderParts, sql`, `)}`);
  }

  // Handle LIMIT
  if (op.limit !== undefined) {
    clauses.push(sql`LIMIT ${op.limit}`);
  }

  // Handle OFFSET
  if (op.offset !== undefined) {
    clauses.push(sql`OFFSET ${op.offset}`);
  }

  return clauses;
}
