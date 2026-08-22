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
  check,
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
  identityAssertions: string;
  recordedIdentityAssertions: string;
  identityClosure: string;
  identitySeparation: string;
  uniques: string;
  edgeClaims: string;
  schemaVersions: string;
  graphTemplates: string;
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
  identityAssertions: "typegraph_identity_assertions",
  recordedIdentityAssertions: "typegraph_recorded_identity_assertions",
  identityClosure: "typegraph_identity_closure",
  identitySeparation: "typegraph_identity_separation",
  uniques: "typegraph_node_uniques",
  edgeClaims: "typegraph_edge_claims",
  schemaVersions: "typegraph_schema_versions",
  graphTemplates: "typegraph_graph_templates",
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

  // The identity assertion ledger. `ended_by_kind` / `ended_by_id` record WHY
  // an assertion stopped being current: NULL for an explicit retraction,
  // populated with the deleted endpoint's `(kind, id)` when a node soft-delete
  // cascaded onto it. The CHECK holds the two invariants the writers rely on —
  // the pair is set or unset together, and a cause only ever names an ENDED
  // row's own endpoint.
  const identityAssertions = pgTable(
    n.identityAssertions,
    {
      graphId: text("graph_id").notNull(),
      id: text("id").notNull(),
      relation: text("rel").notNull(),
      aKind: text("a_kind").notNull(),
      aId: text("a_id").notNull(),
      bKind: text("b_kind").notNull(),
      bId: text("b_id").notNull(),
      validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
      validTo: timestamp("valid_to", { withTimezone: true }),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
      deletedAt: timestamp("deleted_at", { withTimezone: true }),
      endedByKind: text("ended_by_kind"),
      endedById: text("ended_by_id"),
    },
    (t) => [
      primaryKey({ columns: [t.graphId, t.id] }),
      index(`${n.identityAssertions}_a_idx`).on(
        t.graphId,
        t.aKind,
        t.aId,
        t.validTo,
      ),
      index(`${n.identityAssertions}_b_idx`).on(
        t.graphId,
        t.bKind,
        t.bId,
        t.validTo,
      ),
      uniqueIndex(`${n.identityAssertions}_current_pair_idx`)
        .on(t.graphId, t.relation, t.aKind, t.aId, t.bKind, t.bId)
        .where(sql`${t.validTo} IS NULL`),
      check(
        `${n.identityAssertions}_ended_by_check`,
        sql`(ended_by_kind IS NULL) = (ended_by_id IS NULL) AND (ended_by_kind IS NULL OR (valid_to IS NOT NULL AND ((ended_by_kind = a_kind AND ended_by_id = a_id) OR (ended_by_kind = b_kind AND ended_by_id = b_id))))`,
      ),
    ],
  );

  const recordedIdentityAssertions = pgTable(
    n.recordedIdentityAssertions,
    {
      historyId: text("history_id").notNull(),
      graphId: text("graph_id").notNull(),
      id: text("id").notNull(),
      relation: text("rel").notNull(),
      aKind: text("a_kind").notNull(),
      aId: text("a_id").notNull(),
      bKind: text("b_kind").notNull(),
      bId: text("b_id").notNull(),
      validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
      validTo: timestamp("valid_to", { withTimezone: true }),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
      deletedAt: timestamp("deleted_at", { withTimezone: true }),
      endedByKind: text("ended_by_kind"),
      endedById: text("ended_by_id"),
      recordedFrom: bigint("recorded_from", { mode: "number" }).notNull(),
      recordedTo: bigint("recorded_to", { mode: "number" }).notNull(),
      op: text("op").notNull(),
      schemaVersion: integer("schema_version"),
      txId: text("tx_id"),
      meta: jsonb("meta"),
    },
    (t) => [
      primaryKey({ columns: [t.historyId] }),
      index(`${n.recordedIdentityAssertions}_entity_idx`).on(
        t.graphId,
        t.id,
        t.recordedFrom,
        t.recordedTo,
      ),
      index(`${n.recordedIdentityAssertions}_a_idx`).on(
        t.graphId,
        t.aKind,
        t.aId,
        t.recordedFrom,
        t.recordedTo,
      ),
      index(`${n.recordedIdentityAssertions}_b_idx`).on(
        t.graphId,
        t.bKind,
        t.bId,
        t.recordedFrom,
        t.recordedTo,
      ),
    ],
  );

  const identityClosure = pgTable(
    n.identityClosure,
    {
      graphId: text("graph_id").notNull(),
      memberKind: text("member_kind").notNull(),
      memberId: text("member_id").notNull(),
      classKind: text("class_kind").notNull(),
      classId: text("class_id").notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.graphId, t.memberKind, t.memberId] }),
      index(`${n.identityClosure}_class_idx`).on(
        t.graphId,
        t.classKind,
        t.classId,
      ),
    ],
  );

  // The identity separation relation: the `different` ledger lifted to whole
  // identity classes, one row per separated class pair. `class_key_low` /
  // `class_key_high` hold the persisted class-key encoding (see
  // `identity/separation.ts`), ordered by code point. The CHECK pins `COLLATE
  // "C"` because a database whose default collation is linguistic orders text
  // differently from the writer, which would reject legitimate pairs; under
  // `C` the comparison is byte order, which is exactly code-point order.
  // Fusing two separated classes relabels both sides of their shared row to
  // one key, so the contradiction cannot commit.
  const identitySeparation = pgTable(
    n.identitySeparation,
    {
      graphId: text("graph_id").notNull(),
      classKeyLow: text("class_key_low").notNull(),
      classKeyHigh: text("class_key_high").notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.graphId, t.classKeyLow, t.classKeyHigh] }),
      index(`${n.identitySeparation}_high_idx`).on(t.graphId, t.classKeyHigh),
      check(
        `${n.identitySeparation}_ordered_pair_check`,
        sql`class_key_low COLLATE "C" < class_key_high COLLATE "C"`,
      ),
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

  // The edge cardinality claim relation: one row per claim AXIS
  // (`<cardinality>:<edgeKind>`) and endpoint KEY, naming the edge that holds
  // it. Declared edge cardinality is a predicate over `(kind, from)` or
  // `(kind, from, to)`, which the edges primary key `(graph_id, id)` cannot
  // fence, so this relation's own primary key is what refuses a second
  // concurrent claimant. A claim whose holder is no longer live (or, for
  // `oneActive`, no longer active) is taken over in place, which is why the
  // relation needs no release path — see `store/claims/edge-claims.ts`.
  const edgeClaims = pgTable(
    n.edgeClaims,
    {
      graphId: text("graph_id").notNull(),
      axis: text("axis").notNull(),
      key: text("key").notNull(),
      edgeId: text("edge_id").notNull(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.graphId, t.axis, t.key] }),
      index(`${n.edgeClaims}_edge_idx`).on(t.graphId, t.edgeId),
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

  const graphTemplates = pgTable(
    n.graphTemplates,
    {
      templateId: text("template_id").notNull(),
      schemaHash: text("schema_hash").notNull(),
      schemaDoc: jsonb("schema_doc").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    },
    (t) => [primaryKey({ columns: [t.templateId] })],
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
    identityAssertions,
    recordedIdentityAssertions,
    identityClosure,
    identitySeparation,
    uniques,
    edgeClaims,
    schemaVersions,
    graphTemplates,
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
  edgeClaims,
  schemaVersions,
  fulltext,
} = tables;

/**
 * Type representing the tables object returned by createPostgresTables.
 */
export type PostgresTables = ReturnType<typeof createPostgresTables>;
