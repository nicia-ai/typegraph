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
 * import { tables } from "@nicia-ai/typegraph/adapters/drizzle/postgres";
 *
 * // Custom table names
 * import { createPostgresTables } from "@nicia-ai/typegraph/adapters/drizzle/postgres";
 * const tables = createPostgresTables({
 *   nodes: "myapp_nodes",
 *   edges: "myapp_edges",
 * });
 * ```
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import {
  buildPostgresEdgeIndexBuilders,
  buildPostgresNodeIndexBuilders,
  buildPostgresSystemIndexBuilders,
} from "../../../indexes/drizzle";
import { assertNoSystemIndexNameCollision } from "../../../indexes/system";
import { type IndexDeclaration } from "../../../indexes/types";
import { regconfig, tsvector } from "../columns/fulltext";

/**
 * Table name configuration.
 */
export type PostgresTableNames = Readonly<{
  nodes: string;
  edges: string;
  recordedNodes: string;
  recordedEdges: string;
  recordedClock: string;
  revisionOrigins: string;
  uniques: string;
  schemaVersions: string;
  fulltext: string;
  indexMaterializations: string;
  contributionMaterializations: string;
  kindRemovals: string;
  reconciliationMarkers: string;
}>;

export type CreatePostgresTablesOptions = Readonly<{
  /**
   * Additional TypeGraph indexes to include in the Drizzle schema.
   *
   * These become first-class Drizzle indexes, so drizzle-kit migrations will
   * pick them up automatically.
   */
  indexes?: readonly IndexDeclaration[] | undefined;
}>;

const DEFAULT_TABLE_NAMES: PostgresTableNames = {
  nodes: "typegraph_nodes",
  edges: "typegraph_edges",
  recordedNodes: "typegraph_recorded_nodes",
  recordedEdges: "typegraph_recorded_edges",
  recordedClock: "typegraph_recorded_clock",
  revisionOrigins: "typegraph_revision_origins",
  uniques: "typegraph_node_uniques",
  schemaVersions: "typegraph_schema_versions",
  fulltext: "typegraph_node_fulltext",
  indexMaterializations: "typegraph_index_materializations",
  contributionMaterializations: "typegraph_contribution_materializations",
  kindRemovals: "typegraph_kind_removals",
  reconciliationMarkers: "typegraph_reconciliation_markers",
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
  assertNoSystemIndexNameCollision(indexes, n);

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
      // System indexes come from SYSTEM_INDEX_DECLARATIONS (single source
      // for both dialects + the runtime materializer).
      ...buildPostgresSystemIndexBuilders("nodes", n.nodes, t),
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
      ...buildPostgresSystemIndexBuilders("edges", n.edges, t),
      ...buildPostgresEdgeIndexBuilders(t, indexes),
    ],
  );

  const recordedNodes = pgTable(
    n.recordedNodes,
    {
      historyId: text("history_id").notNull(),
      graphId: text("graph_id").notNull(),
      kind: text("kind").notNull(),
      id: text("id").notNull(),
      props: jsonb("props").notNull(),
      version: integer("version").notNull(),
      validFrom: timestamp("valid_from", { withTimezone: true }),
      validTo: timestamp("valid_to", { withTimezone: true }),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
      deletedAt: timestamp("deleted_at", { withTimezone: true }),
      recordedFrom: bigint("recorded_from", { mode: "number" }).notNull(),
      recordedTo: bigint("recorded_to", { mode: "number" }).notNull(),
      op: text("op").notNull(),
      schemaVersion: integer("schema_version"),
      txId: text("tx_id"),
      meta: jsonb("meta"),
    },
    (t) => [
      primaryKey({ columns: [t.historyId] }),
      ...buildPostgresSystemIndexBuilders("recordedNodes", n.recordedNodes, t),
    ],
  );

  const recordedEdges = pgTable(
    n.recordedEdges,
    {
      historyId: text("history_id").notNull(),
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
      recordedFrom: bigint("recorded_from", { mode: "number" }).notNull(),
      recordedTo: bigint("recorded_to", { mode: "number" }).notNull(),
      op: text("op").notNull(),
      schemaVersion: integer("schema_version"),
      txId: text("tx_id"),
      meta: jsonb("meta"),
    },
    (t) => [
      primaryKey({ columns: [t.historyId] }),
      ...buildPostgresSystemIndexBuilders("recordedEdges", n.recordedEdges, t),
    ],
  );

  const recordedClock = pgTable(
    n.recordedClock,
    {
      graphId: text("graph_id").notNull(),
      revision: bigint("revision", { mode: "number" }).notNull(),
      recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    },
    (t) => [primaryKey({ columns: [t.graphId] })],
  );

  const revisionOrigins = pgTable(
    n.revisionOrigins,
    {
      graphId: text("graph_id").notNull(),
      origin: text("origin").notNull(),
    },
    (t) => [primaryKey({ columns: [t.graphId] })],
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
      // Partial unique index enforcing the "at most one active version
      // per graph" invariant at the storage layer. Defense in depth
      // against buggy backend implementations or out-of-band writes.
      // Forces the deactivate-then-activate ordering used by
      // `commitSchemaVersion` and `setActiveVersion`.
      uniqueIndex(`${n.schemaVersions}_one_active_per_graph_idx`)
        .on(t.graphId)
        .where(sql`${t.isActive} = TRUE`),
    ],
  );

  /**
   * Per-deployment record of which declared indexes have been
   * materialized against this database. Owned and written by
   * `store.materializeIndexes()`. Keyed on `index_name` because SQL
   * index names are physical, database-global identifiers — `graphId`
   * is provenance, not identity.
   */
  const indexMaterializations = pgTable(
    n.indexMaterializations,
    {
      indexName: text("index_name").notNull(),
      graphId: text("graph_id").notNull(),
      entity: text("entity").notNull(),
      kind: text("kind").notNull(),
      signature: text("signature").notNull(),
      schemaVersion: integer("schema_version").notNull(),
      materializedAt: timestamp("materialized_at", { withTimezone: true }),
      lastAttemptedAt: timestamp("last_attempted_at", {
        withTimezone: true,
      }).notNull(),
      lastError: text("last_error"),
      // Cross-caller build claim: while `building_since` is fresh (within
      // the lease), exactly one materializer owns this index's CREATE
      // INDEX CONCURRENTLY. Serializes same-index CIC across processes —
      // two concurrent expression-index CICs deadlock each other (no
      // safe-snapshot exemption). NULL when no build is in flight.
      buildingSince: timestamp("building_since", { withTimezone: true }),
      claimToken: text("claim_token"),
    },
    (t) => [primaryKey({ columns: [t.indexName] })],
  );

  /**
   * Per-deployment record of extension kinds removed via
   * `store.removeKinds()` whose data has not yet been cleaned up by
   * `store.materializeRemovals()`. Same per-deployment rationale as
   * `indexMaterializations`: two replicas of the same `schema_doc` may
   * be at different stages of the data-cleanup phase. Keyed on
   * `(graph_id, kind_name, entity, schema_version)` — each remove
   * operation is its own row. `entity` separates a node and an edge
   * that share a kind name; the `schema_version` discriminator keeps a
   * re-add-then-re-remove cycle from collapsing onto the prior row,
   * where the COALESCE-on-failure rule would preserve the earlier
   * `removed_at` and silently skip the new pending cleanup.
   */
  const kindRemovals = pgTable(
    n.kindRemovals,
    {
      graphId: text("graph_id").notNull(),
      kindName: text("kind_name").notNull(),
      entity: text("entity").notNull(),
      schemaVersion: integer("schema_version").notNull(),
      removedAt: timestamp("removed_at", { withTimezone: true }),
      lastAttemptedAt: timestamp("last_attempted_at", {
        withTimezone: true,
      }).notNull(),
      lastError: text("last_error"),
    },
    (t) => [
      primaryKey({
        columns: [t.graphId, t.kindName, t.entity, t.schemaVersion],
      }),
    ],
  );

  /**
   * Per-deployment high-water mark for `materializeRemovals`
   * reconciliation: the schema version up to which the historical
   * "did every removal land in `kindRemovals`?" walk has been
   * verified. Subsequent calls walk only versions newer than this
   * marker, instead of re-walking from version 1 every time.
   */
  const reconciliationMarkers = pgTable(
    n.reconciliationMarkers,
    {
      graphId: text("graph_id").notNull(),
      reconciledToVersion: integer("reconciled_to_version").notNull(),
    },
    (t) => [primaryKey({ columns: [t.graphId] })],
  );

  /**
   * Per-deployment durable marker that a strategy-owned table
   * contribution (#129 — fulltext today) has been materialized against
   * this database (#135). The single source of truth replacing the old
   * in-memory per-backend `fulltextEnsured` latch: "is fulltext storage
   * materialized?" is now a queryable database fact, written only by
   * the async boot path and read (cached) by the fulltext hot-path
   * gate.
   *
   * Keyed on `(graph_id, logical_name, owner, table_name)` — unlike
   * `indexMaterializations` (physical index name is database-global),
   * a contribution's identity is graph-scoped: two graphs can each own
   * a logically-identical fulltext table. `signature` is deliberately
   * NOT in the key: a same-identity row with a different signature is
   * detectable drift, surfaced as a loud error rather than a silent
   * re-materialize. `materialized_at` is null until the first success;
   * the COALESCE-on-failure rule preserves it across failed retries,
   * mirroring `indexMaterializations`.
   */
  const contributionMaterializations = pgTable(
    n.contributionMaterializations,
    {
      graphId: text("graph_id").notNull(),
      logicalName: text("logical_name").notNull(),
      owner: text("owner").notNull(),
      tableName: text("table_name").notNull(),
      signature: text("signature").notNull(),
      materializedAt: timestamp("materialized_at", { withTimezone: true }),
      lastAttemptedAt: timestamp("last_attempted_at", {
        withTimezone: true,
      }).notNull(),
      lastError: text("last_error"),
    },
    (t) => [
      primaryKey({
        columns: [t.graphId, t.logicalName, t.owner, t.tableName],
      }),
    ],
  );

  /**
   * Drizzle pg-core table for the default `tsvectorStrategy` so
   * drizzle-kit can introspect the fulltext table alongside the
   * others. Mirrors `tsvectorStrategy.ownedTables(...).createDdl` —
   * the typed shape and the strategy DDL must stay in sync (drift
   * sentinel lives in `tests/typed-fulltext-table.test.ts`).
   *
   * Why `regconfig` + GENERATED: `to_tsvector("language", "content")`
   * needs an immutable language to qualify for use inside a
   * `STORED` generated column, so Postgres can own the
   * `content → tsv` invariant.
   *
   * Alternate strategies (pg_trgm, ParadeDB, pgroonga) bring their
   * own DDL; `generatePostgresDDL` skips this typed table for them
   * and defers to the active strategy's `ownedTables(...).createDdl`.
   * Drizzle-kit consumers on non-default strategies must override
   * `tables.fulltext` in their schema barrel.
   */
  const fulltext = pgTable(
    n.fulltext,
    {
      graphId: text("graph_id").notNull(),
      nodeKind: text("node_kind").notNull(),
      nodeId: text("node_id").notNull(),
      content: text("content").notNull(),
      language: regconfig("language").notNull(),
      tsv: tsvector("tsv")
        .generatedAlwaysAs(sql`to_tsvector("language", "content")`)
        .notNull(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.graphId, t.nodeKind, t.nodeId] }),
      index(`${n.fulltext}_tsv_idx`).using("gin", t.tsv),
      index(`${n.fulltext}_kind_idx`).on(t.graphId, t.nodeKind),
    ],
  );

  return {
    nodes,
    edges,
    recordedNodes,
    recordedEdges,
    recordedClock,
    revisionOrigins,
    uniques,
    schemaVersions,
    indexMaterializations,
    contributionMaterializations,
    kindRemovals,
    reconciliationMarkers,
    fulltext,
    fulltextTableName: n.fulltext,
  } as const;
}

/**
 * Default tables with standard TypeGraph table names.
 */
export const tables = createPostgresTables();

/**
 * Convenience exports for default tables.
 */
export const {
  nodes,
  edges,
  recordedNodes,
  recordedEdges,
  recordedClock,
  uniques,
  schemaVersions,
  fulltext,
} = tables;

/**
 * Type representing the tables object returned by createPostgresTables.
 */
export type PostgresTables = ReturnType<typeof createPostgresTables>;
