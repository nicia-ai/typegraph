import { getDialect } from "../query/dialect";
import { type SqlDialect } from "../query/dialect/types";
import { renderSqlInline, sql, type SqlFragment } from "../query/sql-fragment";
import { requireDefined } from "../utils/presence";
import {
  compileEdgeIndexKeys,
  compileIndexWhere,
  compileNodeIndexKeys,
  type IndexCompilationContext,
} from "./compiler";
import {
  type EdgeIndexDeclaration,
  type NodeIndexDeclaration,
  type RelationalIndexDeclaration,
  type SystemColumnName,
} from "./types";

export type GenerateIndexDdlOptions = Readonly<{
  nodesTableName?: string | undefined;
  edgesTableName?: string | undefined;
  ifNotExists?: boolean | undefined;
  /**
   * Emit `CREATE INDEX CONCURRENTLY` (Postgres only). Required for
   * `store.materializeIndexes()` so live tables don't take an
   * `AccessExclusiveLock`. Ignored on SQLite (no equivalent; SQLite is
   * single-writer regardless). When true on Postgres, the resulting
   * statement cannot be executed inside a transaction.
   */
  concurrent?: boolean | undefined;
}>;

const INDEX_DDL_BEHAVIOR = {
  postgres: { concurrentBuilds: true, supportsGinFamily: true },
  sqlite: { concurrentBuilds: false, supportsGinFamily: false },
} as const satisfies Record<
  SqlDialect,
  Readonly<{ concurrentBuilds: boolean; supportsGinFamily: boolean }>
>;

/**
 * Generate `CREATE INDEX` DDL for a single relational index declaration.
 *
 * Vector index declarations (`entity: "vector"`) are NOT handled here —
 * they go through `backend.createVectorIndex` instead because the DDL
 * is dialect-specific (`USING hnsw (...) WITH (m=..., ef_construction=...)`
 * on Postgres) and operates on the strategy's per-`(kind, field)` embedding
 * tables, not `typegraph_nodes` / `typegraph_edges`. Callers narrow to the
 * relational subset before calling this function.
 */
export function generateIndexDDL(
  index: RelationalIndexDeclaration,
  dialect: SqlDialect,
  options: GenerateIndexDdlOptions = {},
): string {
  if (index.entity === "node") {
    return generateNodeIndexDDL(index, dialect, options);
  }
  return generateEdgeIndexDDL(index, dialect, options);
}

export function generateNodeIndexDDL(
  index: NodeIndexDeclaration,
  dialect: SqlDialect,
  options: GenerateIndexDdlOptions = {},
): string {
  const tableName = options.nodesTableName ?? "typegraph_nodes";
  return generateTableIndexDDL(index, dialect, tableName, options);
}

export function generateEdgeIndexDDL(
  index: EdgeIndexDeclaration,
  dialect: SqlDialect,
  options: GenerateIndexDdlOptions = {},
): string {
  const tableName = options.edgesTableName ?? "typegraph_edges";
  return generateTableIndexDDL(index, dialect, tableName, options);
}

function generateTableIndexDDL(
  index: RelationalIndexDeclaration,
  dialect: SqlDialect,
  tableName: string,
  options: GenerateIndexDdlOptions,
): string {
  if (index.method !== undefined) {
    return generateGinFamilyIndexDDL(index, dialect, tableName, options);
  }
  const ifNotExists = options.ifNotExists ?? true;
  const propsColumn = sql.identifier("props");
  const systemColumn = (column: SystemColumnName): SqlFragment =>
    sql.identifier(column);

  const keys =
    index.entity === "node" ?
      compileNodeIndexKeys(index, dialect, propsColumn, systemColumn).keys
    : compileEdgeIndexKeys(index, dialect, propsColumn, systemColumn).keys;

  const whereSql =
    index.where ?
      renderSqlInline(
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

  const keySql = keys.map((key) => renderSqlInline(key, dialect)).join(", ");
  const unique = index.unique ? "UNIQUE " : "";
  const concurrent =
    (
      options.concurrent === true &&
      INDEX_DDL_BEHAVIOR[dialect].concurrentBuilds
    ) ?
      "CONCURRENTLY "
    : "";
  const ifNotExistsSql = ifNotExists ? "IF NOT EXISTS " : "";

  const whereClause = whereSql ? ` WHERE ${whereSql}` : "";

  return `CREATE ${unique}INDEX ${concurrent}${ifNotExistsSql}${quoteIdentifier(index.name)} ON ${quoteIdentifier(tableName)} (${keySql})${whereClause};`;
}

/**
 * DDL for the GIN-family methods (`"gin"` / `"trigram"`) — a PostgreSQL
 * expression GIN over the declaration's single field.
 *
 * The indexed expression is built from the SAME dialect extraction the
 * query compiler emits for the field (`jsonExtract` → `"props" #> ARRAY[…]`
 * for containment, `jsonExtractText` → `#>>` for text), because Postgres
 * matches expression indexes structurally: `(props #> ARRAY['tags']) @> $1`
 * and `(props #>> ARRAY['name']) ILIKE $1 ESCAPE '\'` both hit their GIN
 * (verified against parameterized prepared statements). No scope prefix
 * columns, uniqueness, or partial clause: a GIN indexes one expression, and
 * the query's `graph_id` / `kind` equality filters apply as residual
 * conditions over the candidate rows.
 */
function generateGinFamilyIndexDDL(
  index: RelationalIndexDeclaration,
  dialect: SqlDialect,
  tableName: string,
  options: GenerateIndexDdlOptions,
): string {
  if (!INDEX_DDL_BEHAVIOR[dialect].supportsGinFamily) {
    throw new Error(
      `Index "${index.name}" declares method "${index.method}", which ` +
        "requires PostgreSQL. materializeIndexes() reports such " +
        "declarations as skipped on SQLite instead of calling this.",
    );
  }
  const adapter = getDialect(dialect);
  const propsColumn = sql.identifier("props");
  const pointer = requireDefined(index.fields[0]);
  const expression =
    index.method === "gin" ?
      adapter.jsonExtract(propsColumn, pointer)
    : adapter.jsonExtractText(propsColumn, pointer);
  const operatorClass =
    index.method === "gin" ? "jsonb_path_ops" : "gin_trgm_ops";
  const concurrent = options.concurrent === true ? "CONCURRENTLY " : "";
  const ifNotExistsSql = (options.ifNotExists ?? true) ? "IF NOT EXISTS " : "";
  return `CREATE INDEX ${concurrent}${ifNotExistsSql}${quoteIdentifier(index.name)} ON ${quoteIdentifier(tableName)} USING GIN ((${renderSqlInline(expression, dialect)}) ${operatorClass});`;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
