import { type SQL, sql } from "drizzle-orm";
import { CasingCache } from "drizzle-orm/casing";

import { getDialect, type SqlDialect } from "../query/dialect";
import {
  compileEdgeIndexKeys,
  compileIndexWhere,
  compileNodeIndexKeys,
  type IndexCompilationContext,
} from "./compiler";
import {
  type EdgeIndex,
  type NodeIndex,
  type SystemColumnName,
  type TypeGraphIndex,
} from "./types";

export type GenerateIndexDdlOptions = Readonly<{
  nodesTableName?: string | undefined;
  edgesTableName?: string | undefined;
  ifNotExists?: boolean | undefined;
}>;

export function generateIndexDDL(
  index: TypeGraphIndex,
  dialect: SqlDialect,
  options: GenerateIndexDdlOptions = {},
): string {
  if (index.__type === "typegraph_node_index") {
    return generateNodeIndexDDL(index, dialect, options);
  }
  return generateEdgeIndexDDL(index, dialect, options);
}

export function generateNodeIndexDDL(
  index: NodeIndex,
  dialect: SqlDialect,
  options: GenerateIndexDdlOptions = {},
): string {
  const tableName = options.nodesTableName ?? "typegraph_nodes";
  return generateTableIndexDDL(index, dialect, tableName, options);
}

export function generateEdgeIndexDDL(
  index: EdgeIndex,
  dialect: SqlDialect,
  options: GenerateIndexDdlOptions = {},
): string {
  const tableName = options.edgesTableName ?? "typegraph_edges";
  return generateTableIndexDDL(index, dialect, tableName, options);
}

function generateTableIndexDDL(
  index: TypeGraphIndex,
  dialect: SqlDialect,
  tableName: string,
  options: GenerateIndexDdlOptions,
): string {
  const ifNotExists = options.ifNotExists ?? true;
  const propsColumn = sql.raw('"props"');
  const systemColumn = (column: SystemColumnName): SQL =>
    sql.raw(quoteIdentifier(column));

  const keys =
    index.__type === "typegraph_node_index" ?
      compileNodeIndexKeys(index, dialect, propsColumn, systemColumn).keys
    : compileEdgeIndexKeys(index, dialect, propsColumn, systemColumn).keys;

  const whereSql =
    index.where ?
      sqlToInlineString(
        compileIndexWhere(
          {
            dialect,
            propsColumn,
            systemColumn,
          } satisfies IndexCompilationContext,
          index.where,
        ),
        dialect,
      )
    : undefined;

  const keySql = keys.map((k) => sqlToInlineString(k, dialect)).join(", ");
  const unique = index.unique ? "UNIQUE " : "";
  const ifNotExistsSql = ifNotExists ? "IF NOT EXISTS " : "";

  const whereClause = whereSql ? ` WHERE ${whereSql}` : "";

  return `CREATE ${unique}INDEX ${ifNotExistsSql}${quoteIdentifier(index.name)} ON ${quoteIdentifier(tableName)} (${keySql})${whereClause};`;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function sqlToInlineString(object: SQL, dialect: SqlDialect): string {
  const query = object.toQuery({
    casing: new CasingCache(),
    escapeName: (name) => name,
    escapeParam: (_number, value) => inlineParam(value, dialect),
    escapeString: (value) => escapeStringLiteral(value),
    inlineParams: true,
    invokeSource: "indexes",
  });

  if (query.params.length > 0) {
    throw new Error(
      "Index DDL generation produced parameters; expected fully inlined SQL",
    );
  }

  return query.sql;
}

function inlineParam(value: unknown, dialect: SqlDialect): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (value instanceof Date) {
    return escapeStringLiteral(value.toISOString());
  }

  if (typeof value === "string") {
    return escapeStringLiteral(value);
  }
  if (typeof value === "number") {
    return value.toString();
  }
  if (typeof value === "boolean") {
    return getDialect(dialect).booleanLiteralString(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }

  throw new TypeError(
    "Index DDL generation received an unsupported SQL parameter value",
  );
}

function escapeStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
