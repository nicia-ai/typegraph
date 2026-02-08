import { type SQL, sql, type SQLWrapper } from "drizzle-orm";
import {
  index as pgIndex,
  type IndexBuilder as PgIndexBuilder,
  uniqueIndex as pgUniqueIndex,
} from "drizzle-orm/pg-core";
import {
  index as sqliteIndex,
  type IndexBuilder as SqliteIndexBuilder,
  uniqueIndex as sqliteUniqueIndex,
} from "drizzle-orm/sqlite-core";

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

// ============================================================
// PostgreSQL (Drizzle Schema)
// ============================================================

export function buildPostgresNodeIndexBuilders(
  table: NodeIndexTable,
  indexes: readonly TypeGraphIndex[],
): readonly PgIndexBuilder[] {
  const nodeIndexes = indexes.filter(
    (index): index is NodeIndex => index.__type === "typegraph_node_index",
  );

  return nodeIndexes.map((index) => {
    const propsColumn = sql`${table.props}`;
    const systemColumn = (column: SystemColumnName): SQL =>
      sql`${getPostgresNodeSystemColumn(table, column)}`;

    const { keys } = compileNodeIndexKeys(
      index,
      "postgres",
      propsColumn,
      systemColumn,
    );
    assertNonEmpty(keys, `node index "${index.name}"`);

    const base = index.unique ? pgUniqueIndex(index.name) : pgIndex(index.name);

    const builder = base.on(...keys);

    if (index.where) {
      const ctx: IndexCompilationContext = {
        dialect: "postgres",
        propsColumn,
        systemColumn,
      };
      builder.where(compileIndexWhere(ctx, index.where));
    }

    return builder;
  });
}

export function buildPostgresEdgeIndexBuilders(
  table: EdgeIndexTable,
  indexes: readonly TypeGraphIndex[],
): readonly PgIndexBuilder[] {
  const edgeIndexes = indexes.filter(
    (index): index is EdgeIndex => index.__type === "typegraph_edge_index",
  );

  return edgeIndexes.map((index) => {
    const propsColumn = sql`${table.props}`;
    const systemColumn = (column: SystemColumnName): SQL =>
      sql`${getPostgresEdgeSystemColumn(table, column)}`;

    const { keys } = compileEdgeIndexKeys(
      index,
      "postgres",
      propsColumn,
      systemColumn,
    );
    assertNonEmpty(keys, `edge index "${index.name}"`);

    const base = index.unique ? pgUniqueIndex(index.name) : pgIndex(index.name);

    const builder = base.on(...keys);

    if (index.where) {
      const ctx: IndexCompilationContext = {
        dialect: "postgres",
        propsColumn,
        systemColumn,
      };
      builder.where(compileIndexWhere(ctx, index.where));
    }

    return builder;
  });
}

function getPostgresNodeSystemColumn(
  table: NodeIndexTable,
  column: SystemColumnName,
): SQLWrapper {
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
): SQLWrapper {
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
  indexes: readonly TypeGraphIndex[],
): readonly SqliteIndexBuilder[] {
  const nodeIndexes = indexes.filter(
    (index): index is NodeIndex => index.__type === "typegraph_node_index",
  );

  return nodeIndexes.map((index) => {
    const propsColumn = sql`${table.props}`;
    const systemColumn = (column: SystemColumnName): SQL =>
      sql`${getSqliteNodeSystemColumn(table, column)}`;

    const { keys } = compileNodeIndexKeys(
      index,
      "sqlite",
      propsColumn,
      systemColumn,
    );
    assertNonEmpty(keys, `node index "${index.name}"`);

    const base =
      index.unique ? sqliteUniqueIndex(index.name) : sqliteIndex(index.name);

    const builder = base.on(...keys);

    if (index.where) {
      const ctx: IndexCompilationContext = {
        dialect: "sqlite",
        propsColumn,
        systemColumn,
      };
      builder.where(compileIndexWhere(ctx, index.where));
    }

    return builder;
  });
}

export function buildSqliteEdgeIndexBuilders(
  table: EdgeIndexTable,
  indexes: readonly TypeGraphIndex[],
): readonly SqliteIndexBuilder[] {
  const edgeIndexes = indexes.filter(
    (index): index is EdgeIndex => index.__type === "typegraph_edge_index",
  );

  return edgeIndexes.map((index) => {
    const propsColumn = sql`${table.props}`;
    const systemColumn = (column: SystemColumnName): SQL =>
      sql`${getSqliteEdgeSystemColumn(table, column)}`;

    const { keys } = compileEdgeIndexKeys(
      index,
      "sqlite",
      propsColumn,
      systemColumn,
    );
    assertNonEmpty(keys, `edge index "${index.name}"`);

    const base =
      index.unique ? sqliteUniqueIndex(index.name) : sqliteIndex(index.name);

    const builder = base.on(...keys);

    if (index.where) {
      const ctx: IndexCompilationContext = {
        dialect: "sqlite",
        propsColumn,
        systemColumn,
      };
      builder.where(compileIndexWhere(ctx, index.where));
    }

    return builder;
  });
}

function getSqliteNodeSystemColumn(
  table: NodeIndexTable,
  column: SystemColumnName,
): SQLWrapper {
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
): SQLWrapper {
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
// Minimal table shapes (shared between dialect schemas)
// ============================================================

type NodeIndexTable = Readonly<{
  graphId: SQLWrapper;
  kind: SQLWrapper;
  id: SQLWrapper;
  props: SQLWrapper;
  version: SQLWrapper;
  validFrom: SQLWrapper;
  validTo: SQLWrapper;
  createdAt: SQLWrapper;
  updatedAt: SQLWrapper;
  deletedAt: SQLWrapper;
}>;

type EdgeIndexTable = Readonly<{
  graphId: SQLWrapper;
  id: SQLWrapper;
  kind: SQLWrapper;
  fromKind: SQLWrapper;
  fromId: SQLWrapper;
  toKind: SQLWrapper;
  toId: SQLWrapper;
  props: SQLWrapper;
  validFrom: SQLWrapper;
  validTo: SQLWrapper;
  createdAt: SQLWrapper;
  updatedAt: SQLWrapper;
  deletedAt: SQLWrapper;
}>;

function assertNonEmpty(
  values: readonly SQL[],
  label: string,
): asserts values is readonly [SQL, ...SQL[]] {
  if (values.length === 0) {
    throw new Error(`Index must have at least one key (${label})`);
  }
}
