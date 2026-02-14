/**
 * Recursive CTE Compilation
 *
 * Compiles variable-length path traversals using WITH RECURSIVE.
 * Handles cycle detection and depth limiting using dialect-specific operations.
 */
import { type SQL, sql } from "drizzle-orm";

import { UnsupportedPredicateError } from "../../errors";
import {
  type FieldRef,
  type QueryAst,
  type SelectiveField,
  type Traversal,
  type VariableLengthSpec,
} from "../ast";
import { type DialectAdapter } from "../dialect";
import { jsonPointer } from "../json-pointer";
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
 * Maximum depth for recursive CTE queries when maxDepth is unlimited (-1).
 *
 * This default limit prevents runaway recursion for unbounded traversals while
 * still supporting typical neighborhood/path use-cases.
 */
export const MAX_RECURSIVE_DEPTH = 100;

/**
 * Maximum depth for explicit maxDepth traversals.
 *
 * Explicit traversal bounds are opt-in and safe to allow at a higher ceiling
 * for stress testing and long-path workloads.
 */
export const MAX_EXPLICIT_RECURSIVE_DEPTH = 1000;

const NODE_COLUMNS = [
  "id",
  "kind",
  "props",
  "version",
  "valid_from",
  "valid_to",
  "created_at",
  "updated_at",
  "deleted_at",
] as const;

type RequiredColumnsByAlias = ReadonlyMap<string, ReadonlySet<string>>;
const EMPTY_REQUIRED_COLUMNS = new Set<string>();
const NO_ALWAYS_REQUIRED_COLUMNS = new Set<string>();

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

  const requiredColumnsByAlias = collectRequiredColumnsByAlias(
    ast,
    vlTraversal,
  );

  // Build the recursive CTE
  const recursiveCte = compileRecursiveCte(
    ast,
    vlTraversal,
    graphId,
    ctx,
    requiredColumnsByAlias,
  );

  // Build projection
  const projection = compileRecursiveProjection(ast, vlTraversal, dialect);

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
  requiredColumnsByAlias: RequiredColumnsByAlias | undefined,
): SQL {
  const { dialect } = ctx;
  const startAlias = ast.start.alias;
  const startKinds = ast.start.kinds;
  const nodeAlias = traversal.nodeAlias;
  const directEdgeKinds = [...new Set(traversal.edgeKinds)];
  const inverseEdgeKinds =
    traversal.inverseEdgeKinds === undefined ?
      []
    : [...new Set(traversal.inverseEdgeKinds)];
  const nodeKinds = traversal.nodeKinds;
  const previousNodeKinds = [...new Set([...startKinds, ...nodeKinds])];
  const direction = traversal.direction;
  const vl = traversal.variableLength;
  const shouldEnforceCycleCheck = !(vl.maxDepth > 0 && !vl.collectPath);
  const shouldTrackPath = shouldEnforceCycleCheck || vl.collectPath;
  const recursiveJoinRequiredColumns = new Set<string>(["id"]);
  if (previousNodeKinds.length > 1) {
    recursiveJoinRequiredColumns.add("kind");
  }
  const requiredStartColumns =
    requiredColumnsByAlias ?
      (requiredColumnsByAlias.get(startAlias) ?? EMPTY_REQUIRED_COLUMNS)
    : undefined;
  const requiredNodeColumns =
    requiredColumnsByAlias ?
      (requiredColumnsByAlias.get(nodeAlias) ?? EMPTY_REQUIRED_COLUMNS)
    : undefined;
  const startColumnsFromBase = compileNodeSelectColumnsFromTable(
    "n0",
    startAlias,
    requiredStartColumns,
    NO_ALWAYS_REQUIRED_COLUMNS,
  );
  const startColumnsFromRecursive = compileNodeSelectColumnsFromRecursiveRow(
    startAlias,
    requiredStartColumns,
    NO_ALWAYS_REQUIRED_COLUMNS,
  );
  const nodeColumnsFromBase = compileNodeSelectColumnsFromTable(
    "n0",
    nodeAlias,
    requiredNodeColumns,
    recursiveJoinRequiredColumns,
  );
  const nodeColumnsFromRecursive = compileNodeSelectColumnsFromTable(
    "n",
    nodeAlias,
    requiredNodeColumns,
    recursiveJoinRequiredColumns,
  );

  const startKindFilter = compileKindFilter(startKinds, "n0.kind");
  const nodeKindFilter = compileKindFilter(nodeKinds, "n.kind");

  const startTemporalFilter = compileTemporalFilter(
    extractTemporalOptions(ast, "n0"),
  );
  const edgeTemporalFilter = compileTemporalFilter(
    extractTemporalOptions(ast, "e"),
  );
  const nodeTemporalFilter = compileTemporalFilter(
    extractTemporalOptions(ast, "n"),
  );

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

  // Max depth condition:
  // - unlimited traversals are capped at MAX_RECURSIVE_DEPTH
  // - explicit maxDepth traversals are capped at MAX_EXPLICIT_RECURSIVE_DEPTH
  const effectiveMaxDepth =
    vl.maxDepth > 0 ?
      Math.min(vl.maxDepth, MAX_EXPLICIT_RECURSIVE_DEPTH)
    : MAX_RECURSIVE_DEPTH;
  const maxDepthCondition = sql`r.depth < ${effectiveMaxDepth}`;

  const cycleCheck =
    shouldEnforceCycleCheck ?
      dialect.cycleCheck(sql.raw("n.id"), sql.raw("r.path"))
    : undefined;
  const initialPath =
    shouldTrackPath ? dialect.initializePath(sql.raw("n0.id")) : undefined;
  const pathExtension =
    shouldTrackPath ?
      dialect.extendPath(sql.raw("r.path"), sql.raw("n.id"))
    : undefined;

  // Base case WHERE clauses
  const baseWhereClauses = [
    sql`n0.graph_id = ${graphId}`,
    startKindFilter,
    startTemporalFilter,
    ...startPredicates,
  ];

  const recursiveBaseWhereClauses: SQL[] = [
    sql`e.graph_id = ${graphId}`,
    nodeKindFilter,
    edgeTemporalFilter,
    nodeTemporalFilter,
    maxDepthCondition,
  ];
  if (cycleCheck !== undefined) {
    recursiveBaseWhereClauses.push(cycleCheck);
  }
  recursiveBaseWhereClauses.push(...edgePredicates, ...targetNodePredicates);

  function compileRecursiveBranch(
    branch: Readonly<{
      joinField: "from_id" | "to_id";
      targetField: "from_id" | "to_id";
      joinKindField: "from_kind" | "to_kind";
      targetKindField: "from_kind" | "to_kind";
      edgeKinds: readonly string[];
      duplicateGuard?: SQL | undefined;
    }>,
  ): SQL {
    const recursiveWhereClauses = [
      ...recursiveBaseWhereClauses,
      compileKindFilter(branch.edgeKinds, "e.kind"),
      compileKindFilter(previousNodeKinds, `e.${branch.joinKindField}`),
      compileKindFilter(nodeKinds, `e.${branch.targetKindField}`),
    ];

    if (branch.duplicateGuard !== undefined) {
      recursiveWhereClauses.push(branch.duplicateGuard);
    }

    const recursiveSelectColumns = [
      ...startColumnsFromRecursive,
      ...nodeColumnsFromRecursive,
      sql`r.depth + 1 AS depth`,
    ];
    if (pathExtension !== undefined) {
      recursiveSelectColumns.push(sql`${pathExtension} AS path`);
    }
    const recursiveJoinClauses: SQL[] = [
      sql`e.${sql.raw(branch.joinField)} = r.${sql.raw(nodeAlias)}_id`,
    ];
    if (previousNodeKinds.length > 1) {
      recursiveJoinClauses.push(
        sql`e.${sql.raw(branch.joinKindField)} = r.${sql.raw(nodeAlias)}_kind`,
      );
    }

    return sql`
      SELECT ${sql.join(recursiveSelectColumns, sql`, `)}
      FROM recursive_cte r
      JOIN ${ctx.schema.edgesTable} e ON ${sql.join(recursiveJoinClauses, sql` AND `)}
      JOIN ${ctx.schema.nodesTable} n ON n.graph_id = e.graph_id
        AND n.id = e.${sql.raw(branch.targetField)}
        AND n.kind = e.${sql.raw(branch.targetKindField)}
      WHERE ${sql.join(recursiveWhereClauses, sql` AND `)}
    `;
  }

  const directJoinField = direction === "out" ? "from_id" : "to_id";
  const directTargetField = direction === "out" ? "to_id" : "from_id";
  const directJoinKindField = direction === "out" ? "from_kind" : "to_kind";
  const directTargetKindField = direction === "out" ? "to_kind" : "from_kind";

  const directBranch = compileRecursiveBranch({
    joinField: directJoinField,
    targetField: directTargetField,
    joinKindField: directJoinKindField,
    targetKindField: directTargetKindField,
    edgeKinds: directEdgeKinds,
  });

  function compileInverseRecursiveBranch(): SQL {
    const inverseJoinField = direction === "out" ? "to_id" : "from_id";
    const inverseTargetField = direction === "out" ? "from_id" : "to_id";
    const inverseJoinKindField = direction === "out" ? "to_kind" : "from_kind";
    const inverseTargetKindField =
      direction === "out" ? "from_kind" : "to_kind";
    const overlappingKinds = inverseEdgeKinds.filter((kind) =>
      directEdgeKinds.includes(kind),
    );

    const duplicateGuard =
      overlappingKinds.length > 0 ?
        sql`NOT (e.from_id = e.to_id AND ${compileKindFilter(overlappingKinds, "e.kind")})`
      : undefined;

    const inverseBranch = compileRecursiveBranch({
      joinField: inverseJoinField,
      targetField: inverseTargetField,
      joinKindField: inverseJoinKindField,
      targetKindField: inverseTargetKindField,
      edgeKinds: inverseEdgeKinds,
      duplicateGuard,
    });

    return sql`
      ${directBranch}
      UNION ALL
      ${inverseBranch}
    `;
  }

  const recursiveBranchSql =
    inverseEdgeKinds.length === 0 ?
      directBranch
    : compileInverseRecursiveBranch();
  const baseSelectColumns = [
    ...startColumnsFromBase,
    ...nodeColumnsFromBase,
    sql`0 AS depth`,
  ];
  if (initialPath !== undefined) {
    baseSelectColumns.push(sql`${initialPath} AS path`);
  }

  return sql`
    recursive_cte AS (
      -- Base case: starting nodes
      SELECT ${sql.join(baseSelectColumns, sql`, `)}
      FROM ${ctx.schema.nodesTable} n0
      WHERE ${sql.join(baseWhereClauses, sql` AND `)}

      UNION ALL

      -- Recursive case: follow edges
      ${recursiveBranchSql}
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

function addRequiredColumn(
  requiredColumnsByAlias: Map<string, Set<string>>,
  alias: string,
  column: string,
): void {
  const existing = requiredColumnsByAlias.get(alias);
  if (existing !== undefined) {
    existing.add(column);
    return;
  }
  requiredColumnsByAlias.set(alias, new Set([column]));
}

function markFieldRefAsRequired(
  requiredColumnsByAlias: Map<string, Set<string>>,
  field: FieldRef,
): void {
  const column = field.path[0];
  if (column === undefined) {
    return;
  }
  addRequiredColumn(requiredColumnsByAlias, field.alias, column);
}

function markSelectiveFieldAsRequired(
  requiredColumnsByAlias: Map<string, Set<string>>,
  field: SelectiveField,
): void {
  if (field.isSystemField) {
    addRequiredColumn(
      requiredColumnsByAlias,
      field.alias,
      mapSelectiveSystemFieldToColumn(field.field),
    );
    return;
  }
  addRequiredColumn(requiredColumnsByAlias, field.alias, "props");
}

function collectRequiredColumnsByAlias(
  ast: QueryAst,
  traversal: VariableLengthTraversal,
): RequiredColumnsByAlias | undefined {
  const selectiveFields = ast.selectiveFields;
  if (selectiveFields === undefined || selectiveFields.length === 0) {
    return undefined;
  }

  const requiredColumnsByAlias = new Map<string, Set<string>>();
  const previousNodeKinds = [
    ...new Set([...ast.start.kinds, ...traversal.nodeKinds]),
  ];

  // Recursive expansion always needs node alias id for joins/cycle checks.
  addRequiredColumn(requiredColumnsByAlias, traversal.nodeAlias, "id");
  if (previousNodeKinds.length > 1) {
    addRequiredColumn(requiredColumnsByAlias, traversal.nodeAlias, "kind");
  }

  for (const field of selectiveFields) {
    markSelectiveFieldAsRequired(requiredColumnsByAlias, field);
  }

  if (ast.orderBy) {
    for (const orderSpec of ast.orderBy) {
      markFieldRefAsRequired(requiredColumnsByAlias, orderSpec.field);
    }
  }

  return requiredColumnsByAlias;
}

function shouldProjectNodeColumn(
  requiredColumns: ReadonlySet<string> | undefined,
  alwaysRequiredColumns: ReadonlySet<string>,
  column: string,
): boolean {
  if (alwaysRequiredColumns.has(column)) {
    return true;
  }
  if (requiredColumns === undefined) {
    return true;
  }
  return requiredColumns.has(column);
}

function compileNodeSelectColumnsFromTable(
  tableAlias: string,
  alias: string,
  requiredColumns: ReadonlySet<string> | undefined,
  alwaysRequiredColumns: ReadonlySet<string>,
): SQL[] {
  return NODE_COLUMNS.filter((column) =>
    shouldProjectNodeColumn(requiredColumns, alwaysRequiredColumns, column),
  ).map(
    (column) =>
      sql`${sql.raw(tableAlias)}.${sql.raw(column)} AS ${sql.raw(`${alias}_${column}`)}`,
  );
}

function compileNodeSelectColumnsFromRecursiveRow(
  alias: string,
  requiredColumns: ReadonlySet<string> | undefined,
  alwaysRequiredColumns: ReadonlySet<string>,
): SQL[] {
  return NODE_COLUMNS.filter((column) =>
    shouldProjectNodeColumn(requiredColumns, alwaysRequiredColumns, column),
  ).map((column) => {
    const projected = `${alias}_${column}`;
    return sql`r.${sql.raw(projected)} AS ${sql.raw(projected)}`;
  });
}

/**
 * Compiles projection for recursive query results.
 */
function compileRecursiveProjection(
  ast: QueryAst,
  traversal: VariableLengthTraversal,
  dialect: DialectAdapter,
): SQL {
  if (ast.selectiveFields && ast.selectiveFields.length > 0) {
    return compileRecursiveSelectiveProjection(
      ast.selectiveFields,
      ast,
      traversal,
      dialect,
    );
  }

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

function quoteIdentifier(identifier: string): SQL {
  return sql.raw(`"${identifier.replaceAll('"', '""')}"`);
}

function mapSelectiveSystemFieldToColumn(field: string): string {
  if (field === "fromId") {
    return "from_id";
  }
  if (field === "toId") {
    return "to_id";
  }
  if (field.startsWith("meta.")) {
    return field
      .slice(5)
      .replaceAll(/([A-Z])/g, "_$1")
      .toLowerCase();
  }
  return field;
}

function compileSelectiveJsonValue(
  dialect: DialectAdapter,
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

function compileRecursiveSelectiveProjection(
  fields: readonly SelectiveField[],
  ast: QueryAst,
  traversal: VariableLengthTraversal,
  dialect: DialectAdapter,
): SQL {
  const allowedAliases = new Set([ast.start.alias, traversal.nodeAlias]);

  return sql.join(
    fields.map((field) => {
      if (!allowedAliases.has(field.alias)) {
        throw new UnsupportedPredicateError(
          `Selective projection for recursive traversals does not support alias "${field.alias}"`,
        );
      }

      if (field.isSystemField) {
        const dbColumn = mapSelectiveSystemFieldToColumn(field.field);
        return sql`${sql.raw(`${field.alias}_${dbColumn}`)} AS ${quoteIdentifier(field.outputName)}`;
      }

      const column = sql.raw(`${field.alias}_props`);
      const extracted = compileSelectiveJsonValue(
        dialect,
        column,
        jsonPointer([field.field]),
        field.valueType,
      );
      return sql`${extracted} AS ${quoteIdentifier(field.outputName)}`;
    }),
    sql`, `,
  );
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
