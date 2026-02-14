import { type SQL, sql } from "drizzle-orm";

import { UnsupportedPredicateError } from "../../../errors";
import {
  type AggregateExpr,
  type FieldRef,
  type QueryAst,
  type SelectiveField,
  type VectorSimilarityPredicate,
} from "../../ast";
import { type DialectAdapter } from "../../dialect";
import { jsonPointer } from "../../json-pointer";
import { type TemporalFilterPass } from "../passes";
import {
  compileKindFilter,
  compilePredicateClauses,
  getNodeKindsForAlias,
  getPredicatesForAlias,
  type PredicateIndex,
} from "../predicate-utils";
import {
  compileFieldValue,
  compilePredicateExpression,
  type PredicateCompilerContext,
} from "../predicates";
import { compileTypedJsonExtract } from "../typed-json-extract";
import {
  EDGE_COLUMNS,
  EMPTY_REQUIRED_COLUMNS,
  isAggregateExpr,
  mapSelectiveSystemFieldToColumn,
  NODE_COLUMNS,
  quoteIdentifier,
  type RequiredColumnsByAlias,
  shouldProjectColumn,
} from "../utils";

export type StandardEmitterPredicateIndex = PredicateIndex;

function compileColumnReference(
  tableAlias: string | undefined,
  column: string,
): SQL {
  if (tableAlias === undefined) {
    return sql.raw(column);
  }
  return sql`${sql.raw(tableAlias)}.${sql.raw(column)}`;
}

function compileNodeSelectColumns(
  tableAlias: string | undefined,
  alias: string,
  requiredColumns: ReadonlySet<string> | undefined,
): SQL[] {
  return NODE_COLUMNS.filter(
    (column) =>
      column === "id" ||
      column === "kind" ||
      shouldProjectColumn(requiredColumns, column),
  ).map(
    (column) =>
      sql`${compileColumnReference(tableAlias, column)} AS ${sql.raw(`${alias}_${column}`)}`,
  );
}

function compileEdgeSelectColumns(
  tableAlias: string | undefined,
  alias: string,
  requiredColumns: ReadonlySet<string> | undefined,
): SQL[] {
  return EDGE_COLUMNS.filter((column) =>
    shouldProjectColumn(requiredColumns, column),
  ).map(
    (column) =>
      sql`${compileColumnReference(tableAlias, column)} AS ${sql.raw(`${alias}_${column}`)}`,
  );
}

type BuildStandardStartCteInput = Readonly<{
  ast: QueryAst;
  ctx: PredicateCompilerContext;
  graphId: string;
  predicateIndex: StandardEmitterPredicateIndex;
  requiredColumnsByAlias: RequiredColumnsByAlias | undefined;
  temporalFilterPass: TemporalFilterPass;
}>;

export function buildStandardStartCte(input: BuildStandardStartCteInput): SQL {
  const { ast, ctx, graphId, predicateIndex, requiredColumnsByAlias } = input;
  const alias = ast.start.alias;
  const kinds = ast.start.kinds;

  const kindFilter = compileKindFilter(sql.raw("kind"), kinds);
  const temporalFilter = input.temporalFilterPass.forAlias();
  const cteContext: PredicateCompilerContext = { ...ctx, cteColumnPrefix: "" };
  const predicateClauses = compilePredicateClauses(
    getPredicatesForAlias(predicateIndex, alias, "node"),
    cteContext,
  );

  const whereClauses = [
    sql`graph_id = ${graphId}`,
    kindFilter,
    temporalFilter,
    ...predicateClauses,
  ];

  const effectiveRequiredColumns =
    requiredColumnsByAlias ?
      (requiredColumnsByAlias.get(alias) ?? EMPTY_REQUIRED_COLUMNS)
    : undefined;

  return sql`
    cte_${sql.raw(alias)} AS (
      SELECT ${sql.join(
        compileNodeSelectColumns(undefined, alias, effectiveRequiredColumns),
        sql`, `,
      )}
      FROM ${ctx.schema.nodesTable}
      WHERE ${sql.join(whereClauses, sql` AND `)}
    )
  `;
}

type BuildStandardTraversalCteInput = Readonly<{
  ast: QueryAst;
  carryForwardPreviousColumns: boolean;
  ctx: PredicateCompilerContext;
  graphId: string;
  materializeCte: boolean;
  predicateIndex: StandardEmitterPredicateIndex;
  requiredColumnsByAlias: RequiredColumnsByAlias | undefined;
  temporalFilterPass: TemporalFilterPass;
  traversalIndex: number;
  traversalLimit: number | undefined;
}>;

export function buildStandardTraversalCte(
  input: BuildStandardTraversalCteInput,
): SQL {
  const {
    ast,
    carryForwardPreviousColumns,
    ctx,
    graphId,
    materializeCte,
    predicateIndex,
    requiredColumnsByAlias,
    temporalFilterPass,
    traversalIndex,
    traversalLimit,
  } = input;
  const traversal = ast.traversals[traversalIndex]!;
  const traversalLimitValue =
    traversalIndex === ast.traversals.length - 1 ? traversalLimit : undefined;

  const previousNodeKinds = getNodeKindsForAlias(ast, traversal.joinFromAlias);
  const directEdgeKinds = [...new Set(traversal.edgeKinds)];
  const inverseEdgeKinds =
    traversal.inverseEdgeKinds === undefined ?
      []
    : [...new Set(traversal.inverseEdgeKinds)];

  const nodeKinds = traversal.nodeKinds;
  const nodeKindFilter = compileKindFilter(sql.raw("n.kind"), nodeKinds);

  const edgeTemporalFilter = temporalFilterPass.forAlias("e");
  const nodeTemporalFilter = temporalFilterPass.forAlias("n");

  const nodeCteContext: PredicateCompilerContext = {
    ...ctx,
    cteColumnPrefix: "n",
  };
  const nodePredicateClauses = compilePredicateClauses(
    getPredicatesForAlias(predicateIndex, traversal.nodeAlias, "node"),
    nodeCteContext,
  );

  const edgeCteContext: PredicateCompilerContext = {
    ...ctx,
    cteColumnPrefix: "e",
  };
  const edgePredicateClauses = compilePredicateClauses(
    getPredicatesForAlias(predicateIndex, traversal.edgeAlias, "edge"),
    edgeCteContext,
  );

  const baseWhereClauses = [
    sql`e.graph_id = ${graphId}`,
    nodeKindFilter,
    edgeTemporalFilter,
    nodeTemporalFilter,
    ...nodePredicateClauses,
    ...edgePredicateClauses,
  ];

  const previousAlias = traversal.joinFromAlias;
  const edgeAlias = traversal.edgeAlias;
  const nodeAlias = traversal.nodeAlias;
  const requiredNodeColumns =
    requiredColumnsByAlias ?
      (requiredColumnsByAlias.get(nodeAlias) ?? EMPTY_REQUIRED_COLUMNS)
    : undefined;
  const requiredEdgeColumns =
    requiredColumnsByAlias ?
      (requiredColumnsByAlias.get(edgeAlias) ?? EMPTY_REQUIRED_COLUMNS)
    : undefined;
  const previousRowColumns =
    carryForwardPreviousColumns ?
      [sql`cte_${sql.raw(previousAlias)}.*`]
    : [
        sql`cte_${sql.raw(previousAlias)}.${sql.raw(previousAlias)}_id AS ${sql.raw(previousAlias)}_id`,
        sql`cte_${sql.raw(previousAlias)}.${sql.raw(previousAlias)}_kind AS ${sql.raw(previousAlias)}_kind`,
      ];
  const selectColumns = [
    ...previousRowColumns,
    ...compileEdgeSelectColumns("e", edgeAlias, requiredEdgeColumns),
    ...compileNodeSelectColumns("n", nodeAlias, requiredNodeColumns),
  ];
  const cteMaterialization = materializeCte ? sql`MATERIALIZED ` : sql``;

  function compileTraversalBranch(
    branch: Readonly<{
      duplicateGuard?: SQL | undefined;
      edgeKinds: readonly string[];
      joinField: "from_id" | "to_id";
      joinKindField: "from_kind" | "to_kind";
      targetField: "from_id" | "to_id";
      targetKindField: "from_kind" | "to_kind";
    }>,
  ): SQL {
    const whereClauses = [
      ...baseWhereClauses,
      compileKindFilter(sql.raw("e.kind"), branch.edgeKinds),
      compileKindFilter(
        sql.raw(`e.${branch.joinKindField}`),
        previousNodeKinds,
      ),
      compileKindFilter(sql.raw(`e.${branch.targetKindField}`), nodeKinds),
    ];

    if (branch.duplicateGuard !== undefined) {
      whereClauses.push(branch.duplicateGuard);
    }

    return sql`
      SELECT ${sql.join(selectColumns, sql`, `)}
      FROM cte_${sql.raw(previousAlias)}
      JOIN ${ctx.schema.edgesTable} e ON cte_${sql.raw(previousAlias)}.${sql.raw(previousAlias)}_id = e.${sql.raw(branch.joinField)}
        AND cte_${sql.raw(previousAlias)}.${sql.raw(previousAlias)}_kind = e.${sql.raw(branch.joinKindField)}
      JOIN ${ctx.schema.nodesTable} n ON n.graph_id = e.graph_id
        AND n.id = e.${sql.raw(branch.targetField)}
        AND n.kind = e.${sql.raw(branch.targetKindField)}
      WHERE ${sql.join(whereClauses, sql` AND `)}
    `;
  }

  const directJoinField = traversal.direction === "out" ? "from_id" : "to_id";
  const directTargetField = traversal.direction === "out" ? "to_id" : "from_id";
  const directJoinKindField =
    traversal.direction === "out" ? "from_kind" : "to_kind";
  const directTargetKindField =
    traversal.direction === "out" ? "to_kind" : "from_kind";

  const directBranch = compileTraversalBranch({
    edgeKinds: directEdgeKinds,
    joinField: directJoinField,
    joinKindField: directJoinKindField,
    targetField: directTargetField,
    targetKindField: directTargetKindField,
  });

  if (inverseEdgeKinds.length === 0) {
    if (traversalLimitValue !== undefined) {
      return sql`
        cte_${sql.raw(nodeAlias)} AS ${cteMaterialization}(
          SELECT * FROM (
            ${directBranch}
          ) AS traversal_rows
          LIMIT ${traversalLimitValue}
        )
      `;
    }

    return sql`
      cte_${sql.raw(nodeAlias)} AS ${cteMaterialization}(
        ${directBranch}
      )
    `;
  }

  const inverseJoinField = traversal.direction === "out" ? "to_id" : "from_id";
  const inverseTargetField =
    traversal.direction === "out" ? "from_id" : "to_id";
  const inverseJoinKindField =
    traversal.direction === "out" ? "to_kind" : "from_kind";
  const inverseTargetKindField =
    traversal.direction === "out" ? "from_kind" : "to_kind";

  const overlappingKinds = inverseEdgeKinds.filter((kind) =>
    directEdgeKinds.includes(kind),
  );

  const duplicateGuard =
    overlappingKinds.length > 0 ?
      sql`NOT (e.from_id = e.to_id AND ${compileKindFilter(
        sql.raw("e.kind"),
        overlappingKinds,
      )})`
    : undefined;

  const inverseBranch = compileTraversalBranch({
    duplicateGuard,
    edgeKinds: inverseEdgeKinds,
    joinField: inverseJoinField,
    joinKindField: inverseJoinKindField,
    targetField: inverseTargetField,
    targetKindField: inverseTargetKindField,
  });

  if (traversalLimitValue !== undefined) {
    return sql`
      cte_${sql.raw(nodeAlias)} AS ${cteMaterialization}(
        SELECT * FROM (
          ${directBranch}
          UNION ALL
          ${inverseBranch}
        ) AS traversal_rows
        LIMIT ${traversalLimitValue}
      )
    `;
  }

  return sql`
    cte_${sql.raw(nodeAlias)} AS ${cteMaterialization}(
      ${directBranch}
      UNION ALL
      ${inverseBranch}
    )
  `;
}

function compileAggregateExprFromSource(
  expr: AggregateExpr,
  dialect: DialectAdapter,
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

function compileProjectedSource(
  field: {
    cteAlias?: string;
    source: FieldRef | AggregateExpr;
  },
  dialect: DialectAdapter,
): SQL {
  if (isAggregateExpr(field.source)) {
    return compileAggregateExprFromSource(field.source, dialect);
  }
  const cteAlias = field.cteAlias ?? `cte_${field.source.alias}`;
  return compileFieldValue(
    field.source,
    dialect,
    field.source.valueType,
    cteAlias,
  );
}

type BuildStandardProjectionInput = Readonly<{
  ast: QueryAst;
  collapsedTraversalCteAlias?: string;
  dialect: DialectAdapter;
}>;

export function buildStandardProjection(
  input: BuildStandardProjectionInput,
): SQL {
  const { ast, collapsedTraversalCteAlias, dialect } = input;
  if (ast.selectiveFields && ast.selectiveFields.length > 0) {
    return compileSelectiveProjection(
      ast.selectiveFields,
      dialect,
      ast,
      collapsedTraversalCteAlias,
    );
  }

  const fields = ast.projection.fields;
  if (fields.length === 0) {
    return sql.raw("*");
  }

  const projectedFields = fields.map((field) => {
    const source = compileProjectedSource(field, dialect);
    return sql`${source} AS ${quoteIdentifier(field.outputName)}`;
  });
  return sql.join(projectedFields, sql`, `);
}

function compileSelectiveProjection(
  fields: readonly SelectiveField[],
  dialect: DialectAdapter,
  ast: QueryAst,
  collapsedTraversalCteAlias?: string,
): SQL {
  const aliasToCte = new Map<string, string>([
    [ast.start.alias, `cte_${ast.start.alias}`],
  ]);

  for (const traversal of ast.traversals) {
    aliasToCte.set(traversal.nodeAlias, `cte_${traversal.nodeAlias}`);
    aliasToCte.set(traversal.edgeAlias, `cte_${traversal.nodeAlias}`);
  }

  const columns = fields.map((field) => {
    const cteAlias =
      collapsedTraversalCteAlias ??
      aliasToCte.get(field.alias) ??
      `cte_${field.alias}`;

    if (field.isSystemField) {
      const dbColumn = mapSelectiveSystemFieldToColumn(field.field);

      return sql`${sql.raw(cteAlias)}.${sql.raw(`${field.alias}_${dbColumn}`)} AS ${quoteIdentifier(field.outputName)}`;
    }

    const propsColumn = `${field.alias}_props`;
    const column = sql`${sql.raw(cteAlias)}.${sql.raw(propsColumn)}`;
    const pointer = jsonPointer([field.field]);
    const extracted = compileTypedJsonExtract({
      column,
      dialect,
      pointer,
      valueType: field.valueType,
    });
    return sql`${extracted} AS ${quoteIdentifier(field.outputName)}`;
  });

  return sql.join(columns, sql`, `);
}

type BuildStandardFromClauseInput = Readonly<{
  ast: QueryAst;
  collapsedTraversalCteAlias?: string;
  vectorPredicate?: VectorSimilarityPredicate;
}>;

export function buildStandardFromClause(
  input: BuildStandardFromClauseInput,
): SQL {
  const { ast, collapsedTraversalCteAlias, vectorPredicate } = input;
  if (collapsedTraversalCteAlias !== undefined) {
    return sql`FROM ${sql.raw(collapsedTraversalCteAlias)}`;
  }

  const startAlias = ast.start.alias;
  const fromClause = sql`FROM cte_${sql.raw(startAlias)}`;

  const joins: SQL[] = [];
  for (const traversal of ast.traversals) {
    const cteAlias = `cte_${traversal.nodeAlias}`;
    const previousAlias = traversal.joinFromAlias;
    const joinType = traversal.optional ? "LEFT JOIN" : "INNER JOIN";
    joins.push(
      sql`${sql.raw(joinType)} ${sql.raw(cteAlias)} ON ${sql.raw(cteAlias)}.${sql.raw(previousAlias)}_id = cte_${sql.raw(previousAlias)}.${sql.raw(previousAlias)}_id AND ${sql.raw(cteAlias)}.${sql.raw(previousAlias)}_kind = cte_${sql.raw(previousAlias)}.${sql.raw(previousAlias)}_kind`,
    );
  }

  if (vectorPredicate) {
    const nodeAlias = vectorPredicate.field.alias;
    joins.push(
      sql`INNER JOIN cte_embeddings ON cte_embeddings.node_id = cte_${sql.raw(nodeAlias)}.${sql.raw(nodeAlias)}_id`,
    );
  }

  return joins.length === 0 ?
      fromClause
    : sql`${fromClause} ${sql.join(joins, sql` `)}`;
}

type BuildStandardOrderByInput = Readonly<{
  ast: QueryAst;
  collapsedTraversalCteAlias?: string;
  dialect: DialectAdapter;
}>;

export function buildStandardOrderBy(
  input: BuildStandardOrderByInput,
): SQL | undefined {
  const { ast, collapsedTraversalCteAlias, dialect } = input;
  if (!ast.orderBy || ast.orderBy.length === 0) {
    return undefined;
  }

  const parts: SQL[] = [];
  for (const orderSpec of ast.orderBy) {
    const valueType = orderSpec.field.valueType;
    if (valueType === "array" || valueType === "object") {
      throw new UnsupportedPredicateError(
        "Ordering by JSON arrays or objects is not supported",
      );
    }
    const cteAlias =
      collapsedTraversalCteAlias ?? `cte_${orderSpec.field.alias}`;
    const field = compileFieldValue(
      orderSpec.field,
      dialect,
      valueType,
      cteAlias,
    );
    const direction = sql.raw(orderSpec.direction.toUpperCase());
    const nulls =
      orderSpec.nulls ?? (orderSpec.direction === "asc" ? "last" : "first");
    const nullsDirection = sql.raw(nulls === "first" ? "DESC" : "ASC");
    parts.push(
      sql`(${field} IS NULL) ${nullsDirection}`,
      sql`${field} ${direction}`,
    );
  }

  return sql`ORDER BY ${sql.join(parts, sql`, `)}`;
}

function fieldRefKey(field: FieldRef): string {
  const pointer = field.jsonPointer ?? "";
  return `${field.alias}:${field.path.join(".")}:${pointer}`;
}

type BuildStandardGroupByInput = Readonly<{
  ast: QueryAst;
  dialect: DialectAdapter;
}>;

export function buildStandardGroupBy(
  input: BuildStandardGroupByInput,
): SQL | undefined {
  const { ast, dialect } = input;
  if (!ast.groupBy || ast.groupBy.fields.length === 0) {
    return undefined;
  }

  const seenKeys = new Set<string>();
  const allFields: FieldRef[] = [];

  for (const projectedField of ast.projection.fields) {
    if (projectedField.source.__type === "field_ref") {
      const key = fieldRefKey(projectedField.source);
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        allFields.push(projectedField.source);
      }
    }
  }

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

  const parts = allFields.map((field) =>
    compileFieldValue(field, dialect, field.valueType, `cte_${field.alias}`),
  );

  return sql`GROUP BY ${sql.join(parts, sql`, `)}`;
}

type BuildStandardHavingInput = Readonly<{
  ast: QueryAst;
  ctx: PredicateCompilerContext;
}>;

export function buildStandardHaving(
  input: BuildStandardHavingInput,
): SQL | undefined {
  const { ast, ctx } = input;
  if (!ast.having) {
    return undefined;
  }

  const condition = compilePredicateExpression(ast.having, ctx);
  return sql`HAVING ${condition}`;
}

type BuildStandardEmbeddingsCteInput = Readonly<{
  ctx: PredicateCompilerContext;
  graphId: string;
  vectorPredicate: VectorSimilarityPredicate;
}>;

export function buildStandardEmbeddingsCte(
  input: BuildStandardEmbeddingsCteInput,
): SQL {
  const { ctx, graphId, vectorPredicate } = input;
  const { dialect } = ctx;
  const { field, metric, minScore, queryEmbedding } = vectorPredicate;

  const fieldPath =
    field.jsonPointer ? (field.jsonPointer as string)
    : field.path.length > 1 && field.path[0] === "props" ?
      `/${field.path.slice(1).join("/")}`
    : `/${field.path.join("/")}`;

  const distanceExpr = dialect.vectorDistance(
    sql.raw("embedding"),
    queryEmbedding,
    metric,
  );

  const conditions: SQL[] = [
    sql`graph_id = ${graphId}`,
    sql`field_path = ${fieldPath}`,
  ];

  if (minScore !== undefined) {
    // minScore validation (finiteness, cosine range) is handled by the vector
    // predicate pass in passes/vector.ts — no redundant check here.
    conditions.push(
      compileVectorMinScoreCondition(distanceExpr, metric, minScore),
    );
  }

  const scoreExpr = compileVectorScoreExpression(distanceExpr, metric);

  return sql`
    cte_embeddings AS (
      SELECT
        node_id,
        ${distanceExpr} AS distance,
        ${scoreExpr} AS score
      FROM ${ctx.schema.embeddingsTable}
      WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY ${distanceExpr} ASC
    )
  `;
}

function compileVectorScoreExpression(
  distanceExpr: SQL,
  metric: VectorSimilarityPredicate["metric"],
): SQL {
  switch (metric) {
    case "cosine": {
      return sql`(1.0 - ${distanceExpr})`;
    }
    case "l2":
    case "inner_product": {
      return distanceExpr;
    }
  }
}

function compileVectorMinScoreCondition(
  distanceExpr: SQL,
  metric: VectorSimilarityPredicate["metric"],
  minScore: number,
): SQL {
  switch (metric) {
    case "cosine": {
      const threshold = 1 - minScore;
      return sql`${distanceExpr} <= ${threshold}`;
    }
    case "l2": {
      return sql`${distanceExpr} <= ${minScore}`;
    }
    case "inner_product": {
      const negativeThreshold = -minScore;
      return sql`${distanceExpr} <= ${negativeThreshold}`;
    }
  }
}

type BuildStandardVectorOrderByInput = Readonly<{
  ast: QueryAst;
  dialect: DialectAdapter;
}>;

export function buildStandardVectorOrderBy(
  input: BuildStandardVectorOrderByInput,
): SQL {
  const { ast, dialect } = input;

  const distanceOrder = sql`cte_embeddings.distance ASC`;
  const additionalOrders: SQL[] = [];

  if (ast.orderBy && ast.orderBy.length > 0) {
    for (const orderSpec of ast.orderBy) {
      const valueType = orderSpec.field.valueType;
      if (valueType === "array" || valueType === "object") {
        throw new UnsupportedPredicateError(
          "Ordering by JSON arrays or objects is not supported",
        );
      }
      const cteAlias = `cte_${orderSpec.field.alias}`;
      const field = compileFieldValue(
        orderSpec.field,
        dialect,
        valueType,
        cteAlias,
      );
      const direction = sql.raw(orderSpec.direction.toUpperCase());
      const nulls =
        orderSpec.nulls ?? (orderSpec.direction === "asc" ? "last" : "first");
      const nullsDirection = sql.raw(nulls === "first" ? "DESC" : "ASC");
      additionalOrders.push(
        sql`(${field} IS NULL) ${nullsDirection}`,
        sql`${field} ${direction}`,
      );
    }
  }

  const allOrders = [distanceOrder, ...additionalOrders];
  return sql`ORDER BY ${sql.join(allOrders, sql`, `)}`;
}

type BuildLimitOffsetClauseInput = Readonly<{
  limit: number | undefined;
  offset: number | undefined;
}>;

export function buildLimitOffsetClause(
  input: BuildLimitOffsetClauseInput,
): SQL | undefined {
  const { limit, offset } = input;
  const parts: SQL[] = [];

  if (limit !== undefined) {
    parts.push(sql`LIMIT ${limit}`);
  }
  if (offset !== undefined) {
    parts.push(sql`OFFSET ${offset}`);
  }

  return parts.length > 0 ? sql.join(parts, sql` `) : undefined;
}
