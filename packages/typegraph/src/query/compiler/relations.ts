import { ConfigurationError } from "../../errors";
import type { QueryAst, SortDirection, ValueType } from "../ast";
import {
  type DatabaseExpression,
  haveCompatibleCollectionElements,
} from "../expressions";
import { compileOrderTerm } from "../order";
import { sql, type SqlFragment } from "../sql-fragment";
import { asCompiledSelectSql, type CompiledSelectSql } from "../sql-intent";
import {
  compileDatabaseExpression,
  type DatabaseExpressionCompilerContext,
} from "./database-expressions";
import { compileNameCheckedQuery, type CompileQueryOptions } from "./index";
import { compileLimitOffsetClauses } from "./limit-offset";
import { validateRelationAggregation } from "./relation-aggregate-validation";
import { SELECTION_ORDER_COLUMN } from "./relevance-order";
import { setOperationKeyword } from "./set-operations";
import {
  refuseReservedOutputKeys,
  type SqlNameUsage,
} from "./sql-name-registry";
import { withPinnedReadInstant } from "./temporal";

export type RelationColumn = Readonly<{
  outputName: string;
  valueType: ValueType;
  elementValueType?: ValueType;
  elementFields?: Readonly<Record<string, ValueType>>;
  /**
   * The date positions of a structured property column, opaque as
   * `DatabaseExpression.readPlan` is; read it with `expressionReadPlan`.
   */
  readPlan?: unknown;
  nullable: boolean;
  /** Proven graph-node identity carried only from a direct graph field. */
  identity?: Readonly<{
    component: "id" | "kind";
    alias: string;
  }>;
}> &
  // Whether the column's dates are ones the caller stated.
  Pick<DatabaseExpression, "dateOrigin" | "elementDateOrigins">;

export type RelationOrder = Readonly<{
  expression: DatabaseExpression;
  direction: SortDirection;
  nulls: "first" | "last";
}>;

export type RelationSource = Readonly<{
  kind: "source";
  query: QueryAst;
  graphId: string;
  options: CompileQueryOptions;
}>;

export type DerivedRelation = Readonly<{
  kind: "derived";
  source: RelationAst;
  sourceColumns: readonly RelationColumn[];
  projection: readonly Readonly<{
    column: RelationColumn;
    expression: DatabaseExpression;
  }>[];
  predicate?: DatabaseExpression<boolean | undefined>;
  groupBy?: readonly DatabaseExpression[];
  distinct: boolean;
  orderBy: readonly RelationOrder[];
  limit?: number;
  offset?: number;
}>;

export type SetRelation = Readonly<{
  kind: "set";
  operator: "union" | "unionAll" | "intersect" | "except";
  left: RelationAst;
  right: RelationAst;
  columns: readonly RelationColumn[];
}>;

export type TopPerPartitionRelation = Readonly<{
  kind: "topPerPartition";
  source: RelationAst;
  columns: readonly RelationColumn[];
  partitionBy: readonly DatabaseExpression[];
  orderBy: readonly RelationOrder[];
  limit: number;
}>;

export type RelationAst =
  DerivedRelation | RelationSource | SetRelation | TopPerPartitionRelation;

function relationSources(relation: RelationAst): readonly RelationSource[] {
  switch (relation.kind) {
    case "source": {
      return [relation];
    }
    case "derived": {
      return relationSources(relation.source);
    }
    case "topPerPartition": {
      return relationSources(relation.source);
    }
    case "set": {
      return [
        ...relationSources(relation.left),
        ...relationSources(relation.right),
      ];
    }
  }
}

const SOURCE_ALIAS = "typegraph_relation_source";

/** The hidden column `topPerPartition()` numbers each partition's rows in. */
const PARTITION_RANK_COLUMN = "__tg_partition_rank";

const RELATION_ORDER_COLUMN_PREFIX = "__tg_relation_order_";

const RELATION_SOURCE_ORDER_COLUMN_PREFIX = "__tg_relation_source_order_";

/**
 * The hidden column that carries a relation's `index`th ordering term to the
 * statement around it: the relation builder appends one per ordering term
 * after a derived relation's visible columns.
 */
export function relationOrderColumnName(index: number): string {
  return `${RELATION_ORDER_COLUMN_PREFIX}${index}`;
}

/**
 * The hidden column a relation built from a projection adds to its source
 * query for the projection's `index`th ordering term when no projected
 * column carries that term already.
 */
export function relationSourceOrderColumnName(index: number): string {
  return `${RELATION_SOURCE_ORDER_COLUMN_PREFIX}${index}`;
}

function isRelationSourceOrderColumnName(name: string): boolean {
  if (!name.startsWith(RELATION_SOURCE_ORDER_COLUMN_PREFIX)) return false;
  const index = Number(name.slice(RELATION_SOURCE_ORDER_COLUMN_PREFIX.length));
  return (
    Number.isSafeInteger(index) && relationSourceOrderColumnName(index) === name
  );
}

/**
 * Every column name a relation tree declares other than the hidden ordering
 * columns the relation builder adds: the output keys of each source query,
 * each derived relation's input and output columns, and the columns of each
 * ranked and set relation, nested relations included. A hidden column is
 * recognized only in the slot the builder puts it in: a derived relation's
 * trailing column for its `index`th ordering term, named
 * `relationOrderColumnName(index)`, or a source query's output key spelled
 * `relationSourceOrderColumnName(index)` (no visible column of any relation
 * may be spelled either way).
 */
function declaredRelationColumnNames(relation: RelationAst): readonly string[] {
  switch (relation.kind) {
    case "source": {
      return relation.query.projection.fields
        .map((field) => field.outputName)
        .filter((name) => !isRelationSourceOrderColumnName(name));
    }
    case "derived": {
      const hiddenStart = relation.projection.length - relation.orderBy.length;
      return [
        ...relation.sourceColumns.map((column) => column.outputName),
        ...relation.projection.flatMap(({ column }, index) =>
          (
            index >= hiddenStart &&
            column.outputName === relationOrderColumnName(index - hiddenStart)
          ) ?
            []
          : [column.outputName],
        ),
        ...declaredRelationColumnNames(relation.source),
      ];
    }
    case "topPerPartition": {
      return [
        ...relation.columns.map((column) => column.outputName),
        ...declaredRelationColumnNames(relation.source),
      ];
    }
    case "set": {
      return [
        ...relation.columns.map((column) => column.outputName),
        ...declaredRelationColumnNames(relation.left),
        ...declaredRelationColumnNames(relation.right),
      ];
    }
  }
}

/**
 * Refuses a relation, before any SQL is sent, that declares a column in the
 * reserved `__tg` namespace anywhere in its tree. The builders refuse such a
 * key where it is declared; this covers a relation definition built another
 * way and handed to the public `ExecutableRelationQuery` constructor. The
 * aliases of each source query are refused where it is compiled
 * (`compileQueryWithSqlNames`).
 */
function refuseReservedRelationColumnNames(relation: RelationAst): void {
  refuseReservedOutputKeys(declaredRelationColumnNames(relation));
}

function expressionContext(
  dialect: DatabaseExpressionCompilerContext["dialect"],
  allowAggregates: boolean,
  orderedAggregates: boolean,
): DatabaseExpressionCompilerContext {
  return {
    allowAggregates,
    aggregateClause:
      allowAggregates ? "relation projection" : "relation filter and ordering",
    dialect,
    orderedAggregates,
    compileFieldExpression(field) {
      if (
        field.alias !== "relation" ||
        field.path.length !== 1 ||
        field.path[0] === undefined
      )
        return;
      return sql`${sql.identifier(SOURCE_ALIAS)}.${sql.identifier(field.path[0])}`;
    },
  };
}

function compileExpression(
  expression: DatabaseExpression,
  dialect: DatabaseExpressionCompilerContext["dialect"],
  allowAggregates: boolean,
  orderedAggregates: boolean,
): SqlFragment {
  return compileDatabaseExpression(
    expression,
    expressionContext(dialect, allowAggregates, orderedAggregates),
  );
}

/**
 * Whether `expression` reads the selection-order column of the query a
 * relation reads from (`SELECTION_ORDER_COLUMN`, see `selectionOrderColumn`):
 * the ordering term a relation over a relevance-ordered query inherits.
 */
export function readsSelectionOrder(expression: DatabaseExpression): boolean {
  const { node } = expression;
  return (
    node.kind === "field" &&
    node.field.alias === "relation" &&
    node.field.path.length === 1 &&
    node.field.path[0] === SELECTION_ORDER_COLUMN
  );
}

/**
 * Compiles an expression of a derived relation's projection or ordering.
 * When `selectionGroups` holds (a grouped or distinct relation ordered by its source's
 * selection order, see {@link compileDerived}), the selection-order column
 * reads each distinct row's best occurrence, `MIN` of its rank.
 */
function compileDerivedExpression(
  expression: DatabaseExpression,
  dialect: DatabaseExpressionCompilerContext["dialect"],
  allowAggregates: boolean,
  orderedAggregates: boolean,
  selectionGroups: boolean,
): SqlFragment {
  const compiled = compileExpression(
    expression,
    dialect,
    allowAggregates,
    orderedAggregates,
  );
  return selectionGroups && readsSelectionOrder(expression) ?
      sql`MIN(${compiled})`
    : compiled;
}

function compileOrder(
  orderBy: readonly RelationOrder[],
  dialect: DatabaseExpressionCompilerContext["dialect"],
  orderedAggregates: boolean,
  selectionGroups = false,
): SqlFragment {
  if (orderBy.length === 0) return sql.empty();
  if (orderBy.some((order) => order.expression.elementValueType !== undefined))
    throw new ConfigurationError(
      "Relation ordering requires scalar keys; collection-valued ordering is unsupported.",
    );
  return sql` ORDER BY ${sql.join(
    orderBy.map((order) =>
      compileOrderTerm(
        compileDerivedExpression(
          order.expression,
          dialect,
          false,
          orderedAggregates,
          selectionGroups,
        ),
        order.direction,
        order.nulls,
      ),
    ),
    sql`, `,
  )}`;
}

function compileDerived(
  relation: DerivedRelation,
  dialect: DatabaseExpressionCompilerContext["dialect"],
  orderedAggregates: boolean,
): CompiledSelectSql {
  // A relation whose rows are groups (`distinct()` or `groupBy()`) and that
  // is ordered by its source's selection order sorts each group by its best
  // occurrence, as a search statement sorts a group by its best member: it
  // reads the smallest rank of each group. A distinct relation groups by
  // every other projected value, which is what DISTINCT compares (its other
  // ordering terms read projected columns, and a grouped relation's projected
  // values are determined by its grouping, so grouping by them instead
  // selects the same distinct rows).
  const selectionGroups =
    (relation.distinct || (relation.groupBy?.length ?? 0) > 0) &&
    relation.orderBy.some((order) => readsSelectionOrder(order.expression));
  validateRelationAggregation(
    relation.projection
      .map(({ expression }) => expression)
      .filter(
        (expression) => !(selectionGroups && readsSelectionOrder(expression)),
      ),
    relation.groupBy,
  );
  const source = compileRelationPart(relation.source, dialect, "wrapped");
  const projection = sql.join(
    relation.projection.map(
      ({ column, expression }) =>
        sql`${compileDerivedExpression(expression, dialect, true, orderedAggregates, selectionGroups)} AS ${sql.identifier(column.outputName)}`,
    ),
    sql`, `,
  );
  const predicate =
    relation.predicate === undefined ?
      sql.empty()
    : sql` WHERE ${compileExpression(relation.predicate, dialect, false, orderedAggregates)}`;
  const groupExpressions =
    selectionGroups && relation.distinct ?
      relation.projection
        .map(({ expression }) => expression)
        .filter((expression) => !readsSelectionOrder(expression))
    : (relation.groupBy ?? []);
  const groupBy =
    groupExpressions.length === 0 ?
      sql.empty()
    : sql` GROUP BY ${sql.join(
        groupExpressions.map((expression) =>
          compileExpression(expression, dialect, false, orderedAggregates),
        ),
        sql`, `,
      )}`;
  const distinct = relation.distinct && !selectionGroups;
  return asCompiledSelectSql(
    sql`SELECT ${distinct ? sql.raw("DISTINCT ") : sql.empty()}${projection} FROM (${source}) AS ${sql.identifier(SOURCE_ALIAS)}${predicate}${groupBy}${compileOrder(relation.orderBy, dialect, orderedAggregates, selectionGroups)} ${sql.join(compileLimitOffsetClauses(relation.limit, relation.offset, dialect), sql` `)}`,
  );
}

function compileTopPerPartition(
  relation: TopPerPartitionRelation,
  dialect: DatabaseExpressionCompilerContext["dialect"],
  orderedAggregates: boolean,
): CompiledSelectSql {
  const source = compileRelationPart(relation.source, dialect, "wrapped");
  const partition = sql.join(
    relation.partitionBy.map((expression) =>
      compileExpression(expression, dialect, false, orderedAggregates),
    ),
    sql`, `,
  );
  const ordering = compileOrder(relation.orderBy, dialect, orderedAggregates);
  // No column of the relation falls in the reserved `__tg` namespace
  // (`refuseReservedRelationColumnNames`), so this hidden column meets none.
  const rankName = PARTITION_RANK_COLUMN;
  const selectedColumns = sql.join(
    relation.columns.map(
      (column) =>
        sql`${sql.identifier(SOURCE_ALIAS)}.${sql.identifier(column.outputName)}`,
    ),
    sql`, `,
  );
  return asCompiledSelectSql(
    sql`SELECT ${selectedColumns} FROM (SELECT ${sql.identifier(SOURCE_ALIAS)}.*, ROW_NUMBER() OVER (PARTITION BY ${partition}${ordering}) AS ${sql.identifier(rankName)} FROM (${source}) AS ${sql.identifier(SOURCE_ALIAS)}) AS ${sql.identifier(SOURCE_ALIAS)} WHERE ${sql.identifier(SOURCE_ALIAS)}.${sql.identifier(rankName)} <= ${relation.limit}`,
  );
}

/**
 * Compiles a query a relation reads from, refusing it when its generated SQL
 * names collide under `usage` (see `sql-name-registry.ts`): the caller's
 * use when the query is the whole relation, and `"wrapped"` when a derived,
 * top-per-partition or set relation refers to its columns by name. A relation
 * reads its source in the order the source selects its rows in, so the
 * source compiles in the `selection-ordered` shape: a relevance-ordered query
 * carries that order as its selection-order column (`selectionOrderColumn`).
 */
function compileRelationSource(
  source: RelationSource,
  usage: SqlNameUsage,
): CompiledSelectSql {
  return compileNameCheckedQuery(
    source.query,
    source.graphId,
    source.options,
    usage,
    "selection-ordered",
  );
}

/**
 * Refuses a relation, before any SQL is sent, when a query it reads from has
 * generated SQL names that collide under the use `compileRelation` would
 * check: the check a prepared relation runs once, for the statement every
 * execution sends.
 */
export function assertRelationSourceSqlNames(
  relation: RelationAst,
  usage: SqlNameUsage,
): void {
  refuseReservedRelationColumnNames(relation);
  if (relation.kind === "source") {
    compileRelationSource(relation, usage);
    return;
  }
  for (const source of relationSources(relation))
    compileRelationSource(source, "wrapped");
}

/** Compiles a structural relation tree without selecting a dialect strategy path. */
function compileRelationInner(
  relation: RelationAst,
  dialect: DatabaseExpressionCompilerContext["dialect"],
  orderedAggregates: boolean,
  usage: SqlNameUsage,
): CompiledSelectSql {
  switch (relation.kind) {
    case "source": {
      return compileRelationSource(relation, usage);
    }
    case "derived": {
      return compileDerived(relation, dialect, orderedAggregates);
    }
    case "topPerPartition": {
      return compileTopPerPartition(relation, dialect, orderedAggregates);
    }
    case "set": {
      const left = compileRelationPart(relation.left, dialect, "wrapped");
      const right = compileRelationPart(relation.right, dialect, "wrapped");
      const columns = sql.join(
        relation.columns.map(
          (column) =>
            sql`${sql.identifier("typegraph_relation_left")}.${sql.identifier(column.outputName)}`,
        ),
        sql`, `,
      );
      const rightColumns = sql.join(
        relation.columns.map(
          (column) =>
            sql`${sql.identifier("typegraph_relation_right")}.${sql.identifier(column.outputName)}`,
        ),
        sql`, `,
      );
      const operator = setOperationKeyword(relation.operator);
      return asCompiledSelectSql(
        sql`SELECT ${columns} FROM (${left}) AS ${sql.identifier("typegraph_relation_left")} ${sql.raw(operator)} SELECT ${rightColumns} FROM (${right}) AS ${sql.identifier("typegraph_relation_right")}`,
      );
    }
  }
}

/**
 * Compiles a relation. `usage` is how the caller reads the statement's result
 * columns (see `SqlNameUsage`); a query the relation reads from is checked
 * under it when it is the whole relation.
 *
 * Every compile from outside this module enters here and is refused when the
 * relation declares a column in the reserved namespace
 * (`refuseReservedRelationColumnNames`); the nested relations of one
 * statement compile through `compileRelationPart`, already checked.
 */
export function compileRelation(
  relation: RelationAst,
  dialect: DatabaseExpressionCompilerContext["dialect"],
  usage: SqlNameUsage = "decoded",
): CompiledSelectSql {
  refuseReservedRelationColumnNames(relation);
  return compileRelationPart(relation, dialect, usage);
}

/** Compiles a relation, or a relation nested in one, without the reserved-name check. */
function compileRelationPart(
  relation: RelationAst,
  dialect: DatabaseExpressionCompilerContext["dialect"],
  usage: SqlNameUsage,
): CompiledSelectSql {
  const orderedAggregates = relationSources(relation).every(
    (source) => source.options.orderedAggregates === true,
  );
  return withPinnedReadInstant(() =>
    compileRelationInner(relation, dialect, orderedAggregates, usage),
  );
}

export function assertCompatibleRelationColumns(
  left: readonly RelationColumn[],
  right: readonly RelationColumn[],
): void {
  if (left.length !== right.length)
    throw new ConfigurationError(
      "Set-operation projections must have the same number of columns.",
    );
  for (const [index, leftColumn] of left.entries()) {
    const rightColumn = right[index];
    if (
      leftColumn.outputName !== rightColumn?.outputName ||
      leftColumn.valueType !== rightColumn.valueType ||
      !haveCompatibleCollectionElements(leftColumn, rightColumn) ||
      leftColumn.nullable !== rightColumn.nullable
    ) {
      throw new ConfigurationError(
        "Set-operation projections must have identical ordered column names, types, collection element codecs, and nullability.",
        { index, left: leftColumn, right: rightColumn },
      );
    }
  }
}
