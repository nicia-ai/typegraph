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
 * import { tables } from "@nicia-ai/typegraph/sqlite";
 *
 * // Custom table names
 * import { createSqliteTables } from "@nicia-ai/typegraph/sqlite";
 * const tables = createSqliteTables({
 *   nodes: "myapp_nodes",
 *   edges: "myapp_edges",
 * });
 * ```
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import {
  buildSqliteEdgeIndexBuilders,
  buildSqliteNodeIndexBuilders,
} from "../../../indexes/drizzle";
import { type IndexDeclaration } from "../../../indexes/types";

/**
 * Table name configuration.
 */
export type SqliteTableNames = Readonly<{
  nodes: string;
  edges: string;
  uniques: string;
  schemaVersions: string;
  fulltext: string;
  indexMaterializations: string;
  contributionMaterializations: string;
  kindRemovals: string;
  reconciliationMarkers: string;
  nodeHistory: string;
  edgeHistory: string;
}>;

/**
 * Physical name of the legacy single shared embeddings table, dropped in
 * the cross-backend vector cutover (the clean cut of #157). Strategies now
 * own per-`(nodeKind, fieldPath)` typed storage. Retained only so the
 * one-time migration utility can address and drain the old table.
 */
export const LEGACY_EMBEDDINGS_TABLE_NAME = "typegraph_node_embeddings";

export type CreateSqliteTablesOptions = Readonly<{
  /**
   * Additional TypeGraph indexes to include in the Drizzle schema.
   *
   * These become first-class Drizzle indexes, so drizzle-kit migrations will
   * pick them up automatically.
   */
  indexes?: readonly IndexDeclaration[] | undefined;
}>;

const DEFAULT_TABLE_NAMES: SqliteTableNames = {
  nodes: "typegraph_nodes",
  edges: "typegraph_edges",
  uniques: "typegraph_node_uniques",
  schemaVersions: "typegraph_schema_versions",
  fulltext: "typegraph_node_fulltext",
  indexMaterializations: "typegraph_index_materializations",
  contributionMaterializations: "typegraph_contribution_materializations",
  kindRemovals: "typegraph_kind_removals",
  reconciliationMarkers: "typegraph_reconciliation_markers",
  nodeHistory: "typegraph_node_history",
  edgeHistory: "typegraph_edge_history",
};

/**
 * Creates SQLite table definitions with customizable table names.
 * Index names are derived from table names.
 */
export function createSqliteTables(
  names: Partial<SqliteTableNames> = {},
  options: CreateSqliteTablesOptions = {},
) {
  const n: SqliteTableNames = { ...DEFAULT_TABLE_NAMES, ...names };
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
      index(`${n.nodes}_kind_created_idx`).on(
        t.graphId,
        t.kind,
        t.deletedAt,
        t.createdAt,
      ),
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
      // Partial unique index enforcing the "at most one active version
      // per graph" invariant at the storage layer. Defense in depth
      // against buggy backend implementations or out-of-band writes.
      // Forces the deactivate-then-activate ordering used by
      // `commitSchemaVersion` and `setActiveVersion`.
      uniqueIndex(`${n.schemaVersions}_one_active_per_graph_idx`)
        .on(t.graphId)
        .where(sql`${t.isActive} = 1`),
    ],
  );

  /**
   * Per-deployment record of which declared indexes have been
   * materialized against this database. Owned and written by
   * `store.materializeIndexes()`. Keyed on `index_name` because SQL
   * index names are physical, database-global identifiers — `graphId`
   * is provenance, not identity.
   */
  const indexMaterializations = sqliteTable(
    n.indexMaterializations,
    {
      indexName: text("index_name").notNull(),
      graphId: text("graph_id").notNull(),
      entity: text("entity").notNull(),
      kind: text("kind").notNull(),
      signature: text("signature").notNull(),
      schemaVersion: integer("schema_version").notNull(),
      materializedAt: text("materialized_at"),
      lastAttemptedAt: text("last_attempted_at").notNull(),
      lastError: text("last_error"),
    },
    (t) => [primaryKey({ columns: [t.indexName] })],
  );

  /**
   * Per-deployment record of extension kinds removed via
   * `store.removeKinds()` whose data has not yet been cleaned up by
   * `store.materializeRemovals()`. Keyed on `(graph_id, kind_name,
   * entity, schema_version)` — each remove operation is its own row.
   * `entity` separates a node and an edge that share a kind name; the
   * `schema_version` discriminator keeps a re-add-then-re-remove cycle
   * (Foo removed at v=N, re-added, then removed again at v=N+2) from
   * collapsing onto the prior row, where the COALESCE-on-failure rule
   * would preserve the earlier `removed_at` and silently skip the new
   * pending cleanup. `removed_at` is null until the data-cleanup pass
   * succeeds; the pending set is "rows where removed_at IS NULL".
   */
  const kindRemovals = sqliteTable(
    n.kindRemovals,
    {
      graphId: text("graph_id").notNull(),
      kindName: text("kind_name").notNull(),
      entity: text("entity").notNull(),
      schemaVersion: integer("schema_version").notNull(),
      removedAt: text("removed_at"),
      lastAttemptedAt: text("last_attempted_at").notNull(),
      lastError: text("last_error"),
    },
    (t) => [
      primaryKey({
        columns: [t.graphId, t.kindName, t.entity, t.schemaVersion],
      }),
    ],
  );

  /**
   * Per-deployment high-water mark for the `materializeRemovals`
   * reconciliation walk. One row per `graph_id` carrying the schema
   * version up to which the historical "did every removal land in
   * `kindRemovals`?" walk has been verified. Lets subsequent calls
   * skip already-checked transitions instead of re-walking from
   * version 1 every time.
   */
  const reconciliationMarkers = sqliteTable(
    n.reconciliationMarkers,
    {
      graphId: text("graph_id").notNull(),
      reconciledToVersion: integer("reconciled_to_version").notNull(),
    },
    (t) => [primaryKey({ columns: [t.graphId] })],
  );

  /**
   * Per-deployment durable marker that a strategy-owned table
   * contribution (#129 — the FTS5 virtual table today) has been
   * materialized against this database (#135). Replaces the in-memory
   * per-backend `fulltextEnsured` latch with a queryable database fact.
   * Keyed on `(graph_id, logical_name, owner, table_name)`; `signature`
   * stays out of the key so same-identity drift is a loud error, not a
   * silent re-materialize. Same COALESCE-on-failure preservation rule
   * as `indexMaterializations`.
   */
  const contributionMaterializations = sqliteTable(
    n.contributionMaterializations,
    {
      graphId: text("graph_id").notNull(),
      logicalName: text("logical_name").notNull(),
      owner: text("owner").notNull(),
      tableName: text("table_name").notNull(),
      signature: text("signature").notNull(),
      materializedAt: text("materialized_at"),
      lastAttemptedAt: text("last_attempted_at").notNull(),
      lastError: text("last_error"),
    },
    (t) => [
      primaryKey({
        columns: [t.graphId, t.logicalName, t.owner, t.tableName],
      }),
    ],
  );

  /**
   * Recorded-time history side-table for nodes (F1a). Holds the complete
   * pre-image of every mutated node row plus a `[recorded_from,
   * recorded_to)` currency interval and audit columns (`op`,
   * `schema_version`, `tx_id`, `meta`). Written in the same transaction
   * as the mutation when `history` capture is enabled; never on create.
   *
   * `historyId` is a surrogate autoincrement PK for row identity (a
   * same-timestamp transition tiebreaker); it is an implementation detail,
   * never exposed in the read API and granting no replay semantics —
   * user-visible ordering is `(recorded_from, recorded_to, version)`. The
   * autoincrement column-PK can't be expressed by the generic DDL walker,
   * so this table's DDL is emitted by `generateSqliteHistoryTableSQL` and
   * excluded from the column-walker contribution set.
   */
  const nodeHistory = sqliteTable(
    n.nodeHistory,
    {
      historyId: integer("history_id").primaryKey({ autoIncrement: true }),
      graphId: text("graph_id").notNull(),
      kind: text("kind").notNull(),
      id: text("id").notNull(),
      props: text("props").notNull(),
      version: integer("version").notNull(),
      validFrom: text("valid_from"),
      validTo: text("valid_to"),
      createdAt: text("created_at").notNull(),
      updatedAt: text("updated_at").notNull(),
      deletedAt: text("deleted_at"),
      recordedFrom: text("recorded_from").notNull(),
      recordedTo: text("recorded_to").notNull(),
      op: text("op").notNull(),
      schemaVersion: integer("schema_version").notNull(),
      txId: text("tx_id").notNull(),
      meta: text("meta"),
    },
    (t) => [
      index(`${n.nodeHistory}_entity_idx`).on(
        t.graphId,
        t.kind,
        t.id,
        t.recordedTo,
      ),
      index(`${n.nodeHistory}_prune_idx`).on(t.graphId, t.recordedTo),
    ],
  );

  /**
   * Recorded-time history side-table for edges (F1a). Mirrors
   * {@link nodeHistory}; see its doc for the contract.
   */
  const edgeHistory = sqliteTable(
    n.edgeHistory,
    {
      historyId: integer("history_id").primaryKey({ autoIncrement: true }),
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
      recordedFrom: text("recorded_from").notNull(),
      recordedTo: text("recorded_to").notNull(),
      op: text("op").notNull(),
      schemaVersion: integer("schema_version").notNull(),
      txId: text("tx_id").notNull(),
      meta: text("meta"),
    },
    (t) => [
      index(`${n.edgeHistory}_entity_idx`).on(t.graphId, t.id, t.recordedTo),
      index(`${n.edgeHistory}_prune_idx`).on(t.graphId, t.recordedTo),
    ],
  );

  return {
    nodes,
    edges,
    uniques,
    schemaVersions,
    indexMaterializations,
    contributionMaterializations,
    kindRemovals,
    reconciliationMarkers,
    nodeHistory,
    edgeHistory,
    /**
     * The fulltext storage is a FTS5 virtual table which Drizzle cannot
     * represent. DDL is emitted as raw SQL and operations query it via
     * `sql.raw()`.
     */
    fulltextTableName: n.fulltext,
  } as const;
}

/**
 * Default tables with standard TypeGraph table names.
 */
export const tables = createSqliteTables();

/**
 * Convenience exports for default tables.
 */
export const { nodes, edges, uniques, schemaVersions } = tables;

/**
 * Type representing the tables object returned by createSqliteTables.
 */
export type SqliteTables = ReturnType<typeof createSqliteTables>;
