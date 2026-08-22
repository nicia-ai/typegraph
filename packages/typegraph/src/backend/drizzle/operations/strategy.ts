import { getTableName, type SQL, sql } from "drizzle-orm";

import type { FulltextStrategy } from "../../../query/dialect/fulltext-strategy";
import { isSqlFragment, type SqlFragment } from "../../../query/sql-fragment";
import { type ConstrainedCardinality } from "../../../store/claims/edge-claims";
import { isPresent } from "../../../utils/presence";
import type { PrimaryKeyRelation } from "../../../utils/sql-errors";
import { nowIso } from "../../row-mappers";
import type {
  CheckUniqueBatchParams,
  CheckUniqueParams,
  ClaimEdgeCardinalityParams,
  ContributionMaterializationIdentity,
  CountEdgesByKindParams,
  CountEdgesFromParams,
  CountNodesByKindParams,
  DeleteEdgeParams,
  DeleteEdgesBatchParams,
  DeleteFulltextBatchParams,
  DeleteFulltextParams,
  DeleteNodeParams,
  DeleteUniqueParams,
  EdgeExistsBetweenParams,
  FindEdgesByEndpointSetParams,
  FindEdgesByHeterogeneousEndpointSetParams,
  FindEdgesByKindParams,
  FindEdgesConnectedToParams,
  FindNodesByKindParams,
  FulltextSearchParams,
  HardDeleteEdgeParams,
  HardDeleteNodeParams,
  HardDeleteUniquesByConcreteKindParams,
  HardDeleteUniquesByNodeIdsParams,
  HybridSearchParams,
  InsertEdgeParams,
  InsertNodeParams,
  InsertSchemaParams,
  InsertUniqueParams,
  PurgeEdgeClaimsParams,
  RecordContributionMaterializationParams,
  SchemaWriteFenceParams,
  SqlDialect,
  UpdateEdgeParams,
  UpdateNodeParams,
  UpdateNodeSetParams,
  UpsertFulltextBatchParams,
  UpsertFulltextParams,
} from "../../types";
import { toDrizzleSql } from "../execution/types";
import type { PostgresTables } from "../schema/postgres";
import type { SqliteTables } from "../schema/sqlite";
import { buildClearGraph, type ClearGraphStatement } from "./clear";
import {
  buildCountEdgesByKind,
  buildCountNodesByKind,
  buildFindEdgesByEndpointSet,
  buildFindEdgesByHeterogeneousEndpointSet,
  buildFindEdgesByKind,
  buildFindNodesByKind,
} from "./collections";
import {
  buildContendedEdgeRowAudit,
  buildContendedUniqueRowAudit,
  buildDisjointOverlapAudit,
} from "./constraint-fence-audit";
import {
  buildLockEdgeClaimGuarded,
  buildLockEdgeClaims,
  buildPurgeEdgeClaims,
  buildTakeOverEdgeClaim,
  buildTakeOverEdgeClaimGuarded,
} from "./edge-claims";
import {
  buildCountEdgesFrom,
  buildDeleteEdge,
  buildDeleteEdgesBatch,
  buildEdgeExistsBetween,
  buildFindEdgesConnectedTo,
  buildGetEdge,
  buildGetEdges,
  buildHardDeleteEdge,
  buildHardDeleteEdgesBatch,
  buildHardDeleteEdgesByNode,
  buildInsertEdge,
  buildInsertEdgeIfEndpointsLive,
  buildInsertEdgeIfEndpointsLiveWithSchemaFence,
  buildInsertEdgeNoReturn,
  buildInsertEdgesBatch,
  buildInsertEdgesBatchReturning,
  buildUpdateEdge,
} from "./edges";
import { buildFulltextSearch } from "./fulltext";
import { buildHybridSearchStatement, hybridCandidatesRef } from "./hybrid";
import {
  buildDeleteNode,
  buildGetNode,
  buildGetNodes,
  buildHardDeleteNode,
  buildInsertNode,
  buildInsertNodeIfAbsent,
  buildInsertNodeIfAbsentWithSchemaFence,
  buildInsertNodeNoReturn,
  buildInsertNodesBatch,
  buildInsertNodesBatchReturning,
  buildInsertNodeWithSchemaFence,
  buildUpdateNode,
  buildUpdateNodeSet,
} from "./nodes";
import {
  buildGetActiveSchema,
  buildGetSchemaVersion,
  buildInsertSchema,
  buildLockSchemaVersionAndGraphWrite,
  buildSetActiveSchema,
} from "./schema";
import {
  edgePrimaryKeyConstraint,
  liveNodeIdsSubquery,
  nodePrimaryKeyConstraint,
  type Tables,
} from "./shared";
import {
  buildCheckUnique,
  buildCheckUniqueBatch,
  buildDeleteUnique,
  buildHardDeleteUniquesByConcreteKind,
  buildHardDeleteUniquesByNode,
  buildHardDeleteUniquesByNodeIds,
  buildInsertUnique,
  buildInsertUniqueBatch,
} from "./uniques";

/**
 * Binds an absent value as a SQL `NULL` literal rather than as a bound
 * parameter, so the column's own type drives the insert instead of the
 * driver having to infer a type for a null placeholder.
 */
function nullableText(value: string | undefined): SQL {
  return value === undefined ? sql`NULL` : sql`${value}`;
}

export type CommonOperationStrategy = Readonly<{
  /**
   * The nodes and edges PRIMARY KEY constraints, as the engine names them — the
   * only scope in which a driver duplicate-key failure means "this identity is
   * already taken" rather than "these values collide with another row's".
   *
   * Data rather than SQL, and a member of this interface rather than a lookup at
   * the classification site, so it is derived once from the same `tables` the
   * insert builders render and every dialect is forced by the type checker to
   * supply it.
   */
  primaryKeyConstraints: Readonly<{
    nodes: PrimaryKeyRelation;
    edges: PrimaryKeyRelation;
  }>;
  buildUpsertFulltext: (
    params: UpsertFulltextParams,
    timestamp: string,
  ) => readonly SQL[];
  buildDeleteFulltext: (params: DeleteFulltextParams) => readonly SQL[];
  buildDeleteFulltextByNode: (
    graphId: string,
    nodeKind: string,
    nodeId: string,
  ) => readonly SQL[];
  buildUpsertFulltextBatch: (
    params: UpsertFulltextBatchParams,
    timestamp: string,
  ) => readonly SQL[];
  buildDeleteFulltextBatch: (
    params: DeleteFulltextBatchParams,
  ) => readonly SQL[];
  buildFulltextSearch: (params: FulltextSearchParams) => SQL;
  /**
   * Composes the single-statement hybrid search: the caller supplies the
   * vector source SQL (strategy-owned); this member builds the fulltext
   * source over the same candidate set and fuses both via
   * {@link buildHybridSearchStatement}.
   */
  buildHybridSearch: (
    params: HybridSearchParams,
    vectorSql: SQL,
    vectorScoreDescending: boolean,
  ) => SQL;
  buildInsertNode: (params: InsertNodeParams, timestamp: string) => SQL;
  buildInsertNodeIfAbsent: (
    params: InsertNodeParams,
    timestamp: string,
  ) => SQL;
  buildInsertNodeIfAbsentWithSchemaFence: (
    params: InsertNodeParams,
    timestamp: string,
    schemaFence: SchemaWriteFenceParams,
    schemaLockClause: SQL,
  ) => SQL;
  buildInsertNodeWithSchemaFence: (
    params: InsertNodeParams,
    timestamp: string,
    schemaFence: SchemaWriteFenceParams,
    schemaLockClause: SQL,
  ) => SQL;
  buildInsertNodeNoReturn: (params: InsertNodeParams, timestamp: string) => SQL;
  buildInsertNodesBatch: (
    params: readonly InsertNodeParams[],
    timestamp: string,
  ) => SQL;
  buildInsertNodesBatchReturning: (
    params: readonly InsertNodeParams[],
    timestamp: string,
  ) => SQL;
  buildGetNode: (graphId: string, kind: string, id: string) => SQL;
  buildGetNodes: (graphId: string, kind: string, ids: readonly string[]) => SQL;
  buildUpdateNode: (params: UpdateNodeParams, timestamp: string) => SQL;
  buildUpdateNodeSet: (params: UpdateNodeSetParams, timestamp: string) => SQL;
  buildDeleteNode: (params: DeleteNodeParams, timestamp: string) => SQL;
  buildHardDeleteNode: (params: HardDeleteNodeParams) => SQL;
  buildInsertEdge: (params: InsertEdgeParams, timestamp: string) => SQL;
  buildInsertEdgeIfEndpointsLive: (
    params: InsertEdgeParams,
    timestamp: string,
  ) => SQL;
  buildInsertEdgeIfEndpointsLiveWithSchemaFence: (
    params: InsertEdgeParams,
    timestamp: string,
    schemaFence: SchemaWriteFenceParams,
    schemaLockClause: SQL,
  ) => SQL;
  buildInsertEdgeNoReturn: (params: InsertEdgeParams, timestamp: string) => SQL;
  buildInsertEdgesBatch: (
    params: readonly InsertEdgeParams[],
    timestamp: string,
  ) => SQL;
  buildInsertEdgesBatchReturning: (
    params: readonly InsertEdgeParams[],
    timestamp: string,
  ) => SQL;
  buildGetEdge: (graphId: string, id: string) => SQL;
  buildGetEdges: (graphId: string, ids: readonly string[]) => SQL;
  buildUpdateEdge: (params: UpdateEdgeParams, timestamp: string) => SQL;
  buildDeleteEdge: (params: DeleteEdgeParams, timestamp: string) => SQL;
  buildDeleteEdgesBatch: (
    params: DeleteEdgesBatchParams,
    timestamp: string,
  ) => SQL;
  buildHardDeleteEdge: (params: HardDeleteEdgeParams) => SQL;
  buildHardDeleteEdgesBatch: (params: DeleteEdgesBatchParams) => SQL;
  buildHardDeleteEdgesByNode: (
    graphId: string,
    nodeKind: string,
    nodeId: string,
  ) => SQL;
  buildCountEdgesFrom: (params: CountEdgesFromParams) => SQL;
  buildEdgeExistsBetween: (params: EdgeExistsBetweenParams) => SQL;
  buildFindEdgesConnectedTo: (params: FindEdgesConnectedToParams) => SQL;
  buildFindNodesByKind: (params: FindNodesByKindParams) => SQL;
  buildCountNodesByKind: (params: CountNodesByKindParams) => SQL;
  buildFindEdgesByKind: (params: FindEdgesByKindParams) => SQL;
  /**
   * Interface member rather than an optional one: every dialect must supply
   * an endpoint-set read, so the operation can never be silently skipped by a
   * dialect that forgot it. Both bundled dialects get it from the shared
   * builder.
   */
  buildFindEdgesByEndpointSet: (
    params: FindEdgesByEndpointSetParams,
    endpointIds: readonly string[],
  ) => SQL;
  buildFindEdgesByHeterogeneousEndpointSet: (
    params: FindEdgesByHeterogeneousEndpointSetParams,
    endpoints: readonly Readonly<{ kind: string; id: string }>[],
    edgeKinds: readonly string[],
  ) => SQL;
  buildCountEdgesByKind: (params: CountEdgesByKindParams) => SQL;
  buildInsertUnique: (params: InsertUniqueParams) => SQL;
  buildInsertUniqueBatch: (entries: readonly InsertUniqueParams[]) => SQL;
  buildDeleteUnique: (params: DeleteUniqueParams, timestamp: string) => SQL;
  buildHardDeleteUniquesByNode: (
    graphId: string,
    concreteKind: string,
    nodeId: string,
  ) => SQL;
  buildHardDeleteUniquesByNodeIds: (
    params: HardDeleteUniquesByNodeIdsParams,
  ) => SQL;
  /**
   * Dialect-independent by construction — the fragment names only the
   * relation and two columns, so the store-side kind-removal cleanup compiles
   * the identical predicate through its own execution path.
   */
  buildHardDeleteUniquesByConcreteKind: (
    params: HardDeleteUniquesByConcreteKindParams,
  ) => SqlFragment;
  buildCheckUnique: (params: CheckUniqueParams) => SQL;
  buildCheckUniqueBatch: (params: CheckUniqueBatchParams) => SQL;
  /**
   * The two edge-claim statements, in the order the driver issues them: the
   * decision-free lock that reports the committed holder, then — only for a
   * foreign holder — the conditional takeover. Members of this interface rather
   * than dialect helpers, so the type checker forces both dialects to have them.
   */
  buildLockEdgeClaims: (
    entries: readonly ClaimEdgeCardinalityParams[],
    timestamp: string,
  ) => SQL;
  buildLockEdgeClaimGuarded: (
    params: ClaimEdgeCardinalityParams,
    timestamp: string,
  ) => SQL;
  buildTakeOverEdgeClaim: (
    params: ClaimEdgeCardinalityParams,
    timestamp: string,
  ) => SQL;
  buildTakeOverEdgeClaimGuarded: (
    params: ClaimEdgeCardinalityParams,
    timestamp: string,
  ) => SQL;
  buildPurgeEdgeClaims: (params: PurgeEdgeClaimsParams) => SQL;
  /**
   * The three read-only fence-audit statements, one per constraint family.
   * Members of this interface for the same reason the claim statements are:
   * the type checker forces both dialects to have them, so a family cannot be
   * audited on one backend and silently skipped on the other.
   */
  buildContendedUniqueRowAudit: (
    graphId: string,
    constraintNames: readonly string[],
  ) => SQL;
  buildContendedEdgeRowAudit: (
    graphId: string,
    cardinality: ConstrainedCardinality,
    edgeKinds: readonly string[],
  ) => SQL;
  buildDisjointOverlapAudit: (
    graphId: string,
    kinds: readonly [string, string],
  ) => SQL;
  buildGetActiveSchema: (graphId: string) => SQL;
  /** PostgreSQL-only dependent schema-row + graph-advisory fence. */
  buildLockSchemaVersionAndGraphWrite?: (
    params: SchemaWriteFenceParams,
    advisoryLockNamespace: string,
  ) => SQL;
  buildInsertSchema: (params: InsertSchemaParams, timestamp: string) => SQL;
  buildGetSchemaVersion: (graphId: string, version: number) => SQL;
  buildSetActiveSchema: (
    graphId: string,
    version: number,
  ) => Readonly<{ activateVersion: SQL; deactivateAll: SQL }>;
  /**
   * Write one contribution marker row outright (no conflict clause), for
   * the transaction-scoped stamp a destructive rebuild commits alongside
   * the DDL that produced it.
   */
  buildInsertContributionMaterialization: (
    params: RecordContributionMaterializationParams,
  ) => SQL;
  buildDeleteContributionMaterialization: (
    identity: ContributionMaterializationIdentity,
  ) => SQL;
  buildTableExists: (tableName: string) => SQL;
  buildClearGraph: (graphId: string) => readonly ClearGraphStatement[];
}>;

/**
 * Vector embedding operations are no longer part of the dialect operation
 * strategy: the active {@link VectorStrategy} owns all embedding storage
 * and SQL (upsert / delete / search / index lifecycle) per-`(kind, field)`,
 * so both dialects share the same operation strategy shape.
 */
export type SqliteOperationStrategy = CommonOperationStrategy;

export type PostgresOperationStrategy = CommonOperationStrategy;

type TableOperationBuilder = (tables: Tables, ...args: never[]) => SQL;

type TableOperationBuilderMap = Readonly<Record<string, TableOperationBuilder>>;

type BoundTableOperationBuilderMap<TBuilders extends TableOperationBuilderMap> =
  Readonly<{
    [K in keyof TBuilders]: TBuilders[K] extends (
      (tables: Tables, ...args: infer TArguments) => SQL
    ) ?
      (...args: TArguments) => SQL
    : never;
  }>;

function bindTableOperationBuilders<TBuilders extends TableOperationBuilderMap>(
  tables: Tables,
  builders: TBuilders,
): BoundTableOperationBuilderMap<TBuilders> {
  const boundEntries = Object.entries(builders).map(([name, builder]) => {
    function boundBuilder(...args: never[]): SQL {
      return builder(tables, ...args);
    }

    return [name, boundBuilder] as const;
  });

  return Object.fromEntries(
    boundEntries,
  ) as BoundTableOperationBuilderMap<TBuilders>;
}

const COMMON_TABLE_OPERATION_BUILDERS = {
  buildInsertNode,
  buildInsertNodeIfAbsent,
  buildInsertNodeIfAbsentWithSchemaFence,
  buildInsertNodeWithSchemaFence,
  buildInsertNodeNoReturn,
  buildInsertNodesBatch,
  buildInsertNodesBatchReturning,
  buildGetNode,
  buildGetNodes,
  buildUpdateNode,
  buildDeleteNode,
  buildHardDeleteNode,
  buildInsertEdge,
  buildInsertEdgeIfEndpointsLive,
  buildInsertEdgeIfEndpointsLiveWithSchemaFence,
  buildInsertEdgeNoReturn,
  buildInsertEdgesBatch,
  buildInsertEdgesBatchReturning,
  buildGetEdge,
  buildGetEdges,
  buildUpdateEdge,
  buildDeleteEdge,
  buildDeleteEdgesBatch,
  buildHardDeleteEdge,
  buildHardDeleteEdgesBatch,
  buildHardDeleteEdgesByNode,
  buildCountEdgesFrom,
  buildEdgeExistsBetween,
  buildFindEdgesConnectedTo,
  buildFindNodesByKind,
  buildCountNodesByKind,
  buildFindEdgesByKind,
  buildFindEdgesByEndpointSet,
  buildFindEdgesByHeterogeneousEndpointSet,
  buildCountEdgesByKind,
  buildDeleteUnique,
  buildHardDeleteUniquesByNode,
  buildHardDeleteUniquesByNodeIds,
  buildCheckUnique,
  buildCheckUniqueBatch,
  buildGetSchemaVersion,
} as const satisfies TableOperationBuilderMap;

function createCommonOperationStrategy(
  tables: Tables,
  dialect: SqlDialect,
  fulltextStrategy: FulltextStrategy,
): CommonOperationStrategy {
  const tableOperations = bindTableOperationBuilders(
    tables,
    COMMON_TABLE_OPERATION_BUILDERS,
  );
  const fulltextTable = tables.fulltextTableName;
  const contributionMaterializations = tables.contributionMaterializations;

  // All fulltext write SQL is owned by the active strategy — so swapping
  // to pg_trgm / ParadeDB / pgroonga swaps the full CRUD pipeline, not
  // just the read-side fragments.
  const fulltextBuilders = {
    buildUpsertFulltext: (
      params: UpsertFulltextParams,
      timestamp: string,
    ): readonly SQL[] =>
      fulltextStrategy
        .buildUpsert(fulltextTable, params, timestamp)
        .map((statement) => toDrizzleSql(statement, dialect)),
    buildDeleteFulltext: (params: DeleteFulltextParams): readonly SQL[] =>
      fulltextStrategy
        .buildDelete(fulltextTable, params)
        .map((statement) => toDrizzleSql(statement, dialect)),
    buildDeleteFulltextByNode: (
      graphId: string,
      nodeKind: string,
      nodeId: string,
    ): readonly SQL[] =>
      fulltextStrategy
        .buildDelete(fulltextTable, {
          graphId,
          nodeKind,
          nodeId,
        })
        .map((statement) => toDrizzleSql(statement, dialect)),
    buildUpsertFulltextBatch: (
      params: UpsertFulltextBatchParams,
      timestamp: string,
    ): readonly SQL[] =>
      fulltextStrategy
        .buildBatchUpsert(fulltextTable, params, timestamp)
        .map((statement) => toDrizzleSql(statement, dialect)),
    buildDeleteFulltextBatch: (
      params: DeleteFulltextBatchParams,
    ): readonly SQL[] =>
      fulltextStrategy
        .buildBatchDelete(fulltextTable, params)
        .map((statement) => toDrizzleSql(statement, dialect)),
    buildFulltextSearch: (params: FulltextSearchParams): SQL =>
      buildFulltextSearch(
        fulltextTable,
        params,
        fulltextStrategy,
        dialect,
        // Store-compiled candidates (predicates + subclass + currency)
        // take precedence; the live-node default covers direct backend use.
        params.candidates ??
          liveNodeIdsSubquery(
            tables.nodes,
            params.graphId,
            params.nodeKind,
            nowIso(),
          ),
      ),
    buildHybridSearch: (
      params: HybridSearchParams,
      vectorSql: SQL,
      vectorScoreDescending: boolean,
    ): SQL => {
      const candidates =
        params.candidates ??
        liveNodeIdsSubquery(
          tables.nodes,
          params.graphId,
          params.nodeKind,
          nowIso(),
        );
      const fulltextSql = buildFulltextSearch(
        fulltextTable,
        {
          graphId: params.graphId,
          nodeKind: params.nodeKind,
          query: params.fulltext.query,
          limit: params.fulltext.k,
          ...(params.fulltext.mode === undefined ?
            {}
          : { mode: params.fulltext.mode }),
          ...(params.fulltext.language === undefined ?
            {}
          : { language: params.fulltext.language }),
          ...(params.fulltext.minScore === undefined ?
            {}
          : { minScore: params.fulltext.minScore }),
          ...(params.fulltext.includeSnippets === undefined ?
            {}
          : { includeSnippets: params.fulltext.includeSnippets }),
        },
        fulltextStrategy,
        dialect,
        // Reference, not copy: the statement evaluates the shared
        // tg_hybrid_cand CTE once for both legs.
        hybridCandidatesRef(),
      );
      return buildHybridSearchStatement({
        candidatesSql:
          isSqlFragment(candidates) ?
            toDrizzleSql(candidates, dialect)
          : candidates,
        vectorSql,
        vectorScoreDescending,
        fulltextSql,
        nodes: tables.nodes,
        dialect,
        graphId: params.graphId,
        nodeKind: params.nodeKind,
        fusionK: params.fusion.k,
        vectorWeight: params.fusion.vectorWeight,
        fulltextWeight: params.fusion.fulltextWeight,
        limit: params.limit,
        offset: params.offset ?? 0,
      });
    },
  };

  /**
   * States one contribution marker row outright: every column takes the
   * supplied value whether or not a row already exists.
   *
   * Deliberately not the top-level backend's upsert, which COALESCEs
   * `materialized_at` so a *failed* re-attempt cannot erase an earlier
   * success. That rule is right when the attempt may have failed and
   * wrong for a completed destructive rebuild, whose whole point is that
   * the storage is new — the recorded timestamp must be the rebuild's,
   * not the shape it replaced.
   *
   * One statement rather than a delete/insert pair so the row is never
   * momentarily absent inside the transaction, and so a concurrent
   * `repairContributions()` racing the same identity resolves as a
   * conflict rather than a primary-key violation that would roll the
   * whole rebuild back.
   *
   * Dialect-shared: the composite primary key is the conflict target on
   * both engines, and the ISO timestamps bind straight into SQLite's TEXT
   * and Postgres' TIMESTAMPTZ columns, the same way every other write
   * builder here passes `nowIso()` through.
   */
  function buildInsertContributionMaterialization(
    params: RecordContributionMaterializationParams,
  ): SQL {
    return sql`
      INSERT INTO ${contributionMaterializations}
        (graph_id, logical_name, owner, table_name, signature,
         materialized_at, last_attempted_at, last_error)
      VALUES (
        ${params.graphId}, ${params.logicalName}, ${params.owner},
        ${params.tableName}, ${params.signature},
        ${nullableText(params.materializedAt)}, ${params.attemptedAt},
        ${nullableText(params.error)}
      )
      ON CONFLICT (graph_id, logical_name, owner, table_name) DO UPDATE SET
        signature = excluded.signature,
        materialized_at = excluded.materialized_at,
        last_attempted_at = excluded.last_attempted_at,
        last_error = excluded.last_error
    `;
  }

  function buildDeleteContributionMaterialization(
    identity: ContributionMaterializationIdentity,
  ): SQL {
    return sql`
      DELETE FROM ${contributionMaterializations}
      WHERE graph_id = ${identity.graphId}
        AND logical_name = ${identity.logicalName}
        AND owner = ${identity.owner}
        AND table_name = ${identity.tableName}
    `;
  }

  return {
    ...tableOperations,
    ...fulltextBuilders,
    primaryKeyConstraints: {
      nodes: nodePrimaryKeyConstraint(tables.nodes),
      edges: edgePrimaryKeyConstraint(tables.edges),
    },
    buildUpdateNodeSet(params: UpdateNodeSetParams, timestamp: string): SQL {
      return buildUpdateNodeSet(tables, dialect, params, timestamp);
    },
    buildDeleteContributionMaterialization,
    buildInsertContributionMaterialization,
    buildInsertUnique(params: InsertUniqueParams): SQL {
      return buildInsertUnique(tables, dialect, params);
    },
    buildInsertUniqueBatch(entries: readonly InsertUniqueParams[]): SQL {
      return buildInsertUniqueBatch(tables, dialect, entries);
    },
    buildHardDeleteUniquesByConcreteKind(
      params: HardDeleteUniquesByConcreteKindParams,
    ): SqlFragment {
      return buildHardDeleteUniquesByConcreteKind(
        getTableName(tables.uniques),
        params,
      );
    },
    buildLockEdgeClaims(
      entries: readonly ClaimEdgeCardinalityParams[],
      timestamp: string,
    ): SQL {
      return buildLockEdgeClaims(tables, entries, timestamp);
    },
    buildLockEdgeClaimGuarded(
      params: ClaimEdgeCardinalityParams,
      timestamp: string,
    ): SQL {
      return buildLockEdgeClaimGuarded(tables, params, timestamp);
    },
    buildTakeOverEdgeClaim(
      params: ClaimEdgeCardinalityParams,
      timestamp: string,
    ): SQL {
      return buildTakeOverEdgeClaim(tables, params, timestamp);
    },
    buildTakeOverEdgeClaimGuarded(
      params: ClaimEdgeCardinalityParams,
      timestamp: string,
    ): SQL {
      return buildTakeOverEdgeClaimGuarded(tables, params, timestamp);
    },
    buildPurgeEdgeClaims(params: PurgeEdgeClaimsParams): SQL {
      return buildPurgeEdgeClaims(tables, params);
    },
    buildContendedUniqueRowAudit(
      graphId: string,
      constraintNames: readonly string[],
    ): SQL {
      return buildContendedUniqueRowAudit(tables, graphId, constraintNames);
    },
    buildContendedEdgeRowAudit(
      graphId: string,
      cardinality: ConstrainedCardinality,
      edgeKinds: readonly string[],
    ): SQL {
      return buildContendedEdgeRowAudit(
        tables,
        graphId,
        cardinality,
        edgeKinds,
      );
    },
    buildDisjointOverlapAudit(
      graphId: string,
      kinds: readonly [string, string],
    ): SQL {
      return buildDisjointOverlapAudit(tables, graphId, kinds);
    },
    buildGetActiveSchema(graphId: string): SQL {
      return buildGetActiveSchema(tables, graphId, dialect);
    },
    buildInsertSchema(params: InsertSchemaParams, timestamp: string): SQL {
      return buildInsertSchema(tables, params, timestamp, dialect);
    },
    buildSetActiveSchema(
      graphId: string,
      version: number,
    ): Readonly<{ activateVersion: SQL; deactivateAll: SQL }> {
      return buildSetActiveSchema(tables, graphId, version, dialect);
    },
    buildTableExists(tableName: string): SQL {
      switch (dialect) {
        case "postgres": {
          // `pg_table_is_visible` resolves visibility through the session
          // `search_path` — exactly how the unqualified DELETE / ANALYZE this
          // probe guards resolves `tableName`. Scoping to `current_schema()`
          // instead would report the table missing whenever it lives in a
          // search_path schema that is not the current one (a shared-schema /
          // multi-tenant deployment), skipping a statement that would in fact
          // have hit the table — a guard narrower than what it protects.
          return sql`
            SELECT c.relname AS table_name
            FROM pg_catalog.pg_class AS c
            WHERE c.relname = ${tableName}
              AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
              AND pg_catalog.pg_table_is_visible(c.oid)
            LIMIT 1
          `;
        }
        case "sqlite": {
          return sql`SELECT name AS table_name FROM sqlite_master WHERE type IN ('table', 'view') AND name = ${tableName}`;
        }
        default: {
          return dialect satisfies never;
        }
      }
    },
    buildClearGraph(graphId: string): readonly ClearGraphStatement[] {
      return buildClearGraph(tables, graphId);
    },
  };
}

/**
 * Interprets the row returned by {@link CommonOperationStrategy.buildTableExists}.
 * The probe selects a single non-null column only when the table is present, so
 * an absent row — or a row whose columns are all null — means the table does not
 * exist. Shared by `clear()` and `refreshStatistics()` so the two callers can't
 * drift on how the probe result is read.
 */
export function tableExistsFromRow(
  row: Record<string, unknown> | undefined,
): boolean {
  if (row === undefined) return false;
  return Object.values(row).some((value) => isPresent(value));
}

/**
 * Wraps a {@link CommonOperationStrategy.buildTableExists} probe in a
 * per-instance cache. A table confirmed present is cached by default for the
 * backend's lifetime, but callers may disable positive caching when the probe is
 * sensitive to session state such as PostgreSQL `search_path`. Missing tables
 * stay re-probable by default so a later focused bootstrap that creates one is
 * picked up; callers on a non-DDL path can opt into negative caching. Shared by
 * `clear()`'s ignore-missing guard and `refreshStatistics()`'s recorded ANALYZE
 * so the two cannot drift on caching or on how the probe row is read.
 *
 * `probe` runs the existence query and returns the single result row (or
 * `undefined`); the caller supplies it because the two sites execute through
 * different adapters (a single-row `execGet` vs. a row-array `execute`).
 */
export type TableExistenceCacheOptions = Readonly<{
  cacheExisting?: boolean | undefined;
  cacheMissing?: boolean | undefined;
}>;

export function createCachedTableExistence(
  probe: (tableName: string) => Promise<Record<string, unknown> | undefined>,
  options?: TableExistenceCacheOptions,
): (tableName: string) => Promise<boolean> {
  const cacheExisting = options?.cacheExisting !== false;
  const cacheMissing = options?.cacheMissing === true;
  const confirmedExisting = new Set<string>();
  const confirmedMissing = new Set<string>();
  return async function tableExists(tableName: string): Promise<boolean> {
    if (confirmedExisting.has(tableName)) return true;
    if (confirmedMissing.has(tableName)) return false;
    const exists = tableExistsFromRow(await probe(tableName));
    if (exists && cacheExisting) {
      confirmedExisting.add(tableName);
    }
    if (!exists && cacheMissing) {
      confirmedMissing.add(tableName);
    }
    return exists;
  };
}

export function createSqliteOperationStrategy(
  tables: SqliteTables,
  fulltextStrategy: FulltextStrategy,
): SqliteOperationStrategy {
  return createCommonOperationStrategy(tables, "sqlite", fulltextStrategy);
}

export function createPostgresOperationStrategy(
  tables: PostgresTables,
  fulltextStrategy: FulltextStrategy,
): PostgresOperationStrategy {
  return {
    ...createCommonOperationStrategy(tables, "postgres", fulltextStrategy),
    buildLockSchemaVersionAndGraphWrite: (params, advisoryLockNamespace) =>
      buildLockSchemaVersionAndGraphWrite(
        tables,
        params,
        advisoryLockNamespace,
      ),
  };
}
