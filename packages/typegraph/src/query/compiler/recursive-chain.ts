import { UnsupportedPredicateError } from "../../errors";
import type { QueryAst, Traversal } from "../ast";
import { sql, type SqlFragment } from "../sql-fragment";
import { compileLimitOffsetClauses } from "./limit-offset";
import { getNodeKindsForAlias } from "./predicate-utils";
import {
  compilePredicateExpression,
  type PredicateCompilerContext,
} from "./predicates";
import {
  assertRecursiveOutputSupported,
  compileAdditionalRecursiveProjectionFields,
  compileRecursiveOrderBy,
  compileRecursiveSelectiveField,
  compileRecursiveStage,
  compileVariableLengthQuery,
  hasExplicitRecursiveProjection,
} from "./recursive";
import { NODE_COLUMNS } from "./utils";

function stageAst(
  ast: QueryAst,
  traversal: Traversal,
  index: number,
): QueryAst {
  const allowedPredicates = new Set([
    traversal.edgeAlias,
    traversal.nodeAlias,
    ...(index === 0 ? [ast.start.alias] : []),
  ]);
  const {
    aggregateOrderBy: _aggregateOrderBy,
    groupBy: _groupBy,
    having: _having,
    limit: _limit,
    offset: _offset,
    orderBy: _orderBy,
    resultPredicate: _resultPredicate,
    selectiveFields: _selectiveFields,
    ...stageBase
  } = ast;
  return {
    ...stageBase,
    start: {
      alias: traversal.joinFromAlias,
      kinds: getNodeKindsForAlias(ast, traversal.joinFromAlias),
      includeSubClasses: false,
    },
    traversals: [traversal],
    predicates: ast.predicates.filter((predicate) =>
      allowedPredicates.has(predicate.targetAlias),
    ),
    projection: { fields: [] },
  };
}

function selectNodeColumns(alias: string, sourceAlias?: string): SqlFragment[] {
  return NODE_COLUMNS.map((column) => {
    const name = `${alias}_${column}`;
    return sourceAlias === undefined ?
        sql.identifier(name)
      : sql`${sql.identifier(sourceAlias)}.${sql.identifier(name)} AS ${sql.identifier(name)}`;
  });
}

function stageOutputColumns(
  traversal: Traversal,
  sourceAlias: string,
): SqlFragment[] {
  const columns = selectNodeColumns(traversal.nodeAlias, sourceAlias);
  const variableLength = traversal.variableLength;
  if (variableLength?.depthAlias !== undefined) {
    columns.push(
      sql`${sql.identifier(sourceAlias)}.${sql.identifier(variableLength.depthAlias)} AS ${sql.identifier(variableLength.depthAlias)}`,
    );
  }
  if (variableLength?.pathAlias !== undefined) {
    columns.push(
      sql`${sql.identifier(sourceAlias)}.${sql.identifier(variableLength.pathAlias)} AS ${sql.identifier(variableLength.pathAlias)}`,
    );
  }
  return columns;
}

function compileFinalProjection(
  ast: QueryAst,
  traversals: readonly Traversal[],
  ctx: PredicateCompilerContext,
  resultAlias: string,
): SqlFragment {
  const dialect = ctx.dialect;
  if (ast.selectiveFields !== undefined && ast.selectiveFields.length > 0) {
    const nodeAliases = new Set([
      ast.start.alias,
      ...traversals.map((traversal) => traversal.nodeAlias),
    ]);
    // Optional-node decoding tracks structural edge fields even when the edge
    // was not selected. Recursive stages do not materialize those edge rows.
    const emittedFields = ast.selectiveFields.filter((field) =>
      nodeAliases.has(field.alias),
    );
    const columns = emittedFields.map((field) =>
      compileRecursiveSelectiveField(field, nodeAliases, dialect, resultAlias),
    );
    for (const traversal of traversals) {
      const variableLength = traversal.variableLength;
      if (variableLength?.depthAlias !== undefined) {
        columns.push(
          sql`${sql.identifier(resultAlias)}.${sql.identifier(variableLength.depthAlias)} AS ${sql.identifier(variableLength.depthAlias)}`,
        );
      }
      if (variableLength?.pathAlias !== undefined) {
        columns.push(
          sql`${sql.identifier(resultAlias)}.${sql.identifier(variableLength.pathAlias)} AS ${sql.identifier(variableLength.pathAlias)}`,
        );
      }
    }
    columns.push(
      ...compileAdditionalRecursiveProjectionFields(
        ast,
        new Set(emittedFields.map((field) => field.outputName)),
        ctx,
        resultAlias,
        new Set(traversals.map((traversal) => traversal.edgeAlias)),
      ),
    );
    return sql.join(columns, sql`, `);
  }

  const explicitProjection = hasExplicitRecursiveProjection(ast);
  const nodeAliases = [
    ast.start.alias,
    ...traversals.map((traversal) => traversal.nodeAlias),
  ];
  const columns = [
    ...(explicitProjection ?
      []
    : nodeAliases.flatMap((alias) => selectNodeColumns(alias, resultAlias))),
    ...traversals.flatMap((traversal) =>
      stageOutputColumns(traversal, resultAlias).slice(NODE_COLUMNS.length),
    ),
    ...compileAdditionalRecursiveProjectionFields(
      ast,
      new Set(
        explicitProjection ?
          []
        : nodeAliases.flatMap((alias) =>
            NODE_COLUMNS.map((column) => `${alias}_${column}`),
          ),
      ),
      ctx,
      resultAlias,
      new Set(traversals.map((traversal) => traversal.edgeAlias)),
    ),
  ];
  return sql.join(columns, sql`, `);
}

export function compileMultiStageRecursiveQuery(
  ast: QueryAst,
  graphId: string,
  ctx: PredicateCompilerContext,
): SqlFragment {
  if (
    ast.traversals.some((traversal) => traversal.variableLength === undefined)
  ) {
    throw new UnsupportedPredicateError(
      "Mixing fixed-hop and variable-length traversals is not yet supported",
    );
  }

  const traversals = ast.traversals;
  assertRecursiveOutputSupported(ast);
  const materializedAliases = new Set([ast.start.alias]);
  for (const traversal of traversals) {
    if (!materializedAliases.has(traversal.joinFromAlias)) {
      throw new UnsupportedPredicateError(
        `Recursive traversal source alias "${traversal.joinFromAlias}" must refer to an earlier stage`,
      );
    }
    materializedAliases.add(traversal.nodeAlias);
  }
  const edgeAliases = new Set(
    traversals.map((traversal) => traversal.edgeAlias),
  );
  const selectedEdgeField = ast.selectiveFields?.find((field) =>
    edgeAliases.has(field.alias),
  );
  if (selectedEdgeField !== undefined) {
    throw new UnsupportedPredicateError(
      `Selective projection for recursive traversals does not support edge alias "${selectedEdgeField.alias}"`,
    );
  }
  const ctes: SqlFragment[] = [];
  let completedName = "typegraph_recursive_stage_0";
  const firstTraversal = traversals[0];
  if (firstTraversal === undefined) {
    throw new UnsupportedPredicateError(
      "Recursive query has no traversal stages",
    );
  }
  ctes.push(
    sql`${sql.identifier(completedName)} AS (${compileVariableLengthQuery(stageAst(ast, firstTraversal, 0), graphId, ctx)})`,
  );

  for (let index = 1; index < traversals.length; index++) {
    const traversal = traversals[index];
    if (traversal === undefined) continue;
    const expansionName = `typegraph_recursive_expansion_${index}`;
    const nextCompletedName = `typegraph_recursive_stage_${index}`;
    const seed = sql`SELECT DISTINCT ${sql.identifier(`${traversal.joinFromAlias}_kind`)} AS kind, ${sql.identifier(`${traversal.joinFromAlias}_id`)} AS id FROM ${sql.identifier(completedName)} WHERE ${sql.identifier(`${traversal.joinFromAlias}_id`)} IS NOT NULL`;
    const expansion = compileRecursiveStage(
      stageAst(ast, traversal, index),
      graphId,
      ctx,
      seed,
    );
    ctes.push(sql`${sql.identifier(expansionName)} AS (${expansion})`);
    const join = traversal.optional ? sql`LEFT JOIN` : sql`JOIN`;
    ctes.push(sql`
      ${sql.identifier(nextCompletedName)} AS (
            SELECT previous.*, ${sql.join(stageOutputColumns(traversal, "expanded"), sql`, `)}
            FROM ${sql.identifier(completedName)} AS previous
            ${join} ${sql.identifier(expansionName)} AS expanded
              ON expanded.${sql.identifier(`${traversal.joinFromAlias}_kind`)} = previous.${sql.identifier(`${traversal.joinFromAlias}_kind`)}
             AND expanded.${sql.identifier(`${traversal.joinFromAlias}_id`)} = previous.${sql.identifier(`${traversal.joinFromAlias}_id`)}
          )
    `);
    completedName = nextCompletedName;
  }

  const resultAlias = ctx.recursiveResultAlias ?? "typegraph_recursive_result";
  const clauses: SqlFragment[] = [];
  if (ast.resultPredicate !== undefined) {
    clauses.push(
      sql`WHERE ${compilePredicateExpression(ast.resultPredicate, {
        ...ctx,
        resolveFieldCteAlias: () => resultAlias,
      })}`,
    );
  }
  const orderBy = compileRecursiveOrderBy(ast, ctx, resultAlias);
  if (orderBy !== undefined) clauses.push(orderBy);
  const range = compileLimitOffsetClauses(ast.limit, ast.offset, ctx.dialect);
  clauses.push(...range);

  return sql`
    WITH ${sql.join(ctes, sql`, `)}
        SELECT ${compileFinalProjection(ast, traversals, ctx, resultAlias)}
        FROM ${sql.identifier(completedName)} AS ${sql.identifier(resultAlias)}
        ${sql.join(clauses, sql` `)}
  `;
}
