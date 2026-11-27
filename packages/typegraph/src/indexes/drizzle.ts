import { sql as drizzleSql, type SQLWrapper } from "drizzle-orm";
import {
  index as pgIndex,
  type IndexBuilder as PgIndexBuilder,
  type PgColumn,
  uniqueIndex as pgUniqueIndex,
} from "drizzle-orm/pg-core";
import {
  index as sqliteIndex,
  type IndexBuilder as SqliteIndexBuilder,
  type SQLiteColumn,
  uniqueIndex as sqliteUniqueIndex,
} from "drizzle-orm/sqlite-core";

import { assertBundledDialectDateIndexExpressionsSupported } from "../backend/capabilities/date-index-expressions";
import { toDrizzleSql } from "../backend/drizzle/execution/types";
import { type SqlDialect } from "../query/dialect";
import { sql as portableSql, type SqlFragment } from "../query/sql-fragment";
import { requireDefined } from "../utils/presence";
import {
  compileEdgeIndexKeys,
  compileIndexWhere,
  compileNodeIndexKeys,
  type IndexCompilationContext,
} from "./compiler";
import {
  graphIdOrderIndexName,
  type SystemIndexDeclaration,
  systemIndexDeclarationsFor,
  systemIndexName,
  type SystemIndexTable,
} from "./system";
import {
  type EdgeIndexDeclaration,
  type IndexDeclaration,
  type NodeIndexDeclaration,
  type SystemColumnName,
} from "./types";

// ============================================================
// PostgreSQL (Drizzle Schema)
// ============================================================

export function buildPostgresNodeIndexBuilders(
  table: NodeIndexTable,
  indexes: readonly IndexDeclaration[],
  physicalName?: (index: NodeIndexDeclaration) => string,
): readonly PgIndexBuilder[] {
  // GIN-family declarations (method: "gin" / "trigram") are
  // materialize-only — like pgvector ANN indexes, they are a pure
  // materialization concern and never ride the Drizzle table extras.
  const nodeIndexes = indexes.filter(
    (index): index is NodeIndexDeclaration =>
      index.entity === "node" && index.method === undefined,
  );
  assertBundledDialectDateIndexExpressionsSupported(
    "postgres",
    nodeIndexes,
    "buildPostgresNodeIndexBuilders()",
  );

  return nodeIndexes.map((index) => {
    const propsColumn = portableSql.identifier(table.props.name);
    const systemColumn = (column: SystemColumnName): SqlFragment =>
      portableSql.identifier(getPostgresNodeSystemColumn(table, column).name);

    const { keys } = compileNodeIndexKeys(
      index,
      "postgres",
      propsColumn,
      systemColumn,
    );
    assertNonEmpty(keys, `node index "${index.name}"`);

    const name = physicalName?.(index) ?? index.name;
    const base = index.unique ? pgUniqueIndex(name) : pgIndex(name);

    const drizzleKeys = keys.map((key) => toDrizzleSql(key, "postgres"));
    assertNonEmpty(drizzleKeys, `node index "${index.name}"`);
    const [firstKey, ...remainingKeys] = drizzleKeys;
    const builder = base.on(firstKey, ...remainingKeys);

    if (index.where) {
      const ctx: IndexCompilationContext = {
        dialect: "postgres",
        propsColumn,
        systemColumn,
      };
      builder.where(
        toDrizzleSql(compileIndexWhere(ctx, index.where), "postgres"),
      );
    }

    return builder;
  });
}

export function buildPostgresEdgeIndexBuilders(
  table: EdgeIndexTable,
  indexes: readonly IndexDeclaration[],
  physicalName?: (index: EdgeIndexDeclaration) => string,
): readonly PgIndexBuilder[] {
  const edgeIndexes = indexes.filter(
    (index): index is EdgeIndexDeclaration =>
      index.entity === "edge" && index.method === undefined,
  );
  assertBundledDialectDateIndexExpressionsSupported(
    "postgres",
    edgeIndexes,
    "buildPostgresEdgeIndexBuilders()",
  );

  return edgeIndexes.map((index) => {
    const propsColumn = portableSql.identifier(table.props.name);
    const systemColumn = (column: SystemColumnName): SqlFragment =>
      portableSql.identifier(getPostgresEdgeSystemColumn(table, column).name);

    const { keys } = compileEdgeIndexKeys(
      index,
      "postgres",
      propsColumn,
      systemColumn,
    );
    assertNonEmpty(keys, `edge index "${index.name}"`);

    const name = physicalName?.(index) ?? index.name;
    const base = index.unique ? pgUniqueIndex(name) : pgIndex(name);

    const drizzleKeys = keys.map((key) => toDrizzleSql(key, "postgres"));
    assertNonEmpty(drizzleKeys, `edge index "${index.name}"`);
    const [firstKey, ...remainingKeys] = drizzleKeys;
    const builder = base.on(firstKey, ...remainingKeys);

    if (index.where) {
      const ctx: IndexCompilationContext = {
        dialect: "postgres",
        propsColumn,
        systemColumn,
      };
      builder.where(
        toDrizzleSql(compileIndexWhere(ctx, index.where), "postgres"),
      );
    }

    return builder;
  });
}

function getPostgresNodeSystemColumn(
  table: NodeIndexTable,
  column: SystemColumnName,
): NamedSqlWrapper {
  switch (column) {
    case "graph_id": {
      return table.graphId;
    }
    case "kind": {
      return table.kind;
    }
    case "id": {
      return table.id;
    }
    case "from_kind":
    case "from_id":
    case "to_kind":
    case "to_id": {
      throw new Error(`Unsupported node system column for indexes: ${column}`);
    }
    case "deleted_at": {
      return table.deletedAt;
    }
    case "valid_from": {
      return table.validFrom;
    }
    case "valid_to": {
      return table.validTo;
    }
    case "created_at": {
      return table.createdAt;
    }
    case "updated_at": {
      return table.updatedAt;
    }
    case "version": {
      return table.version;
    }
  }
}

function getPostgresEdgeSystemColumn(
  table: EdgeIndexTable,
  column: SystemColumnName,
): NamedSqlWrapper {
  switch (column) {
    case "graph_id": {
      return table.graphId;
    }
    case "kind": {
      return table.kind;
    }
    case "id": {
      return table.id;
    }
    case "from_kind": {
      return table.fromKind;
    }
    case "from_id": {
      return table.fromId;
    }
    case "to_kind": {
      return table.toKind;
    }
    case "to_id": {
      return table.toId;
    }
    case "deleted_at": {
      return table.deletedAt;
    }
    case "valid_from": {
      return table.validFrom;
    }
    case "valid_to": {
      return table.validTo;
    }
    case "created_at": {
      return table.createdAt;
    }
    case "updated_at": {
      return table.updatedAt;
    }
    case "version": {
      throw new Error(`Unsupported edge system column for indexes: ${column}`);
    }
  }
}

// ============================================================
// SQLite (Drizzle Schema)
// ============================================================

export function buildSqliteNodeIndexBuilders(
  table: NodeIndexTable,
  indexes: readonly IndexDeclaration[],
): readonly SqliteIndexBuilder[] {
  // GIN-family declarations (method: "gin" / "trigram") are
  // materialize-only — like pgvector ANN indexes, they are a pure
  // materialization concern and never ride the Drizzle table extras.
  const nodeIndexes = indexes.filter(
    (index): index is NodeIndexDeclaration =>
      index.entity === "node" && index.method === undefined,
  );

  return nodeIndexes.map((index) => {
    const propsColumn = portableSql.identifier(table.props.name);
    const systemColumn = (column: SystemColumnName): SqlFragment =>
      portableSql.identifier(getSqliteNodeSystemColumn(table, column).name);

    const { keys } = compileNodeIndexKeys(
      index,
      "sqlite",
      propsColumn,
      systemColumn,
    );
    assertNonEmpty(keys, `node index "${index.name}"`);

    const base =
      index.unique ? sqliteUniqueIndex(index.name) : sqliteIndex(index.name);

    const drizzleKeys = keys.map((key) => toDrizzleSql(key, "sqlite"));
    assertNonEmpty(drizzleKeys, `node index "${index.name}"`);
    const [firstKey, ...remainingKeys] = drizzleKeys;
    const builder = base.on(firstKey, ...remainingKeys);

    if (index.where) {
      const ctx: IndexCompilationContext = {
        dialect: "sqlite",
        propsColumn,
        systemColumn,
      };
      builder.where(
        toDrizzleSql(compileIndexWhere(ctx, index.where), "sqlite"),
      );
    }

    return builder;
  });
}

export function buildSqliteEdgeIndexBuilders(
  table: EdgeIndexTable,
  indexes: readonly IndexDeclaration[],
): readonly SqliteIndexBuilder[] {
  const edgeIndexes = indexes.filter(
    (index): index is EdgeIndexDeclaration =>
      index.entity === "edge" && index.method === undefined,
  );

  return edgeIndexes.map((index) => {
    const propsColumn = portableSql.identifier(table.props.name);
    const systemColumn = (column: SystemColumnName): SqlFragment =>
      portableSql.identifier(getSqliteEdgeSystemColumn(table, column).name);

    const { keys } = compileEdgeIndexKeys(
      index,
      "sqlite",
      propsColumn,
      systemColumn,
    );
    assertNonEmpty(keys, `edge index "${index.name}"`);

    const base =
      index.unique ? sqliteUniqueIndex(index.name) : sqliteIndex(index.name);

    const drizzleKeys = keys.map((key) => toDrizzleSql(key, "sqlite"));
    assertNonEmpty(drizzleKeys, `edge index "${index.name}"`);
    const [firstKey, ...remainingKeys] = drizzleKeys;
    const builder = base.on(firstKey, ...remainingKeys);

    if (index.where) {
      const ctx: IndexCompilationContext = {
        dialect: "sqlite",
        propsColumn,
        systemColumn,
      };
      builder.where(
        toDrizzleSql(compileIndexWhere(ctx, index.where), "sqlite"),
      );
    }

    return builder;
  });
}

function getSqliteNodeSystemColumn(
  table: NodeIndexTable,
  column: SystemColumnName,
): NamedSqlWrapper {
  switch (column) {
    case "graph_id": {
      return table.graphId;
    }
    case "kind": {
      return table.kind;
    }
    case "id": {
      return table.id;
    }
    case "from_kind":
    case "from_id":
    case "to_kind":
    case "to_id": {
      throw new Error(`Unsupported node system column for indexes: ${column}`);
    }
    case "deleted_at": {
      return table.deletedAt;
    }
    case "valid_from": {
      return table.validFrom;
    }
    case "valid_to": {
      return table.validTo;
    }
    case "created_at": {
      return table.createdAt;
    }
    case "updated_at": {
      return table.updatedAt;
    }
    case "version": {
      return table.version;
    }
  }
}

function getSqliteEdgeSystemColumn(
  table: EdgeIndexTable,
  column: SystemColumnName,
): NamedSqlWrapper {
  switch (column) {
    case "graph_id": {
      return table.graphId;
    }
    case "kind": {
      return table.kind;
    }
    case "id": {
      return table.id;
    }
    case "from_kind": {
      return table.fromKind;
    }
    case "from_id": {
      return table.fromId;
    }
    case "to_kind": {
      return table.toKind;
    }
    case "to_id": {
      return table.toId;
    }
    case "deleted_at": {
      return table.deletedAt;
    }
    case "valid_from": {
      return table.validFrom;
    }
    case "valid_to": {
      return table.validTo;
    }
    case "created_at": {
      return table.createdAt;
    }
    case "updated_at": {
      return table.updatedAt;
    }
    case "version": {
      throw new Error(`Unsupported edge system column for indexes: ${column}`);
    }
  }
}

// ============================================================
// System indexes (both dialects, each declaration's dialect scope applied)
// ============================================================
//
// The schema factories derive their system-index Drizzle builders from
// `SYSTEM_INDEX_DECLARATIONS` so both dialects emit the same index set by
// construction. The builders receive the table's real column objects (not
// SQL wrappers) so the DDL generator renders plain quoted column names —
// byte-identical to the runtime DDL `materializeSystemIndexes` emits.

type SystemIndexColumns<C extends { name: string }> = Readonly<
  Record<string, C>
>;

/**
 * Resolves a declaration's physical column names against the table's own
 * column objects by each column's `.name` — the SQL name Drizzle carries on
 * the column itself — so no naming convention sits between the declaration
 * and the schema. A column the table doesn't define throws at
 * table-construction time (exercised by the system-index parity tests).
 */
function resolveSystemIndexColumn<C extends { name: string }>(
  declaration: SystemIndexDeclaration,
  columns: SystemIndexColumns<C>,
  column: string,
): C {
  const value = Object.values(columns).find(
    (candidate) => candidate.name === column,
  );
  if (value === undefined) {
    throw new Error(
      `System index "${declaration.table}_${declaration.suffix}" references ` +
        `a column "${column}" the ${declaration.table} table does not define`,
    );
  }
  return value;
}

function resolveSystemIndexColumns<C extends { name: string }>(
  declaration: SystemIndexDeclaration,
  columns: SystemIndexColumns<C>,
): readonly [C, ...C[]] {
  const resolved = declaration.columns.map((column) =>
    resolveSystemIndexColumn(declaration, columns, column),
  );
  // `declaration.columns` is non-empty by type, so `resolved` is too.
  return resolved as [C, ...C[]];
}

/**
 * A partial declaration's predicate over the table's own column object, so
 * the generated DDL renders `WHERE "<column>" IS NULL` exactly as the runtime
 * DDL does.
 */
function resolveSystemIndexPredicate<C extends { name: string }>(
  declaration: SystemIndexDeclaration,
  columns: SystemIndexColumns<C>,
): ReturnType<typeof drizzleSql> | undefined {
  if (declaration.predicate === undefined) return undefined;
  const column = resolveSystemIndexColumn(
    declaration,
    columns,
    declaration.predicate.isNull,
  );
  return drizzleSql`${column} IS NULL`;
}

/**
 * Plain system indexes share this builder. PostgreSQL applies explicit
 * binary text collations to the additional ordered text keys below.
 */
function buildSystemIndexBuilders<C extends { name: string }, B>(
  dialect: SqlDialect,
  tableKey: SystemIndexTable,
  physicalTableName: string,
  columns: SystemIndexColumns<C>,
  indexFactory: (
    name: string,
    resolved: readonly [C, ...C[]],
    declaration: SystemIndexDeclaration,
  ) => B,
): readonly B[] {
  return systemIndexDeclarationsFor(dialect)
    .filter((declaration) => declaration.table === tableKey)
    .map((declaration) =>
      indexFactory(
        systemIndexName(physicalTableName, declaration.suffix),
        resolveSystemIndexColumns(declaration, columns),
        declaration,
      ),
    );
}

export function buildSqliteSystemIndexBuilders(
  tableKey: SystemIndexTable,
  physicalTableName: string,
  columns: SystemIndexColumns<SQLiteColumn>,
): readonly SqliteIndexBuilder[] {
  return buildSystemIndexBuilders(
    "sqlite",
    tableKey,
    physicalTableName,
    columns,
    (name, resolved, declaration) => {
      const builder = sqliteIndex(name).on(...resolved);
      const predicate = resolveSystemIndexPredicate(declaration, columns);
      return predicate === undefined ? builder : builder.where(predicate);
    },
  );
}

/**
 * The byte-ordered `graph_id` index (see `graphIdOrderIndexName`) as a Drizzle
 * builder, so the schema factory, drizzle-kit and the generated DDL all carry
 * the index the graph id listing seeks. PostgreSQL only: SQLite's text indexes
 * are already in byte order.
 */
export function buildPostgresGraphIdOrderIndex(
  physicalTableName: string,
  graphIdColumn: PgColumn,
): PgIndexBuilder {
  return pgIndex(graphIdOrderIndexName(physicalTableName)).on(
    drizzleSql`${graphIdColumn} COLLATE "C"`,
  );
}

export function buildPostgresSystemIndexBuilders(
  tableKey: SystemIndexTable,
  physicalTableName: string,
  columns: SystemIndexColumns<PgColumn>,
): readonly PgIndexBuilder[] {
  return buildSystemIndexBuilders(
    "postgres",
    tableKey,
    physicalTableName,
    columns,
    (name, resolved, declaration) => {
      const keys = resolved.map((column) =>
        declaration.binaryOrderColumns?.includes(column.name) === true ?
          drizzleSql`${column} COLLATE "C"`
        : column,
      );
      const builder = pgIndex(name).on(
        requireDefined(keys[0]),
        ...keys.slice(1),
      );
      const predicate = resolveSystemIndexPredicate(declaration, columns);
      return predicate === undefined ? builder : builder.where(predicate);
    },
  );
}

// ============================================================
// Minimal table shapes (shared between dialect schemas)
// ============================================================

export type NamedSqlWrapper = SQLWrapper & Readonly<{ name: string }>;

export type NodeIndexTable = Readonly<{
  graphId: NamedSqlWrapper;
  kind: NamedSqlWrapper;
  id: NamedSqlWrapper;
  props: NamedSqlWrapper;
  version: NamedSqlWrapper;
  validFrom: NamedSqlWrapper;
  validTo: NamedSqlWrapper;
  createdAt: NamedSqlWrapper;
  updatedAt: NamedSqlWrapper;
  deletedAt: NamedSqlWrapper;
}>;

export type EdgeIndexTable = Readonly<{
  graphId: NamedSqlWrapper;
  id: NamedSqlWrapper;
  kind: NamedSqlWrapper;
  fromKind: NamedSqlWrapper;
  fromId: NamedSqlWrapper;
  toKind: NamedSqlWrapper;
  toId: NamedSqlWrapper;
  props: NamedSqlWrapper;
  validFrom: NamedSqlWrapper;
  validTo: NamedSqlWrapper;
  createdAt: NamedSqlWrapper;
  updatedAt: NamedSqlWrapper;
  deletedAt: NamedSqlWrapper;
}>;

function assertNonEmpty<T>(
  values: readonly T[],
  label: string,
): asserts values is readonly [T, ...T[]] {
  if (values.length === 0) {
    throw new Error(`Index must have at least one key (${label})`);
  }
}
