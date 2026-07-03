import { type SQL, sql } from "drizzle-orm";

import type { FulltextStrategy } from "../../../query/dialect/fulltext-strategy";
import { isPresent } from "../../../utils/presence";
import type {
  CheckUniqueBatchParams,
  CheckUniqueParams,
  CountEdgesByKindParams,
  CountEdgesFromParams,
  CountNodesByKindParams,
  DeleteEdgeParams,
  DeleteFulltextBatchParams,
  DeleteFulltextParams,
  DeleteNodeParams,
  DeleteUniqueParams,
  EdgeExistsBetweenParams,
  FindEdgesByKindParams,
  FindEdgesConnectedToParams,
  FindNodesByKindParams,
  FulltextSearchParams,
  HardDeleteEdgeParams,
  HardDeleteNodeParams,
  InsertEdgeParams,
  InsertNodeParams,
  InsertSchemaParams,
  InsertUniqueParams,
  SqlDialect,
  UpdateEdgeParams,
  UpdateNodeParams,
  UpsertFulltextBatchParams,
  UpsertFulltextParams,
} from "../../types";
import type { PostgresTables } from "../schema/postgres";
import type { SqliteTables } from "../schema/sqlite";
import { buildClearGraph, type ClearGraphStatement } from "./clear";
import {
  buildCountEdgesByKind,
  buildCountNodesByKind,
  buildFindEdgesByKind,
  buildFindNodesByKind,
} from "./collections";
import {
  buildCountEdgesFrom,
  buildDeleteEdge,
  buildEdgeExistsBetween,
  buildFindEdgesConnectedTo,
  buildGetEdge,
  buildGetEdges,
  buildHardDeleteEdge,
  buildHardDeleteEdgesByNode,
  buildInsertEdge,
  buildInsertEdgeNoReturn,
  buildInsertEdgesBatch,
  buildInsertEdgesBatchReturning,
  buildUpdateEdge,
} from "./edges";
import { buildFulltextSearch } from "./fulltext";
import {
  buildDeleteNode,
  buildGetNode,
  buildGetNodes,
  buildHardDeleteNode,
  buildInsertNode,
  buildInsertNodeNoReturn,
  buildInsertNodesBatch,
  buildInsertNodesBatchReturning,
  buildUpdateNode,
} from "./nodes";
import {
  buildGetActiveSchema,
  buildGetSchemaVersion,
  buildInsertSchema,
  buildSetActiveSchema,
} from "./schema";
import type { Tables } from "./shared";
import {
  buildCheckUnique,
  buildCheckUniqueBatch,
  buildDeleteUnique,
  buildHardDeleteUniquesByNode,
  buildInsertUnique,
  buildInsertUniqueBatch,
} from "./uniques";

export type CommonOperationStrategy = Readonly<{
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
  buildInsertNode: (params: InsertNodeParams, timestamp: string) => SQL;
  buildInsertNodeNoReturn: (
    params: InsertNodeParams,
    timestamp: string,
  ) => SQL;
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
  buildDeleteNode: (params: DeleteNodeParams, timestamp: string) => SQL;
  buildHardDeleteNode: (params: HardDeleteNodeParams) => SQL;
  buildInsertEdge: (params: InsertEdgeParams, timestamp: string) => SQL;
  buildInsertEdgeNoReturn: (
    params: InsertEdgeParams,
    timestamp: string,
  ) => SQL;
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
  buildHardDeleteEdge: (params: HardDeleteEdgeParams) => SQL;
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
  buildCountEdgesByKind: (params: CountEdgesByKindParams) => SQL;
  buildInsertUnique: (params: InsertUniqueParams) => SQL;
  buildInsertUniqueBatch: (entries: readonly InsertUniqueParams[]) => SQL;
  buildDeleteUnique: (params: DeleteUniqueParams, timestamp: string) => SQL;
  buildHardDeleteUniquesByNode: (graphId: string, nodeId: string) => SQL;
  buildCheckUnique: (params: CheckUniqueParams) => SQL;
  buildCheckUniqueBatch: (params: CheckUniqueBatchParams) => SQL;
  buildGetActiveSchema: (graphId: string) => SQL;
  buildInsertSchema: (params: InsertSchemaParams, timestamp: string) => SQL;
  buildGetSchemaVersion: (graphId: string, version: number) => SQL;
  buildSetActiveSchema: (
    graphId: string,
    version: number,
  ) => Readonly<{ activateVersion: SQL; deactivateAll: SQL }>;
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

type TableOperationBuilder = (
  tables: Tables,
  ...args: never[]
) => SQL;

type TableOperationBuilderMap = Readonly<Record<string, TableOperationBuilder>>;

type BoundTableOperationBuilderMap<TBuilders extends TableOperationBuilderMap> = Readonly<{
  [K in keyof TBuilders]: TBuilders[K] extends (
    tables: Tables,
    ...args: infer TArguments
  ) => SQL
    ? (...args: TArguments) => SQL
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

  return Object.fromEntries(boundEntries) as BoundTableOperationBuilderMap<TBuilders>;
}

const COMMON_TABLE_OPERATION_BUILDERS = {
  buildInsertNode,
  buildInsertNodeNoReturn,
  buildInsertNodesBatch,
  buildInsertNodesBatchReturning,
  buildGetNode,
  buildGetNodes,
  buildUpdateNode,
  buildDeleteNode,
  buildHardDeleteNode,
  buildInsertEdge,
  buildInsertEdgeNoReturn,
  buildInsertEdgesBatch,
  buildInsertEdgesBatchReturning,
  buildGetEdge,
  buildGetEdges,
  buildUpdateEdge,
  buildDeleteEdge,
  buildHardDeleteEdge,
  buildHardDeleteEdgesByNode,
  buildCountEdgesFrom,
  buildEdgeExistsBetween,
  buildFindEdgesConnectedTo,
  buildFindNodesByKind,
  buildCountNodesByKind,
  buildFindEdgesByKind,
  buildCountEdgesByKind,
  buildDeleteUnique,
  buildHardDeleteUniquesByNode,
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

  // All fulltext write SQL is owned by the active strategy — so swapping
  // to pg_trgm / ParadeDB / pgroonga swaps the full CRUD pipeline, not
  // just the read-side fragments.
  const fulltextBuilders = {
    buildUpsertFulltext: (
      params: UpsertFulltextParams,
      timestamp: string,
    ): readonly SQL[] =>
      fulltextStrategy.buildUpsert(fulltextTable, params, timestamp),
    buildDeleteFulltext: (params: DeleteFulltextParams): readonly SQL[] =>
      fulltextStrategy.buildDelete(fulltextTable, params),
    buildDeleteFulltextByNode: (
      graphId: string,
      nodeKind: string,
      nodeId: string,
    ): readonly SQL[] =>
      fulltextStrategy.buildDelete(fulltextTable, {
        graphId,
        nodeKind,
        nodeId,
      }),
    buildUpsertFulltextBatch: (
      params: UpsertFulltextBatchParams,
      timestamp: string,
    ): readonly SQL[] =>
      fulltextStrategy.buildBatchUpsert(fulltextTable, params, timestamp),
    buildDeleteFulltextBatch: (
      params: DeleteFulltextBatchParams,
    ): readonly SQL[] =>
      fulltextStrategy.buildBatchDelete(fulltextTable, params),
    buildFulltextSearch: (params: FulltextSearchParams): SQL =>
      buildFulltextSearch(fulltextTable, params, fulltextStrategy),
  };

  return {
    ...tableOperations,
    ...fulltextBuilders,
    buildInsertUnique(params: InsertUniqueParams): SQL {
      return buildInsertUnique(tables, dialect, params);
    },
    buildInsertUniqueBatch(entries: readonly InsertUniqueParams[]): SQL {
      return buildInsertUniqueBatch(tables, dialect, entries);
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
      if (dialect === "postgres") {
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
      return sql`SELECT name AS table_name FROM sqlite_master WHERE type IN ('table', 'view') AND name = ${tableName}`;
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
  return createCommonOperationStrategy(tables, "postgres", fulltextStrategy);
}
