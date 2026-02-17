import { type SQL } from "drizzle-orm";

import type {
  CheckUniqueParams,
  CountEdgesByKindParams,
  CountEdgesFromParams,
  CountNodesByKindParams,
  DeleteEdgeParams,
  DeleteEmbeddingParams,
  DeleteNodeParams,
  DeleteUniqueParams,
  EdgeExistsBetweenParams,
  FindEdgesByKindParams,
  FindEdgesConnectedToParams,
  FindNodesByKindParams,
  HardDeleteEdgeParams,
  HardDeleteNodeParams,
  InsertEdgeParams,
  InsertNodeParams,
  InsertSchemaParams,
  InsertUniqueParams,
  SqlDialect,
  UpdateEdgeParams,
  UpdateNodeParams,
  UpsertEmbeddingParams,
  VectorSearchParams,
} from "../../types";
import type { PostgresTables } from "../schema/postgres";
import type { SqliteTables } from "../schema/sqlite";
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
  buildDeleteUnique,
  buildHardDeleteEmbeddingsByNode,
  buildHardDeleteUniquesByNode,
  buildInsertUnique,
} from "./uniques";
import {
  buildDeleteEmbedding,
  buildGetEmbedding,
  buildUpsertEmbeddingPostgres,
  buildVectorSearchPostgres,
} from "./vectors";

export type CommonOperationStrategy = Readonly<{
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
  buildDeleteUnique: (params: DeleteUniqueParams, timestamp: string) => SQL;
  buildHardDeleteUniquesByNode: (graphId: string, nodeId: string) => SQL;
  buildHardDeleteEmbeddingsByNode: (
    graphId: string,
    nodeKind: string,
    nodeId: string,
  ) => SQL;
  buildCheckUnique: (params: CheckUniqueParams) => SQL;
  buildGetActiveSchema: (graphId: string) => SQL;
  buildInsertSchema: (params: InsertSchemaParams, timestamp: string) => SQL;
  buildGetSchemaVersion: (graphId: string, version: number) => SQL;
  buildSetActiveSchema: (
    graphId: string,
    version: number,
  ) => Readonly<{ activateVersion: SQL; deactivateAll: SQL }>;
}>;

export type PostgresVectorOperationStrategy = Readonly<{
  buildUpsertEmbedding: (
    params: UpsertEmbeddingParams,
    timestamp: string,
  ) => SQL;
  buildDeleteEmbedding: (params: DeleteEmbeddingParams) => SQL;
  buildGetEmbedding: (
    graphId: string,
    nodeKind: string,
    nodeId: string,
    fieldPath: string,
  ) => SQL;
  buildVectorSearch: (params: VectorSearchParams) => SQL;
}>;

export type SqliteOperationStrategy = CommonOperationStrategy;

export type PostgresOperationStrategy = Readonly<
  CommonOperationStrategy & PostgresVectorOperationStrategy
>;

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
  buildHardDeleteEmbeddingsByNode,
  buildCheckUnique,
  buildGetSchemaVersion,
} as const satisfies TableOperationBuilderMap;

function createCommonOperationStrategy(
  tables: Tables,
  dialect: SqlDialect,
): CommonOperationStrategy {
  const tableOperations = bindTableOperationBuilders(
    tables,
    COMMON_TABLE_OPERATION_BUILDERS,
  );

  return {
    ...tableOperations,
    buildInsertUnique(params: InsertUniqueParams): SQL {
      return buildInsertUnique(tables, dialect, params);
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
  };
}

export function createSqliteOperationStrategy(
  tables: SqliteTables,
): SqliteOperationStrategy {
  return createCommonOperationStrategy(tables, "sqlite");
}

export function createPostgresOperationStrategy(
  tables: PostgresTables,
): PostgresOperationStrategy {
  const common = createCommonOperationStrategy(tables, "postgres");

  return {
    ...common,
    buildUpsertEmbedding(params: UpsertEmbeddingParams, timestamp: string): SQL {
      return buildUpsertEmbeddingPostgres(tables, params, timestamp);
    },
    buildDeleteEmbedding(params: DeleteEmbeddingParams): SQL {
      return buildDeleteEmbedding(tables, params);
    },
    buildGetEmbedding(
      graphId: string,
      nodeKind: string,
      nodeId: string,
      fieldPath: string,
    ): SQL {
      return buildGetEmbedding(tables, graphId, nodeKind, nodeId, fieldPath);
    },
    buildVectorSearch(params: VectorSearchParams): SQL {
      return buildVectorSearchPostgres(tables, params);
    },
  };
}
