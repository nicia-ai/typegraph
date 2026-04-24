import { type SQL, sql } from "drizzle-orm";

import { UnsupportedPredicateError } from "../../../errors";
import {
  type AggregateExpr,
  DEFAULT_RRF_K,
  DEFAULT_RRF_WEIGHT,
  type FieldRef,
  type FulltextMatchPredicate,
  type HybridFusionOptions,
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
  getHybridTargetAlias,
  getNodeKindsForAlias,
  getPredicatesForAlias,
  type PredicateIndex,
} from "../predicate-utils";
import {
  compileFieldValue,
  compilePredicateExpression,
  type PredicateCompilerContext,
} from "../predicates";
import {
  ALIAS_CTE_PREFIX,
  EMBEDDINGS_CTE_ALIAS,
  FULLTEXT_CTE_ALIAS,
  HYBRID_CANDIDATES_CTE_ALIAS,
} from "../schema";
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

function qualifyColumn(owner: string, name: string): SQL {
  return sql`${quoteIdentifier(owner)}.${quoteIdentifier(name)}`;
}

const SCOPED_RELEVANCE_NODES_ALIAS = "scoped_relevance_nodes";

function buildScopedNodeIdsSubquery(nodeAlias: string): SQL {
  const cteAlias = `${ALIAS_CTE_PREFIX}${nodeAlias}`;
  return sql`
    (
        SELECT DISTINCT
          ${qualifyColumn(cteAlias, `${nodeAlias}_id`)} AS node_id,
          ${qualifyColumn(cteAlias, `${nodeAlias}_kind`)} AS node_kind
        FROM ${quoteIdentifier(cteAlias)}
      ) AS ${sql.raw(SCOPED_RELEVANCE_NODES_ALIAS)}
  `;
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
  /**
   * Optional LIMIT/OFFSET to apply inside the start CTE. Used by the count
   * aggregate fast path to push limits past the GROUP BY when it's safe.
   */
  limitOffset?: Readonly<{ limit: number; offset?: number | undefined }>;
}>;

export function buildStandardStartCte(input: BuildStandardStartCteInput): SQL {
  const { ast, ctx, graphId, predicateIndex, requiredColumnsByAlias } = input;
  const alias = ast.start.alias;
  const kinds = ast.start.kinds;
  const cteMaterialization =
    ctx.dialect.capabilities.emitNotMaterializedHint ?
      sql`NOT MATERIALIZED `
    : sql``;

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

  const limitClause =
    input.limitOffset === undefined ? sql``
    : input.limitOffset.offset === undefined ?
      sql`
        LIMIT ${input.limitOffset.limit}
      `
    : sql`
      LIMIT ${input.limitOffset.limit} OFFSET ${input.limitOffset.offset}
    `;

  return sql`
    cte_${sql.raw(alias)} AS ${cteMaterialization}(
      SELECT ${sql.join(
        compileNodeSelectColumns(undefined, alias, effectiveRequiredColumns),
        sql`, `,
      )}
      FROM ${ctx.schema.nodesTable}
      WHERE ${sql.join(whereClauses, sql` AND `)}${limitClause}
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
  const cteMaterialization =
    materializeCte ? sql`MATERIALIZED `
    : ctx.dialect.capabilities.emitNotMaterializedHint ? sql`NOT MATERIALIZED `
    : sql``;

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
    case "count":
    case "countDistinct":
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
      if (fn === "countDistinct") {
        return sql`COUNT(DISTINCT ${column})`;
      }
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

/**
 * Builds a map from query aliases (node and edge) to their CTE table names.
 * Edge aliases map to the CTE of the traversal node they are co-projected with.
 */
function buildAliasToCteMap(ast: QueryAst): Map<string, string> {
  const map = new Map<string, string>([
    [ast.start.alias, `cte_${ast.start.alias}`],
  ]);
  for (const traversal of ast.traversals) {
    map.set(traversal.nodeAlias, `cte_${traversal.nodeAlias}`);
    map.set(traversal.edgeAlias, `cte_${traversal.nodeAlias}`);
  }
  return map;
}

function compileSelectiveProjection(
  fields: readonly SelectiveField[],
  dialect: DialectAdapter,
  ast: QueryAst,
  collapsedTraversalCteAlias?: string,
): SQL {
  const aliasToCte = buildAliasToCteMap(ast);

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

function buildRelevanceJoins(
  vectorPredicate: VectorSimilarityPredicate | undefined,
  fulltextPredicate: FulltextMatchPredicate | undefined,
): SQL[] {
  const hybridTargetAlias = getHybridTargetAlias(
    vectorPredicate,
    fulltextPredicate,
  );
  if (hybridTargetAlias !== undefined) {
    return [
      buildHybridCandidateJoin(hybridTargetAlias),
      buildRelevanceJoin(EMBEDDINGS_CTE_ALIAS, hybridTargetAlias, "LEFT JOIN"),
      buildRelevanceJoin(FULLTEXT_CTE_ALIAS, hybridTargetAlias, "LEFT JOIN"),
    ];
  }

  const joins: SQL[] = [];
  if (vectorPredicate) {
    joins.push(
      buildRelevanceJoin(EMBEDDINGS_CTE_ALIAS, vectorPredicate.field.alias),
    );
  }
  if (fulltextPredicate) {
    joins.push(
      buildRelevanceJoin(FULLTEXT_CTE_ALIAS, fulltextPredicate.field.alias),
    );
  }
  return joins;
}

function buildHybridCandidateJoin(nodeAlias: string): SQL {
  const candidateCte = sql.raw(HYBRID_CANDIDATES_CTE_ALIAS);
  const node = sql.raw(`${ALIAS_CTE_PREFIX}${nodeAlias}`);
  const idColumn = sql.raw(`${nodeAlias}_id`);
  const kindColumn = sql.raw(`${nodeAlias}_kind`);
  return sql`INNER JOIN ${candidateCte} ON ${candidateCte}.node_id = ${node}.${idColumn} AND ${candidateCte}.node_kind = ${node}.${kindColumn}`;
}

function buildRelevanceJoin(
  cteAlias: string,
  nodeAlias: string,
  joinType = "INNER JOIN",
): SQL {
  const cte = sql.raw(cteAlias);
  const node = sql.raw(`${ALIAS_CTE_PREFIX}${nodeAlias}`);
  const idColumn = sql.raw(`${nodeAlias}_id`);
  const kindColumn = sql.raw(`${nodeAlias}_kind`);
  return sql`${sql.raw(joinType)} ${cte} ON ${cte}.node_id = ${node}.${idColumn} AND ${cte}.node_kind = ${node}.${kindColumn}`;
}

type BuildStandardFromClauseInput = Readonly<{
  ast: QueryAst;
  collapsedTraversalCteAlias?: string;
  fulltextPredicate?: FulltextMatchPredicate;
  vectorPredicate?: VectorSimilarityPredicate;
}>;

export function buildStandardFromClause(
  input: BuildStandardFromClauseInput,
): SQL {
  const {
    ast,
    collapsedTraversalCteAlias,
    fulltextPredicate,
    vectorPredicate,
  } = input;
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

  // Node IDs are unique only within a kind (PK is graph_id, kind, id),
  // so the relevance-CTE joins must include node_kind. Without it,
  // polymorphic queries would cross-join on user-supplied ids shared
  // across kinds.
  for (const join of buildRelevanceJoins(vectorPredicate, fulltextPredicate)) {
    joins.push(join);
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

  const aliasToCte = buildAliasToCteMap(ast);
  const parts: SQL[] = [];
  for (const orderSpec of ast.orderBy) {
    const valueType = orderSpec.field.valueType;
    if (valueType === "array" || valueType === "object") {
      throw new UnsupportedPredicateError(
        "Ordering by JSON arrays or objects is not supported",
      );
    }
    const cteAlias =
      collapsedTraversalCteAlias ??
      aliasToCte.get(orderSpec.field.alias) ??
      `cte_${orderSpec.field.alias}`;
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

function resolveEmbeddingFieldPath(field: FieldRef): string {
  if (
    field.jsonPointer !== undefined &&
    field.jsonPointer !== "" &&
    field.jsonPointer !== "/"
  ) {
    return field.jsonPointer.replace(/^\//u, "").replaceAll("/", ".");
  }

  if (field.path[0] === "props") {
    return field.path.slice(1).join(".");
  }

  return field.path.join(".");
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

  const aliasToCte = buildAliasToCteMap(ast);
  const parts = allFields.map((field) =>
    compileFieldValue(
      field,
      dialect,
      field.valueType,
      aliasToCte.get(field.alias) ?? `cte_${field.alias}`,
    ),
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
  nodeKinds: readonly string[];
  vectorPredicate: VectorSimilarityPredicate;
}>;

export function buildStandardEmbeddingsCte(
  input: BuildStandardEmbeddingsCteInput,
): SQL {
  const { ctx, graphId, nodeKinds, vectorPredicate } = input;
  const { dialect } = ctx;
  const { field, metric, minScore, queryEmbedding } = vectorPredicate;
  const embeddingsTableName = ctx.schema.tables.embeddings;

  if (nodeKinds.length === 0) {
    throw new UnsupportedPredicateError(
      "Vector predicate must resolve to at least one node kind",
    );
  }

  const fieldPath = resolveEmbeddingFieldPath(field);

  const distanceExpr = dialect.vectorDistance(
    qualifyColumn(embeddingsTableName, "embedding"),
    queryEmbedding,
    metric,
  );
  const scopedNodes = buildScopedNodeIdsSubquery(field.alias);

  // Filter by the alias's resolved kinds so similarTo() doesn't leak
  // rank weight from other kinds that happen to embed the same field_path.
  const conditions: SQL[] = [
    sql`${qualifyColumn(embeddingsTableName, "graph_id")} = ${graphId}`,
    compileKindFilter(
      qualifyColumn(embeddingsTableName, "node_kind"),
      nodeKinds,
    ),
    sql`${qualifyColumn(embeddingsTableName, "field_path")} = ${fieldPath}`,
  ];

  if (minScore !== undefined) {
    // minScore validation (finiteness, cosine range) is handled by the vector
    // predicate pass in passes/vector.ts — no redundant check here.
    conditions.push(
      compileVectorMinScoreCondition(distanceExpr, metric, minScore),
    );
  }

  const scoreExpr = compileVectorScoreExpression(distanceExpr, metric);

  // Inner SELECT applies the predicate's k-cutoff, then ROW_NUMBER ranks
  // over that bounded set. Without the inner LIMIT, a hybrid query
  // would assign vector ordinals to every row in the embeddings table,
  // letting documents far outside the requested top-k contribute to the
  // RRF fused score and reorder final results.
  return sql`
    ${sql.raw(EMBEDDINGS_CTE_ALIAS)} AS (
      SELECT
        node_id,
        node_kind,
        distance,
        score,
        ROW_NUMBER() OVER (ORDER BY distance ASC) AS ord
      FROM (
        SELECT
          ${qualifyColumn(embeddingsTableName, "node_id")} AS node_id,
          ${qualifyColumn(embeddingsTableName, "node_kind")} AS node_kind,
          ${distanceExpr} AS distance,
          ${scoreExpr} AS score
        FROM ${ctx.schema.embeddingsTable}
        INNER JOIN ${scopedNodes}
          ON ${sql.raw(`${SCOPED_RELEVANCE_NODES_ALIAS}.node_id`)} =
             ${qualifyColumn(embeddingsTableName, "node_id")}
         AND ${sql.raw(`${SCOPED_RELEVANCE_NODES_ALIAS}.node_kind`)} =
             ${qualifyColumn(embeddingsTableName, "node_kind")}
        WHERE ${sql.join(conditions, sql` AND `)}
        ORDER BY distance ASC
        LIMIT ${vectorPredicate.limit}
      ) AS vec_inner
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

// ============================================================
// Fulltext Search CTE
// ============================================================

type BuildStandardFulltextCteInput = Readonly<{
  ctx: PredicateCompilerContext;
  fulltextPredicate: FulltextMatchPredicate;
  graphId: string;
  nodeKinds: readonly string[];
}>;

export function buildStandardFulltextCte(
  input: BuildStandardFulltextCteInput,
): SQL {
  const { ctx, fulltextPredicate, graphId, nodeKinds } = input;
  const { dialect, schema } = ctx;
  const { query, mode, language, limit, minScore } = fulltextPredicate;

  if (nodeKinds.length === 0) {
    throw new UnsupportedPredicateError(
      "Fulltext predicate must resolve to at least one node kind",
    );
  }

  const tableName = schema.tables.fulltext;
  const scopedNodes = buildScopedNodeIdsSubquery(fulltextPredicate.field.alias);
  const fulltextStrategy = dialect.fulltext;
  if (fulltextStrategy === undefined) {
    throw new UnsupportedPredicateError(
      `Fulltext match predicates are not supported for dialect "${dialect.name}"`,
    );
  }
  const matchCondition = fulltextStrategy.matchCondition(
    tableName,
    query,
    mode,
    language,
  );
  const rankExpression = fulltextStrategy.rankExpression(
    tableName,
    query,
    mode,
    language,
  );

  const conditions: SQL[] = [
    sql`${qualifyColumn(tableName, "graph_id")} = ${graphId}`,
    compileKindFilter(qualifyColumn(tableName, "node_kind"), nodeKinds),
    matchCondition,
  ];
  if (minScore !== undefined) {
    conditions.push(sql`${rankExpression} >= ${minScore}`);
  }

  // Inner SELECT computes the rank once into an alias, outer SELECT
  // adds the ordinal via ROW_NUMBER. Two reasons to nest:
  // (1) Postgres re-evaluates `ts_rank_cd(...)` if it's repeated across
  // SELECT/ORDER BY, so referencing the alias avoids duplicate work.
  // (2) SQLite FTS5's bm25() cannot appear inside a window function's
  // OVER clause — the auxiliary-function context is restricted.
  return sql`
    ${sql.raw(FULLTEXT_CTE_ALIAS)} AS (
      SELECT
        node_id,
        node_kind,
        rank,
        ROW_NUMBER() OVER (ORDER BY rank DESC, node_id ASC) AS ord
      FROM (
        SELECT
          ${qualifyColumn(tableName, "node_id")} AS node_id,
          ${qualifyColumn(tableName, "node_kind")} AS node_kind,
          ${rankExpression} AS rank
        FROM ${schema.fulltextTable}
        INNER JOIN ${scopedNodes}
          ON ${sql.raw(`${SCOPED_RELEVANCE_NODES_ALIAS}.node_id`)} =
             ${qualifyColumn(tableName, "node_id")}
         AND ${sql.raw(`${SCOPED_RELEVANCE_NODES_ALIAS}.node_kind`)} =
             ${qualifyColumn(tableName, "node_kind")}
        WHERE ${sql.join(conditions, sql` AND `)}
        ORDER BY rank DESC, ${qualifyColumn(tableName, "node_id")} ASC
        LIMIT ${limit}
      ) AS fts_inner
    )
  `;
}

export function buildStandardHybridCandidateCte(): SQL {
  return sql`
    ${sql.raw(HYBRID_CANDIDATES_CTE_ALIAS)} AS (
      SELECT node_id, node_kind FROM ${sql.raw(EMBEDDINGS_CTE_ALIAS)}
      UNION
      SELECT node_id, node_kind FROM ${sql.raw(FULLTEXT_CTE_ALIAS)}
    )
  `;
}

/**
 * Compiles user-supplied `orderBy` clauses into SQL fragments suitable
 * for appending after a relevance-driven primary ORDER BY (vector,
 * fulltext, or hybrid RRF).
 */
function compileUserOrderBy(
  ast: QueryAst,
  dialect: DialectAdapter,
): readonly SQL[] {
  if (!ast.orderBy || ast.orderBy.length === 0) return [];

  const aliasToCte = buildAliasToCteMap(ast);
  const fragments: SQL[] = [];
  for (const orderSpec of ast.orderBy) {
    const valueType = orderSpec.field.valueType;
    if (valueType === "array" || valueType === "object") {
      throw new UnsupportedPredicateError(
        "Ordering by JSON arrays or objects is not supported",
      );
    }
    const cteAlias =
      aliasToCte.get(orderSpec.field.alias) ??
      `${ALIAS_CTE_PREFIX}${orderSpec.field.alias}`;
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
    fragments.push(
      sql`(${field} IS NULL) ${nullsDirection}`,
      sql`${field} ${direction}`,
    );
  }
  return fragments;
}

type BuildStandardFulltextOrderByInput = Readonly<{
  ast: QueryAst;
  dialect: DialectAdapter;
}>;

/**
 * ORDER BY clause when only a fulltext predicate is present.
 * Orders by rank DESC then any user-supplied ORDER BY as tiebreakers.
 */
export function buildStandardFulltextOrderBy(
  input: BuildStandardFulltextOrderByInput,
): SQL {
  const { ast, dialect } = input;
  const rankOrder = sql.raw(`${FULLTEXT_CTE_ALIAS}.rank DESC`);
  const userOrders = compileUserOrderBy(ast, dialect);
  return sql`ORDER BY ${sql.join([rankOrder, ...userOrders], sql`, `)}`;
}

/**
 * ORDER BY clause when BOTH vector and fulltext predicates are present.
 *
 * Reciprocal Rank Fusion at SQL level. Each CTE emits an `ord` ordinal
 * via ROW_NUMBER; the outer ORDER BY blends them as
 * `w_vec / (k + ord_vec) + w_ft / (k + ord_ft)`. NULL `ord` (a node
 * matched by only one source) makes that source's term NULL → COALESCE-to-0
 * absorbs it. User-supplied `orderBy` clauses follow as tiebreakers,
 * matching the single-source paths so pagination stays stable across
 * RRF score ties.
 *
 * Defaults: k=60, vector weight = fulltext weight = 1. Override via
 * `.fuseWith({ k, weights })` on the query builder.
 */

type BuildStandardHybridRrfOrderByInput = Readonly<{
  ast: QueryAst;
  dialect: DialectAdapter;
  fusion: HybridFusionOptions | undefined;
}>;

export function buildStandardHybridRrfOrderBy(
  input: BuildStandardHybridRrfOrderByInput,
): SQL {
  const { ast, dialect, fusion } = input;
  const k = fusion?.k ?? DEFAULT_RRF_K;
  const vectorWeight = fusion?.weights?.vector ?? DEFAULT_RRF_WEIGHT;
  const fulltextWeight = fusion?.weights?.fulltext ?? DEFAULT_RRF_WEIGHT;

  // Invariant: validateHybridFusionOptions has already rejected
  // non-finite / negative values before we reach here. sql.raw on these
  // numeric constants is deliberate — they're schema-level config, not
  // user-bindable.
  const rrfOrder = sql.raw(
    `(COALESCE(${vectorWeight} / (${k} + ${EMBEDDINGS_CTE_ALIAS}.ord), 0) + ` +
      `COALESCE(${fulltextWeight} / (${k} + ${FULLTEXT_CTE_ALIAS}.ord), 0)) DESC`,
  );
  // Deterministic tiebreak on the CTE-projected node_id. At least one of
  // the two CTEs always has a non-NULL node_id for any row returned by
  // the LEFT JOIN-union shape, so COALESCE always resolves. This matches
  // `store.search.hybrid`'s JS-side `localeCompare(nodeId)` tiebreak so
  // the two paths produce identical top-k under ties.
  const idTiebreak = sql.raw(
    `COALESCE(${FULLTEXT_CTE_ALIAS}.node_id, ${EMBEDDINGS_CTE_ALIAS}.node_id) ASC`,
  );
  const userOrders = compileUserOrderBy(ast, dialect);
  return sql`ORDER BY ${sql.join([rrfOrder, ...userOrders, idTiebreak], sql`, `)}`;
}

type BuildStandardVectorOrderByInput = Readonly<{
  ast: QueryAst;
  dialect: DialectAdapter;
}>;

export function buildStandardVectorOrderBy(
  input: BuildStandardVectorOrderByInput,
): SQL {
  const { ast, dialect } = input;
  const distanceOrder = sql.raw(`${EMBEDDINGS_CTE_ALIAS}.distance ASC`);
  const userOrders = compileUserOrderBy(ast, dialect);
  return sql`ORDER BY ${sql.join([distanceOrder, ...userOrders], sql`, `)}`;
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
