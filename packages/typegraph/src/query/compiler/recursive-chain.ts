import { UnsupportedPredicateError } from "../../errors";
import type {
  PredicateExpression,
  ProjectedField,
  QueryAst,
  Traversal,
} from "../ast";
import {
  aliasColumnName,
  aliasCteName,
  generatedIdentifier,
} from "../generated-identifier";
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
  compileRecursiveResultField,
  compileRecursiveSelectiveField,
  compileRecursiveStage,
  compileVariableLengthQuery,
  hasExplicitRecursiveProjection,
} from "./recursive";
import { assertTraversalStagePredicatesSupported } from "./traversal-stage-validation";
import { EDGE_COLUMNS, NODE_COLUMNS } from "./utils";

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
    fusion: _fusion,
    ...stageBase
  } = ast;
  return {
    ...stageBase,
    start: {
      alias: traversal.joinFromAlias,
      kinds: getNodeKindsForAlias(ast, traversal.joinFromAlias),
      expansion:
        index === 0 && traversal.joinFromAlias === ast.start.alias ?
          ast.start.expansion
        : "exact",
    },
    traversals: [traversal],
    predicates: ast.predicates.filter((predicate) =>
      allowedPredicates.has(predicate.targetAlias),
    ),
    projection: { fields: [] },
    ...(index === 0 && ast.fusion !== undefined ? { fusion: ast.fusion } : {}),
  };
}

function sourceAst(ast: QueryAst): QueryAst {
  const {
    aggregateOrderBy: _aggregateOrderBy,
    groupBy: _groupBy,
    having: _having,
    limit: _limit,
    offset: _offset,
    orderBy: _orderBy,
    resultPredicate: _resultPredicate,
    selectiveFields: _selectiveFields,
    ...sourceBase
  } = ast;
  return {
    ...sourceBase,
    traversals: [],
    predicates: ast.predicates.filter(
      (predicate) => predicate.targetAlias === ast.start.alias,
    ),
    projection: {
      fields: NODE_COLUMNS.map((column) => ({
        outputName: aliasColumnName(ast.start.alias, column),
        source: {
          __type: "field_ref",
          alias: ast.start.alias,
          path: [column],
        },
      })),
    },
  };
}

function selectNodeColumns(alias: string, sourceAlias?: string): SqlFragment[] {
  return NODE_COLUMNS.map((column) => {
    const name = aliasColumnName(alias, column);
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
      sql`${sql.identifier(sourceAlias)}.${sql.identifier(generatedIdentifier(variableLength.depthAlias))} AS ${sql.identifier(generatedIdentifier(variableLength.depthAlias))}`,
    );
  }
  if (variableLength?.pathAlias !== undefined) {
    columns.push(
      sql`${sql.identifier(sourceAlias)}.${sql.identifier(generatedIdentifier(variableLength.pathAlias))} AS ${sql.identifier(generatedIdentifier(variableLength.pathAlias))}`,
    );
  }
  return columns;
}

function fixedStageOutputColumns(
  traversal: Traversal,
  sourceAlias: string,
): SqlFragment[] {
  return [
    ...stageOutputColumns(traversal, sourceAlias),
    ...EDGE_COLUMNS.map((column) => {
      const name = aliasColumnName(traversal.edgeAlias, column);
      return sql`${sql.identifier(sourceAlias)}.${sql.identifier(name)} AS ${sql.identifier(name)}`;
    }),
  ];
}

function fixedStageProjection(traversal: Traversal): readonly ProjectedField[] {
  const fields = [
    ...NODE_COLUMNS.map((column) => ({
      alias: traversal.joinFromAlias,
      column,
    })),
    ...NODE_COLUMNS.map((column) => ({
      alias: traversal.nodeAlias,
      column,
    })),
    ...EDGE_COLUMNS.map((column) => ({
      alias: traversal.edgeAlias,
      column,
    })),
  ];
  return fields.map(({ alias, column }) => ({
    outputName: aliasColumnName(alias, column),
    source: {
      __type: "field_ref",
      alias,
      path: [column],
    },
    ...(alias === traversal.edgeAlias ?
      { cteAlias: aliasCteName(traversal.nodeAlias) }
    : {}),
  }));
}

function outputColumnsForStage(
  traversal: Traversal,
  sourceAlias: string,
): SqlFragment[] {
  return traversal.variableLength === undefined ?
      fixedStageOutputColumns(traversal, sourceAlias)
    : stageOutputColumns(traversal, sourceAlias);
}

function compileStage(
  ast: QueryAst,
  traversal: Traversal,
  index: number,
  graphId: string,
  ctx: PredicateCompilerContext,
  seed?: SqlFragment,
): SqlFragment {
  assertTraversalStagePredicatesSupported(ast, traversal, index);
  const isolated = stageAst(ast, traversal, index);
  if (traversal.variableLength === undefined) {
    const compiled = ctx.compileQuery(
      {
        ...isolated,
        projection: { fields: fixedStageProjection(traversal) },
      },
      graphId,
    );
    if (seed === undefined) return compiled;
    const stageAlias = "__tg_fixed_stage";
    const seedAlias = "__tg_fixed_seed";
    return sql`
      SELECT * FROM (${compiled}) AS ${sql.identifier(stageAlias)}
      WHERE EXISTS (
        SELECT 1 FROM (${seed}) AS ${sql.identifier(seedAlias)}
        WHERE ${sql.identifier(seedAlias)}.kind = ${sql.identifier(stageAlias)}.${sql.identifier(aliasColumnName(traversal.joinFromAlias, "kind"))}
          AND ${sql.identifier(seedAlias)}.id = ${sql.identifier(stageAlias)}.${sql.identifier(aliasColumnName(traversal.joinFromAlias, "id"))}
      )
    `;
  }
  return seed === undefined ?
      compileVariableLengthQuery(isolated, graphId, ctx)
    : compileRecursiveStage(isolated, graphId, ctx, seed);
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
    const fixedEdgeAliases = new Set(
      traversals
        .filter((traversal) => traversal.variableLength === undefined)
        .map((traversal) => traversal.edgeAlias),
    );
    const selectableAliases = new Set([...nodeAliases, ...fixedEdgeAliases]);
    // Optional-node decoding tracks structural edge fields even when the edge
    // was not selected. Recursive stages do not materialize those edge rows.
    const emittedFields = ast.selectiveFields.filter((field) =>
      selectableAliases.has(field.alias),
    );
    const columns = emittedFields.map((field) =>
      compileRecursiveSelectiveField(
        field,
        selectableAliases,
        dialect,
        resultAlias,
      ),
    );
    for (const traversal of traversals) {
      const variableLength = traversal.variableLength;
      if (variableLength?.depthAlias !== undefined) {
        columns.push(
          sql`${sql.identifier(resultAlias)}.${sql.identifier(generatedIdentifier(variableLength.depthAlias))} AS ${sql.identifier(generatedIdentifier(variableLength.depthAlias))}`,
        );
      }
      if (variableLength?.pathAlias !== undefined) {
        columns.push(
          sql`${sql.identifier(resultAlias)}.${sql.identifier(generatedIdentifier(variableLength.pathAlias))} AS ${sql.identifier(generatedIdentifier(variableLength.pathAlias))}`,
        );
      }
    }
    columns.push(
      ...compileAdditionalRecursiveProjectionFields(
        ast,
        new Set(emittedFields.map((field) => field.outputName)),
        ctx,
        resultAlias,
        new Set(
          traversals
            .filter((traversal) => traversal.variableLength !== undefined)
            .map((traversal) => traversal.edgeAlias),
        ),
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
    : [
        ...nodeAliases.flatMap((alias) =>
          selectNodeColumns(alias, resultAlias),
        ),
        ...traversals
          .filter((traversal) => traversal.variableLength === undefined)
          .flatMap((traversal) =>
            EDGE_COLUMNS.map((column) => {
              const name = aliasColumnName(traversal.edgeAlias, column);
              return sql`${sql.identifier(resultAlias)}.${sql.identifier(name)} AS ${sql.identifier(name)}`;
            }),
          ),
      ]),
    ...traversals.flatMap((traversal) =>
      stageOutputColumns(traversal, resultAlias).slice(NODE_COLUMNS.length),
    ),
    ...compileAdditionalRecursiveProjectionFields(
      ast,
      new Set(
        explicitProjection ?
          []
        : [
            ...nodeAliases.flatMap((alias) =>
              NODE_COLUMNS.map((column) => aliasColumnName(alias, column)),
            ),
            ...traversals
              .filter((traversal) => traversal.variableLength === undefined)
              .flatMap((traversal) =>
                EDGE_COLUMNS.map((column) =>
                  aliasColumnName(traversal.edgeAlias, column),
                ),
              ),
          ],
      ),
      ctx,
      resultAlias,
      new Set(
        traversals
          .filter((traversal) => traversal.variableLength !== undefined)
          .map((traversal) => traversal.edgeAlias),
      ),
    ),
  ];
  return sql.join(columns, sql`, `);
}

function assertRecursiveResultPredicateSupported(
  predicate: PredicateExpression,
): void {
  if (predicate.__type === "database_expression_predicate") return;
  if (predicate.__type === "not") {
    assertRecursiveResultPredicateSupported(predicate.predicate);
    return;
  }
  if (predicate.__type === "and" || predicate.__type === "or") {
    for (const operand of predicate.predicates)
      assertRecursiveResultPredicateSupported(operand);
    return;
  }
  throw new UnsupportedPredicateError(
    "Completed recursive match filters require database expressions so materialized output columns remain scope-safe.",
  );
}

export function compileMultiStageRecursiveQuery(
  ast: QueryAst,
  graphId: string,
  ctx: PredicateCompilerContext,
): SqlFragment {
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
    traversals
      .filter((traversal) => traversal.variableLength !== undefined)
      .map((traversal) => traversal.edgeAlias),
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
  if (firstTraversal.optional) {
    assertTraversalStagePredicatesSupported(ast, firstTraversal, 0);
    const sourceName = "typegraph_recursive_source_0";
    const source = ctx.compileQuery(sourceAst(ast), graphId);
    const seed = sql`SELECT DISTINCT ${sql.identifier(aliasColumnName(ast.start.alias, "kind"))} AS kind, ${sql.identifier(aliasColumnName(ast.start.alias, "id"))} AS id FROM ${sql.identifier(sourceName)}`;
    const expansion = compileStage(ast, firstTraversal, 1, graphId, ctx, seed);
    const expansionName = "typegraph_recursive_expansion_0";
    ctes.push(
      sql`${sql.identifier(sourceName)} AS (${source})`,
      sql`${sql.identifier(expansionName)} AS (${expansion})`,
      sql`
        ${sql.identifier(completedName)} AS (
          SELECT source.*, ${sql.join(outputColumnsForStage(firstTraversal, "expanded"), sql`, `)}
          FROM ${sql.identifier(sourceName)} AS source
          LEFT JOIN ${sql.identifier(expansionName)} AS expanded
            ON expanded.${sql.identifier(aliasColumnName(ast.start.alias, "kind"))} = source.${sql.identifier(aliasColumnName(ast.start.alias, "kind"))}
           AND expanded.${sql.identifier(aliasColumnName(ast.start.alias, "id"))} = source.${sql.identifier(aliasColumnName(ast.start.alias, "id"))}
        )
      `,
    );
  } else {
    ctes.push(
      sql`${sql.identifier(completedName)} AS (${compileStage(ast, firstTraversal, 0, graphId, ctx)})`,
    );
  }

  for (let index = 1; index < traversals.length; index++) {
    const traversal = traversals[index];
    if (traversal === undefined) continue;
    const expansionName = `typegraph_recursive_expansion_${index}`;
    const nextCompletedName = `typegraph_recursive_stage_${index}`;
    const seed = sql`SELECT DISTINCT ${sql.identifier(aliasColumnName(traversal.joinFromAlias, "kind"))} AS kind, ${sql.identifier(aliasColumnName(traversal.joinFromAlias, "id"))} AS id FROM ${sql.identifier(completedName)} WHERE ${sql.identifier(aliasColumnName(traversal.joinFromAlias, "id"))} IS NOT NULL`;
    const expansion = compileStage(ast, traversal, index, graphId, ctx, seed);
    ctes.push(sql`${sql.identifier(expansionName)} AS (${expansion})`);
    const join = traversal.optional ? sql`LEFT JOIN` : sql`JOIN`;
    ctes.push(sql`
      ${sql.identifier(nextCompletedName)} AS (
            SELECT previous.*, ${sql.join(outputColumnsForStage(traversal, "expanded"), sql`, `)}
            FROM ${sql.identifier(completedName)} AS previous
            ${join} ${sql.identifier(expansionName)} AS expanded
              ON expanded.${sql.identifier(aliasColumnName(traversal.joinFromAlias, "kind"))} = previous.${sql.identifier(aliasColumnName(traversal.joinFromAlias, "kind"))}
             AND expanded.${sql.identifier(aliasColumnName(traversal.joinFromAlias, "id"))} = previous.${sql.identifier(aliasColumnName(traversal.joinFromAlias, "id"))}
          )
    `);
    completedName = nextCompletedName;
  }

  const resultAlias = ctx.recursiveResultAlias ?? "typegraph_recursive_result";
  const clauses: SqlFragment[] = [];
  if (ast.resultPredicate !== undefined) {
    assertRecursiveResultPredicateSupported(ast.resultPredicate);
    clauses.push(
      sql`WHERE ${compilePredicateExpression(ast.resultPredicate, {
        ...ctx,
        resolveFieldCteAlias: () => resultAlias,
        compileFieldExpression(field, expression) {
          return compileRecursiveResultField(
            field,
            ctx.dialect,
            resultAlias,
            expression.valueType,
          );
        },
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
