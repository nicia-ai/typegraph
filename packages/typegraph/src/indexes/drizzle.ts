import { type SQLWrapper } from "drizzle-orm";
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

import { toDrizzleSql } from "../backend/drizzle/execution/types";
import { sql as portableSql, type SqlFragment } from "../query/sql-fragment";
import {
  compileEdgeIndexKeys,
  compileIndexWhere,
  compileNodeIndexKeys,
  type IndexCompilationContext,
} from "./compiler";
import {
  SYSTEM_INDEX_DECLARATIONS,
  type SystemIndexDeclaration,
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
): readonly PgIndexBuilder[] {
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
      portableSql.identifier(getPostgresNodeSystemColumn(table, column).name);

    const { keys } = compileNodeIndexKeys(
      index,
      "postgres",
      propsColumn,
      systemColumn,
    );
    assertNonEmpty(keys, `node index "${index.name}"`);

    const base = index.unique ? pgUniqueIndex(index.name) : pgIndex(index.name);

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
): readonly PgIndexBuilder[] {
  const edgeIndexes = indexes.filter(
    (index): index is EdgeIndexDeclaration =>
      index.entity === "edge" && index.method === undefined,
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

    const base = index.unique ? pgUniqueIndex(index.name) : pgIndex(index.name);

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
// System indexes (both dialects)
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
function resolveSystemIndexColumns<C extends { name: string }>(
  declaration: SystemIndexDeclaration,
  columns: SystemIndexColumns<C>,
): readonly [C, ...C[]] {
  const byPhysicalName = new Map(
    Object.values(columns).map((column) => [column.name, column]),
  );
  const resolved = declaration.columns.map((column) => {
    const value = byPhysicalName.get(column);
    if (value === undefined) {
      throw new Error(
        `System index "${declaration.table}_${declaration.suffix}" references ` +
          `a column "${column}" the ${declaration.table} table does not define`,
      );
    }
    return value;
  });
  // `declaration.columns` is non-empty by type, so `resolved` is too.
  return resolved as [C, ...C[]];
}

/**
 * The two dialect variants do no dialect-specific work (no unique, no
 * where, no expression compilation — unlike the node/edge builder pairs
 * above), so they share one body parameterized by the dialect's index
 * factory.
 */
function buildSystemIndexBuilders<C extends { name: string }, B>(
  tableKey: SystemIndexTable,
  physicalTableName: string,
  columns: SystemIndexColumns<C>,
  indexFactory: (name: string) => { on: (...cols: [C, ...C[]]) => B },
): readonly B[] {
  return SYSTEM_INDEX_DECLARATIONS.filter(
    (declaration) => declaration.table === tableKey,
  ).map((declaration) =>
    indexFactory(systemIndexName(physicalTableName, declaration.suffix)).on(
      ...resolveSystemIndexColumns(declaration, columns),
    ),
  );
}

export function buildSqliteSystemIndexBuilders(
  tableKey: SystemIndexTable,
  physicalTableName: string,
  columns: SystemIndexColumns<SQLiteColumn>,
): readonly SqliteIndexBuilder[] {
  return buildSystemIndexBuilders(
    tableKey,
    physicalTableName,
    columns,
    (name) => sqliteIndex(name),
  );
}

export function buildPostgresSystemIndexBuilders(
  tableKey: SystemIndexTable,
  physicalTableName: string,
  columns: SystemIndexColumns<PgColumn>,
): readonly PgIndexBuilder[] {
  return buildSystemIndexBuilders(
    tableKey,
    physicalTableName,
    columns,
    (name) => pgIndex(name),
  );
}

// ============================================================
// Minimal table shapes (shared between dialect schemas)
// ============================================================

type NamedSqlWrapper = SQLWrapper & Readonly<{ name: string }>;

type NodeIndexTable = Readonly<{
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

type EdgeIndexTable = Readonly<{
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
