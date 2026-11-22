import { UnsupportedPredicateError } from "../../../errors";
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
  assertApproximateMetricSupported,
  vectorMinScoreCondition,
  vectorScoreExpression,
} from "../../dialect/vector-strategy";
import { type DatabaseExpression } from "../../expressions";
import { compileOrderTerm, resolveNullOrdering } from "../../order";
import { sql, type SqlFragment } from "../../sql-fragment";
import { validateAggregateOperand } from "../aggregate-validation";
import {
  aliasColumnName,
  aliasCteName,
  lateMaterializedPhysicalAlias,
  selectivePropsColumnName,
} from "../alias-names";
import {
  bindUnresolvedColumnReads,
  readAliasColumn,
  readColumn,
  readDerivedTableColumn,
  readEveryColumn,
  readEveryColumnOf,
  readUnqualifiedColumn,
} from "../column-reads";
import {
  compileDatabaseExpression,
  compileLegacyAggregateExpression,
} from "../database-expressions";
import { planIdentityFrontierExpansion } from "../identity-traversal";
import { compileInverseTraversalDuplicateGuard } from "../inverse-traversal-guard";
import { compileLimitOffsetClauses } from "../limit-offset";
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
  type RelevanceSortKey,
  type RelevanceSortSource,
} from "../relevance-order";
import {
  EMBEDDINGS_CTE_ALIAS,
  FULLTEXT_CTE_ALIAS,
  HYBRID_CANDIDATES_CTE_ALIAS,
  vectorSlotKey,
} from "../schema";
import {
  declareAliasColumn,
  declareAliasCte,
  declareFixedCte,
  declareFixedCteWithColumns,
  declareResultColumn,
  declareSelectivePropsColumn,
  type SqlNameScope,
  type SqlStatementNames,
} from "../sql-name-registry";
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
import { type StandardFromClause } from "./standard";

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

function selectivePropsCteColumnName(field: SelectiveField): string {
  return selectivePropsColumnName(field.alias, field.field);
}

function buildScopedNodeIdsSubquery(nodeAlias: string): SqlFragment {
  const cteAlias = aliasCteName(nodeAlias);
  return sql`
    (
        SELECT DISTINCT
          ${readAliasColumn(cteAlias, nodeAlias, "id")} AS node_id,
          ${readAliasColumn(cteAlias, nodeAlias, "kind")} AS node_kind
        FROM ${sql.raw(cteAlias)}
      ) AS ${sql.raw(SCOPED_RELEVANCE_NODES_ALIAS)}
  `;
}

type CompileSelectivePropsSelectColumnsInput = Readonly<{
  alias: string;
  /** The columns of the CTE these columns are declared in. */
  columns: SqlNameScope;
  dialect: DialectAdapter;
  selectiveFields: readonly SelectiveField[] | undefined;
  tableAlias: string | undefined;
}>;

function compileSelectivePropsSelectColumns(
  input: CompileSelectivePropsSelectColumnsInput,
): SqlFragment[] {
  const { alias, columns, dialect, selectiveFields, tableAlias } = input;
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
    const name = declareSelectivePropsColumn(columns, alias, field.field);
    return sql`${extracted} AS ${quoteIdentifier(name)}`;
  });
}

function appendSelectivePropsColumns(
  baseColumns: readonly SqlFragment[],
  input: CompileSelectivePropsSelectColumnsInput,
): SqlFragment[] {
  return [...baseColumns, ...compileSelectivePropsSelectColumns(input)];
}

type CompileAliasSelectColumnsInput = Readonly<{
  alias: string;
  /** The columns of the CTE these columns are declared in. */
  columns: SqlNameScope;
  dialect: DialectAdapter;
  requiredColumns: ReadonlySet<string> | undefined;
  selectiveFields: readonly SelectiveField[] | undefined;
  tableAlias: string | undefined;
}>;

function compileNodeSelectColumns(
  input: CompileAliasSelectColumnsInput,
): SqlFragment[] {
  const { alias, columns, requiredColumns, tableAlias } = input;
  const baseColumns = NODE_COLUMNS.filter(
    (column) =>
      column === "id" ||
      column === "kind" ||
      shouldProjectColumn(requiredColumns, column),
  ).map(
    (column) =>
      sql`${compileColumnReference(tableAlias, column)} AS ${sql.raw(declareAliasColumn(columns, alias, column))}`,
  );
  return appendSelectivePropsColumns(baseColumns, input);
}

function compileEdgeSelectColumns(
  input: CompileAliasSelectColumnsInput,
): SqlFragment[] {
  const { alias, columns, requiredColumns, tableAlias } = input;
  const baseColumns = EDGE_COLUMNS.filter((column) =>
    shouldProjectColumn(requiredColumns, column),
  ).map(
    (column) =>
      sql`${compileColumnReference(tableAlias, column)} AS ${sql.raw(declareAliasColumn(columns, alias, column))}`,
  );
  return appendSelectivePropsColumns(baseColumns, input);
}

type BuildStandardStartCteInput = Readonly<{
  ast: QueryAst;
  ctx: PredicateCompilerContext;
  graphId: string;
  names: SqlStatementNames;
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

  const cteName = declareAliasCte(input.names, alias);
  return sql`
    ${sql.raw(cteName)} AS ${cteMaterialization}(
      SELECT ${sql.join(
        compileNodeSelectColumns({
          alias,
          columns: input.names.relationColumns(cteName),
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
  names: SqlStatementNames;
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
    names,
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

  const edgeRowFilter = temporalFilterPass.forTraversalEdges(traversal, "e");
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
    edgeRowFilter,
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
  const cteName = declareAliasCte(names, nodeAlias);
  const columns = names.relationColumns(cteName);
  const previousCteName = aliasCteName(previousAlias);
  // `previous.*` brings every column of the previous CTE into this one, so
  // those names are declared here too and meet this CTE's own columns.
  if (carryForwardPreviousColumns)
    columns.inherit(names.relationColumns(previousCteName));
  const previousRowColumns =
    carryForwardPreviousColumns ?
      [readEveryColumnOf(previousCteName)]
    : [
        sql`${readAliasColumn(previousCteName, previousAlias, "id")} AS ${sql.raw(declareAliasColumn(columns, previousAlias, "id"))}`,
        sql`${readAliasColumn(previousCteName, previousAlias, "kind")} AS ${sql.raw(declareAliasColumn(columns, previousAlias, "kind"))}`,
      ];
  const selectColumns = [
    ...previousRowColumns,
    ...compileEdgeSelectColumns({
      alias: edgeAlias,
      columns,
      dialect: ctx.dialect,
      requiredColumns: requiredEdgeColumns,
      selectiveFields: ast.selectiveFields,
      tableAlias: "e",
    }),
    ...compileNodeSelectColumns({
      alias: nodeAlias,
      columns,
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

  // A traversal CTE holds one row per edge matched from its frontier, and the
  // outer query joins it back on the frontier node's (id, kind). The start CTE
  // holds each node once, but an earlier traversal's CTE holds a node once per
  // path into it; expanding each of those rows and then joining on the node
  // would return every path once per path. So unless this CTE carries the
  // whole path forward itself, it expands each frontier node exactly once. The
  // derived table keeps the CTE's name, so the frontier reads the same either
  // way.
  const frontierHoldsOneRowPerNode =
    carryForwardPreviousColumns || previousAlias === ast.start.alias;
  const frontierSource =
    frontierHoldsOneRowPerNode ?
      sql`${sql.raw(previousCteName)}`
    : sql`(SELECT DISTINCT ${readUnqualifiedColumn([previousCteName], aliasColumnName(previousAlias, "id"))}, ${readUnqualifiedColumn([previousCteName], aliasColumnName(previousAlias, "kind"))} FROM ${sql.raw(previousCteName)}) AS ${sql.raw(previousCteName)}`;

  // The frontier join reads the previous alias's id and kind by name.
  const previousIdColumn = readAliasColumn(
    previousCteName,
    previousAlias,
    "id",
  );
  const previousKindColumn = readAliasColumn(
    previousCteName,
    previousAlias,
    "kind",
  );
  const identityFrontierExpansion =
    traversal.includeIdentityMembers === true ?
      planIdentityFrontierExpansion({
        ast,
        ctx,
        graphId,
        previousId: previousIdColumn,
        previousKind: previousKindColumn,
        temporalFilterPass,
      })
    : undefined;

  // A widened frontier reaches the edge through COALESCE over an outer join, so
  // the engine sees no plain frontier-to-edge equality to plan from and may drive
  // the nested loop from the edge table instead — a rescan of every candidate
  // edge per frontier row, which is the cost typegraph#270 removes. Pinning the
  // frontier ahead of the edge table restores the indexed
  // (graph_id, from_kind, from_id) seek on engines that read FROM order as a
  // directive; the same planner control the recursive emitter applies to its
  // worktable, so it rides the same capability. A traversal without identity
  // expansion joins on the frontier's own columns and needs no pin, so its SQL is
  // left untouched.
  const pinFrontierAheadOfEdges =
    identityFrontierExpansion !== undefined &&
    ctx.dialect.capabilities.forceRecursiveWorktableOuterJoinOrder;

  /**
   * Connects a candidate edge to the frontier. A widened frontier and a plain
   * one join the edge the same way — on the frontier row's (kind, id) or on the
   * class member's — so no traversal reaches an edge through a correlated
   * membership test.
   */
  function compileSourceJoin(
    branch: Readonly<{
      joinField: "from_id" | "to_id";
      joinKindField: "from_kind" | "to_kind";
    }>,
  ): SqlFragment {
    const edgeId = sql`e.${sql.raw(branch.joinField)}`;
    const edgeKind = sql`e.${sql.raw(branch.joinKindField)}`;
    if (identityFrontierExpansion !== undefined) {
      return sql`
        ${identityFrontierExpansion.memberId} = ${edgeId}
        AND ${identityFrontierExpansion.memberKind} = ${edgeKind}
      `;
    }
    return sql`
      ${previousIdColumn} = ${edgeId}
      AND ${previousKindColumn} = ${edgeKind}
    `;
  }

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
      // Conditions the frontier widening cannot state in a join condition —
      // currently the member-visibility guard. Every branch of the step carries
      // them, because every branch reads the widened frontier.
      ...(identityFrontierExpansion?.whereClauses ?? []),
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

    const sourceJoin = compileSourceJoin(branch);
    const frontierJoin = identityFrontierExpansion?.frontierJoin ?? sql``;

    // The target join is spelled out in both orderings rather than hoisted into
    // a shared fragment: interpolating one would surround it with the
    // fragment's own leading and trailing newlines, and a traversal that needs
    // no pin has to compile byte-identically to what it did before the pin
    // existed. The recursive emitter repeats it for the same reason.
    if (pinFrontierAheadOfEdges) {
      return sql`
        SELECT ${sql.join(selectColumns, sql`, `)}
        FROM ${frontierSource}
        ${frontierJoin}
        CROSS JOIN ${ctx.schema.edgesTable} e
        JOIN ${ctx.schema.nodesTable} n ON n.graph_id = e.graph_id
          AND n.id = e.${sql.raw(branch.targetField)}
          AND n.kind = e.${sql.raw(branch.targetKindField)}
        WHERE ${sql.join([sourceJoin, ...whereClauses], sql` AND `)}
      `;
    }

    return sql`
      SELECT ${sql.join(selectColumns, sql`, `)}
      FROM ${frontierSource}
      ${frontierJoin}
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
        ${sql.raw(cteName)} AS ${cteMaterialization}(
          SELECT * FROM (
            ${directBranch}
          ) AS traversal_rows
          LIMIT ${traversalLimitValue}
        )
      `;
    }

    return sql`
      ${sql.raw(cteName)} AS ${cteMaterialization}(
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

  const duplicateGuard = compileInverseTraversalDuplicateGuard(
    directEdgeKinds,
    inverseEdgeKinds,
    (overlappingKinds) =>
      compileKindFilter(sql.raw("e.kind"), overlappingKinds),
  );

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
      ${sql.raw(cteName)} AS ${cteMaterialization}(
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
    ${sql.raw(cteName)} AS ${cteMaterialization}(
      ${directBranch}
      UNION ALL
      ${inverseBranch}
    )
  `;
}

function compileAggregateExprFromSource(
  expr: AggregateExpr,
  dialect: DialectAdapter,
  cteAliasOverride?: string,
): SqlFragment {
  validateAggregateOperand(expr);
  const { field } = expr;
  return compileLegacyAggregateExpression(expr, {
    dialect,
    resolveFieldCteAlias() {
      return cteAliasOverride ?? aliasCteName(field.alias);
    },
  });
}

function compileProjectedSource(
  field: {
    cteAlias?: string;
    source: DatabaseExpression | FieldRef | AggregateExpr;
  },
  ast: QueryAst,
  ctx: PredicateCompilerContext,
  cteAliasOverride?: string,
): SqlFragment {
  const { dialect } = ctx;
  const cteAlias = cteAliasOverride ?? field.cteAlias;
  if (field.source.__type === "database_expression") {
    return compileStandardDatabaseExpression(ast, field.source, ctx, cteAlias);
  }
  if (isAggregateExpr(field.source)) {
    return compileAggregateExprFromSource(field.source, dialect, cteAlias);
  }
  return compileFieldValue(
    field.source,
    dialect,
    field.source.valueType,
    cteAlias ?? aliasCteName(field.source.alias),
  );
}

type BuildStandardProjectionInput = Readonly<{
  ast: QueryAst;
  collapsedTraversalCteAlias?: string;
  ctx: PredicateCompilerContext;
  names: SqlStatementNames;
}>;

/** Describes the value a projected field reads, for a name-collision refusal. */
export function describeProjectedField(
  field: Readonly<{
    outputName: string;
    source: DatabaseExpression | FieldRef | AggregateExpr;
  }>,
): string {
  const source = field.source;
  if (source.__type === "field_ref") {
    const path = [
      ...source.path,
      ...(source.jsonPointer === undefined ? [] : [source.jsonPointer]),
    ].join(".");
    return `${path} of alias "${source.alias}"`;
  }
  return `the value selected as "${field.outputName}"`;
}

/** Describes the value a selectively projected field reads, for a refusal. */
function describeSelectiveField(field: SelectiveField): string {
  return `${field.isSystemField ? "" : "property "}${field.field} of alias "${field.alias}"`;
}

export function buildStandardProjection(
  input: BuildStandardProjectionInput,
): SqlFragment {
  const { ast, collapsedTraversalCteAlias, ctx, names } = input;
  if (ast.selectiveFields && ast.selectiveFields.length > 0) {
    return compileSelectiveProjection(
      ast.selectiveFields,
      ast,
      names,
      collapsedTraversalCteAlias,
    );
  }

  const fields = ast.projection.fields;
  if (fields.length === 0) {
    // `SELECT *` returns every column of every relation in the FROM clause,
    // under names the caller then reads.
    const fromRelations =
      collapsedTraversalCteAlias === undefined ?
        [
          aliasCteName(ast.start.alias),
          ...ast.traversals.map((traversal) =>
            aliasCteName(traversal.nodeAlias),
          ),
        ]
      : [collapsedTraversalCteAlias];
    for (const relation of fromRelations)
      names.results.inherit(names.relationColumns(relation));
    return readEveryColumn(fromRelations);
  }

  const projectedFields = fields.map((field) => {
    const source = compileProjectedSource(
      field,
      ast,
      ctx,
      collapsedTraversalCteAlias,
    );
    const outputName = declareResultColumn(
      names,
      field.outputName,
      describeProjectedField(field),
    );
    return sql`${source} AS ${quoteIdentifier(outputName)}`;
  });
  return sql.join(projectedFields, sql`, `);
}

/**
 * Builds a map from query aliases (node and edge) to their CTE table names.
 * Edge aliases map to the CTE of the traversal node they are co-projected with.
 */
function buildAliasToCteMap(ast: QueryAst): Map<string, string> {
  const map = new Map<string, string>([
    [ast.start.alias, aliasCteName(ast.start.alias)],
  ]);
  for (const traversal of ast.traversals) {
    map.set(traversal.nodeAlias, aliasCteName(traversal.nodeAlias));
    map.set(traversal.edgeAlias, aliasCteName(traversal.nodeAlias));
  }
  return map;
}

function compileSelectiveProjection(
  fields: readonly SelectiveField[],
  ast: QueryAst,
  names: SqlStatementNames,
  collapsedTraversalCteAlias?: string,
): SqlFragment {
  const aliasToCte = buildAliasToCteMap(ast);

  const columns = fields.map((field) => {
    const cteAlias =
      collapsedTraversalCteAlias ??
      aliasToCte.get(field.alias) ??
      aliasCteName(field.alias);
    const outputName = declareResultColumn(
      names,
      field.outputName,
      describeSelectiveField(field),
    );

    if (field.isSystemField) {
      const dbColumn = mapSelectiveSystemFieldToColumn(field.field);

      return sql`${readAliasColumn(cteAlias, field.alias, dbColumn)} AS ${quoteIdentifier(outputName)}`;
    }

    return sql`${readColumn(cteAlias, selectivePropsCteColumnName(field), "quoted-name")} AS ${quoteIdentifier(outputName)}`;
  });

  return sql.join(columns, sql`, `);
}

function compileOrderFieldValue(
  ast: QueryAst,
  field: DatabaseExpression | FieldRef,
  dialect: DialectAdapter,
  cteAlias: string,
): SqlFragment {
  if (field.__type === "database_expression") {
    return compileStandardDatabaseExpression(ast, field, dialect, cteAlias);
  }
  const selectiveField = findSelectivePropsFieldForFieldRef(
    ast.selectiveFields,
    field,
  );
  if (selectiveField !== undefined) {
    return readColumn(
      cteAlias,
      selectivePropsCteColumnName(selectiveField),
      "quoted-name",
    );
  }

  return compileFieldValue(field, dialect, field.valueType, cteAlias);
}

function compileStandardDatabaseExpression(
  ast: QueryAst,
  expression: DatabaseExpression,
  context: PredicateCompilerContext | DialectAdapter,
  cteAliasOverride?: string,
  allowAggregates = true,
): SqlFragment {
  const ctx = isPredicateCompilerContext(context) ? context : undefined;
  const dialect =
    isPredicateCompilerContext(context) ? context.dialect : context;
  const aliasToCte = buildAliasToCteMap(ast);
  return compileDatabaseExpression(expression, {
    allowAggregates,
    ...(allowAggregates ? {} : { aggregateClause: "GROUP BY" }),
    dialect,
    orderedAggregates: ctx?.orderedAggregates ?? true,
    ...(ctx?.compileExpressionSubquery === undefined ?
      {}
    : { compileSubquery: ctx.compileExpressionSubquery }),
    ...(ctx?.compileExpressionOuterReference === undefined ?
      {}
    : { compileOuterReference: ctx.compileExpressionOuterReference }),
    resolveFieldCteAlias(field) {
      return cteAliasOverride ?? aliasToCte.get(field.alias);
    },
  });
}

function isPredicateCompilerContext(
  context: DialectAdapter | PredicateCompilerContext,
): context is PredicateCompilerContext {
  return "schema" in context;
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
      buildRelevanceJoin(
        HYBRID_CANDIDATES_CTE_ALIAS,
        hybridTargetAlias,
        "INNER JOIN",
      ),
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

function buildRelevanceJoin(
  cteAlias: string,
  nodeAlias: string,
  joinType = "INNER JOIN",
): SqlFragment {
  const cte = sql.raw(cteAlias);
  const nodeCteName = aliasCteName(nodeAlias);
  return sql`${sql.raw(joinType)} ${cte} ON ${readColumn(cteAlias, "node_id")} = ${readAliasColumn(nodeCteName, nodeAlias, "id")} AND ${readColumn(cteAlias, "node_kind")} = ${readAliasColumn(nodeCteName, nodeAlias, "kind")}`;
}

type BuildStandardFromClauseInput = Readonly<{
  ast: QueryAst;
  collapsedTraversalCteAlias?: string;
  fulltextPredicate?: FulltextMatchPredicate;
  vectorPredicate?: VectorSimilarityPredicate;
}>;

export function buildStandardFromClause(
  input: BuildStandardFromClauseInput,
): StandardFromClause {
  const {
    ast,
    collapsedTraversalCteAlias,
    fulltextPredicate,
    vectorPredicate,
  } = input;
  if (collapsedTraversalCteAlias !== undefined) {
    return {
      sql: sql`FROM ${sql.raw(collapsedTraversalCteAlias)}`,
      relations: [collapsedTraversalCteAlias],
    };
  }

  const startAlias = ast.start.alias;
  const fromClause = sql`FROM ${sql.raw(aliasCteName(startAlias))}`;
  const relations = [
    aliasCteName(startAlias),
    ...ast.traversals.map((traversal) => aliasCteName(traversal.nodeAlias)),
    ...relevanceRelations(vectorPredicate, fulltextPredicate),
  ];

  const joins: SqlFragment[] = [];
  for (const traversal of ast.traversals) {
    const cteAlias = aliasCteName(traversal.nodeAlias);
    const previousAlias = traversal.joinFromAlias;
    const previousCteName = aliasCteName(previousAlias);
    const joinType = traversal.optional ? "LEFT JOIN" : "INNER JOIN";
    // The join reads the previous alias's id and kind by name on both sides.
    joins.push(
      sql`${sql.raw(joinType)} ${sql.raw(cteAlias)} ON ${readAliasColumn(cteAlias, previousAlias, "id")} = ${readAliasColumn(previousCteName, previousAlias, "id")} AND ${readAliasColumn(cteAlias, previousAlias, "kind")} = ${readAliasColumn(previousCteName, previousAlias, "kind")}`,
    );
  }

  // Node IDs are unique only within a kind (PK is graph_id, kind, id),
  // so the relevance-CTE joins must include node_kind. Without it,
  // polymorphic queries would cross-join on user-supplied ids shared
  // across kinds.
  for (const join of buildRelevanceJoins(vectorPredicate, fulltextPredicate)) {
    joins.push(join);
  }

  return {
    sql:
      joins.length === 0 ?
        fromClause
      : sql`${fromClause} ${sql.join(joins, sql` `)}`,
    relations,
  };
}

/** The relevance relations {@link buildRelevanceJoins} joins, in order. */
function relevanceRelations(
  vectorPredicate: VectorSimilarityPredicate | undefined,
  fulltextPredicate: FulltextMatchPredicate | undefined,
): readonly string[] {
  if (getHybridTargetAlias(vectorPredicate, fulltextPredicate) !== undefined)
    return [
      HYBRID_CANDIDATES_CTE_ALIAS,
      EMBEDDINGS_CTE_ALIAS,
      FULLTEXT_CTE_ALIAS,
    ];
  return [
    ...(vectorPredicate === undefined ? [] : [EMBEDDINGS_CTE_ALIAS]),
    ...(fulltextPredicate === undefined ? [] : [FULLTEXT_CTE_ALIAS]),
  ];
}

type BuildStandardOrderByInput = Readonly<{
  ast: QueryAst;
  collapsedTraversalCteAlias?: string;
  dialect: DialectAdapter;
}>;

export function buildStandardOrderBy(
  input: BuildStandardOrderByInput,
): SqlFragment | undefined {
  const parts = compileStandardOrderTerms(input);
  if (parts.length === 0) return undefined;
  return sql`ORDER BY ${sql.join(parts, sql`, `)}`;
}

/**
 * The caller's `orderBy()` terms, in order: field terms, then terms naming an
 * `aggregate()` / `project()` output. The one owner of user ordering — the
 * plain ORDER BY and the relevance ORDER BYs (vector, fulltext, hybrid RRF),
 * which append these after their relevance term, both read it.
 */
function compileStandardOrderTerms(
  input: BuildStandardOrderByInput,
): readonly SqlFragment[] {
  const { ast, collapsedTraversalCteAlias, dialect } = input;
  const fieldOrderBy = ast.orderBy ?? [];
  const aggregateOrderBy = ast.aggregateOrderBy ?? [];
  if (fieldOrderBy.length === 0 && aggregateOrderBy.length === 0) {
    return [];
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
      (orderSpec.field.__type === "field_ref" ?
        (aliasToCte?.get(orderSpec.field.alias) ??
        aliasCteName(orderSpec.field.alias))
      : undefined) ??
      "";
    const field = compileOrderFieldValue(
      ast,
      orderSpec.field,
      dialect,
      cteAlias,
    );
    const nulls = resolveNullOrdering(orderSpec);
    parts.push(compileOrderTerm(field, orderSpec.direction, nulls));
  }

  // Aggregate ordering references the projected SELECT-list output alias
  // directly rather than recompiling a FieldRef/AggregateExpr — every
  // `.aggregate()` field (grouped or aggregated) is always projected with
  // an alias, and both SQLite and PostgreSQL allow ORDER BY to reference
  // it, so this needs no per-CTE or per-dialect resolution.
  //
  for (const orderSpec of aggregateOrderBy) {
    const column = quoteIdentifier(orderSpec.outputName);
    const nulls = resolveNullOrdering(orderSpec);
    parts.push(compileOrderTerm(column, orderSpec.direction, nulls));
  }

  return parts;
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
  fromClause: StandardFromClause;
  names: SqlStatementNames;
  where?: SqlFragment;
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
  const { ast, collapsedTraversalCteAlias, dialect, fromClause, names } = input;
  const topKName = declareFixedCte(names, LATE_MAT_TOPK_CTE_ALIAS);
  const topKColumns = names.relationColumns(topKName);
  const aliasToCte = buildAliasToCteMap(ast);
  const cteAliasFor = (alias: string): string =>
    collapsedTraversalCteAlias ?? aliasToCte.get(alias) ?? aliasCteName(alias);

  const columns: SqlFragment[] = [];
  for (const alias of lateMaterializedNodeAliases(ast)) {
    const cteAlias = cteAliasFor(alias);
    columns.push(
      sql`${readAliasColumn(cteAlias, alias, "id")} AS ${sql.raw(declareAliasColumn(topKColumns, alias, "id"))}`,
      sql`${readAliasColumn(cteAlias, alias, "kind")} AS ${sql.raw(declareAliasColumn(topKColumns, alias, "kind"))}`,
    );
  }
  for (const [index, orderSpec] of (ast.orderBy ?? []).entries()) {
    const value = compileOrderFieldValue(
      ast,
      orderSpec.field,
      dialect,
      orderSpec.field.__type === "field_ref" ?
        cteAliasFor(orderSpec.field.alias)
      : (collapsedTraversalCteAlias ?? ""),
    );
    const sortKey = `${LATE_MAT_SORT_KEY_PREFIX}${index}`;
    topKColumns.register(
      sortKey,
      `sort-key\u0000${index}`,
      `sort key ${index}`,
    );
    columns.push(sql`${value} AS ${sql.raw(sortKey)}`);
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
    dialect,
  });

  const parts: SqlFragment[] = [
    sql`SELECT ${sql.join(columns, sql`, `)}`,
    fromClause.sql,
  ];
  if (input.where !== undefined) parts.push(input.where);
  if (innerOrderBy !== undefined) parts.push(innerOrderBy);
  if (limitOffset !== undefined) parts.push(limitOffset);

  // Unqualified references in this SELECT resolve in the relations of its FROM.
  const select = bindUnresolvedColumnReads(
    sql.join(parts, sql` `),
    fromClause.relations,
  );
  return sql`${sql.raw(topKName)} AS (${select})`;
}

/**
 * The outer projection: each selective field sourced from the re-joined
 * physical node table alias `lm_<alias>` rather than a candidate CTE, so the
 * deferred columns are read only for the surviving rows.
 */
export function buildLateMaterializedOuterProjection(
  ast: QueryAst,
  dialect: DialectAdapter,
  names: SqlStatementNames,
): SqlFragment {
  const columns = (ast.selectiveFields ?? []).map((field) => {
    const physicalAlias = lateMaterializedPhysicalAlias(field.alias);
    const outputName = declareResultColumn(
      names,
      field.outputName,
      describeSelectiveField(field),
    );
    if (field.isSystemField) {
      const dbColumn = mapSelectiveSystemFieldToColumn(field.field);
      return sql`${compileColumnReference(physicalAlias, dbColumn)} AS ${quoteIdentifier(outputName)}`;
    }
    const extracted = compileSelectivePropsExtraction(
      field,
      compileColumnReference(physicalAlias, "props"),
      dialect,
    );
    return sql`${extracted} AS ${quoteIdentifier(outputName)}`;
  });
  return sql.join(columns, sql`, `);
}

/**
 * The outer ORDER BY: re-orders the LIMIT survivors by the `__lm_sk{n}` sort
 * values carried out of the topK CTE, matching `buildStandardOrderBy`'s
 * null-ordering semantics.
 */
export function buildLateMaterializedOuterOrderBy(
  ast: QueryAst,
): SqlFragment | undefined {
  const orderBy = ast.orderBy ?? [];
  if (orderBy.length === 0) return undefined;
  const parts: SqlFragment[] = [];
  for (const [index, orderSpec] of orderBy.entries()) {
    const column = readColumn(
      LATE_MAT_TOPK_CTE_ALIAS,
      `${LATE_MAT_SORT_KEY_PREFIX}${index}`,
    );
    const nulls = resolveNullOrdering(orderSpec);
    parts.push(compileOrderTerm(column, orderSpec.direction, nulls));
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
  const allFields: (DatabaseExpression | FieldRef)[] = [];

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
    if (field.__type === "database_expression") {
      allFields.push(field);
      continue;
    }
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
    field.__type === "database_expression" ?
      compileStandardDatabaseExpression(ast, field, dialect, undefined, false)
    : compileFieldValue(
        field,
        dialect,
        field.valueType,
        aliasToCte.get(field.alias) ?? aliasCteName(field.alias),
      ),
  );

  return sql`GROUP BY ${sql.join(parts, sql`, `)}`;
}

/** Filters completed alias matches, never the candidate or optional-match CTEs. */
export function buildStandardResultWhere(
  input: Readonly<{
    ast: QueryAst;
    ctx: PredicateCompilerContext;
  }>,
): SqlFragment | undefined {
  const { ast, ctx } = input;
  if (ast.resultPredicate === undefined) return undefined;
  const aliases = buildAliasToCteMap(ast);
  const condition = compilePredicateExpression(ast.resultPredicate, {
    ...ctx,
    databaseExpressionAggregates: false,
    resolveFieldCteAlias: (field) =>
      aliases.get(field.alias) ?? aliasCteName(field.alias),
  });
  return sql`WHERE ${condition}`;
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

  const condition = compilePredicateExpression(ast.having, {
    ...ctx,
    databaseExpressionAggregates: true,
  });
  return sql`HAVING ${condition}`;
}

type BuildStandardEmbeddingsCteInput = Readonly<{
  ctx: PredicateCompilerContext;
  graphId: string;
  names: SqlStatementNames;
  nodeKinds: readonly string[];
  vectorPredicate: VectorSimilarityPredicate;
}>;

/** The columns `cte_embeddings` emits, in its SELECT list's order. */
const EMBEDDINGS_CTE_COLUMNS = [
  "node_id",
  "node_kind",
  "distance",
  "score",
  "ord",
] as const;

/** The columns `cte_fulltext` emits, in its SELECT list's order. */
const FULLTEXT_CTE_COLUMNS = ["node_id", "node_kind", "rank", "ord"] as const;

/** The columns `cte_relevance_candidates` emits, in its SELECT list's order. */
const HYBRID_CANDIDATES_CTE_COLUMNS = ["node_id", "node_kind"] as const;

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
 * slot declared `indexType: "none"` degrades to the exact scan, and a
 * `metric` override the slot's ANN structure cannot serve is refused rather
 * than degraded (see {@link assertApproximateMetricSupported}).
 */
export function buildStandardEmbeddingsCte(
  input: BuildStandardEmbeddingsCteInput,
): SqlFragment {
  const { ctx, graphId, names, nodeKinds, vectorPredicate } = input;
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
    // metric (the one its ANN index was built for). Resolving per kind keeps a
    // subclass-expanded union correct when subkinds declare different metrics.
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
    // true nearest neighbors.
    //
    // A caller who STATED `approximate: true` for such a slot is refused
    // ({@link assertApproximateMetricSupported}) rather than quietly served
    // the exact scan: the two options cannot both be honored, and which one
    // was dropped is not something the caller can see in the results. Where
    // nothing was stated the fallback stays silent because nothing is being
    // ignored — engines whose `buildSearch` is EXACT (vec0's brute-force C
    // KNN) serve the non-approximate branch through the engine form when the
    // metric matches (identical results to the SQL distance scan at engine
    // speed: 489ms -> 113ms at 50k on the SQLite lane) and through the SQL
    // scan when it does not.
    if (slotDescriptor !== undefined) {
      assertApproximateMetricSupported({
        approximate: vectorPredicate.approximate,
        requestedMetric: metric,
        declaredMetric: slotDescriptor.metric,
        indexType: slotDescriptor.indexType,
        nodeKind: kind,
        fieldPath,
      });
    }
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
      const candidateCte = aliasCteName(field.alias);
      const kindCandidates = sql`SELECT ${readAliasColumn(candidateCte, field.alias, "id")} FROM ${sql.raw(candidateCte)} WHERE ${readAliasColumn(candidateCte, field.alias, "kind")} = ${kind}`;
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
        branchMetric === "cosine" ?
          sql`(1.0 - ${readDerivedTableColumn("score")})`
        : readDerivedTableColumn("score");
      return sql`
        SELECT ${readDerivedTableColumn("node_id")}, ${kind} AS node_kind, ${distanceFromScore} AS distance, ${readDerivedTableColumn("score")}
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
  declareFixedCteWithColumns(
    names,
    EMBEDDINGS_CTE_ALIAS,
    EMBEDDINGS_CTE_COLUMNS,
  );
  // `ord` is computed here; the other columns are read from `vec_inner`.
  return sql`
    ${sql.raw(EMBEDDINGS_CTE_ALIAS)} AS (
      SELECT
        ${readDerivedTableColumn("node_id")},
        ${readDerivedTableColumn("node_kind")},
        ${readDerivedTableColumn("distance")},
        ${readDerivedTableColumn("score")},
        ROW_NUMBER() OVER (ORDER BY ${readDerivedTableColumn("distance")} ASC) AS ord
      FROM (
        ${unionBody}
        ORDER BY ${readDerivedTableColumn("distance")} ASC
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
  names: SqlStatementNames;
  nodeKinds: readonly string[];
}>;

export function buildStandardFulltextCte(
  input: BuildStandardFulltextCteInput,
): SqlFragment {
  const { ctx, fulltextPredicate, graphId, names, nodeKinds } = input;
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
  declareFixedCteWithColumns(names, FULLTEXT_CTE_ALIAS, FULLTEXT_CTE_COLUMNS);
  // `ord` is computed here; the other columns are read from `fts_inner`.
  return sql`
    ${sql.raw(FULLTEXT_CTE_ALIAS)} AS (
      SELECT
        ${readDerivedTableColumn("node_id")},
        ${readDerivedTableColumn("node_kind")},
        ${readDerivedTableColumn("rank")},
        ROW_NUMBER() OVER (ORDER BY ${readDerivedTableColumn("rank")} DESC, ${readDerivedTableColumn("node_id")} ASC) AS ord
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
        ORDER BY ${readDerivedTableColumn("rank")} DESC, ${qualifyColumn(tableName, "node_id")} ASC
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

export function buildStandardHybridCandidateCte(
  names: SqlStatementNames,
): SqlFragment {
  declareFixedCteWithColumns(
    names,
    HYBRID_CANDIDATES_CTE_ALIAS,
    HYBRID_CANDIDATES_CTE_COLUMNS,
  );
  return sql`
    ${sql.raw(HYBRID_CANDIDATES_CTE_ALIAS)} AS (
      SELECT ${readUnqualifiedColumn([EMBEDDINGS_CTE_ALIAS], "node_id")}, ${readUnqualifiedColumn([EMBEDDINGS_CTE_ALIAS], "node_kind")} FROM ${sql.raw(EMBEDDINGS_CTE_ALIAS)}
      UNION
      SELECT ${readUnqualifiedColumn([FULLTEXT_CTE_ALIAS], "node_id")}, ${readUnqualifiedColumn([FULLTEXT_CTE_ALIAS], "node_kind")} FROM ${sql.raw(FULLTEXT_CTE_ALIAS)}
    )
  `;
}

type RelevanceSortValueInput = Readonly<{
  /** Whether the statement's result rows are groups (`isAggregatedStatement`). */
  aggregated: boolean;
  dialect: DialectAdapter;
  fusion: HybridFusionOptions | undefined;
}>;

/**
 * The reciprocal-rank-fusion score of one hybrid match. Each CTE emits an
 * `ord` ordinal via ROW_NUMBER; the score blends them as
 * `w_vec / (k + ord_vec) + w_ft / (k + ord_ft)`. NULL `ord` (a node matched
 * by only one source) makes that source's term NULL → COALESCE-to-0 absorbs
 * it.
 *
 * Defaults: k=60, vector weight = fulltext weight = 1. Override via
 * `.fuseWith({ k, weights })` on the query builder.
 */
function compileHybridRrfScore(
  fusion: HybridFusionOptions | undefined,
): SqlFragment {
  const k = fusion?.k ?? DEFAULT_RRF_K;
  const vectorWeight = fusion?.weights?.vector ?? DEFAULT_RRF_WEIGHT;
  const fulltextWeight = fusion?.weights?.fulltext ?? DEFAULT_RRF_WEIGHT;

  // Invariant: validateHybridFusionOptions has already rejected
  // non-finite / negative values before we reach here. sql.raw on these
  // numeric constants is deliberate — they're schema-level config, not
  // user-bindable.
  // `* 1.0` is also deliberate: PostgreSQL otherwise performs integer
  // division when the default weight and rank constant are integers. Keep
  // this promotion in lockstep with the backend hybrid statement emitter.
  return sql`${sql.raw(`(COALESCE((${vectorWeight} * 1.0) / (${k} + `)}${readColumn(EMBEDDINGS_CTE_ALIAS, "ord")}${sql.raw(`), 0) + COALESCE((${fulltextWeight} * 1.0) / (${k} + `)}${readColumn(FULLTEXT_CTE_ALIAS, "ord")}${sql.raw("), 0))")}`;
}

/** The value one relevance sort key reads from a single match row. */
function compileRelevancePerMatchValue(
  source: RelevanceSortSource,
  input: RelevanceSortValueInput,
): SqlFragment {
  switch (source) {
    case "fulltext_rank": {
      return readColumn(FULLTEXT_CTE_ALIAS, "rank");
    }
    case "vector_distance": {
      return readColumn(EMBEDDINGS_CTE_ALIAS, "distance");
    }
    case "hybrid_score": {
      return compileHybridRrfScore(input.fusion);
    }
    case "hybrid_node_id": {
      // Deterministic tiebreak on the CTE-projected node_id. At least one of
      // the two CTEs always has a non-NULL node_id for any row returned by
      // the LEFT JOIN-union shape, so COALESCE always resolves. It compares
      // in byte order (`binaryText`) on every backend, the order of
      // `store.search.hybrid`'s JS-side code-unit tiebreak and of SQLite's
      // BINARY collation, so ties never follow a PostgreSQL database's
      // linguistic collation.
      return input.dialect.binaryText(
        sql`COALESCE(${readColumn(FULLTEXT_CTE_ALIAS, "node_id")}, ${readColumn(EMBEDDINGS_CTE_ALIAS, "node_id")})`,
      );
    }
  }
}

/**
 * The value of one relevance sort key for a result row. When the rows are
 * groups (`isAggregatedStatement`), a group sorts by its best member: `MAX`
 * of a value ordered descending, `MIN` of one ordered ascending, so the
 * relevance order of groups extends the order of matches and every engine
 * accepts the term.
 */
function compileRelevanceSortValue(
  key: RelevanceSortKey,
  input: RelevanceSortValueInput,
): SqlFragment {
  const perMatch = compileRelevancePerMatchValue(key.source, input);
  if (!input.aggregated) return perMatch;
  return sql`${sql.raw(key.direction === "desc" ? "MAX" : "MIN")}(${perMatch})`;
}

type BuildStandardRelevanceOrderByInput = RelevanceSortValueInput &
  Readonly<{
    ast: QueryAst;
    /** `describeRelevanceOrder(ast)`; never empty. */
    keys: readonly RelevanceSortKey[];
  }>;

/**
 * ORDER BY clause of a full-text, vector or hybrid statement: the leading
 * relevance keys (rank DESC, distance ASC, or the fused RRF score DESC), then
 * the caller's `orderBy()` terms as tiebreakers, then the trailing relevance
 * keys (the hybrid node_id tiebreak), so pagination stays stable across ties.
 */
export function buildStandardRelevanceOrderBy(
  input: BuildStandardRelevanceOrderByInput,
): SqlFragment {
  const { ast, dialect, keys } = input;
  const terms = (placement: RelevanceSortKey["placement"]) =>
    keys
      .filter((key) => key.placement === placement)
      .map(
        (key) =>
          sql`${compileRelevanceSortValue(key, input)} ${sql.raw(key.direction === "desc" ? "DESC" : "ASC")}`,
      );
  const userOrders = compileStandardOrderTerms({ ast, dialect });
  return sql`ORDER BY ${sql.join([...terms("leading"), ...userOrders, ...terms("trailing")], sql`, `)}`;
}

type BuildLimitOffsetClauseInput = Readonly<{
  dialect: DialectAdapter;
  limit: number | undefined;
  offset: number | undefined;
}>;

export function buildLimitOffsetClause(
  input: BuildLimitOffsetClauseInput,
): SqlFragment | undefined {
  const parts = compileLimitOffsetClauses(
    input.limit,
    input.offset,
    input.dialect,
  );
  return parts.length > 0 ? sql.join(parts, sql` `) : undefined;
}
