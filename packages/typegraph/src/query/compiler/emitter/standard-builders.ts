import { UnsupportedPredicateError } from "../../../errors";
import { boundPgIdentifier } from "../../../utils/identifier";
import { requireDefined } from "../../../utils/presence";
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
import { type DialectAdapter } from "../../dialect/types";
import {
  vectorMinScoreCondition,
  vectorScoreExpression,
} from "../../dialect/vector-strategy";
import { sql, type SqlFragment } from "../../sql-fragment";
import { compileIdentitySourcePredicate } from "../identity-traversal";
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
  vectorSlotKey,
} from "../schema";
import { compileSelectivePropsExtraction } from "../typed-json-extract";
import {
  EDGE_COLUMNS,
  EMPTY_REQUIRED_COLUMNS,
  findSelectivePropsFieldForFieldRef,
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
): SqlFragment {
  if (tableAlias === undefined) {
    return sql.raw(column);
  }
  return sql`${sql.raw(tableAlias)}.${sql.raw(column)}`;
}

function qualifyColumn(owner: string, name: string): SqlFragment {
  return sql`${quoteIdentifier(owner)}.${quoteIdentifier(name)}`;
}

const SCOPED_RELEVANCE_NODES_ALIAS = "scoped_relevance_nodes";

/**
 * Builds a synthetic CTE column name for a selectively-extracted props field.
 *
 * Length-prefixes each component (`<length>:<value>`) rather than joining
 * `alias`/`field` on a bare `_`: alias and field are both attacker/user-controlled
 * strings that may themselves contain `_`, so naive concatenation lets two distinct
 * (alias, field) pairs collide on the same column name (e.g. alias="p_full",
 * field="name" vs. alias="p", field="full_name" would otherwise both produce
 * "__tg_p_full_name"). The length prefix makes the encoding unambiguous regardless
 * of what characters alias/field contain.
 *
 * The encoding is unbounded, but PostgreSQL truncates identifiers at 63 bytes,
 * so `boundPgIdentifier` hash-guards long names: two pairs whose encodings share
 * a >63-byte prefix would otherwise collapse onto the same physical column.
 * Short names are returned verbatim, preserving the readable `__tg_...` form.
 */
function selectivePropsCteColumnName(field: SelectiveField): string {
  const { alias, field: fieldName } = field;
  const encoded = `__tg_${alias.length}:${alias}:${fieldName.length}:${fieldName}`;
  return boundPgIdentifier(encoded, `${alias}\0${fieldName}`);
}

function buildScopedNodeIdsSubquery(nodeAlias: string): SqlFragment {
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

type CompileSelectivePropsSelectColumnsInput = Readonly<{
  alias: string;
  dialect: DialectAdapter;
  selectiveFields: readonly SelectiveField[] | undefined;
  tableAlias: string | undefined;
}>;

function compileSelectivePropsSelectColumns(
  input: CompileSelectivePropsSelectColumnsInput,
): SqlFragment[] {
  const { alias, dialect, selectiveFields, tableAlias } = input;
  const propsFields =
    selectiveFields?.filter(
      (field) => !field.isSystemField && field.alias === alias,
    ) ?? [];
  if (propsFields.length === 0) return [];

  const propsColumn = compileColumnReference(tableAlias, "props");
  return propsFields.map((field) => {
    const extracted = compileSelectivePropsExtraction(
      field,
      propsColumn,
      dialect,
    );
    return sql`${extracted} AS ${quoteIdentifier(selectivePropsCteColumnName(field))}`;
  });
}

function appendSelectivePropsColumns(
  baseColumns: readonly SqlFragment[],
  input: CompileSelectivePropsSelectColumnsInput,
): SqlFragment[] {
  return [...baseColumns, ...compileSelectivePropsSelectColumns(input)];
}

type CompileNodeSelectColumnsInput = Readonly<{
  alias: string;
  dialect: DialectAdapter;
  requiredColumns: ReadonlySet<string> | undefined;
  selectiveFields: readonly SelectiveField[] | undefined;
  tableAlias: string | undefined;
}>;

function compileNodeSelectColumns(
  input: CompileNodeSelectColumnsInput,
): SqlFragment[] {
  const { alias, dialect, requiredColumns, selectiveFields, tableAlias } =
    input;
  const baseColumns = NODE_COLUMNS.filter(
    (column) =>
      column === "id" ||
      column === "kind" ||
      shouldProjectColumn(requiredColumns, column),
  ).map(
    (column) =>
      sql`${compileColumnReference(tableAlias, column)} AS ${sql.raw(`${alias}_${column}`)}`,
  );
  return appendSelectivePropsColumns(baseColumns, {
    alias,
    dialect,
    selectiveFields,
    tableAlias,
  });
}

type CompileEdgeSelectColumnsInput = Readonly<{
  alias: string;
  dialect: DialectAdapter;
  requiredColumns: ReadonlySet<string> | undefined;
  selectiveFields: readonly SelectiveField[] | undefined;
  tableAlias: string | undefined;
}>;

function compileEdgeSelectColumns(
  input: CompileEdgeSelectColumnsInput,
): SqlFragment[] {
  const { alias, dialect, requiredColumns, selectiveFields, tableAlias } =
    input;
  const baseColumns = EDGE_COLUMNS.filter((column) =>
    shouldProjectColumn(requiredColumns, column),
  ).map(
    (column) =>
      sql`${compileColumnReference(tableAlias, column)} AS ${sql.raw(`${alias}_${column}`)}`,
  );
  return appendSelectivePropsColumns(baseColumns, {
    alias,
    dialect,
    selectiveFields,
    tableAlias,
  });
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

export function buildStandardStartCte(
  input: BuildStandardStartCteInput,
): SqlFragment {
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
        compileNodeSelectColumns({
          alias,
          dialect: ctx.dialect,
          requiredColumns: effectiveRequiredColumns,
          selectiveFields: ast.selectiveFields,
          tableAlias: undefined,
        }),
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
): SqlFragment {
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
  const traversal = requireDefined(ast.traversals[traversalIndex]);
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
    ...compileEdgeSelectColumns({
      alias: edgeAlias,
      dialect: ctx.dialect,
      requiredColumns: requiredEdgeColumns,
      selectiveFields: ast.selectiveFields,
      tableAlias: "e",
    }),
    ...compileNodeSelectColumns({
      alias: nodeAlias,
      dialect: ctx.dialect,
      requiredColumns: requiredNodeColumns,
      selectiveFields: ast.selectiveFields,
      tableAlias: "n",
    }),
  ];
  const cteMaterialization =
    materializeCte ? sql`MATERIALIZED `
    : ctx.dialect.capabilities.emitNotMaterializedHint ? sql`NOT MATERIALIZED `
    : sql``;

  function compileTraversalBranch(
    branch: Readonly<{
      duplicateGuard?: SqlFragment | undefined;
      edgeKinds: readonly string[];
      joinField: "from_id" | "to_id";
      joinKindField: "from_kind" | "to_kind";
      targetField: "from_id" | "to_id";
      targetKindField: "from_kind" | "to_kind";
    }>,
  ): SqlFragment {
    const whereClauses = [
      ...baseWhereClauses,
      compileKindFilter(sql.raw("e.kind"), branch.edgeKinds),
      compileKindFilter(sql.raw(`e.${branch.targetKindField}`), nodeKinds),
    ];

    if (traversal.includeIdentityMembers !== true) {
      whereClauses.push(
        compileKindFilter(
          sql.raw(`e.${branch.joinKindField}`),
          previousNodeKinds,
        ),
      );
    }

    if (branch.duplicateGuard !== undefined) {
      whereClauses.push(branch.duplicateGuard);
    }

    const sourceJoin =
      traversal.includeIdentityMembers === true ?
        compileIdentitySourcePredicate({
          ast,
          ctx,
          edgeId: sql`e.${sql.raw(branch.joinField)}`,
          edgeKind: sql`e.${sql.raw(branch.joinKindField)}`,
          graphId,
          previousId: sql`cte_${sql.raw(previousAlias)}.${sql.raw(`${previousAlias}_id`)}`,
          previousKind: sql`cte_${sql.raw(previousAlias)}.${sql.raw(`${previousAlias}_kind`)}`,
          temporalFilterPass,
        })
      : sql`
        cte_${sql.raw(previousAlias)}.${sql.raw(`${previousAlias}_id`)} = e.${sql.raw(branch.joinField)}
        AND cte_${sql.raw(previousAlias)}.${sql.raw(`${previousAlias}_kind`)} = e.${sql.raw(branch.joinKindField)}
      `;

    return sql`
      SELECT ${sql.join(selectColumns, sql`, `)}
      FROM cte_${sql.raw(previousAlias)}
      JOIN ${ctx.schema.edgesTable} e ON ${sourceJoin}
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

  // Exclude a TRUE self-loop (an edge whose two endpoints are the same node)
  // from the inverse branch so it is traversed once, not twice. Identity of a
  // node is (kind, id), not id alone: under sameIdAcrossKinds folding a genuine
  // two-node edge between folded peers (e.g. (Person, x) -> (Author, x)) has
  // from_id = to_id while from_kind <> to_kind, and must NOT be suppressed.
  const duplicateGuard =
    overlappingKinds.length > 0 ?
      sql`NOT (e.from_id = e.to_id AND e.from_kind = e.to_kind AND ${compileKindFilter(
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
): SqlFragment {
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
): SqlFragment {
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
): SqlFragment {
  const { ast, collapsedTraversalCteAlias, dialect } = input;
  if (ast.selectiveFields && ast.selectiveFields.length > 0) {
    return compileSelectiveProjection(
      ast.selectiveFields,
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
  ast: QueryAst,
  collapsedTraversalCteAlias?: string,
): SqlFragment {
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

    return sql`${sql.raw(cteAlias)}.${quoteIdentifier(selectivePropsCteColumnName(field))} AS ${quoteIdentifier(field.outputName)}`;
  });

  return sql.join(columns, sql`, `);
}

function compileOrderFieldValue(
  ast: QueryAst,
  field: FieldRef,
  dialect: DialectAdapter,
  cteAlias: string,
): SqlFragment {
  const selectiveField = findSelectivePropsFieldForFieldRef(
    ast.selectiveFields,
    field,
  );
  if (selectiveField !== undefined) {
    return sql`${sql.raw(cteAlias)}.${quoteIdentifier(selectivePropsCteColumnName(selectiveField))}`;
  }

  return compileFieldValue(field, dialect, field.valueType, cteAlias);
}

function buildRelevanceJoins(
  vectorPredicate: VectorSimilarityPredicate | undefined,
  fulltextPredicate: FulltextMatchPredicate | undefined,
): SqlFragment[] {
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

  const joins: SqlFragment[] = [];
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

function buildHybridCandidateJoin(nodeAlias: string): SqlFragment {
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
): SqlFragment {
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
): SqlFragment {
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

  const joins: SqlFragment[] = [];
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
): SqlFragment | undefined {
  const { ast, collapsedTraversalCteAlias, dialect } = input;
  const fieldOrderBy = ast.orderBy ?? [];
  const aggregateOrderBy = ast.aggregateOrderBy ?? [];
  if (fieldOrderBy.length === 0 && aggregateOrderBy.length === 0) {
    return undefined;
  }

  // Only built when there's a FieldRef-based order spec to resolve against
  // a CTE — the aggregate-alias loop below references the SELECT-list
  // output alias directly and never needs it, which matters because the
  // common case for `.aggregate().orderBy(...)` has `fieldOrderBy` empty.
  const aliasToCte =
    fieldOrderBy.length > 0 ? buildAliasToCteMap(ast) : undefined;
  const parts: SqlFragment[] = [];
  for (const orderSpec of fieldOrderBy) {
    const valueType = orderSpec.field.valueType;
    if (valueType === "array" || valueType === "object") {
      throw new UnsupportedPredicateError(
        "Ordering by JSON arrays or objects is not supported",
      );
    }
    const cteAlias =
      collapsedTraversalCteAlias ??
      aliasToCte?.get(orderSpec.field.alias) ??
      `cte_${orderSpec.field.alias}`;
    const field = compileOrderFieldValue(
      ast,
      orderSpec.field,
      dialect,
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

  // Aggregate ordering references the projected SELECT-list output alias
  // directly rather than recompiling a FieldRef/AggregateExpr — every
  // `.aggregate()` field (grouped or aggregated) is always projected with
  // an alias, and both SQLite and PostgreSQL allow ORDER BY to reference
  // it, so this needs no per-CTE or per-dialect resolution.
  //
  // Nulls ordering can't reuse the `(field IS NULL) direction, field
  // direction` trick above: unlike a source-table field reference, an
  // output alias is only resolved by either dialect when the ORDER BY term
  // is the bare identifier itself — wrapping it in `(alias IS NULL)`
  // makes both SQLite and PostgreSQL look for a real column named
  // `alias` and fail. The standard `NULLS FIRST`/`NULLS LAST` suffix
  // (supported by both dialects) sidesteps that: it attaches to the bare
  // identifier rather than embedding it in a larger expression.
  for (const orderSpec of aggregateOrderBy) {
    const column = quoteIdentifier(orderSpec.outputName);
    const direction = sql.raw(orderSpec.direction.toUpperCase());
    const nulls =
      orderSpec.nulls ?? (orderSpec.direction === "asc" ? "last" : "first");
    const nullsKeyword = sql.raw(
      nulls === "first" ? "NULLS FIRST" : "NULLS LAST",
    );
    parts.push(sql`${column} ${direction} ${nullsKeyword}`);
  }

  return sql`ORDER BY ${sql.join(parts, sql`, `)}`;
}

// ============================================================
// Late materialization (deferred projection)
// ============================================================
//
// For an ORDER BY … LIMIT query whose projection reads columns beyond the
// ordering/identity keys, the flat plan carries every projected column (e.g. a
// large `content` prop) through the sorter for every candidate row and then
// discards all but the LIMIT survivors. Late materialization sorts+limits a
// *lean* candidate set (identity + sort keys only), then re-joins the physical
// node table by `(graph_id, kind, id)` to fetch the deferred columns for only
// the surviving rows. See the standard emitter's late-materialization branch
// for the eligibility gate; these builders assume it already held.

export const LATE_MAT_TOPK_CTE_ALIAS = "cte_lm_topk";
const LATE_MAT_SORT_KEY_PREFIX = "__lm_sk";
const LATE_MAT_PHYSICAL_ALIAS_PREFIX = "lm_";

export function lateMaterializedPhysicalAlias(alias: string): string {
  return `${LATE_MAT_PHYSICAL_ALIAS_PREFIX}${alias}`;
}

/** Node aliases in the query: the start alias plus each traversal's node. */
function lateMaterializedNodeAliases(ast: QueryAst): readonly string[] {
  return [
    ast.start.alias,
    ...ast.traversals.map((traversal) => traversal.nodeAlias),
  ];
}

/**
 * Node aliases the projection actually reads — the physical tables the outer
 * SELECT must re-join. Edge aliases are gated out upstream, so every projected
 * alias resolves to a node table here.
 */
export function lateMaterializedProjectedNodeAliases(
  ast: QueryAst,
): readonly string[] {
  const referenced = new Set<string>();
  for (const field of ast.selectiveFields ?? []) {
    referenced.add(field.alias);
  }
  return lateMaterializedNodeAliases(ast).filter((alias) =>
    referenced.has(alias),
  );
}

type BuildLateMaterializedTopKCteInput = Readonly<{
  ast: QueryAst;
  collapsedTraversalCteAlias?: string;
  dialect: DialectAdapter;
  fromClause: SqlFragment;
  limit: number;
  offset?: number | undefined;
}>;

/**
 * The topK CTE: selects each node alias's identity `(id, kind)` plus each sort
 * key value (aliased `__lm_sk{n}` so the outer SELECT can re-order the survivors
 * without re-extracting), ordered and limited on the lean candidate set.
 *
 * When the traversal rowset is collapsed onto a single CTE, every alias's
 * identity is carried into that one CTE (keyed by alias prefix), so all columns
 * resolve against `collapsedTraversalCteAlias` and the FROM references it alone.
 */
export function buildLateMaterializedTopKCte(
  input: BuildLateMaterializedTopKCteInput,
): SqlFragment {
  const { ast, collapsedTraversalCteAlias, dialect, fromClause } = input;
  const aliasToCte = buildAliasToCteMap(ast);
  const cteAliasFor = (alias: string): string =>
    collapsedTraversalCteAlias ??
    aliasToCte.get(alias) ??
    `${ALIAS_CTE_PREFIX}${alias}`;

  const columns: SqlFragment[] = [];
  for (const alias of lateMaterializedNodeAliases(ast)) {
    const cteAlias = cteAliasFor(alias);
    columns.push(
      sql`${qualifyColumn(cteAlias, `${alias}_id`)} AS ${sql.raw(`${alias}_id`)}`,
      sql`${qualifyColumn(cteAlias, `${alias}_kind`)} AS ${sql.raw(`${alias}_kind`)}`,
    );
  }
  for (const [index, orderSpec] of (ast.orderBy ?? []).entries()) {
    const value = compileOrderFieldValue(
      ast,
      orderSpec.field,
      dialect,
      cteAliasFor(orderSpec.field.alias),
    );
    columns.push(
      sql`${value} AS ${sql.raw(`${LATE_MAT_SORT_KEY_PREFIX}${index}`)}`,
    );
  }

  const innerOrderBy = buildStandardOrderBy({
    ast,
    dialect,
    ...(collapsedTraversalCteAlias === undefined ?
      {}
    : { collapsedTraversalCteAlias }),
  });
  const limitOffset = buildLimitOffsetClause({
    limit: input.limit,
    offset: input.offset,
  });

  const parts: SqlFragment[] = [
    sql`SELECT ${sql.join(columns, sql`, `)}`,
    fromClause,
  ];
  if (innerOrderBy !== undefined) parts.push(innerOrderBy);
  if (limitOffset !== undefined) parts.push(limitOffset);

  return sql`${sql.raw(LATE_MAT_TOPK_CTE_ALIAS)} AS (${sql.join(parts, sql` `)})`;
}

/**
 * The outer projection: each selective field sourced from the re-joined
 * physical node table alias `lm_<alias>` rather than a candidate CTE, so the
 * deferred columns are read only for the surviving rows.
 */
export function buildLateMaterializedOuterProjection(
  ast: QueryAst,
  dialect: DialectAdapter,
): SqlFragment {
  const columns = (ast.selectiveFields ?? []).map((field) => {
    const physicalAlias = lateMaterializedPhysicalAlias(field.alias);
    if (field.isSystemField) {
      const dbColumn = mapSelectiveSystemFieldToColumn(field.field);
      return sql`${compileColumnReference(physicalAlias, dbColumn)} AS ${quoteIdentifier(field.outputName)}`;
    }
    const extracted = compileSelectivePropsExtraction(
      field,
      compileColumnReference(physicalAlias, "props"),
      dialect,
    );
    return sql`${extracted} AS ${quoteIdentifier(field.outputName)}`;
  });
  return sql.join(columns, sql`, `);
}

/**
 * The outer ORDER BY: re-orders the LIMIT survivors by the `__lm_sk{n}` sort
 * values carried out of the topK CTE, matching `buildStandardOrderBy`'s
 * null-ordering semantics. Referencing the CTE's real columns (not bare output
 * aliases) keeps the `(x IS NULL)` null-placement trick valid on both dialects.
 */
export function buildLateMaterializedOuterOrderBy(
  ast: QueryAst,
): SqlFragment | undefined {
  const orderBy = ast.orderBy ?? [];
  if (orderBy.length === 0) return undefined;
  const topk = sql.raw(LATE_MAT_TOPK_CTE_ALIAS);
  const parts: SqlFragment[] = [];
  for (const [index, orderSpec] of orderBy.entries()) {
    const column = sql`${topk}.${sql.raw(`${LATE_MAT_SORT_KEY_PREFIX}${index}`)}`;
    const direction = sql.raw(orderSpec.direction.toUpperCase());
    const nulls =
      orderSpec.nulls ?? (orderSpec.direction === "asc" ? "last" : "first");
    const nullsDirection = sql.raw(nulls === "first" ? "DESC" : "ASC");
    parts.push(
      sql`(${column} IS NULL) ${nullsDirection}`,
      sql`${column} ${direction}`,
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
): SqlFragment | undefined {
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
): SqlFragment | undefined {
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

/**
 * Builds the relevance CTE for a `field.similarTo(...)` predicate in the query
 * builder.
 *
 * Default (exact): splices the strategy's `distanceExpression` and scans each
 * declaring kind's per-field table (`ORDER BY distance LIMIT k`). On
 * pgvector >= 0.8 the planner can serve this shape from an HNSW index for a
 * single-kind alias; on the SQLite-family engines it is a full scan.
 *
 * Opt-in (`{ approximate: true }`): each declaring kind's branch compiles to
 * the strategy's own search SQL — the engine-native ANN form (vec0
 * `MATCH … k=`, libSQL `vector_top_k`, pgvector's index-eligible scan) —
 * scoped to the alias's candidate nodes via the same `candidates` pushdown
 * the search facade uses. Semantics become approximate (index recall); a
 * slot declared `indexType: "none"` degrades to the exact scan.
 */
export function buildStandardEmbeddingsCte(
  input: BuildStandardEmbeddingsCteInput,
): SqlFragment {
  const { ctx, graphId, nodeKinds, vectorPredicate } = input;
  const { field, metric, minScore, queryEmbedding } = vectorPredicate;

  if (nodeKinds.length === 0) {
    throw new UnsupportedPredicateError(
      "Vector predicate must resolve to at least one node kind",
    );
  }

  const { vectorStrategy } = ctx;
  if (vectorStrategy === undefined) {
    throw new UnsupportedPredicateError(
      "Vector similarity predicate requires a backend with a vector strategy",
    );
  }

  const fieldPath = resolveEmbeddingFieldPath(field);
  const vectorSlots = ctx.vectorSlots;
  const scopedNodes = buildScopedNodeIdsSubquery(field.alias);

  // Only the kinds in this alias that actually DECLARE the embedding
  // field back a per-field table. Skipping kinds without a slot keeps
  // similarTo() from referencing a table that was never created and
  // stops rank weight leaking from kinds that happen to share a
  // field_path but don't embed it.
  const declaringKinds = nodeKinds.filter((kind) =>
    vectorSlots?.has(vectorSlotKey(kind, fieldPath)),
  );

  // Per-kind relevance scan against the strategy's typed per-field
  // table. The strategy owns the engine-specific distance fragment
  // (`<=>` / `vec_distance_cosine` / `vector_distance_cos`); the score
  // and minScore math around it stays shared so the OUTPUT columns
  // (node_id, node_kind, distance, score, ord) are identical across
  // engines and the hybrid RRF / vector ORDER BY paths are untouched.
  const branches = declaringKinds.map((kind) => {
    const tableName = vectorStrategy.tableName(graphId, kind, fieldPath);
    const slotDescriptor = vectorSlots?.get(vectorSlotKey(kind, fieldPath));
    // Use the predicate's explicit metric if given, else this kind's DECLARED
    // metric (the one its ANN index was built for). Resolving per kind keeps an
    // includeSubClasses union correct when subkinds declare different metrics.
    const branchMetric = metric ?? slotDescriptor?.metric ?? "cosine";

    // Approximate opt-in: retrieve this kind's candidates via the
    // strategy's own search SQL — the engine's native ANN form — scoped to
    // the alias's candidate nodes (predicates, currency, traversal
    // reachability) via the same `candidates` pushdown the search facade
    // uses. A slot declared `indexType: "none"` compiles to the strategy's
    // exact scan, so the opt-in degrades to today's semantics. Distance is
    // re-derived from the strategy's score convention (cosine score =
    // `1 - distance`; l2 / inner_product score = raw distance) so the
    // shared ORDER BY / ROW_NUMBER machinery below is untouched.
    //
    // The ANN path additionally requires the effective metric to MATCH the
    // slot's declared metric: every engine materializes metric-specific
    // ANN structures (vec0 bakes `distance_metric` into the virtual table,
    // libSQL's DiskANN index and pgvector's operator class are built for
    // one metric), so retrieving by the declared metric and re-scoring
    // under an overridden one would silently miss the override metric's
    // true nearest neighbors. A mismatched override falls back to the
    // exact scan below — correct for any metric, like `indexType: "none"`.
    // Engines whose `buildSearch` is EXACT (vec0's brute-force C KNN)
    // serve the non-approximate branch through it as well: identical
    // results to the SQL distance scan at engine speed (489ms -> 113ms
    // at 50k on the SQLite lane). The metric gate stays: the engine
    // form is built for the slot's declared metric.
    const engineFormEligible =
      vectorPredicate.approximate === true ||
      vectorStrategy.searchIsExact === true;
    const annSlot =
      engineFormEligible && branchMetric === slotDescriptor?.metric ?
        slotDescriptor
      : undefined;
    if (annSlot !== undefined) {
      ctx.annIndexTypes?.add(annSlot.indexType);
      // Membership candidates WITHOUT the scoped subquery's DISTINCT:
      // strategies embed these as `node_id IN (...)`, where duplicates
      // cannot change the result — and the DISTINCT is what kept
      // PostgreSQL off the ordered ANN index scan entirely (verified:
      // the identical statement flips from a full sort to an HNSW
      // Index Scan when the DISTINCT is dropped; even
      // `enable_seqscan = off` could not rescue the DISTINCT form).
      // The JOIN consumers (exact branch, fulltext CTE) keep
      // buildScopedNodeIdsSubquery's DISTINCT — a join DOES multiply
      // rows on duplicates.
      const candidateCte = `${ALIAS_CTE_PREFIX}${field.alias}`;
      const kindCandidates = sql`SELECT ${qualifyColumn(candidateCte, `${field.alias}_id`)} FROM ${quoteIdentifier(candidateCte)} WHERE ${qualifyColumn(candidateCte, `${field.alias}_kind`)} = ${kind}`;
      const annSql = vectorStrategy.buildSearch(
        {
          graphId,
          nodeKind: kind,
          fieldPath,
          dimensions: annSlot.dimensions,
          metric: branchMetric,
          indexType: annSlot.indexType,
        },
        {
          graphId,
          nodeKind: kind,
          fieldPath,
          queryEmbedding,
          metric: branchMetric,
          dimensions: annSlot.dimensions,
          indexType: annSlot.indexType,
          limit: vectorPredicate.limit,
          ...(minScore === undefined ? {} : { minScore }),
        },
        kindCandidates,
      );
      const distanceFromScore =
        branchMetric === "cosine" ? sql.raw("(1.0 - score)") : sql.raw("score");
      return sql`
        SELECT node_id, ${kind} AS node_kind, ${distanceFromScore} AS distance, score
        FROM (${annSql}) AS tg_ann_src
      `;
    }
    const distanceExpr = vectorStrategy.distanceExpression(
      qualifyColumn(tableName, "embedding"),
      queryEmbedding,
      branchMetric,
    );
    // EXACT MEANS EXACT: this branch is the non-approximate path, but on
    // pgvector any `ORDER BY embedding <=> q LIMIT k` whose expression
    // matches the ANN opclass is silently served by the HNSW/IVFFlat
    // index — approximate results with plan-dependent recall (measured
    // recall 0.980 unfiltered, 0.000 under a selective filter at 50k,
    // where the index frontier starves). `+ 0.0` makes the ordered
    // expression unmatchable to the opclass, forcing the true flat scan;
    // numerically identity, and inert on engines whose ANN forms are
    // opt-in anyway (vec0 MATCH, libSQL vector_top_k). The sanctioned
    // index path is `approximate: true` above.
    const exactDistanceExpr = sql`(${distanceExpr} + 0.0)`;
    const scoreExpr = vectorScoreExpression(distanceExpr, branchMetric);

    const conditions: SqlFragment[] = [
      sql`${qualifyColumn(tableName, "graph_id")} = ${graphId}`,
    ];
    if (minScore !== undefined) {
      // minScore validation (finiteness, cosine range) is handled by the
      // vector predicate pass in passes/vector.ts — no redundant check.
      conditions.push(
        vectorMinScoreCondition(distanceExpr, branchMetric, minScore),
      );
    }

    return sql`
      SELECT
        ${qualifyColumn(tableName, "node_id")} AS node_id,
        ${kind} AS node_kind,
        ${exactDistanceExpr} AS distance,
        ${scoreExpr} AS score
      FROM ${quoteIdentifier(tableName)}
      INNER JOIN ${scopedNodes}
        ON ${sql.raw(`${SCOPED_RELEVANCE_NODES_ALIAS}.node_id`)} =
           ${qualifyColumn(tableName, "node_id")}
       AND ${sql.raw(`${SCOPED_RELEVANCE_NODES_ALIAS}.node_kind`)} = ${kind}
      WHERE ${sql.join(conditions, sql` AND `)}
    `;
  });

  // No declaring kind → emit a CTE with the right column shape that
  // yields no rows, so the rest of the emitter (which always references
  // cte_embeddings) compiles and simply matches nothing.
  const unionBody =
    branches.length === 0 ?
      emptyEmbeddingsBody()
    : sql.join(
        branches,
        sql`
          UNION ALL
        `,
      );

  // Inner SELECT applies the predicate's k-cutoff, then ROW_NUMBER ranks
  // over that bounded set. Without the inner LIMIT, a hybrid query would
  // assign vector ordinals to every candidate, letting documents far
  // outside the requested top-k contribute to the RRF fused score and
  // reorder final results.
  return sql`
    ${sql.raw(EMBEDDINGS_CTE_ALIAS)} AS (
      SELECT
        node_id,
        node_kind,
        distance,
        score,
        ROW_NUMBER() OVER (ORDER BY distance ASC) AS ord
      FROM (
        ${unionBody}
        ORDER BY distance ASC
        LIMIT ${vectorPredicate.limit}
      ) AS vec_inner
    )
  `;
}

/**
 * A no-row inner body carrying the exact `(node_id, node_kind, distance,
 * score)` column contract, used when no kind in the alias declares the
 * embedding field. `WHERE 1 = 0` keeps the planner from scanning.
 */
function emptyEmbeddingsBody(): SqlFragment {
  return sql`
    SELECT
      CAST(NULL AS TEXT) AS node_id,
      CAST(NULL AS TEXT) AS node_kind,
      CAST(NULL AS REAL) AS distance,
      CAST(NULL AS REAL) AS score
    WHERE 1 = 0
  `;
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
): SqlFragment {
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
  // Parse the query with a CONSTANT language whenever possible: the
  // caller's explicit override, else the one declared language shared by
  // every kind in the alias (rows are written with their kind's declared
  // language, so this matches the stored tsv). A constant keeps the
  // tsquery plan-time-stable, so PostgreSQL's GIN index on `tsv` can
  // serve the match — the per-row `websearch_to_tsquery("language", ...)`
  // fallback (mixed-language aliases only) forces a scan of the kinds'
  // rows.
  const effectiveLanguage =
    language ?? sharedDeclaredLanguage(ctx.fulltextLanguages, nodeKinds);
  const matchCondition = fulltextStrategy.matchCondition(
    tableName,
    query,
    mode,
    effectiveLanguage,
  );
  const rankExpression = fulltextStrategy.rankExpression(
    tableName,
    query,
    mode,
    effectiveLanguage,
  );

  const conditions: SqlFragment[] = [
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

/**
 * The single declared language shared by every kind in the alias that
 * declares searchable fields, or `undefined` when they disagree (or none
 * declares any — such kinds contribute no fulltext rows either way).
 */
function sharedDeclaredLanguage(
  fulltextLanguages: ReadonlyMap<string, string> | undefined,
  nodeKinds: readonly string[],
): string | undefined {
  if (fulltextLanguages === undefined) return undefined;
  const languages = new Set<string>();
  for (const kind of nodeKinds) {
    const language = fulltextLanguages.get(kind);
    if (language !== undefined) languages.add(language);
  }
  if (languages.size !== 1) return undefined;
  return [...languages][0];
}

export function buildStandardHybridCandidateCte(): SqlFragment {
  return sql`
    ${sql.raw(HYBRID_CANDIDATES_CTE_ALIAS)} AS (
      SELECT node_id, node_kind FROM ${sql.raw(EMBEDDINGS_CTE_ALIAS)}
      UNION
      SELECT node_id, node_kind FROM ${sql.raw(FULLTEXT_CTE_ALIAS)}
    )
  `;
}

/**
 * Compiles user-supplied `orderBy` clauses into `SqlFragment` values suitable
 * for appending after a relevance-driven primary ORDER BY (vector,
 * fulltext, or hybrid RRF).
 */
function compileUserOrderBy(
  ast: QueryAst,
  dialect: DialectAdapter,
): readonly SqlFragment[] {
  if (!ast.orderBy || ast.orderBy.length === 0) return [];

  const aliasToCte = buildAliasToCteMap(ast);
  const fragments: SqlFragment[] = [];
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
    const field = compileOrderFieldValue(
      ast,
      orderSpec.field,
      dialect,
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
): SqlFragment {
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
): SqlFragment {
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
  // `store.search.hybrid`'s JS-side code-unit `compareStrings(nodeId)`
  // tiebreak so the two paths produce identical top-k under ties (SQLite
  // BINARY collation is code-unit order for the ASCII id alphabet).
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
): SqlFragment {
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
): SqlFragment | undefined {
  const { limit, offset } = input;
  const parts: SqlFragment[] = [];

  if (limit !== undefined) {
    parts.push(sql`LIMIT ${limit}`);
  }
  if (offset !== undefined) {
    parts.push(sql`OFFSET ${offset}`);
  }

  return parts.length > 0 ? sql.join(parts, sql` `) : undefined;
}
