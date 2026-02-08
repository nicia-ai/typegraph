/**
 * Drizzle SQLite schema for TypeGraph.
 *
 * Provides table definitions that can be customized via the factory function.
 * Users import these tables into their Drizzle schema and use drizzle-kit
 * for migrations.
 *
 * @example
 * ```typescript
 * // Default table names
 * import { tables } from "@nicia-ai/typegraph/drizzle/schema/sqlite";
 *
 * // Custom table names
 * import { createSqliteTables } from "@nicia-ai/typegraph/drizzle/schema/sqlite";
 * const tables = createSqliteTables({
 *   nodes: "myapp_nodes",
 *   edges: "myapp_edges",
 * });
 * ```
 */
import {
  blob,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

import {
  buildSqliteEdgeIndexBuilders,
  buildSqliteNodeIndexBuilders,
  type TypeGraphIndex,
} from "../../../indexes";

/**
 * Table name configuration.
 */
export type TableNames = Readonly<{
  nodes: string;
  edges: string;
  uniques: string;
  schemaVersions: string;
  embeddings: string;
}>;

export type CreateSqliteTablesOptions = Readonly<{
  /**
   * Additional TypeGraph indexes to include in the Drizzle schema.
   *
   * These become first-class Drizzle indexes, so drizzle-kit migrations will
   * pick them up automatically.
   */
  indexes?: readonly TypeGraphIndex[] | undefined;
}>;

const DEFAULT_TABLE_NAMES: TableNames = {
  nodes: "typegraph_nodes",
  edges: "typegraph_edges",
  uniques: "typegraph_node_uniques",
  schemaVersions: "typegraph_schema_versions",
  embeddings: "typegraph_node_embeddings",
};

/**
 * Creates SQLite table definitions with customizable table names.
 * Index names are derived from table names.
 */
export function createSqliteTables(
  names: Partial<TableNames> = {},
  options: CreateSqliteTablesOptions = {},
) {
  const n: TableNames = { ...DEFAULT_TABLE_NAMES, ...names };
  const indexes = options.indexes ?? [];

  const nodes = sqliteTable(
    n.nodes,
    {
      graphId: text("graph_id").notNull(),
      kind: text("kind").notNull(),
      id: text("id").notNull(),
      props: text("props").notNull(),
      version: integer("version").notNull().default(1),
      validFrom: text("valid_from"),
      validTo: text("valid_to"),
      createdAt: text("created_at").notNull(),
      updatedAt: text("updated_at").notNull(),
      deletedAt: text("deleted_at"),
    },
    (t) => [
      primaryKey({ columns: [t.graphId, t.kind, t.id] }),
      index(`${n.nodes}_kind_idx`).on(t.graphId, t.kind),
      index(`${n.nodes}_deleted_idx`).on(t.graphId, t.deletedAt),
      index(`${n.nodes}_valid_idx`).on(t.graphId, t.validFrom, t.validTo),
      ...buildSqliteNodeIndexBuilders(t, indexes),
    ],
  );

  const edges = sqliteTable(
    n.edges,
    {
      graphId: text("graph_id").notNull(),
      id: text("id").notNull(),
      kind: text("kind").notNull(),
      fromKind: text("from_kind").notNull(),
      fromId: text("from_id").notNull(),
      toKind: text("to_kind").notNull(),
      toId: text("to_id").notNull(),
      props: text("props").notNull(),
      validFrom: text("valid_from"),
      validTo: text("valid_to"),
      createdAt: text("created_at").notNull(),
      updatedAt: text("updated_at").notNull(),
      deletedAt: text("deleted_at"),
    },
    (t) => [
      primaryKey({ columns: [t.graphId, t.id] }),
      index(`${n.edges}_kind_idx`).on(t.graphId, t.kind),
      index(`${n.edges}_from_idx`).on(t.graphId, t.fromKind, t.fromId),
      index(`${n.edges}_to_idx`).on(t.graphId, t.toKind, t.toId),
      index(`${n.edges}_deleted_idx`).on(t.graphId, t.deletedAt),
      index(`${n.edges}_valid_idx`).on(t.graphId, t.validFrom, t.validTo),
      index(`${n.edges}_cardinality_idx`).on(
        t.graphId,
        t.kind,
        t.fromKind,
        t.fromId,
        t.validTo,
      ),
      ...buildSqliteEdgeIndexBuilders(t, indexes),
    ],
  );

  const uniques = sqliteTable(
    n.uniques,
    {
      graphId: text("graph_id").notNull(),
      nodeKind: text("node_kind").notNull(),
      constraintName: text("constraint_name").notNull(),
      key: text("key").notNull(),
      nodeId: text("node_id").notNull(),
      concreteKind: text("concrete_kind").notNull(),
      deletedAt: text("deleted_at"),
    },
    (t) => [
      primaryKey({
        columns: [t.graphId, t.nodeKind, t.constraintName, t.key],
      }),
      index(`${n.uniques}_node_idx`).on(t.graphId, t.concreteKind, t.nodeId),
    ],
  );

  const schemaVersions = sqliteTable(
    n.schemaVersions,
    {
      graphId: text("graph_id").notNull(),
      version: integer("version").notNull(),
      schemaHash: text("schema_hash").notNull(),
      schemaDoc: text("schema_doc").notNull(),
      createdAt: text("created_at").notNull(),
      isActive: integer("is_active", { mode: "boolean" })
        .notNull()
        .default(false),
    },
    (t) => [
      primaryKey({ columns: [t.graphId, t.version] }),
      index(`${n.schemaVersions}_active_idx`).on(t.graphId, t.isActive),
    ],
  );

  /**
   * Embeddings table for vector search.
   *
   * Stores embeddings as BLOB (for sqlite-vec binary format) or as JSON text.
   * When sqlite-vec extension is loaded, the BLOB column can be used with
   * vec_f32() for similarity operations.
   */
  const embeddings = sqliteTable(
    n.embeddings,
    {
      graphId: text("graph_id").notNull(),
      nodeKind: text("node_kind").notNull(),
      nodeId: text("node_id").notNull(),
      fieldPath: text("field_path").notNull(),
      /**
       * Embedding vector.
       * Stored as BLOB for sqlite-vec binary format, or JSON text for fallback.
       * For sqlite-vec: use vec_f32() to convert JSON array to binary.
       */
      embedding: blob("embedding", { mode: "buffer" }).notNull(),
      /** Number of dimensions (for validation) */
      dimensions: integer("dimensions").notNull(),
      createdAt: text("created_at").notNull(),
      updatedAt: text("updated_at").notNull(),
    },
    (t) => [
      primaryKey({
        columns: [t.graphId, t.nodeKind, t.nodeId, t.fieldPath],
      }),
      // Index for looking up embeddings by node
      index(`${n.embeddings}_node_idx`).on(
        t.graphId,
        t.nodeKind,
        t.nodeId,
      ),
      // Index for filtering by kind and field (used in vector search)
      index(`${n.embeddings}_kind_field_idx`).on(
        t.graphId,
        t.nodeKind,
        t.fieldPath,
      ),
    ],
  );

  return { nodes, edges, uniques, schemaVersions, embeddings } as const;
}

/**
 * Default tables with standard TypeGraph table names.
 */
export const tables = createSqliteTables();

/**
 * Convenience exports for default tables.
 */
export const { nodes, edges, uniques, schemaVersions, embeddings } = tables;

/**
 * Type representing the tables object returned by createSqliteTables.
 */
export type SqliteTables = ReturnType<typeof createSqliteTables>;

/**
 * Type for nodes table.
 */
export type NodesTable = SqliteTables["nodes"];

/**
 * Type for edges table.
 */
export type EdgesTable = SqliteTables["edges"];

/**
 * Type for uniques table.
 */
export type UniquesTable = SqliteTables["uniques"];

/**
 * Type for schema versions table.
 */
export type SchemaVersionsTable = SqliteTables["schemaVersions"];

/**
 * Type for embeddings table.
 */
export type EmbeddingsTable = SqliteTables["embeddings"];
