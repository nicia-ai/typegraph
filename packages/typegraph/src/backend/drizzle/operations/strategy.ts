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
  Dialect,
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

function createCommonOperationStrategy(
  tables: Tables,
  dialect: Dialect,
): CommonOperationStrategy {
  return {
    buildInsertNode(params: InsertNodeParams, timestamp: string): SQL {
      return buildInsertNode(tables, params, timestamp);
    },
    buildInsertNodeNoReturn(params: InsertNodeParams, timestamp: string): SQL {
      return buildInsertNodeNoReturn(tables, params, timestamp);
    },
    buildInsertNodesBatch(
      params: readonly InsertNodeParams[],
      timestamp: string,
    ): SQL {
      return buildInsertNodesBatch(tables, params, timestamp);
    },
    buildInsertNodesBatchReturning(
      params: readonly InsertNodeParams[],
      timestamp: string,
    ): SQL {
      return buildInsertNodesBatchReturning(tables, params, timestamp);
    },
    buildGetNode(graphId: string, kind: string, id: string): SQL {
      return buildGetNode(tables, graphId, kind, id);
    },
    buildGetNodes(graphId: string, kind: string, ids: readonly string[]): SQL {
      return buildGetNodes(tables, graphId, kind, ids);
    },
    buildUpdateNode(params: UpdateNodeParams, timestamp: string): SQL {
      return buildUpdateNode(tables, params, timestamp);
    },
    buildDeleteNode(params: DeleteNodeParams, timestamp: string): SQL {
      return buildDeleteNode(tables, params, timestamp);
    },
    buildHardDeleteNode(params: HardDeleteNodeParams): SQL {
      return buildHardDeleteNode(tables, params);
    },
    buildInsertEdge(params: InsertEdgeParams, timestamp: string): SQL {
      return buildInsertEdge(tables, params, timestamp);
    },
    buildInsertEdgeNoReturn(params: InsertEdgeParams, timestamp: string): SQL {
      return buildInsertEdgeNoReturn(tables, params, timestamp);
    },
    buildInsertEdgesBatch(
      params: readonly InsertEdgeParams[],
      timestamp: string,
    ): SQL {
      return buildInsertEdgesBatch(tables, params, timestamp);
    },
    buildInsertEdgesBatchReturning(
      params: readonly InsertEdgeParams[],
      timestamp: string,
    ): SQL {
      return buildInsertEdgesBatchReturning(tables, params, timestamp);
    },
    buildGetEdge(graphId: string, id: string): SQL {
      return buildGetEdge(tables, graphId, id);
    },
    buildGetEdges(graphId: string, ids: readonly string[]): SQL {
      return buildGetEdges(tables, graphId, ids);
    },
    buildUpdateEdge(params: UpdateEdgeParams, timestamp: string): SQL {
      return buildUpdateEdge(tables, params, timestamp);
    },
    buildDeleteEdge(params: DeleteEdgeParams, timestamp: string): SQL {
      return buildDeleteEdge(tables, params, timestamp);
    },
    buildHardDeleteEdge(params: HardDeleteEdgeParams): SQL {
      return buildHardDeleteEdge(tables, params);
    },
    buildCountEdgesFrom(params: CountEdgesFromParams): SQL {
      return buildCountEdgesFrom(tables, params);
    },
    buildEdgeExistsBetween(params: EdgeExistsBetweenParams): SQL {
      return buildEdgeExistsBetween(tables, params);
    },
    buildFindEdgesConnectedTo(params: FindEdgesConnectedToParams): SQL {
      return buildFindEdgesConnectedTo(tables, params);
    },
    buildFindNodesByKind(params: FindNodesByKindParams): SQL {
      return buildFindNodesByKind(tables, params);
    },
    buildCountNodesByKind(params: CountNodesByKindParams): SQL {
      return buildCountNodesByKind(tables, params);
    },
    buildFindEdgesByKind(params: FindEdgesByKindParams): SQL {
      return buildFindEdgesByKind(tables, params);
    },
    buildCountEdgesByKind(params: CountEdgesByKindParams): SQL {
      return buildCountEdgesByKind(tables, params);
    },
    buildInsertUnique(params: InsertUniqueParams): SQL {
      return buildInsertUnique(tables, dialect, params);
    },
    buildDeleteUnique(params: DeleteUniqueParams, timestamp: string): SQL {
      return buildDeleteUnique(tables, params, timestamp);
    },
    buildHardDeleteUniquesByNode(graphId: string, nodeId: string): SQL {
      return buildHardDeleteUniquesByNode(tables, graphId, nodeId);
    },
    buildHardDeleteEmbeddingsByNode(
      graphId: string,
      nodeKind: string,
      nodeId: string,
    ): SQL {
      return buildHardDeleteEmbeddingsByNode(tables, graphId, nodeKind, nodeId);
    },
    buildCheckUnique(params: CheckUniqueParams): SQL {
      return buildCheckUnique(tables, params);
    },
    buildGetActiveSchema(graphId: string): SQL {
      return buildGetActiveSchema(tables, graphId, dialect);
    },
    buildInsertSchema(params: InsertSchemaParams, timestamp: string): SQL {
      return buildInsertSchema(tables, params, timestamp, dialect);
    },
    buildGetSchemaVersion(graphId: string, version: number): SQL {
      return buildGetSchemaVersion(tables, graphId, version);
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
