/**
 * Drizzle PostgreSQL schema for TypeGraph.
 *
 * Provides table definitions that can be customized via the factory function.
 * Uses PostgreSQL-native types: JSONB, TIMESTAMPTZ, BOOLEAN, VECTOR.
 *
 * The embeddings table uses pgvector's native VECTOR type. Ensure the
 * extension is enabled before creating tables:
 *
 * ```sql
 * CREATE EXTENSION IF NOT EXISTS vector;
 * ```
 *
 * @example
 * ```typescript
 * // Default table names
 * import { tables } from "@nicia-ai/typegraph/drizzle/schema/postgres";
 *
 * // Custom table names
 * import { createPostgresTables } from "@nicia-ai/typegraph/drizzle/schema/postgres";
 * const tables = createPostgresTables({
 *   nodes: "myapp_nodes",
 *   edges: "myapp_edges",
 * });
 * ```
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import {
  buildPostgresEdgeIndexBuilders,
  buildPostgresNodeIndexBuilders,
  type TypeGraphIndex,
} from "../../../indexes";
import { vector } from "../columns/vector";

/**
 * Table name configuration.
 */
export type PostgresTableNames = Readonly<{
  nodes: string;
  edges: string;
  uniques: string;
  schemaVersions: string;
  embeddings: string;
}>;

export type CreatePostgresTablesOptions = Readonly<{
  /**
   * Additional TypeGraph indexes to include in the Drizzle schema.
   *
   * These become first-class Drizzle indexes, so drizzle-kit migrations will
   * pick them up automatically.
   */
  indexes?: readonly TypeGraphIndex[] | undefined;
}>;

const DEFAULT_TABLE_NAMES: PostgresTableNames = {
  nodes: "typegraph_nodes",
  edges: "typegraph_edges",
  uniques: "typegraph_node_uniques",
  schemaVersions: "typegraph_schema_versions",
  embeddings: "typegraph_node_embeddings",
};

/**
 * Creates PostgreSQL table definitions with customizable table names.
 * Index names are derived from table names.
 */
export function createPostgresTables(
  names: Partial<PostgresTableNames> = {},
  options: CreatePostgresTablesOptions = {},
) {
  const n: PostgresTableNames = { ...DEFAULT_TABLE_NAMES, ...names };
  const indexes = options.indexes ?? [];

  const nodes = pgTable(
    n.nodes,
    {
      graphId: text("graph_id").notNull(),
      kind: text("kind").notNull(),
      id: text("id").notNull(),
      props: jsonb("props").notNull(),
      version: integer("version").notNull().default(1),
      validFrom: timestamp("valid_from", { withTimezone: true }),
      validTo: timestamp("valid_to", { withTimezone: true }),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
      deletedAt: timestamp("deleted_at", { withTimezone: true }),
    },
    (t) => [
      primaryKey({ columns: [t.graphId, t.kind, t.id] }),
      index(`${n.nodes}_kind_idx`).on(t.graphId, t.kind),
      index(`${n.nodes}_kind_created_idx`).on(
        t.graphId,
        t.kind,
        t.deletedAt,
        t.createdAt,
      ),
      index(`${n.nodes}_deleted_idx`).on(t.graphId, t.deletedAt),
      index(`${n.nodes}_valid_idx`).on(t.graphId, t.validFrom, t.validTo),
      ...buildPostgresNodeIndexBuilders(t, indexes),
    ],
  );

  const edges = pgTable(
    n.edges,
    {
      graphId: text("graph_id").notNull(),
      id: text("id").notNull(),
      kind: text("kind").notNull(),
      fromKind: text("from_kind").notNull(),
      fromId: text("from_id").notNull(),
      toKind: text("to_kind").notNull(),
      toId: text("to_id").notNull(),
      props: jsonb("props").notNull(),
      validFrom: timestamp("valid_from", { withTimezone: true }),
      validTo: timestamp("valid_to", { withTimezone: true }),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
      deletedAt: timestamp("deleted_at", { withTimezone: true }),
    },
    (t) => [
      primaryKey({ columns: [t.graphId, t.id] }),
      index(`${n.edges}_kind_idx`).on(t.graphId, t.kind),
      // Directional traversal index (outgoing): supports endpoint lookups
      // and extra filtering by edge kind / target kind.
      index(`${n.edges}_from_idx`).on(
        t.graphId,
        t.fromKind,
        t.fromId,
        t.kind,
        t.toKind,
        t.deletedAt,
        t.validTo,
      ),
      // Directional traversal index (incoming): mirrors from_idx for reverse traversals.
      index(`${n.edges}_to_idx`).on(
        t.graphId,
        t.toKind,
        t.toId,
        t.kind,
        t.fromKind,
        t.deletedAt,
        t.validTo,
      ),
      index(`${n.edges}_kind_created_idx`).on(
        t.graphId,
        t.kind,
        t.deletedAt,
        t.createdAt,
      ),
      index(`${n.edges}_deleted_idx`).on(t.graphId, t.deletedAt),
      index(`${n.edges}_valid_idx`).on(t.graphId, t.validFrom, t.validTo),
      index(`${n.edges}_cardinality_idx`).on(
        t.graphId,
        t.kind,
        t.fromKind,
        t.fromId,
        t.validTo,
      ),
      ...buildPostgresEdgeIndexBuilders(t, indexes),
    ],
  );

  const uniques = pgTable(
    n.uniques,
    {
      graphId: text("graph_id").notNull(),
      nodeKind: text("node_kind").notNull(),
      constraintName: text("constraint_name").notNull(),
      key: text("key").notNull(),
      nodeId: text("node_id").notNull(),
      concreteKind: text("concrete_kind").notNull(),
      deletedAt: timestamp("deleted_at", { withTimezone: true }),
    },
    (t) => [
      primaryKey({
        columns: [t.graphId, t.nodeKind, t.constraintName, t.key],
      }),
      index(`${n.uniques}_node_idx`).on(t.graphId, t.concreteKind, t.nodeId),
    ],
  );

  const schemaVersions = pgTable(
    n.schemaVersions,
    {
      graphId: text("graph_id").notNull(),
      version: integer("version").notNull(),
      schemaHash: text("schema_hash").notNull(),
      schemaDoc: jsonb("schema_doc").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
      isActive: boolean("is_active").notNull().default(false),
    },
    (t) => [
      primaryKey({ columns: [t.graphId, t.version] }),
      index(`${n.schemaVersions}_active_idx`).on(t.graphId, t.isActive),
    ],
  );

  /**
   * Embeddings table for vector search.
   *
   * Stores embeddings using pgvector's native VECTOR type for efficient
   * similarity operations without runtime casts.
   *
   * The column uses unparameterized VECTOR type to support multiple
   * embedding dimensions in a single table. Dimension validation is
   * handled at the application level via the `dimensions` column.
   *
   * Requires pgvector extension:
   *   CREATE EXTENSION IF NOT EXISTS vector;
   *
   * Vector indices (HNSW, IVFFlat) are created dynamically based on the
   * configured metric and dimensions.
   */
  const embeddings = pgTable(
    n.embeddings,
    {
      graphId: text("graph_id").notNull(),
      nodeKind: text("node_kind").notNull(),
      nodeId: text("node_id").notNull(),
      fieldPath: text("field_path").notNull(),
      /** Embedding vector stored as native pgvector type */
      embedding: vector("embedding").notNull(),
      /** Number of dimensions (for validation) */
      dimensions: integer("dimensions").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
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
export const tables = createPostgresTables();

/**
 * Convenience exports for default tables.
 */
export const { nodes, edges, uniques, schemaVersions, embeddings } = tables;

/**
 * Type representing the tables object returned by createPostgresTables.
 */
export type PostgresTables = ReturnType<typeof createPostgresTables>;

/**
 * Type for nodes table.
 */
export type NodesTable = PostgresTables["nodes"];

/**
 * Type for edges table.
 */
export type EdgesTable = PostgresTables["edges"];

/**
 * Type for uniques table.
 */
export type UniquesTable = PostgresTables["uniques"];

/**
 * Type for schema versions table.
 */
export type SchemaVersionsTable = PostgresTables["schemaVersions"];

/**
 * Type for embeddings table.
 */
export type EmbeddingsTable = PostgresTables["embeddings"];
