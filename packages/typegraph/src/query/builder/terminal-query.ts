/** Scalar SQL terminals preserve the relation without evaluating result selectors. */
import { ConfigurationError } from "../../errors";
import { withRecordedRelationsPrecondition } from "../../utils/sql-errors";
import type { QueryAst } from "../ast";
import { compileQuery } from "../compiler";
import { executeSchemaCheckedRead } from "../execution/schema-checked-read";
import { sql } from "../sql-fragment";
import { asCompiledSelectSql } from "../sql-intent";
import { count } from "./aggregates";
import { buildQueryAst } from "./ast-builder";
import { buildCompileOptions } from "./compile-options";
import { getQueryBuilderInternalContext } from "./internal-context";
import { hasParameterReferences } from "./prepared-query";
import type { QueryBuilderConfig, QueryBuilderState } from "./types";

/** COUNT operates on groups when grouping is present, otherwise on match rows. */
function buildTerminalAst(
  config: QueryBuilderConfig,
  state: QueryBuilderState,
): QueryAst {
  const fields =
    state.groupBy?.fields ??
    (state.having === undefined ?
      [
        {
          __type: "field_ref" as const,
          alias: state.startAlias,
          path: ["id"],
          valueType: "string" as const,
        },
      ]
    : [count(state.startAlias)]);
  return buildQueryAst(config, {
    ...state,
    projection: fields.map((source, index) => ({
      outputName: `terminal_field_${index}`,
      source,
    })),
  });
}

export async function executeQueryTerminal(
  config: QueryBuilderConfig,
  state: QueryBuilderState,
  operation: "count" | "exists",
): Promise<number> {
  const backend = config.backend;
  if (backend === undefined)
    throw new ConfigurationError(
      "Query terminals require an execution backend.",
      { operation },
    );
  const ast = buildTerminalAst(config, state);
  if (hasParameterReferences(ast))
    throw new ConfigurationError(
      "Query terminals require bound values; param() references cannot be executed directly.",
      { operation },
    );
  const options = buildCompileOptions(config);
  const relation = compileQuery(ast, config.graphId, options);
  const column = "typegraph_terminal_value";
  const statement = asCompiledSelectSql(
    operation === "count" ?
      sql`SELECT COUNT(*) AS ${sql.identifier(column)} FROM (${relation}) AS typegraph_terminal_rows`
    : sql`SELECT CASE WHEN EXISTS (${relation}) THEN 1 ELSE 0 END AS ${sql.identifier(column)}`,
  );
  const checked = getQueryBuilderInternalContext(config).expectedSchemaVersion;
  const { orderBy: _orderBy, ...unorderedAst } = ast;
  const rowsPromise =
    checked === undefined ?
      backend.execute<Record<string, unknown>>(statement)
    : executeSchemaCheckedRead({
        backend,
        ast: unorderedAst,
        graphId: config.graphId,
        expectedVersion: checked.value,
        rowIdentityColumn: column,
        compile: () => statement,
      });
  const rows = await (state.recordedAsOf === undefined ?
    rowsPromise
  : withRecordedRelationsPrecondition(rowsPromise, {
      dialect: backend.dialect,
      surface: `recorded-query-${operation}`,
    }));
  return Number(rows[0]?.[column] ?? 0);
}
