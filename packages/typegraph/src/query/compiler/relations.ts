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
import { compileQuery, type CompileQueryOptions } from "./index";
import { compileLimitOffsetClauses } from "./limit-offset";
import { validateRelationAggregation } from "./relation-aggregate-validation";
import { setOperationKeyword } from "./set-operations";
import { withPinnedReadInstant } from "./temporal";

export type RelationColumn = Readonly<{
  outputName: string;
  valueType: ValueType;
  elementValueType?: ValueType;
  elementFields?: Readonly<Record<string, ValueType>>;
  nullable: boolean;
  /** Proven graph-node identity carried only from a direct graph field. */
  identity?: Readonly<{
    component: "id" | "kind";
    alias: string;
  }>;
}>;

export type RelationOrder = Readonly<{
  expression: DatabaseExpression;
  direction: SortDirection;
  nulls: "first" | "last";
}>;

type RelationSource = Readonly<{
  kind: "source";
  query: QueryAst;
  graphId: string;
  options: CompileQueryOptions;
}>;

type DerivedRelation = Readonly<{
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

type SetRelation = Readonly<{
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

function compileOrder(
  orderBy: readonly RelationOrder[],
  dialect: DatabaseExpressionCompilerContext["dialect"],
  orderedAggregates: boolean,
): SqlFragment {
  if (orderBy.length === 0) return sql.empty();
  if (orderBy.some((order) => order.expression.elementValueType !== undefined))
    throw new ConfigurationError(
      "Relation ordering requires scalar keys; collection-valued ordering is unsupported.",
    );
  return sql` ORDER BY ${sql.join(
    orderBy.map((order) =>
      compileOrderTerm(
        compileExpression(order.expression, dialect, false, orderedAggregates),
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
  validateRelationAggregation(
    relation.projection.map(({ expression }) => expression),
    relation.groupBy,
  );
  const source = compileRelation(relation.source, dialect);
  const projection = sql.join(
    relation.projection.map(
      ({ column, expression }) =>
        sql`${compileExpression(expression, dialect, true, orderedAggregates)} AS ${sql.identifier(column.outputName)}`,
    ),
    sql`, `,
  );
  const predicate =
    relation.predicate === undefined ?
      sql.empty()
    : sql` WHERE ${compileExpression(relation.predicate, dialect, false, orderedAggregates)}`;
  const groupBy =
    relation.groupBy === undefined || relation.groupBy.length === 0 ?
      sql.empty()
    : sql` GROUP BY ${sql.join(
        relation.groupBy.map((expression) =>
          compileExpression(expression, dialect, false, orderedAggregates),
        ),
        sql`, `,
      )}`;
  return asCompiledSelectSql(
    sql`SELECT ${relation.distinct ? sql.raw("DISTINCT ") : sql.empty()}${projection} FROM (${source}) AS ${sql.identifier(SOURCE_ALIAS)}${predicate}${groupBy}${compileOrder(relation.orderBy, dialect, orderedAggregates)} ${sql.join(compileLimitOffsetClauses(relation.limit, relation.offset, dialect), sql` `)}`,
  );
}

function compileTopPerPartition(
  relation: TopPerPartitionRelation,
  dialect: DatabaseExpressionCompilerContext["dialect"],
  orderedAggregates: boolean,
): CompiledSelectSql {
  const source = compileRelation(relation.source, dialect);
  const partition = sql.join(
    relation.partitionBy.map((expression) =>
      compileExpression(expression, dialect, false, orderedAggregates),
    ),
    sql`, `,
  );
  const ordering = compileOrder(relation.orderBy, dialect, orderedAggregates);
  const occupiedNames = new Set(
    // SQLite resolves even quoted identifiers without case sensitivity.
    relation.columns.map((column) => column.outputName.toLowerCase()),
  );
  let rankName = "__tg_partition_rank";
  while (occupiedNames.has(rankName)) rankName += "_";
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

/** Compiles a structural relation tree without selecting a dialect strategy path. */
function compileRelationInner(
  relation: RelationAst,
  dialect: DatabaseExpressionCompilerContext["dialect"],
  orderedAggregates: boolean,
): CompiledSelectSql {
  switch (relation.kind) {
    case "source": {
      return compileQuery(relation.query, relation.graphId, relation.options);
    }
    case "derived": {
      return compileDerived(relation, dialect, orderedAggregates);
    }
    case "topPerPartition": {
      return compileTopPerPartition(relation, dialect, orderedAggregates);
    }
    case "set": {
      const left = compileRelation(relation.left, dialect);
      const right = compileRelation(relation.right, dialect);
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

export function compileRelation(
  relation: RelationAst,
  dialect: DatabaseExpressionCompilerContext["dialect"],
): CompiledSelectSql {
  const orderedAggregates = relationSources(relation).every(
    (source) => source.options.orderedAggregates === true,
  );
  return withPinnedReadInstant(() =>
    compileRelationInner(relation, dialect, orderedAggregates),
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
